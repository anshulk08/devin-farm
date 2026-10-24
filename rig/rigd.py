"""rigd: the rig daemon. `python -m rig.rigd --help`.

Production:  python -m rig.rigd --bind 100.81.207.89 --port 8080 --control-port 8081
Mock (CI):   python -m rig.rigd --mock-drivers --mock-verifier --mock-identity --bind 127.0.0.1 --port 8080 --control-port 8081
"""
from __future__ import annotations

import argparse
import asyncio
import ipaddress
import logging
import os
import signal
from pathlib import Path

import uvicorn

from .api import create_control_app, create_session_app
from .config import load_config
from .drivers.mock import MockDriver
from .drivers.pico import PicoDriver
from .drivers.unoq import UnoQDriver
from .engine import Rig
from .identity import MockIdentity, TailscaleIdentity
from .verifier import HttpVerifier, MockVerifier

log = logging.getLogger("rigd")


def build_rig(args: argparse.Namespace) -> Rig:
    if args.mock_identity and not ipaddress.ip_address(args.bind).is_loopback:
        raise SystemExit("--mock-identity is refused unless --bind is a loopback address (127.0.0.1)")
    cfg = load_config(args.config, mock=args.mock_drivers)
    drivers = {}
    for d in cfg.devices:
        if args.mock_drivers:
            drivers[d["id"]] = MockDriver(d["id"], d, speed=args.speed)
        elif d["type"] == "pico":
            drivers[d["id"]] = PicoDriver(d["id"], d)
        else:
            drivers[d["id"]] = UnoQDriver(d["id"], d, cfg.unoq_library_allowlist)
    verifier = MockVerifier() if args.mock_verifier else HttpVerifier(cfg.verifier_url)
    identity = MockIdentity() if args.mock_identity else TailscaleIdentity(cfg.team_logins)
    if not args.mock_drivers and args.mock_verifier:
        log.warning("real drivers with a MOCK verifier: verdicts are not camera measurements")
    state_dir = Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    return Rig(cfg, drivers, verifier, identity, state_dir, mock=args.mock_drivers, speed=args.speed)


async def serve(args: argparse.Namespace) -> None:
    rig = build_rig(args)
    servers = [
        uvicorn.Server(uvicorn.Config(create_session_app(rig), host=args.bind, port=args.port,
                                      log_level="warning", access_log=False)),
        uvicorn.Server(uvicorn.Config(create_control_app(rig), host=args.bind, port=args.control_port,
                                      log_level="warning", access_log=False)),
    ]
    for s in servers:
        s.install_signal_handlers = lambda: None  # we own signals
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    rig.start()
    tasks = [asyncio.create_task(s.serve()) for s in servers]
    log.info("rigd %s up: session API %s:%d, control API %s:%d (%s drivers, %s verifier, %s identity)",
             rig.rig_id, args.bind, args.port, args.bind, args.control_port,
             "mock" if args.mock_drivers else "real", "mock" if args.mock_verifier else "http",
             "mock" if args.mock_identity else "tailscale")
    waiter = asyncio.create_task(stop.wait())
    await asyncio.wait([waiter, *tasks], return_when=asyncio.FIRST_COMPLETED)
    for s in servers:
        s.should_exit = True
    await asyncio.gather(*tasks, return_exceptions=True)
    await rig.stop()


def main() -> None:
    ap = argparse.ArgumentParser(prog="rigd", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bind", default="127.0.0.1", help="address for both ports (production: the tailnet IP, never 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8080, help="C1 session API")
    ap.add_argument("--control-port", type=int, default=8081, help="C3 control API + C4 events")
    ap.add_argument("--config", help="rig config yaml (default $FARM_RIG_CONFIG or /etc/farm/rig.yaml)")
    ap.add_argument("--state-dir", default=os.environ.get("FARM_STATE_DIR", "/var/lib/farm"),
                    help="fencing-token SQLite + evidence bundles (C7)")
    ap.add_argument("--mock-drivers", action="store_true", help="simulate boards; no hardware")
    ap.add_argument("--mock-verifier", action="store_true", help="mock rule instead of the C5 service")
    ap.add_argument("--mock-identity", action="store_true", help="X-Mock-Node header instead of whois; loopback only")
    ap.add_argument("--speed", type=float, default=1.0, help="mock timing multiplier (tests)")
    args = ap.parse_args()
    if args.bind in ("0.0.0.0", "::"):
        raise SystemExit("refusing to bind a wildcard address; bind the tailnet IP (C0)")
    if args.mock_drivers and args.state_dir == "/var/lib/farm" and not os.access("/var/lib/farm", os.W_OK):
        import tempfile
        args.state_dir = tempfile.mkdtemp(prefix="farm-rigd-")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    asyncio.run(serve(args))


if __name__ == "__main__":
    main()
