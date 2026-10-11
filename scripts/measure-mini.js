// Benchmark harness for the Mini edition: module-load time, idle RSS and peak
// RSS under a burst of command dispatches. Run against the Mini install:
//   npm ci --omit=dev --omit=optional
//   node scripts/measure-mini.js [messages=400]
// Reports JSON on stdout. Companion: scripts/measure-full.js.
process.env.OPTIMUS_MINI = '1';

const t0 = process.hrtime.bigint();

const runtime = require('../lib/miniRuntime');
runtime.installTempPolicy({ intervalMs: 60 * 60 * 1000 });

const { getLastStats } = require('../lib/commandLoader');
const { handleMessages } = require('../main');

const t1 = process.hrtime.bigint();
const loadMs = Number(t1 - t0) / 1e6;
const stats = getLastStats();

const mb = (n) => +(n / 1048576).toFixed(1);
function snap() {
    const m = process.memoryUsage();
    return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external) };
}

const idle = snap();

const sent = [];
const mockSock = {
    user: { id: '1234567890:1@s.whatsapp.net' },
    sendMessage: async (jid, content) => { sent.push(1); return { key: { id: 'mock' } }; },
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({ participants: [] }),
    readMessages: async () => {},
};

const COMMANDS = ['.ping', '.uptime', '.alive', '.calc 2+2', '.coinflip', '.dice', '.8ball will it work',
    '.help', '.settings', '.owner', '.groupstats', '.myactivity', '.staff', '.advice', '.joke', '.quote'];

(async () => {
    const N = Number(process.argv[2] || 400);
    let peak = idle;
    const sample = () => { const s = snap(); if (s.rss > peak.rss) peak = s; return s; };

    for (let i = 0; i < N; i++) {
        const text = COMMANDS[i % COMMANDS.length];
        await handleMessages(mockSock, {
            messages: [{
                key: { remoteJid: '9999999999@s.whatsapp.net', fromMe: true, participant: undefined, id: 'T' + i },
                message: { conversation: text },
            }],
            type: 'notify',
        }, false).catch(() => {});
        if (i % 25 === 0) sample();
    }
    await new Promise((r) => setTimeout(r, 500));
    const afterActivity = sample();

    console.log(JSON.stringify({
        mode: 'mini',
        loadedCommands: stats.loaded,
        skippedCommands: stats.skipped,
        loadMs: +loadMs.toFixed(0),
        idle,
        peakUnderActivity: peak,
        afterActivity,
        messagesHandled: N,
        replies: sent.length,
    }, null, 2));

    process.exit(0);
})();
