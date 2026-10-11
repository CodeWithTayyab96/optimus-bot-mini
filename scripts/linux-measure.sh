#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# linux-measure.sh — collect the real numbers on the TARGET Linux server.
#
# The Mini edition was developed and audited on Windows, where Node's RSS runs
# higher than on Linux. This script gathers the Linux figures so the deployment
# budget is based on measurements from the actual host, not on estimates.
#
# It is READ-ONLY with respect to your data: it starts the bot, samples it,
# stops it cleanly and prints a report. It never deletes auth state, user data
# or configuration.
#
# Usage:
#   cd /opt/optimus-mini
#   bash scripts/linux-measure.sh            # needs node_modules already installed
#   SAMPLES=12 INTERVAL=10 bash scripts/linux-measure.sh
#
# Prerequisite: `npm ci --omit=dev --omit=optional --no-audit --no-fund`
# ---------------------------------------------------------------------------
set -u

SAMPLES="${SAMPLES:-8}"          # how many RSS samples
INTERVAL="${INTERVAL:-10}"       # seconds between samples
READY_TIMEOUT="${READY_TIMEOUT:-120}"
LOG="logs/measure-$(date +%Y%m%d-%H%M%S).log"

hr() { printf '%s\n' "------------------------------------------------------------"; }
say() { printf '%s\n' "$*"; }

mkdir -p logs

hr
say "Optimus Mini — Linux measurement  ($(date -Is))"
hr

# ── 1. Environment ─────────────────────────────────────────────────────────
say "1. Environment"
say "   node          : $(node --version 2>/dev/null || echo 'NOT FOUND')"
say "   npm           : $(npm --version 2>/dev/null || echo 'NOT FOUND')"
say "   kernel        : $(uname -sr)"
say "   cpus          : $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo '?')"
echo

say "   free -m:"
free -m | sed 's/^/     /'
echo

say "   df -h (the filesystem holding this project):"
df -h . | sed 's/^/     /'
echo

# ── 2. Disk footprint ──────────────────────────────────────────────────────
say "2. Disk footprint"
if [ -d node_modules ]; then
  say "   node_modules  : $(du -sh node_modules 2>/dev/null | cut -f1)"
  say "   packages      : $(find node_modules -maxdepth 2 -name package.json 2>/dev/null | wc -l)"
else
  say "   node_modules  : MISSING — run: npm ci --omit=dev --omit=optional --no-audit --no-fund"
fi
say "   source (excl. node_modules/logs/temp/session):"
du -sh --exclude=node_modules --exclude=logs --exclude=temp --exclude=session . 2>/dev/null | sed 's/^/     /'
say "   runtime state :"
for d in session data logs temp; do
  [ -e "$d" ] && say "     $(du -sh "$d" 2>/dev/null | cut -f1)	$d"
done
say "   npm cache     : $(du -sh "$(npm config get cache 2>/dev/null)" 2>/dev/null | cut -f1)"
echo

# ── 3. Start the bot and sample it ─────────────────────────────────────────
say "3. Startup + idle memory"
say "   starting: node mini.js --qr  (no account linking, safe)"
: > "$LOG"
setsid node mini.js --qr >>"$LOG" 2>&1 &
BOT=$!
say "   pid $BOT — waiting up to ${READY_TIMEOUT}s for the connection"

READY_AT=""
for i in $(seq 1 "$READY_TIMEOUT"); do
  if grep -q "Connecting to WhatsApp" "$LOG" 2>/dev/null; then READY_AT="$i"; break; fi
  if ! kill -0 "$BOT" 2>/dev/null; then say "   ✗ the process exited early — see $LOG"; break; fi
  sleep 1
done
[ -n "$READY_AT" ] && say "   module load + socket setup: ${READY_AT}s (upper bound; includes npm/node start)"

printf '   %-8s %-10s %s\n' "t(s)" "RSS(KB)" "VSZ(KB)"
PEAK=0
for i in $(seq 1 "$SAMPLES"); do
  if ! kill -0 "$BOT" 2>/dev/null; then say "   ✗ process gone at sample $i"; break; fi
  # ps is always present; /proc is the fallback.
  read -r RSS VSZ <<EOF
$(ps -o rss=,vsz= -p "$BOT" 2>/dev/null || awk '{print $2, $1}' /proc/$BOT/statm 2>/dev/null)
EOF
  RSS=${RSS:-0}
  [ "$RSS" -gt "$PEAK" ] 2>/dev/null && PEAK=$RSS
  printf '   %-8s %-10s %s\n' "$((i * INTERVAL))" "$RSS" "${VSZ:-?}"
  sleep "$INTERVAL"
done
say "   peak RSS observed: $((PEAK / 1024)) MB"
echo

# ── 4. Clean shutdown ──────────────────────────────────────────────────────
say "4. Shutdown"
kill -TERM "$BOT" 2>/dev/null
SHUT=""
for i in $(seq 1 20); do
  kill -0 "$BOT" 2>/dev/null || { SHUT="$i"; break; }
  sleep 1
done
if [ -n "$SHUT" ]; then
  say "   exited ${SHUT}s after SIGTERM"
  grep -E "shutting down gracefully|\[shutdown\]" "$LOG" | sed 's/^/     /' || say "     (no graceful-shutdown line found)"
else
  say "   ✗ still running 20s after SIGTERM — killing"
  kill -9 "$BOT" 2>/dev/null
fi
echo

# ── 5. Auth state survives ─────────────────────────────────────────────────
say "5. Auth state"
if [ -d session ] && [ -n "$(ls -A session 2>/dev/null)" ]; then
  say "   session/ present with $(ls -A session | wc -l) file(s) — untouched by the shutdown above"
else
  say "   session/ is empty (bot not linked yet, or never paired) — expected on a fresh host"
fi
echo

# ── 6. Summary ─────────────────────────────────────────────────────────────
hr
say "Summary (paste this back for the deployment budget)"
hr
say "  node              : $(node --version 2>/dev/null)"
say "  node_modules      : $(du -sh node_modules 2>/dev/null | cut -f1)"
say "  peak RSS observed : $((PEAK / 1024)) MB"
say "  free -m total     : $(free -m | awk '/^Mem:/{print $2}') MB"
say "  free -m available : $(free -m | awk '/^Mem:/{print $7}') MB"
say "  disk available    : $(df -h . | awk 'NR==2{print $4}')"
say "  log written to    : $LOG"
hr
say "Note: this run was never linked to a WhatsApp account, so it measures"
say "startup + idle only. For representative ACTIVITY memory, run the bot"
say "linked and send it a few dozen commands, sampling with:"
say "    watch -n 5 \"ps -o rss= -C node | awk '{s+=\\$1} END{print s/1024\\\" MB\\\"}'\""
