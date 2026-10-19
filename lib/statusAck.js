/**
 * Ack incoming top-level <status> stanzas. See WHY below.
 */
const { buildAckStanza } = require('@whiskeysockets/baileys/lib/Utils/stanza-ack');

/**
 * WHY
 * ---
 * Baileys v7 (verified in the version Optimus installs, 7.0.0-rc13, and reported
 * still unhandled on rc.9 / rc.14 / master) registers handlers for CB:message,
 * CB:call, CB:receipt, CB:notification and CB:ack,class:message — but NOT for
 * CB:status. Since ~late 2026 WhatsApp has been delivering some accounts' status
 * updates (stories) as a top-level <status> stanza instead of
 * <message from="status@broadcast">. Baileys never matches it, so the client
 * never acks it. ~50 minutes later the server closes the stream and names the
 * missing ack:
 *
 *     {"tag":"stream:error",...,"content":[{"tag":"ack","attrs":{"class":"status",
 *        "type":"media","id":"..."}}]}
 *
 * This surfaces as `Error: Stream Errored (ack)` and is mapped to status 500
 * (badSession), because `ack` is not in CODE_MAP. On reconnect the same pending
 * <status> is redelivered, never acked, and the loop repeats ~every 50 minutes.
 *
 * Upstream: WhiskeySockets/Baileys#2858 — opened 2026-10-14, still open, no
 * released version contains the fix at the time of writing. The reporter's
 * recommended fix is `ws.on('CB:status', node => sendMessageAck(node).catch(...))`.
 *
 * HOW WE FIX IT (reproducible — no node_modules edits)
 * ---------------------------------------------------
 * The connection layer emits a `CB:<tag>` event for EVERY top-level node (Baileys
 * socket.js `onMessageReceived`: `ws.emit('CB:' + tag, frame)`), so a top-level
 * <status> fires `CB:status` even though no internal handler is registered. We
 * attach our own listener on every freshly created socket and ack the stanza with
 * Baileys' own acknowledgment primitive:
 *
 *   - Prefer `sock.sendMessageAck(node)` — the exact function the upstream fix
 *     calls. Internally it runs `buildAckStanza(node)` then `sendNode`, with no
 *     error code (a NACK would keep the stanza pending and the drop would recur).
 *   - Fall back to `buildAckStanza(node) + sock.sendNode(ack)` for builds where
 *     `sendMessageAck` is unavailable.
 *
 * The fix lives in Optimus source (lib/statusAck.js) and uses only public Baileys
 * APIs, so it is reproducible on any clean install of the pinned version — no
 * patch file and no undocumented edit inside node_modules.
 *
 * GUARD RAILS (per the brief)
 * - Only <status> stanzas are acked. We never ack arbitrary unknown nodes, and we
 *   never ack incoming <ack> nodes (those are the server's responses to us).
 * - The ack is wrapped so a failure can never bubble into the websocket dispatch
 *   or leave any offline processor stuck.
 * - No session is deleted and no re-pair is forced for this failure; the
 *   connection supervisor still treats a 500 as a retry.
 *
 * OFFLINE ORDERING
 * ----------------
 * A <status offline="true"> is a redelivery during the catch-up batch. Baileys
 * has no status handler, so there is no Baileys-side offline flow for it. To
 * "route through the existing offline processor" without patching node_modules
 * we run an equivalent ordered, failure-isolated queue: pending offline statuses
 * are acked in arrival order, and a single rejected ack is caught and logged so
 * it can never leave the queue stuck (the rc.9 trap the upstream reporter hit,
 * where a throw inside a node processor left `isProcessing` true and blocked
 * every later offline node).
 */
function registerStatusAck(sock) {
    if (!sock || !sock.ws || typeof sock.ws.on !== 'function') {
        return () => {};
    }

    // Baileys' acknowledgment primitive. sendMessageAck is exactly what upstream's
    // #2858 fix uses; buildAckStanza + sendNode is the identical fallback for
    // builds that do not expose sendMessageAck. Always returns a promise so a
    // synchronous throw inside sendNode becomes a rejection we can .catch, never
    // an exception that escapes the websocket dispatch.
    const ackSender = (node) => {
        try {
            if (typeof sock.sendMessageAck === 'function') {
                return sock.sendMessageAck(node);
            }
            const ack = buildAckStanza(node, undefined, sock.user && sock.user.id);
            return sock.sendNode(ack);
        } catch (err) {
            return Promise.reject(err);
        }
    };

    // Ordered, failure-isolated processor for OFFLINE status stanzas. Mirrors
    // Baileys' makeOfflineNodeProcessor contract: sequential in arrival order,
    // every handler error is contained, and `draining` can never be left `true`.
    const offlineQueue = [];
    let draining = false;
    async function drainOffline() {
        if (draining) return;
        draining = true;
        try {
            while (offlineQueue.length) {
                const node = offlineQueue.shift();
                try {
                    await ackSender(node);
                } catch (err) {
                    console.error('[status-ack] offline ack failed, continuing queue:',
                        err && err.message ? err.message : err);
                }
            }
        } finally {
            draining = false;
        }
    }

    const handler = (node) => {
        // Only acknowledge top-level <status> stanzas. An incoming <ack> (the
        // server's own ack of our traffic) must never be re-acked, and we do not
        // ack other unknown tags.
        if (!node || node.tag !== 'status') return;

        // Redelivered (offline) statuses go through the ordered queue so acks are
        // sent in arrival order and one bad stanza cannot strand the rest.
        if (node.attrs && node.attrs.offline === 'true') {
            offlineQueue.push(node);
            // Kick the drainer as a microtask; never block the dispatch.
            Promise.resolve().then(drainOffline).catch(() => {});
            return;
        }

        // Online statuses are acked immediately.
        ackSender(node).catch((err) => {
            console.error('[status-ack] failed to send ack:',
                err && err.message ? err.message : err);
        });
    };

    sock.ws.on('CB:status', handler);
    return handler;
}

module.exports = { registerStatusAck };
