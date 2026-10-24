# Devin Farm: hardware lease + verify

You are writing firmware for a real board on the Devin Farm. You reach the board only through the `farm` CLI over the tailnet. A camera decides whether your code worked. You are done only when a camera-verified `farm verify` passes on your final commit.

Your prompt gives you `Farm ID: s-…`, `Device type: …`, maybe `Device hint: …`, and a bootstrap command. The secrets `TS_AUTHKEY` and `FARM_ID` are in your environment. Never print `TS_AUTHKEY`.

## 1. Join the tailnet

If `~/.farm/env` does not exist, run the bootstrap from your prompt:
```
git clone --depth 1 <FARM_KIT_REPO> /tmp/devin-farm && bash /tmp/devin-farm/session-kit/farm-join.sh
```
It is idempotent, so you can re-run it if `farm` reports the rig is unreachable. It puts `farm` on PATH (or use `/tmp/devin-farm/session-kit/farm`). Run `farm help` for every option and exit code.

## 2. Look before you lease

```
farm rig                 # health: online, camera_ok, verifier_online, maintenance
farm devices             # pick a free device of your Device type (prefer the Device hint)
farm describe pico-1     # READ IT: pins, how to write the program, gotchas, assertion examples
```
If `farm rig` fails with exit 3 (unreachable), wait 30 s, re-run `farm-join.sh`, and retry 3 times. If it still fails, report the rig as offline (step 9). Don't keep retrying forever.

## 3. Lease one device

```
farm lease pico-1 --ttl 600
```
- A queued lease (202) is normal. `farm lease` keeps polling and prints your queue position until the lease is granted. Let it run. If you interrupt it, resume within 30 s with `farm status <lease_id> --wait`, or you lose your slot.
- Never hold more than one lease. `farm` refuses a second one; release the first.
- The lease expires after its TTL (300 s by default, max 900) unless you use it. Any `farm run/logs/verify/renew` call renews it. The hard cap is 30 min from grant. While you think or edit for longer, `farm renew`. Release within the TTL when you finish.
- You can write code before leasing. Lease when you have something to run.

## 4. Write code, commit, push

Write the program as `describe` says (Pico: `main.py`; Uno Q: the app dir). Commit and push to the ticket repo, then take the full SHA: `git rev-parse HEAD`. The rig fetches by SHA, so the commit must be pushed before you run it.

## 5. Run it

```
RUN=$(farm run https://github.com/<org>/<repo> <sha> <path-in-repo>)
farm logs "$RUN" --follow --timeout 60
farm run-status "$RUN"      # exit 1 if failed: read error + log_tail, fix, push, re-run
```

## 6. Verify with the camera

Write assertions from the ticket's requirements into a file, for example `/tmp/assertions.json` (a JSON array of C6 assertions). Use the shapes and targets from `farm describe`:
```json
[
  {"type": "led_sequence", "target": "pico.leds", "steps": [{"on": [0,2], "ms": 500}, {"on": [1], "ms": 500}], "repeat": 3, "tol_ms": 80},
  {"type": "led_blink",    "target": "pico.led", "hz": 2.0, "duty": 0.3, "tol_pct": 10},
  {"type": "led_state",    "target": "pico.led", "state": "on"},
  {"type": "matrix_frame", "target": "unoq.matrix", "ascii": ["#...........#", ".............", ".............", "......#......", ".............", ".............", ".............", "#...........#"], "tol_cells": 2, "hold_s": 2},
  {"type": "matrix_text",  "target": "unoq.matrix", "text": "DEVIN", "scroll_cols_per_s": 10, "tol_pct": 25},
  {"type": "rgb_color",    "target": "unoq.rgb1", "color": "green"},
  {"type": "log_contains", "pattern": "READY"}
]
```
`matrix_frame.ascii` is 8 rows of 13 chars (`#` = on, `.` = off).

```
farm verify /tmp/assertions.json --duration 10
```
This prints one row per assertion: TYPE, TARGET, VERDICT, MEASURED, EXPECTED, ±UNCERTAINTY, DETAIL. Then it prints `VERDICT: PASS|FAIL` and the `evidence_id`. Exit 0 means every camera-verified assertion passed.
- `log_contains` is SELF-REPORTED. It only shows that your program printed something. It never counts as a pass and never proves the hardware did anything.
- Assert what the ticket asks for, not what your code happens to do. Don't loosen tolerances to get a pass.

## 7. Iterate

Read MEASURED against EXPECTED and the DETAIL (for example `step 2: LED 0 still on`). Fix the code, commit, push, then repeat `farm run` with the new SHA and `farm verify`. Only the final SHA's verify counts.

## 8. Release (always)

```
farm release
```
Release as soon as you finish verifying, and also on failure, on giving up, or before you stop for any reason. Other sessions are queued behind you.

## 9. Report

Open a PR with the code. In the PR description, include the evidence link `${FARM_EVIDENCE_BASE}/e/<evidence_id>` if `FARM_EVIDENCE_BASE` is set; otherwise include the evidence id. Paste the results table from the final verify.

Then give your final structured output (claim schema):
```json
{"claimed_success": true, "confidence": 0.9, "final_sha": "<40-hex sha>", "evidence_ids": ["<evidence_id>"], "notes": "led_sequence passed: 3/3 camera-verified"}
```
- Set `claimed_success: true` ONLY if a camera-verified `farm verify` passed (exit 0) on `final_sha`. Self-reported (`log_contains`) results, a clean build, or logs are never enough.
- Otherwise set `claimed_success: false`. In `notes`, say what failed and include the last measured vs expected, or say "rig offline" / "never granted a lease".
- Put every evidence id from the final SHA's verifies in `evidence_ids`.

## Errors

`farm` prints `error: <code>: <message>` and `next: <call>`. Do what `next` says.

| Situation | What to do |
|---|---|
| 202 queued | Normal. Keep polling (`farm lease` does it). Don't lease a second device to skip the queue. |
| 409 `busy` | Someone else holds the device. Pick another free device of your type, or lease anyway and wait in the queue. |
| 409 `device_offline` / `maintenance` | Pick another device of your type (`farm devices`). If none exists, wait 60 s and check `farm rig`. After 10 min, report the rig as offline. |
| 403 `stale_token` / `not_holder` | Your lease ended (expired, revoked, or taken over). `farm` forgets it. Lease again with `farm lease <device>`, then re-run and re-verify. |
| 403 `not_on_tailnet` | Re-run `farm-join.sh`, then `farm rig`. |
| 429 `rate_limited` | Wait 10 s and retry. Poll less often. |
| 422 `lint_failed` | Fix the program per the message (see `describe`), push, re-run. |
| run `failed` (`build_failed`) | Read `farm run-status` (error + log_tail), fix, push, re-run. |
| exit 3, rig unreachable | Re-run `farm-join.sh`, check `tailscale status`, retry. Rig offline: report it, `claimed_success: false`. |
| verify FAIL with "not visible" / camera detail | It's a rig problem, not your code: retry once after 30 s; if it persists, report it. |
