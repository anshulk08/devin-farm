# Heartbeat blink on external LED 1

Target board: a Raspberry Pi Pico running MicroPython (lease a `pico` device).
Make **external LED 1** (GP16) flash a "heartbeat": lit for 100 ms, dark for 400 ms, repeating forever. The onboard
LED (GP25) must stay off. Print `READY` when the loop has started.

Verify with the farm camera before claiming you are done; a program that prints the right things is not enough.
