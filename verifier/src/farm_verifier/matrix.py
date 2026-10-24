"""Locate the Uno Q 8x13 matrix in camera frames and read each cell as lit/dark.

Frames are single-channel uint8 (per-pixel max over B/G/R, see capture.Camera.read).
Grid coordinates are (col, row) with cell centres at integers: (0, 0) top-left, (12, 7) bottom-right.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .grid import COLS, ROWS

GRID_CORNERS = np.float32([[0, 0], [COLS - 1, 0], [COLS - 1, ROWS - 1], [0, ROWS - 1]])
CELL_XY = np.float32([[c, r] for r in range(ROWS) for c in range(COLS)])  # row-major


def detect_blobs(img: np.ndarray, min_contrast: float = 15.0) -> np.ndarray:
    """Centroids (N, 2) of LED-sized bright spots.

    Local maxima above a local background (white top-hat), so adjacent LEDs whose glow merges
    under a global threshold still separate. Saturated plateaus collapse to one centroid.
    """
    b = cv2.GaussianBlur(img.astype(np.float32), (0, 0), 1.2)
    bg = cv2.morphologyEx(b, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    th = b - bg
    thr = max(min_contrast, 0.25 * float(np.percentile(th, 99.99)))
    peak = ((b >= cv2.dilate(b, np.ones((5, 5), np.uint8))) & (th > thr)).astype(np.uint8)
    n, _, _, cents = cv2.connectedComponentsWithStats(peak, connectivity=8)
    return cents[1:].astype(np.float32)


def _index_lattice(pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Integer lattice (col, row) for each point, by walking nearest-neighbour steps from a seed.

    Steps are classified against two basis vectors (the dominant near-horizontal and near-vertical
    neighbour offsets), so mild perspective is fine. Returns (indices into pts, coords) for the
    connected lattice reached from the densest seed; points that conflict or are unreachable are dropped.
    """
    d = pts[:, None] - pts[None]
    dist = np.linalg.norm(d, axis=2)
    np.fill_diagonal(dist, np.inf)
    pitch = float(np.median(dist.min(axis=1)))
    near = dist < 1.2 * pitch  # 4-neighbours only (diagonals sit at ~1.41 pitch)
    steps = d.transpose(1, 0, 2)[near]  # vectors i -> j for neighbouring pairs
    horiz = np.abs(steps[:, 0]) >= np.abs(steps[:, 1])
    hs = steps[horiz] * np.sign(steps[horiz][:, :1])  # orient to +x
    vs = steps[~horiz] * np.sign(steps[~horiz][:, 1:2])  # orient to +y
    basis = np.stack([np.median(hs, axis=0), np.median(vs, axis=0)]).T  # columns: col step, row step
    inv = np.linalg.inv(basis)

    seed = int(near.sum(axis=1).argmax())
    coords = {seed: (0, 0)}
    queue = [seed]
    while queue:
        i = queue.pop()
        for j in np.nonzero(near[i])[0]:
            if j in coords:
                continue
            dc, dr = np.round(inv @ (pts[j] - pts[i])).astype(int)
            if abs(dc) + abs(dr) == 1:
                coords[j] = (coords[i][0] + dc, coords[i][1] + dr)
                queue.append(j)
    idx = np.array(sorted(coords))
    return idx, np.array([coords[i] for i in idx])


def _best_window(coords: np.ndarray, weight: np.ndarray) -> tuple[int, int]:
    """(col0, row0) of the COLS x ROWS window of lattice coords with the most total brightness."""
    best, arg = -1.0, (0, 0)
    for c0 in range(coords[:, 0].min(), coords[:, 0].max() - COLS + 2):
        for r0 in range(coords[:, 1].min(), coords[:, 1].max() - ROWS + 2):
            inside = (coords[:, 0] >= c0) & (coords[:, 0] < c0 + COLS) & (coords[:, 1] >= r0) & (coords[:, 1] < r0 + ROWS)
            s = float(weight[inside].sum())
            if s > best:
                best, arg = s, (c0, r0)
    return arg


@dataclass
class Calibration:
    H: np.ndarray  # 3x3, grid (col, row) -> image (x, y)
    on_level: np.ndarray  # (8, 13) cell brightness when lit, from the calibration frames
    off_level: float  # board surface brightness between LEDs
    image_size: tuple[int, int]  # (w, h) of the frames it was made from
    exposure: int | None = None
    reproj_px: float = 0.0  # mean fit residual at calibration time

    @property
    def centres(self) -> np.ndarray:
        """(8, 13, 2) image coordinates of every cell centre."""
        return cv2.perspectiveTransform(CELL_XY[None], self.H)[0].reshape(ROWS, COLS, 2)

    @property
    def pitch_px(self) -> float:
        c = self.centres
        return float(np.mean([np.linalg.norm(np.diff(c, axis=1), axis=2).mean(), np.linalg.norm(np.diff(c, axis=0), axis=2).mean()]))

    def to_image(self, grid_xy: np.ndarray) -> np.ndarray:
        return cv2.perspectiveTransform(np.float32(grid_xy).reshape(1, -1, 2), self.H)[0]

    def to_grid(self, img_xy: np.ndarray) -> np.ndarray:
        return cv2.perspectiveTransform(np.float32(img_xy).reshape(1, -1, 2), np.linalg.inv(self.H))[0]

    def roi(self, margin_cells: float = 1.5) -> tuple[int, int, int, int]:
        """(x0, y0, x1, y1) bounding box of the matrix plus a margin, clipped to the frame."""
        m = margin_cells
        quad = self.to_image(np.float32([[-m, -m], [COLS - 1 + m, -m], [COLS - 1 + m, ROWS - 1 + m], [-m, ROWS - 1 + m]]))
        w, h = self.image_size
        x0, y0 = np.floor(quad.min(axis=0)).astype(int)
        x1, y1 = np.ceil(quad.max(axis=0)).astype(int)
        return max(0, int(x0)), max(0, int(y0)), min(w, int(x1)), min(h, int(y1))

    def save(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps({
            "H": self.H.tolist(), "on_level": self.on_level.round(1).tolist(), "off_level": round(self.off_level, 1),
            "image_size": list(self.image_size), "exposure": self.exposure, "reproj_px": round(self.reproj_px, 3),
            "corners_px": self.to_image(GRID_CORNERS).round(1).tolist(),
        }, indent=1))

    @classmethod
    def load(cls, path: str | Path) -> "Calibration":
        d = json.loads(Path(path).read_text())
        return cls(np.array(d["H"], dtype=np.float64), np.array(d["on_level"], dtype=np.float32), float(d["off_level"]),
                   tuple(d["image_size"]), d.get("exposure"), d.get("reproj_px", 0.0))


def sample_cells(img: np.ndarray, cal: Calibration) -> np.ndarray:
    """(8, 13) brightness: max of the lightly blurred frame within a small square at each cell centre."""
    blur = cv2.GaussianBlur(img, (3, 3), 0)
    r = max(1, int(round(0.25 * cal.pitch_px)))
    h, w = blur.shape
    out = np.zeros((ROWS, COLS), np.float32)
    centres = cal.centres
    for row in range(ROWS):
        for col in range(COLS):
            x, y = centres[row, col]
            xi, yi = int(round(x)), int(round(y))
            patch = blur[max(0, yi - r):min(h, yi + r + 1), max(0, xi - r):min(w, xi + r + 1)]
            out[row, col] = float(patch.max()) if patch.size else 0.0
    return out


def classify(values: np.ndarray, cal: Calibration) -> tuple[np.ndarray, np.ndarray]:
    """(lit, ambiguous) bool grids. Per-cell threshold halfway between board level and that cell's lit level."""
    span = np.maximum(cal.on_level - cal.off_level, 1.0)
    thr = cal.off_level + 0.5 * span
    return values > thr, np.abs(values - thr) < 0.25 * span


def _orientation(window_vals: np.ndarray, off: float) -> np.ndarray:
    """3x3 map from matrix (col, row) to window (col, row), found from the single dark corner (r0c0).

    The calibration image is all-on except r0c0, so whichever window corner is dark is the matrix origin.
    Covers the board being rotated 180° or the camera image being mirrored.
    """
    lit_ref = float(np.median(window_vals))
    dark = window_vals < off + 0.5 * (lit_ref - off)
    corners = {(0, 0): (1, 1), (COLS - 1, 0): (-1, 1), (0, ROWS - 1): (1, -1), (COLS - 1, ROWS - 1): (-1, -1)}
    dark_corners = [cr for cr in corners if dark[cr[1], cr[0]]]
    if len(dark_corners) != 1 or dark.sum() > 3:
        raise RuntimeError(f"calibration image not recognised: expected exactly the r0c0 corner dark, saw {int(dark.sum())} dark cells "
                           f"({len(dark_corners)} dark corners); is images/calibrate.txt showing?")
    (oc, orow), (sc, sr) = dark_corners[0], corners[dark_corners[0]]
    return np.array([[sc, 0, oc], [0, sr, orow], [0, 0, 1]], dtype=np.float64)


def calibrate(frames: list[np.ndarray], exposure: int | None = None) -> Calibration:
    """Fit the grid from frames of the calibration image: every LED lit except r0c0 (images/calibrate.txt)."""
    mean = np.mean(np.stack(frames).astype(np.float32), axis=0).astype(np.uint8)
    pts = detect_blobs(mean)
    if len(pts) < 0.8 * ROWS * COLS:
        raise RuntimeError(f"found {len(pts)} bright spots, need >= {int(0.8 * ROWS * COLS)}: is the calibration image showing and the matrix in frame?")
    idx, coords = _index_lattice(pts)
    # Glare off the bezel can add a partial row/column; keep the 13x8 window that is brightest.
    weight = cv2.GaussianBlur(mean, (3, 3), 0)[pts[idx, 1].round().astype(int), pts[idx, 0].round().astype(int)].astype(np.float32)
    c0, r0 = _best_window(coords, weight)
    cell = (coords - (c0, r0)).astype(np.float32)
    ok = (cell[:, 0] >= 0) & (cell[:, 0] < COLS) & (cell[:, 1] >= 0) & (cell[:, 1] < ROWS)
    if ok.sum() < 0.8 * ROWS * COLS:
        raise RuntimeError(f"only {int(ok.sum())} LEDs fit an 8x13 grid; check the camera angle and that nothing else bright is next to the matrix")
    src, dst = cell[ok], pts[idx][ok]
    H_win, _ = cv2.findHomography(src, dst, 0)  # lattice indices are exact, so plain least squares
    reproj = float(np.linalg.norm(cv2.perspectiveTransform(src[None], H_win)[0] - dst, axis=1).mean())
    h, w = mean.shape
    win = Calibration(H_win, np.zeros((ROWS, COLS), np.float32), 0.0, (w, h), exposure, reproj)
    x0, y0, x1, y1 = win.roi(0.0)
    off = float(np.percentile(cv2.GaussianBlur(mean, (3, 3), 0)[y0:y1, x0:x1], 10))
    cal = Calibration(H_win @ _orientation(sample_cells(mean, win), off), np.zeros((ROWS, COLS), np.float32), off, (w, h), exposure, reproj)
    on = np.median(np.stack([sample_cells(f, cal) for f in frames]), axis=0)
    on[0, 0] = np.median(on)  # the marker cell was dark; assume a typical lit level
    cal.on_level = on
    if float(on.min()) < off + 20:
        raise RuntimeError("some matrix cells are barely brighter than the board; raise exposure or check for occlusion")
    return cal


def registration_error(img: np.ndarray, cal: Calibration) -> tuple[float | None, int]:
    """Median distance (in cells) from lit spots near the matrix to the nearest cell centre.

    None when no spots are lit (nothing to register against). Large values mean the camera or board moved.
    """
    pts = detect_blobs(img)
    if len(pts) == 0:
        return None, 0
    g = cal.to_grid(pts)
    near = (g[:, 0] > -1) & (g[:, 0] < COLS) & (g[:, 1] > -1) & (g[:, 1] < ROWS)
    if not near.any():
        return None, 0
    g = g[near]
    return float(np.median(np.linalg.norm(g - np.round(g), axis=1))), int(near.sum())
