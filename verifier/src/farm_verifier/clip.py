"""Evidence clip writers: MP4 (H.264 if the OpenCV build has it) and a small GIF, with a burned-in verdict overlay (C7)."""

from __future__ import annotations

import io
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

GREEN, RED, WHITE = (80, 200, 80), (60, 60, 230), (235, 235, 235)
MAX_GIF_BYTES = 2_800_000


def _short(r: dict) -> str:
    m = r.get("measured") or {}
    if "ascii" in m:
        return f"{m.get('wrong_cells', '?')} cells differ, held {m.get('held_s', '?')}s"
    brief = {k: v for k, v in m.items() if not isinstance(v, (list, dict))}
    return ", ".join(f"{k}={v}" for k, v in brief.items())[:70]


def overlay(crop: np.ndarray, results: list[dict], wall_t: float, width: int = 480) -> np.ndarray:
    s = max(1.0, width / crop.shape[1])
    img = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC) if s > 1 else crop.copy()
    img = np.ascontiguousarray(img)
    lines = [(f"{'PASS' if r['passed'] else 'FAIL'} {r['type']} {r.get('target') or ''}: {_short(r)}",
              GREEN if r["passed"] else RED) for r in results[:3]]
    band = 18 * len(lines) + 6
    top = np.zeros((band, img.shape[1], 3), np.uint8)
    for i, (txt, col) in enumerate(lines):
        cv2.putText(top, txt[:90], (4, 15 + 18 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.42, col, 1, cv2.LINE_AA)
    foot = np.zeros((20, img.shape[1], 3), np.uint8)
    stamp = datetime.fromtimestamp(wall_t).strftime("%Y-%m-%d %H:%M:%S")
    cv2.putText(foot, f"{stamp}  recorded by the Farm camera", (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.42, WHITE, 1, cv2.LINE_AA)
    return np.vstack([top, img, foot])


def write_mp4(path: Path, frames: list[np.ndarray], fps: float) -> bool:
    if not frames:
        return False
    h, w = frames[0].shape[:2]
    w, h = w - w % 2, h - h % 2
    for tag in ("avc1", "mp4v"):
        wr = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*tag), fps, (w, h))
        if wr.isOpened():
            for f in frames:
                wr.write(f[:h, :w])
            wr.release()
            if path.exists() and path.stat().st_size > 0:
                return True
    return False


def write_gif(path: Path, frames: list[np.ndarray], fps: float) -> bool:
    if not frames:
        return False
    from PIL import Image  # optional dependency of the service

    width = frames[0].shape[1]
    for scale in (1.0, 0.75, 0.5, 0.35):
        step = 1 if scale == 1.0 else 2
        imgs = []
        for f in frames[::step]:
            rgb = cv2.cvtColor(cv2.resize(f, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
            imgs.append(Image.fromarray(rgb).quantize(colors=64, dither=Image.Dither.NONE))
        buf = io.BytesIO()
        imgs[0].save(buf, "GIF", save_all=True, append_images=imgs[1:], duration=int(1000 * step / fps), loop=0, optimize=False)
        if buf.tell() <= MAX_GIF_BYTES:
            path.write_bytes(buf.getvalue())
            return True
    return False


def write_clip_files(out: Path, crops: list[tuple[float, np.ndarray]], results: list[dict], fps: float = 10.0) -> list[str]:
    """clip.mp4 + clip.gif into `out`; returns the file names written."""
    now_m, now_w = time.monotonic(), time.time()
    frames = [overlay(c, results, now_w - (now_m - t)) for t, c in crops]
    files = []
    if write_mp4(out / "clip.mp4", frames, fps):
        files.append("clip.mp4")
    if write_gif(out / "clip.gif", frames, fps):
        files.append("clip.gif")
    return files
