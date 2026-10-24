"""`farm-control serve [--mock]`, `farm-control record --out run.ndjson`, `farm-control doctor`."""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import os
import signal
import sys
import time
from typing import Any

import httpx

from .app import Control, create_operator_app, create_public_app
from .config import Settings
from .devin import DevinClient
from .events import iter_sse
from .serving import bind, serve
from .tailnet import CliPeerSource, TailscaleAPI
from .tickets import TicketCatalog


async def _serve(args: argparse.Namespace) -> int:
    settings = Settings.from_env()
    if args.operator_port is not None:
        settings = dataclasses.replace(settings, operator_port=args.operator_port)
    if args.public_port is not None:
        settings = dataclasses.replace(settings, public_port=args.public_port)
    stack = None
    if args.mock:
        from .mock import mock_settings, start_mock_stack
        stack = await start_mock_stack(speed=float(os.environ.get("FARM_MOCK_SPEED", "1")))
        settings = mock_settings(settings, stack)
        peers: Any = stack.peers
    else:
        peers = CliPeerSource()
    settings.validate()

    ctl = Control(settings, peers)
    await ctl.start()
    operator = await serve(create_operator_app(ctl), bind(settings.operator_host, settings.operator_port), args.log_level)
    public = await serve(create_public_app(ctl), bind(settings.public_host, settings.public_port), args.log_level)
    print(f"farm-control {settings.mode.upper()} mode", flush=True)
    print(f"  operator  {operator.url}   (expose: tailscale serve --bg --https=8443 {operator.url})", flush=True)
    print(f"  public    {public.url}   (expose: tailscale funnel --bg --https=443 {public.url})", flush=True)
    if stack:
        print(f"  mock rigs {', '.join(f'{h}={u}' for h, u in stack.world.rig_urls.items())}", flush=True)
        print(f"  mock cloud (Devin v3 + Tailscale v2) {stack.cloud.url}", flush=True)
    print(f"  rigs      {', '.join(c.rig_id for c in ctl.registry.all()) or 'none discovered yet'}", flush=True)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    print("shutting down", flush=True)
    await operator.stop()
    await public.stop()
    await ctl.stop()
    if stack:
        await stack.stop()
    return 0


async def _record(args: argparse.Namespace) -> int:
    headers = {"Tailscale-User-Login": args.login} if args.login else {}
    deadline = time.monotonic() + args.duration if args.duration else None
    count = 0
    timeout = httpx.Timeout(10.0, read=60.0)
    with open(args.out, "a", encoding="utf-8") as out:
        async with httpx.AsyncClient(timeout=timeout) as http, http.stream("GET", args.url, headers=headers) as r:
            if r.status_code != 200:
                print(f"record: HTTP {r.status_code}: {(await r.aread()).decode(errors='replace')}", file=sys.stderr)
                return 1
            async for name, data in iter_sse(r.aiter_lines()):
                payload = json.loads(data)
                out.write(json.dumps({"ts": payload.get("ts", time.time()), "event": name, "data": payload},
                                     separators=(",", ":")) + "\n")
                out.flush()
                count += 1
                if deadline and time.monotonic() > deadline:
                    break
    print(f"record: {count} events -> {args.out}", file=sys.stderr)
    return 0


async def _doctor(_: argparse.Namespace) -> int:
    s = Settings.from_env()
    failed = False

    def report(status: str, name: str, detail: str = "") -> None:
        nonlocal failed
        failed |= status == "FAIL"
        print(f"{status:4} {name}{': ' + detail if detail else ''}", flush=True)

    try:
        s.validate()
        report("PASS", "config", f"operator {s.operator_host}:{s.operator_port}, public {s.public_host}:{s.public_port}")
    except ValueError as exc:
        report("FAIL", "config", str(exc))
    if s.operator_auth == "tailscale" and not s.team_logins:
        report("FAIL", "FARM_TEAM_LOGINS", "empty: the operator API would refuse everyone")
    else:
        report("PASS", "FARM_TEAM_LOGINS", f"{len(s.team_logins)} login(s)")
    report("PASS" if s.public_url else "WARN", "FARM_PUBLIC_URL", s.public_url or "unset: evidence links are relative")

    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as http:
        try:
            peers = await CliPeerSource().peers()
            rigs = [p for p in peers if s.rig_tag in p.tags]
            report("PASS", "tailscale status", f"{len(peers)} peers, {len(rigs)} with {s.rig_tag}")
            for p in rigs:
                url = f"http://{p.ipv4()}:{s.rig_control_port}/v1/state"
                if not p.online:
                    report("FAIL", f"rig {p.hostname}", "offline in tailscale status")
                    continue
                try:
                    r = await http.get(url)
                    r.raise_for_status()
                    st = r.json()
                    report("PASS", f"rig {p.hostname}", f"{len(st.get('devices', []))} devices, "
                                                         f"camera ok={st.get('camera', {}).get('ok')}")
                except (httpx.HTTPError, ValueError) as exc:
                    report("FAIL", f"rig {p.hostname}", f"{url}: {exc}")
            if not rigs:
                report("WARN", "rigs", f"no peers tagged {s.rig_tag} yet")
        except Exception as exc:
            report("FAIL", "tailscale status", str(exc))

        if s.devin_configured:
            try:
                await DevinClient(s.devin_api_base, s.devin_api_key, s.devin_org_id, http).list_sessions(first=1)
                report("PASS", "Devin API", f"{s.devin_api_base} org {s.devin_org_id}")
            except Exception as exc:
                report("FAIL", "Devin API", str(exc))
        else:
            report("FAIL", "Devin API", "DEVIN_API_KEY / DEVIN_ORG_ID unset")
        report("PASS" if s.playbook_id else "WARN", "FARM_PLAYBOOK_ID",
               s.playbook_id or "unset: run session-kit/register_playbook.sh")

        if s.tailscale_api_configured:
            try:
                devices = await TailscaleAPI(s.ts_api_base, s.ts_client_id, s.ts_client_secret, http,
                                             s.ts_tailnet).devices()
                report("PASS", "Tailscale API (OAuth)", f"{len(devices)} devices visible")
            except Exception as exc:
                report("FAIL", "Tailscale API (OAuth)", str(exc))
        else:
            report("FAIL", "Tailscale API (OAuth)", "TS_OAUTH_CLIENT_ID / TS_OAUTH_CLIENT_SECRET unset")

    tickets = TicketCatalog(s.tickets_dir).list()
    report("PASS" if tickets else "WARN", "tickets", f"{len(tickets)} under {s.tickets_dir}")
    report("PASS" if s.claim_schema_path.is_file() else "WARN", "claim schema", str(s.claim_schema_path))
    report("PASS" if s.web_dist.is_dir() else "WARN", "operator web build", str(s.web_dist))
    report("PASS" if s.web_public_dist.is_dir() else "WARN", "public web build", str(s.web_public_dist))
    try:
        s.var_dir.mkdir(parents=True, exist_ok=True)
        probe = s.var_dir / ".doctor"
        probe.write_text("ok")
        probe.unlink()
        report("PASS", "var dir", str(s.var_dir))
    except OSError as exc:
        report("FAIL", "var dir", str(exc))
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="farm-control", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("serve", help="run the operator and public servers")
    sp.add_argument("--mock", action="store_true", help="mock rigs, mock Devin API, mock Tailscale API (badged MOCK)")
    sp.add_argument("--operator-port", type=int)
    sp.add_argument("--public-port", type=int)
    sp.add_argument("--log-level", default=os.environ.get("FARM_LOG_LEVEL", "warning"))
    rp = sub.add_parser("record", help="append the live event stream to an ndjson file (for replays)")
    rp.add_argument("--out", required=True)
    rp.add_argument("--url", default="http://127.0.0.1:8700/api/events")
    rp.add_argument("--login", default=os.environ.get("FARM_RECORD_LOGIN", ""),
                    help="Tailscale-User-Login to present when connecting locally (not via tailscale serve)")
    rp.add_argument("--duration", type=float, default=0.0, help="stop after N seconds (0 = until interrupted)")
    sub.add_parser("doctor", help="check configuration, tailnet, rigs, Devin and Tailscale API access")
    args = p.parse_args(argv)
    logging.basicConfig(level=getattr(args, "log_level", "warning").upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    runner = {"serve": _serve, "record": _record, "doctor": _doctor}[args.cmd]
    try:
        return asyncio.run(runner(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
