#!/usr/bin/env bash
# Fresh development registry: builds the server, creates a new database under .data/dev, starts the
# server on :7720 (so it never collides with a real registry on :7710) in the background, seeds the fictional org, and prints a sign-in token.
# Then run the console with: pnpm --filter @intra-skills/web dev   (http://localhost:5173)
# Stop with scripts/dev/down.sh. Every run starts from an empty database.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
data="$root/.data/dev"
port="${PORT:-7720}"
node="$(command -v node)"

"$root/scripts/dev/down.sh" >/dev/null 2>&1 || true
(cd "$root" && pnpm --filter @intra-skills/shared --filter @intra-skills/server run build >/dev/null)
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $port is already in use (PORT=<n> picks another):" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
  exit 1
fi
rm -rf "$data"
mkdir -p "$data"
token="$("$node" "$root/packages/server/dist/bin.js" init --data "$data" --admin maya --name "Maya Chen" | tail -1)"
INTRA_SKILLS_ORG_NAME="${INTRA_SKILLS_ORG_NAME:-acme-skills}" INTRA_SKILLS_POLL_SECONDS=3600 \
  nohup "$node" "$root/packages/server/dist/bin.js" serve --data "$data" --port "$port" >"$data/server.log" 2>&1 &
echo $! >"$data/server.pid"
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break
  sleep 0.1
done
"$node" "$root/scripts/dev/seed.ts" "http://127.0.0.1:$port" "$data" "$token" >"$data/seed.log"
echo "$token" >"$data/admin-token"
chmod 600 "$data/admin-token"
echo "registry: http://127.0.0.1:$port   (pid $(cat "$data/server.pid"), log $data/server.log)"
[[ -f "$root/packages/web/dist/index.html" ]] && echo "console:  http://localhost:$port   (sign in by pasting the token below)"
echo "sign in as maya (admin) with: $token"
echo "other users' tokens: $data/seed.log"
