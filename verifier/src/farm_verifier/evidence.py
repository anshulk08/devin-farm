"""Annotated key frame for a matrix_frame result: crop of the matrix with each cell marked."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .grid import parse_ascii
from .matrix import Calibration

GREEN, RED, GREY = (80, 200, 80), (60, 60, 230), (140, 140, 140)


def annotate(bgr: np.ndarray, cal: Calibration, result: dict, scale: int = 4) -> np.ndarray:
    x0, y0, x1, y1 = cal.roi(1.5)
    crop = cv2.resize(bgr[y0:y1, x0:x1], None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    expected = parse_ascii(result["expected"]["ascii"])
    measured = parse_ascii(result["measured"]["ascii"]) if result.get("measured") else None
    r = max(2, int(0.35 * cal.pitch_px * scale))
    for (row, col), exp in np.ndenumerate(expected):
        x, y = (cal.centres[row, col] - (x0, y0)) * scale
        colour = GREY if measured is None else (GREEN if measured[row, col] == exp else RED)
        cv2.circle(crop, (int(x), int(y)), r, colour, 2 if exp else 1, cv2.LINE_AA)
    verdict = "PASS" if result["passed"] else "FAIL"
    banner = np.zeros((28, crop.shape[1], 3), np.uint8)
    cv2.putText(banner, f"{verdict} matrix_frame  {result['detail'][:80]}", (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                GREEN if result["passed"] else RED, 1, cv2.LINE_AA)
    return np.vstack([banner, crop])


def write(evidence_dir: str | Path, bgr: np.ndarray, cal: Calibration, result: dict) -> Path:
    out = Path(evidence_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "frame-matrix.jpg"
    cv2.imwrite(str(path), annotate(bgr, cal, result))
    return path
