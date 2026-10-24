"""Synthetic camera frames of the Uno Q matrix: perspective, LED blur, noise, scan flicker."""

from __future__ import annotations

import cv2
import numpy as np

from .grid import COLS, ROWS
from .matrix import GRID_CORNERS


def default_quad(w: int = 1280, h: int = 720) -> np.ndarray:
    """Image positions of the TL/TR/BR/BL cell centres: matrix ~140 px wide, slightly skewed."""
    return np.float32([[565, 122], [690, 118], [693, 196], [567, 199]]) * np.float32([w / 1280, h / 720])


def render(grid: np.ndarray, quad: np.ndarray | None = None, size: tuple[int, int] = (1280, 720), level: float = 200,
           board: float = 12, noise: float = 4, dropout: float = 0.0, extra_spots: list[tuple[int, int]] = (),
           rng: np.random.Generator | None = None) -> np.ndarray:
    """One grayscale frame. `dropout` = probability a lit LED is caught dark (matrix scanning)."""
    rng = rng or np.random.default_rng(0)
    w, h = size
    quad = default_quad(w, h) if quad is None else np.float32(quad)
    H = cv2.getPerspectiveTransform(GRID_CORNERS, quad)
    img = np.full((h, w), board, np.float32)
    pitch = float(np.linalg.norm(quad[1] - quad[0]) / (COLS - 1))
    radius = max(1, int(round(0.18 * pitch)))
    centres = cv2.perspectiveTransform(np.float32([[c, r] for r in range(ROWS) for c in range(COLS)])[None], H)[0]
    for (x, y), on in zip(centres, grid.reshape(-1)):
        if on and rng.random() >= dropout:
            cv2.circle(img, (int(round(x)), int(round(y))), radius, level * rng.uniform(0.85, 1.0), -1, cv2.LINE_AA)
    for x, y in extra_spots:
        cv2.circle(img, (x, y), radius + 1, level, -1, cv2.LINE_AA)
    img = cv2.GaussianBlur(img, (0, 0), 0.35 * pitch / 2)
    img += rng.normal(0, noise, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def clip(grid: np.ndarray, n: int = 30, fps: float = 15, t0: float = 0.0, **kw) -> list[tuple[float, np.ndarray]]:
    rng = kw.pop("rng", None) or np.random.default_rng(1)
    return [(t0 + i / fps, render(grid, rng=rng, **kw)) for i in range(n)]
