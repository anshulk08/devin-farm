"""farm-verifier: show an image on the Uno Q matrix, calibrate the camera to it, verify what it shows.

    farm-verifier show images/devin-hexes.txt         # compile + start on the Uno Q (boot default)
    farm-verifier calibrate                           # shows the calibration image, fits the grid, re-shows the default image
    farm-verifier observe --expect images/devin-hexes.txt
    farm-verifier observe --assertions a.json         # C6 list or single object
    farm-verifier serve                               # C5 HTTP service on 127.0.0.1:8090 (needs the `service` extra)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from . import evidence, grid, unoq
from .assertions import evaluate
from .capture import DEFAULT_EXPOSURE, Camera, find_camera
from .matrix import Calibration, calibrate

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CAL = ROOT / "state" / "unoq-1.calibration.json"
CALIBRATION_IMAGE = ROOT / "images" / "calibrate.txt"  # all lit except r0c0, which fixes orientation


def _camera(args) -> Camera:
    return Camera(args.camera or find_camera(), exposure=args.exposure)


def cmd_show(args) -> int:
    g = grid.load(args.image)
    print("\n".join(grid.to_ascii(g)))
    print(unoq.show(g, serial=args.serial, make_default=not args.no_default).splitlines()[-1])
    return 0


def cmd_calibrate(args) -> int:
    if not args.no_show:
        print("showing calibration image on the Uno Q ...", flush=True)
        unoq.show(grid.load(CALIBRATION_IMAGE), serial=args.serial, make_default=False)
        time.sleep(1.0)
    with _camera(args) as cam:
        frames = [img for _, img in cam.frames(args.duration)]
    cal = calibrate(frames, exposure=args.exposure)
    cal.save(args.calibration)
    print(json.dumps({"ok": True, "calibration": str(args.calibration), "pitch_px": round(cal.pitch_px, 2),
                      "reproj_px": round(cal.reproj_px, 3), "off_level": round(cal.off_level, 1),
                      "on_level_min": round(float(cal.on_level.min()), 1), "roi": cal.roi()}))
    if not args.no_show and args.restore:
        unoq.show(grid.load(args.restore), serial=args.serial)
        print(f"restored {args.restore}")
    return 0


def _load_assertions(args) -> list[dict]:
    if args.expect:
        return [{"type": "matrix_frame", "target": "unoq.matrix", "ascii": grid.to_ascii(grid.load(args.expect)),
                 "tol_cells": args.tol_cells, "hold_s": args.hold_s}]
    data = json.loads(Path(args.assertions).read_text())
    return data if isinstance(data, list) else [data]


def cmd_observe(args) -> int:
    assertions = _load_assertions(args)
    cal = Calibration.load(args.calibration) if Path(args.calibration).exists() else None
    if cal is not None and cal.exposure is not None and cal.exposure != args.exposure:
        print(f"warning: calibrated at exposure {cal.exposure}, observing at {args.exposure}", file=sys.stderr)
    with _camera(args) as cam:
        frames = cam.frames(args.duration)
        bgr = cam.last_bgr
    results = [evaluate(a, frames, cal) for a in assertions]
    if args.evidence_dir and cal is not None and bgr is not None:
        for r in results:
            if r["type"] == "matrix_frame" and r.get("measured"):
                r["evidence_frame"] = str(evidence.write(args.evidence_dir, bgr, cal, r))
    print(json.dumps({"results": results}, indent=1))
    return 0 if all(r["passed"] for r in results) else 1


def cmd_serve(args) -> int:
    from .service import serve

    serve(args.host, args.port, args.camera, args.exposure, args.serial)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="farm-verifier", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--camera", help="V4L2 device (default: first Logitech/BRIO node)")
    p.add_argument("--exposure", type=int, default=DEFAULT_EXPOSURE, help="manual exposure, 100 µs units")
    p.add_argument("--serial", help="adb serial of the Uno Q (default: the only device)")
    p.add_argument("--calibration", type=Path, default=DEFAULT_CAL)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("show", help="display an 8x13 image file on the Uno Q matrix from boot")
    s.add_argument("image", type=Path)
    s.add_argument("--no-default", action="store_true", help="start it now but do not make it the boot App")
    s.set_defaults(fn=cmd_show)

    c = sub.add_parser("calibrate", help="show the calibration image, locate the 104 LEDs, save the grid homography")
    c.add_argument("--duration", type=float, default=2.0)
    c.add_argument("--no-show", action="store_true", help="calibration image is already displayed; do not touch the Uno Q")
    c.add_argument("--restore", type=Path, default=ROOT / "images" / "devin-hexes.txt", help="image to show afterwards")
    c.set_defaults(fn=cmd_calibrate)

    o = sub.add_parser("observe", help="watch the matrix and check it against an expected image (exit 0 = pass)")
    g = o.add_mutually_exclusive_group(required=True)
    g.add_argument("--expect", type=Path, help="8x13 image file")
    g.add_argument("--assertions", type=Path, help="C6 assertion JSON (object or list)")
    o.add_argument("--duration", type=float, default=3.0)
    o.add_argument("--tol-cells", type=int, default=2)
    o.add_argument("--hold-s", type=float, default=2.0)
    o.add_argument("--evidence-dir", type=Path, help="write an annotated key frame here")
    o.set_defaults(fn=cmd_observe)

    v = sub.add_parser("serve", help="run the C5 HTTP service (camera owner, /observe, /snapshot, ...)")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8090)
    v.set_defaults(fn=cmd_serve)

    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
