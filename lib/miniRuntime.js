/**
 * Optimus Mini — runtime resource guards.
 * Copyright (c) 2026 Muhammad Tayyab Imran
 *
 * Small, dependency-free helpers that keep the Mini process inside the memory
 * and disk budget of a tiny server (≈580 MB RAM / ≈750 MB disk):
 *
 *   installLogPolicy()          rotating, rate-limited log file with a hard cap
 *   installTempPolicy()         temp dir on a fixed path + age/size eviction
 *   installMemoryGuard()        exit cleanly when RSS passes a ceiling
 *   installGracefulShutdown()   close the socket, flush the store, exit cleanly
 *   installCrashGuards()        never die silently on an unhandled error
 *   createBackoff()             bounded exponential reconnect backoff
 *   boundedCache()              NodeCache with maxKeys + TTL (no unbounded maps)
 *
 * Everything here is intentionally boring: no new dependencies, no clever
 * scheduling, nothing that costs more than it saves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'temp');
const LOG_DIR = path.join(ROOT, 'logs');

/** Parse an integer env var, clamped, with a default. */
function envInt(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

function ensureDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {
        /* best effort — a read-only tree should not stop the bot */
    }
    return dir;
}

// ────────────────────────────────────────────────────────────────────────────
//  Logging: rotating file + rate limit
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mirror console output into a size-capped, rotating file.
 *
 * Two independent caps stop the log from ever filling the disk:
 *   • per-file size   → rotate when exceeded, keeping `keep` generations
 *   • bytes per second → drop excess lines during an error storm
 *
 * Total disk ceiling = maxBytes × (keep + 1). Defaults to ~6 MB.
 * Set MINI_LOG_FILE=off to disable (e.g. when systemd/journald owns the logs).
 *
 * @returns {{ stop: Function, stats: Function }}
 */
function installLogPolicy(options = {}) {
    const setting = process.env.MINI_LOG_FILE;
    const enabled = setting === undefined ? true : !/^(off|0|false|no)$/i.test(String(setting).trim());
    if (!enabled) return { stop() {}, stats: () => ({ enabled: false }) };

    const file = options.file
        ? path.resolve(ROOT, options.file)
        : (setting && !/^(on|1|true|yes)$/i.test(String(setting).trim()))
            ? path.resolve(ROOT, setting)
            : path.join(LOG_DIR, 'mini.log');
    const maxBytes = options.maxBytes ?? envInt('MINI_LOG_MAX_BYTES', 2 * 1024 * 1024, { min: 64 * 1024 });
    const keep = options.keep ?? envInt('MINI_LOG_KEEP', 2, { min: 1, max: 20 });
    const maxBytesPerSec = options.maxBytesPerSec ?? envInt('MINI_LOG_MAX_BYTES_PER_SEC', 256 * 1024, { min: 4096 });

    ensureDir(path.dirname(file));

    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }

    let windowStart = Date.now();
    let windowBytes = 0;
    let dropped = 0;

    function rotate() {
        // Keep `file` plus `keep` generations: file.1 … file.{keep}.
        // Total disk ceiling is therefore maxBytes × (keep + 1).
        try {
            for (let i = keep; i >= 1; i--) {
                const from = i === 1 ? file : `${file}.${i - 1}`;
                const to = `${file}.${i}`;
                if (!fs.existsSync(from)) continue;
                try { fs.rmSync(to, { force: true }); } catch { /* ignore */ }
                try { fs.renameSync(from, to); } catch { /* ignore */ }
            }
        } catch {
            /* rotation is best effort */
        }
        size = 0;
    }

    function write(line) {
        const now = Date.now();
        if (now - windowStart >= 1000) {
            if (dropped > 0) {
                // Record the drop count once per window so it is visible.
                const note = `[log] ${dropped} line(s) dropped (rate limit ${maxBytesPerSec} B/s)\n`;
                dropped = 0;
                appendRaw(note);
            }
            windowStart = now;
            windowBytes = 0;
        }
        const bytes = Buffer.byteLength(line) + 1;
        if (windowBytes + bytes > maxBytesPerSec) { dropped++; return; }
        windowBytes += bytes;
        appendRaw(line + '\n');
    }

    function appendRaw(text) {
        try {
            fs.appendFileSync(file, text);
            size += Buffer.byteLength(text);
            if (size > maxBytes) rotate();
        } catch {
            /* a failed log write must never break the bot */
        }
    }

    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const patch = (key) => (...args) => {
        try { orig[key].apply(console, args); } catch { /* ignore */ }
        write(util.format(...args));
    };
    console.log = patch('log');
    console.info = patch('info');
    console.warn = patch('warn');
    console.error = patch('error');

    return {
        file,
        stop() {
            console.log = orig.log;
            console.info = orig.info;
            console.warn = orig.warn;
            console.error = orig.error;
        },
        stats: () => ({ enabled: true, file, maxBytes, keep, maxBytesPerSec }),
    };
}

// ────────────────────────────────────────────────────────────────────────────
//  Temp files: fixed location + age/size eviction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Point TMPDIR/TEMP/TMP at ./temp and evict stale or oversized leftovers.
 * Runs once now and then on a bounded interval. Unref'd so it never keeps the
 * process alive.
 */
function installTempPolicy(options = {}) {
    ensureDir(TMP_DIR);
    process.env.TMPDIR = TMP_DIR;
    process.env.TEMP = TMP_DIR;
    process.env.TMP = TMP_DIR;

    const maxAgeMs = options.maxAgeMs ?? envInt('MINI_TMP_MAX_AGE_MS', 60 * 60 * 1000, { min: 60_000 });
    const maxTotalBytes = options.maxTotalBytes ?? envInt('MINI_TMP_MAX_BYTES', 64 * 1024 * 1024, { min: 1024 * 1024 });
    const intervalMs = options.intervalMs ?? envInt('MINI_TMP_SWEEP_MS', 15 * 60 * 1000, { min: 60_000 });

    function sweep() {
        let entries;
        try { entries = fs.readdirSync(TMP_DIR); } catch { return; }
        const now = Date.now();
        let total = 0;
        const survivors = [];
        for (const name of entries) {
            const p = path.join(TMP_DIR, name);
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            if (now - st.mtimeMs > maxAgeMs) {
                try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
                continue;
            }
            total += st.size;
            survivors.push({ p, size: st.size, mtime: st.mtimeMs });
        }
        if (total > maxTotalBytes) {
            survivors.sort((a, b) => a.mtime - b.mtime); // oldest first
            for (const s of survivors) {
                if (total <= maxTotalBytes) break;
                try { fs.rmSync(s.p, { recursive: true, force: true }); total -= s.size; } catch { /* ignore */ }
            }
        }
    }

    sweep();
    const timer = setInterval(sweep, intervalMs);
    if (timer.unref) timer.unref();

    return { dir: TMP_DIR, sweep, stop: () => clearInterval(timer) };
}

// ────────────────────────────────────────────────────────────────────────────
//  Memory ceiling
// ────────────────────────────────────────────────────────────────────────────

/**
 * Watch RSS and, when it passes `limitMb`, call onLimit (default: exit so the
 * supervisor restarts a fresh process). The interval is unref'd.
 *
 * Default 180 MB: measured peak is ~119 MB, so this leaves ~50 % headroom for a
 * burst while still leaving ~400 MB of a 580 MB host to the OS and other
 * services. Keep it BELOW the supervisor's hard cap (systemd `MemoryMax` / pm2
 * `max_memory_restart`) so the bot restarts itself before being killed.
 */
function installMemoryGuard(options = {}) {
    const limitMb = options.limitMb ?? envInt('MAX_RSS_MB', 180, { min: 64 });
    const intervalMs = options.intervalMs ?? envInt('MINI_MEM_CHECK_MS', 30_000, { min: 5000 });
    const onLimit = options.onLimit || ((rss) => {
        console.error(`⚠️  RSS ${rss.toFixed(0)} MB > ${limitMb} MB ceiling — exiting for a clean restart.`);
        process.exit(1);
    });

    const timer = setInterval(() => {
        const rss = process.memoryUsage().rss / 1048576;
        if (rss > limitMb) onLimit(rss);
    }, intervalMs);
    if (timer.unref) timer.unref();

    return { limitMb, stop: () => clearInterval(timer) };
}

// ────────────────────────────────────────────────────────────────────────────
//  Shutdown + crash handling
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run `onShutdown` on SIGTERM/SIGINT, then exit — but never hang: a hard
 * deadline forces the exit if cleanup stalls.
 */
function installGracefulShutdown(options = {}) {
    const onShutdown = options.onShutdown || (async () => {});
    const timeoutMs = options.timeoutMs ?? envInt('MINI_SHUTDOWN_TIMEOUT_MS', 8000, { min: 500 });
    let closing = false;

    const handle = async (signal) => {
        if (closing) return;
        closing = true;
        console.log(`\n🛑 Received ${signal} — shutting down gracefully…`);
        const deadline = setTimeout(() => {
            console.warn('⚠️  Shutdown timed out — forcing exit.');
            process.exit(0);
        }, timeoutMs);
        if (deadline.unref) deadline.unref();
        try {
            await onShutdown(signal);
        } catch (err) {
            console.error('Error during shutdown:', err && err.message);
        }
        clearTimeout(deadline);
        process.exit(0);
    };

    process.on('SIGTERM', () => { handle('SIGTERM'); });
    process.on('SIGINT', () => { handle('SIGINT'); });
    return { isClosing: () => closing };
}

/** Log unhandled failures instead of dying silently. */
function installCrashGuards() {
    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
    });
    process.on('unhandledRejection', (err) => {
        console.error('Unhandled Rejection:', err && err.stack ? err.stack : err);
    });
}

// ────────────────────────────────────────────────────────────────────────────
//  Boot guard: break crash loops without giving up on transient failures
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect a crash loop and slow it down.
 *
 * A supervisor restarts a crashed process, but if the crash happens during
 * startup (a transient DNS/network failure fetching the WhatsApp version, a bad
 * config, a port clash) the restart repeats every few seconds forever —
 * burning CPU and filling the disk with identical log lines.
 *
 * This records boot attempts on disk and returns a delay the caller should wait
 * out BEFORE starting:
 *
 *   first boot            → 0
 *   previous boot healthy → 0 (the record was cleared)
 *   previous boot crashed → 2s, 4s, 8s … capped (default 5 min)
 *
 * A run that survives `healthyMs` clears the record, so the delay is only ever
 * applied to genuinely failing starts. It backs off rather than refusing to
 * start, so a transient outage still recovers on its own.
 *
 * @returns {{ delayMs: number, attempts: number, healthy: Function, stop: Function }}
 */
function installBootGuard(options = {}) {
    const file = options.file || path.join(ROOT, 'data', '.boot-attempts.json');
    // A boot shorter than this counts as a failed start.
    const fastFailMs = options.fastFailMs ?? envInt('MINI_BOOT_FASTFAIL_MS', 30_000, { min: 1000 });
    // A run longer than this is considered healthy and clears the record.
    const healthyMs = options.healthyMs ?? envInt('MINI_BOOT_HEALTHY_MS', 60_000, { min: 5000 });
    const baseMs = options.baseMs ?? envInt('MINI_BOOT_BACKOFF_BASE_MS', 2000, { min: 100 });
    const maxMs = options.maxMs ?? envInt('MINI_BOOT_BACKOFF_MAX_MS', 300_000, { min: 1000 });
    const maxAttempts = options.maxAttempts ?? envInt('MINI_BOOT_MAX_ATTEMPTS', 20, { min: 1 });

    ensureDir(path.dirname(file));

    const now = Date.now();
    let state = { attempts: 0, lastBootAt: 0, lastHealthyAt: 0 };
    try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first boot */ }

    const previousWasFast = state.lastBootAt > 0 && (now - state.lastBootAt) < fastFailMs;
    const attempts = previousWasFast ? (state.attempts || 0) + 1 : 1;

    try {
        fs.writeFileSync(file, JSON.stringify({ ...state, attempts, lastBootAt: now }, null, 2));
    } catch { /* best effort */ }

    const delayMs = previousWasFast
        ? Math.min(maxMs, baseMs * Math.pow(2, Math.min(attempts - 2, 16)))
        : 0;

    if (previousWasFast && attempts >= maxAttempts) {
        console.error(
            `⚠️  ${attempts} consecutive failed starts. Backing off ${Math.round(maxMs / 1000)}s per attempt. ` +
            'Check the log above — this is almost always a configuration or network problem, not the bot.'
        );
    }

    const timer = setTimeout(() => {
        try {
            fs.writeFileSync(file, JSON.stringify({ attempts: 0, lastBootAt: now, lastHealthyAt: Date.now() }, null, 2));
        } catch { /* best effort */ }
    }, healthyMs);
    if (timer.unref) timer.unref();

    return {
        delayMs,
        attempts,
        healthy: () => { clearTimeout(timer); },
        stop: () => clearTimeout(timer),
        file,
    };
}

// ────────────────────────────────────────────────────────────────────────────
//  Reconnect backoff + bounded cache
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bounded exponential backoff with jitter. Prevents a reconnect storm from
 * hammering WhatsApp (and the CPU) when the network is down.
 */
function createBackoff(options = {}) {
    const baseMs = options.baseMs ?? envInt('MINI_RECONNECT_BASE_MS', 2000, { min: 250 });
    const maxMs = options.maxMs ?? envInt('MINI_RECONNECT_MAX_MS', 60000, { min: 1000 });
    const factor = options.factor ?? 2;
    const jitter = options.jitter ?? 0.2;
    let attempt = 0;
    return {
        next() {
            const raw = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
            attempt += 1;
            const j = 1 + (Math.random() * 2 - 1) * jitter;
            return Math.round(Math.min(maxMs, raw * j));
        },
        reset() { attempt = 0; },
        get attempt() { return attempt; },
    };
}

/**
 * Build a NodeCache with hard bounds so a long-running process cannot leak.
 * `useClones:false` avoids cloning large message objects on every read.
 *
 * IMPORTANT: node-cache's own `maxKeys` option THROWS `ECACHEFULL` once the
 * cache is full — it does not evict — so using it would turn a full cache into
 * a crash in the middle of message handling. We therefore leave `maxKeys` unset
 * and evict the oldest entries ourselves (FIFO, via insertion order) before
 * each insert, and swallow any residual store error: this cache is an
 * optimisation, never a correctness requirement.
 */
function boundedCache(NodeCache, { maxKeys = 500, ttlSeconds = 300 } = {}) {
    const cache = new NodeCache({
        stdTTL: ttlSeconds,
        checkperiod: Math.max(30, Math.min(120, ttlSeconds)),
        useClones: false,
    });

    if (!maxKeys || maxKeys <= 0) return cache;

    const rawSet = cache.set.bind(cache);
    cache.set = (key, value, ttl) => {
        try {
            if (!cache.has(key)) {
                const keys = cache.keys();
                if (keys.length >= maxKeys) {
                    const drop = Math.max(1, Math.ceil(maxKeys * 0.1));
                    for (let i = 0; i < drop && i < keys.length; i++) cache.del(keys[i]);
                }
            }
            return rawSet(key, value, ttl);
        } catch {
            return false;
        }
    };
    return cache;
}

module.exports = {
    ROOT,
    TMP_DIR,
    LOG_DIR,
    envInt,
    ensureDir,
    installLogPolicy,
    installTempPolicy,
    installMemoryGuard,
    installGracefulShutdown,
    installCrashGuards,
    installBootGuard,
    createBackoff,
    boundedCache,
};
