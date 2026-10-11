# Optimus Mini — Deployment Guide

A lightweight edition of Optimus Bot for a severely resource-constrained host
(the design target is **≈750 MB disk / ≈580 MB RAM**, shared with the OS).

Optimus Mini reuses the full edition's proven core — `main.js` (message
handling), `lib/`, and the lightweight commands — but:

- loads **only** the commands in `lib/miniProfile.js`, so a heavy dependency
  (`sharp`, `ffmpeg`, `yt-search`, `cheerio`, …) is never even `require()`d;
- does **not** start the optional subsystems (YouTube PO-token provider,
  download-health monitor, WARP tunnel, auto-bio, yt-dlp bootstrap);
- applies hard resource guards: a rotating, size-capped log, a temp/disk policy,
  a memory ceiling, bounded caches, bounded reconnect backoff, and clean
  shutdown.

The full edition is untouched — `node index.js` behaves exactly as before.

> **Measured on the reference build** (Node 22, Windows host — Linux is
> typically lower): install **106 MB**, idle RSS **≈83 MB**, startup/connection
> peak **≈119 MB**, **170** commands loaded, runtime artefacts **< 20 KB**.
> See `OPTIMUS_MINI_REPORT.md` for the full before/after table and caveats.
>
> **Not measured on Linux.** No Linux host was available during development, so
> the figures above are Windows. Run `bash scripts/linux-measure.sh` on the
> target server to collect the real numbers before committing to a disk/RAM
> budget — see §9.

---

## 1. Host requirements

| Requirement | Notes |
|---|---|
| **Linux** (any small VPS/container) | No Docker, no database, no extra services |
| **Node.js ≥ 18** (22 LTS recommended) | the runtime itself needs ~90–110 MB of disk and ~50 MB of RAM |
| **~130 MB free disk for the bot** | install (~106 MB, incl. the required `sharp`) + bounded logs/session |
| **~250 MB available RAM** | measured ~83 MB idle, ~119 MB peak, plus headroom |
| **Outbound HTTPS** | to WhatsApp + the APIs your commands use |
| **A WhatsApp number** for the bot | pairing code or QR |

Nothing else. Mini needs **no** Python, **no** ffmpeg, **no** yt-dlp, **no**
Redis and **no** database.

---

## 2. Install

```bash
# 1. Get the code onto the host (git clone, scp, rsync, …)
git clone https://github.com/CodeWithTayyab96/Optimus-Bot.git optimus-mini
cd optimus-mini

# 2. Install ONLY the essential production dependencies.
#    --omit=dev      skips jest / @types
#    --omit=optional skips every heavy, optional package
npm ci --omit=dev --omit=optional --no-audit --no-fund
```

`npm run install:mini` is the same command.

> ### ⚠️ Do NOT prune `sharp`
> `@whiskeysockets/baileys` declares `sharp` as a **non-optional peer
> dependency**, so npm installs it (~50 MB) even with `--omit=optional`. That is
> deliberate and **required**:
>
> - `.setpp` → baileys `generateProfilePicture`
> - **sending any image or video** → baileys `extractImageThumb`
>
> Both throw `No image processing library available` when neither `sharp` nor
> `jimp` is present — and Mini omits `jimp`. Verified by removing it: both
> operations failed immediately.
>
> Do **not** use `--legacy-peer-deps` (it drops sharp) and do **not** delete
> `node_modules/sharp`. `npm run test:mini` fails loudly if it is missing.
>
> Budget the 50 MB. It is the price of sending pictures on Baileys v7.

---

## 3. Configure

> ### ⚠️ Check whether `.env` already exists first
> This project is distributed **with a `.env` file already present**, containing
> real credentials and `WARP=1`. It is gitignored, but it is in the archive.
> `cp .env.mini.example .env` would **overwrite it and destroy those keys**.
>
> ```bash
> ls -l .env 2>/dev/null && cp -n .env .env.backup-$(date +%F)   # back it up first
> ```
>
> Then either edit the existing `.env`, or copy the template only if none exists:
>
> ```bash
> [ -f .env ] || cp .env.mini.example .env
> chmod 600 .env
> nano .env
> ```
>
> Mini ignores `WARP=1` (the WARP tunnel is not started), but leaving a stale
> `WARP=1` in the file is harmless — only the full edition acts on it. If you
> also run the full edition, be aware that `WARP=1` makes it download a ~13 MB
> `usque` binary into `.warp/` on first start.

Edit the bot identity in `settings.js` (committed, placeholders only):

| Setting | Meaning |
|---|---|
| `ownerNumber` | **who commands** the bot (your personal number) |
| `botNumber` | **the account the bot runs on** — used for pairing |
| `prefix` | command prefix (default `.`) |

Numbers are country code + number, no `+`, no spaces (e.g. `923001234567`).
`ownerNumber` and `botNumber` are usually **different accounts** — pairing with
the wrong one links the wrong WhatsApp account.

**Secrets never go in `settings.js`** (it is committed to git). Put API keys in
`.env` only. `.env` is gitignored.

---

## 4. First run (link the bot)

```bash
node mini.js
```

- **Pairing code (default).** The bot prints a code; enter it in WhatsApp →
  *Settings → Linked Devices → Link a Device → "Link with phone number instead"*.
  The code is also written to `data/pairing-code.txt` (deleted once linked).
- **QR instead:** `node mini.js --qr`

A pairing code is single-use, and each new request invalidates the previous one.
The bot deliberately does **not** re-request a code on reconnect — enter the one
printed, or restart to get a fresh one.

Once linked, the session lives in `session/`. **Back it up** (see §9) so you
never have to re-pair.

---

## 5. Keep it running

### 5.1 systemd (recommended)

```bash
sudo cp optimus-mini.service /etc/systemd/system/optimus-mini.service
sudo nano /etc/systemd/system/optimus-mini.service   # set User / WorkingDirectory / ExecStart
sudo systemctl daemon-reload
sudo systemctl enable --now optimus-mini
```

The unit ships with the limits that protect a 580 MB host: `MemoryHigh=192M`,
`MemoryMax=280M`, `CPUQuota=70%`, and journald rate limits. Keep `MAX_RSS_MB`
in `.env` slightly **below** `MemoryMax` so the bot restarts itself before
systemd has to OOM-kill it.

Everyday commands:

```bash
systemctl status optimus-mini
sudo systemctl restart optimus-mini
sudo systemctl stop optimus-mini
journalctl -u optimus-mini -f            # live logs
journalctl -u optimus-mini --since today # today's logs
```

### 5.2 pm2 (alternative)

```bash
npm install -g pm2
pm2 start ecosystem.mini.config.js
pm2 save && pm2 startup                  # run the command pm2 prints
pm2 logs optimus-mini
pm2 restart optimus-mini
```

### 5.3 No supervisor (last resort)

```bash
nohup node mini.js >> logs/mini.log 2>&1 &
```

Works, but you lose automatic restart. Prefer systemd.

> Mini runs **one** process. There is no separate provider, worker or web
> server to supervise.

---

## 6. Optional feature groups (off by default)

Mini ships the essentials (group management, moderation, owner controls, basic
info, keyless utilities, productivity). Everything else is opt-in and grouped:

| Group | What | Extra packages needed |
|---|---|---|
| `ai` | text AI commands (`.gpt`, `.summarize`, `.reply`, …) | none |
| `anime` | anime search + image commands | none |
| `media` | YouTube/Instagram/TikTok/… downloads | `yt-search`, `ruhend-scraper`, `ffmpeg` |
| `stickers` | sticker maker, crop, take | `ffmpeg-static`, `fluent-ffmpeg`, `node-webpmux` |
| `image` | image editing, PDF study | `sharp`, `jimp`, `mammoth`, `pdf-parse` |
| `textmaker` | styled text generator | `mumaker` |
| `extras` | news, translate, github, url, tts | `cheerio`, `google-translate-api-x`, `moment-timezone`, `gtts` |

Enable them in `.env`:

```bash
MINI_ENABLE=ai,anime
```

Groups with "extra packages" need a **full** install first — which defeats the
point of Mini, so only do it if you really want that feature on this host:

```bash
npm install --omit=dev          # installs the optional packages too
```

Check what a group needs without installing anything:

```bash
npm run deps:mini:check
```

---

## 7. Resource tuning (all optional)

| Variable | Default | What it does |
|---|---|---|
| `MAX_RSS_MB` | `180` | restart when RSS passes this (keep below systemd `MemoryMax`) |
| `MINI_LOG_FILE` | `logs/mini.log` | `off` when journald/pm2 owns the logs |
| `MINI_LOG_MAX_BYTES` | `2097152` | per-file cap before rotation |
| `MINI_LOG_KEEP` | `2` | rotated generations (ceiling = bytes × (keep+1) ≈ 6 MB) |
| `MINI_LOG_MAX_BYTES_PER_SEC` | `262144` | drops excess lines during an error storm |
| `MINI_TMP_MAX_AGE_MS` | `3600000` | delete temp files older than 1 h |
| `MINI_TMP_MAX_BYTES` | `67108864` | hard cap on the temp directory (64 MB) |
| `MINI_RECONNECT_BASE_MS` / `MINI_RECONNECT_MAX_MS` | `2000` / `60000` | reconnect backoff |
| `MAX_STORE_CONTACTS` / `MAX_STORE_CHATS` | `5000` / `2000` | caps on the persisted store |
| `MINI_BOOT_FASTFAIL_MS` | `30000` | a start shorter than this counts as a failed start |
| `MINI_BOOT_BACKOFF_BASE_MS` / `MINI_BOOT_BACKOFF_MAX_MS` | `2000` / `300000` | crash-loop backoff (doubles, capped at 5 min) |
| `MINI_MEM_CHECK_MS` | `30000` | how often RSS is sampled |
| `MINI_SHUTDOWN_TIMEOUT_MS` | `8000` | hard deadline for a clean shutdown |

---

## 8. Disk, logs and maintenance

### 8.1 What Mini writes

| Path | Purpose | Bound |
|---|---|---|
| `session/` | WhatsApp credentials | small (KB) |
| `data/` | command state (bans, warnings, settings, reminders) | small (KB) |
| `logs/mini.log` (+`.1`, `.2`) | rotating console mirror | ~6 MB ceiling |
| `temp/` | media scratch space | 64 MB ceiling, 1 h max age |
| `baileys_store.json` | last N messages per chat | ≤ 20 msg/chat, capped contacts/chats |

Nothing here grows without a ceiling.

### 8.2 Routine checks

```bash
du -sh node_modules logs data temp session   # footprint
journalctl -u optimus-mini -n 100            # recent logs
```

`.cleartmp` (owner command) empties `temp/` on demand.

### 8.3 Why `sharp` (50 MB) cannot be removed

`sharp` is ~47 % of the install, so it looks like the obvious thing to prune.
**It is required.** See the warning in §2 — removing it breaks `.setpp` and
sending images/videos, and `npm run test:mini` will catch it.

If 106 MB genuinely does not fit, reduce the *source* instead: disable the file
log (`MINI_LOG_FILE=off`, saves the ~6 MB ceiling) and lower
`MINI_TMP_MAX_BYTES`. Do not remove `sharp`.

### 8.4 Disk and memory budget on a 750 MB / 580 MB host

| Item | Size | Notes |
|---|---|---|
| Node.js runtime | ~90–110 MB | **not counted in the install size** — it is the runtime |
| Application source | ~7 MB | the repo without `node_modules` |
| `node_modules` | ~106 MB | dominated by `sharp` (50 MB) |
| Session + data + logs + temp | < 25 MB | all bounded by the ceilings in §7 |
| **Bot subtotal** | **~240 MB** | source + deps + runtime state (excl. Node itself) |
| With the Node runtime | **~340 MB** | |
| npm cache | 0–500 MB | `npm cache clean --force` after install frees it |

**The 750 MB budget is about the whole server, not the bot.** A typical minimal
Linux install already uses 400–900 MB, so on a 750 MB host you may have very
little free space. Check before deploying:

```bash
df -h /                       # total, used, available
du -sh /usr /var /home 2>/dev/null | sort -h
free -m                       # total and available RAM
```

Rules of thumb for this host:

- if **available disk < 400 MB**, install somewhere with more room or use a
  smaller Node build — do not delete OS files to make space;
- if **available RAM < 250 MB**, lower `MAX_RSS_MB` to `140` and
  `MemoryMax` to `180M`, and disable the file log.

### 8.5 Recovering from a memory or disk limit

| Situation | What happens | What to do |
|---|---|---|
| RSS passes `MAX_RSS_MB` | the bot flushes state, closes the socket and exits `1`; the supervisor restarts it | raise `MAX_RSS_MB` if it is too low for the host, or trim `MINI_ENABLE` groups |
| systemd `MemoryMax` hit | the kernel OOM-kills the unit; `Restart=always` brings it back | keep `MAX_RSS_MB` **below** `MemoryMax` so the bot restarts first |
| Startup keeps failing | the boot guard waits 2 s → 4 s → … (max 5 min) between attempts; systemd `StartLimitBurst` stops the unit after 6 tries in 5 min | read `journalctl -u optimus-mini -n 100`, fix the cause, then `systemctl reset-failed optimus-mini && systemctl start optimus-mini` |
| Disk filling | logs cap at ~6 MB, temp at 64 MB, store at 20 msg/chat | `du -sh logs temp data`; run `.cleartmp`; lower `MINI_TMP_MAX_BYTES` |
| Auth state seems lost | it is not deleted on restart — only on a real logout (401) | restore from your `session/` backup (see §8.6) |

### 8.6 Authentication state — backup and recovery

`session/` holds the WhatsApp credentials. **A normal restart never touches it**
(verified); it is deleted *only* when WhatsApp reports the device was logged out.

```bash
tar czf optimus-session-$(date +%F).tgz session/ data/ .env   # do this once linked
```

To restore, stop the bot, unpack over the project directory, and start it — no
re-pairing needed. Keep that archive private: it is equivalent to your login.

`data/` (your bans/warnings/reminders) and `.env` (your secrets) belong in the
same archive — they are the only other things worth keeping.

---

## 9. Measure the real numbers on this server

The figures in this guide were measured on Windows, where Node's RSS runs
higher than on Linux. Collect the actual Linux numbers before committing to a
budget:

```bash
bash scripts/linux-measure.sh          # ~2 minutes; read-only w.r.t. your data
```

It reports `free -m`, `df -h`, `du -sh`, module-load time, peak/idle RSS, clean
shutdown, and whether `session/` survived — then prints a summary you can paste
back. It never deletes auth state, user data or configuration.

Manual equivalents, if you prefer:

```bash
free -m                                   # total / available RAM
df -h .                                   # disk available to the bot
du -sh node_modules logs data temp session
ps -o rss= -p "$(pgrep -f 'node mini.js')" | awk '{printf "%.0f MB\n", $1/1024}'
```

For **activity** memory, run the bot linked and sample while you use it:

```bash
watch -n 5 "ps -o rss= -C node | awk '{s+=\$1} END{printf \"%.0f MB\n\", s/1024}'"
```

---

## 10. Updating

```bash
git pull
npm ci --omit=dev --omit=optional --no-audit --no-fund
sudo systemctl restart optimus-mini
```

The owner command `.update` does the same from inside WhatsApp.

---

## 11. Verify the install

```bash
npm run test:mini
```

Runs, with no extra tooling, five checks:

| Check | What it proves |
|---|---|
| `syntax check` | every Mini file parses |
| `check-mini-deps` | no core command reaches a heavy package; none is a hard dependency |
| `check-command-counts` | the loader's accounting adds up and **every essential command is dispatchable** |
| `check-image-lib` | `sharp` is present and baileys' image path works (guards against pruning it) |
| `smoke-mini` | only the allowlist loads, no heavy module is `require()`d, essential commands dispatch, excluded ones do not, and the resource guards behave |

Individual checks:

```bash
node scripts/check-mini-deps.js
node scripts/check-command-counts.js
node scripts/check-image-lib.js
node scripts/smoke-mini.js
```

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Cannot find module '@whiskeysockets/baileys'` | dependencies not installed → `npm ci --omit=dev --omit=optional` |
| Sending an image fails with `No image processing library available` | `sharp` was removed or skipped → reinstall (`npm ci --omit=dev --omit=optional`); do **not** use `--legacy-peer-deps` |
| Bot asks for a number on every restart | not linked yet; enter the printed pairing code once |
| `Connection closed (401)` / session deleted | logged out from the phone → re-pair |
| Process restarts in a loop | `MAX_RSS_MB` too low for the host, or systemd `MemoryMax` below it — raise both. Check `journalctl`; after 6 fast failures systemd stops the unit (`systemctl reset-failed optimus-mini` to clear) |
| Bot waits a few seconds before starting | the boot guard detected a previous failed start — expected after a crash; see §8.5 |
| A command replies "not a command" | it belongs to an optional group → `MINI_ENABLE=<group>` (see §6) |
| Logs seem to stop | hit the per-second rate cap or rotated — check `logs/mini.log.1` |
| Disk filling up | check `temp/`; lower `MINI_TMP_MAX_BYTES`, or run `.cleartmp` |
| `.dictionary` / `.dict` behaviour looks odd | fixed in this revision: a command's own name now always beats another command's alias (previously `define` shadowed `dictionary`) |

---

## 13. Design notes (why it is small)

- **Allowlist, not denylist.** `lib/commandLoader.js` reads the command's name
  from source *without executing it*, and skips anything not in the profile — so
  a heavy `require()` is never reached. A denylist would silently load any newly
  added heavy command.
- **Optional packages are declared, not deleted.** Heavy deps live in
  `optionalDependencies`, so the **full** edition's plain `npm install` is
  unchanged while Mini can skip them with `--omit=optional`.
- **No new dependencies.** Every guard is plain Node.
- **The full edition is untouched.** Mini is a separate entry point (`mini.js`);
  `index.js`, `main.js` and the command modules are shared, not forked.
