// Farm idle (CONTRACTS C8) for the Uno Q: four corner pixels of the 8x13 matrix steady, a centre pixel
// heartbeat at 0.5 Hz (1 s on, 1 s off), RGB LED off. Core-only (Arduino_LED_Matrix ships with arduino:zephyr).
#include <Arduino_LED_Matrix.h>

Arduino_LED_Matrix matrix;
static uint8_t frame[104];  // 8 rows x 13 cols, row-major, 0/1

static void set(int r, int c, uint8_t v) { frame[r * 13 + c] = v; }

void setup() {
  matrix.begin();
  matrix.setGrayscaleBits(1);
  // RGB LED 1 (LED3_R/G/B on the Uno Q) is active-low; drive it off.
  pinMode(LED3_R, OUTPUT); pinMode(LED3_G, OUTPUT); pinMode(LED3_B, OUTPUT);
  digitalWrite(LED3_R, HIGH); digitalWrite(LED3_G, HIGH); digitalWrite(LED3_B, HIGH);
}

void loop() {
  static bool on = false;
  on = !on;
  for (int i = 0; i < 104; i++) frame[i] = 0;
  set(0, 0, 1); set(0, 12, 1); set(7, 0, 1); set(7, 12, 1);
  set(3, 6, on ? 1 : 0);
  matrix.draw(frame);
  delay(1000);
}
