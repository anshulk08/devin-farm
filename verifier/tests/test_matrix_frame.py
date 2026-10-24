"""matrix_frame end to end on synthetic camera frames: calibrate from the calibration image, then judge images."""

from pathlib import Path

import numpy as np
import pytest

from farm_verifier import grid, synth
from farm_verifier.assertions import evaluate, matrix_frame
from farm_verifier.matrix import calibrate

IMAGES = Path(__file__).resolve().parents[1] / "images"
LOGO = grid.load(IMAGES / "devin-hexes.txt")
COG = grid.load(IMAGES / "cognition-logo.txt")
PROMPT = grid.load(IMAGES / "prompt.txt")
CAL_IMG = grid.load(IMAGES / "calibrate.txt")


def assertion(g, tol=2, hold=1.0):
    return {"type": "matrix_frame", "target": "unoq.matrix", "ascii": grid.to_ascii(g), "tol_cells": tol, "hold_s": hold}


def cal_for(**kw):
    return calibrate([img for _, img in synth.clip(CAL_IMG, n=8, **kw)])


@pytest.fixture(scope="module")
def cal():
    return cal_for()


def test_calibration_recovers_cell_centres(cal):
    quad = synth.default_quad()
    np.testing.assert_allclose(cal.centres[0, 0], quad[0], atol=0.6)
    np.testing.assert_allclose(cal.centres[-1, -1], quad[2], atol=0.6)


@pytest.mark.parametrize("flip", ["none", "mirror", "rot180"])
def test_calibration_orientation_from_marker(flip):
    """Mirrored camera or upside-down board: the dark r0c0 marker still anchors the grid."""
    q = synth.default_quad()
    quad = {"none": q, "mirror": q[[1, 0, 3, 2]], "rot180": q[[2, 3, 0, 1]]}[flip]
    c = cal_for(quad=quad)
    frames = synth.clip(LOGO, n=20, quad=quad)
    r = matrix_frame(assertion(LOGO), frames, c)
    assert r["passed"], r["detail"]
    assert not matrix_frame(assertion(np.fliplr(LOGO)), frames, c)["passed"]


def test_correct_image_passes(cal):
    r = matrix_frame(assertion(LOGO), synth.clip(LOGO, n=20), cal)
    assert r["passed"], r["detail"]
    assert r["measured"]["ascii"] == grid.to_ascii(LOGO)
    assert r["measured"]["wrong_cells"] == 0


def test_different_logo_fails_with_cells_named(cal):
    r = matrix_frame(assertion(LOGO), synth.clip(COG, n=20), cal)
    assert not r["passed"]
    assert r["measured"]["ascii"] == grid.to_ascii(COG)
    assert "cells differ" in r["detail"]


@pytest.mark.parametrize("flipped", [np.fliplr, np.flipud])
def test_mirrored_output_fails(cal, flipped):
    """A mirror-image bug on the board (wrong pixel order) is a fail. PROMPT has no symmetry."""
    r = matrix_frame(assertion(PROMPT), synth.clip(flipped(PROMPT), n=20), cal)
    assert not r["passed"]


def test_tolerance_boundary(cal):
    off_by = lambda k: (lambda g: (g.__setitem__((7, slice(13 - k, 13)), True), g)[1])(LOGO.copy())
    assert matrix_frame(assertion(LOGO, tol=2), synth.clip(off_by(2), n=20), cal)["passed"]
    r = matrix_frame(assertion(LOGO, tol=2), synth.clip(off_by(3), n=20), cal)
    assert not r["passed"] and r["measured"]["wrong_cells"] == 3
    assert not matrix_frame(assertion(LOGO, tol=0), synth.clip(off_by(1), n=20), cal)["passed"]


def test_blank_matrix_fails(cal):
    r = matrix_frame(assertion(LOGO), synth.clip(np.zeros_like(LOGO), n=20), cal)
    assert not r["passed"]
    assert r["measured"]["wrong_cells"] == int(LOGO.sum())


def test_scan_flicker_is_tolerated(cal):
    """The matrix is multiplexed: a lit LED is sometimes caught dark in a single frame."""
    r = matrix_frame(assertion(LOGO), synth.clip(LOGO, n=30, dropout=0.15), cal)
    assert r["passed"], r["detail"]


def test_hold_time_enforced(cal):
    """Correct image for only part of the window (e.g. an animation passing through it) is not a pass."""
    frames = synth.clip(LOGO, n=10, fps=15) + synth.clip(COG, n=20, fps=15, t0=10 / 15)
    r = matrix_frame(assertion(LOGO, hold=1.5), frames, cal)
    assert not r["passed"]
    assert r["measured"]["held_s"] < 1.0
    assert "only" in r["detail"]


def test_moved_camera_cannot_verify(cal):
    shifted = synth.default_quad() + np.float32([5, 0])  # half a cell
    r = matrix_frame(assertion(LOGO), synth.clip(LOGO, n=20, quad=shifted), cal)
    assert not r["passed"]
    assert "cannot verify" in r["detail"]


def test_bright_spot_off_matrix_is_ignored(cal):
    """A lit LED elsewhere on the board (power LED, RGB) is outside the grid and must not count."""
    r = matrix_frame(assertion(LOGO), synth.clip(LOGO, n=20, extra_spots=[(400, 400)]), cal)
    assert r["passed"], r["detail"]


def test_uncalibrated_never_passes():
    r = matrix_frame(assertion(LOGO), synth.clip(LOGO, n=5), None)
    assert not r["passed"] and r["measured"] is None and "not calibrated" in r["detail"]


def test_no_frames_never_passes(cal):
    r = matrix_frame(assertion(LOGO), [], cal)
    assert not r["passed"] and "no camera frames" in r["detail"]


def test_unknown_assertion_type_is_not_a_pass(cal):
    r = evaluate({"type": "matrix_text", "text": "DEVIN"}, synth.clip(LOGO, n=5), cal)
    assert not r["passed"] and "not implemented" in r["detail"]


def test_calibration_rejects_wrong_image():
    """Calibrating while some other image shows must fail loudly, not produce a bad grid."""
    with pytest.raises(RuntimeError):
        calibrate([img for _, img in synth.clip(LOGO, n=5)])
