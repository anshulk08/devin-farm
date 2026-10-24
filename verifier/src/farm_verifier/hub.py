"""Single camera owner: one thread reads the camera, keeps a short ring of recent frames, and feeds recorders.

Snapshot, stream, calibrate and observe all read from here, so they share frames and never fight for the device.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Protocol

import cv2
import numpy as np


class Source(Protocol):
    def read_bgr(self) -> tuple[float, np.ndarray]: ...
    def close(self) -> None: ...


@dataclass
class Recording:
    """Frames collected for one observe/calibrate window."""
    gray: list[tuple[float, np.ndarray]] = field(default_factory=list)  # full-frame grayscale (max over B/G/R)
    bgr: list[tuple[float, np.ndarray]] = field(default_factory=list)  # ROI crops for the evidence clip
    last_full: np.ndarray | None = None  # last full-frame BGR
    samples: list = field(default_factory=list)  # (t, sampler(gray, bgr)) per gray frame
    error: str | None = None  # why nothing was recorded


class _Rec:
    def __init__(self, roi, gray_fps: float, clip_fps: float, clip_width: int, sampler=None):
        self.out = Recording()
        self.roi, self.gray_gap, self.clip_gap, self.clip_width = roi, 1.0 / gray_fps, 1.0 / clip_fps, clip_width
        self.sampler = sampler
        self.next_gray = self.next_clip = 0.0


class FrameHub:
    def __init__(self, opener: Callable[[], Source], ring: int = 6, retry_s: float = 2.0):
        self._opener, self._retry_s = opener, retry_s
        self._ring: deque[tuple[float, np.ndarray]] = deque(maxlen=ring)
        self._cond = threading.Condition()
        self._recs: list[_Rec] = []
        self._stop = threading.Event()
        self.error: str | None = "camera not opened yet"
        self._times: deque[float] = deque(maxlen=30)
        self._thread = threading.Thread(target=self._run, name="camera-owner", daemon=True)

    # ---- lifecycle -------------------------------------------------------------------------
    def start(self) -> "FrameHub":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                src = self._opener()
            except Exception as e:  # noqa: BLE001 - camera missing/busy: report and retry
                self.error = f"camera unavailable: {e}"
                self._stop.wait(self._retry_s)
                continue
            self.error = None
            try:
                while not self._stop.is_set():
                    t, bgr = src.read_bgr()
                    self._push(t, bgr)
            except Exception as e:  # noqa: BLE001
                self.error = f"camera read failed: {e}"
            finally:
                try:
                    src.close()
                except Exception:  # noqa: BLE001
                    pass
            self._stop.wait(self._retry_s)

    def _push(self, t: float, bgr: np.ndarray) -> None:
        with self._cond:
            self._ring.append((t, bgr))
            self._times.append(t)
            recs = list(self._recs)
            self._cond.notify_all()
        for r in recs:
            if t >= r.next_gray:
                r.next_gray = t + r.gray_gap - 1e-3
                g = bgr.max(axis=2)
                r.out.gray.append((t, g))
                if r.sampler is not None:
                    r.out.samples.append((t, r.sampler(g, bgr)))
            r.out.last_full = bgr
            if t >= r.next_clip:
                r.next_clip = t + r.clip_gap - 1e-3
                x0, y0, x1, y1 = r.roi or (0, 0, bgr.shape[1], bgr.shape[0])
                crop = bgr[y0:y1, x0:x1]
                s = min(1.0, r.clip_width / max(1, crop.shape[1])) if r.clip_width else 1.0
                r.out.bgr.append((t, cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else crop.copy()))

    # ---- readers ---------------------------------------------------------------------------
    def latest(self) -> tuple[float, np.ndarray] | None:
        with self._cond:
            return self._ring[-1] if self._ring else None

    def age_s(self) -> float | None:
        f = self.latest()
        return None if f is None else max(0.0, time.monotonic() - f[0])

    def fps(self) -> float:
        with self._cond:
            ts = list(self._times)
        return round((len(ts) - 1) / (ts[-1] - ts[0]), 1) if len(ts) > 2 and ts[-1] > ts[0] else 0.0

    def fresh(self, max_age_s: float = 2.0) -> tuple[float, np.ndarray] | None:
        """Latest frame if it is recent; None if the camera is down or the stream stalled."""
        f = self.latest()
        return f if f is not None and time.monotonic() - f[0] <= max_age_s else None

    def wait_next(self, after_t: float, timeout: float = 2.0) -> tuple[float, np.ndarray] | None:
        end = time.monotonic() + timeout
        with self._cond:
            while True:
                if self._ring and self._ring[-1][0] > after_t:
                    return self._ring[-1]
                left = end - time.monotonic()
                if left <= 0:
                    return None
                self._cond.wait(left)

    def record(self, duration_s: float, roi: tuple[int, int, int, int] | None = None, gray_fps: float = 15.0,
               clip_fps: float = 10.0, clip_width: int = 640, sampler=None) -> Recording:
        """Blocking: collect `duration_s` of frames. `error` is set (and no frames returned) if the stream is stale."""
        rec = _Rec(roi, gray_fps, clip_fps, clip_width, sampler)
        with self._cond:
            self._recs.append(rec)
        try:
            if self.latest() is None:
                self.wait_next(0.0, 3.0)
            end = time.monotonic() + duration_s
            while time.monotonic() < end and not self._stop.is_set():
                time.sleep(0.05)
        finally:
            with self._cond:
                self._recs.remove(rec)
        time.sleep(0.05)  # a push that copied the recorder list just before removal may still append
        out = rec.out
        out.gray, out.bgr, out.samples = list(out.gray), list(out.bgr), list(out.samples)
        if not out.gray:
            out.error = self.error or "no camera frames arrived during the observation window"
        elif time.monotonic() - out.gray[-1][0] > 2.0:
            out.error = self.error or "camera stream stalled during the observation window"
            out.gray, out.bgr, out.samples = [], [], []
        return out
