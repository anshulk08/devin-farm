#!/usr/bin/env bash
# Deploy rigd to the Jetson: rsync rig/ -> /opt/farm/rig, pip install into /opt/farm/venv (via the Mac proxy),
# install config + unit, restart, smoke-check /v1/rig and /v1/state.
#   rig/deploy.sh [host]        default host: rig-1
# Needs on the Mac: ssh access to the rig, and the reverse proxy tunnel on rig-1:1081 (https_proxy) for pip.
set -euo pipefail
HOST=${1:-rig-1}
HERE=$(cd "$(dirname "$0")" && pwd)
BIND_IP=${FARM_BIND:-$(ssh "$HOST" 'tailscale ip -4 | head -n1')}
PROXY=${FARM_PROXY:-http://127.0.0.1:1081}   # as seen from the Jetson

ssh "$HOST" 'sudo mkdir -p /opt/farm /etc/farm /var/lib/farm && sudo chown -R guru:guru /opt/farm /var/lib/farm'
rsync -a --delete --exclude __pycache__ --exclude '*.pyc' --exclude tests/hw "$HERE/" "$HOST:/opt/farm/rig/"
ssh "$HOST" "bash -s" <<REMOTE
set -euo pipefail
cd /opt/farm
PY=\$(command -v python3.11 || command -v python3)
[ -x venv/bin/python ] || \$PY -m venv venv
export https_proxy=$PROXY http_proxy=$PROXY
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q -r rig/requirements.txt
[ -f /etc/farm/rig.yaml ] || sudo cp rig/rig.example.yaml /etc/farm/rig.yaml
printf 'FARM_BIND=%s\n' "$BIND_IP" | sudo tee /etc/farm/env >/dev/null
sudo cp rig/farm-rigd.service /etc/systemd/system/farm-rigd.service
sudo systemctl daemon-reload
sudo systemctl enable farm-rigd >/dev/null 2>&1
sudo systemctl restart farm-rigd
REMOTE
echo "smoke: http://$BIND_IP:8081/v1/rig (control API; the session API on :8080 needs a tag:devin-session node)"
for i in $(seq 30); do
  if out=$(ssh "$HOST" "curl -fs --max-time 3 http://$BIND_IP:8081/v1/rig" 2>/dev/null); then echo "$out"; exit 0; fi
  sleep 1
done
echo "smoke FAILED; journalctl -u farm-rigd on $HOST:" >&2
ssh "$HOST" 'sudo journalctl -u farm-rigd -n 30 --no-pager' >&2
exit 1
