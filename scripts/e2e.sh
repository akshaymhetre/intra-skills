#!/usr/bin/env bash
# End-to-end run of the real server + real CLI in a sandbox HOME.
# Never touches the real ~/.claude, ~/.agents, ~/.cursor or ~/.intra-skills.
# Usage: scripts/e2e.sh [port]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-7798}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/intra-e2e.XXXXXX")"
DATA="$WORK/data"
# Resolve the real node before HOME changes: version-manager shims (mise, asdf) read HOME.
NODE="$(node -p process.execPath)"
export HOME="$WORK/home"
export INTRA_SKILLS_HOME="$HOME/.intra-skills"
export NO_COLOR=1
mkdir -p "$HOME"
[[ -f "$ROOT/packages/server/dist/bin.js" && -f "$ROOT/packages/cli/dist/bin.js" ]] || { echo "Build first: pnpm build" >&2; exit 1; }
SERVER="$NODE $ROOT/packages/server/dist/bin.js"
INTRA="$NODE $ROOT/packages/cli/dist/bin.js"
REG="http://127.0.0.1:$PORT"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

cleanup() { [[ -n "${SPID:-}" ]] && kill "$SPID" 2>/dev/null || true; }
trap cleanup EXIT

echo "== workdir $WORK"
ADMIN_OUT="$($SERVER init --data "$DATA" --admin ada --name "Ada Admin")"
ADMIN_TOKEN="$(printf '%s\n' "$ADMIN_OUT" | grep -oE 'isk_[A-Za-z0-9]{32}' | head -1)"
[[ -n "$ADMIN_TOKEN" ]] && ok "init printed an admin token" || { bad "init printed an admin token"; echo "$ADMIN_OUT"; exit 1; }

$SERVER serve --data "$DATA" --port "$PORT" >"$WORK/server.log" 2>&1 &
SPID=$!
for _ in $(seq 1 50); do curl -fs "$REG/api/health" >/dev/null 2>&1 && break; sleep 0.1; done
check "server health" "curl -fs $REG/api/health"

$INTRA login --registry "$REG" --token "$ADMIN_TOKEN" >/dev/null
check "whoami is ada" "$INTRA whoami --json | grep -q '\"ada\"'"

# Teams and a second user.
$INTRA team create platform --name "Platform" >/dev/null
$INTRA team create frontend --name "Frontend" >/dev/null
BOB_TOKEN="$($INTRA user create bob --name Bob --json | grep -oE 'isk_[A-Za-z0-9]{32}' | head -1)"
[[ -n "$BOB_TOKEN" ]] && ok "admin created user bob" || bad "admin created user bob"
$INTRA team add frontend bob >/dev/null

# Author a skill.
SK="$WORK/src"
mkdir -p "$SK"
( cd "$SK" && $INTRA init deploy-check --team platform --area infra,backend --tags aws,ecs >/dev/null )
check "init scaffolded a valid skill" "$INTRA validate $SK/deploy-check"
mkdir -p "$SK/deploy-check/scripts"
printf '#!/bin/sh\necho checking\n' > "$SK/deploy-check/scripts/check.sh"
chmod +x "$SK/deploy-check/scripts/check.sh"
check "publish 0.1.0" "$INTRA publish $SK/deploy-check --yes"
check "republishing the same version is refused" "! $INTRA publish $SK/deploy-check --yes"
echo "extra line" >> "$SK/deploy-check/SKILL.md"
check "publish --bump minor" "$INTRA publish $SK/deploy-check --bump minor --changelog 'add extra line' --yes"
check "SKILL.md was rewritten to 0.2.0" "grep -q '0.2.0' $SK/deploy-check/SKILL.md"

# Secret scan.
cp -R "$SK/deploy-check" "$SK/leaky" && sed -i.bak 's/^name: deploy-check/name: leaky/' "$SK/leaky/SKILL.md" && rm "$SK/leaky/SKILL.md.bak"
echo 'aws_key = AKIAABCDEFGHIJKLMNOP' > "$SK/leaky/references.txt"
check "secret scan refuses an AWS key" "! $INTRA publish $SK/leaky --yes"

# Private skill + access control.
cp -R "$SK/deploy-check" "$SK/secret-sauce" && sed -i.bak 's/^name: deploy-check/name: secret-sauce/' "$SK/secret-sauce/SKILL.md" && rm "$SK/secret-sauce/SKILL.md.bak"
check "publish private skill" "$INTRA publish $SK/secret-sauce --private --version 1.0.0 --yes"
check "bob cannot see the private skill" "! INTRA_SKILLS_TOKEN=$BOB_TOKEN curl -fs -H 'Authorization: Bearer $BOB_TOKEN' $REG/api/skills/secret-sauce"
check "private skill absent from bob's search" "! curl -fs -H 'Authorization: Bearer $BOB_TOKEN' '$REG/api/skills' | grep -q secret-sauce"
$INTRA grant secret-sauce --team frontend --perm read >/dev/null
check "team grant lets bob read it" "curl -fs -H 'Authorization: Bearer $BOB_TOKEN' $REG/api/skills/secret-sauce"

# Search / facets.
check "search by team" "$INTRA search --team platform --json | grep -q deploy-check"
check "search by area" "$INTRA search --area infra --json | grep -q deploy-check"
check "search by tool" "$INTRA search --tool codex --json | grep -q deploy-check"

# Global install into all three tools.
check "install global to all tools" "$INTRA install deploy-check@^0.1.0 --to claude,codex,cursor"
for d in .claude/skills .agents/skills .cursor/skills; do
  check "symlink $d/deploy-check resolves to SKILL.md" "test -f $HOME/$d/deploy-check/SKILL.md"
done
check "^0.1.0 pinned 0.1.0, not 0.2.0" "! grep -q 'extra line' $HOME/.claude/skills/deploy-check/SKILL.md"

# Unmanaged dir is protected.
mkdir -p "$HOME/.claude/skills/secret-sauce" && echo mine > "$HOME/.claude/skills/secret-sauce/SKILL.md"
check "refuses to overwrite an unmanaged skill dir" "! $INTRA install secret-sauce --to claude"
check "unmanaged dir survived" "grep -q mine $HOME/.claude/skills/secret-sauce/SKILL.md"

# Update / list / yank.
$INTRA install deploy-check@latest --to claude,codex,cursor >/dev/null
check "latest install moved to 0.2.0" "grep -q 'extra line' $HOME/.claude/skills/deploy-check/SKILL.md"
check "list shows deploy-check" "$INTRA list --json | grep -q deploy-check"
check "yank 0.2.0" "$INTRA yank deploy-check 0.2.0 --reason 'bad line'"
check "resolve latest skips yanked" "curl -fs -H 'Authorization: Bearer $ADMIN_TOKEN' '$REG/api/skills/deploy-check/resolve?range=latest' | grep -q '0.1.0'"
check "diff 0.1.0 -> 0.2.0 mentions extra line" "$INTRA diff deploy-check 0.1.0 0.2.0 | grep -q 'extra line'"

# Project mode + lockfile + sync.
PROJ="$WORK/proj"
mkdir -p "$PROJ" && git -C "$PROJ" init -q
check "project install" "( cd $PROJ && $INTRA install deploy-check@0.1.0 --project --to claude,codex )"
check "project copy has marker" "test -f $PROJ/.claude/skills/deploy-check/.intra-skill.json"
check "lockfile written" "grep -q '\"deploy-check\"' $PROJ/skills.lock.json"
rm -rf "$PROJ/.agents/skills/deploy-check"
check "sync --frozen detects drift" "! ( cd $PROJ && $INTRA sync --frozen )"
check "sync restores" "( cd $PROJ && $INTRA sync ) && test -f $PROJ/.agents/skills/deploy-check/SKILL.md"

# Remove + doctor.
check "remove global" "$INTRA remove deploy-check"
check "symlinks gone" "! test -e $HOME/.claude/skills/deploy-check"
check "doctor runs" "$INTRA doctor"

# Audit trail.
check "audit has publish, grant and yank" "curl -fs -H 'Authorization: Bearer $ADMIN_TOKEN' '$REG/api/audit?limit=200' | grep -q skill.publish && curl -fs -H 'Authorization: Bearer $ADMIN_TOKEN' '$REG/api/audit?limit=200' | grep -q grants.set && curl -fs -H 'Authorization: Bearer $ADMIN_TOKEN' '$REG/api/audit?limit=200' | grep -q version.yank"

echo "== $PASS passed, $FAIL failed (workdir $WORK)"
[[ "$FAIL" -eq 0 ]]
