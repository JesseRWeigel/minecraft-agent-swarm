#!/usr/bin/env bash
# Source from a repository-root working directory. Invalid/missing state is an
# error: it must never silently grant permission to restart or load a model.
ops_mode() {
  jq -ers 'if length != 1 then error("require one operations object") else .[0] end | if type == "object" and (.mode == "live" or .mode == "maintenance" or .mode == "evaluation")
    then .mode else error("invalid operations mode") end' "${1:-ops/state.json}"
}
