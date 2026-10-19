#!/usr/bin/env node
/**
 * Smoke test: connection lifecycle and reconnect policy (lib/connection.js)
 *
 * The bug this pins down: `Stream Errored (ack)` maps to status 500
 * (badSession) in Baileys v7, and the old handler reconnected on everything
 * except 401 — every 5 seconds, without ever ending the previous socket. One
 * close could schedule two reconnects, each of which scheduled two more.
 *
 * Verified here:
 *   1. Status codes are classified per the library's own DisconnectReason
 *      values: 401 re-pairs, 403/411/440 stop, the rest retry.
 *   2. A close schedules exactly ONE retry, however many times it is delivered.
 *   3. Updates from a superseded socket are ignored entirely.
 *   4. Adopting a socket ends the previous one.
 *   5. The delay grows exponentially, is capped, and is never zero.
 *   6. A stable connection resets the retry budget; a flapping one exhausts it
 *      and then stops instead of looping forever.
 *   7. `open` is reported as a distinct event from `connecting`.
 *   8. Nothing in the diagnostics leaks credential material.
 *   9. stop() cancels a pending retry (shutdown must not open a socket).
 *
 * Usage: node scripts/smoke-reconnect.js
 */

const path = require('path');
const connection = require(path.join(__dirname, '..', 'lib', 'connection'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('✅ ' + name); }
    else { fail++; console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

/** A deterministic clock + timer queue, so backoff tests do not sleep. */
function makeClock() {
    let now = 1_000_000_000;
    const timers = [];
    let id = 0;
    return {
        now: () => now,
        advance(ms) { now += ms; },
        timers: {
            setTimeout(fn, ms) {
                const t = { id: ++id, fn, at: now + ms, cleared: false };
                timers.push(t);
                return t;
            },
            clearTimeout(t) { if (t) t.cleared = true; },
        },
        pending: () => timers.filter((t) => !t.cleared),
        async runNext() {
            const t = timers.filter((x) => !x.cleared).sort((a, b) => a.at - b.at)[0];
            if (!t) return false;
            t.cleared = true;
            now = t.at;
            await t.fn();
            return true;
        },
    };
}

function makeSocket(id = 'sock') {
    return {
        id,
        ended: 0,
        listeners: 0,
        user: { id: '923000000000:1@s.whatsapp.net' },
        ev: {
            removeAllListeners() { this.listeners = 0; },
        },
        end() { this.ended += 1; },
    };
}

const close = (statusCode, message = 'Stream Errored (ack)') => ({
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) },
});

(async () => {
    // --------------------------------------------------------- classification ---
    console.log('\n=== status code policy ===');
    {
        const cases = [
            [401, 'reauth', 'logged out'],
            [403, 'stop', 'forbidden'],
            [411, 'stop', 'multi-device'],
            [440, 'stop', 'replaced'],
            [500, 'reconnect', 'bad session'],
            [515, 'reconnect', 'restart required'],
            [428, 'reconnect', 'connection closed'],
            [408, 'reconnect', 'lost/timeout'],
            [503, 'reconnect', 'service unavailable'],
            [undefined, 'reconnect', 'no code'],
        ];
        for (const [code, action, label] of cases) {
            const got = connection.classifyDisconnect(code);
            check(`${String(code).padEnd(9)} (${label}) → ${action}`, got.action === action, JSON.stringify(got));
        }

        check('ack → 500 is retried, not treated as a logout',
            connection.classifyDisconnect(500).action === 'reconnect');
        check('an unknown code is retried rather than fatal',
            connection.classifyDisconnect(9999).action === 'reconnect');
    }

    // ------------------------------------------------------------- diagnostics ---
    console.log('\n=== diagnostics never leak secrets ===');
    {
        const info = connection.describeDisconnect(close(500));
        check('status code is surfaced', info.statusCode === 500, JSON.stringify(info));
        check('message is surfaced', info.message === 'Stream Errored (ack)', info.message);
        check('reason is human readable', /bad session/i.test(info.reason), info.reason);
        check('only the four documented fields are returned',
            JSON.stringify(Object.keys(info).sort()) === JSON.stringify(['action', 'message', 'reason', 'statusCode']),
            JSON.stringify(Object.keys(info)));

        // A crafted error carrying creds must not survive into the description.
        // Field NAMES may remain (they are useful for diagnosis); the values
        // must not.
        const leaky = close(401, 'me: ABCDEF123456@s.whatsapp.net noiseKey: {"private":"xx"}');
        const out = JSON.stringify(connection.describeDisconnect(leaky));
        check('no jid in the description', !/@s\.whatsapp\.net/.test(out), out);
        check('no key value in the description', !/"private"\s*:\s*"xx"/.test(out) && !/ABCDEF123456/.test(out), out);

        const empty = connection.describeDisconnect(undefined);
        check('a missing lastDisconnect is handled', empty.statusCode === null && empty.action === 'reconnect', JSON.stringify(empty));
    }

    // ------------------------------------------------------------------ backoff ---
    console.log('\n=== backoff ===');
    {
        const b = connection.createBackoff({ baseMs: 1000, maxMs: 16000, jitter: 0, maxAttempts: 6 });
        const delays = [b.next(), b.next(), b.next(), b.next(), b.next()];
        check('delay grows exponentially', JSON.stringify(delays) === JSON.stringify([1000, 2000, 4000, 8000, 16000]), JSON.stringify(delays));
        check('delay is capped', b.next() === 16000, String(b.next()));
        check('every delay is positive', delays.every((d) => d > 0));
        check('the budget is exhausted after maxAttempts', b.exhausted === true);

        const jittered = connection.createBackoff({ baseMs: 1000, maxMs: 60000, jitter: 0.2 });
        const withJitter = [jittered.next(() => 0), jittered.next(() => 1)];
        check('jitter only shortens the delay',
            withJitter[0] <= 1000 && withJitter[1] <= 2000 && withJitter[1] >= 1600,
            JSON.stringify(withJitter));

        const fresh = connection.createBackoff({ baseMs: 1000 });
        fresh.next(); fresh.next();
        fresh.reset();
        check('reset() restores the budget', fresh.attempts === 0);
    }

    // --------------------------------------------------------------- supervisor ---
    console.log('\n=== one socket, one retry ===');
    {
        const clock = makeClock();
        const connects = [];
        const sup = connection.createSupervisor({
            connect: async () => { connects.push(clock.now()); },
            log: () => { },
            timers: clock.timers,
            now: clock.now,
        });

        const s1 = makeSocket('s1');
        sup.adopt(s1);
        await sup.handle(s1, { connection: 'connecting' });
        await sup.handle(s1, { connection: 'open' });
        check('open is handled', sup.state().opens === 1);

        // Deliver the same close three times — a real hazard when the old
        // socket's listeners are still attached.
        await sup.handle(s1, close(500));
        await sup.handle(s1, close(500));
        await sup.handle(s1, close(500));
        check('repeated close events schedule ONE retry', clock.pending().length === 1, `${clock.pending().length} timers`);
        check('close counted once', sup.state().closes === 1, `${sup.state().closes}`);

        // A stale socket's update must be ignored.
        const stale = makeSocket('stale');
        const res = await sup.handle(stale, { connection: 'open' });
        check('updates from a stale socket are ignored', res.handled === false && res.action === 'stale-socket', JSON.stringify(res));

        await clock.runNext();
        check('the retry calls connect exactly once', connects.length === 1, `${connects.length}`);
    }

    console.log('\n=== adopting ends the previous socket ===');
    {
        const clock = makeClock();
        const sup = connection.createSupervisor({ connect: async () => { }, log: () => { }, timers: clock.timers, now: clock.now });
        const a = makeSocket('a');
        const b = makeSocket('b');
        sup.adopt(a);
        sup.adopt(b);
        check('the old socket was ended', a.ended === 1, `ended ${a.ended}`);
        check('the old socket lost its listeners', a.ev.listeners === 0);
        check('the new socket is current', sup.isCurrent(b) && !sup.isCurrent(a));
        check('adopting did not end the new socket', b.ended === 0);
    }

    console.log('\n=== logout and conflict do not loop ===');
    {
        const clock = makeClock();
        let reconnects = 0;
        const sup = connection.createSupervisor({ connect: async () => { reconnects++; }, log: () => { }, timers: clock.timers, now: clock.now });

        const s = makeSocket();
        sup.adopt(s);
        await sup.handle(s, close(401));
        check('401 does not schedule a retry', clock.pending().length === 0);
        check('401 reports the reauth action', sup.state().lastDisconnect.action === 'reauth');
        check('401 marks the supervisor stopped', sup.state().stopped === true);

        const clock2 = makeClock();
        const sup2 = connection.createSupervisor({ connect: async () => { reconnects++; }, log: () => { }, timers: clock2.timers, now: clock2.now });
        const s2 = makeSocket();
        sup2.adopt(s2);
        await sup2.handle(s2, close(440));
        check('440 (another session) does not retry', clock2.pending().length === 0);
        check('440 stops rather than fighting', sup2.state().stopped === true);

        const clock3 = makeClock();
        const sup3 = connection.createSupervisor({ connect: async () => { reconnects++; }, log: () => { }, timers: clock3.timers, now: clock3.now });
        const s3 = makeSocket();
        sup3.adopt(s3);
        await sup3.handle(s3, close(403));
        check('403 does not retry', clock3.pending().length === 0);
    }

    console.log('\n=== a flapping handshake eventually gives up ===');
    {
        const clock = makeClock();
        let connects = 0;
        const sup = connection.createSupervisor({
            connect: async () => { connects++; },
            log: () => { },
            timers: clock.timers,
            now: clock.now,
            backoff: connection.createBackoff({ baseMs: 10, maxMs: 40, jitter: 0, maxAttempts: 4, stableAfterMs: 60000 }),
        });

        // Each cycle: adopt a socket, open, then close 1s later — a flap.
        for (let i = 0; i < 8; i++) {
            const s = makeSocket(`f${i}`);
            sup.adopt(s);
            await sup.handle(s, { connection: 'open' });
            clock.advance(1000);
            await sup.handle(s, close(500));
            await clock.runNext();
        }
        check('the retry budget stops the loop', sup.state().stopped === true, JSON.stringify(sup.state()));
        check('connects stayed bounded', connects <= 4, `${connects} connects`);
    }

    console.log('\n=== a stable connection resets the budget ===');
    {
        const clock = makeClock();
        const sup = connection.createSupervisor({
            connect: async () => { },
            log: () => { },
            timers: clock.timers,
            now: clock.now,
            backoff: connection.createBackoff({ baseMs: 10, maxMs: 40, jitter: 0, maxAttempts: 3, stableAfterMs: 60000 }),
        });
        const s = makeSocket();
        sup.adopt(s);
        await sup.handle(s, { connection: 'open' });
        clock.advance(10 * 60 * 1000); // ten healthy minutes
        await sup.handle(s, close(428));
        check('a long-lived connection resets the attempt counter', sup.state().attempts === 1, JSON.stringify(sup.state()));
        check('and still schedules a retry', clock.pending().length === 1);
    }

    console.log('\n=== shutdown cancels the pending retry ===');
    {
        const clock = makeClock();
        let connects = 0;
        const sup = connection.createSupervisor({ connect: async () => { connects++; }, log: () => { }, timers: clock.timers, now: clock.now });
        const s = makeSocket();
        sup.adopt(s);
        await sup.handle(s, close(500));
        check('a retry is pending', clock.pending().length === 1);
        sup.stop();
        check('stop() clears the timer', clock.pending().length === 0, `${clock.pending().length}`);
        await clock.runNext();
        check('no connect happens after stop()', connects === 0, `${connects}`);
        check('the socket was ended', s.ended === 1);
    }

    console.log('\n=== connect failures use the same scheduler ===');
    {
        const clock = makeClock();
        let connects = 0;
        const sup = connection.createSupervisor({ connect: async () => { connects++; }, log: () => { }, timers: clock.timers, now: clock.now });
        const s = makeSocket();
        sup.adopt(s);
        sup.reportConnectError(new Error('auth state unreadable'));
        check('a connect throw schedules exactly one retry', clock.pending().length === 1, `${clock.pending().length}`);
        check('the failed socket was ended', s.ended === 1);
        await clock.runNext();
        check('the retry ran once', connects === 1, `${connects}`);
    }

    console.log('\n=== open vs connecting ===');
    {
        const clock = makeClock();
        const events = [];
        const sup = connection.createSupervisor({
            connect: async () => { },
            log: () => { },
            timers: clock.timers,
            now: clock.now,
            onOpen: (sock, meta) => { events.push(['open', meta.attempt]); },
            onClose: (info) => { events.push(['close', info.statusCode]); },
        });
        const s = makeSocket();
        sup.adopt(s);
        await sup.handle(s, { connection: 'connecting' });
        check('connecting is not reported as open', events.length === 0, JSON.stringify(events));
        await sup.handle(s, { connection: 'open' });
        check('open fires once with an attempt number', events.length === 1 && events[0][0] === 'open', JSON.stringify(events));
        await sup.handle(s, close(500));
        check('close carries the status code', events[1] && events[1][1] === 500, JSON.stringify(events));
    }

    // ---------------------------------------------------------- entry wiring ---
    // The entry points cannot be unit-tested (they connect on load), so their
    // wiring is asserted structurally: the pieces that prevent the loop must be
    // present and in the right order.
    console.log('\n=== entry point wiring ===');
    {
        const fs = require('fs');
        const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

        for (const file of ['index.js', 'mini.js']) {
            const src = read(file);

            check(`${file}: uses the shared supervisor`, /createSupervisor\s*\(/.test(src));
            check(`${file}: adopts the socket before use`, /supervisor\.adopt\s*\(/.test(src));
            check(`${file}: routes updates through the supervisor`, /supervisor\.handle\s*\(/.test(src));
            check(`${file}: stops the loop on shutdown`, /supervisor\.stop\s*\(/.test(src));

            // creds.update must be registered on the socket that is adopted.
            const credsIdx = src.indexOf("ev.on('creds.update'");
            const adoptIdx = src.indexOf('supervisor.adopt(');
            check(`${file}: creds.update is wired`, credsIdx !== -1);
            check(`${file}: creds.update is registered before adoption`, credsIdx !== -1 && adoptIdx !== -1 && credsIdx < adoptIdx);

            // The old bug: reconnecting straight from the close branch.
            check(`${file}: no inline reconnect from the close handler`,
                !/connection === 'close'[\s\S]{0,600}startXeonBotInc\(\)/.test(src) &&
                !/connection === 'close'[\s\S]{0,600}startBot\(\)/.test(src));
        }

        const indexSrc = read('index.js');
        check('index.js: the connect failure path does not recurse directly',
            !/catch \(error\)[\s\S]{0,200}startXeonBotInc\(\)/.test(indexSrc));
        check('index.js: connect failures go to the supervisor',
            /reportConnectError\s*\(/.test(indexSrc));
        check('index.js: the version is resolved once, not per reconnect',
            /resolvedVersion/.test(indexSrc) && /async function resolveVersion/.test(indexSrc));
    }

    console.log(`\n${pass - fail}/${pass} reconnect checks passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('❌ smoke-reconnect crashed:', err);
    process.exit(1);
});
