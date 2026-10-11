#!/usr/bin/env node
/**
 * run-mini-tests — aggregated checks for the Optimus Mini edition.
 *
 * Dependency-light by design: it must run inside a production Mini install
 * (`npm ci --omit=dev --omit=optional`), where jest and the dev tooling are
 * absent. Steps:
 *
 *   1. syntax-check every file the Mini edition ships / touches (in-process,
 *      via vm.Script — no child process needed);
 *   2. run the static dependency-budget guard (check-mini-deps.js);
 *   3. run the functional smoke suite (smoke-mini.js).
 *
 * The functional checks are spawned as child processes where possible (clean
 * isolation) and fall back to in-process execution where spawning is blocked.
 *
 * Usage: node scripts/run-mini-tests.js      (npm run test:mini)
 */
'use strict';

const { spawnSync } = require('child_process');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
let failures = 0;
let ran = 0;

/** Try to spawn a child node process; return null when spawning is blocked. */
function trySpawn(args) {
    for (const bin of [process.execPath, 'node']) {
        const res = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
        if (!res.error) return res;
    }
    return null;
}

/**
 * Run one functional check, preferring a child process.
 * @param {string} label
 * @param {string[]} args          argv for the child process
 * @param {() => number|Promise<number>} inProcess  fallback → failure count
 */
async function runFunctional(label, args, inProcess) {
    ran++;
    const res = trySpawn(args);
    if (res) {
        const okRun = res.status === 0;
        console.log(`${okRun ? '✅' : '❌'} ${label}`);
        if (!okRun) {
            failures++;
            console.log((res.stdout || '') + (res.stderr || ''));
        }
        return;
    }
    // Spawning unavailable — run it here.
    console.log(`ℹ️  ${label}: running in-process (child processes unavailable)`);
    let fails = 0;
    try {
        fails = await inProcess();
    } catch (err) {
        fails = 1;
        console.error(err && err.stack ? err.stack : err);
    }
    console.log(`${fails === 0 ? '✅' : '❌'} ${label}`);
    if (fails) failures++;
}

// ── 1. Syntax check (in-process) ────────────────────────────────────────────
const MINI_FILES = [
    'mini.js',
    'lib/miniProfile.js',
    'lib/miniRuntime.js',
    'lib/commandLoader.js',
    'lib/lightweight_store.js',
    'lib/sessionInfo.js',
    'lib/productivity/scheduler.js',
    'lib/groupTimers.js',
    'main.js',
    'settings.js',
    'scripts/check-mini-deps.js',
    'scripts/check-command-counts.js',
    'scripts/check-image-lib.js',
    'scripts/smoke-mini.js',
    'scripts/run-mini-tests.js',
];

let syntaxOk = true;
for (const rel of MINI_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { syntaxOk = false; console.log(`❌ missing: ${rel}`); continue; }
    try {
        // Strip a shebang, exactly as the CommonJS loader does, then compile.
        const src = fs.readFileSync(full, 'utf8').replace(/^#![^\n]*\n/, '');
        new vm.Script(src, { filename: full });
    } catch (err) {
        syntaxOk = false;
        console.log(`❌ syntax: ${rel}\n${err.message}`);
    }
}
ran++;
if (syntaxOk) console.log(`✅ syntax check (${MINI_FILES.length} files)`);
else failures++;

// ── 2 + 3. Functional checks ────────────────────────────────────────────────
(async () => {
    await runFunctional(
        'dependency budget (check-mini-deps)',
        ['scripts/check-mini-deps.js'],
        () => require('./check-mini-deps').check()
    );
    await runFunctional(
        'command counts (check-command-counts)',
        ['scripts/check-command-counts.js'],
        () => require('./check-command-counts').check()
    );
    await runFunctional(
        'image library (check-image-lib)',
        ['scripts/check-image-lib.js'],
        () => require('./check-image-lib').check()
    );
    await runFunctional(
        'functional smoke (smoke-mini)',
        ['scripts/smoke-mini.js'],
        async () => (await require('./smoke-mini').smoke()).failed
    );

    // ── Cleanup ─────────────────────────────────────────────────────────────
    for (const rel of ['data/afk.json', 'data/groupStats.json', 'data/mode.json', 'data/messageStats.json']) {
        try { fs.rmSync(path.join(ROOT, rel), { force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${ran - failures}/${ran} mini checks passed`);
    process.exit(failures === 0 ? 0 : 1);
})();
