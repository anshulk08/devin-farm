# Lane B status

## Works (on real hardware: Uno Q + Logitech BRIO, laptop host)
- `farm-verifier show <image>`: any 8x13 image compiled into a core-only sketch and started via `arduino-app-cli`; set as the boot default App.
- `farm-verifier calibrate`: auto-locates all 104 LEDs from `images/calibrate.txt`; orientation from the dark r0c0 marker; reprojection 0.4–0.5 px; pitch ~10.4 px at 1280x720.
- `farm-verifier observe`: C6 `matrix_frame` with tolerance, hold time, ambiguity and registration checks; annotated evidence frame.
- `scripts/hw_matrix_check.sh`: each shipped image PASSes against itself and FAILs against another, on the real matrix.
- `pytest`: 29 synthetic-frame tests, including wrong answers (other logo, mirrored, blank, off-by-N cells, partial hold, moved camera, uncalibrated).

## Mocked / not yet
- C5 HTTP service (`127.0.0.1:8090`), ring buffer, `confirm_idle` (C8 idle pattern), MP4/GIF clips.
- `led_sequence`, `led_blink`, `matrix_text`, `rgb_color`.
- Not yet run on the Jetson. Camera device is found by name (`BRIO`/`Logitech`).

## Blocked / needs
- Enclosure + fixed camera mount (calibration must be redone after any bump).
- Reboot persistence of the boot App not yet observed: rebooting the Uno Q needs a sudo password (`adb reboot` is a no-op on this image). The App is set as `default` (`arduino-app-cli properties get default`).
- A (rig): the rig's unoq driver should reuse `farm_verifier.unoq.show` semantics or call `arduino-app-cli` the same way (stop before replacing files; keep the App's `.cache/`).
