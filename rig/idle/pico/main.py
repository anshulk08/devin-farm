# Farm idle program (CONTRACTS C8): onboard LED (GP25) blinks at 0.5 Hz (1 s on, 1 s off);
# external LEDs GP16-GP19 stay off. Installed by rigd on every reset; the verifier calibrates from it.
import time
from machine import Pin

led = Pin(25, Pin.OUT)
for gp in (16, 17, 18, 19):
    Pin(gp, Pin.OUT).value(0)

print("FARM-IDLE")
while True:
    led.value(1)
    time.sleep_ms(1000)
    led.value(0)
    time.sleep_ms(1000)
