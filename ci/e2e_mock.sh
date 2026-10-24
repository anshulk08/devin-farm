#!/usr/bin/env bash
# Mock end-to-end: rigd (mock drivers + mock verifier) + scripted sessions.
# Becomes a hard gate once rig/ ships `--mock-drivers` (WORKSPLIT lane A, T+4).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d rig ] || ! grep -rqs -- "--mock-drivers" rig; then
  echo "e2e_mock: rigd mock mode not present yet; skipping (not a pass)"; exit 0
fi
PORT=${PORT:-18080}; CTL=${CTL:-18081}
python -m rig.rigd --mock-drivers --mock-verifier --bind 127.0.0.1 --port "$PORT" --control-port "$CTL" --mock-identity &
PID=$!; trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$PORT/v1/rig" >/dev/null && break; sleep 0.2; done
python ci/e2e_scenarios.py --base "http://127.0.0.1:$PORT" --mock-identity
