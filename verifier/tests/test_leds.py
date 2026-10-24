"""Point-LED assertions on synthetic samples, including wrong answers."""

import numpy as np

from farm_verifier.leds import LedPoints, classify_color, led_blink, led_sequence, led_state, rgb_color

PTS = LedPoints({"pico.led": (0, 0), "pico.leds.0": (0, 0), "pico.leds.1": (1, 0), "pico.leds.2": (2, 0), "unoq.rgb1": (3, 0)})
OFF, ON = (5.0, (0.0, 0.0, 0.0)), (220.0, (30.0, 40.0, 220.0))


def clip(fn, dur=6.0, fps=30.0):
    return [(i / fps, fn(i / fps)) for i in range(int(dur * fps))]


def blink(hz, duty=0.5):
    return clip(lambda t: {"pico.led": ON if (t * hz) % 1 < duty else OFF})


def test_blink_pass_and_fail():
    a = {"type": "led_blink", "target": "pico.led", "hz": 2.0, "duty": 0.3, "tol_pct": 10}
    assert led_blink(a, blink(2.0, 0.3), PTS)["passed"]
    r = led_blink(a, blink(1.0, 0.3), PTS)
    assert not r["passed"] and "Hz" in r["detail"]
    assert not led_blink(a, clip(lambda t: {"pico.led": OFF}), PTS)["passed"]


def test_state():
    on = clip(lambda t: {"pico.led": ON}, 1.0)
    assert led_state({"target": "pico.led", "state": "on"}, on, PTS)["passed"]
    assert not led_state({"target": "pico.led", "state": "off"}, on, PTS)["passed"]


def test_sequence_pass_and_wrong_step():
    a = {"type": "led_sequence", "target": "pico.leds", "steps": [{"on": [0, 2], "ms": 500}, {"on": [1], "ms": 500}], "tol_ms": 80}

    def seq(second):
        def f(t):
            on = [0, 2] if t % 1.0 < 0.5 else second
            return {f"pico.leds.{i}": ON if i in on else OFF for i in range(3)}
        return clip(f, 5.0)
    assert led_sequence(a, seq([1]), PTS)["passed"]
    r = led_sequence(a, seq([0, 1]), PTS)
    assert not r["passed"] and "[0, 1]" in r["detail"]


def test_uncalibrated_points_fail():
    assert not led_blink({"target": "pico.led", "hz": 1.0}, blink(1.0), None)["passed"]
    assert not led_state({"target": "pico.nope", "state": "on"}, blink(1.0), PTS)["passed"]


def test_rgb_color():
    green = clip(lambda t: {"unoq.rgb1": (200.0, (40.0, 220.0, 30.0))}, 1.0)
    assert classify_color((40, 220, 30)) == "green" and classify_color((220, 30, 30)) == "blue"
    assert rgb_color({"target": "unoq.rgb1", "color": "green"}, green, PTS)["passed"]
    assert not rgb_color({"target": "unoq.rgb1", "color": "red"}, green, PTS)["passed"]
    assert not rgb_color({"target": "unoq.rgb1", "color": "green"}, clip(lambda t: {"unoq.rgb1": OFF}, 1.0), PTS)["passed"]
