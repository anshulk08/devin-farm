# session-kit

What runs inside each Devin session VM. Contracts: `docs/CONTRACTS.md` C0 (tailnet), C1 (rig API), C6 (assertions), C11 (claim).

| File | Purpose |
|---|---|
| `farm-join.sh` | Joins the tailnet as `devin-$FARM_ID` (idempotent), writes `~/.farm/env`, puts `farm` on PATH, and runs `farm rig` |
| `farm` | CLI over the rig session API (bash 3.2+, curl, jq). Run `farm help` |
| `SKILL.md` | The playbook the session follows (macro `!farm`) |
| `claim.schema.json` | C11 structured-output schema (the canonical copy) |
| `register_playbook.sh` | Creates the playbook in Devin (or updates it with `PUT` when `FARM_PLAYBOOK_ID` is set). Prints `export FARM_PLAYBOOK_ID=…` |

## Secrets and env

Control mints a one-off, ephemeral, pre-authorized `tag:devin-session` key for each session. It passes the key to Devin create-session as `session_secrets` `TS_AUTHKEY` and `FARM_ID`, so both show up as env vars in the VM. The prompt carries the bootstrap: `git clone --depth 1 <FARM_KIT_REPO> /tmp/devin-farm && bash /tmp/devin-farm/session-kit/farm-join.sh`. Nothing here stores or prints the key.

| Var | Used by | Meaning |
|---|---|---|
| `TS_AUTHKEY`, `FARM_ID` | farm-join.sh | session secrets (required) |
| `FARM_RIG` | both | rig hostname (default `rig-1`) |
| `FARM_RIG_URL` | farm | base URL override (mocks, non-default port) |
| `FARM_PROXY` | farm | `http://localhost:1055` in userspace mode, passed as `curl -x` |
| `FARM_MOCK_NODE` | farm | sent as `X-Mock-Node`; caller identity for mock rigs only |
| `FARM_EVIDENCE_BASE` | farm, SKILL | public base URL of control; evidence is at `/e/<id>` |
| `FARM_TS_MODE` | farm-join.sh | force `kernel` or `userspace` |
| `FARM_HOME` | both | state dir, default `~/.farm` (`env`, `leases/`, `tailscaled.log`) |
| `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `FARM_PLAYBOOK_ID` | register_playbook.sh | Devin API access; set `FARM_PLAYBOOK_ID` to update in place |

`~/.farm/env` is plain `KEY=VALUE`. `farm` reads it itself, and values already set in the environment take precedence. Lease state, including fencing tokens, lives in `~/.farm/leases/<lease_id>.json`. Lease-scoped calls send `X-Fencing-Token` automatically.

## Kernel vs userspace mode

- Kernel mode is used when the user is root or has passwordless sudo and `/dev/net/tun` exists. tailscaled runs under systemd, or in the background without it. Traffic is routed normally and `FARM_PROXY` is not set.
- Userspace mode is the fallback: `tailscaled --tun=userspace-networking --outbound-http-proxy-listen=localhost:1055 --socks5-server=localhost:1055 --state=mem: --socket=~/.farm/tailscaled.sock`, run without root. Only traffic through the proxy reaches the tailnet, so `farm` uses `FARM_PROXY`. Run the CLI as `tailscale --socket="$FARM_TS_SOCKET" status`. With `--state=mem:` the node is gone after a VM restart. Re-run `farm-join.sh`, which needs a fresh key from control if the old one was already used.

## Mock usage

Against a mock rig (`farm-control serve --mock` or `rigd --mock-identity`) no tailnet is needed:
```
FARM_RIG_URL=http://127.0.0.1:<port> FARM_MOCK_NODE=devin-s-test farm devices
FARM_RIG_URL=http://127.0.0.1:<port> FARM_MOCK_NODE=devin-s-test farm lease pico-1
```
Use `FARM_HOME=$(mktemp -d)` to keep mock leases out of `~/.farm`. This also skips a `FARM_PROXY` from a real join; alternatively pass `FARM_PROXY=` (empty).
