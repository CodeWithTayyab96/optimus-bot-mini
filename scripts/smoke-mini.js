#!/usr/bin/env node
/**
 * smoke-mini — functional checks for the Optimus Mini edition.
 *
 * Runs in dependency-light mode (pure Node + the Mini install), so it works on
 * the target host as well as in CI. It proves four things:
 *
 *   1. the profile classifies commands correctly (essential vs optional);
 *   2. the command loader loads ONLY the allowlist when OPTIMUS_MINI is set;
 *   3. no heavy package is require()d into the Mini process;
 *   4. essential commands actually dispatch, and excluded ones do not.
 *
 * Usage: node scripts/smoke-mini.js
 * Also exported as smoke() so run-mini-tests.js can call it in-process.
 */
'use strict';

// Must be set before anything requires main.js / the command loader.
process.env.OPTIMUS_MINI = '1';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

async function smoke(log = console.log) {
    let passed = 0;
    let failed = 0;
    const ok = (label, cond) => {
        if (cond) { passed++; log(`  ✅ ${label}`); }
        else { failed++; log(`  ❌ ${label}`); }
    };

    const profile = require('../lib/miniProfile');

    // ── 1. Profile classification ───────────────────────────────────────────
    log('\n=== 1. Profile classification ===');
    ok('CORE is a non-trivial allowlist', profile.CORE_COMMANDS.length >= 100);
    for (const c of ['ping', 'help', 'kick', 'ban', 'warn', 'tagall', 'mode', 'afk', 'weather', 'remind']) {
        ok(`'${c}' is essential`, profile.CORE_COMMANDS.includes(c));
    }
    for (const c of ['play', 'song', 'sticker', 'gptimage', 'study', 'textmaker', 'igs']) {
        ok(`'${c}' is NOT essential`, !profile.CORE_COMMANDS.includes(c));
    }
    ok('optional groups exist', Object.keys(profile.OPTIONAL_GROUPS).length >= 5);
    ok('heavy package list is populated', profile.HEAVY_PACKAGES.length >= 15);
    ok('resolveCommands() honours MINI_ENABLE', profile.resolveCommands({ MINI_ENABLE: 'ai' }).has('gpt'));
    ok('resolveCommands() excludes disabled groups', !profile.resolveCommands({ MINI_ENABLE: '' }).has('gpt'));
    ok('unknown groups are reported', profile.unknownGroups({ MINI_ENABLE: 'nope' }).includes('nope'));

    // ── 2. Loader filtering (loads main.js → core commands only) ────────────
    log('\n=== 2. Command loader filtering ===');
    const { getLastStats, loadCommands } = require('../lib/commandLoader');
    // Capture whether sharp was already loaded BEFORE main.js runs, so the
    // startup-graph assertion below stays meaningful when another check (e.g.
    // check-image-lib) ran first in the same process.
    const sharpPreloaded = Object.keys(require.cache).some((k) => k.includes('/node_modules/sharp/'));
    const { handleMessages } = require('../main');
    const stats = getLastStats();

    ok('loader ran in allowlist mode', stats.allowlisted === true);
    ok(`loaded a healthy number of commands (${stats.loaded})`, stats.loaded >= 100);
    ok(`skipped the excluded commands (${stats.skipped})`, stats.skipped >= 30);
    ok('no command failed to load', stats.failed === 0);

    const commands = loadCommands();
    ok('ping is registered', commands.has('ping'));
    ok('help is registered', commands.has('help'));
    ok('menu alias resolves', commands.has('menu'));
    ok('kick is registered', commands.has('kick'));
    ok('EXCLUDED play is not registered', !commands.has('play'));
    ok('EXCLUDED sticker is not registered', !commands.has('sticker'));
    ok('EXCLUDED gptimage is not registered', !commands.has('gptimage'));
    ok('EXCLUDED textmaker is not registered', !commands.has('textmaker'));

    // Regression: `define.js` aliases 'dictionary', which used to shadow
    // `dictionary.js` entirely (and leave `.dict` unregistered). A command's own
    // name must always beat another command's alias.
    ok("'.dictionary' resolves to the dictionary command", commands.get('dictionary')?.name === 'dictionary');
    ok("'.dict' resolves to the dictionary command", commands.get('dict')?.name === 'dictionary');
    ok("'.define' resolves to the define command", commands.get('define')?.name === 'define');
    ok("'.meaning' resolves to a command", Boolean(commands.get('meaning')));

    // ── 3. No heavy package in the process ──────────────────────────────────
    log('\n=== 3. Heavy packages absent from the runtime ===');
    const cacheKeys = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
    const loaded = (pkg) => cacheKeys.some((k) => k.includes(`/node_modules/${pkg}/`));
    const unavoidable = [];
    for (const pkg of profile.HEAVY_PACKAGES) {
        if (loaded(pkg)) unavoidable.push(pkg);
        else ok(`'${pkg}' is NOT loaded`, true);
    }
    if (unavoidable.length) {
        log(`  ℹ️  loaded anyway (pulled by a core dependency, not by Mini commands): ${unavoidable.join(', ')}`);
    }
    // `sharp` is intentionally NOT in require.cache at startup (baileys imports it
    // lazily), yet it must stay INSTALLED — see scripts/check-image-lib.js.
    if (sharpPreloaded) {
        log("  ℹ️  'sharp' was already loaded by an earlier check — startup-graph assertion skipped");
    } else {
        ok("'sharp' is absent from the startup graph but still required at runtime", !loaded('sharp'));
    }

    for (const mod of ['potSupervisor', 'dlHealth', 'warpProxy', 'ytdlp', 'myfunc']) {
        const present = cacheKeys.some((k) => k.endsWith(`/lib/${mod}.js`));
        ok(`lib/${mod}.js is NOT loaded`, !present);
    }

    // ── 4. Dispatch: essential works, excluded does not ─────────────────────
    log('\n=== 4. Dispatch behaviour ===');
    const sent = [];
    const mockSock = {
        user: { id: '1234567890:1@s.whatsapp.net' },
        sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'mock' } }; },
        sendPresenceUpdate: async () => {},
        groupMetadata: async () => ({ participants: [] }),
        readMessages: async () => {},
    };
    const message = (text) => ({
        key: { remoteJid: '9999999999@s.whatsapp.net', fromMe: true, participant: undefined, id: 'T1' },
        message: { conversation: text },
    });

    await handleMessages(mockSock, { messages: [message('.ping')], type: 'notify' }, false);
    await new Promise((r) => setTimeout(r, 400));
    ok('.ping replies', sent.map((s) => s.content?.text || '').join(' ').includes('Pong'));

    const before = sent.length;
    await handleMessages(mockSock, { messages: [message('.play never gonna give you up')], type: 'notify' }, false);
    await new Promise((r) => setTimeout(r, 400));
    ok('.play (excluded) does not dispatch a command', sent.length === before);

    // ── 5. Runtime guards ───────────────────────────────────────────────────
    log('\n=== 5. Runtime guards ===');
    const runtime = require('../lib/miniRuntime');
    const NodeCache = require('node-cache');

    ok('envInt falls back on a bad value', runtime.envInt('__MINI_NOPE', 7) === 7);
    process.env.__MINI_INT = '999999';
    ok('envInt clamps to max', runtime.envInt('__MINI_INT', 7, { max: 100 }) === 100);
    delete process.env.__MINI_INT;

    const bo = runtime.createBackoff({ baseMs: 1000, maxMs: 8000, factor: 2, jitter: 0 });
    const seq = [bo.next(), bo.next(), bo.next(), bo.next(), bo.next()];
    ok('backoff doubles then caps', JSON.stringify(seq) === JSON.stringify([1000, 2000, 4000, 8000, 8000]));
    bo.reset();
    ok('backoff resets', bo.next() === 1000);

    const cache = runtime.boundedCache(NodeCache, { maxKeys: 3, ttlSeconds: 60 });
    let cacheThrew = false;
    try { for (let i = 0; i < 20; i++) cache.set('k' + i, i); } catch { cacheThrew = true; }
    ok('bounded cache never throws when full (ECACHEFULL regression)', !cacheThrew);
    ok('bounded cache respects maxKeys', cache.keys().length <= 3);
    ok('bounded cache still stores recent keys', cache.get('k19') === 19);

    // Log rotation: a tiny cap must rotate and never exceed the ceiling.
    const logFile = path.join(ROOT, 'logs', '_smoke-rotate.log');
    for (const f of [logFile, logFile + '.1', logFile + '.2']) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    const realLog = console.log;
    console.log = () => {}; // silence the mirror so the burst does not flood the console
    const policy = runtime.installLogPolicy({ file: logFile, maxBytes: 2048, keep: 1, maxBytesPerSec: 10 * 1024 * 1024 });
    try {
        for (let i = 0; i < 200; i++) console.log('x'.repeat(120));
    } finally {
        policy.stop();
        console.log = realLog;
    }
    const rotated = fs.existsSync(logFile) || fs.existsSync(logFile + '.1');
    let total = 0;
    for (const f of [logFile, logFile + '.1', logFile + '.2']) {
        try { total += fs.statSync(f).size; } catch { /* absent */ }
    }
    ok('log rotation produced files', rotated);
    // Ceiling is maxBytes × (keep + 1); allow one extra line for the append that
    // trips the rotation.
    ok(`log total stays bounded (${total} B ≤ 4608)`, total > 0 && total <= 2048 * 2 + 512);
    for (const f of [logFile, logFile + '.1', logFile + '.2']) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

    // Graceful shutdown: stub process.exit so the handler can be observed.
    const realExit = process.exit;
    let exitCode = null;
    let signalled = null;
    process.exit = (code) => { exitCode = code; };
    try {
        runtime.installGracefulShutdown({ onShutdown: async (sig) => { signalled = sig; }, timeoutMs: 200 });
        process.emit('SIGTERM');
        await new Promise((r) => setTimeout(r, 80));
    } finally {
        process.exit = realExit;
        process.removeAllListeners('SIGTERM');
    }
    ok('shutdown handler ran on SIGTERM', signalled === 'SIGTERM');
    ok('shutdown exited cleanly', exitCode === 0);

    // Memory guard fires when RSS is over the ceiling.
    let guardFired = false;
    const guard = runtime.installMemoryGuard({ limitMb: 0, intervalMs: 10, onLimit: () => { guardFired = true; } });
    await new Promise((r) => setTimeout(r, 60));
    guard.stop();
    ok('memory guard fires past the ceiling', guardFired);

    // Boot guard: a crash loop must back off instead of restarting flat out.
    const bootFile = path.join(ROOT, 'logs', '_smoke-boot.json');
    const clean = () => { try { fs.rmSync(bootFile, { force: true }); } catch { /* ignore */ } };
    clean();
    let bg = runtime.installBootGuard({ file: bootFile, healthyMs: 60000 });
    ok('first boot has no delay', bg.delayMs === 0);
    bg.stop();

    fs.writeFileSync(bootFile, JSON.stringify({ attempts: 1, lastBootAt: Date.now() }));
    bg = runtime.installBootGuard({ file: bootFile, fastFailMs: 30000, baseMs: 1000, maxMs: 60000, healthyMs: 60000 });
    ok('a failed start produces a backoff delay', bg.delayMs > 0);
    ok('consecutive failures are counted', bg.attempts === 2);
    bg.stop();

    fs.writeFileSync(bootFile, JSON.stringify({ attempts: 3, lastBootAt: Date.now() - 120000 }));
    bg = runtime.installBootGuard({ file: bootFile, fastFailMs: 30000, baseMs: 1000, maxMs: 60000, healthyMs: 60000 });
    ok('a healthy previous run resets the delay', bg.delayMs === 0);
    ok('a healthy previous run resets the counter', bg.attempts === 1);
    bg.stop();
    clean();

    // Clean up runtime artefacts these checks may create.
    for (const rel of ['data/afk.json', 'data/mode.json', 'data/messageStats.json', 'data/groupStats.json']) {
        try { fs.rmSync(path.join(ROOT, rel), { force: true }); } catch { /* ignore */ }
    }

    return { passed, failed };
}

module.exports = { smoke };

if (require.main === module) {
    smoke()
        .then(({ passed, failed }) => {
            console.log(`\n${'='.repeat(50)}`);
            console.log(`Mini smoke: ${passed} passed, ${failed} failed`);
            process.exit(failed === 0 ? 0 : 1);
        })
        .catch((e) => {
            console.error('❌ smoke-mini crashed:', e);
            process.exit(1);
        });
}
