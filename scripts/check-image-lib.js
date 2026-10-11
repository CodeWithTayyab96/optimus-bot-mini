#!/usr/bin/env node
/**
 * check-image-lib — verify that an image-processing library is installed and
 * that baileys' image path works.
 *
 * Why this exists: `sharp` (50 MB) is the single largest package in the Mini
 * install, so it is tempting to prune. Doing so BREAKS real functionality:
 *
 *   • `.setpp`  → baileys `generateProfilePicture`
 *   • sending any image/video → baileys `extractImageThumb`
 *
 * Both call `getImageProcessingLibrary()`, which throws
 * "No image processing library available" when neither `sharp` nor `jimp` is
 * present. Mini's install omits `jimp` (it is an optionalDependency), so
 * `sharp` is required. This check fails loudly if it is ever missing or broken.
 *
 * Usage: node scripts/check-image-lib.js
 * Also exported as check() for run-mini-tests.js.
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');

// A 1x1 PNG — enough for both code paths.
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
);

/** Which library is actually available (sharp preferred by baileys). */
async function availableLibraries() {
    const found = [];
    for (const name of ['sharp', 'jimp']) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await import(name);
            found.push(name);
        } catch { /* not installed */ }
    }
    return found;
}

async function check(emit = console.log, emitErr = console.error) {
    let failures = 0;
    const fail = (m) => { failures++; emitErr(`  ❌ ${m}`); };
    const pass = (m) => emit(`  ✅ ${m}`);

    emit('Optimus Mini — image-processing library\n');

    const libs = await availableLibraries();
    if (libs.length === 0) {
        fail('neither sharp nor jimp is installed — sending images and .setpp will fail');
        emit('\n  Install with:  npm ci --omit=dev --omit=optional   (sharp comes as a baileys peer)');
        emit(`\n❌ FAIL (${failures})`);
        return failures;
    }
    emit(`  installed: ${libs.join(', ')}`);

    let media;
    try {
        media = require(path.join(ROOT, 'node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js'));
    } catch (err) {
        emit(`  ⚠️  baileys is not installed — skipping the functional check (${err.code || err.message})`);
        emit('\n✅ PASS (nothing to verify without baileys)');
        return 0;
    }

    const cases = [
        ['generateProfilePicture (used by .setpp)', () => media.generateProfilePicture(PNG_1x1, { width: 64, height: 64 })],
        ['extractImageThumb (used when sending images/videos)', () => media.extractImageThumb(PNG_1x1, 32)],
    ];
    for (const [label, run] of cases) {
        try {
            const out = await run();
            if (out && (out.img || out.buffer)) pass(label);
            else fail(`${label} returned an unexpected result`);
        } catch (err) {
            fail(`${label} → ${err.message}`);
        }
    }

    if (failures === 0 && !libs.includes('sharp')) {
        emit('  ℹ️  running on jimp alone — baileys 7.0.0-rc13\'s extractImageThumb jimp branch is');
        emit('      guarded by `typeof Jimp === "object"`, which a v1 class export does not satisfy.');
        emit('      It works here, but sharp is the path baileys is written for.');
    }

    emit(`\n${failures === 0 ? '✅ PASS' : `❌ FAIL (${failures})`}`);
    return failures;
}

module.exports = { check, availableLibraries };

if (require.main === module) {
    check().then((f) => process.exit(f === 0 ? 0 : 1));
}
