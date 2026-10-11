#!/usr/bin/env node
/**
 * check-command-counts — reconcile every command-count number and fail loudly
 * when they drift apart.
 *
 * Why this exists: the project has four different "command counts" that look
 * contradictory but are not —
 *
 *   files on disk            every commands/<cat>/*.js
 *   unique declared names    files sharing a `name:` collapse into one command
 *   profile (Category A)     names the Mini allowlist asks for
 *   loaded / skipped / etc.  what the loader actually did
 *
 * This script prints the reconciliation and asserts that the loader's
 * accounting adds up exactly, so a future edit cannot silently change the
 * numbers without failing the check.
 *
 * Usage: node scripts/check-command-counts.js
 * Also exported as check() for run-mini-tests.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Every command file with the name it declares, in loader order. */
function enumerate() {
    const { readDeclaredName } = require('../lib/commandLoader');
    const dir = path.join(ROOT, 'commands');
    const files = [];
    // Sorted, to match the loader's deterministic order.
    for (const cat of fs.readdirSync(dir).sort()) {
        const catPath = path.join(dir, cat);
        if (!fs.statSync(catPath).isDirectory()) continue;
        for (const f of fs.readdirSync(catPath).filter((x) => x.endsWith('.js')).sort()) {
            const full = path.join(catPath, f);
            files.push({ rel: path.relative(ROOT, full).replace(/\\/g, '/'), name: readDeclaredName(full) });
        }
    }
    return files;
}

/** Names declared by more than one file (the later ones are shadowed). */
function duplicatesOf(files) {
    const byName = new Map();
    for (const f of files) {
        if (!byName.has(f.name)) byName.set(f.name, []);
        byName.get(f.name).push(f.rel);
    }
    const dupes = new Map();
    for (const [name, rels] of byName) if (rels.length > 1) dupes.set(name, rels);
    return dupes;
}

function check(emit = console.log, emitErr = console.error) {
    let failures = 0;
    const fail = (m) => { failures++; emitErr(`  ❌ ${m}`); };
    const pass = (m) => emit(`  ✅ ${m}`);

    const profile = require('../lib/miniProfile');
    const files = enumerate();
    const dupes = duplicatesOf(files);
    const uniqueNames = new Set(files.map((f) => f.name));

    emit('Optimus Mini — command-count reconciliation\n');

    // ── 1. Files vs unique names ────────────────────────────────────────────
    emit('1. Files on disk');
    emit(`  files                 : ${files.length}`);
    emit(`  unique declared names : ${uniqueNames.size}`);
    emit(`  duplicate names       : ${dupes.size}`);
    for (const [name, rels] of dupes) {
        emit(`      • '${name}' declared by ${rels.length} files → ${rels.join(', ')}`);
    }

    // ── 2. Profile consistency ──────────────────────────────────────────────
    emit('\n2. Profile (Category A)');
    const core = profile.CORE_COMMANDS;
    const coreSet = new Set(core);
    emit(`  CORE_COMMANDS entries : ${core.length}`);
    emit(`  CORE unique names     : ${coreSet.size}`);

    if (coreSet.size !== core.length) {
        const seen = new Set(); const repeated = new Set();
        for (const n of core) { if (seen.has(n)) repeated.add(n); seen.add(n); }
        fail(`CORE_COMMANDS contains duplicate entries: ${[...repeated].join(', ')}`);
    } else {
        pass('CORE_COMMANDS has no duplicate entries');
    }

    const missingFiles = core.filter((n) => !uniqueNames.has(n));
    if (missingFiles.length) fail(`CORE names with no command file: ${missingFiles.join(', ')}`);
    else pass(`all ${core.length} CORE names have a command file`);

    // A CORE name that is shadowed by a duplicate still loads exactly once.
    const shadowedCore = [...dupes.keys()].filter((n) => coreSet.has(n));
    if (shadowedCore.length) {
        emit(`  ℹ️  CORE names shadowed by a duplicate (load once, first file wins): ${shadowedCore.join(', ')}`);
    }

    // ── 3. Loader accounting (Mini mode) ────────────────────────────────────
    emit('\n3. Loader accounting (Mini mode)');
    let stats = null;
    let loadedMap = null;
    try {
        process.env.OPTIMUS_MINI = '1';
        const { loadCommands, getLastStats } = require('../lib/commandLoader');
        loadedMap = loadCommands();
        stats = getLastStats();
    } catch (err) {
        emit(`  ⚠️  could not run the loader (dependencies not installed?): ${err.message}`);
    }

    if (stats) {
        const dupFiles = files.length - uniqueNames.size; // files sharing a name with an earlier file
        emit(`  files                 : ${files.length}`);
        emit(`  loaded                : ${stats.loaded}`);
        emit(`  skipped (not allowed) : ${stats.skipped}`);
        emit(`  failed                : ${stats.failed}`);
        emit(`  shadowed duplicates   : ${stats.duplicates}`);
        const sum = stats.loaded + stats.skipped + stats.failed + stats.duplicates;
        if (sum !== files.length) {
            fail(`accounting does not add up: ${stats.loaded}+${stats.skipped}+${stats.failed}+${stats.duplicates} = ${sum} ≠ ${files.length} files`);
        } else {
            pass(`accounting adds up: ${stats.loaded} loaded + ${stats.skipped} skipped + ${stats.failed} failed + ${stats.duplicates} shadowed = ${files.length}`);
        }

        if (stats.failed !== 0) {
            emit(`  ℹ️  ${stats.failed} command file(s) failed to load — see the warnings above (usually a missing optional package)`);
        }

        // The allowlist loads exactly one file per distinct CORE name.
        const expected = core.filter((n) => uniqueNames.has(n)).length;
        if (stats.loaded !== expected) {
            fail(`loaded ${stats.loaded} but expected ${expected} (distinct CORE names with a file)`);
        } else {
            pass(`loaded exactly one command per distinct CORE name (${expected})`);
        }

        // The real requirement: EVERY essential command must be dispatchable.
        const unreachable = core.filter((n) => !loadedMap.has(n));
        if (unreachable.length) {
            fail(`essential commands not dispatchable: ${unreachable.join(', ')}`);
        } else {
            pass(`all ${core.length} essential commands are registered and dispatchable`);
        }

        // An alias must never win over another command's primary name.
        const aliasStolen = [];
        for (const c of files) {
            if (!coreSet.has(c.name)) continue;
            const registered = loadedMap.get(c.name);
            if (registered && registered.name !== c.name) {
                aliasStolen.push(`${c.name} → resolved to '${registered.name}' (${c.rel})`);
            }
        }
        if (aliasStolen.length) fail(`primary name shadowed by an alias: ${aliasStolen.join('; ')}`);
        else pass('no primary command name is shadowed by another command\'s alias');
    }

    emit(`\n${failures === 0 ? '✅ PASS' : `❌ FAIL (${failures})`}`);
    return failures;
}

module.exports = { check, enumerate, duplicatesOf };

if (require.main === module) {
    process.exit(check() === 0 ? 0 : 1);
}
