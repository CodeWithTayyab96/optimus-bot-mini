/**
 * Unit tests for the Optimus Mini edition.
 *
 * These are deliberately dependency-light: they exercise the profile, the
 * command loader's allowlist plumbing and the runtime guards WITHOUT loading
 * the full command graph (so they run fast and do not need optional deps).
 */
const path = require('path');
const fs = require('fs');

const profile = require('../lib/miniProfile');
const { readDeclaredName, resolveAllowlist } = require('../lib/commandLoader');
const runtime = require('../lib/miniRuntime');

const ROOT = path.join(__dirname, '..');

describe('miniProfile — classification', () => {
    test('essential commands are present', () => {
        for (const c of ['ping', 'help', 'kick', 'ban', 'tagall', 'mode', 'afk', 'weather', 'remind']) {
            expect(profile.CORE_COMMANDS).toContain(c);
        }
    });

    test('heavy commands are NOT essential', () => {
        for (const c of ['play', 'song', 'sticker', 'gptimage', 'study', 'textmaker', 'igs', 'simage']) {
            expect(profile.CORE_COMMANDS).not.toContain(c);
        }
    });

    test('heavy packages are documented', () => {
        expect(profile.HEAVY_PACKAGES).toEqual(expect.arrayContaining(['sharp', 'ffmpeg-static', 'yt-search', 'cheerio']));
    });

    test('resolveCommands() returns core only by default', () => {
        const set = profile.resolveCommands({ MINI_ENABLE: '' });
        expect(set.has('ping')).toBe(true);
        expect(set.has('gpt')).toBe(false);
    });

    test('resolveCommands() adds an enabled optional group', () => {
        const set = profile.resolveCommands({ MINI_ENABLE: 'ai' });
        expect(set.has('gpt')).toBe(true);
        expect(set.has('summarize')).toBe(true);
        // An unrelated group stays off.
        expect(set.has('play')).toBe(false);
    });

    test('resolveCommands() supports several groups', () => {
        const set = profile.resolveCommands({ MINI_ENABLE: 'ai,media' });
        expect(set.has('gpt')).toBe(true);
        expect(set.has('play')).toBe(true);
    });

    test('unknown group names are ignored and reported', () => {
        expect(profile.enabledGroups({ MINI_ENABLE: 'bogus' }).size).toBe(0);
        expect(profile.unknownGroups({ MINI_ENABLE: 'bogus,ai' })).toEqual(['bogus']);
    });

    test('requiredOptionalPackages() maps groups to packages', () => {
        expect(profile.requiredOptionalPackages({ MINI_ENABLE: 'media' })).toContain('yt-search');
        expect(profile.requiredOptionalPackages({ MINI_ENABLE: '' })).toEqual([]);
    });
});

describe('commandLoader — name extraction', () => {
    // These three files are the reason the extractor exists: a naive "first
    // name:" scan picks up `filename: 'qr.png'` / an options object instead.
    test('reads the command name, not a nested property', () => {
        expect(readDeclaredName(path.join(ROOT, 'commands/media/video.js'))).toBe('video');
        expect(readDeclaredName(path.join(ROOT, 'commands/utility/readqr.js'))).toBe('readqr');
        expect(readDeclaredName(path.join(ROOT, 'commands/general/stickercrop.js'))).toBe('crop');
    });

    test('handles a normal command', () => {
        expect(readDeclaredName(path.join(ROOT, 'commands/general/ping.js'))).toBe('ping');
    });
});

describe('commandLoader — allowlist resolution', () => {
    const original = process.env.OPTIMUS_MINI;
    afterEach(() => {
        if (original === undefined) delete process.env.OPTIMUS_MINI;
        else process.env.OPTIMUS_MINI = original;
    });

    test('returns null (load everything) when Mini is off', () => {
        delete process.env.OPTIMUS_MINI;
        expect(resolveAllowlist({})).toBeNull();
    });

    test('returns the profile set when Mini is on', () => {
        process.env.OPTIMUS_MINI = '1';
        const allow = resolveAllowlist({});
        expect(allow).toBeInstanceOf(Set);
        expect(allow.has('ping')).toBe(true);
        expect(allow.has('play')).toBe(false);
    });

    test('an explicit allow option wins over the environment', () => {
        delete process.env.OPTIMUS_MINI;
        const allow = resolveAllowlist({ allow: ['ping'] });
        expect(allow.has('ping')).toBe(true);
        expect(allow.has('kick')).toBe(false);
    });

    test('accepts an array or a Set', () => {
        expect(resolveAllowlist({ allow: ['ping'] }).has('ping')).toBe(true);
        expect(resolveAllowlist({ allow: new Set(['kick']) }).has('kick')).toBe(true);
    });
});

describe('miniRuntime — guards', () => {
    test('envInt clamps and defaults', () => {
        process.env.__MINI_TEST = 'not-a-number';
        expect(runtime.envInt('__MINI_TEST', 7)).toBe(7);
        process.env.__MINI_TEST = '999999';
        expect(runtime.envInt('__MINI_TEST', 7, { max: 100 })).toBe(100);
        process.env.__MINI_TEST = '5';
        expect(runtime.envInt('__MINI_TEST', 7, { min: 10 })).toBe(10);
        delete process.env.__MINI_TEST;
        expect(runtime.envInt('__MINI_TEST_MISSING', 42)).toBe(42);
    });

    test('backoff grows, is capped and resets', () => {
        const b = runtime.createBackoff({ baseMs: 1000, maxMs: 8000, factor: 2, jitter: 0 });
        expect(b.next()).toBe(1000);
        expect(b.next()).toBe(2000);
        expect(b.next()).toBe(4000);
        expect(b.next()).toBe(8000);
        expect(b.next()).toBe(8000); // capped
        b.reset();
        expect(b.next()).toBe(1000);
    });

    test('boundedCache honours maxKeys', () => {
        const NodeCache = require('node-cache');
        const cache = runtime.boundedCache(NodeCache, { maxKeys: 3, ttlSeconds: 60 });
        for (let i = 0; i < 10; i++) cache.set(`k${i}`, i);
        expect(cache.keys().length).toBeLessThanOrEqual(3);
    });

    test('boundedCache never throws when full (ECACHEFULL regression)', () => {
        const NodeCache = require('node-cache');
        const cache = runtime.boundedCache(NodeCache, { maxKeys: 2, ttlSeconds: 60 });
        expect(() => { for (let i = 0; i < 50; i++) cache.set(`k${i}`, i); }).not.toThrow();
        // The most recent write must survive.
        expect(cache.get('k49')).toBe(49);
    });

    test('installTempPolicy creates the temp dir and sets TMPDIR', () => {
        const p = runtime.installTempPolicy({ intervalMs: 60 * 60 * 1000 });
        expect(fs.existsSync(p.dir)).toBe(true);
        expect(process.env.TMPDIR).toBe(p.dir);
        p.stop();
    });

    test('installMemoryGuard returns the ceiling and is stoppable', () => {
        const g = runtime.installMemoryGuard({ limitMb: 999, intervalMs: 60 * 60 * 1000, onLimit: () => {} });
        expect(g.limitMb).toBe(999);
        g.stop();
    });

    test('installGracefulShutdown runs the handler and exits cleanly', async () => {
        const realExit = process.exit;
        let exitCode = null;
        let signalled = null;
        process.exit = (code) => { exitCode = code; };
        try {
            runtime.installGracefulShutdown({ onShutdown: async (sig) => { signalled = sig; }, timeoutMs: 200 });
            process.emit('SIGTERM');
            await new Promise((r) => setTimeout(r, 60));
        } finally {
            process.exit = realExit;
            process.removeAllListeners('SIGTERM');
            process.removeAllListeners('SIGINT');
        }
        expect(signalled).toBe('SIGTERM');
        expect(exitCode).toBe(0);
    });

    test('installLogPolicy rotates and stays within its ceiling', () => {
        const file = path.join(ROOT, 'logs', '_jest-rotate.log');
        for (const f of [file, `${file}.1`, `${file}.2`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
        const realLog = console.log;
        console.log = () => {};
        const policy = runtime.installLogPolicy({ file, maxBytes: 2048, keep: 1, maxBytesPerSec: 10 * 1024 * 1024 });
        try {
            for (let i = 0; i < 200; i++) console.log('x'.repeat(120));
        } finally {
            policy.stop();
            console.log = realLog;
        }
        let total = 0;
        for (const f of [file, `${file}.1`, `${file}.2`]) {
            try { total += fs.statSync(f).size; } catch { /* absent */ }
        }
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(2048 * 2 + 512);
        for (const f of [file, `${file}.1`, `${file}.2`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    });
});
