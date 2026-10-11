// Benchmark harness for the FULL edition: module-load time, idle RSS and how
// many commands load, following the same startup path as index.js.
// Run against the full install (`npm ci --omit=dev`), with OPTIMUS_MINI unset:
//   node scripts/measure-full.js
// Reports JSON on stdout. Companion: scripts/measure-mini.js.
delete process.env.OPTIMUS_MINI;

const t0 = process.hrtime.bigint();

require('../settings');
require('../config.js');
const { getLastStats } = require('../lib/commandLoader');
const { handleMessages } = require('../main'); // loads ALL commands
// The modules the full entry point (index.js) requires at startup:
require('../lib/myfunc');       // jimp, moment-timezone, baileys
require('../lib/exif');         // node-webpmux, fluent-ffmpeg (+ ffmpeg-static)
require('../lib/productivity/scheduler');
require('../lib/potSupervisor');
require('../lib/dlHealth');
require('../lib/warpProxy');

const t1 = process.hrtime.bigint();
const mb = (n) => +(n / 1048576).toFixed(1);
const m = process.memoryUsage();
const stats = getLastStats();

console.log(JSON.stringify({
    mode: 'full',
    loadedCommands: stats.loaded,
    failedCommands: stats.failed,
    skippedCommands: stats.skipped,
    loadMs: +((Number(t1 - t0)) / 1e6).toFixed(0),
    idle: { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external) },
    handleMessagesType: typeof handleMessages,
}, null, 2));
process.exit(0);
