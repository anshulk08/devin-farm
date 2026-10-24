# farm-verifier (Lane B)

The Farm camera oracle. Today it does one thing end to end: **put an 8x13 image on the Uno Q LED
matrix, and decide from the webcam whether the matrix really shows it** (C6 `matrix_frame`).

## Quick start

Hardware: Uno Q on USB (adb), Logitech BRIO webcam looking at the matrix, steady light.

```bash
cd verifier
uv sync
uv run farm-verifier show images/devin-hexes.txt      # compiles + flashes; becomes the boot App
uv run farm-verifier calibrate                        # shows images/calibrate.txt, fits the grid, re-shows the logo
uv run farm-verifier observe --expect images/devin-hexes.txt --evidence-dir /tmp/ev   # exit 0 = pass
uv run pytest -q                                      # synthetic-frame tests, no hardware
scripts/hw_matrix_check.sh                            # every image: PASS vs itself, FAIL vs another
```

Recalibrate whenever the camera or board moves; `observe` returns "cannot verify ... recalibrate"
when lit spots no longer sit on the calibrated grid.

## Images

`images/*.txt` are 8 lines of 13 chars, `#` = lit, `.` = dark; row 0 is the top row as you face the board.
Any file in this format works with `show` and `--expect`.

| File | What |
|---|---|
| `devin-hexes.txt` | Default boot image: the three hexagons from the Devin symbol, without the stalk |
| `cognition-logo.txt` | Cognition symbol |
| `hex-ring.txt`, `prompt.txt`, `code-brackets.txt`, `dev-text.txt` | Alternatives; `prompt.txt` has no symmetry, so it catches mirrored output |
| `calibrate.txt` | Every LED lit except r0c0. Calibration only: the dark corner fixes orientation |

## How it works

**Showing an image (`unoq.py`, `unoq_app/`).** `show` writes the grid into `sketch/frame.h` as 104
0/1 bytes and pushes the App to `~/ArduinoApps/farm-matrix-image`. It then runs
`arduino-app-cli app start` and sets the App as the board's default, so the MCU draws the image from
boot. The sketch only uses `Arduino_LED_Matrix`, which ships with the `arduino:zephyr` core. That
matters: the Uno Q has no internet, so sketches can't download libraries such as
`Arduino_RouterBridge`.

**Calibration (`matrix.py: calibrate`).**
1. Exposure is locked (3 ms by default; `--exposure` to change). Higher exposures saturate the board
   between LEDs.
2. LEDs are found as local maxima above a top-hat background, so neighbours whose glow merges still
   separate.
3. Neighbour steps are walked into an integer lattice, and the brightest 13x8 window is kept. This
   drops bezel glare rows.
4. A homography is fitted to every LED (0.4–0.5 px residual on our rig).
5. The dark r0c0 corner picks the orientation, which handles mirrored cameras and upside-down boards.
6. Per-cell lit level and board level are stored in `state/unoq-1.calibration.json` (gitignored).

**Verdict (`assertions.py: matrix_frame`).** The verifier samples each cell centre in every frame
and takes a per-cell max over 3 frames to hide matrix scan flicker. Each cell is thresholded halfway
between the board level and that cell's lit level. The result passes only if:
- at most `tol_cells` cells differ from the expected image;
- the match holds for at least `hold_s`;
- no ambiguous cells could flip the verdict;
- lit spots sit within 0.3 cells of the calibrated grid.

Otherwise it returns `passed: false` with the cells named. There is no pass without a measurement:
uncalibrated, no frames, or an unknown assertion type all fail.

Results follow C6: `measured.ascii` is what the camera saw, and `uncertainty` reports ambiguous
cells, frame period and registration error. `--evidence-dir` writes `frame-matrix.jpg`, a crop with
each cell circled green (correct) or red (wrong) and the verdict burned in.

## Limits

- Brightness is on/off only (the sketch uses 1-bit grayscale).
- Only `matrix_frame` is implemented. Other C6 types (`matrix_text`, `led_sequence`, ...) return
  "not implemented", never a pass.
- The C5 HTTP service, clips (MP4/GIF) and `confirm_idle` are not built yet; see `STATUS.md`.
