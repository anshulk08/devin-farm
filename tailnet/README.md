# tailnet

Tailnet setup for Devin Farm (`docs/CONTRACTS.md` C0). A human with the Owner or Admin role does this once.

| File | Purpose |
|---|---|
| `policy.hujson` | Tailnet policy: tag owners, grants, team SSH, Funnel for control, plus policy `tests` |
| `acl_check.sh` | Checks from a live node that the ACL really behaves as C0 says |

## 1. Apply the policy

1. Edit `policy.hujson`: replace `"<emails>"` in `group:team` with the team's login names (`alice@example.com`, `bob@github`, …).
2. In the admin console, open **Access controls**, switch to the JSON editor, paste the file, and save. Tailscale runs the `tests` block on save and rejects the policy if a test fails. Sessions must reach only `tag:rig:8080`. Control must reach `tag:rig:8080` and `tag:rig:8081`.
3. Turn on MagicDNS and HTTPS certificates (**DNS** page). Control's Funnel needs both.

## 2. OAuth client for control (session join keys)

In the admin console, open **Settings → Trust credentials → Generate credential** and choose OAuth client:
- Scopes: `auth_keys` (write) and `devices:core` (write).
- Tag for both scopes: `tag:devin-session`.

Give the client ID and secret to control as env vars. Never commit them:
```
export TS_OAUTH_CLIENT_ID=...
export TS_OAUTH_CLIENT_SECRET=...
```
For each session, control exchanges these for an access token (`POST /api/v2/oauth/token`). It then mints a one-off, ephemeral, pre-authorized key tagged `tag:devin-session` with `expirySeconds=3600`, and passes it to the session as `TS_AUTHKEY`. When a session stops, control uses `devices:core` to delete its node.

## 3. Join rigs and control

Run these as an admin, interactively, or with an auth key that carries the tag. `autogroup:admin` owns `tag:rig` and `tag:control`.

```
# each rig (Jetson); hostname rig-<n>
sudo tailscale up --hostname=rig-1 --advertise-tags=tag:rig --ssh

# control node
sudo tailscale up --hostname=farm-control --advertise-tags=tag:control
```
Team laptops join as their users and get `group:team` access to rigs (all ports, plus SSH as `farm`) and control. A tagged node loses its user identity, so keep laptops untagged.

## 4. Check the ACL from a session

On a node joined with a `tag:devin-session` key, for example a Devin VM after `session-kit/farm-join.sh`:
```
RIG=rig-1 CONTROL=farm-control bash tailnet/acl_check.sh
```
- It picks up `FARM_PROXY` from `~/.farm/env` in userspace mode, or you can set it. Through the proxy, a port counts as open when the HTTP CONNECT tunnel succeeds.
- It expects `rig-1:8080` to be open, and `rig-1:8081`, `:22`, `:8090`, and `CONTROL:443`/`:8443` to be blocked.
- To check isolation between sessions, set `PEER=devin-s-xxxxxxxx`.
- It prints PASS/FAIL per check and exits 1 on any unexpected result.
- Use tailnet (MagicDNS) names. A Funnel URL resolved through public DNS reaches control over the internet by design.
- From a `group:team` laptop the blocked checks are expected to FAIL, because the team has full access.
