#!/usr/bin/env bash
# Copy the volatile /tmp/bot-run-*.log supervisor logs into the repo's ignored
# logs/bot-runs/ so they survive reboots and /tmp cleanup. Never deletes anything.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs/bot-runs
rsync -a --no-perms --no-owner --no-group /tmp/bot-run-*.log logs/bot-runs/ 2>/dev/null
n=$(ls logs/bot-runs | wc -l); sz=$(du -sh logs/bot-runs | cut -f1)
echo "PRESERVED_RUN_LOGS=$n SIZE=$sz"
