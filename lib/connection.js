/**
 * connection — one socket, one reconnect loop, one place that decides.
 *
 * WHY THIS EXISTS
 *   Both entry points (index.js and mini.js) used to reconnect from inside the
 *   `connection.update` handler, calling the connect function again with a fixed
 *   delay. That looks harmless and is not:
 *
 *     - the previous socket was never ended, so a "reconnect" could leave two
 *       live sockets on the same credentials, each with its own handlers;
 *     - a socket that emits `close` twice (or a close plus a throw in the
 *       connect path) scheduled two reconnects, and each of those scheduled
 *       two more — the classic runaway loop;
 *     - every status code except 401 was treated as "retry", including 440
 *       (connectionReplaced — another session owns this account) and 403/411,
 *       where retrying is guaranteed to fail and actively fights the other
 *       session;
 *     - the delay was constant, so a persistently failing handshake hammered
 *       WhatsApp every five seconds.
 *
 * WHAT IT DOES
 *   `createSupervisor()` owns the socket lifecycle:
 *     adopt(sock)          register the active socket, ending any previous one
 *     handle(sock, update) ignore updates from stale sockets; act on open/close
 *     stop()               cancel any pending reconnect (shutdown)
 *
 *   The decision itself is pure and lives in `classifyDisconnect()`, so the
 *   policy is testable without a network: 401 → re-authenticate, 403/411/440 →
 *   stop, everything transient → reconnect with exponential backoff.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   - It never deletes credentials. `onClose` decides that for 401 only; a
 *     badSession (500) is retried, because "stream errored (ack)" is what a
 *     transient handshake failure looks like and the creds are usually fine.
 *   - It never logs credential material. `describeDisconnect()` returns the
 *     status code and message only.
 *   - It adds no dependencies and no timers beyond the single reconnect one.
 */

const { DisconnectReason } = require('@whiskeysockets/baileys');

/**
 * What to do for each status code the library can emit.
 *
 * 401 loggedOut        — the device was unlinked. Reconnecting cannot work;
 *                        the session must be re-paired.
 * 403 forbidden        — the account is blocked/banned.
 * 411 multidevice      — the client is not on the multi-device beta; retrying
 *                        produces the same refusal.
 * 440 replaced         — another client connected with the same credentials.
 *                        Retrying here is what turns one conflict into an
 *                        endless fight between two processes.
 * 500 badSession       — session state is suspect. Retried, but it counts
 *                        toward the give-up budget: a permanently corrupt
 *                        session must not loop forever.
 * 515 restartRequired  — a normal part of the handshake; always retry.
 */
const ACTIONS = Object.freeze({
    [DisconnectReason.loggedOut]: 'reauth',
    [DisconnectReason.forbidden]: 'stop',
    [DisconnectReason.multideviceMismatch]: 'stop',
    [DisconnectReason.connectionReplaced]: 'stop',
    [DisconnectReason.badSession]: 'reconnect',
    [DisconnectReason.restartRequired]: 'reconnect',
    [DisconnectReason.connectionClosed]: 'reconnect',
    [DisconnectReason.connectionLost]: 'reconnect',
    [DisconnectReason.timedOut]: 'reconnect',
    [DisconnectReason.unavailableService]: 'reconnect',
});

/** Human labels for the codes we are likely to see. Never includes secrets. */
const REASONS = Object.freeze({
    [DisconnectReason.loggedOut]: 'logged out (device unlinked)',
    [DisconnectReason.forbidden]: 'forbidden (account blocked)',
    [DisconnectReason.multideviceMismatch]: 'multi-device mismatch',
    [DisconnectReason.connectionReplaced]: 'connection replaced (another session)',
    [DisconnectReason.badSession]: 'bad session',
    [DisconnectReason.restartRequired]: 'restart required',
    [DisconnectReason.connectionClosed]: 'connection closed',
    [DisconnectReason.connectionLost]: 'connection lost',
    [DisconnectReason.timedOut]: 'timed out',
    [DisconnectReason.unavailableService]: 'service unavailable',
});

/**
 * Decide what a disconnect means.
 *
 * @param {number|undefined} statusCode
 * @returns {{action: 'reconnect'|'reauth'|'stop', reason: string, statusCode: number|null}}
 */
function classifyDisconnect(statusCode) {
    // `Number(null)` is 0 and `Number('')` is 0 — both would be mistaken for a
    // real code, so the absence of a code is checked before coercion.
    if (statusCode === null || statusCode === undefined || statusCode === '') {
        return { action: 'reconnect', reason: 'unknown (no status code)', statusCode: null };
    }
    const code = Number(statusCode);
    if (!Number.isFinite(code)) {
        // A close without a usable status code is what a dropped socket looks
        // like, and retrying is the right default.
        return { action: 'reconnect', reason: 'unknown (no status code)', statusCode: null };
    }
    return {
        action: ACTIONS[code] || 'reconnect',
        reason: REASONS[code] || 'unrecognised status code',
        statusCode: code,
    };
}

/**
 * Strip anything credential-shaped out of an error message.
 *
 * The library's disconnect messages are plain ("Stream Errored (ack)"), but this
 * string is logged and could in principle carry a JID or a key fragment from an
 * underlying error. Diagnostics must never be the thing that leaks a session.
 */
function sanitizeMessage(message) {
    return String(message == null ? '' : message)
        .replace(/[\w.+-]+@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)/gi, '<redacted-jid>')
        // A serialised key pair, however it got in there.
        .replace(/\{[^{}]*"(?:private|public|key|secret|noise)[^{}]*\}/gi, '<redacted-key>')
        .replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '<redacted-key>')
        .slice(0, 200);
}

/**
 * Extract safe, redaction-safe detail from a Baileys stream-error node.
 *
 * When WhatsApp closes the stream it sends a `<stream:error>` element. Baileys
 * attaches the offending node to `error.output.data` (the child of the
 * `<stream:error>` — e.g. an `<ack class="status" .../>` node) and the resolved
 * status code to `error.output.statusCode`. So a close like
 *
 *     <stream:error code="515"><ack class="status" type="retry" id="3EB.AB"/></stream:error>
 *
 * carries `code=515` and `reasonClass="status"`. A bare `<stream:error><ack/></stream:error>`
 * (no `code`) is what "Stream Errored (ack)" is — Baileys defaults it to 500, and
 * the reason tag is then the only signal we have.
 *
 * We read ONLY the structural labels (`reason` tag, `class`, `type`). Anything
 * that can identify a message or an account — `id`, `from`, `to`, `participant`,
 * key material — is never read into the diagnostic, so this cannot leak a
 * session even by accident.
 *
 * @param {{error?: {output?: {statusCode?: number, data?: object}}}|undefined} lastDisconnect
 * @returns {null | {code: number|null, reasonTag: string|null, reasonClass: string|null, reasonType: string|null}}
 */
function diagnoseStreamError(lastDisconnect) {
    const source = lastDisconnect && lastDisconnect.lastDisconnect
        ? lastDisconnect.lastDisconnect
        : lastDisconnect;
    const out = source && source.error && source.error.output;
    if (!out || typeof out !== 'object') return null;

    // Mirror classifyDisconnect: a missing code is `null`, never 0. (Number(null)
    // is 0, which would masquerade as a real status code.)
    const rawCode = out.statusCode;
    const code = (rawCode === null || rawCode === undefined || rawCode === '')
        ? null
        : (Number.isFinite(Number(rawCode)) ? Number(rawCode) : null);

    // `data` is the node Baileys attached. Normally it is the `<ack>` (or other)
    // child of `<stream:error>`; when the error has no child it falls back to the
    // whole `<stream:error>` node. Either way we only ever touch the tag and the
    // `class` / `type` attributes — never id/from/to/participant.
    const node = out.data;
    let reasonTag = null;
    let reasonClass = null;
    let reasonType = null;

    if (node && typeof node === 'object') {
        const attrs = (node.attrs && typeof node.attrs === 'object') ? node.attrs : {};
        const isOuter = node.tag === 'stream:error';
        // Baileys hands us either the `<ack>`-style child (tag = the reason) or,
        // when there is no child, the whole `<stream:error>` node (no reason to report).
        if (!isOuter) {
            reasonTag = typeof node.tag === 'string' ? node.tag : null;
            reasonClass = attrs.class != null ? String(attrs.class) : null;
            reasonType = attrs.type != null ? String(attrs.type) : null;
        }
        // A child element, if present, is the actual reason regardless of shape.
        const child = Array.isArray(node.content) ? node.content[0] : null;
        if (child && child.tag) {
            reasonTag = child.tag;
            const cattrs = (child.attrs && typeof child.attrs === 'object') ? child.attrs : {};
            if (reasonClass == null && cattrs.class != null) reasonClass = String(cattrs.class);
            if (reasonType == null && cattrs.type != null) reasonType = String(cattrs.type);
        }
    }

    return { code, reasonTag, reasonClass, reasonType };
}

/**
 * Human-readable, redaction-safe one-liner of the stream-error detail, or null
 * when there is nothing to report. Used purely for logging.
 */
function formatStreamDiagnostic(diag) {
    if (!diag) return null;
    const parts = [];
    parts.push(`code=${diag.code != null ? diag.code : 'none'}`);
    if (diag.reasonTag != null) parts.push(`reason=${diag.reasonTag}`);
    if (diag.reasonClass != null) parts.push(`class=${diag.reasonClass}`);
    if (diag.reasonType != null) parts.push(`type=${diag.reasonType}`);
    return parts.join(' · ');
}

/**
 * Pull the useful fields out of a `lastDisconnect`, without touching anything
 * that could contain credentials.
 *
 * @param {{error?: Error & {output?: {statusCode?: number, data?: unknown}}, lastDisconnect?: object}|undefined} lastDisconnect
 * @returns {{statusCode: number|null, message: string, action: string, reason: string, stream: object|null}}
 */
function describeDisconnect(lastDisconnect) {
    // Accept either the `lastDisconnect` object or the whole connection.update
    // payload — callers reach for both, and unwrapping here is cheaper than a
    // silently empty diagnostic.
    const source = lastDisconnect && lastDisconnect.lastDisconnect
        ? lastDisconnect.lastDisconnect
        : lastDisconnect;
    const err = source && source.error;
    const statusCode = err && err.output && Number.isFinite(Number(err.output.statusCode))
        ? Number(err.output.statusCode)
        : null;

    const { action, reason } = classifyDisconnect(statusCode);
    return {
        statusCode,
        message: sanitizeMessage(err && err.message ? err.message : 'no error object'),
        action,
        reason,
        stream: diagnoseStreamError(lastDisconnect),
    };
}

/**
 * Exponential backoff with jitter, capped.
 *
 * @param {{baseMs?: number, maxMs?: number, jitter?: number, maxAttempts?: number, stableAfterMs?: number}} [opts]
 */
function createBackoff(opts = {}) {
    const baseMs = Number(opts.baseMs) || 3000;
    const maxMs = Number(opts.maxMs) || 60000;
    const jitter = Number.isFinite(opts.jitter) ? opts.jitter : 0.2;
    const maxAttempts = Number(opts.maxAttempts) || 10;
    const stableAfterMs = Number(opts.stableAfterMs) || 60000;

    let attempts = 0;
    let openedAt = 0;

    return {
        /** Delay for the next attempt, in ms. Increments the attempt counter. */
        next(rand = Math.random) {
            attempts += 1;
            const raw = Math.min(maxMs, baseMs * Math.pow(2, attempts - 1));
            // Jitter downwards only, so the cap is never exceeded.
            const spread = raw * jitter;
            return Math.round(raw - spread * rand());
        },

        /** A connection opened. */
        noteOpen(now = Date.now()) { openedAt = now; },

        /**
         * A connection closed. If it had been up for `stableAfterMs` the run
         * counted as healthy, so the retry budget starts fresh — a bot that is
         * up for hours and then drops must not be "out of attempts". A short
         * open/close flap keeps the counter, which is what makes a flapping
         * handshake eventually give up instead of looping forever.
         */
        noteClose(now = Date.now()) {
            const stable = openedAt && now - openedAt >= stableAfterMs;
            openedAt = 0;
            if (stable) attempts = 0;
        },

        /** A fresh start (boot, or after a deliberate re-pair). */
        reset() { attempts = 0; openedAt = 0; },

        get attempts() { return attempts; },
        get exhausted() { return attempts >= maxAttempts; },
        get maxAttempts() { return maxAttempts; },
    };
}

/** End a socket and detach its listeners so it cannot fire again. */
function disposeSocket(sock) {
    if (!sock) return;
    try {
        if (typeof sock.ev?.removeAllListeners === 'function') sock.ev.removeAllListeners();
    } catch { /* older shapes */ }
    try {
        if (typeof sock.end === 'function') sock.end(undefined);
    } catch { /* already closed */ }
}

/**
 * Own the socket lifecycle and the reconnect loop.
 *
 * @param {{
 *   connect: () => Promise<void>,
 *   onOpen?: (sock: object, meta: object) => Promise<void>|void,
 *   onClose?: (info: object, decision: object) => Promise<void>|void,
 *   log?: (line: string) => void,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   backoff?: ReturnType<typeof createBackoff>,
 *   now?: () => number,
 * }} opts
 */
function createSupervisor(opts = {}) {
    const connect = opts.connect;
    const onOpen = opts.onOpen || (() => { });
    const onClose = opts.onClose || (() => { });
    const log = opts.log || ((line) => console.log(line));
    const timers = opts.timers || { setTimeout, clearTimeout };
    const now = opts.now || Date.now;
    const backoff = opts.backoff || createBackoff();

    let socket = null;
    let reconnectTimer = null;
    let stopped = false;
    let connecting = false;
    let opened = 0;
    let closed = 0;
    let lastInfo = null;

    /** The current socket, or null. */
    function current() { return socket; }

    /** Is this update coming from the socket we are actually using? */
    function isCurrent(candidate) { return candidate === socket; }

    /**
     * Register a freshly created socket. Any previous socket is ended first —
     * two sockets on one set of credentials is what produces the 440 conflict
     * loop, and it also doubles every message handler.
     */
    function adopt(next) {
        if (!next) return;
        if (socket && socket !== next) {
            log('[conn] ending previous socket before adopting the new one');
            disposeSocket(socket);
        }
        socket = next;
    }

    function scheduleReconnect(info) {
        if (stopped) return;
        if (reconnectTimer) {
            // A second close while a retry is already pending must not queue a
            // second reconnect — that is how one loop becomes two.
            log('[conn] close received while a retry is pending — ignoring');
            return;
        }

        if (backoff.exhausted) {
            stopped = true;
            log(`[conn] giving up after ${backoff.attempts} failed attempts — re-pairing is required`);
            return;
        }

        const wait = backoff.next();
        log(`[conn] reconnecting in ${(wait / 1000).toFixed(1)}s (attempt ${backoff.attempts}/${backoff.maxAttempts})`);
        reconnectTimer = timers.setTimeout(() => {
            reconnectTimer = null;
            if (stopped) return;
            Promise.resolve()
                .then(() => connect())
                .catch((e) => {
                    log(`[conn] connect() threw: ${e && e.message ? e.message : e}`);
                    // The throw is itself a failed attempt; go around again
                    // through the same single scheduler.
                    scheduleReconnect({ statusCode: null, message: String(e && e.message || e) });
                });
        }, wait);
        if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
    }

    /**
     * Handle one `connection.update`.
     *
     * @returns {Promise<{handled: boolean, action?: string}>} handled=false for
     *          an update from a socket that is no longer current.
     */
    async function handle(candidate, update = {}) {
        if (!isCurrent(candidate)) {
            return { handled: false, action: 'stale-socket' };
        }

        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            opened += 1;
            connecting = false;
            backoff.noteOpen(now());
            const meta = {
                attempt: opened,
                since: new Date(now()).toISOString(),
                user: candidate?.user?.id ? String(candidate.user.id).split(':')[0] : null,
            };
            log(`[conn] OPEN — connection #${opened} established${meta.user ? ` as ${meta.user}` : ''}`);
            try { await onOpen(candidate, meta); } catch (e) {
                log(`[conn] onOpen handler failed: ${e && e.message ? e.message : e}`);
            }
            return { handled: true, action: 'open' };
        }

        if (connection === 'close') {
            closed += 1;
            connecting = false;
            const info = describeDisconnect(lastDisconnect);
            lastInfo = info;
            backoff.noteClose(now());

            // The socket is done either way; clear it so a late update from it
            // is treated as stale.
            socket = null;
            disposeSocket(candidate);

            const decision = classifyDisconnect(info.statusCode);
            log(`[conn] CLOSE #${closed} — status ${info.statusCode ?? 'none'} · ${info.reason} · ${info.message}`);
            const diagLine = formatStreamDiagnostic(info.stream);
            if (diagLine) {
                log(`[conn] STREAM-ERROR detail — ${diagLine}`);
            }
            log(`[conn] decision: ${decision.action}`);

            try { await onClose(info, decision); } catch (e) {
                log(`[conn] onClose handler failed: ${e && e.message ? e.message : e}`);
            }

            if (decision.action === 'reconnect') {
                scheduleReconnect(info);
                return { handled: true, action: 'reconnect' };
            }

            stopped = true;
            if (decision.action === 'reauth') {
                log('[conn] session is no longer valid — not reconnecting. Re-pair the bot.');
            } else {
                log(`[conn] not reconnecting (${info.reason}).`);
            }
            return { handled: true, action: decision.action };
        }

        if (connection === 'connecting') {
            connecting = true;
            return { handled: true, action: 'connecting' };
        }

        return { handled: true, action: 'noop' };
    }

    /**
     * A connect attempt threw before it could open. Treated exactly like a
     * close with no status code: retry through the same single scheduler.
     */
    function reportConnectError(error) {
        const message = error && error.message ? error.message : String(error);
        log(`[conn] connect() failed before open: ${message}`);
        if (socket) {
            disposeSocket(socket);
            socket = null;
        }
        scheduleReconnect({ statusCode: null, message });
    }

    /** Stop the loop (shutdown, or a deliberate restart). */
    function stop() {
        stopped = true;
        if (reconnectTimer) {
            timers.clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        disposeSocket(socket);
        socket = null;
    }

    function state() {
        return {
            connected: Boolean(socket),
            connecting,
            stopped,
            opens: opened,
            closes: closed,
            attempts: backoff.attempts,
            lastDisconnect: lastInfo,
            pendingRetry: Boolean(reconnectTimer),
        };
    }

    return { adopt, handle, stop, state, current, isCurrent, reportConnectError, _backoff: backoff };
}

module.exports = {
    ACTIONS,
    REASONS,
    classifyDisconnect,
    describeDisconnect,
    diagnoseStreamError,
    formatStreamDiagnostic,
    createBackoff,
    createSupervisor,
    disposeSocket,
    _test: { ACTIONS, REASONS },
};
