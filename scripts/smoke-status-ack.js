#!/usr/bin/env node
/**
 * Smoke test: incoming top-level <status> stanza acknowledgment (Baileys #2858).
 *
 * The bug: Baileys v7 has no CB:status handler, so status stanzas (stories) are
 * never acked. ~50 min later the server closes the stream naming the missing ack
 * with class="status" → "Stream Errored (ack)". This pins the Optimus-side fix:
 * registerStatusAck() must ack exactly those stanzas, with the right attributes,
 * and must never throw, even if the ack send fails.
 *
 * Usage: node scripts/smoke-status-ack.js
 */

const EventEmitter = require('events');
const { registerStatusAck } = require(path_for('lib', 'statusAck'));
const { buildAckStanza } = require('@whiskeysockets/baileys/lib/Utils/stanza-ack');

function path_for(...p) {
    return require('path').join(__dirname, '..', ...p);
}

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('✅ ' + name); }
    else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

/** Build a fake socket whose ws is a real EventEmitter and whose sendNode records. */
function makeSock(opts = {}) {
    const ws = new EventEmitter();
    const sock = {
        ws,
        user: opts.user || { id: '1111111111@s.whatsapp.net' },
        sendNode: opts.sendNode || ((n) => { sock.__sent.push(n); return Promise.resolve(); }),
        __sent: opts.__sent || [],
    };
    // When opts.sendMessageAck is set, the handler must use Baileys' own ack
    // primitive (the brief's recommended mechanism). Record the built ack so the
    // attribute assertions still hold.
    if (opts.sendMessageAck) {
        sock.sendMessageAck = (n) => sock.sendNode(buildAckStanza(n));
    }
    return sock;
}

/** Let queued microtasks / offline drain run before assertions. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

const statusNode = (attrs) => ({ tag: 'status', attrs: attrs || {} });

(async () => {
    console.log('\n=== status stanza ack ===');
    {
        const sock = makeSock();
        registerStatusAck(sock);

        const node = statusNode({
            from: '1234567890@s.whatsapp.net',
            id: '3A20MEDIAID',
            type: 'media',
            participant: 'p@s.whatsapp.net',
            recipient: 'r@s.whatsapp.net',
        });
        sock.ws.emit('CB:status', node);

        check('one ack sent', sock.__sent.length === 1, `sent=${sock.__sent.length}`);
        const ack = sock.__sent[0];
        check('ack tag is "ack"', ack && ack.tag === 'ack');
        check('ack class is "status" (the #2858 requirement)',
            ack && ack.attrs && ack.attrs.class === 'status', JSON.stringify(ack && ack.attrs));
        check('ack carries the original id', ack && ack.attrs.id === '3A20MEDIAID');
        check('ack is addressed back to the sender (to=from)',
            ack && ack.attrs.to === '1234567890@s.whatsapp.net');
        check('ack preserves type', ack && ack.attrs.type === 'media');
        check('ack preserves participant', ack && ack.attrs.participant === 'p@s.whatsapp.net');
        check('ack preserves recipient', ack && ack.attrs.recipient === 'r@s.whatsapp.net');
        check('ack has NO error code (a NACK would keep it pending)',
            ack && ack.attrs.error === undefined, JSON.stringify(ack && ack.attrs));
    }

    console.log('\n=== offline ordering: offline="true" is acked via the ordered queue ===');
    {
        const sock = makeSock();
        registerStatusAck(sock);
        // A redelivered (offline) status must still be acked (now through the
        // ordered queue), and the offline flag must not leak into the ack.
        sock.ws.emit('CB:status', statusNode({ id: 'OFFLINE1', type: 'text', offline: 'true' }));
        await flush();
        check('offline status is acked', sock.__sent.length === 1, `sent=${sock.__sent.length}`);
        check('ack class is "status"', sock.__sent[0] && sock.__sent[0].attrs.class === 'status');
        check('offline flag is not echoed into the ack',
            !('offline' in (sock.__sent[0].attrs || {})));
    }

    console.log('\n=== offline ordering: multiple offline statuses acked in arrival order ===');
    {
        const sock = makeSock();
        registerStatusAck(sock);
        sock.ws.emit('CB:status', statusNode({ id: 'O1', offline: 'true' }));
        sock.ws.emit('CB:status', statusNode({ id: 'O2', offline: 'true' }));
        sock.ws.emit('CB:status', statusNode({ id: 'O3', offline: 'true' }));
        await flush();
        check('three offline statuses produce three acks', sock.__sent.length === 3, `sent=${sock.__sent.length}`);
        check('offline acks preserve arrival order',
            sock.__sent.map((a) => a.attrs.id).join(',') === 'O1,O2,O3',
            sock.__sent.map((a) => a.attrs.id).join(','));
    }

    console.log('\n=== offline error recovery: a failed ack never strands the queue ===');
    {
        const sock = makeSock({
            sendNode: (n) => (n.attrs.id === 'FAIL'
                ? Promise.reject(new Error('network down'))
                : (sock.__sent.push(n), Promise.resolve())),
        });
        registerStatusAck(sock);
        sock.ws.emit('CB:status', statusNode({ id: 'FAIL', offline: 'true' }));
        sock.ws.emit('CB:status', statusNode({ id: 'OK', offline: 'true' }));
        await flush();
        check('a rejected offline ack does not prevent later offline acks',
            sock.__sent.length === 1 && sock.__sent[0].attrs.id === 'OK',
            sock.__sent.map((a) => a.attrs.id).join(','));
    }

    console.log('\n=== guard rails: only <status> is acked ===');
    {
        const sock = makeSock();
        registerStatusAck(sock);
        // An incoming <ack> must never be re-acked.
        sock.ws.emit('CB:status', { tag: 'ack', attrs: { class: 'status', id: 'X' } });
        // An unknown tag must not be acked.
        sock.ws.emit('CB:status', { tag: 'weird', attrs: { id: 'Y' } });
        check('no ack sent for non-status nodes', sock.__sent.length === 0, `sent=${sock.__sent.length}`);
    }

    console.log('\n=== error recovery: a failing ack never throws and is logged ===');
    {
        const errors = [];
        const orig = console.error;
        console.error = (...a) => errors.push(a.map((x) => String(x)).join(' '));
        const sock = makeSock({ sendNode: () => Promise.reject(new Error('network down')) });
        registerStatusAck(sock);
        let threw = false;
        try {
            sock.ws.emit('CB:status', statusNode({ id: 'Z' }));
        } catch (e) {
            threw = true;
        }
        // The .catch logs on a later microtask; let it flush before restoring.
        await flush();
        console.error = orig;
        check('emitting a status does not throw when sendNode rejects', !threw);
        check('the failure is logged, not swallowed silently',
            errors.some((e) => String(e).includes('status-ack')), errors.join(' | '));

        // Synchronous throw inside sendNode must also be contained (ackSender wraps
        // it into a rejected promise, so it never escapes the websocket dispatch).
        const sock2 = makeSock({ sendNode: () => { throw new Error('sync boom'); } });
        let threw2 = false;
        try {
            sock2.ws.emit('CB:status', statusNode({ id: 'W' }));
        } catch (e) {
            threw2 = true;
        }
        check('emitting a status does not throw when sendNode throws synchronously', !threw2);
    }

    console.log('\n=== ack primitive: sendMessageAck path produces a correct ack ===');
    {
        // When Baileys exposes sock.sendMessageAck (the brief's recommended
        // mechanism, and exactly what upstream's #2858 fix uses), the handler must
        // route through it and still produce an ack with class="status".
        const sock = makeSock({ sendMessageAck: true });
        registerStatusAck(sock);
        sock.ws.emit('CB:status', statusNode({
            from: '1234567890@s.whatsapp.net',
            id: '3A20MEDIAID',
            type: 'media',
        }));
        check('sendMessageAck path sends exactly one ack', sock.__sent.length === 1, `sent=${sock.__sent.length}`);
        const ack = sock.__sent[0];
        check('sendMessageAck ack class is "status"',
            ack && ack.attrs && ack.attrs.class === 'status', JSON.stringify(ack && ack.attrs));
        check('sendMessageAck ack carries the original id',
            ack && ack.attrs.id === '3A20MEDIAID');
        check('sendMessageAck ack has NO error code (a NACK would keep it pending)',
            ack && ack.attrs.error === undefined, JSON.stringify(ack && ack.attrs));
    }

    console.log('\n=== defensive: malformed node cannot crash the handler ===');
    {
        const sock = makeSock();
        registerStatusAck(sock);
        let threw = false;
        try {
            sock.ws.emit('CB:status', undefined);
            sock.ws.emit('CB:status', statusNode()); // no attrs
        } catch (e) {
            threw = true;
        }
        check('undefined / attr-less status nodes are handled without throwing', !threw);
    }

    console.log('\n=== works without sock.user (meId only used for messages) ===');
    {
        const sock = makeSock({ user: undefined });
        registerStatusAck(sock);
        sock.ws.emit('CB:status', statusNode({ id: 'NOUSER', from: 'f@s.whatsapp.net' }));
        check('status is acked even when sock.user is absent',
            sock.__sent.length === 1 && sock.__sent[0].attrs.class === 'status', JSON.stringify(sock.__sent[0] && sock.__sent[0].attrs));
    }

    console.log('\n=== no-op when ws is missing ===');
    {
        let threw = false;
        try {
            const h = registerStatusAck(null);
            check('returns a no-op handler', typeof h === 'function');
        } catch (e) {
            threw = true;
        }
        check('registerStatusAck(null) does not throw', !threw);
    }

    console.log('\n=== multiple stanzas: each acked once ===');
    {
        const sock = makeSock();
        registerStatusAck(sock);
        sock.ws.emit('CB:status', statusNode({ id: 'A' }));
        sock.ws.emit('CB:status', statusNode({ id: 'B' }));
        sock.ws.emit('CB:status', statusNode({ id: 'C' }));
        check('three status stanzas produce three acks', sock.__sent.length === 3, `sent=${sock.__sent.length}`);
    }

    console.log(`\n${pass - fail}/${pass} status-ack checks passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('❌ smoke-status-ack crashed:', err);
    process.exit(1);
});
