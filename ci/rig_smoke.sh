#!/usr/bin/env bash
# On-rig smoke test for a candidate build (INTEGRATION.md §3).
# Usage: ci/rig_smoke.sh [--host rig-usb] [--ref <sha>]
# Writes ci/results/<date>-<sha>.md. Stages that depend on unbuilt lanes report SKIP, never PASS.
set -uo pipefail
cd "$(dirname "$0")/.."
H=rig-usb; REF=$(git rev-parse --short HEAD)
while [ $# -gt 0 ]; do case $1 in --host) H=$2; shift 2;; --ref) REF=$2; shift 2;; *) echo "unknown $1"; exit 2;; esac; done
OUT="ci/results/$(date +%Y%m%d-%H%M)-$REF.md"; mkdir -p ci/results
log(){ echo "$1" | tee -a "$OUT"; }
log "# rig smoke $REF on $H ($(date -u +%FT%TZ))"

log "## facts"; ci/rig_probe.sh "$H" 2>&1 | sed 's/^/    /' >>"$OUT" && log "PASS probe" || log "FAIL probe (ssh?)"

if [ -x rig/deploy.sh ]; then
  rig/deploy.sh all --ref "$REF" >>"$OUT" 2>&1 && log "PASS deploy $REF" || { log "FAIL deploy"; exit 1; }
else log "SKIP deploy (rig/deploy.sh not merged yet)"; fi

if ssh "$H" 'systemctl is-active --quiet farm-rigd' 2>/dev/null; then
  RIGIP=$(ssh "$H" 'tailscale ip -4 2>/dev/null | head -1')
  if [ -x rig/health.sh ]; then ssh "$H" 'bash -s' <rig/health.sh >>"$OUT" 2>&1 && log "PASS health" || log "FAIL health"; fi
  if [ -n "$RIGIP" ]; then
    python3 ci/e2e_scenarios.py --base "http://$RIGIP:8080" >>"$OUT" 2>&1 && log "PASS lease/queue/fencing scenarios" || log "FAIL scenarios (see above)"
  else log "SKIP scenarios (rig not on tailnet yet)"; fi
  if [ -f tickets/validate.py ]; then python3 tickets/validate.py --all >>"$OUT" 2>&1 && log "PASS reference tickets" || log "FAIL reference tickets"; else log "SKIP tickets (validate.py not merged)"; fi
else
  log "SKIP services (farm-rigd not running on rig)"
fi
grep -q '^FAIL' "$OUT" && { echo "RESULT: FAIL -> $OUT"; exit 1; } || echo "RESULT: no failures (check SKIPs) -> $OUT"
