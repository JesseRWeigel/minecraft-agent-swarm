#!/usr/bin/env bash
# Study/operations state for the swarm. Modes:
#   live         ordinary campaign; operator fixes allowed and logged (observational data)
#   maintenance  planned window (e.g. GPU research): NO automatic restarts, no deploys,
#                no model use; the supervisor refuses to restart; report as maintenance
#   evaluation   controlled trial: code, prompts and policies FROZEN; only safety or
#                infrastructure interventions, each logged with its effect on validity
# Every transition is appended to ops/interventions.jsonl.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
STATE=ops/state.json
LEDGER=ops/interventions.jsonl
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
source scripts/ops-mode.sh
mode() { ops_mode "$STATE"; }
# Stage and validate before same-directory atomic rename. A failed jq producer
# must leave the previous mode intact, and readers must never see a partial JSON.
write_state() (
  temporary=$(mktemp ops/.state.XXXXXX)
  trap 'rm -f -- "$temporary"' EXIT
  cat > "$temporary"
  ops_mode "$temporary" >/dev/null
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$STATE"
)

case "${1:-status}" in
  status)
    cat "$STATE"; echo; echo "OPS_MODE=$(mode)";;
  enter-maintenance)
    reason="${2:-planned maintenance}"
    jq -n --arg m maintenance --arg s "$(now)" --arg r "$reason" --arg b "${OPS_BY:-Claude (operator)}" \
      '{mode:$m,since:$s,reason:$r,by:$b,trial:null}' | write_state
    jq -nc --arg ts "$(now)" --arg r "$reason" '{ts_utc:$ts,kind:"state",reason:("enter maintenance: "+$r),changes:["ops/state.json"],study_mode:"maintenance",by:"Claude (operator)",trial_validity:null}' >> "$LEDGER"
    echo "maintenance entered: $reason";;
  exit-maintenance)
    jq -n --arg m live --arg s "$(now)" --arg b "${OPS_BY:-Claude (operator)}" '{mode:$m,since:$s,reason:"live campaign (observational)",by:$b,trial:null}' | write_state
    jq -nc --arg ts "$(now)" '{ts_utc:$ts,kind:"state",reason:"exit maintenance, back to live",changes:["ops/state.json"],study_mode:"live",by:"Claude (operator)",trial_validity:null}' >> "$LEDGER"
    echo "back to live";;
  enter-evaluation)
    trial="${2:?trial id required}"; note="${3:-controlled evaluation}"
    jq -n --arg m evaluation --arg s "$(now)" --arg r "$note" --arg t "$trial" --arg b "${OPS_BY:-Claude (operator)}" '{mode:$m,since:$s,reason:$r,by:$b,trial:$t}' | write_state
    jq -nc --arg ts "$(now)" --arg t "$trial" --arg r "$note" '{ts_utc:$ts,kind:"state",reason:("enter evaluation "+$t+": "+$r),changes:["ops/state.json"],study_mode:"evaluation",trial:$t,by:"Claude (operator)",trial_validity:"trial start"}' >> "$LEDGER"
    echo "evaluation $trial entered: code, prompts and policies are frozen";;
  exit-evaluation)
    trial=$(jq -r '.trial // "unknown"' "$STATE")
    jq -n --arg m live --arg s "$(now)" --arg b "${OPS_BY:-Claude (operator)}" '{mode:$m,since:$s,reason:"live campaign (observational)",by:$b,trial:null}' | write_state
    jq -nc --arg ts "$(now)" --arg t "$trial" '{ts_utc:$ts,kind:"state",reason:("exit evaluation "+$t),changes:["ops/state.json"],study_mode:"live",trial:$t,by:"Claude (operator)",trial_validity:"trial end"}' >> "$LEDGER"
    echo "evaluation $trial ended, back to live";;
  log)
    # ops-state.sh log <kind> <reason> [changes] [commit] [run] [restart_utc] [validity-note]
    jq -nc --arg ts "$(now)" --arg k "${2:?kind}" --arg r "${3:?reason}" --arg c "${4:-}" --arg commit "${5:-}" --arg run "${6:-}" --arg rst "${7:-}" --arg v "${8:-}" --arg m "$(mode)" --arg t "$(jq -r '.trial // empty' "$STATE")" \
      '{ts_utc:$ts,kind:$k,reason:$r,changes:($c|split(",")|map(select(length>0))),commit:$commit,run:($run|tonumber? // null),restart_utc:$rst,restart_source:"supervisor log",deploy_point:"hourly cycle restart",by:"Claude (operator)",study_mode:$m,trial:(if $t=="" then null else $t end),trial_validity:(if $v=="" then null else $v end)}' >> "$LEDGER"
    echo "logged";;
  *) echo "usage: $0 status|enter-maintenance <reason>|exit-maintenance|enter-evaluation <trial> [note]|exit-evaluation|log <kind> <reason> [changes] [commit] [run] [restart_utc] [validity]"; exit 2;;
esac
