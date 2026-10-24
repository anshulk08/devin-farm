from pathlib import Path

import pytest

from farm_verifier import grid
from farm_verifier.unoq import frame_header

IMAGES = Path(__file__).resolve().parents[1] / "images"


@pytest.mark.parametrize("path", sorted(IMAGES.glob("*.txt")), ids=lambda p: p.stem)
def test_every_shipped_image_is_8x13(path):
    assert grid.load(path).shape == (8, 13)


@pytest.mark.parametrize("rows", [["#" * 13] * 7, ["#" * 12] * 8, ["#" * 12 + "x"] + ["." * 13] * 7])
def test_malformed_ascii_rejected(rows):
    with pytest.raises(ValueError):
        grid.parse_ascii(rows)


def test_frame_header_is_row_major_bytes():
    g = grid.parse_ascii(["#" + "." * 12] + ["." * 13] * 6 + ["." * 12 + "#"])
    body = frame_header(g).split("{", 1)[1].split("}", 1)[0]
    values = [int(v) for v in body.replace("\n", "").split(",") if v.strip()]
    assert len(values) == 104
    assert values[0] == 1 and values[-1] == 1 and sum(values) == 2
