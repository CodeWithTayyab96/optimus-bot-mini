#!/usr/bin/env node
/**
 * Optimus Mini — entry point.
 * Copyright (c) 2026 Muhammad Tayyab Imran
 *
 * A deliberately small edition of Optimus Bot for a severely resource-constrained
 * host (≈580 MB RAM / ≈750 MB disk). It reuses the full edition's proven core —
 * main.js (message handling), lib/ and the lightweight commands — but:
 *
 *   • loads ONLY the commands in lib/miniProfile.js (never require()ing a heavy
 *     dependency such as sharp, ffmpeg, yt-search or cheerio);
 *   • does NOT start the optional subsystems (PO-token supervisor, download
 *     health monitor, WARP tunnel, auto-bio, yt-dlp bootstrap);
 *   • applies hard resource guards (rotating logs, temp/disk caps, a memory
 *     ceiling, bounded caches, reconnect backoff, clean shutdown).
 *
 * The full edition is untouched: `node index.js` behaves exactly as before.
 *
 * Usage
 *   node mini.js                 pair (if needed) with a pairing code, then run
 *   node mini.js --qr            print a QR code instead of a pairing code
 *   MINI_ENABLE=ai,media node mini.js   also load the optional groups
 *
 * See OPTIMUS_MINI_DEPLOY.md for the full guide.
 */
'use strict';

// Set BEFORE anything requires main.js / lib/commandLoader.js: this is what
// makes the command loader apply the Mini allowlist.
process.env.OPTIMUS_MINI = '1';
process.title = 'optimus-mini';

const fs = require('fs');
const chalk = require('chalk');
const NodeCache = require('node-cache');
const readline = require('readline');

const runtime = require('./lib/miniRuntime');
const settings = require('./settings');
require('./config.js');

// main.js is required AFTER OPTIMUS_MINI is set, so it loads only Mini commands.
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const store = require('./lib/lightweight_store');
const { describeSession, sessionSummary, needsPairing } = require('./lib/sessionInfo');
const miniProfile = require('./lib/miniProfile');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// ────────────────────────────────────────────────────────────────────────────
//  Resource guards (installed before any long-running work)
// ────────────────────────────────────────────────────────────────────────────
const logPolicy = runtime.installLogPolicy();
runtime.installTempPolicy();
runtime.installCrashGuards();
const backoff = runtime.createBackoff();
// Detects a crash loop and returns a delay to wait before starting again.
const bootGuard = runtime.installBootGuard();

const DATA_DIR = './data';
const OWNER_FILE = `${DATA_DIR}/owner.json`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let owner = [];
try {
    owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    if (!Array.isArray(owner)) owner = [];
} catch {
    owner = settings.ownerNumber ? [String(settings.ownerNumber)] : [];
    try { fs.writeFileSync(OWNER_FILE, JSON.stringify(owner, null, 2)); } catch { /* best effort */ }
}

global.botname = 'OPTIMUS MINI';
global.themeemoji = '•';

const pairingCode = !process.argv.includes('--qr') || process.argv.includes('--pairing-code');
const useMobile = process.argv.includes('--mobile');

const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const question = (text) => (rl
    ? new Promise((resolve) => rl.question(text, resolve))
    : Promise.resolve(settings.botNumber || settings.ownerNumber || null));

// ────────────────────────────────────────────────────────────────────────────
//  Store — bounded, persisted on an interval
// ────────────────────────────────────────────────────────────────────────────
store.readFromFile();
const storeTimer = setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);
if (storeTimer.unref) storeTimer.unref();

// ────────────────────────────────────────────────────────────────────────────
//  Startup banner
// ────────────────────────────────────────────────────────────────────────────
function banner(stats, memLimitMb) {
    const groups = [...miniProfile.enabledGroups()];
    console.log('');
    console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════════════╗'));
    console.log(chalk.bold.cyan('  ║') + chalk.bold.white('   OPTIMUS MINI — lightweight WhatsApp bot        ') + chalk.bold.cyan('║'));
    console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════════════╝'));
    console.log(chalk.gray(`  version ${settings.version} · commit ${settings.gitCommit || 'unknown'} · node ${process.version}`));
    console.log(chalk.gray(
        `  commands        : ${stats.loaded}/${stats.total} files loaded` +
        ` (${stats.skipped} outside the Mini profile, ${stats.duplicates} shadowed by a duplicate name, ${stats.failed} failed)`
    ));
    if (groups.length) console.log(chalk.gray(`  extra groups    : ${groups.join(', ')}`));
    console.log(chalk.gray(`  RAM ceiling     : ${memLimitMb} MB (MAX_RSS_MB)`));
    if (logPolicy.stats().enabled) {
        console.log(chalk.gray(`  log file        : ${logPolicy.stats().file} (cap ~${Math.round(logPolicy.stats().maxBytes * (logPolicy.stats().keep + 1) / 1048576)} MB)`));
    } else {
        console.log(chalk.gray('  log file        : disabled (MINI_LOG_FILE=off)'));
    }
    console.log('');
}

// ────────────────────────────────────────────────────────────────────────────
//  Socket lifecycle
// ────────────────────────────────────────────────────────────────────────────
let sock = null;
let pairingCodeIssued = false;
let shuttingDown = false;

// Bounded so a flapping connection cannot grow it without limit.
const msgRetryCounterCache = runtime.boundedCache(NodeCache, { maxKeys: 200, ttlSeconds: 120 });

function reportSessionState(creds) {
    const info = describeSession(creds, './session/creds.json');
    console.log(chalk.cyan(`[session] ${sessionSummary(info)}`));
    if (needsPairing(info)) {
        console.log(chalk.yellow('[session] Not linked — the bot will ask for a phone number to pair.'));
    }
}

function writePairingCodeFile(number, code) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync('./data/pairing-code.txt', [
            `Number : ${number}`,
            `Code   : ${code}`,
            `Issued : ${new Date().toISOString()}`,
            '',
            'WhatsApp → Settings → Linked Devices → Link a Device',
            '→ "Link with phone number instead" → enter the code.',
        ].join('\n'));
        console.log(chalk.cyan('[pair] code also written to data/pairing-code.txt'));
    } catch (err) {
        console.log(chalk.gray(`[pair] could not write the code file: ${err.message}`));
    }
}

function clearPairingCodeFile() {
    try { fs.rmSync('./data/pairing-code.txt', { force: true }); } catch { /* nothing to remove */ }
}

/** Start the lightweight subsystems that CORE commands depend on. */
function startCoreServices(socket) {
    try {
        require('./lib/productivity/scheduler').init(socket);
    } catch (error) {
        console.error('Error initialising the reminder scheduler:', error.message);
    }
    try {
        require('./lib/groupTimers').init(socket);
    } catch (error) {
        console.error('Error re-arming group timers:', error.message);
    }
}

async function startBot() {
    if (shuttingDown) return;

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    reportSessionState(state.creds);

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !pairingCode,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
        },
        markOnlineOnConnect: true,
        // Link previews cost CPU + memory; off by default on a tiny host.
        generateHighQualityLinkPreview: process.env.MINI_LINK_PREVIEW === '1',
        syncFullHistory: false,
        getMessage: async (key) => {
            const jid = jidNormalizedUser(key.remoteJid);
            const msg = await store.loadMessage(jid, key.id);
            return msg?.message || '';
        },
        msgRetryCounterCache,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);
    store.bind(sock.ev);

    // Same outbound governor as the full edition: fewer messages per command,
    // which matters even more on a small host sharing one WhatsApp number.
    require('./lib/notify').wrap(sock);

    // Compatibility helper used by some libs; no dependency cost.
    sock.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return (decode.user && decode.server && `${decode.user}@${decode.server}`) || jid;
        }
        return jid;
    };

    // ── Incoming messages ───────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            mek.message = Object.keys(mek.message)[0] === 'ephemeralMessage'
                ? mek.message.ephemeralMessage.message
                : mek.message;

            if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                await handleStatus(sock, chatUpdate);
                return;
            }
            if (!sock.public && !mek.key.fromMe && chatUpdate.type === 'notify') {
                const isGroup = mek.key?.remoteJid?.endsWith('@g.us');
                if (!isGroup) return;
            }
            if (mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

            // Flush the retry cache after each message to keep it small under
            // load. Baileys keeps its own reference internally and does NOT
            // expose it on the socket, so flush via OUR handle (this is why the
            // full edition's `sock.msgRetryCounterCache.clear()` never runs).
            msgRetryCounterCache.flushAll();

            try {
                await handleMessages(sock, chatUpdate, false);
            } catch (err) {
                console.error('Error in handleMessages:', err.message);
                if (mek.key?.remoteJid) {
                    await sock.sendMessage(mek.key.remoteJid, {
                        text: '❌ An error occurred while processing your message.',
                    }).catch(() => {});
                }
            }
        } catch (err) {
            console.error('Error in messages.upsert:', err.message);
        }
    });

    sock.public = true;

    // ── Pairing code ────────────────────────────────────────────────────────
    if (pairingCode && !sock.authState.creds.registered) {
        if (useMobile) throw new Error('Cannot use pairing code with the mobile API');
        if (pairingCodeIssued) {
            console.log(chalk.yellow('⚠️  A pairing code was already issued this run — not requesting a new one.'));
        } else {
            pairingCodeIssued = true;
            let phoneNumber;
            if (rl) {
                phoneNumber = await question(chalk.greenBright(
                    'Please type the WhatsApp number for the BOT account (country code + number, no + or spaces): '
                ));
            } else {
                phoneNumber = settings.botNumber || settings.ownerNumber || null;
                if (phoneNumber) console.log(chalk.cyan(`[pair] Using ${phoneNumber} from settings.`));
            }
            if (!phoneNumber) {
                console.log(chalk.red('No phone number available. Set botNumber/ownerNumber in settings.js.'));
                process.exit(1);
            }
            phoneNumber = String(phoneNumber).replace(/[^0-9]/g, '');

            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(chalk.bgGreen.black('Your Pairing Code : '), chalk.white(code));
                    writePairingCodeFile(phoneNumber, code);
                } catch (error) {
                    console.error('Error requesting pairing code:', error.message);
                    pairingCodeIssued = false;
                }
            }, 3000);
        }
    }

    // ── Connection updates ──────────────────────────────────────────────────
    sock.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect, qr } = s;

        if (qr) {
            console.log(chalk.yellow('📱 Scan this QR code with WhatsApp (Settings → Linked Devices):'));
            try {
                require('qrcode-terminal').generate(qr, { small: true });
            } catch (qrErr) {
                console.log(chalk.red('Could not render the QR code:'), qrErr.message);
            }
        }

        if (connection === 'connecting') console.log(chalk.yellow('🔄 Connecting to WhatsApp…'));

        if (connection === 'open') {
            clearPairingCodeFile();
            backoff.reset();
            console.log(chalk.green(`🌿 Connected as ${sock.user?.id || 'unknown'}`));
            startCoreServices(sock);
        }

        if (connection === 'close') {
            if (shuttingDown) return;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

            if (loggedOut) {
                try {
                    fs.rmSync('./session', { recursive: true, force: true });
                    console.log(chalk.yellow('Session folder deleted — please re-authenticate.'));
                } catch (error) {
                    console.error('Error deleting session:', error.message);
                }
                return;
            }

            const wait = backoff.next();
            console.log(chalk.red(`Connection closed (${statusCode ?? 'unknown'}). Reconnecting in ${(wait / 1000).toFixed(1)}s…`));
            setTimeout(() => {
                startBot().catch((error) => {
                    console.error('Reconnect failed:', error.message);
                    const again = backoff.next();
                    setTimeout(() => startBot().catch(() => {}), again);
                });
            }, wait);
        }
    });

    // ── Anti-call (opt-in per owner command) ────────────────────────────────
    const antiCallNotified = new Set();
    sock.ev.on('call', async (calls) => {
        try {
            const { readState } = require('./commands/owner/anticall');
            if (!readState().enabled) return;
            for (const call of calls) {
                const callerJid = call.from || call.peerJid || call.chatId;
                if (!callerJid) continue;
                try {
                    if (typeof sock.rejectCall === 'function' && call.id) await sock.rejectCall(call.id, callerJid);
                } catch { /* ignore */ }
                if (!antiCallNotified.has(callerJid)) {
                    antiCallNotified.add(callerJid);
                    setTimeout(() => antiCallNotified.delete(callerJid), 60000);
                    await sock.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected.' }).catch(() => {});
                }
                setTimeout(() => { sock.updateBlockStatus(callerJid, 'block').catch(() => {}); }, 800);
            }
        } catch { /* ignore */ }
    });

    sock.ev.on('group-participants.update', async (update) => {
        await handleGroupParticipantUpdate(sock, update);
    });

    return sock;
}

// ────────────────────────────────────────────────────────────────────────────
//  Shutdown
// ────────────────────────────────────────────────────────────────────────────
async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${reason || 'signal'} — flushing state and closing the socket`);
    clearInterval(storeTimer);
    try { require('./lib/productivity/scheduler').shutdown(); } catch { /* ignore */ }
    try { require('./lib/groupTimers').stop(); } catch { /* ignore */ }
    try { store.writeToFile(); } catch { /* ignore */ }
    try {
        if (sock && typeof sock.end === 'function') sock.end(new Error('shutdown'));
        else if (sock && sock.ws) sock.ws.close();
    } catch { /* ignore */ }
    logPolicy.stop();
}

runtime.installGracefulShutdown({ onShutdown: shutdown });

// The memory ceiling goes through the SAME clean path as a signal: the store is
// flushed and the socket is closed before the process exits, so hitting the
// limit can never leave half-written state behind.
const memGuard = runtime.installMemoryGuard({
    onLimit: async (rss) => {
        console.error(`⚠️  RSS ${rss.toFixed(0)} MB over the ${runtime.envInt('MAX_RSS_MB', 180, { min: 64 })} MB ceiling — restarting cleanly.`);
        await shutdown('memory ceiling');
        process.exit(1); // the supervisor brings up a fresh process
    },
});

// ────────────────────────────────────────────────────────────────────────────
//  Go
// ────────────────────────────────────────────────────────────────────────────
// The command loader already ran inside main.js; report what it actually loaded.
const { getLastStats } = require('./lib/commandLoader');
banner(getLastStats(), memGuard.limitMb);

async function main() {
    // If the previous boot died during startup, wait before trying again so a
    // persistent failure cannot become a tight restart loop.
    if (bootGuard.delayMs > 0) {
        console.log(chalk.yellow(
            `⚠️  Previous start failed early (attempt ${bootGuard.attempts}). Waiting ${(bootGuard.delayMs / 1000).toFixed(0)}s before retrying.`
        ));
        await new Promise((r) => setTimeout(r, bootGuard.delayMs));
    }
    await startBot();
    bootGuard.healthy();
}

main().catch((error) => {
    console.error('Fatal error:', error && error.stack ? error.stack : error);
    // Deliberately NOT a raw exit path: flush what we can first.
    shutdown('fatal startup error').finally(() => process.exit(1));
});
