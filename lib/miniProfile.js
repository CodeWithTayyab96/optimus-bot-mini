/**
 * Optimus Mini — feature profile.
 * Copyright (c) 2026 Muhammad Tayyab Imran
 *
 * A single source of truth for WHAT Optimus Mini loads. It is pure data + tiny
 * helpers with zero dependencies, so requiring it can never pull a heavy module
 * into the process (the whole point of the Mini edition).
 *
 * Classification (see OPTIMUS_MINI_REPORT.md for the full analysis):
 *
 *   Category A — ESSENTIAL   → CORE_COMMANDS, always loaded.
 *   Category B — OPTIONAL    → OPTIONAL_GROUPS, off by default, opt in with
 *                              MINI_ENABLE=<group>[,<group>...].
 *   Category C — EXCLUDED    → neither list; documented in EXCLUDED_FEATURES.
 *
 * A command is matched by its `name` field. Aliases are registered
 * automatically by the command loader when the primary name is enabled.
 *
 * Why an allowlist rather than a denylist: a command that is NOT listed here is
 * never require()d, so none of its dependencies (sharp, ffmpeg, yt-dlp helpers,
 * cheerio, …) are ever loaded into memory. A denylist would silently load any
 * newly added heavy command.
 */
'use strict';

/**
 * Category A — ESSENTIAL commands.
 *
 * Everything the bot needs for its primary purpose: group management,
 * moderation, owner controls, basic info, keyless utilities and lightweight
 * productivity. Every command here is dependency-light (Node built-ins,
 * baileys, axios, node-fetch or qrcode only) — verified by
 * scripts/check-mini-deps.js.
 */
const CORE_COMMANDS = [
  // ── admin / group management + moderation (50) ───────────────────────────
  'admincheck', 'antibadword', 'antibot', 'antigroupmention', 'antigroupstatus',
  'antihijack', 'antilink', 'antispam', 'antisticker', 'antitag', 'approveall',
  'autosticker', 'ban', 'chatbot', 'clear', 'close', 'creategc', 'delete',
  'demote', 'demoteall', 'gcstatus', 'goodbye', 'groupjid', 'grouplink',
  'hidetag', 'join', 'kick', 'kickadmin', 'kickall', 'leave', 'listonline',
  'mention', 'mute', 'open', 'pending', 'promote', 'promoteall', 'protect',
  'rejectall', 'resetlink', 'resetwarn', 'setgdesc', 'tag', 'tagall',
  'tagnotadmin', 'unban', 'unmute', 'warn', 'warnings', 'welcome',

  // ── general (14) ─────────────────────────────────────────────────────────
  'alive', 'help', 'ping', 'owner', 'settings', 'uptime', 'groupinfo',
  'groupstats', 'myactivity', 'staff', 'ss', 'getpp', 'githubstalk', 'vv',

  // ── group (1) ────────────────────────────────────────────────────────────
  'savecontact',

  // ── islamic (1) ──────────────────────────────────────────────────────────
  'quran',

  // ── owner controls (27) ──────────────────────────────────────────────────
  'afk', 'aistatus', 'anticall', 'antidelete', 'areact', 'autoread',
  'autoreply', 'autostatus', 'autotyping', 'block', 'broadcast',
  'clearsession', 'cleartmp', 'jid', 'mode', 'pair', 'pmblocker', 'poststatus',
  'restart', 'setbotname', 'setnewsletter', 'setpp', 'setprefix', 'status',
  'sudo', 'unblock', 'update',

  // ── productivity (10) ────────────────────────────────────────────────────
  'cancelreminder', 'poll', 'pollresult', 'remind', 'reminders', 'save',
  'saved', 'schedule', 'snooze', 'unsave',

  // ── fun (light) (38) ─────────────────────────────────────────────────────
  '8ball', 'advice', 'bomb', 'cat', 'catfact', 'character', 'coinflip',
  'compliment', 'dare', 'dice', 'dog', 'fact', 'flirt', 'food', 'gayrate',
  'gif', 'goodnight', 'hangman', 'insult', 'joke', 'meme', 'motivate', 'pies',
  'quote', 'riddle', 'roast', 'roseday', 'rps', 'shayari', 'ship', 'simp',
  'slot', 'stupid', 'topmembers', 'trivia', 'truth', 'ttt', 'wasted',

  // ── utility (keyless / lightweight) (30) ─────────────────────────────────
  'apod', 'aqi', 'book', 'calc', 'color', 'crypto', 'currency', 'ddg',
  'define', 'dictionary', 'earthquake', 'fancy', 'gita', 'google', 'hn',
  'imdb', 'itunes', 'musicbrainz', 'myip', 'nameinfo', 'qr', 'recipe',
  'shorturl', 'sports', 'stock', 'sun', 'tmdb', 'weather', 'wiki',
];

/**
 * Category B — OPTIONAL groups. Not loaded unless opted in.
 *
 * Enabling a group may require the matching optionalDependencies to be
 * installed (`npm install`, i.e. WITHOUT `--omit=optional`). The mapping below
 * records which extra packages a group needs so the operator is told up front.
 */
const OPTIONAL_GROUPS = {
  ai: {
    requires: [],
    commands: [
      'gpt', 'imagine', 'magicstudio', 'openai', 'reply', 'rewrite',
      'summarize', 'stt', 'voicesummary',
    ],
  },
  anime: {
    requires: [],
    commands: ['anime', 'mal', 'manga', 'waifu'],
  },
  media: {
    requires: ['yt-search', 'ruhend-scraper', 'axios'],
    commands: [
      'apk', 'capcut', 'download', 'facebook', 'lyrics', 'mediafire',
      'pinterest', 'soundcloud', 'spotify', 'threads', 'twitter', 'ytdiag',
      'dlstatus', 'music', 'song', 'video', 'ytsearch', 'tiktok',
      'instagram', 'igs', 'remini', 'removebg', 'toaudio', 'togif', 'toptt',
      'tovideo', 'toimg', 'blur',
    ],
  },
  stickers: {
    requires: ['ffmpeg-static', 'fluent-ffmpeg', 'node-webpmux'],
    commands: ['sticker', 'sticker2', 'crop', 'take', 'tg', 'attp', 'emojimix'],
  },
  image: {
    requires: ['sharp', 'jimp', 'fs-extra'],
    // NOTE: `.study` also needs `pdf-to-img` (PDF → image for AI vision), which
    // is NOT declared in package.json — a pre-existing gap in the original
    // project. Declaring it pulls ~72 MB (a nested pdfjs-dist + @napi-rs), so it
    // is left out; `.study` text extraction works, PDF-page images do not.
    commands: ['gptimage', 'study', 'simage', 'setmenuimage'],
  },
  textmaker: {
    requires: ['mumaker'],
    commands: ['textmaker'],
  },
  extras: {
    requires: ['cheerio', 'google-translate-api-x', 'moment-timezone', 'gtts'],
    commands: [
      'news', 'translate', 'github', 'url', 'tts', 'heart', 'memesearch',
    ],
  },
};

/**
 * Category C — EXCLUDED features (background services / heavy subsystems).
 * Listed here so the profile is self-documenting and tests can assert they are
 * never started by the Mini entry point.
 */
const EXCLUDED_FEATURES = [
  'potSupervisor (YouTube PO-token provider supervisor)',
  'dlHealth (download-source health monitor)',
  'warpProxy (Cloudflare WARP tunnel)',
  'autobio (background auto-bio loop)',
  'bootstrap.js yt-dlp / python auto-install',
  'fs.watchFile self-reload (development convenience in index.js)',
];

/** Runtime features Mini does start. Small, bounded, required by CORE. */
const CORE_FEATURES = [
  'scheduler (reminder/schedule engine — required by .remind/.schedule)',
  'groupTimers (re-arm .open/.close reverts across restarts)',
  'statusCache (capture incoming statuses for .status)',
  'lightweight store (bounded, persisted every 10 s)',
];

/**
 * Packages that must never appear in a CORE command's dependency graph — they
 * are what makes the full edition heavy.
 *
 * ⚠️  `sharp` is in this list, but that does NOT mean it can be removed from the
 * install: baileys declares it as a (non-optional) peer and calls it — lazily —
 * for `generateProfilePicture` (`.setpp`) and `extractImageThumb` (sending any
 * image or video). With it missing, both throw "No image processing library
 * available" because Mini omits the `jimp` fallback. Keep it installed;
 * `scripts/check-image-lib.js` enforces this.
 */
const HEAVY_PACKAGES = [
  'sharp', 'jimp', 'ffmpeg-static', 'fluent-ffmpeg', '@ffmpeg/ffmpeg',
  '@distube/ytdl-core', 'yt-search', 'youtube-yts', 'node-youtube-music',
  'mammoth', 'pdf-parse', 'pdf-to-img', 'mumaker', 'ruhend-scraper',
  'cheerio', 'gtts', 'node-webpmux', 'node-id3', 'google-translate-api-x',
  'moment-timezone', 'fs-extra',
];

/** Parse MINI_ENABLE="ai,media" into a Set. Unknown names are ignored. */
function enabledGroups(env = process.env) {
  const raw = String(env.MINI_ENABLE || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(raw.filter((g) => Object.prototype.hasOwnProperty.call(OPTIONAL_GROUPS, g)));
}

/** Unknown group names in MINI_ENABLE (so we can warn about typos). */
function unknownGroups(env = process.env) {
  const raw = String(env.MINI_ENABLE || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return raw.filter((g) => !Object.prototype.hasOwnProperty.call(OPTIONAL_GROUPS, g));
}

/** The set of command names Mini should load, given the environment. */
function resolveCommands(env = process.env) {
  const set = new Set(CORE_COMMANDS);
  for (const g of enabledGroups(env)) {
    for (const c of OPTIONAL_GROUPS[g].commands) set.add(c);
  }
  return set;
}

/** Which optional packages are needed for the currently enabled groups. */
function requiredOptionalPackages(env = process.env) {
  const need = new Set();
  for (const g of enabledGroups(env)) {
    for (const p of OPTIONAL_GROUPS[g].requires) need.add(p);
  }
  return [...need];
}

module.exports = {
  name: 'Optimus Mini',
  CORE_COMMANDS,
  OPTIONAL_GROUPS,
  EXCLUDED_FEATURES,
  CORE_FEATURES,
  HEAVY_PACKAGES,
  enabledGroups,
  unknownGroups,
  resolveCommands,
  requiredOptionalPackages,
  // Convenience: the resolved allowlist at load time (env must be set first).
  get commands() {
    return resolveCommands();
  },
};
