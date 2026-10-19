/**
 * .status — pull a contact's WhatsApp status out of the cache and send it to
 * your DM, privately.
 *
 *   .status #2             → send the contact at index 2 in the listing
 *   .status 923701609799   → send that contact's cached statuses to your DM
 *   .status Ali            → ...by contact name (unique match only)
 *   .status                → what is cached, and for whom
 *   .status clear [#2]     → wipe the cache (all, or one contact)
 *
 *   .status save on|off    → master switch for auto-capture (OFF by default)
 *   .status allow <number> → only capture these contacts (empty = everyone)
 *   .status deny <number>  → drop a number from the allowlist
 *   .status allow clear    → allow everyone again
 *
 * WHY THE LISTING SHOWS NAMES, NOT JUST NUMBERS
 *   Statuses are addressed by whoever posted them, and modern WhatsApp often
 *   addresses an account by LID — a long opaque digit string — rather than by
 *   phone number. The previous listing printed that raw identifier, so every row
 *   read like a random number and there was no way to tell whose status it was.
 *   lib/statusCache now records the poster's push name and resolves LIDs to real
 *   phone numbers, and this command prints `Name (+number)` with a `#N` handle
 *   that can be fed straight back into `.status` and `.status clear`.
 *
 * CAPTURE CONTROLS
 *   Auto-capture is OFF until turned on, so a fresh install downloads nothing.
 *   Settings live in data/statusCache.json and are enforced in
 *   lib/statusCache.captureMessage, before any download happens. Cached items
 *   auto-expire after 24h — WhatsApp's own status lifetime.
 *
 * WHY IT READS FROM A CACHE
 *   WhatsApp PUSHES statuses; there is no "fetch this contact's status" call.
 *   (`sock.fetchStatus(jid)` is a trap — it returns the profile *about* text, not
 *   the story.) So lib/statusCache records every status as it arrives, and this
 *   command serves from that. If a status was never received, it cannot be
 *   served — see the note in the reply for what has to be true.
 *
 * PRIVACY
 *   Nothing here calls readMessages(), so saving a status does NOT mark it as
 *   viewed. The poster never sees that the bot looked. And every message this
 *   command produces — the media AND the confirmation — goes to the DM, never
 *   back into the chat it was typed in.
 *
 * Owner-only: it can expose media posted by other people.
 */
const fs = require('fs');
const style = require('../../lib/messageStyle');
const isOwnerOrSudo = require('../../lib/isOwner');
const statusCache = require('../../lib/statusCache');
const { resolveDmJid } = require('../../lib/dmTarget');

/** Contacts shown per listing page. Two lines each keeps the card readable. */
const MAX_ROWS = 8;

function fmtWhen(ts) {
    try {
        return new Date(ts * 1000).toLocaleString('en-GB', {
            day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return 'unknown';
    }
}

function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

/** One contact as two listing lines: the identity, then the counts. */
function contactLines(contact, index) {
    return [
        ` #${String(index).padStart(2, ' ')}  ${contact.label}`,
        `       ${contact.count} item${contact.count === 1 ? '' : 's'} · last ${fmtWhen(contact.ts)}`,
    ];
}

module.exports = {
    name: 'status',
    aliases: ['statusdl', 'getstatus'],
    category: 'owner',
    description: "Save a contact's WhatsApp status to your DM, privately (never marks it viewed)",
    usage: '.status <number|name|#index> · .status · .status clear [ref] · .status save on|off · .status allow <number>|clear · .status deny <number>',
    ownerOnly: true,
    modOnly: false,
    groupOnly: false,
    privateOnly: false,
    adminOnly: false,
    botAdminNeeded: false,
    async execute(sock, message, args, extra) {
        const senderId = message.key.participant || message.key.remoteJid;

        if (!message.key.fromMe && !(await isOwnerOrSudo(senderId, sock, extra.chatId))) {
            return sock.sendMessage(
                extra.chatId,
                { text: style.permissionDenied('owner', { box: false }) },
                { quoted: message }
            );
        }

        // Everything this command produces goes to the DM — that is the whole
        // point. resolveDmJid never returns a group, so a trigger typed in a
        // group cannot leak the result back into it.
        const dmJid = resolveDmJid(sock, message, extra.chatId, senderId) || extra.chatId;
        const say = (content) => sock.sendMessage(
            dmJid,
            typeof content === 'string' ? { text: content } : content,
            dmJid === extra.chatId ? { quoted: message } : {}
        );

        const sub = (args[0] || '').trim().toLowerCase();

        // ── .status clear [ref] ─────────────────────────────────────────
        if (sub === 'clear') {
            // No argument means "wipe everything", as before.
            const raw = (args.slice(1).join(' ') || '').trim();
            if (!raw) {
                const removed = statusCache.clear(null);
                return say(style.success(
                    `Cleared ${removed} cached status${removed === 1 ? '' : 'es'}.`
                ));
            }

            // With a reference, resolve it first so an unknown name/number is
            // reported instead of silently deleting nothing.
            const resolved = statusCache.resolveRef(raw);
            if (!resolved.contact) {
                return say(clearFailure(raw, resolved, extra.prefix));
            }
            const removed = statusCache.clear(raw);
            return say(style.success(
                `Cleared ${removed} cached status${removed === 1 ? '' : 'es'} for ${resolved.contact.label}.`
            ));
        }

        // ── .status save [on|off] ───────────────────────────────────────
        if (sub === 'save' || sub === 'capture') {
            const mode = (args[1] || '').trim().toLowerCase();
            if (!mode) {
                const on = statusCache.isEnabled();
                return say(style.box('📸 STATUS CAPTURE', [
                    `Auto-save is *${on ? 'ON' : 'OFF'}*.`,
                    '',
                    on
                        ? 'Incoming statuses are being kept (24h, then auto-deleted).'
                        : 'Nothing is being saved — .status <number> has nothing to serve.',
                    '',
                    `Turn it on:  ${extra.prefix}status save on`,
                    `Turn it off: ${extra.prefix}status save off`,
                ]));
            }
            if (mode !== 'on' && mode !== 'off') {
                return say(style.invalidInput(
                    'Use on or off.', `${extra.prefix}status save on`, { box: false }
                ));
            }
            const cfg = statusCache.setEnabled(mode === 'on');
            return say(style.success(
                cfg.enabled
                    ? 'Status auto-save is ON. New statuses will be kept, then expire after 24h.'
                    : 'Status auto-save is OFF. Nothing new will be saved.'
            ));
        }

        // ── .status allow [<number>|clear] ──────────────────────────────
        if (sub === 'allow' || sub === 'only') {
            const arg = (args[1] || '').trim().toLowerCase();
            const list = statusCache.getAllowlist();

            if (!arg) {
                return say(style.box('📸 STATUS ALLOWLIST', [
                    list.length
                        ? list.map((n) => ` ${n}`).join('\n')
                        : 'No allowlist set — every contact is eligible (while auto-save is on).',
                    '',
                    `Add:    ${extra.prefix}status allow <number>`,
                    `Remove: ${extra.prefix}status deny <number>`,
                    `Clear:  ${extra.prefix}status allow clear`,
                ]));
            }
            if (arg === 'clear') {
                statusCache.clearAllowlist();
                return say(style.success('Allowlist cleared — every contact is eligible again.'));
            }
            const num = arg.replace(/[^0-9]/g, '');
            if (num.length < 6 || num.length > 19) {
                return say(style.invalidInput(
                    'Give me a phone number (country code first).',
                    `${extra.prefix}status allow 923701609799`, { box: false }
                ));
            }
            const cfg = statusCache.addToAllowlist(num);
            return say(style.success(`Added ${num} — now ${cfg.allowlist.length} number(s) allowed.`));
        }

        // ── .status deny <number> ───────────────────────────────────────
        if (sub === 'deny' || sub === 'disallow') {
            const num = (args[1] || '').replace(/[^0-9]/g, '');
            if (!num) {
                return say(style.invalidInput(
                    'Give me a phone number to remove.',
                    `${extra.prefix}status deny 923701609799`, { box: false }
                ));
            }
            const cfg = statusCache.removeFromAllowlist(num);
            return say(style.success(`Removed ${num} — ${cfg.allowlist.length} number(s) remain allowed.`));
        }

        // ── .status  (what is cached) ───────────────────────────────────
        if (!sub) {
            const enabled = statusCache.isEnabled();
            const allow = statusCache.getAllowlist();

            // Names written by an older version were never recorded. Resolve what
            // is missing before printing, otherwise the listing stays opaque for
            // everyone who already has a cache.
            try { await statusCache.backfill(sock); } catch (e) {
                console.error('[status] backfill failed:', e.message);
            }

            const contacts = statusCache.listContacts();
            const st = statusCache.stats();

            const state = style.rows([
                ['Auto-save', `*${enabled ? 'ON' : 'OFF'}*`],
                ['Retention', '24h'],
                ['Allowlist', allow.length ? `${allow.length} number(s)` : 'all contacts'],
            ]);

            if (!enabled && !contacts.length) {
                return say(style.box('📸 STATUS CACHE', [
                    'Auto-save is *OFF* — nothing is being recorded.',
                    '',
                    `Turn it on: ${extra.prefix}status save on`,
                    'Then ask someone to post a new status and check again.',
                ]));
            }

            if (!contacts.length) {
                return say(style.box('📸 STATUS CACHE', [
                    ...state,
                    '',
                    'Nothing cached yet — no status has arrived since auto-save was on.',
                    'Statuses are recorded LIVE, as they arrive. The bot cannot go back',
                    'and fetch one that was already posted, and they expire after 24h.',
                    '',
                    'Ask someone to post a new status, then check again.',
                ]));
            }

            const shown = contacts.slice(0, MAX_ROWS);
            const rows = shown.flatMap((c, i) => contactLines(c, i + 1));

            return say(style.box('📸 STATUS CACHE', [
                ...state,
                '',
                ...rows,
                contacts.length > MAX_ROWS ? ` …and ${contacts.length - MAX_ROWS} more` : '',
                '',
                `${st.contacts} contact(s) · ${st.entries} item(s) · ${fmtBytes(st.bytes)}`,
                '',
                `Get one: ${extra.prefix}status #1   or   ${extra.prefix}status <number>`,
                `Wipe:    ${extra.prefix}status clear #1`,
            ].filter((l) => l !== '')));
        }

        // ── .status <ref> ───────────────────────────────────────────────
        // A reference is a #index, a phone number, a LID, a JID or a name — the
        // same forms the listing prints, so what you see is what you can type.
        const ref = args.join(' ').trim();
        const resolved = statusCache.resolveRef(ref);

        if (!resolved.contact) {
            const enabled = statusCache.isEnabled();
            if (resolved.reason === 'ambiguous') {
                const rows = (resolved.matches || []).slice(0, MAX_ROWS)
                    .flatMap((c, i) => contactLines(c, i + 1));
                return say(style.box('📸 STATUS', [
                    `"${ref}" matches more than one cached contact:`,
                    '',
                    ...rows,
                    '',
                    `Pick one: ${extra.prefix}status #1`,
                ]));
            }

            // A `#N` handle is an index, not a contact — say so plainly rather
            // than explaining how statuses are captured.
            if (/^#\d+$/.test(ref)) {
                const total = statusCache.listContacts().length;
                return say(style.box('📸 STATUS', [
                    total
                        ? `There is no ${ref} — ${total} contact(s) are cached, so the handles are #1–#${total}.`
                        : 'The cache is empty — nothing to show.',
                    '',
                    `See who IS cached: ${extra.prefix}status`,
                ]));
            }

            return say(style.box('📸 STATUS', [
                `Nothing cached for ${ref}.`,
                ...(enabled ? [] : [
                    '',
                    `Auto-save is *OFF* — turn it on with ${extra.prefix}status save on`,
                ]),
                '',
                'Statuses are recorded LIVE, as they arrive. The bot cannot go back',
                'and fetch one that was already posted — so a status from before the',
                'bot last started, or older than 24h, will never appear here.',
                '',
                'Ask them to post a new status, then run this again.',
                '',
                `See who IS cached: ${extra.prefix}status`,
            ]));        }

        const contact = resolved.contact;
        const entries = statusCache.listFor(ref);
        if (!entries.length) {
            return say(style.box('📸 STATUS', [
                `Nothing cached for ${contact.label}.`,
                `See who IS cached: ${extra.prefix}status`,
            ]));
        }

        let sent = 0;
        for (const e of entries) {
            try {
                if (e.type === 'text') {
                    await sock.sendMessage(dmJid, {
                        text: `📝 Status from ${contact.label}:\n${e.caption || ''}`,
                    });
                    sent++;
                    continue;
                }

                const file = statusCache.filePathFor(e);
                if (!file) continue;

                const buffer = fs.readFileSync(file);
                const payload = { caption: e.caption || `📸 Status from ${contact.label}` };
                if (e.type === 'image') payload.image = buffer;
                else if (e.type === 'video') payload.video = buffer;
                else payload.audio = buffer;

                await sock.sendMessage(dmJid, payload);
                sent++;
            } catch (err) {
                console.error('[status] send failed:', err.message);
            }
        }

        return say(style.success(
            `Sent ${sent}/${entries.length} status${entries.length === 1 ? '' : 'es'} from ${contact.label} to your DM.`
        ));
    },
};

/**
 * Explain why `.status clear <ref>` matched nothing, and show what does exist.
 * A silent "cleared 0" is what made the old opaque IDs so frustrating.
 */
function clearFailure(raw, resolved, prefix) {
    if (resolved.reason === 'ambiguous') {
        const rows = (resolved.matches || []).slice(0, MAX_ROWS)
            .flatMap((c, i) => contactLines(c, i + 1));
        return style.box('📸 STATUS', [
            `"${raw}" matches more than one cached contact:`,
            '',
            ...rows,
            '',
            `Pick one: ${prefix}status clear #1`,
        ]);
    }
    const contacts = statusCache.listContacts();
    if (/^#\d+$/.test(String(raw))) {
        return style.box('📸 STATUS', [
            contacts.length
                ? `There is no ${raw} — ${contacts.length} contact(s) are cached. Nothing was deleted.`
                : 'The cache is empty — nothing was deleted.',
            '',
            `See who IS cached: ${prefix}status`,
        ]);
    }
    return style.box('📸 STATUS', [
        `Nothing cached for ${raw} — nothing was deleted.`,
        contacts.length
            ? `Cached: ${contacts.slice(0, 3).map((c) => c.label).join(', ')}${contacts.length > 3 ? `, +${contacts.length - 3} more` : ''}`
            : 'The cache is empty.',
        '',
        `Wipe everything: ${prefix}status clear`,
    ]);
}
