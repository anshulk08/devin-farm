"""Webcam capture with locked exposure and monotonic timestamps."""

from __future__ import annotations

import time
from pathlib import Path

import cv2
import numpy as np

# UVC exposure_absolute, 100 µs units. 3 ms keeps every LED below saturation and the board dark
# between LEDs (BRIO, Uno Q matrix at ~30 cm); flicker is handled downstream by a per-cell max window.
DEFAULT_EXPOSURE = 30


def find_camera(names: tuple[str, ...] = ("BRIO", "Logitech")) -> str:
    """First /dev/videoN whose V4L2 name matches (lowest index = the capture node on UVC cams)."""
    nodes = sorted(Path("/sys/class/video4linux").glob("video*"), key=lambda p: int(p.name[5:]))
    for node in nodes:
        name = (node / "name").read_text().strip()
        if any(n.lower() in name.lower() for n in names):
            return f"/dev/{node.name}"
    raise RuntimeError(f"no camera named like {names}; pass --camera /dev/videoN")


class Camera:
    def __init__(self, device: str, width: int = 1280, height: int = 720, exposure: int = DEFAULT_EXPOSURE):
        self.device = device
        self.cap = cv2.VideoCapture(device, cv2.CAP_V4L2)
        if not self.cap.isOpened():
            raise RuntimeError(f"cannot open {device}")
        self.cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, 30)
        # Lock everything that would otherwise drift between calibration and observe.
        self.cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)  # V4L2 "manual"
        self.cap.set(cv2.CAP_PROP_EXPOSURE, exposure)
        self.cap.set(cv2.CAP_PROP_AUTO_WB, 0)
        for _ in range(15):  # let focus settle and flush frames taken with old settings
            self.cap.read()
        self.cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)  # freeze focus where autofocus left it
        self.exposure = exposure
        self.last_bgr: np.ndarray | None = None

    def read_bgr(self) -> tuple[float, np.ndarray]:
        """(monotonic seconds, BGR frame)."""
        ok, frame = self.cap.read()
        t = time.monotonic()
        if not ok:
            raise RuntimeError(f"frame grab failed on {self.device} (unplugged?)")
        self.last_bgr = frame
        return t, frame

    def read(self) -> tuple[float, np.ndarray]:
        """(monotonic seconds, per-pixel max over B/G/R as uint8)."""
        t, frame = self.read_bgr()
        return t, frame.max(axis=2)

    def frames(self, duration_s: float) -> list[tuple[float, np.ndarray]]:
        out = [self.read()]
        while out[-1][0] - out[0][0] < duration_s:
            out.append(self.read())
        return out

    def close(self) -> None:
        self.cap.release()

    def __enter__(self) -> "Camera":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
