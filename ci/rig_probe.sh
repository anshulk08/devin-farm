#!/usr/bin/env bash
# Read-only facts about the Jetson (Day-0 G6). Safe to run any time.
# Usage: ci/rig_probe.sh [ssh-host]   (default: rig-usb = guru@192.168.55.1 over USB)
set -uo pipefail
H=${1:-rig-usb}
ssh -o ConnectTimeout=5 "$H" 'bash -s' <<'EOF'
echo "== model";      tr -d '\0' </proc/device-tree/model; echo
echo "== l4t";        head -1 /etc/nv_tegra_release 2>/dev/null
echo "== os";         . /etc/os-release; echo "$PRETTY_NAME"; uname -r
echo "== python";     ls /usr/bin/python3* 2>/dev/null | tr '\n' ' '; echo; python3 --version
echo "== cpu/mem";    nproc; free -m | sed -n 2p; df -h / | tail -1
echo "== power";      nvpmodel -q 2>/dev/null | head -2
echo "== docker";     docker info 2>/dev/null | grep -iE 'server version|runtimes' || echo "docker not usable by $(whoami)"
echo "== tailscale";  if command -v tailscale >/dev/null; then tailscale version | head -1; tailscale status 2>&1 | head -3; else echo "not installed"; fi
echo "== net";        ip -br addr | grep -v '^lo'; (curl -sS -m 5 -o /dev/null -w 'internet %{http_code}\n' https://login.tailscale.com) 2>&1
echo "== usb";        lsusb
echo "== serial/video"; ls -l /dev/ttyACM* /dev/video* 2>/dev/null
echo "== pico";       lsusb | grep -i 2e8a || echo "no pico"
echo "== adb";        if command -v adb >/dev/null; then adb devices; else echo "adb missing"; fi
echo "== temp";       cat /sys/devices/virtual/thermal/thermal_zone*/temp 2>/dev/null | head -4
EOF
