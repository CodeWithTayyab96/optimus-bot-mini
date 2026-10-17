/**
 * statusCache — keep a copy of every WhatsApp status the bot receives.
 *
 * WHY A CACHE IS THE ONLY WAY TO DO THIS
 *   WhatsApp PUSHES statuses to you; there is no "fetch contact X's status" call.
 *   `sock.fetchStatus(jid)` is a trap — it returns the profile *about* text, not
 *   the story. So the only way `.status <number>` can work on demand is to have
 *   recorded the status when it arrived. That is what this module is for.
 *
 * PRIVACY — THE POINT OF THE WHOLE THING
 *   Downloading a status does NOT mark it as viewed. `readMessages()` is what
 *   sends the "seen" receipt, and this module deliberately never calls it. So a
 *   status can be saved without the poster ever seeing that the bot looked.
 *   (`.autostatus on` does the opposite — it calls readMessages. The two are
 *   independent on purpose.)
 *
 * WHAT IT CANNOT DO
 *   A status only reaches this bot if the poster's privacy settings allow the
 *   bot's number to see it. If someone posts to "my contacts except …" and the
 *   bot is not in that list, the status never arrives and there is nothing to
 *   cache. No amount of code can work around that.
 *
 * IDENTITY — WHY AN ENTRY IS NOT JUST A NUMBER
 *   A status arrives addressed by whoever posted it, and modern WhatsApp often
 *   addresses people by LID (a per-account "linked ID") rather than by phone
 *   number. A LID is a long opaque digit string, so the old cache listing —
 *   which printed `entry.number` — showed a list of what looked like random
 *   numbers with no way to tell whose status was whose. Nothing about that is
 *   wrong at the storage level; it was simply unreadable.
 *
 *   Every entry therefore records THREE things: the JID as received (`jid`), the
 *   phone number when it can be resolved (`number`), the LID when the poster is
 *   LID-addressed (`lid`), and the display name pushed with the status (`name`).
 *   Older entries are normalised on read and back-filled lazily by
 *   `backfill(sock)`, so a cache written by the previous version becomes
 *   readable without being thrown away.
 *
 *   Lookups go through `resolveRef()`, which accepts any of: `#N` (the index in
 *   the listing), a phone number, a LID, a JID, or a contact name. That is what
 *   lets `.status <ref>` and `.status clear <ref>` work with whatever the
 *   listing shows.
 *
 * OFF BY DEFAULT — AND WHY
 *   Capturing every status costs disk and is privacy-sensitive, so it is NOT
 *   automatic out of the box. The master switch lives in data/statusCache.json
 *   (`enabled`, default false) and is driven by `.status save on|off`. With it
 *   off, captureMessage() returns before downloading anything.
 *
 *   An optional per-contact allowlist narrows capture further: when it is
 *   non-empty, only those numbers are recorded. Manage it with
 *   `.status allow <number>`, `.status deny <number>`, `.status allow clear`.
 *   (The allowlist applies to every poster, including the bot's own number.)
 *
 * BOUNDS
 *   Media is stored on disk, so it is capped three ways: an age cap (24h, the
 *   same lifetime WhatsApp gives a status), the newest few per contact, and a
 *   total ceiling — oldest pruned first. Without this a busy status feed would
 *   quietly fill the panel's disk.
 */

const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// Runtime state lives under data/. The directory is swappable so tests never
// touch a real cache (see _test.setDataDir).
let DATA_DIR = path.join(__dirname, '..', 'data');
let CACHE_DIR = path.join(DATA_DIR, 'status-cache');
let INDEX_FILE = path.join(CACHE_DIR, 'index.json');
let CONFIG_FILE = path.join(DATA_DIR, 'statusCache.json');

const MAX_PER_CONTACT = 5;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024; // 150 MB
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;  // skip anything bigger than 30 MB
const MAX_AGE_SECONDS = 24 * 60 * 60;      // statuses expire after 24h

/** Message ids already handled, so a re-delivered upsert is not stored twice. */
const seenIds = new Set();

function ensureDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** Point the cache at another directory (tests). Returns the previous dir. */
function setDataDir(dir) {
    const prev = DATA_DIR;
    DATA_DIR = dir;
    CACHE_DIR = path.join(dir, 'status-cache');
    INDEX_FILE = path.join(CACHE_DIR, 'index.json');
    CONFIG_FILE = path.join(dir, 'statusCache.json');
    return prev;
}

function readIndex() {
    try {
        const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        return Array.isArray(raw) ? raw.map(normaliseEntry) : [];
    } catch {
        return [];
    }
}

function writeIndex(entries) {
    ensureDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
}

/** Read the capture settings, normalised. Missing/corrupt file = disabled. */
function readConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return {
            enabled: !!raw.enabled,
            allowlist: Array.isArray(raw.allowlist)
                ? [...new Set(raw.allowlist.map((n) => numberFromJid(n)).filter(Boolean))]
                : [],
        };
    } catch {
        return { enabled: false, allowlist: [] };
    }
}

function writeConfig(cfg) {
    ensureDataDir();
    const clean = {
        enabled: !!cfg.enabled,
        allowlist: [...new Set((cfg.allowlist || []).map((n) => numberFromJid(n)).filter(Boolean))],
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2));
    return clean;
}

function isEnabled() { return readConfig().enabled; }

function setEnabled(on) {
    const cfg = readConfig();
    cfg.enabled = !!on;
    return writeConfig(cfg);
}

function getAllowlist() { return readConfig().allowlist; }

function addToAllowlist(numberOrJid) {
    const num = numberFromJid(numberOrJid);
    const cfg = readConfig();
    if (num && !cfg.allowlist.includes(num)) cfg.allowlist.push(num);
    return writeConfig(cfg);
}

function removeFromAllowlist(numberOrJid) {
    const num = numberFromJid(numberOrJid);
    const cfg = readConfig();
    cfg.allowlist = cfg.allowlist.filter((n) => n !== num);
    return writeConfig(cfg);
}

function clearAllowlist() {
    const cfg = readConfig();
    cfg.allowlist = [];
    return writeConfig(cfg);
}

/** '923701609799:12@s.whatsapp.net' → '923701609799' */
function numberFromJid(jid) {
    return String(jid || '').split('@')[0].split(':')[0];
}

/** True when this JID addresses an account by LID rather than by phone number. */
function isLidJid(jid) {
    return String(jid || '').endsWith('@lid');
}

/**
 * Bring an entry written by any version into the current shape.
 *
 * The previous version stored whatever `key.participant` was in `number`, so a
 * LID-addressed status was saved as `number: '123456789012345'` with no `lid`
 * field. Left alone that is exactly the "random numeric ID" the listing showed,
 * so on read we demote it to `lid` and leave `number` empty until something
 * resolves the real phone number.
 */
function normaliseEntry(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    // Only the LEGACY shape is demoted: a LID JID with no `lid` field means the
    // old code stored the LID in `number`. A current entry has `lid` set and
    // `number` holding a real phone number, which must be left alone.
    if (isLidJid(entry.jid) && !entry.lid) {
        entry.lid = entry.number || numberFromJid(entry.jid) || null;
        entry.number = null;
    }
    if (entry.name === undefined) entry.name = null;
    return entry;
}

/** The identifier a contact's entries are grouped by. */
function keyOf(entry) {
    return entry.number || entry.lid || entry.jid || '';
}

/** Recursively unwrap view-once / ephemeral envelopes to the raw media node. */
function unwrap(content, depth = 0) {
    if (!content || depth > 10) return null;
    if (content.imageMessage) return { type: 'image', node: content.imageMessage };
    if (content.videoMessage) return { type: 'video', node: content.videoMessage };
    if (content.audioMessage) return { type: 'audio', node: content.audioMessage };
    if (content.conversation) return { type: 'text', text: content.conversation };
    if (content.extendedTextMessage?.text) return { type: 'text', text: content.extendedTextMessage.text };

    for (const key of ['viewOnceMessageV2', 'viewOnceMessageV2Extension', 'viewOnceMessage', 'ephemeralMessage']) {
        if (content[key]?.message) {
            const r = unwrap(content[key].message, depth + 1);
            if (r) return r;
        }
    }
    if (content.message && typeof content.message === 'object') {
        return unwrap(content.message, depth + 1);
    }
    return null;
}

// ---------------------------------------------------------------- identity ---

/**
 * Turn a LID into the poster's phone number, when WhatsApp has told us.
 *
 * The mapping lives in the signal repository and is populated as messages flow;
 * it is not guaranteed, which is why every caller has to cope with null.
 */
async function phoneForLid(sock, jid) {
    if (!isLidJid(jid)) return null;

    // 1. Baileys' own LID → PN mapping (the authoritative source).
    try {
        const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
        const digits = numberFromJid(pn);
        if (digits && !isLidJid(pn)) return digits;
    } catch { /* unknown LID — not an error worth logging */ }

    // 2. The contact store, when it happens to be keyed by the LID.
    try {
        const contacts = sock?.store?.contacts || require('./lightweight_store').contacts || {};
        const c = contacts[jid];
        if (c?.id && !isLidJid(c.id)) return numberFromJid(c.id);
    } catch { /* store unavailable */ }

    return null;
}

/**
 * A human-readable name for a JID, or null.
 *
 * `sock.getName()` falls back to the international phone number, which is not a
 * name — printing "+923001234567" where a name belongs is how the old listing
 * ended up looking like a wall of digits, so those are rejected here.
 */
async function nameForJid(sock, jid, hint) {
    const clean = (v) => {
        const s = String(v || '').trim();
        if (!s) return null;
        if (/^\+?[\d\s()-]{6,}$/.test(s)) return null; // a number, not a name
        if (s === 'Unknown' || s === 'null' || s === 'undefined') return null;
        return s;
    };

    const fromHint = clean(hint);
    if (fromHint) return fromHint;

    try {
        const n = clean(await sock?.getName?.(jid));
        if (n) return n;
    } catch { /* getName is optional */ }

    try {
        const contacts = sock?.store?.contacts || require('./lightweight_store').contacts || {};
        const c = contacts[jid] || contacts[numberFromJid(jid) + '@s.whatsapp.net'];
        const n = clean(c?.name || c?.notify || c?.verifiedName || c?.subject);
        if (n) return n;
    } catch { /* store unavailable */ }

    return null;
}

/**
 * Resolve everything needed to identify one poster.
 * @returns {Promise<{number: string|null, lid: string|null, name: string|null}>}
 */
async function resolveIdentity(sock, jid, hint) {
    const lid = isLidJid(jid) ? numberFromJid(jid) : null;
    const number = lid ? await phoneForLid(sock, jid) : (numberFromJid(jid) || null);
    const name = await nameForJid(sock, jid, hint);
    return { number: number || null, lid, name: name || null };
}

/** How a contact is shown in a listing. Never a bare opaque number. */
function labelFor(contact) {
    const name = String(contact?.name || '').trim();
    const number = String(contact?.number || '').trim();
    const lid = String(contact?.lid || '').trim();

    if (name && number) return `${name} (+${number})`;
    if (name) return name;
    if (number) return `+${number}`;
    if (lid) return `unknown contact (ID ${lid.slice(0, 6)}…${lid.slice(-4)})`;
    return 'unknown contact';
}

// ----------------------------------------------------------------- capture ---

const EXT = { image: 'jpg', video: 'mp4', audio: 'ogg' };

/**
 * When the status was POSTED, in seconds.
 *
 * Baileys puts `messageTimestamp` on the message, not on the key — reading
 * `key.messageTimestamp` (as this module used to) always came back undefined,
 * so every entry was stamped with the moment the bot received it. For a live
 * status that is a second apart, but for a backlog delivered on reconnect it
 * meant a 20-hour-old status was kept for another 24. It also made the listing
 * order arbitrary when several statuses arrived together.
 *
 * The value may be a protobuf Long, which is not a Number.
 */
function timestampOf(msg) {
    const raw = msg?.messageTimestamp ?? msg?.key?.messageTimestamp;
    if (raw == null) return Math.floor(Date.now() / 1000);
    if (typeof raw === 'object' && typeof raw.toNumber === 'function') return raw.toNumber();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000);
}

/**
 * Record one status. Never throws — a status we fail to keep must not take the
 * message pipeline down with it.
 */
async function captureMessage(sock, msg) {
    const key = msg?.key;
    if (!key) return;

    // The poster is normally the `participant`. A status posted by THIS account
    // arrives with `fromMe: true` and no participant, which would leave only
    // status@broadcast — and skipping that would silently drop the owner's own
    // statuses, which is exactly what you want to test with.
    let posterJid = key.participant;
    if (!posterJid && key.fromMe) posterJid = sock?.user?.id || sock?.user?.jid;
    if (!posterJid || posterJid === 'status@broadcast') return;

    const number = numberFromJid(posterJid);

    // Master switch + allowlist, checked BEFORE any download or dedupe
    // bookkeeping — a disabled or filtered-out status costs nothing, and its id
    // is not burned from the dedupe set.
    const cfg = readConfig();
    if (!cfg.enabled) return;
    if (cfg.allowlist.length && !cfg.allowlist.includes(number)) return;

    const id = key.id;
    if (!id || seenIds.has(id)) return;
    seenIds.add(id);
    if (seenIds.size > 500) {
        // Keep the dedupe set from growing without bound.
        for (const old of [...seenIds].slice(0, 250)) seenIds.delete(old);
    }

    const found = unwrap(msg.message);
    if (!found) return;

    // Who posted it — resolved NOW, while the push name is still attached to the
    // message. Doing it later means relying on a store that may have rotated.
    let identity;
    try {
        identity = await resolveIdentity(sock, posterJid, msg.pushName || msg.verifiedBizName);
    } catch {
        identity = {
            number: isLidJid(posterJid) ? null : number,
            lid: isLidJid(posterJid) ? number : null,
            name: null,
        };
    }

    const entry = {
        id,
        jid: posterJid,
        number: identity.number,
        lid: identity.lid,
        name: identity.name,
        type: found.type,
        ts: timestampOf(msg),
        caption: found.node?.caption || found.text || '',
        mimetype: found.node?.mimetype || null,
        file: null,
        size: 0,
    };

    try {
        if (found.type !== 'text') {
            // NOTE: no readMessages() call here — that is what keeps this silent.
            const stream = await downloadContentFromMessage(found.node, found.type);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);

            if (!buffer.length) return;
            if (buffer.length > MAX_ENTRY_BYTES) {
                console.log(`[statusCache] skipping ${labelFor(entry)} — ${(buffer.length / 1048576).toFixed(1)} MB is over the cap`);
                return;
            }

            ensureDir();
            const file = `${number}-${entry.ts}-${id.slice(0, 6)}.${EXT[found.type] || 'bin'}`;
            fs.writeFileSync(path.join(CACHE_DIR, file), buffer);
            entry.file = file;
            entry.size = buffer.length;
        }

        const entries = readIndex();
        entries.push(entry);
        writeIndex(prune(entries));

        // Say so out loud. Without this there is no way to tell "the bot is not
        // in anyone's status audience" from "the capture path is broken" — both
        // look like an empty cache from inside the chat.
        console.log(`[statusCache] saved ${entry.type} status from ${labelFor(entry)} (${entry.size} bytes)`);
    } catch (e) {
        console.error('[statusCache] capture failed:', e.message);
    }
}

/** Enforce the per-contact and total caps, deleting files as entries are dropped. */
function prune(entries) {
    // Age cap first: WhatsApp drops a status after 24h, so anything older than
    // that is dead weight. Its file is unlinked by the sweep at the end.
    const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS;
    const live = entries.filter((e) => (e.ts || 0) >= cutoff);

    // Newest first for the cap checks.
    const byNewest = [...live].sort((a, b) => b.ts - a.ts);
    const keep = new Set();

    const perContact = new Map();
    for (const e of byNewest) {
        const k = keyOf(e);
        const n = perContact.get(k) || 0;
        if (n >= MAX_PER_CONTACT) continue;
        perContact.set(k, n + 1);
        keep.add(e.id);
    }

    let total = 0;
    const kept = [];
    for (const e of byNewest) {
        if (!keep.has(e.id)) continue;
        total += e.size || 0;
        if (total > MAX_TOTAL_BYTES) continue;
        kept.push(e);
    }

    // Drop the files for anything that did not survive.
    const keptIds = new Set(kept.map((e) => e.id));
    for (const e of entries) {
        if (keptIds.has(e.id) || !e.file) continue;
        try {
            fs.unlinkSync(path.join(CACHE_DIR, e.file));
        } catch { /* already gone */ }
    }

    return kept;
}

/** Capture every status in a messages.upsert payload. */
async function capture(sock, upsert) {
    const messages = upsert?.messages || [];
    for (const msg of messages) {
        if (msg?.key?.remoteJid !== 'status@broadcast') continue;
        await captureMessage(sock, msg);
    }
}

// ------------------------------------------------------------------ lookups ---

/** Cached statuses for one contact, newest first. Accepts any ref form. */
function listFor(ref) {
    const resolved = resolveRef(ref);
    if (!resolved.contact) return [];
    return entriesFor(resolved.contact);
}

function entriesFor(contact) {
    const entries = readIndex();
    return entries
        .filter((e) => {
            if (contact.number && e.number === contact.number) return true;
            if (contact.lid && e.lid === contact.lid) return true;
            if (contact.jid && e.jid === contact.jid) return true;
            return false;
        })
        .sort((a, b) => b.ts - a.ts);
}

/** One row per contact that has anything cached, newest first. */
function listContacts() {
    const byKey = new Map();
    for (const e of readIndex()) {
        const k = keyOf(e);
        const cur = byKey.get(k);
        if (!cur) {
            byKey.set(k, {
                key: k,
                jid: e.jid,
                number: e.number || null,
                lid: e.lid || null,
                name: e.name || null,
                ts: e.ts,
                count: 1,
            });
            continue;
        }
        cur.count += 1;
        if (e.ts > cur.ts) cur.ts = e.ts;
        // A later entry may carry an identity the first one lacked.
        cur.name = cur.name || e.name || null;
        cur.number = cur.number || e.number || null;
        cur.lid = cur.lid || e.lid || null;
    }

    const contacts = [...byKey.values()].sort((a, b) => b.ts - a.ts);
    for (const c of contacts) c.label = labelFor(c);
    return contacts;
}

/**
 * Work out which cached contact a user-supplied reference means.
 *
 * Accepted forms, in the order they are tried:
 *   `#3`            — the index shown in the listing (1-based)
 *   `923701609799`  — a phone number (exact, or a unique suffix)
 *   `123456789012`  — a LID, as shown when the phone number is unknown
 *   `Ali`           — a contact name (case-insensitive substring)
 *   `…@s.whatsapp.net` / `…@lid` — a JID
 *
 * @returns {{contact: object|null, reason?: 'empty'|'not-found'|'ambiguous', matches?: object[]}}
 */
function resolveRef(ref) {
    const raw = String(ref == null ? '' : ref).trim();
    if (!raw) return { contact: null, reason: 'empty' };

    const contacts = listContacts();

    // 1. Explicit listing index.
    const idxMatch = raw.match(/^#(\d{1,3})$/);
    if (idxMatch) {
        const i = Number(idxMatch[1]);
        if (i >= 1 && i <= contacts.length) return { contact: contacts[i - 1] };
        return { contact: null, reason: 'not-found' };
    }

    // 2. JID.
    if (raw.includes('@')) {
        const hit = contacts.find((c) => c.jid === raw || (c.jid && numberFromJid(c.jid) === numberFromJid(raw)));
        return hit ? { contact: hit } : { contact: null, reason: 'not-found' };
    }

    // 3. Phone number or LID — digits only, allowing spaces, +, dashes.
    const digits = raw.replace(/[^\d]/g, '');
    if (digits && digits.length === raw.replace(/[\s+\-()]/g, '').length) {
        const exact = contacts.filter((c) => c.number === digits || c.lid === digits || c.key === digits);
        if (exact.length === 1) return { contact: exact[0] };

        // A trailing fragment is a common way to type a number; only accept it
        // when it identifies exactly one contact.
        if (digits.length >= 6) {
            const suffix = contacts.filter((c) =>
                (c.number && c.number.endsWith(digits)) || (c.lid && c.lid.endsWith(digits)));
            if (suffix.length === 1) return { contact: suffix[0] };
            if (suffix.length > 1) return { contact: null, reason: 'ambiguous', matches: suffix };
        }
        return { contact: null, reason: 'not-found' };
    }

    // 4. Name.
    const needle = raw.toLowerCase();
    const named = contacts.filter((c) => String(c.name || '').toLowerCase().includes(needle));
    if (named.length === 1) return { contact: named[0] };
    if (named.length > 1) return { contact: null, reason: 'ambiguous', matches: named };

    return { contact: null, reason: 'not-found' };
}

/**
 * Fill in missing names / phone numbers on entries written before identity was
 * recorded, so an existing cache becomes readable instead of staying opaque.
 *
 * Bounded: at most `limit` lookups per call, and only for entries that are
 * actually missing something. Persists only when something changed.
 *
 * @returns {Promise<number>} how many entries were improved
 */
async function backfill(sock, limit = 25) {
    if (!sock) return 0;

    const entries = readIndex();
    let touched = 0;
    let lookups = 0;
    let changed = false;

    for (const entry of entries) {
        if (lookups >= limit) break;
        const needsNumber = isLidJid(entry.jid) && !entry.number;
        const needsName = !entry.name;
        if (!needsNumber && !needsName) continue;

        lookups++;
        const before = `${entry.number}|${entry.lid}|${entry.name}`;
        try {
            const identity = await resolveIdentity(sock, entry.jid, null);
            if (needsNumber && identity.number) entry.number = identity.number;
            if (identity.lid && !entry.lid) entry.lid = identity.lid;
            if (needsName && identity.name) entry.name = identity.name;
        } catch { /* best effort */ }

        if (`${entry.number}|${entry.lid}|${entry.name}` !== before) {
            touched++;
            changed = true;
        }
    }

    if (changed) {
        try { writeIndex(entries); } catch (e) { console.error('[statusCache] backfill write failed:', e.message); }
    }
    return touched;
}

function stats() {
    const entries = readIndex();
    return {
        entries: entries.length,
        contacts: new Set(entries.map((e) => keyOf(e))).size,
        bytes: entries.reduce((s, e) => s + (e.size || 0), 0),
        dir: CACHE_DIR,
    };
}

/**
 * Delete everything, or one contact's entries.
 * Accepts the same reference forms as `.status <ref>`.
 *
 * @param {string} [ref] phone number, LID, JID, `#index` or contact name
 * @returns {number} how many entries were removed
 */
function clear(ref) {
    const entries = readIndex();

    if (!ref) {
        for (const e of entries) {
            if (!e.file) continue;
            try { fs.unlinkSync(path.join(CACHE_DIR, e.file)); } catch { /* already gone */ }
        }
        writeIndex([]);
        return entries.length;
    }

    const resolved = resolveRef(ref);
    if (!resolved.contact) return 0;

    const drop = entriesFor(resolved.contact);
    const dropIds = new Set(drop.map((e) => e.id));
    const keep = entries.filter((e) => !dropIds.has(e.id));

    for (const e of drop) {
        if (!e.file) continue;
        try { fs.unlinkSync(path.join(CACHE_DIR, e.file)); } catch { /* already gone */ }
    }
    writeIndex(keep);
    return drop.length;
}

/** Absolute path of a cached entry's media, or null. */
function filePathFor(entry) {
    if (!entry?.file) return null;
    const p = path.join(CACHE_DIR, entry.file);
    return fs.existsSync(p) ? p : null;
}

/**
 * Drop expired entries (and their files) even when no new status has arrived.
 * Expiry is already enforced on every capture; this covers the idle case so the
 * 24h promise holds without needing a new status to trigger it. Returns the
 * number removed.
 */
function sweep() {
    const entries = readIndex();
    if (!entries.length) return 0;
    const kept = prune(entries);
    if (kept.length === entries.length) return 0;
    writeIndex(kept);
    return entries.length - kept.length;
}

module.exports = {
    capture,
    listFor,
    listContacts,
    resolveRef,
    backfill,
    labelFor,
    stats,
    clear,
    filePathFor,
    numberFromJid,
    isLidJid,
    resolveIdentity,
    sweep,
    // config
    isEnabled,
    setEnabled,
    getAllowlist,
    addToAllowlist,
    removeFromAllowlist,
    clearAllowlist,
    readConfig,
    // exported for tests
    _test: {
        unwrap, prune, normaliseEntry, keyOf, setDataDir, timestampOf,
        MAX_PER_CONTACT, MAX_TOTAL_BYTES, MAX_AGE_SECONDS,
        dirs: () => ({ DATA_DIR, CACHE_DIR, INDEX_FILE, CONFIG_FILE }),
    },
};
