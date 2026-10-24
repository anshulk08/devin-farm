#!/usr/bin/env bash
# Idempotent rig provisioning (run with sudo on the Jetson): udev rules + /dev/farm symlinks, /etc/farm, /var/lib/farm.
# Not yet covered: usbguard allowlist, the `farm` user, farm-verifier unit (WORKSPLIT lane A item 2).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
RULES=/etc/udev/rules.d/60-farm.rules
TMP=$(mktemp)
cat > "$TMP" <<'RULES'
# Farm rig devices. Managed by rig/provision.sh.
# Uno Q: adb needs the USB device node writable by plugdev; ttyACM gets the stable symlink.
SUBSYSTEM=="usb", ATTR{idVendor}=="2341", ATTR{idProduct}=="0078", MODE="0660", GROUP="plugdev", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", ATTRS{idProduct}=="0078", MODE="0660", GROUP="plugdev", SYMLINK+="farm/unoq-1"
# Logitech BRIO: first video node is the capture stream (index 0); others are metadata/IR.
SUBSYSTEM=="video4linux", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="085e", ATTR{index}=="0", SYMLINK+="farm/cam0"
# Raspberry Pi Pico (MicroPython CDC serial), for later.
SUBSYSTEM=="tty", ATTRS{idVendor}=="2e8a", MODE="0660", GROUP="dialout", SYMLINK+="farm/pico-1"
RULES
if ! cmp -s "$TMP" "$RULES" 2>/dev/null; then install -m 644 "$TMP" "$RULES"; echo "updated $RULES"; fi
rm -f "$TMP"
mkdir -p /etc/farm /var/lib/farm
id guru >/dev/null 2>&1 && chown guru:guru /var/lib/farm
usermod -aG plugdev,dialout,video guru 2>/dev/null || true
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --subsystem-match=tty --subsystem-match=video4linux --action=add
udevadm settle
sudo -u guru adb kill-server >/dev/null 2>&1 || true
sudo -u guru adb start-server >/dev/null 2>&1 || true
echo "symlinks:"; ls -l /dev/farm 2>/dev/null || echo "  (none present)"
sudo -u guru adb devices
