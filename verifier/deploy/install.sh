#!/usr/bin/env bash
# Install/refresh farm-verifier on the rig (idempotent). Run on the rig as a sudoer from the verifier/ dir:
#   verifier/deploy/install.sh
# Creates /opt/farm/verifier-venv (python3.11 if present, else python3), installs this package with the `service` extra,
# installs the systemd unit and (re)starts it. Calibration state lives in /var/lib/farm/verifier.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
PY="$(command -v python3.11 || command -v python3)"
sudo mkdir -p /opt/farm/verifier /var/lib/farm/verifier /var/lib/farm/verifier-evidence
sudo chown -R "$USER" /opt/farm/verifier /var/lib/farm/verifier /var/lib/farm/verifier-evidence
rsync -a --delete --exclude .venv --exclude state --exclude __pycache__ --exclude .pytest_cache "$here"/ /opt/farm/verifier/
[ -d /opt/farm/verifier-venv ] || sudo install -d -o "$USER" /opt/farm/verifier-venv
[ -x /opt/farm/verifier-venv/bin/python ] || "$PY" -m venv /opt/farm/verifier-venv
/opt/farm/verifier-venv/bin/pip install --quiet --upgrade pip
/opt/farm/verifier-venv/bin/pip install --quiet -e "/opt/farm/verifier[service]"  # editable: images/ and unoq_app/ are located relative to the source
sudo mkdir -p /etc/farm
[ -f /etc/farm/verifier.env ] || echo "FARM_VERIFIER_CAMERA=/dev/farm/cam0" | sudo tee /etc/farm/verifier.env >/dev/null
sudo install -m 644 "$here/deploy/farm-verifier.service" /etc/systemd/system/farm-verifier.service
sudo systemctl daemon-reload
sudo systemctl enable farm-verifier.service
sudo systemctl restart farm-verifier.service
sleep 3
curl -fsS http://127.0.0.1:8090/health && echo
