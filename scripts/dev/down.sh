#!/usr/bin/env bash
# Stop the development registry started by scripts/dev/up.sh.
set -euo pipefail
pid_file="$(cd "$(dirname "$0")/../.." && pwd)/.data/dev/server.pid"
[ -f "$pid_file" ] || { echo "no dev registry running"; exit 0; }
kill "$(cat "$pid_file")" 2>/dev/null && echo "stopped dev registry" || echo "dev registry was not running"
rm -f "$pid_file"
