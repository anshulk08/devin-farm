"""Point-LED assertions (C6 `led_state`, `led_blink`, `led_sequence`, `rgb_color`) over per-frame samples.

Each LED is a calibrated image point (see `LedPoints`). A sample is `(t, {name: (level, (b, g, r))})` where `level`
is the brightest pixel in a small patch and `(b, g, r)` the mean colour of that patch's brightest pixels.
Every function returns a C6 result and never passes without a measurement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

Sample = tuple[float, dict[str, tuple[float, tuple[float, float, float]]]]


@dataclass
class LedPoints:
    points: dict[str, tuple[float, float]]  # name ("pico.led", "pico.leds.0", "unoq.rgb1") -> image (x, y)
    threshold: float = 100.0  # patch level above which an LED counts as lit
    radius: int = 4
    image_size: tuple[int, int] = (0, 0)
    extra: dict = field(default_factory=dict)

    def sample(self, gray: np.ndarray, bgr: np.ndarray) -> dict[str, tuple[float, tuple[float, float, float]]]:
        h, w = gray.shape
        out = {}
        r = self.radius
        for name, (x, y) in self.points.items():
            xi, yi = int(round(x)), int(round(y))
            sl = (slice(max(0, yi - r), min(h, yi + r + 1)), slice(max(0, xi - r), min(w, xi + r + 1)))
            g, c = gray[sl], bgr[sl].reshape(-1, 3)
            if g.size == 0:
                out[name] = (0.0, (0.0, 0.0, 0.0))
                continue
            top = c[g.reshape(-1) >= g.max() - 10]
            out[name] = (float(g.max()), tuple(float(v) for v in top.mean(axis=0)))
        return out

    def save(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({"points": {k: list(v) for k, v in self.points.items()}, "threshold": self.threshold,
                                          "radius": self.radius, "image_size": list(self.image_size)}, indent=1))

    @classmethod
    def load(cls, path: str | Path) -> "LedPoints":
        d = json.loads(Path(path).read_text())
        return cls({k: (float(v[0]), float(v[1])) for k, v in d["points"].items()}, float(d.get("threshold", 100.0)),
                   int(d.get("radius", 4)), tuple(d.get("image_size", (0, 0))))


def _base(a: dict, kind: str) -> dict:
    expected = {k: v for k, v in a.items() if k not in ("type", "target")}
    return {"type": kind, "target": a.get("target"), "passed": False, "measured": None, "expected": expected,
            "uncertainty": None, "detail": "", "self_reported": False}


def _fail(res: dict, detail: str) -> dict:
    res["detail"] = detail
    return res


def _period(samples: list[Sample]) -> float:
    ts = np.array([t for t, _ in samples])
    return float(np.median(np.diff(ts))) if len(ts) > 1 else 0.0


def _lit(samples: list[Sample], name: str, thr: float) -> np.ndarray:
    return np.array([s[name][0] > thr for _, s in samples], dtype=bool)


def _runs(ts: np.ndarray, state: np.ndarray, period: float) -> list[tuple[object, float, bool]]:
    """[(state, duration_s, complete)], boundaries at the midpoint between differing frames; first/last are incomplete."""
    out, start = [], 0
    for i in range(1, len(state) + 1):
        if i == len(state) or state[i] != state[start]:
            t0 = ts[start] - period / 2 if start == 0 else (ts[start - 1] + ts[start]) / 2
            t1 = ts[i - 1] + period / 2 if i == len(state) else (ts[i - 1] + ts[i]) / 2
            out.append((state[start], float(t1 - t0), start != 0 and i != len(state)))
            start = i
    return out


def _check_points(a: dict, names: list[str], pts: LedPoints | None, res: dict) -> str | None:
    if pts is None:
        return "cannot verify: LED positions not calibrated for this device"
    missing = [n for n in names if n not in pts.points]
    if missing:
        return f"cannot verify: no calibrated camera position for {', '.join(missing)}"
    return None


def led_state(a: dict, samples: list[Sample], pts: LedPoints | None) -> dict:
    res = _base(a, "led_state")
    name, want = a.get("target", ""), a.get("state", "on")
    if want not in ("on", "off"):
        return _fail(res, f"cannot verify: unknown state {want!r}")
    if (why := _check_points(a, [name], pts, res)) or len(samples) < 3:
        return _fail(res, why or "cannot verify: too few camera frames")
    lit = _lit(samples, name, pts.threshold)
    frac = float(lit.mean())
    got = "on" if frac >= 0.9 else "off" if frac <= 0.1 else "flickering"
    res["measured"] = {"state": got, "lit_fraction": round(frac, 3), "frames": len(samples)}
    res["uncertainty"] = {"frames": 1, "frame_s": round(_period(samples), 3)}
    if got != want:
        return _fail(res, f"LED is {got} (lit in {frac:.0%} of frames), expected {want}")
    res["passed"], res["detail"] = True, f"LED {want} in {1 - frac if want == 'off' else frac:.0%} of {len(samples)} frames"
    return res


def led_blink(a: dict, samples: list[Sample], pts: LedPoints | None) -> dict:
    res = _base(a, "led_blink")
    name, hz = a.get("target", ""), float(a.get("hz", 1.0))
    duty_want, tol = a.get("duty"), float(a.get("tol_pct", 10)) / 100
    if (why := _check_points(a, [name], pts, res)) or len(samples) < 6:
        return _fail(res, why or "cannot verify: too few camera frames")
    ts = np.array([t for t, _ in samples])
    period = _period(samples)
    runs = _runs(ts, _lit(samples, name, pts.threshold), period)
    on = [d for s, d, c in runs if s and c]
    off = [d for s, d, c in runs if not s and c]
    if len(on) < 2 or not off:
        res["measured"] = {"transitions": len(runs) - 1}
        return _fail(res, f"cannot verify: saw {len(runs) - 1} on/off transitions, need at least 4 to measure a frequency")
    t_on, t_off = float(np.mean(on)), float(np.mean(off))
    got_hz, duty = 1.0 / (t_on + t_off), t_on / (t_on + t_off)
    res["measured"] = {"hz": round(got_hz, 3), "duty": round(duty, 3), "cycles": len(on)}
    res["uncertainty"] = {"ms": round(period * 1000)}
    slack = period / (1.0 / hz)  # one frame period as a fraction of the expected period
    if abs(got_hz - hz) / hz > tol + slack:
        return _fail(res, f"measured {got_hz:.2f} Hz, expected {hz:.2f} Hz (±{tol:.0%})")
    if duty_want is not None and abs(duty - float(duty_want)) > max(0.1, tol) + slack:
        return _fail(res, f"measured duty {duty:.2f}, expected {float(duty_want):.2f}")
    res["passed"], res["detail"] = True, f"{got_hz:.2f} Hz duty {duty:.2f} over {len(on)} cycles"
    return res


def led_sequence(a: dict, samples: list[Sample], pts: LedPoints | None) -> dict:
    res = _base(a, "led_sequence")
    base = a.get("target", "pico.leds")
    steps = a.get("steps") or []
    if not steps:
        return _fail(res, "cannot verify: assertion has no steps")
    if pts is None:
        return _fail(res, "cannot verify: LED positions not calibrated for this device")
    names = sorted((n for n in pts.points if n.startswith(base + ".")), key=lambda n: int(n.rsplit(".", 1)[1]))
    idx = [int(n.rsplit(".", 1)[1]) for n in names]
    need = sorted({i for s in steps for i in s.get("on", [])} - set(idx))
    if not names or need:
        return _fail(res, f"cannot verify: no calibrated camera position for LED index {need or 'any'} of {base}")
    if len(samples) < 6:
        return _fail(res, "cannot verify: too few camera frames")
    ts = np.array([t for t, _ in samples])
    period = _period(samples)
    tol_s = max(float(a.get("tol_ms", 80)) / 1000, period)
    keys = np.array([sum(1 << k for k, n in enumerate(names) if s[n][0] > pts.threshold) for _, s in samples])
    runs = _runs(ts, keys, period)
    seq = [(tuple(i for k, i in enumerate(idx) if int(m) >> k & 1), d) for m, d, c in runs if c]
    want = [tuple(sorted(s.get("on", []))) for s in steps]
    ms = [int(s.get("ms", 0)) for s in steps]
    res["measured"] = {"steps": [{"on": list(o), "ms": round(d * 1000)} for o, d in seq[:16]]}
    res["uncertainty"] = {"ms": round(period * 1000)}
    if len(seq) < len(want):
        return _fail(res, f"cannot verify: saw {len(seq)} complete step(s) in the window, the sequence has {len(want)}")
    why = f"first complete step observed (LEDs on {list(seq[0][0])}) matches no step of the sequence"
    for k0 in (k for k, w in enumerate(want) if w == seq[0][0]):
        why = ""
        for j, (o, d) in enumerate(seq):
            k = (k0 + j) % len(want)
            if o != want[k]:
                why = f"step {k + 1}: LEDs on {list(o)}, expected {list(want[k])}"
            elif abs(d * 1000 - ms[k]) > tol_s * 1000:
                why = f"step {k + 1}: lasted {d * 1000:.0f} ms, expected {ms[k]} ms (±{tol_s * 1000:.0f})"
            if why:
                break
        if not why:
            res["passed"], res["detail"] = True, f"{len(seq)} steps matched in order within ±{tol_s * 1000:.0f} ms"
            return res
    return _fail(res, why)


def classify_color(bgr: tuple[float, float, float]) -> str:
    b, g, r = (min(255, max(0, v)) for v in bgr)
    hsv = cv2.cvtColor(np.uint8([[[b, g, r]]]), cv2.COLOR_BGR2HSV)[0, 0]
    h, s, v = int(hsv[0]) * 2, int(hsv[1]), int(hsv[2])
    if v < 60:
        return "off"
    if s < 60:
        return "white"
    for name, lo, hi in (("red", 0, 20), ("orange", 20, 40), ("yellow", 40, 75), ("green", 75, 165), ("cyan", 165, 200),
                         ("blue", 200, 260), ("magenta", 260, 340), ("red", 340, 361)):
        if lo <= h < hi:
            return name
    return "off"


def rgb_color(a: dict, samples: list[Sample], pts: LedPoints | None) -> dict:
    res = _base(a, "rgb_color")
    name, want = a.get("target", ""), str(a.get("color", "")).lower()
    if (why := _check_points(a, [name], pts, res)) or len(samples) < 3:
        return _fail(res, why or "cannot verify: too few camera frames")
    lit = [s[name] for _, s in samples if s[name][0] > pts.threshold]
    seen = [classify_color(c) for _, c in lit]
    counts = {k: seen.count(k) for k in sorted(set(seen))}
    got = max(counts, key=counts.get) if counts else "off"
    res["measured"] = {"color": got, "lit_frames": len(lit), "frames": len(samples), "counts": counts}
    res["uncertainty"] = {"frames": 1}
    if want == "off":
        ok = len(lit) <= 0.1 * len(samples)
        res["measured"]["color"] = "off" if ok else got
        return _fail(res, f"LED lit in {len(lit)} of {len(samples)} frames") if not ok else {**res, "passed": True, "detail": "LED dark"}
    if len(lit) < 0.5 * len(samples):
        return _fail(res, f"LED lit in only {len(lit)} of {len(samples)} frames")
    if got != want or counts[got] < 0.8 * len(lit):
        return _fail(res, f"saw {got} ({counts}), expected {want}")
    res["passed"], res["detail"] = True, f"{want} in {counts[got]} of {len(lit)} lit frames"
    return res


LED_ASSERTIONS = {"led_state": led_state, "led_blink": led_blink, "led_sequence": led_sequence, "rgb_color": rgb_color}
