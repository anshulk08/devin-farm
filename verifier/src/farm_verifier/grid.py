"""The Uno Q LED matrix as a boolean grid, and its ASCII form (C6 `matrix_frame.ascii`)."""

from __future__ import annotations

from pathlib import Path

import numpy as np

ROWS, COLS = 8, 13
ON, OFF = "#", "."


def parse_ascii(rows: list[str]) -> np.ndarray:
    """8 strings of 13 chars (`#` lit, `.` dark) -> bool array of shape (8, 13)."""
    if len(rows) != ROWS:
        raise ValueError(f"expected {ROWS} rows, got {len(rows)}")
    for i, row in enumerate(rows):
        if len(row) != COLS or set(row) - {ON, OFF}:
            raise ValueError(f"row {i} must be {COLS} chars of '{ON}' or '{OFF}', got {row!r}")
    return np.array([[ch == ON for ch in row] for row in rows], dtype=bool)


def to_ascii(grid: np.ndarray) -> list[str]:
    return ["".join(ON if v else OFF for v in row) for row in grid]


def load(path: str | Path) -> np.ndarray:
    """Read an image file: 8 non-empty lines of 13 `#`/`.` chars."""
    lines = [ln.strip() for ln in Path(path).read_text().splitlines()]
    return parse_ascii([ln for ln in lines if ln])
