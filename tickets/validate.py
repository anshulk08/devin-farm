#!/usr/bin/env python3
"""Validate tickets through the real rig API: acquire -> run reference -> verify -> release.
The reference must PASS its assertions (exit 0 only if every ticket passes).

  tickets/validate.py --base http://100.81.207.89:8080 --repo https://github.com/org/ref.git --sha <40hex> [--mock-identity] [ticket ...]

`--repo/--sha` is a git repo whose `<ticket>/reference` directories hold the reference solutions
(the private branch, C9). Stdlib only."""
import argparse, json, sys, time, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def call(method, url, body=None, headers=None, node=None):
    headers = dict(headers or {})
    if node:
        headers["X-Mock-Node"] = node
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def validate(base, repo, sha, ticket, node):
    import re
    cfg = (HERE / ticket / "farm.yaml").read_text()
    dtype = re.search(r"device_type:\s*(\w+)", cfg).group(1)
    timeout = int(re.search(r"timeout_s:\s*(\d+)", cfg).group(1))
    assertions = json.loads((HERE / ticket / "assertions.json").read_text())
    s, devs = call("GET", f"{base}/v1/devices", node=node)
    dev = next((d for d in devs if d["type"] == dtype and d["status"] != "offline"), None) if s == 200 else None
    if not dev:
        return False, f"no online {dtype} device ({s} {devs})"
    s, lease = call("POST", f"{base}/v1/leases", {"device": dev["id"], "wait_s": 25}, node=node)
    while s == 202:
        time.sleep(2)
        s, st = call("GET", f"{base}/v1/leases/{lease['lease_id']}", node=node)
        if st.get("state") == "active":
            lease, s = {**lease, **st}, 200
    if s != 200:
        return False, f"lease failed: {s} {lease}"
    H = {"X-Fencing-Token": str(lease["token"])}
    try:
        s, r = call("POST", f"{base}/v1/leases/{lease['lease_id']}/run",
                    {"repo_url": repo, "sha": sha, "path": f"{ticket}/reference"}, H, node)
        if s != 202:
            return False, f"run rejected: {s} {r}"
        end = time.time() + timeout + 300
        while time.time() < end:
            _, st = call("GET", f"{base}/v1/runs/{r['run_id']}", node=node)
            if st.get("state") in ("running", "failed", "stopped"):
                break
            time.sleep(2)
        if st.get("state") != "running":
            return False, f"run ended {st}"
        s, v = call("POST", f"{base}/v1/leases/{lease['lease_id']}/verify",
                    {"assertions": assertions, "duration_s": 12}, H, node)
        if s != 202:
            return False, f"verify rejected: {s} {v}"
        for _ in range(4):
            _, res = call("GET", f"{base}/v1/verify/{v['verify_id']}?wait=25", node=node)
            if res.get("state") != "pending":
                break
        results = res.get("results") or []
        bad = [x for x in results if not x.get("passed")]
        return (res.get("state") == "done" and results and not bad), json.dumps(bad or results)[:600]
    finally:
        call("POST", f"{base}/v1/leases/{lease['lease_id']}/release", {}, H, node)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True); ap.add_argument("--mock-identity", action="store_true")
    ap.add_argument("tickets", nargs="*")
    a = ap.parse_args()
    names = a.tickets or sorted(p.parent.name for p in HERE.glob("*/assertions.json"))
    ok = True
    for t in names:
        passed, detail = validate(a.base, a.repo, a.sha, t, "validator" if a.mock_identity else None)
        print(("PASS " if passed else "FAIL ") + t + ("" if passed else "  " + detail))
        ok &= bool(passed)
    sys.exit(0 if ok else 1)
