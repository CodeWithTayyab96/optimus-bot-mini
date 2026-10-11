/**
 * Command Loader — walks commands/<category>/ folders and registers every
 * command module into a Map keyed by command name (plus aliases).
 *
 * Each command file must export:
 * {
 *     name: 'ping',
 *     aliases: ['p'],
 *     category: 'general',
 *     description: 'Check bot response time',
 *     usage: '.ping',
 *     ownerOnly: false,
 *     modOnly: false,
 *     groupOnly: false,
 *     privateOnly: false,
 *     adminOnly: false,
 *     botAdminNeeded: false,
 *     async execute(sock, message, args, extra) { ... }
 * }
 *
 * A file that throws at require() time is logged and skipped — one broken
 * command must never prevent the bot from booting.
 *
 * Loading is done in TWO passes so a command's own name always wins over
 * another command's alias:
 *
 *   pass 1  register every command under its primary `name`
 *   pass 2  register aliases that are still free
 *
 * Without this, an alias could claim a name that a real command declares, and
 * which command you got depended on the order files happened to be read in.
 * That is not hypothetical: `define.js` aliases 'dictionary', so it used to
 * shadow `dictionary.js` — a whole command file was unreachable and its `dict`
 * alias never registered. Category and file lists are sorted so the outcome is
 * identical on NTFS (name-sorted) and ext4 (hash-ordered).
 *
 * Allowlist support (Optimus Mini):
 *   loadCommands()                      → load every command (full edition)
 *   loadCommands({ allow: Set|Array })  → load only the named commands
 *
 * When process.env.OPTIMUS_MINI is set, the allowlist is read from
 * lib/miniProfile.js automatically. This matters for more than tidiness: a
 * command that is skipped is never require()d, so its dependencies (sharp,
 * ffmpeg, yt-search, cheerio, …) are never pulled into memory. That is the
 * mechanism that keeps the Mini process small.
 */

const fs = require('fs');
const path = require('path');

/** Stats from the most recent loadCommands() call (for banners/diagnostics). */
let lastStats = { loaded: 0, failed: 0, skipped: 0, duplicates: 0, total: 0, allowlisted: false };

/** Resolve the allowlist for this process, or null for "load everything". */
function resolveAllowlist(options) {
    if (options && options.allow) {
        return options.allow instanceof Set ? options.allow : new Set(options.allow);
    }
    if (process.env.OPTIMUS_MINI) {
        try {
            // Pure data module — safe to require, pulls no dependencies.
            return require('./miniProfile').resolveCommands();
        } catch (error) {
            console.error('❌ Mini profile unavailable, loading all commands:', error.message);
        }
    }
    return null;
}

function loadCommands(options = {}) {
    const commands = new Map();
    const commandsPath = path.join(__dirname, '..', 'commands');
    const allow = resolveAllowlist(options);

    if (!fs.existsSync(commandsPath)) {
        console.error('❌ Commands directory not found:', commandsPath);
        return commands;
    }

    let failed = 0;
    let skipped = 0;
    let duplicates = 0;
    let total = 0;

    // ── Collect candidates ─────────────────────────────────────────────────
    // Sorted so load order — and therefore which file wins a duplicate name —
    // is identical on every filesystem. readdirSync returns NTFS-sorted names on
    // Windows but arbitrary (hash) order on ext4, which would otherwise make the
    // command set host-dependent.
    const candidates = [];
    for (const category of fs.readdirSync(commandsPath).sort()) {
        const categoryPath = path.join(commandsPath, category);
        if (!fs.statSync(categoryPath).isDirectory()) continue;

        for (const file of fs.readdirSync(categoryPath).filter(f => f.endsWith('.js')).sort()) {
            total++;
            const filePath = path.join(categoryPath, file);
            try {
                // In Mini mode we must decide WITHOUT loading the module, because
                // require() is what pulls in the heavy dependency graph. Read only
                // the cheap `name:` literal from the file's source.
                if (allow && !allow.has(readDeclaredName(filePath))) {
                    skipped++;
                    continue;
                }

                const command = require(filePath);

                if (!command || typeof command.name !== 'string' || typeof command.execute !== 'function') {
                    console.warn(`⚠️ Skipping ${category}/${file}: missing name or execute`);
                    failed++;
                    continue;
                }

                // A module may declare a name that differs from the quick scan;
                // re-check so we never load something outside the allowlist.
                if (allow && !allow.has(command.name)) {
                    skipped++;
                    continue;
                }

                candidates.push({ category, file, command, registered: false });
            } catch (error) {
                console.error(`❌ Failed to load command ${category}/${file}: ${error.message}`);
                failed++;
            }
        }
    }

    // ── Pass 1: primary names. A command's own name always beats an alias. ──
    for (const c of candidates) {
        if (commands.has(c.command.name)) {
            console.warn(`⚠️ Duplicate command name '${c.command.name}' in ${c.category}/${c.file} — keeping first`);
            duplicates++;
            continue;
        }
        commands.set(c.command.name, c.command);
        c.registered = true;
    }

    // ── Pass 2: aliases, only where the name is still free. ─────────────────
    for (const c of candidates) {
        if (!c.registered) continue; // a file shadowed in pass 1 contributes nothing
        for (const alias of c.command.aliases || []) {
            if (commands.has(alias)) {
                console.warn(`⚠️ Alias '${alias}' in ${c.category}/${c.file} is already taken — skipping`);
                continue;
            }
            commands.set(alias, c.command);
        }
    }

    const loaded = candidates.reduce((n, c) => n + (c.registered ? 1 : 0), 0);

    const suffix = [
        failed ? `${failed} failed` : '',
        skipped ? `${skipped} not in Mini allowlist` : '',
        duplicates ? `${duplicates} shadowed by a duplicate name` : '',
    ].filter(Boolean).join(', ');
    console.log(`✅ Loaded ${loaded}/${total} command files${suffix ? ` (${suffix})` : ''}`);

    lastStats = { loaded, failed, skipped, duplicates, total, allowlisted: Boolean(allow) };
    return commands;
}

/** Stats from the most recent loadCommands() call. */
function getLastStats() {
    return { ...lastStats };
}

/**
 * Cheaply read the `name:` literal from a command file without executing it.
 *
 * Scans only `module.exports = { … }` blocks that also declare `execute` (the
 * command contract), so unrelated keys — `groupname:`, `filename: 'qr.png'`,
 * `name: 'yt-dlp (url)'` inside an options object, or a trailing
 * `module.exports.helper = …` — can never be mistaken for the command name.
 * Falls back to the filename stem when nothing is found.
 */
function readDeclaredName(filePath) {
    try {
        const src = fs.readFileSync(filePath, 'utf8');
        const NAME = /(?:^|[\s,{])name\s*:\s*['"]([^'"]+)['"]/;
        const blockRe = /module\.exports\s*=\s*\{/g;
        let m;
        let found = null;
        while ((m = blockRe.exec(src))) {
            const block = src.slice(m.index, m.index + 800);
            if (!/execute\s*[:(]/.test(block)) continue; // not the command object
            const n = block.match(NAME);
            if (n) found = n[1];
        }
        if (found) return found;
        const i = src.lastIndexOf('module.exports');
        const scope = i >= 0 ? src.slice(i) : src;
        const fallback = scope.match(NAME) || src.match(NAME);
        return fallback ? fallback[1] : path.basename(filePath, '.js');
    } catch {
        return path.basename(filePath, '.js');
    }
}

module.exports = { loadCommands, readDeclaredName, resolveAllowlist, getLastStats };
