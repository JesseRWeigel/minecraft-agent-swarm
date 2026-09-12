#!/usr/bin/env bash
# Consistent server backup: pause autosave, flush, archive all three dimensions
# plus the server's identity files, resume autosave, verify, and log it.
# Output: backups/world-<UTC>.tar.zst (+ .sha256 and a manifest line in backups/MANIFEST.tsv).
# Safe to run while the server is up; the swarm may keep playing (the pause is seconds).
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
source scripts/ops-mode.sh
# Record validated mode at backup start; do not fabricate live provenance.
mode=$(ops_mode)
mkdir -p backups
ts=$(date -u +%Y%m%dT%H%M%SZ)
out="backups/world-${ts}.tar.zst"
label="${1:-scheduled}"
rcon() { node scripts/rcon.mjs "$@"; }
echo "[backup] $ts label=$label"
# Install cleanup before save-off: a later flush failure must restore autosave.
trap 'rcon "save-on" >/dev/null || echo "ERROR: Could not restore autosave; operator must run save-on." >&2' EXIT
rcon "save-off" "save-all flush" >/dev/null
sleep 2
tar -C server --exclude='ai-world/session.lock' --exclude='*/session.lock' -cf - \
  ai-world ai-world_nether ai-world_the_end server.properties usercache.json ops.json whitelist.json \
  | zstd -T0 -3 -q -o "$out"
rcon "save-on" >/dev/null
trap - EXIT
# Standalone check: an AND-list would mask a failing verifier under set -e.
zstd -t -q "$out"
sha=$(sha256sum "$out" | cut -d' ' -f1)
echo "$sha  $(basename "$out")" > "${out}.sha256"
size=$(stat -c %s "$out")
git_head=$(git rev-parse --short HEAD 2>/dev/null || echo none)
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$(basename "$out")" "$size" "$sha" "$git_head" "$label/$mode" >> backups/MANIFEST.tsv
echo "[backup] ok $out ($((size/1024/1024)) MB, sha256 $sha)"
jq -nc --arg operator "${OPS_BY:-Claude (operator)}" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg f "$(basename "$out")" --arg l "$label" --arg m "$mode" --arg s "$sha" \
  '{ts_utc:$ts,kind:"backup",reason:("world backup ("+$l+")"),changes:[("backups/"+$f)],sha256:$s,study_mode:$m,by:$operator,trial_validity:null}' >> ops/interventions.jsonl
