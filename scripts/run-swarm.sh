#!/usr/bin/env bash
# Supervisor for the swarm.
#
# WHY THIS EXISTS
#
# Six OOM crashes across a week, at intervals from 3h to 25h. Each one killed
# the process and left the swarm down until the next hourly health check noticed
# — sometimes an hour of five idle bots, sometimes longer.
#
# The root cause is still unknown. Five theories have died against evidence:
#   slow memory leak       heap was flat at ~200MB for up to 25h between crashes
#   generated skills       crash 3 was deposit_stash, crash 4 was flee
#   minecraft-data reload  the library caches by version
#   crafting operations    crash 4 did not craft
#   pathfinder searchRadius bounded at 96 and it crashed anyway at 8,185MB
#
# The profile is always identical: heap flat at ~200MB, then the full ceiling
# within one 2-minute sampling window. Raising the ceiling 4GB -> 8GB simply
# doubled the runaway's room, which proves it is unbounded rather than a spike
# needing headroom.
#
# So: contain the blast radius while the hunt continues. A crash becomes a ~15s
# gap instead of an hours-long outage. This does NOT fix anything, and the
# diagnostics stay in place to catch the cause eventually.
#
# RESTART_CAP exists so a genuinely broken build (syntax error, bad config)
# fails loudly instead of spinning forever.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

RESTART_CAP=${RESTART_CAP:-40}
COOLDOWN_S=${COOLDOWN_S:-15}
restarts=0

# A crash loop is different from occasional crashes. If several happen inside
# this window the build itself is suspect, so stop rather than hammer the server.
FAST_FAIL_S=120
fast_failures=0

# Maintenance gate (ops/state.json, see ops/README.md): a planned window must
# not be undone by an automatic restart. FORCE_START=1 overrides for a
# deliberate operator launch inside the window.
ops_mode() { jq -r .mode ops/state.json 2>/dev/null || echo live; }
if [[ "$(ops_mode)" == "maintenance" && "${FORCE_START:-0}" != "1" ]]; then
  echo "[Supervisor] ops mode is MAINTENANCE — refusing to start the swarm (FORCE_START=1 to override)."
  exit 0
fi

while (( restarts < RESTART_CAP )); do
  started=$(date +%s)
  echo "[Supervisor] Starting swarm (restart #$restarts) at $(date -u +%H:%M:%SZ)"

  npm start
  code=$?

  ran=$(( $(date +%s) - started ))
  echo "[Supervisor] Swarm exited code=$code after ${ran}s"

  # 143/137 are our own SIGTERM/SIGKILL from a deliberate redeploy. Do not fight
  # an operator who is intentionally stopping the swarm.
  if [[ $code -eq 143 || $code -eq 137 ]]; then
    echo "[Supervisor] Deliberate stop — not restarting."
    exit 0
  fi

  if (( ran < FAST_FAIL_S )); then
    fast_failures=$(( fast_failures + 1 ))
    if (( fast_failures >= 3 )); then
      echo "[Supervisor] 3 crashes inside ${FAST_FAIL_S}s each — the build looks broken. Stopping."
      exit 1
    fi
  else
    fast_failures=0
  fi

  # 134 is the OOM abort. Call it out so the log says what happened.
  if [[ $code -eq 134 ]]; then
    echo "[Supervisor] Exit 134 = JavaScript heap OOM. Cause still unknown; see scripts/run-swarm.sh header."
  fi

  if [[ "$(ops_mode)" == "maintenance" ]]; then
    echo "[Supervisor] ops mode is MAINTENANCE — not restarting after this exit."
    exit 0
  fi

  restarts=$(( restarts + 1 ))
  echo "[Supervisor] Restarting in ${COOLDOWN_S}s..."
  sleep "$COOLDOWN_S"
done

echo "[Supervisor] Hit RESTART_CAP=$RESTART_CAP. Stopping."
exit 1
