#!/usr/bin/env bash
# Repo-wide static checks: secrets and binding hygiene. Fast; runs on every PR.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

# 1. Secrets that must never be committed.
pattern='(cog_[A-Za-z0-9]{16,}|apk_[A-Za-z0-9]{16,}|tskey-(auth|client|api)-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
if git grep -nIE "$pattern" -- . ':!ci/check.sh' >/dev/null; then
  echo "FAIL secrets:"; git grep -nIE "$pattern" -- . ':!ci/check.sh' | sed 's/:.*:/: <redacted line>/'; fail=1
fi

# 2. Services must not bind all interfaces (C0: tailnet IP or localhost only).
if git grep -nIE "(host *= *['\"]0\.0\.0\.0['\"]|--host[ =]0\.0\.0\.0)" -- rig verifier control 2>/dev/null; then
  echo "FAIL: binding 0.0.0.0 (use the tailnet IP or 127.0.0.1)"; fail=1
fi

[ $fail -eq 0 ] && echo "check.sh: OK"
exit $fail
