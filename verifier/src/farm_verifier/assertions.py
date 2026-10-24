"""C6 `matrix_frame`: did the Uno Q matrix show the expected 8x13 image, held for `hold_s`?

Pure function over timestamped frames + a calibration. Never passes without a measurement:
an unregistered/missing matrix, too few frames, or cells too ambiguous to decide all return
`passed: false` with the reason in `detail`.
"""

from __future__ import annotations

import numpy as np

from .grid import COLS, ROWS, parse_ascii, to_ascii
from .matrix import Calibration, classify, registration_error, sample_cells

MAX_REG_ERR_CELLS = 0.3  # lit spots further than this from cell centres => camera/board moved
FLICKER_WINDOW = 3  # per-cell max over this many consecutive frames hides matrix scan/PWM gaps


def _cells(mask: np.ndarray, limit: int = 6) -> str:
    rc = list(zip(*np.nonzero(mask)))
    s = ", ".join(f"r{r}c{c}" for r, c in rc[:limit])
    return s + (f" +{len(rc) - limit} more" if len(rc) > limit else "")


def _longest_run(ok: np.ndarray) -> tuple[int, int]:
    """[start, end) of the longest run of True; (0, 0) if none."""
    best, start = (0, 0), None
    for i, v in enumerate(list(ok) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start > best[1] - best[0]:
                best = (start, i)
            start = None
    return best


def matrix_frame(assertion: dict, frames: list[tuple[float, np.ndarray]], cal: Calibration | None) -> dict:
    expected = parse_ascii(assertion["ascii"])
    tol = int(assertion.get("tol_cells", 2))
    hold_s = float(assertion.get("hold_s", 2.0))
    result = {
        "type": "matrix_frame", "target": assertion.get("target", "unoq.matrix"), "passed": False,
        "measured": None, "expected": {"ascii": to_ascii(expected), "tol_cells": tol, "hold_s": hold_s},
        "uncertainty": None, "detail": "", "self_reported": False,
    }

    def fail(detail: str) -> dict:
        result["detail"] = detail
        return result

    if cal is None:
        return fail("cannot verify: matrix not calibrated (run `farm-verifier calibrate`)")
    if not frames:
        return fail("cannot verify: no camera frames")
    if frames[0][1].shape[::-1] != tuple(cal.image_size):
        return fail(f"cannot verify: frame size {frames[0][1].shape[::-1]} != calibration {tuple(cal.image_size)}")

    ts = np.array([t for t, _ in frames])
    period = float(np.median(np.diff(ts))) if len(ts) > 1 else 0.0
    raw = np.stack([sample_cells(img, cal) for _, img in frames])  # (N, 8, 13)
    w = min(FLICKER_WINDOW, len(raw))
    vals = np.stack([raw[max(0, i - w + 1):i + 1].max(axis=0) for i in range(len(raw))])
    lit = np.stack([classify(v, cal)[0] for v in vals])
    wrong_per_frame = (lit != expected).reshape(len(lit), -1).sum(axis=1)

    s, e = _longest_run(wrong_per_frame <= tol)
    window = slice(s, e) if e > s else slice(0, len(frames))
    held_s = float(ts[e - 1] - ts[s] + period) if e > s else 0.0

    # The measured image: per-cell median over the matching window (or everything, if nothing matched).
    med = np.median(vals[window], axis=0)
    meas, ambiguous = classify(med, cal)
    wrong = meas != expected
    worst_case = int((wrong | ambiguous).sum())
    best_case = int((wrong & ~ambiguous).sum())

    reg, n_spots = registration_error(np.max(np.stack([img for _, img in frames[window]]), axis=0), cal)
    result["measured"] = {
        "ascii": to_ascii(meas), "wrong_cells": int(wrong.sum()), "held_s": round(held_s, 2),
        "frames": len(frames), "duration_s": round(float(ts[-1] - ts[0] + period), 2),
        "lit_level": round(float(np.median(med[meas])) if meas.any() else 0.0, 1), "off_level": round(cal.off_level, 1),
    }
    result["uncertainty"] = {
        "ambiguous_cells": int(ambiguous.sum()), "frame_s": round(period, 3),
        "registration_cells": None if reg is None else round(reg, 3),
    }

    if reg is not None and reg > MAX_REG_ERR_CELLS:
        return fail(f"cannot verify: lit spots are {reg:.2f} cells off the calibrated grid (camera or board moved); recalibrate")
    if worst_case > tol >= best_case:
        return fail(f"cannot verify: {int(ambiguous.sum())} ambiguous cell(s) ({_cells(ambiguous)}) decide the verdict")
    if wrong.sum() > tol:
        extra, missing = meas & ~expected, ~meas & expected
        parts = [f"{int(wrong.sum())} cells differ (tol {tol})"]
        if missing.any():
            parts.append(f"dark but expected lit: {_cells(missing)}")
        if extra.any():
            parts.append(f"lit but expected dark: {_cells(extra)}")
        return fail("; ".join(parts))
    if held_s + 1e-6 < hold_s:
        return fail(f"image matched for only {held_s:.2f}s of {hold_s:.2f}s required")
    result["passed"] = True
    result["detail"] = f"matched {ROWS * COLS - int(wrong.sum())}/{ROWS * COLS} cells for {held_s:.2f}s"
    return result


ASSERTIONS = {"matrix_frame": matrix_frame}


def evaluate(assertion: dict, frames: list[tuple[float, np.ndarray]], cal: Calibration | None) -> dict:
    fn = ASSERTIONS.get(assertion.get("type"))
    if fn is None:
        return {"type": assertion.get("type"), "target": assertion.get("target"), "passed": False, "measured": None,
                "expected": assertion, "uncertainty": None, "self_reported": False,
                "detail": f"cannot verify: assertion type {assertion.get('type')!r} not implemented by this verifier"}
    return fn(assertion, frames, cal)
