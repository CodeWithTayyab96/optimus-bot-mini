#!/usr/bin/env node
/**
 * check-mini-deps — static guard for the Optimus Mini dependency budget.
 *
 * Fails if:
 *   1. any CORE (Category A) command pulls a heavy package, directly or through
 *      the lib/ modules it requires; or
 *   2. any heavy package is listed in package.json `dependencies` (it must live
 *      in `optionalDependencies` so `npm ci --omit=optional` can skip it).
 *
 * This is the check that keeps Mini small as the codebase evolves: add a heavy
 * import to a core command and this stops you.
 *
 * Usage: node scripts/check-mini-deps.js
 * Also exported as check() so run-mini-tests.js can call it in-process.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const profile = require('../lib/miniProfile');

const BUILTIN = new Set([
    'fs', 'path', 'crypto', 'os', 'util', 'stream', 'http', 'https', 'net', 'zlib',
    'child_process', 'readline', 'events', 'assert', 'vm', 'module', 'url',
    'querystring', 'buffer', 'timers', 'dns', 'tls', 'string_decoder', 'perf_hooks',
    'worker_threads', 'fs/promises',
]);
const HEAVY = new Set(profile.HEAVY_PACKAGES);

/** Resolve a relative require to a file path, or null. */
function resolveReq(from, req) {
    const base = path.resolve(path.dirname(from), req);
    for (const cand of [base, `${base}.js`, path.join(base, 'index.js')]) {
        try { if (fs.statSync(cand).isFile()) return cand; } catch { /* keep looking */ }
    }
    return null;
}

/** Transitive heavy-package set reachable from a file. */
function heavyDeps(file, seen = new Set(), memo = new Map()) {
    if (memo.has(file)) return memo.get(file);
    if (seen.has(file)) return new Set();
    seen.add(file);

    const heavy = new Set();
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch { return heavy; }

    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
        const dep = m[1];
        if (BUILTIN.has(dep)) continue;
        if (dep.startsWith('.')) {
            const target = resolveReq(file, dep);
            if (target) for (const h of heavyDeps(target, seen, memo)) heavy.add(h);
        } else {
            const base = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0];
            if (HEAVY.has(base)) heavy.add(base);
        }
    }
    memo.set(file, heavy);
    return heavy;
}

/** Map command name → file path, without executing the modules. */
function commandFiles() {
    const out = new Map();
    const dir = path.join(ROOT, 'commands');
    for (const cat of fs.readdirSync(dir)) {
        const catPath = path.join(dir, cat);
        if (!fs.statSync(catPath).isDirectory()) continue;
        for (const f of fs.readdirSync(catPath).filter((x) => x.endsWith('.js'))) {
            const full = path.join(catPath, f);
            const src = fs.readFileSync(full, 'utf8');
            const blockRe = /module\.exports\s*=\s*\{/g;
            let mm; let name = null;
            while ((mm = blockRe.exec(src))) {
                const block = src.slice(mm.index, mm.index + 800);
                if (!/execute\s*[:(]/.test(block)) continue;
                const n = block.match(/(?:^|[\s,{])name\s*:\s*['"]([^'"]+)['"]/);
                if (n) name = n[1];
            }
            if (name && !out.has(name)) out.set(name, full);
        }
    }
    return out;
}

/**
 * Run the checks. Returns the number of failures (0 = pass).
 * @param {(msg: string) => void} [emit] line sink (default console.log)
 * @param {(msg: string) => void} [emitErr] error sink (default console.error)
 */
function check(emit = console.log, emitErr = console.error) {
    let failures = 0;
    const fail = (msg) => { failures++; emitErr(`  ❌ ${msg}`); };
    const pass = (msg) => emit(`  ✅ ${msg}`);

    emit('Optimus Mini — dependency budget check\n');

    // ── 1. No CORE command may reach a heavy package ────────────────────────
    emit('1. CORE commands must stay dependency-light');
    const files = commandFiles();
    const offenders = [];
    for (const name of profile.CORE_COMMANDS) {
        const file = files.get(name);
        if (!file) { fail(`core command '${name}' has no source file`); continue; }
        const heavy = heavyDeps(file);
        if (heavy.size) offenders.push(`${name} (${path.relative(ROOT, file)}) → ${[...heavy].join(', ')}`);
    }
    if (offenders.length) {
        offenders.forEach((o) => fail(`heavy dependency reachable from core command: ${o}`));
    } else {
        pass(`${profile.CORE_COMMANDS.length} core commands reach no heavy package`);
    }

    // ── 2. Heavy packages must not be hard `dependencies` ───────────────────
    emit('\n2. Heavy packages must live in optionalDependencies');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const hardHeavy = Object.keys(pkg.dependencies || {}).filter((d) => HEAVY.has(d));
    if (hardHeavy.length) {
        hardHeavy.forEach((d) => fail(`heavy package in 'dependencies': ${d}`));
    } else {
        pass(`no heavy package in 'dependencies' (${Object.keys(pkg.dependencies || {}).length} essential)`);
    }

    // ── 3. Report what the optional groups would need ───────────────────────
    emit('\n3. Optional groups (off by default)');
    for (const [group, meta] of Object.entries(profile.OPTIONAL_GROUPS)) {
        const need = meta.requires.length ? meta.requires.join(', ') : 'no extra packages';
        emit(`  • ${group.padEnd(10)} ${String(meta.commands.length).padStart(3)} commands · needs: ${need}`);
    }

    emit(`\n${failures === 0 ? '✅ PASS' : `❌ FAIL (${failures})`}`);
    return failures;
}

module.exports = { check, heavyDeps, commandFiles };

if (require.main === module) {
    process.exit(check() === 0 ? 0 : 1);
}
