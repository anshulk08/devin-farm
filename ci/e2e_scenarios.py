"""Contract-level scenarios against a rigd (mock or real). Stdlib only.

Scenarios (docs/CONTRACTS.md C1/C2):
  1. lease -> run -> verify -> release on a free device
  2. second lease on the same device is queued (202, position 1), granted after release
  3. stale fencing token is rejected (403 stale_token)
  4. a different node cannot use the holder's lease (403 not_holder)  [needs --mock-identity or two nodes]
With --mock-identity, requests carry X-Mock-Node (rigd --mock-identity, WORKSPLIT lane A item 6).
Against a real rig all requests come from this machine's tailnet identity, so scenario 4 is skipped.
"""
import argparse, json, sys, time, urllib.request, urllib.error

MOCK = False

def call(method, url, body=None, headers=None, node="sess-a"):
    headers = dict(headers or {})
    if MOCK:
        headers["X-Mock-Node"] = node
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True); ap.add_argument("--mock-identity", action="store_true")
    ap.add_argument("--device", default="pico-1")
    ap.add_argument("--repo", default="https://example.invalid/tickets.git")
    ap.add_argument("--sha", default="0" * 40); ap.add_argument("--path", default="pico/led-sequence")
    a = ap.parse_args(); B = a.base; ok = True
    global MOCK; MOCK = a.mock_identity

    def check(name, cond, detail=""):
        nonlocal ok
        print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if detail and not cond else ""))
        ok &= bool(cond)

    s, devs = call("GET", f"{B}/v1/devices")
    check("devices listed", s == 200 and any(d.get("id") == a.device for d in devs), devs)

    s, l1 = call("POST", f"{B}/v1/leases", {"device": a.device, "wait_s": 5})
    check("lease granted", s == 200 and "token" in l1, l1)
    if s != 200:
        sys.exit(1)
    H = {"X-Fencing-Token": str(l1["token"])}

    s, r = call("POST", f"{B}/v1/leases/{l1['lease_id']}/run", {"repo_url": a.repo, "sha": a.sha, "path": a.path}, H)
    check("run accepted", s == 202 and "run_id" in r, r)
    if s == 202:
        st = {}
        for _ in range(60):
            _, st = call("GET", f"{B}/v1/runs/{r['run_id']}")
            if st.get("state") in ("running", "failed", "stopped"):
                break
            time.sleep(1)
        check("run reaches running", st.get("state") == "running", st)
    if MOCK:
        s, e = call("POST", f"{B}/v1/leases/{l1['lease_id']}/renew", {}, H, node="sess-b")
        check("other node rejected (not_holder)", s == 403 and e.get("error", {}).get("code") == "not_holder", e)

    s, v = call("POST", f"{B}/v1/leases/{l1['lease_id']}/verify",
                {"assertions": [{"type": "led_blink", "target": "pico.led", "hz": 2.0, "tol_pct": 10}], "duration_s": 3}, H)
    check("verify accepted", s == 202 and "verify_id" in v, v)
    if s == 202:
        s, res = call("GET", f"{B}/v1/verify/{v['verify_id']}?wait=25")
        results = res.get("results") or []
        check("verify done with measured values", res.get("state") == "done" and results
              and all("measured" in x and "uncertainty" in x for x in results), res)

    s, l2 = call("POST", f"{B}/v1/leases", {"device": a.device, "wait_s": 1}, node="sess-b")
    check("second requester queued", s == 202 and l2.get("position") == 1, l2)

    s, _ = call("POST", f"{B}/v1/leases/{l1['lease_id']}/release", {}, H)
    check("release", s == 200)

    granted = None
    for _ in range(30):
        s, st = call("GET", f"{B}/v1/leases/{l2.get('lease_id')}", node="sess-b")
        if st.get("state") == "active":
            granted = st; break
        time.sleep(1)
    check("queued requester granted after reset", granted is not None and granted.get("token", 0) > l1["token"], granted)

    s, e = call("POST", f"{B}/v1/leases/{l1['lease_id']}/renew", {}, H)
    check("stale token rejected", s == 403 and e.get("error", {}).get("code") in ("stale_token", "not_holder"), e)

    if granted:
        call("POST", f"{B}/v1/leases/{l2['lease_id']}/release", {}, {"X-Fencing-Token": str(granted["token"])}, node="sess-b")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
