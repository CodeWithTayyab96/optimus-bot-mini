#!/usr/bin/env node
/**
 * Smoke test: outbound message design + the senders nobody asked for
 *
 * Two things are checked here.
 *
 * 1. Design — the shared card layout from lib/messageStyle: a bold title, a thin
 *    rule under it (which the docstring has always promised and the code never
 *    drew), the body, and the colour band. Plus `rows()` for aligned key/value
 *    gutters. Every command's output depends on these helpers, so a regression
 *    here degrades the whole bot at once.
 *
 * 2. Unprompted sends — the places that push a message without being asked:
 *      - antidelete: one DM per deleted message, now paced through a queue so a
 *        burst of deletions cannot become a burst of DMs;
 *      - broadcast: one message per group, now spaced apart instead of fired in
 *        a tight loop;
 *      - the connect notice: sent once per process instead of on every reconnect.
 *
 * Usage: node scripts/smoke-outbound.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

// Pacing is read from the environment at module load, so shorten it before the
// require — otherwise the test would take three real 1.5s intervals.
process.env.ANTIDELETE_PACING_MS = process.env.ANTIDELETE_PACING_MS_TEST || '50';

const style = require(path.join(__dirname, '..', 'lib', 'messageStyle'));
const antidelete = require(path.join(__dirname, '..', 'commands', 'owner', 'antidelete'));
const broadcast = require(path.join(__dirname, '..', 'commands', 'owner', 'broadcast'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('✅ ' + name); }
    else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

function failsafe(fn) { try { return fn(); } catch { return null; } }

(async () => {
    // ------------------------------------------------------------------ design ---
    console.log('\n=== card layout ===');
    {
        const card = style.box('📸 STATUS CACHE', ['Auto-save : *ON*']);
        const lines = card.split('\n');

        check('title is bold', lines[0] === '*📸 STATUS CACHE*', lines[0]);
        check('a thin rule sits under the title', lines[1] === '─'.repeat(String('📸 STATUS CACHE').length), lines[1]);
        check('the body follows the rule', lines[2] === 'Auto-save : *ON*', lines[2]);
        check('the colour band closes the card', /^(?:🟩|🟥|🟨|🟦|🟪){6}$/.test(lines[lines.length - 1]), lines[lines.length - 1]);
        check('no blank line is left between title and rule', lines[1] !== '', 'blank rule');

        check('divider() never collapses or runs away',
            failsafe(() => style.divider(1)) === '───' && failsafe(() => style.divider(999)) === '─'.repeat(32),
            failsafe(() => style.divider(1)));

        // The band colour still follows the icon.
        check('success cards get a green band', style.box('✅ OK', ['a']).trim().endsWith('🟩🟩🟩🟩🟩🟩'));
        check('error cards get a red band', style.box('❌ BAD', ['a']).trim().endsWith('🟥🟥🟥🟥🟥🟥'));
    }

    console.log('\n=== rows() ===');
    {
        const rows = style.rows([['Auto-save', '*ON*'], ['Retention', '24h'], ['Allowlist', 'all contacts']]);
        check('one line per pair', rows.length === 3, `${rows.length}`);
        check('colons line up in a column',
            rows.every((r) => r.indexOf(':') === rows[0].indexOf(':')),
            JSON.stringify(rows));
        check('short labels are padded', rows[0].startsWith('Auto-save '), rows[0]);
        check('values keep their own formatting', rows[0].includes('*ON*'), rows[0]);

        check('empty pairs are dropped', style.rows([['a', ''], ['', 'b'], ['c', 'd']]).length === 1);
        check('no rows for empty input', style.rows([]).length === 0 && style.rows(null).length === 0);

        // Long labels must not push the gutter off the card.
        const wide = style.rows([['A very long label indeed', 'x'], ['B', 'y']]);
        check('a long label widens the gutter only once', wide.filter((r) => r.indexOf(':') === wide[0].indexOf(':')).length === 2, JSON.stringify(wide));
    }

    console.log('\n=== digest shape ===');
    {
        // Uses the same card, so the debounced notices look like everything else.
        const one = style.buildDigest ? null : null; // buildDigest is internal; covered in smoke-notify
        const many = style.box('📋 UPDATES', [
            ...style.rows([['Notices', '2 combined to keep this chat quiet']]),
            '',
            '• ⏳ Downloading...',
            '• ✅ Saved.',
        ]);
        check('the digest carries every line', many.includes('Downloading') && many.includes('Saved.'), many.slice(0, 120));
        check('the digest uses the shared card', many.split('\n')[1] === '─'.repeat(13), many.split('\n')[1]);
    }

    // ------------------------------------------------------ antidelete pacing ---
    console.log('\n=== antidelete DM pacing ===');
    {
        const order = [];
        const t = antidelete._test;
        t.revQueue.length = 0;

        t.queueRevocation(() => { order.push(1); });
        t.queueRevocation(() => { order.push(2); });
        t.queueRevocation(() => { order.push(3); });
        check('three reports are queued, not sent', order.length === 0, `${order.length} sent`);

        await new Promise((r) => setTimeout(r, 0));            // first job runs immediately
        check('the first report is delivered promptly', order.length === 1, `${order.length}`);
        await new Promise((r) => setTimeout(r, 20));           // not yet pacing to the next
        check('the rest wait their turn', order.length === 1, `${order.length}`);

        const untilDone = new Promise((resolve) => {
            const started = order.length;
            const iv = setInterval(() => {
                if (order.length >= started + 2) { clearInterval(iv); resolve(); }
            }, 5);
            setTimeout(() => { clearInterval(iv); resolve(); }, 1000);
        });
        await untilDone;
        check('everything is delivered, nothing is dropped', order.length === 3, `${order.length}`);
        check('delivery keeps its order', order.join(',') === '1,2,3', order.join(','));
        check('the queue drains', t.revQueue.length === 0, `${t.revQueue.length} left`);
    }

    // ------------------------------------------------------- broadcast pacing ---
    console.log('\n=== broadcast pacing ===');
    {
        const sent = [];
        const stamps = [];
        const groups = [{ id: '1@g.us' }, { id: '2@g.us' }, { id: '3@g.us' }, { id: '4@g.us' }];
        const sock = {
            groupFetchAllParticipating: async () => Object.fromEntries(groups.map((g) => [g.id, g])),
            sendMessage: async (jid) => { sent.push(jid); stamps.push(Date.now()); },
        };
        const replies = [];
        const delay = broadcast._test.SEND_DELAY_MS;

        // The command paces itself; run it with a short delay so the test is fast.
        const prev = process.env.BROADCAST_DELAY_MS;
        process.env.BROADCAST_DELAY_MS = '60';
        delete require.cache[require.resolve(path.join(__dirname, '..', 'commands', 'owner', 'broadcast'))];
        const paced = require(path.join(__dirname, '..', 'commands', 'owner', 'broadcast'));

        await paced.execute(sock, { key: {} }, ['hello'], { reply: async (t) => replies.push(t) });
        if (prev === undefined) delete process.env.BROADCAST_DELAY_MS;
        else process.env.BROADCAST_DELAY_MS = prev;

        check('one send per group', sent.length === 4, `${sent.length}`);
        const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
        check('sends are spaced apart', gaps.every((g) => g >= 30), JSON.stringify(gaps));

        const body = replies[replies.length - 1];
        check('the result card reports the counts', /Groups\s*:\s*4/.test(body) && /Delivered\s*:\s*✅ 4/.test(body), body.slice(0, 120));
        check('the result card says it was paced', /Paced at/.test(body), body.slice(0, 200));
        check('the shipped default delay is sane', delay >= 500 && delay <= 5000, `${delay}ms`);
    }

    console.log(`\n${pass - fail}/${pass} outbound checks passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('❌ smoke-outbound crashed:', err);
    process.exit(1);
});
