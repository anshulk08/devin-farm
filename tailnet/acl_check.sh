#!/usr/bin/env bash
# acl_check.sh: empirically check the C0 ACL from the node it runs on (normally a
# tag:devin-session node). Expects: rig :8080 reachable; rig :8081, :22, :8090,
# control :443, :8443 and (optional) another session's :8080 blocked.
#
#   RIG=rig-1 CONTROL=farm-control FARM_PROXY=http://localhost:1055 PEER=devin-s-xxxxxxxx bash tailnet/acl_check.sh
#
# RIG defaults to rig-1. CONTROL and PEER are optional; FARM_PROXY defaults to the value in
# ~/.farm/env. Use tailnet (MagicDNS) names: a Funnel hostname resolved through public
# DNS reaches control over the internet, not the tailnet, and is out of scope here.
# Exit 0 if every check matches expectations, 1 otherwise.
set -uo pipefail

if [ -z "${FARM_PROXY+x}" ] && [ -f "${FARM_HOME:-$HOME/.farm}/env" ]; then
  FARM_PROXY=$(sed -n 's/^FARM_PROXY=//p' "${FARM_HOME:-$HOME/.farm}/env" | tr -d "\"'")
fi
RIG=${RIG:-rig-1}
CONTROL=${CONTROL:-}
PEER=${PEER:-}
PROXY=${FARM_PROXY:-}
TIMEOUT=${TIMEOUT:-3}
failures=0

# probe host port -> prints "open" or "blocked(<why>)"
# Through the userspace proxy we use an HTTP CONNECT tunnel: the CONNECT succeeds (200)
# only if tailscaled could open the TCP connection, i.e. the ACL allowed it.
# Direct (kernel mode): any reply, even a non-HTTP one (SSH banner, TLS), means the TCP
# connection was accepted; refused (7) or timed out (28) means blocked.
probe() {
  local host=$1 port=$2 out rc=0 code connect
  if [ -n "$PROXY" ]; then
    out=$(curl -s -o /dev/null -m "$TIMEOUT" -p -x "$PROXY" -w '%{http_code} %{http_connect}' "http://$host:$port/" 2>/dev/null) || rc=$?
    connect=${out#* }
    if [ "$connect" = 200 ]; then echo open; else echo "blocked(connect=${connect:-000},curl=$rc)"; fi
    return 0
  fi
  out=$(curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}' "http://$host:$port/" 2>/dev/null) || rc=$?
  code=$out
  case "$rc" in
    0) echo open ;;
    6) echo "unresolved" ;;
    7) echo "blocked(refused)" ;;
    28) echo "blocked(timeout)" ;;
    *) echo "open(curl=$rc,http=${code:-000})" ;; # connected but not HTTP, e.g. SSH/TLS
  esac
}

check() { # expect(open|blocked) host port label
  local expect=$1 host=$2 port=$3 label=$4 got verdict
  got=$(probe "$host" "$port")
  case "$expect:$got" in
    open:open*) verdict=PASS ;;
    blocked:blocked*) verdict=PASS ;;
    *) verdict=FAIL && failures=$((failures + 1)) ;;
  esac
  printf '%-4s %-28s expect %-7s got %s\n' "$verdict" "$label" "$expect" "$got"
}

echo "acl_check from $(hostname) via ${PROXY:-direct routing}, timeout ${TIMEOUT}s"
check open "$RIG" 8080 "$RIG:8080 session API"
check blocked "$RIG" 8081 "$RIG:8081 control API"
check blocked "$RIG" 22 "$RIG:22 ssh"
check blocked "$RIG" 8090 "$RIG:8090 verifier"
if [ -n "$CONTROL" ]; then
  check blocked "$CONTROL" 443 "$CONTROL:443"
  check blocked "$CONTROL" 8443 "$CONTROL:8443"
else
  echo "SKIP control checks (set CONTROL=<control tailnet host>)"
fi
if [ -n "$PEER" ]; then
  check blocked "$PEER" 8080 "$PEER:8080 other session"
fi

if [ "$failures" -gt 0 ]; then
  echo "acl_check: $failures unexpected result(s)"
  exit 1
fi
echo "acl_check: OK"
