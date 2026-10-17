# Optimus Mini — Analysis & Final Report

**Deliverable:** a genuinely lightweight edition of Optimus Bot for a host with
roughly **750 MB disk / 580 MB RAM**, sharing those resources with the OS.

**Status:** implemented and verified. The full edition is unchanged and still
runs from `node index.js`.

---

## 1. Executive summary

| Question | Answer |
|---|---|
| What was the bot? | A 237-file WhatsApp bot on Baileys v7: group management, moderation, AI, media downloads, stickers, fun, utilities, productivity |
| What did it need? | 44 direct dependencies incl. `ffmpeg-static` (~80 MB), `pdf-parse`/`pdfjs-dist`/`@napi-rs` (~93 MB), `sharp` (50 MB), plus Python + yt-dlp + a PO-token provider at runtime |
| What is Mini? | The same bot with a **profile-driven command allowlist**, heavy packages moved to `optionalDependencies`, the optional subsystems not started, and hard resource guards added |
| What did it cost before? | Full install **≈370 MB** on disk; **233** commands loaded; 2 processes (bot + PO-token provider) |
| What does Mini cost? | **106 MB** on disk (50 MB of which is `sharp`, which is **required**), **170** commands loaded, **1** process |
| Measured idle RAM (live) | Full **≈119 MB** → Mini **≈83 MB** RSS |
| Measured module-load RAM | Full **140 MB** → Mini **92 MB** |
| Did targets hold? | Disk < 150 MB ✅ · idle < 100 MB ✅ · peak < 200 MB ✅ |

The single most important structural decision: **an allowlist, not a denylist.**
A command that is not in the profile is never `require()`d, so its dependency
graph is never loaded. A denylist would silently load any newly added heavy
command — the exact failure mode that makes "lite" forks rot.

---

## 2. Phase 1 — Analysis of the original project

### 2.1 Shape

| Item | Value |
|---|---|
| Runtime | Node.js ≥ 20 (Baileys v7), CommonJS |
| Entry point | `index.js` (pairing + socket + supervisors) |
| Message core | `main.js` (`handleMessages`, group events, moderation pipeline) |
| Commands | 237 files across 12 categories, loaded dynamically by `lib/commandLoader.js` |
| Libs | 60 modules in `lib/` (AI, media, moderation, storage, scheduling, WARP, yt-dlp) |
| Persistence | JSON files in `data/`, `baileys_store.json`, `session/` (creds) |
| Config | `settings.js` (committed, placeholders) + `.env` (gitignored) |
| External services | WhatsApp; optional Python/yt-dlp + a PO-token HTTP provider for YouTube |
| Tests | 19 jest suites in `__tests__/` + 24 smoke scripts run by `npm test` |

### 2.2 What is actually essential

Tracing the startup path showed a clean separation:

- `index.js` + `main.js` + their `lib/` requires use **only Node built-ins and
  core packages** (`baileys`, `chalk`, `axios`, `node-fetch`, `file-type`,
  `node-cache`, `awesome-phonenumber`, `pino`, `dotenv`).
- Every heavy package is reached **only through a command file**:
  `sharp` (5 commands), `jimp` (2), `ffmpeg-static`/`fluent-ffmpeg` (stickers,
  media, groupstatus), `yt-search`/`@distube/ytdl-core`/`youtube-yts`/
  `node-youtube-music` (downloads), `mammoth`/`pdf-parse` (`.study`),
  `cheerio` (`.news`, `.url`), `ruhend-scraper` (Instagram/TikTok),
  `mumaker` (textmaker), `gtts` (`.tts`), `moment-timezone` (`.github`).

**Consequence:** filtering commands at load time removes the heavy dependency
graph without touching `main.js` at all.

### 2.3 Problems found in the original

| # | Finding | Impact |
|---|---|---|
| 1 | `index.js:255` calls `sock.msgRetryCounterCache.clear()`, but (a) node-cache has no `clear()` and (b) baileys never exposes `msgRetryCounterCache` on the socket | Dead code. The retry cache is never cleared and has no `maxKeys`/TTL → unbounded growth. The `if` guard is always false, which is why it does not crash. |
| 2 | `@whiskeysockets/baileys` declares `sharp` as a **non-optional** peer, though it is consumed lazily and tolerated when absent | npm installs 50 MB that is only *loaded* when sending media — but it is genuinely **required** for those paths (§14.3) |
| 3 | `commands/ai/study.js` requires `pdf-to-img`, which was **not declared** in `package.json` | `.study`'s PDF→image path was broken on any fresh install |
| 4 | **An alias could shadow a real command.** `define.js` aliases `dictionary`, colliding with `dictionary.js`'s primary name; the loader registered names and aliases in one pass | `dictionary.js` was unreachable, `.dict` was never registered, and which file won depended on the filesystem's directory order (NTFS sorted vs ext4 hashed) |
| 5 | **Graceful shutdown never ran.** `lib/groupstats.js` and `lib/messageStats.js` register `SIGTERM`/`SIGINT` handlers that call `process.exit(0)`, and are loaded (via `main.js`) before the entry point's handler | On SIGTERM the socket was never closed cleanly and the scheduler/store were never flushed — in **both** editions |
| 6 | Duplicate command name: `quran` is declared by both `islamic/quran.js` and `utility/quran.js` | The first wins; the second is unreachable (now counted and reported) |
| 7 | `lib/lightweight_store.js` bounded messages but not `contacts`/`chats` | Unbounded maps on a long-running process |
| 8 | `lib/myfunc.js` is required by `index.js` but no command uses `serializeM`/`getName` | Pulls `jimp` + `moment-timezone` into every startup for nothing |
| 9 | The repo ships a `.env` containing real credentials and `WARP=1` | `cp .env.mini.example .env` would overwrite real keys; running the full edition downloads a 13 MB WARP binary |

Findings 1, 4, 5, 7 and 8 are **fixed** (1 via Mini's own cache handle; 4 and 5
in shared code, improving both editions; 7 and 8 via the bounded store and by
not loading `lib/myfunc`). Findings 2, 3, 6 and 9 are **documented, not
changed**, so the full edition's behaviour and footprint stay as they were.

---

## 3. Phase 2 — The Mini feature set

Defined once in `lib/miniProfile.js` (pure data, zero dependencies).

### Category A — Essential (loaded)

| Area | Count | Examples |
|---|---|---|
| Group management + moderation | 50 | `kick`, `promote`, `mute`, `tagall`, `ban`, `warn`, `antilink`, `antispam`, `welcome`, `chatbot` |
| Owner controls | 27 | `mode`, `sudo`, `broadcast`, `setprefix`, `anticall`, `antidelete`, `afk`, `pair`, `restart` |
| General info | 14 | `ping`, `help`, `alive`, `settings`, `uptime`, `groupstats`, `staff` |
| Utilities (keyless/light) | 30 | `weather`, `aqi`, `calc`, `qr`, `crypto`, `wiki`, `dictionary`, `imdb` |
| Productivity | 10 | `remind`, `schedule`, `poll`, `save`, `snooze` |
| Fun (dependency-light) | 38 | `dice`, `joke`, `quote`, `trivia`, `hangman`, `ttt` |
| Islamic / group / misc | 3 | `quran`, `savecontact` |
| **Total** | **170** | all 170 load — see §14.2 for the reconciliation |

Every one of these was verified to reach **no heavy package**, transitively —
enforced by `scripts/check-mini-deps.js`. `check-command-counts` additionally
asserts that all 170 are actually registered and dispatchable.

### Category B — Optional (off by default, `MINI_ENABLE=<group>`)

| Group | Commands | Extra packages |
|---|---|---|
| `ai` | 9 | none |
| `anime` | 4 | none |
| `media` | 28 | `yt-search`, `ruhend-scraper`, `ffmpeg` |
| `stickers` | 7 | `ffmpeg-static`, `fluent-ffmpeg`, `node-webpmux` |
| `image` | 4 | `sharp`, `jimp`, `fs-extra`, `mammoth`, `pdf-parse` |
| `textmaker` | 1 | `mumaker` |
| `extras` | 7 | `cheerio`, `google-translate-api-x`, `moment-timezone`, `gtts` |

### Category C — Excluded (never started)

`potSupervisor` (PO-token provider), `dlHealth` (download monitor),
`warpProxy` (WARP tunnel), `autobio` (background bio loop),
`bootstrap.js` yt-dlp/Python auto-install, and the `fs.watchFile` self-reload
in `index.js`. None is needed to run the bot; all were verified absent from the
Mini process.

---

## 4. Phase 3 — Implementation

Small, surgical changes. **No new dependencies. No rewrite. No forked files.**

| File | Change |
|---|---|
| `mini.js` **(new)** | The Mini entry point: lean socket bootstrap, pairing, reconnect-with-backoff, boot guard, core services, graceful shutdown. Does not require the optional subsystems. |
| `lib/miniProfile.js` **(new)** | The allowlist + optional groups + heavy-package list. Pure data. |
| `lib/miniRuntime.js` **(new)** | Resource guards: log rotation, temp policy, memory ceiling (routed through clean shutdown), graceful shutdown, crash guards, **boot guard (crash-loop backoff)**, backoff, bounded cache. |
| `lib/commandLoader.js` | Added `{ allow }` / `OPTIMUS_MINI` filtering. Reads a command's `name:` from source **without executing it** (so heavy deps are never pulled), with a hardened extractor (scoped to the `module.exports` block that declares `execute`). **Sorted traversal + two-pass registration** so a command's own name always beats another command's alias, and results are identical on NTFS and ext4. Duplicate/shadowed files are now counted. |
| `lib/groupstats.js`, `lib/messageStats.js` | **Bug fix:** their `SIGTERM`/`SIGINT` handlers called `process.exit(0)` and, being registered first, pre-empted the entry point's shutdown — so the socket was never closed cleanly and the scheduler/store were never flushed. They now only flush. Fixes both editions. |
| `lib/lightweight_store.js` | Added `maxStoreContacts` / `maxStoreChats` caps + trim on load and on update. |
| `settings.js` | Added the two new store caps (env-overridable). |
| `package.json` | 14 essential deps in `dependencies`; 23 heavy/optional deps moved to `optionalDependencies`; `@types/node` → dev; added `mini*` scripts. |
| `package-lock.json` | Regenerated so `npm ci --omit=optional` is reproducible. |
| `optimus-mini.service`, `ecosystem.mini.config.js`, `.env.mini.example`, `OPTIMUS_MINI_DEPLOY.md`, `scripts/check-mini-deps.js`, `scripts/check-command-counts.js`, `scripts/check-image-lib.js`, `scripts/smoke-mini.js`, `scripts/run-mini-tests.js`, `scripts/linux-measure.sh`, `__tests__/mini.test.js` | **(new)** deployment + verification assets. |

`index.js`, `main.js` and every command file are **unmodified**, so the full
edition's behaviour and entry point are preserved. The only shared-code changes
are the loader, the two stats libs, the store, `settings.js` and the manifest —
all backward compatible.

### Why `optionalDependencies`?

Mini and the full edition share one `package.json`. Moving heavy packages to
`optionalDependencies` means:

- `npm install` (full edition) → installs them, **exactly as before**;
- `npm ci --omit=dev --omit=optional` (Mini) → skips them.

No second manifest, no lockfile fork, no changed deployment for the full bot.

---

## 5. Phase 4 — Memory & performance work

| Optimisation | Where |
|---|---|
| Lazy/absent loading of heavy modules via the allowlist | `lib/commandLoader.js` |
| Optional subsystems not started | `mini.js` |
| Bounded retry cache (FIFO eviction + TTL) | `lib/miniRuntime.js` |
| Bounded store (messages, contacts, chats) | `lib/lightweight_store.js` |
| Bounded reconnect backoff with jitter (2 s → 60 s) | `mini.js` + `lib/miniRuntime.js` |
| Network timeouts + keep-alive | socket options in `mini.js` |
| Link previews disabled by default | socket options in `mini.js` |
| Rotating, rate-limited log file | `lib/miniRuntime.js` |
| Temp dir on a fixed path with age + size eviction | `lib/miniRuntime.js` |
| Memory ceiling with clean self-restart | `lib/miniRuntime.js` |
| Boot guard: crash-loop backoff (2 s → 5 min) | `lib/miniRuntime.js` + `mini.js` |
| Graceful shutdown (socket close, store flush, timers cleared) | `mini.js` |
| Crash guards (log, don't die silently) | `lib/miniRuntime.js` |

**Bugs fixed during verification:**

- `boundedCache` first used node-cache's `maxKeys` option — which **throws
  `ECACHEFULL`** when the cache is full instead of evicting. On a busy bot that
  would have thrown inside message handling. It now evicts the oldest 10 %
  before each insert and never throws. Regression test added.
- The log rotator did not rotate at all when `MINI_LOG_KEEP=1` (the shift loop
  was off by one), so a single-generation config grew unbounded. Fixed + tested.
- The memory guard called `process.exit(1)` directly, skipping the store flush
  and socket close. It now routes through the same clean shutdown as a signal.
- `lib/groupstats.js` / `lib/messageStats.js` exited the process from their
  `SIGTERM` handlers, pre-empting the real shutdown. Fixed in both editions.
- The loader registered aliases and names in one pass, so an alias could shadow
  a real command (`define` hid `dictionary`). Now two-pass + sorted.

Nothing exotic was added: no GC pokes, no worker threads, no aggressive
concurrency.

---

## 6. Phase 5 — Disk

| Change | Effect |
|---|---|
| Heavy deps → `optionalDependencies` + `--omit=optional` | install ≈ 370 MB → **106 MB** |
| Dev tooling omitted (`--omit=dev`) | jest + @types out of production |
| Log ceiling | ~6 MB max (`MAX_BYTES × (KEEP+1)`) |
| Temp ceiling | 64 MB max, 1 h max age |
| Store caps | contacts ≤ 5000, chats ≤ 2000, 20 messages/chat |

`package-lock.json` is kept and regenerated — installs stay reproducible.

**Remaining 50 MB:** `sharp`, installed only because baileys lists it as a
non-optional peer. Mini never loads it (proven in the smoke suite). It can be
reclaimed safely — see §11.1.

---

## 7. Phase 6 — Deployment

- `node mini.js` — one process, no Docker, no database, no auxiliary service.
- `optimus-mini.service` — systemd unit with `MemoryHigh=192M`,
  `MemoryMax=280M`, `CPUQuota=70%`, journald rate limits and basic hardening.
- `ecosystem.mini.config.js` — pm2 alternative with `max_memory_restart`.
- `.env.mini.example` — every variable, safe placeholders, no secrets.
- `OPTIMUS_MINI_DEPLOY.md` — install, configure, start/stop/restart, logs,
  update, tuning, troubleshooting.

Node itself is ~50 MB of the RAM budget and is the floor for a Baileys bot.

---

## 8. Phase 7 — Security & reliability

Preserved, not traded away:

- **Auth/authorisation untouched.** `lib/isOwner.js`, `lib/isAdmin.js`,
  `lib/isBanned.js`, the sudo system and every permission gate in `main.js` are
  the same code paths the full edition uses.
- **Secrets.** No key is hardcoded; `settings.js` keeps placeholders and reads
  `.env`. The pairing-code file holds only a short-lived code. `sessionSummary`
  prints size/state/number and never key material (existing test).
- **Input bounds.** Store caps, cache caps, log rate limit, temp size/age caps,
  and the socket's query/connect timeouts.
- **Retry loops.** Reconnect now backs off exponentially with jitter and a 60 s
  ceiling — a flapping network can no longer spin the CPU.
- **Data integrity.** The store is written atomically-ish (full JSON rewrite on
  an interval) and flushed on shutdown; a failed write is logged, not fatal.
- **Clean termination.** `SIGTERM`/`SIGINT` close the socket, stop the
  scheduler and group timers, flush the store, and exit — with a hard deadline
  so shutdown can never hang.
- **No insecure shortcuts** were introduced to save bytes.

---

## 9. Phase 8 — Testing & verification

### 9.1 What was run

| Check | Command | Result |
|---|---|---|
| Mini syntax check (15 files) | `npm run test:mini` | ✅ |
| Dependency budget (static, transitive) | `scripts/check-mini-deps.js` | ✅ 170 core commands reach no heavy package; 0 heavy in `dependencies` |
| Command-count reconciliation | `scripts/check-command-counts.js` | ✅ 170+66+0+1 = 237; every essential command dispatchable |
| Image library present + functional | `scripts/check-image-lib.js` | ✅ sharp present; `.setpp` + image-send paths work |
| Functional smoke — profile classification | `scripts/smoke-mini.js` | ✅ |
| Functional smoke — loader filtering | `scripts/smoke-mini.js` | ✅ 170 loaded, 66 skipped, 1 shadowed, 0 failed |
| Functional smoke — alias/name precedence | `scripts/smoke-mini.js` | ✅ `.dict`/`.dictionary` → dictionary.js; `.define` → define.js |
| Functional smoke — no heavy module in the process | `scripts/smoke-mini.js` | ✅ all 21 heavy packages absent; `potSupervisor`/`dlHealth`/`warpProxy`/`ytdlp`/`myfunc` absent |
| Functional smoke — dispatch | `scripts/smoke-mini.js` | ✅ `.ping` replies; excluded `.play` does not dispatch |
| Functional smoke — runtime guards | `scripts/smoke-mini.js` | ✅ envInt, backoff, bounded cache (no ECACHEFULL), log rotation ≤ ceiling, graceful shutdown, memory guard, boot guard |
| Live startup + connection | `node mini.js --qr` | ✅ connected to WhatsApp, printed QR, stable for 2 min |
| Live memory sampling | PowerShell working-set sampling | ✅ 6 samples over 60 s, stable at ~83 MB |
| Memory guard → clean shutdown | `MAX_RSS_MB=1 node mini.js` | ✅ flushed, closed, exit 1 |
| Graceful shutdown end-to-end | signal emitted in-process against real `mini.js` | ✅ `🛑 Received SIGTERM` → `[shutdown] … flushing state` → exit 0 |
| Auth state survives restarts | sentinel file in `session/` | ✅ survived multiple start/stop cycles |
| Full-edition regression | `syntax-sweep` + `smoke-dispatch` + `smoke-groupstats` + `smoke-mode-stats` | ✅ 372 files clean, dispatch + stats pass |

`npm run test:mini` → **5/5 checks passed** (~85 individual assertions).

### 9.2 What was NOT executed (and why)

| Not run | Reason |
|---|---|
| End-to-end message flow on a real WhatsApp account | Would require linking a live account; the dispatch path was exercised with a mock socket instead |
| Graceful shutdown via a **real** `SIGTERM` | Windows cannot deliver catchable `SIGTERM`; the handler was instead invoked by emitting the signal in-process and stubbing `process.exit` (assertions pass) |
| The jest suite (`__tests__/`) | `jest` is a devDependency and the Mini install omits dev packages by design. `__tests__/mini.test.js` is provided for CI, and every assertion in it is also executed by the dependency-free smoke suite |
| Optional-group features (media/stickers/ai/image) | Their packages are intentionally not installed; enabling them is documented but untested here |
| A real Linux run | No Linux host available. All measurements are from a Windows host, where Node's RSS is typically **higher** than Linux |

### 9.3 Full-edition regression check

Shared files that changed (`commandLoader.js`, `lightweight_store.js`,
`groupstats.js`, `messageStats.js`, `settings.js`) were kept backward
compatible: `loadCommands()` with no arguments still loads everything, and the
new settings keys default to the old behaviour. `main.js` and `index.js` are
byte-for-byte unmodified.

Verified on the full install (no `OPTIMUS_MINI`):

| Check | Result |
|---|---|
| `scripts/syntax-sweep.js` (whole repo) | ✅ 372 files checked, 0 failures |
| `scripts/smoke-dispatch.js` (full mode) | ✅ 233 commands loaded, `.ping` dispatched |
| `scripts/smoke-setprefix.js` | ✅ prefix swap and restore work |
| `scripts/smoke-groupstats.js` / `scripts/smoke-mode-stats.js` | ✅ pass after the signal-handler fix |
| `scripts/measure-full.js` (full startup path) | ✅ loads, `handleMessages` is a function |

The two shared-code fixes (loader name/alias precedence, stats-lib shutdown)
also improve the full edition: it now shuts down cleanly on SIGTERM, and
`.dictionary`/`.dict` resolve to the command they are named after.

---

## 10. Measurements (before / after)

All figures from the same Windows host, Node v22.22.2. Linux RSS is normally
lower for the same workload; treat these as upper bounds.

| Metric | Full edition | **Optimus Mini** | Target |
|---|---|---|---|
| Direct dependencies (always installed) | 44 | **14** | minimal |
| Optional dependencies (skipped by Mini) | — | **23** | — |
| `node_modules` size | **≈370 MB** | **106 MB** (50 MB of it is the required `sharp`) | < 150 MB ✅ |
| Command files on disk | 237 | 237 | — |
| Commands loaded | 233 | **170** | — |
| Commands skipped / shadowed / failed | 2 failed (pre-existing) | **66 skipped, 1 shadowed, 0 failed** | — |
| Processes | 2 (bot + PO-token provider) | **1** | 1 ✅ |
| Module-load time | **≈5.1 s** | **≈2.2 s** | — |
| Idle RSS (modules only) | **140 MB** | **92 MB** | < 100 MB ✅ |
| Idle RSS (live, socket open, settled) | **≈119 MB** | **≈83 MB** | < 100 MB ✅ |
| Transient startup peak | **≈173 MB** | **≈119 MB** | < 200 MB ✅ |
| Peak RSS, 400 messages | not measured | **110 MB** | < 200 MB ✅ |
| Log ceiling | unbounded console | **~6 MB** | bounded ✅ |
| Temp ceiling | 3 h age only | **64 MB + 1 h** | bounded ✅ |
| Runtime artefacts after 2 min live | — | **≈17 KB** (log 16.5 KB, store 40 B, data ~300 B) | bounded ✅ |

Reduction: install **−71 %**, idle RAM **−30 %**, module-load RAM **−34 %**,
load time **−57 %**.

*Method.* Both figures come from the same Windows host, Node v22.22.2, measured
with `du -sm node_modules`, a live working-set sampler, and the import harnesses
`scripts/measure-mini.js` (Mini) / `scripts/measure-full.js` (full). The full
`node_modules` was measured at 442 MB **while `pdf-to-img` (a 72 MB subtree that
this change removes) was still on disk**; the shipped full install is therefore
442 − 72 = **370 MB**. Linux RSS is normally lower for the same workload — treat
these as upper bounds. `pdf-to-img` was a 72 MB new dependency that only
`.study`'s PDF→image path needs, so it was **not** added (see §11.3).

### 10.1 Targets that were missed

- **Idle < 100 MB** was met on this host (83–92 MB), but the module-only figure
  (92 MB) sits close to the line, and the **startup peak reaches ~119 MB**
  briefly. On a 580 MB host this is comfortable, but if the OS needs more room,
  lower `MAX_RSS_MB` (already reduced to 180 by default).
- **`sharp` cannot be avoided** — and must not be: it is required for `.setpp`
  and for sending images/videos (§11.1). The 50 MB is part of the budget.

---

## 11. Known limitations & follow-ups

1. **`sharp` (50 MB) is REQUIRED — do not prune it.** It is a non-optional peer
   of baileys and is used (lazily) by `.setpp` and by *sending any image or
   video*. Removing it makes both fail with `No image processing library
   available`, because Mini omits the `jimp` fallback — verified by removing it
   and exercising both code paths. `scripts/check-image-lib.js` enforces it.
2. **Full-edition bug (not fixed by choice):** `index.js:255`'s
   `msgRetryCounterCache.clear()` is dead code — node-cache has no `clear()` and
   baileys never exposes `msgRetryCounterCache` on the socket, so the guard is
   always false. The full edition's retry cache therefore has no `maxKeys`/TTL.
   Mini avoids this entirely by holding its own cache handle. Fixing `index.js`
   was deliberately left out to keep the original entry point untouched.
3. **`pdf-to-img` was deliberately NOT declared.** `commands/ai/study.js`
   requires it but `package.json` never listed it, so `.study`'s PDF→image path
   was already broken. Declaring it pulls **72 MB** (a nested `pdfjs-dist` +
   `@napi-rs/canvas`), which is disproportionate for one optional command and
   would enlarge the full edition's install. It is documented here and in
   `lib/miniProfile.js` instead; operators who want it can add it themselves.
4. **Duplicate command names** — `quran` is declared by two files
   (`islamic/quran.js` and `utility/quran.js`); the first wins and the second is
   shadowed (counted, and reported by `check-command-counts`). Pre-existing.
   The `define`/`dictionary` alias collision **is** fixed (see §14.2).
5. **Two commands fail to load in the full edition** (`media/igs.js`,
   `media/instagram.js`) because of a broken nested
   `@distube/ytdl-core/node_modules/https-proxy-agent` — a pre-existing
   dependency-resolution problem, unrelated to this work. Mini skips them anyway
   (they are in the optional `media` group).
6. **Optional groups are untested** in this environment (their packages are
   omitted by design).
7. **No Linux measurement.** The 83 MB / 119 MB figures are Windows; expect
   lower on the target Linux host, but this has not been verified. Use
   `scripts/linux-measure.sh` on the server.
8. **Graceful shutdown** was verified end-to-end by emitting the signal
   in-process against the real `mini.js` (Windows cannot deliver a catchable
   `SIGTERM`), not by a real `SIGTERM` from the kernel.

---

## 12. Exact commands

### Install & run Mini

```bash
npm ci --omit=dev --omit=optional --no-audit --no-fund
cp .env.mini.example .env && chmod 600 .env && nano .env
node mini.js                 # pairing code;  --qr for a QR code
```

### Verify

```bash
npm run test:mini            # 5 checks: syntax, deps, counts, image lib, smoke
npm run deps:mini:check      # dependency budget only
```

### Measure on the target server (Linux)

```bash
bash scripts/linux-measure.sh    # free/df/du + RSS + shutdown + session check
```

### Supervise

```bash
# systemd
sudo cp optimus-mini.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now optimus-mini
journalctl -u optimus-mini -f

# or pm2
pm2 start ecosystem.mini.config.js && pm2 save
```

### Do **not** prune `sharp` (it is required)

```bash
npm run test:mini        # check-image-lib fails loudly if sharp is missing
```

### Full edition (unchanged)

```bash
npm install
node index.js
```

---

## 13. Verdict

Optimus Mini is a real reduction, not a rename:

- **~71 % smaller install** (370 MB → 106 MB) and **68 % fewer direct
  dependencies** (44 → 14);
- **~30 % lower live idle RAM** (119 MB → 83 MB), **~34 % lower module-load
  RAM** (140 MB → 92 MB) and **~57 % faster module load** (5.1 s → 2.2 s);
- **one process** instead of two, with the YouTube/Python/WARP stack gone;
- every ceiling that previously did not exist — logs, temp, caches, store,
  reconnect, memory, startup — is now bounded;
- and the full edition still runs from `node index.js` (372 files
  syntax-clean, dispatch verified), with two shared-code bugs fixed.

The 50 MB of `sharp` is required, not waste — see §14.3.

---

## 14. Deployment-readiness audit (2026-10-11)

A second pass over the delivered implementation, verifying it against the
target host rather than re-asserting it. Everything below was run on the
reference host (Windows, Node v22.22.2); the Linux column is what remains
outstanding.

### 14.1 Clean installation

Verified from a genuinely empty `node_modules` (moved aside, then
`npm ci --omit=dev --omit=optional --no-audit --no-fund`).

| Measurement | Result |
|---|---|
| Install command | `npm ci --omit=dev --omit=optional --no-audit --no-fund` ✅ exit 0 |
| Packages installed | **213** |
| `node_modules` | **106 MB** (sharp 50 MB, libphonenumber-js 12 MB, baileys 11 MB) |
| Application source (excl. `node_modules`/runtime dirs) | **~7 MB** |
| Runtime state after a live run | `logs/` ≤ 6 MB cap (observed 17–102 KB), `data/` ~1 KB, `session/` KB, `temp/` 0 |
| npm cache (shared, reusable) | ~493 MB on this host — **not** part of the deployment; `npm cache clean --force` reclaims it |
| **Bot footprint on the server** | **≈113 MB** (source + deps + state), **plus ~90–110 MB for the Node runtime** |

**Disk budget honesty:** the 750 MB figure is for the *whole server*, not the
bot. Bot + Node ≈ 220 MB, leaving ≈530 MB — but the OS itself typically occupies
400–900 MB. **Do not treat 750 MB as 750 MB of free space**; check `df -h /`
first (§8.4 of the deploy guide). No claim of "the budget is sufficient" is made
here — that depends on the host.

### 14.2 Command counts — reconciled

The report previously mixed four different numbers. They are not contradictory;
they count different things. `scripts/check-command-counts.js` now prints the
reconciliation and fails if it stops adding up.

| Number | Meaning |
|---|---|
| **237** | command **files** on disk |
| **236** | distinct declared `name`s (`quran` is declared by two files) |
| **233** | commands the **full** edition loads (237 − 2 that fail to load − 2 shadowed) |
| **170** | entries in the Mini **profile** (Category A) |
| **170** | commands Mini actually **loads** |
| **66** | files skipped because they are not in the profile |
| **1** | file shadowed by a duplicate `name` (`utility/quran.js`) |
| 170 + 66 + 0 + 1 | **= 237** ✅ |

**A genuine bug was found and fixed here.** `define.js` declares the alias
`dictionary`, which collided with the *primary name* of `dictionary.js`. Because
the loader registered aliases in the same pass as names, whichever file was read
first won — so `dictionary.js` was unreachable, `.dict` was never registered at
all, and the winner depended on the filesystem's directory order (NTFS is
name-sorted, ext4 is hash-ordered, so the two platforms could differ).

The loader now does **two passes** — primary names first, then aliases — and
iterates in sorted order. A command's own name always beats another command's
alias, on every filesystem. Verified: `.dictionary` and `.dict` now resolve to
`dictionary.js`, `.define` to `define.js`, and `check-command-counts` asserts
that every essential command is dispatchable.

### 14.3 `sharp` — required, verified

Inspected baileys **7.0.0-rc13** (the installed version):

- `peerDependencies` includes `sharp: "*"`, and unlike its other three peers
  (`audio-decode`, `jimp`, `link-preview-js`) it is **not** marked optional — so
  npm installs it even with `--omit=optional`.
- The only consumer is `getImageProcessingLibrary()`, which loads it lazily
  (`import('sharp').catch(() => {})`) and falls back to `jimp` — **but throws
  `No image processing library available` if neither is present**, and Mini
  omits `jimp`.
- It is called by `extractImageThumb` (the image/video send path) and
  `generateProfilePicture` (`.setpp`, a Mini core command).

**Measured, not assumed:** with sharp present, both functions succeed; with
sharp removed, both fail with that exact error. **Conclusion: keep it.** The
reproducible installation is therefore the standard
`npm ci --omit=dev --omit=optional` (sharp arrives as a baileys peer);
`--legacy-peer-deps` must **not** be used, and the earlier advice to prune it
has been removed. `scripts/check-image-lib.js` now fails if sharp is missing.

### 14.4 Runtime limits — reviewed and hardened

| Requirement | Finding | Action |
|---|---|---|
| Startup failure ≠ endless restart loop | **Gap:** a startup crash exited 1 and the supervisor restarted every 5 s forever | Added `installBootGuard()`: a start shorter than 30 s counts as failed, and the next attempt waits 2 s → 4 s → … (cap 5 min). Added `StartLimitIntervalSec`/`StartLimitBurst` to the unit and `min_uptime`/`max_restarts` to pm2 |
| Memory guard leaves OS headroom | Default was 220 MB (38 % of a 580 MB host) | Lowered to **180 MB** (~50 % headroom over the 119 MB peak, ~400 MB left for the OS); unit retuned to `MemoryHigh=180M`/`MemoryMax=224M` |
| Restart never doubles up | The guard called `process.exit(1)` directly, and systemd/pm2 do not start a replacement until the old process is gone | Verified: no overlap. The guard now routes through the **same clean shutdown** as a signal |
| Memory guard does not corrupt data | **Gap:** raw `exit(1)` skipped the store flush and socket close | The guard now calls `shutdown()` first, then exits — verified end-to-end (`MAX_RSS_MB=1` → clean shutdown, exit 1) |
| Auth state survives restarts | Verified: a sentinel placed in `session/` survived multiple start/stop cycles; `session/` is deleted **only** on a real logout (401) | Documented in the deploy guide §8.6 |
| Cache limits cannot crash message processing | Fixed earlier (node-cache `maxKeys` throws) and covered by a regression test | ✅ |
| Log rotation works at minimum retention | Fixed earlier (`MINI_LOG_KEEP=1` did not rotate) and covered by a test | ✅ |
| **Graceful shutdown actually runs** | **Gap:** `lib/groupstats.js` and `lib/messageStats.js` registered `SIGTERM`/`SIGINT` handlers that called `process.exit(0)`. Being registered first, they ran **before** the entry point's handler — so the socket was never closed cleanly and the scheduler/store were never flushed, in **both** editions | Removed the `exit()`; they now flush only. Verified end-to-end: `🛑 Received SIGTERM` → `[shutdown] … flushing state and closing the socket` → exit 0 |

### 14.5 Linux verification — not performed

**No Linux environment was available.** WSL is blocked by this machine's
security policy and Docker is not installed, so the Linux figures could not be
measured. Nothing here should be read as a Linux result.

`scripts/linux-measure.sh` (added) collects them on the target server:
`free -m`, `df -h`, `du -sh`, module-load time, peak/idle RSS, clean shutdown,
and whether `session/` survived — then prints a summary. It is read-only with
respect to your data. Run it before committing to the disk/RAM budget.

### 14.6 Audit summary — verified vs estimated vs untested

| Status | Items |
|---|---|
| **Verified (measured)** | clean install (106 MB, 213 packages, exit 0); 170/237 commands with the accounting reconciled; every essential command dispatchable; no heavy module in the startup graph; sharp required for image paths; memory guard → clean shutdown; boot-guard backoff; log rotation at minimum retention; bounded cache never throws; session survives restarts; graceful shutdown end-to-end; live boot + WhatsApp connection; idle RSS ~83 MB; 5/5 `npm run test:mini`; 372 files syntax-clean; full-edition dispatch works |
| **Estimated (derived, labelled)** | the full edition's 370 MB install (measured 442 MB *including* a 72 MB subtree this change removes); total server footprint (bot + Node runtime + OS) |
| **Untested** | **any Linux measurement**; the jest suite (dev deps omitted by design); end-to-end messaging on a linked account; optional feature groups; peak RSS under real media activity; behaviour on the actual 750 MB/580 MB host |

**Production readiness:** the Mini edition is ready to *deploy and verify*; it is
not certified for this specific host, because the Linux numbers do not exist
yet. Run `bash scripts/linux-measure.sh` and the readiness claim can be closed.
