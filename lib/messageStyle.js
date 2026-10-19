/**
 * messageStyle — central visual identity for Optimus Bot responses.
 *
 * Consistent symbols (Phase 12):
 *   ✅ success · ❌ error · ⚠️ warning · ℹ️ info · ⏳ processing
 *   🔒 permission · 👑 owner · 🛡️ admin · 🤖 bot
 *
 * Two shapes:
 *   - Compact (default): single line, e.g. `✅ Download completed successfully.`
 *   - Card (`box`, `make(..., {box:true})`): a bold title, a thin rule that
 *     separates the heading from the body, the body, and a band of colour
 *     squares as a closing accent.
 *
 * Commands keep full control of their content; these helpers only provide the
 * shared frame. Nothing here talks to WhatsApp — callers pass the resulting
 * string to sock.sendMessage / reply as before.
 */

const settings = require('../settings');

const ICONS = Object.freeze({
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    processing: '⏳',
    lock: '🔒',
    owner: '👑',
    admin: '🛡️',
    bot: '🤖'
});

const BOT_NAME = () => settings.botName || 'Optimus Bot';

// WhatsApp has no text colour, so the "colour" of a card comes from a band of
// coloured squares. The square is inferred from the leading icon of the title
// (green = success, red = error/denied, amber = warning, blue = info, purple = bot).
const ACCENT_MAP = [
    ['✅', '🟩'], ['❌', '🟥'], ['⚠', '🟨'], ['ℹ', '🟦'],
    ['🔒', '🟥'], ['👑', '🟨'], ['🛡', '🟦'], ['🤖', '🟪'],
];
const DEFAULT_ACCENT = '🟦';

/** Colour square for a card, inferred from its leading icon. */
function accentFor(label) {
    const s = String(label);
    for (const [icon, sq] of ACCENT_MAP) if (s.startsWith(icon)) return sq;
    return DEFAULT_ACCENT;
}

/**
 * A thin rule, used to separate a card's heading from its body.
 *
 * The docstring for box() has promised this divider since Phase 12 and the code
 * never drew one — without it a title and its first body line are visually
 * indistinguishable in a WhatsApp message, which is what makes the long status
 * cards read as a wall of text.
 *
 * @param {number} [len] characters; defaults to the rule length that reads well
 *                       at chat font sizes (matches most titles)
 */
function divider(len = 13) {
    return '─'.repeat(Math.max(3, Math.min(32, Math.round(len))));
}

/**
 * Render a banner card — the bot's primary layout.
 *
 * Shape:
 *   *✅ SUCCESS*
 *   ─────────────
 *   <content line>
 *   🟩🟩🟩🟩🟩🟩
 *
 * A bold title line, a thin rule that separates the heading from the body, the
 * body, then a coloured square band (matched to the message type) as a closing
 * accent — keeps the top of the card clean.
 *
 * @param {string} label   title text, e.g. "✅ SUCCESS" (rendered bold)
 * @param {string|string[]} content body lines
 * @param {string} [accent] optional colour square override (e.g. '🟩')
 */
function box(label, content, accent) {
    const lines = Array.isArray(content) ? content : [content];
    const body = [];
    for (const raw of lines) {
        for (const line of String(raw).split('\n')) body.push(line);
    }
    const title = `*${label}*`;
    const rule = divider(Math.max(String(label).length, 13));
    const band = (accent || accentFor(label)).repeat(6);
    return [title, rule, ...body, band].join('\n');
}

/**
 * Aligned `Label : value` rows.
 *
 * The old format was `Label: *value*` hand-written per call, so the colons were
 * never in a column and the eye had to hunt for them. Values keep their own
 * formatting (`*bold*` etc.) — this only fixes the gutter.
 *
 * @param {Array<[string,string]>} pairs
 * @param {number} [gap] spaces either side of the colon
 * @returns {string[]} one line per pair
 */
function rows(pairs, gap = 1) {
    const clean = (pairs || []).filter(([k, v]) => String(k || '').trim() && String(v ?? '').trim() !== '');
    if (!clean.length) return [];
    const width = Math.max(...clean.map(([k]) => String(k).trim().length));
    const pad = ' '.repeat(Math.max(0, gap));
    return clean.map(([k, v]) => `${String(k).trim().padEnd(width, ' ')}${pad}:${pad}${v}`);
}

function make(icon, label, message, opts = {}) {
    const text = String(message == null ? '' : message).trim();
    if (opts.box) {
        const lines = [text];
        if (opts.usage) lines.push('', 'Usage:', ` ${opts.usage}`);
        return box(`${icon} ${label}`, lines);
    }
    return `${icon} ${text}`;
}

/** ✅ Success message. `{ box: true }` for the card form, `usage` adds a usage line. */
function success(message, opts) { return make(ICONS.success, 'SUCCESS', message, opts); }

/** ❌ Error message. Never include stack traces / paths / keys in `message`. */
function error(message, opts) { return make(ICONS.error, 'ERROR', message, opts); }

/** ⚠️ Warning message. */
function warning(message, opts) { return make(ICONS.warning, 'WARNING', message, opts); }

/** ℹ️ Informational message. */
function info(message, opts) { return make(ICONS.info, 'INFO', message, opts); }

/** ⏳ Processing message (kept compact — one line, no box). */
function processing(message) {
    return `${ICONS.processing} ${String(message).replace(/\.{3,}$/, '')}...`;
}

/** ✅ Completion message (alias of success for symmetry). */
function completed(message, opts) { return success(message, opts); }

/**
 * 🔒 Permission-denied messages, one per existing permission scope.
 * Boxed by default; pass `{ box: false }` for a compact single line.
 */
function permissionDenied(scope, opts = {}) {
    const messages = {
        owner: `${ICONS.owner} Only the bot owner can use this command.`,
        ownerOrSudo: `${ICONS.owner} This command is only available for the owner or sudo.`,
        admin: `${ICONS.admin} Only group admins can use this command.`,
        botAdmin: `${ICONS.bot} Please make the bot an admin to use this command.`,
        group: `${ICONS.info} This command can only be used in groups.`,
        private: `${ICONS.info} This command can only be used in private chat.`
    };
    const text = messages[scope] || messages.ownerOrSudo;
    if (opts.box === false) return text;
    return box(`${ICONS.lock} ACCESS DENIED`, [text]);
}

/** ❌ "X not found." — boxed by default. */
function notFound(what, opts = {}) {
    const text = `${what} not found.`;
    if (opts.box === false) return `${ICONS.error} ${text}`;
    return box(`${ICONS.error} NOT FOUND`, [text]);
}

/** ❌ Invalid input, with an optional usage hint. */
function invalidInput(what, usage, opts = {}) {
    const lines = [what || 'Invalid input.'];
    if (usage) lines.push('', 'Usage:', ` ${usage}`);
    if (opts.box === false) return `${ICONS.error} ${lines[0]}`;
    return box(`${ICONS.error} INVALID INPUT`, lines);
}

/**
 * 🤖 Branded menu header.
 * @param {{ user?: string, prefix?: string, mode?: string }} ctx
 */
function menuHeader(ctx = {}) {
    const lines = [];
    if (ctx.user) lines.push(`${ICONS.bot} Welcome, ${ctx.user}`);
    if (ctx.prefix) lines.push(`${ICONS.info} Prefix : ${ctx.prefix}`);
    if (ctx.mode) lines.push(`${ICONS.lock} Mode   : ${ctx.mode}`);
    if (!lines.length) lines.push(`${ICONS.bot} ${BOT_NAME()}`);
    return box(`🤖 ${BOT_NAME().toUpperCase()}`, lines);
}

/**
 * Split a long message into chunks at newline boundaries, never splitting a
 * single line in half. Safe for any message; menu blocks use splitBlocks.
 * @param {string} text
 * @param {number} maxLen max characters per chunk
 * @returns {string[]}
 */
function splitLong(text, maxLen = 3000) {
    const chunks = [];
    let current = '';
    for (const line of String(text).split('\n')) {
        if (line.length > maxLen) {
            // Pathological single line: hard-slice it (keeps the function total).
            if (current) { chunks.push(current); current = ''; }
            for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
            continue;
        }
        if (current && current.length + 1 + line.length > maxLen) {
            chunks.push(current);
            current = '';
        }
        current = current ? `${current}\n${line}` : line;
    }
    if (current) chunks.push(current);
    return chunks;
}

/**
 * Split pre-built blocks (category cards, headers, footers) into chunks of
 * ≤ maxLen. Blocks are atomic: a block never straddles two chunks.
 * @param {string[]} blocks
 * @param {number} maxLen
 * @returns {string[]}
 */
function splitBlocks(blocks, maxLen = 3000) {
    const chunks = [];
    let current = '';
    for (const block of blocks) {
        const sep = current ? '\n\n' : '';
        if (block.length > maxLen) {
            // Overlong single block: fall back to line-based splitting.
            if (current) { chunks.push(current); current = ''; }
            chunks.push(...splitLong(block, maxLen));
            continue;
        }
        if (current && current.length + sep.length + block.length > maxLen) {
            chunks.push(current);
            current = block;
        } else {
            current = current ? current + sep + block : block;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

module.exports = {
    ICONS,
    BOT_NAME,
    box,
    divider,
    rows,
    accentFor,
    success,
    error,
    warning,
    info,
    processing,
    completed,
    permissionDenied,
    notFound,
    invalidInput,
    menuHeader,
    splitLong,
    splitBlocks
};
