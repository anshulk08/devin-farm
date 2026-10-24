#!/usr/bin/env bash
# farm-join.sh: join this Devin VM to the Devin Farm tailnet (docs/CONTRACTS.md C0).
# Idempotent: safe to re-run. Needs TS_AUTHKEY and FARM_ID (session secrets from control).
#
# Kernel mode when passwordless sudo (or root) and /dev/net/tun exist; otherwise
# userspace networking with an HTTP/SOCKS5 proxy on localhost:1055 (FARM_PROXY).
# Force a mode with FARM_TS_MODE=kernel|userspace.
# Writes ~/.farm/env (read by the `farm` CLI), then runs `farm rig` as a health check.
set -euo pipefail
umask 077

log() { echo "farm-join: $*" >&2; }
die() { log "error: $*"; exit 1; }

[ -n "${TS_AUTHKEY:-}" ] || die "TS_AUTHKEY is not set. Control delivers it as a session secret; ask the operator to restart the session."
[ -n "${FARM_ID:-}" ] || die "FARM_ID is not set. Control delivers it as a session secret (format s-<8 hex>)."
case "$FARM_ID" in
  s-*) ;;
  *) log "warning: FARM_ID '$FARM_ID' does not look like s-<8 hex>" ;;
esac

WANT_HOST="devin-$FARM_ID"
FARM_HOME="${FARM_HOME:-$HOME/.farm}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROXY_ADDR="localhost:1055"
mkdir -p "$FARM_HOME/bin"
export PATH="$FARM_HOME/bin:$PATH"

# ---- privileges and mode -----------------------------------------------------

HAVE_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  HAVE_ROOT=1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  HAVE_ROOT=1
fi

asroot() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi
}

MODE=${FARM_TS_MODE:-}
if [ -z "$MODE" ]; then
  if [ "$HAVE_ROOT" = 1 ] && [ -c /dev/net/tun ]; then MODE=kernel; else MODE=userspace; fi
fi
case "$MODE" in
  kernel) [ "$HAVE_ROOT" = 1 ] || die "FARM_TS_MODE=kernel needs root or passwordless sudo" ;;
  userspace) ;;
  *) die "FARM_TS_MODE must be kernel or userspace" ;;
esac
SOCK="${FARM_TS_SOCKET:-$FARM_HOME/tailscaled.sock}"
log "mode: $MODE"

# ---- dependencies ------------------------------------------------------------

arch() {
  case "$(uname -m)" in
    x86_64 | amd64) echo amd64 ;;
    aarch64 | arm64) echo arm64 ;;
    armv7l | armv6l) echo arm ;;
    i386 | i686) echo 386 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
}

install_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  log "installing jq"
  if [ "$HAVE_ROOT" = 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then
      asroot env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null 2>&1 ||
        { asroot apt-get update -qq >/dev/null 2>&1 && asroot env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq >/dev/null 2>&1; } || true
    elif command -v dnf >/dev/null 2>&1; then
      asroot dnf install -y -q jq >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then
      asroot apk add -q jq >/dev/null 2>&1 || true
    fi
  fi
  if ! command -v jq >/dev/null 2>&1; then
    [ "$(uname -s)" = Linux ] || die "please install jq"
    curl -fsSL -o "$FARM_HOME/bin/jq" "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-$(arch)" ||
      die "could not download jq"
    chmod 755 "$FARM_HOME/bin/jq"
  fi
}

install_tailscale() {
  if command -v tailscale >/dev/null 2>&1 && command -v tailscaled >/dev/null 2>&1; then return 0; fi
  if [ "$HAVE_ROOT" = 1 ]; then
    log "installing tailscale (install.sh)"
    curl -fsSL https://tailscale.com/install.sh | asroot sh >/dev/null || die "tailscale install failed"
  else
    # No root: unpack the static release into ~/.farm/bin (userspace mode needs no root).
    [ "$(uname -s)" = Linux ] || die "install tailscale first (no sudo available)"
    local a tgz
    a=$(arch)
    tgz=$(curl -fsSL 'https://pkgs.tailscale.com/stable/?mode=json' | grep -o "\"tailscale_[0-9.]*_${a}\\.tgz\"" | head -n1 | tr -d '"')
    [ -n "$tgz" ] || die "could not find a tailscale release for $a"
    log "installing $tgz into $FARM_HOME/bin (no sudo)"
    curl -fsSL "https://pkgs.tailscale.com/stable/$tgz" | tar -xz -C "$FARM_HOME" || die "tailscale download failed"
    cp "$FARM_HOME/${tgz%.tgz}/tailscale" "$FARM_HOME/${tgz%.tgz}/tailscaled" "$FARM_HOME/bin/"
    rm -rf "${FARM_HOME:?}/${tgz%.tgz}"
  fi
  command -v tailscaled >/dev/null 2>&1 || die "tailscaled not found after install"
}

install_jq
install_tailscale

# ---- daemon --------------------------------------------------------------------

ts() {
  if [ "$MODE" = userspace ]; then tailscale --socket="$SOCK" "$@"; else asroot tailscale "$@"; fi
}

daemon_up() { ts status --json >/dev/null 2>&1; }

wait_daemon() {
  local tries=0
  while [ "$tries" -lt 30 ]; do
    daemon_up && return 0
    tries=$((tries + 1))
    sleep 0.5
  done
  die "tailscaled did not start; see $FARM_HOME/tailscaled.log"
}

start_daemon() {
  if daemon_up; then return 0; fi
  if [ "$MODE" = userspace ]; then
    log "starting tailscaled (userspace networking, proxy on $PROXY_ADDR)"
    rm -f "$SOCK"
    env -u TS_AUTHKEY nohup tailscaled --tun=userspace-networking \
      --outbound-http-proxy-listen="$PROXY_ADDR" --socks5-server="$PROXY_ADDR" \
      --state=mem: --socket="$SOCK" >>"$FARM_HOME/tailscaled.log" 2>&1 &
    echo $! >"$FARM_HOME/tailscaled.pid"
  elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 &&
    asroot systemctl enable --now tailscaled >/dev/null 2>&1; then
    log "started tailscaled via systemd"
  else
    log "starting tailscaled in the background (no systemd)"
    asroot mkdir -p /var/lib/tailscale /var/run/tailscale
    asroot env -u TS_AUTHKEY nohup tailscaled --state=/var/lib/tailscale/tailscaled.state \
      --socket=/var/run/tailscale/tailscaled.sock >>"$FARM_HOME/tailscaled.log" 2>&1 &
    echo $! >"$FARM_HOME/tailscaled.pid"
  fi
  wait_daemon
}

start_daemon

# ---- join --------------------------------------------------------------------

status_json=$(ts status --json 2>/dev/null || echo '{}')
backend=$(printf '%s' "$status_json" | jq -r '.BackendState // empty')
self_host=$(printf '%s' "$status_json" | jq -r '.Self.HostName // empty')
self_dns=$(printf '%s' "$status_json" | jq -r '.Self.DNSName // empty')

if [ "$backend" = Running ] && { [ "$self_host" = "$WANT_HOST" ] || [ "${self_dns%%.*}" = "$WANT_HOST" ]; }; then
  log "already on the tailnet as $WANT_HOST"
else
  if [ "$backend" = Running ]; then
    log "logged in as '${self_host:-?}', not $WANT_HOST; logging out first"
    ts logout >/dev/null 2>&1 || true
  fi
  log "joining the tailnet as $WANT_HOST"
  ts up --authkey="$TS_AUTHKEY" --hostname="$WANT_HOST" --timeout=90s >/dev/null ||
    die "tailscale up failed (expired or used key? control mints a one-off key per session)"
fi

# ---- ~/.farm/env -------------------------------------------------------------

{
  echo "FARM_ID=$FARM_ID"
  echo "FARM_RIG=${FARM_RIG:-rig-1}"
  echo "FARM_TS_MODE=$MODE"
  if [ "$MODE" = userspace ]; then
    echo "FARM_PROXY=http://$PROXY_ADDR"
    echo "FARM_TS_SOCKET=$SOCK"
  fi
  if [ -n "${FARM_EVIDENCE_BASE:-}" ]; then echo "FARM_EVIDENCE_BASE=$FARM_EVIDENCE_BASE"; fi
} >"$FARM_HOME/env.tmp"
mv "$FARM_HOME/env.tmp" "$FARM_HOME/env"
log "wrote $FARM_HOME/env"

# ---- put `farm` on PATH ------------------------------------------------------

FARM_BIN=
if [ -x "$SCRIPT_DIR/farm" ]; then
  FARM_BIN="$SCRIPT_DIR/farm"
  if [ "$HAVE_ROOT" = 1 ]; then
    asroot ln -sf "$FARM_BIN" /usr/local/bin/farm
  else
    mkdir -p "$HOME/.local/bin"
    ln -sf "$FARM_BIN" "$HOME/.local/bin/farm"
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) log "add to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
  fi
elif command -v farm >/dev/null 2>&1; then
  FARM_BIN=$(command -v farm)
fi

# ---- summary + health check --------------------------------------------------

echo "tailscale ($MODE mode):"
ts status 2>/dev/null | sed -n '1,15p' || true
if [ "$MODE" = userspace ]; then
  echo "proxy: FARM_PROXY=http://$PROXY_ADDR (the farm CLI uses it automatically)"
fi

if [ -n "$FARM_BIN" ]; then
  echo "health check: farm rig"
  rc=0
  "$FARM_BIN" rig || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "warning: 'farm rig' failed (exit $rc). The tailnet is joined; the rig may be offline. Retry in 30 s."
  fi
else
  log "farm CLI not found next to this script or on PATH; skipping health check"
fi
