# Show a heart on the Uno Q LED matrix

Target board: an Arduino Uno Q (lease a `unoq` device). Make the 8x13 LED matrix show this static image
(`#` = lit, `.` = dark) and keep showing it:

```
.............
..##.....##..
.####...####.
.###########.
..#########..
...#######...
.....###.....
......#......
```

The app must use the standard layout (`app.yaml`, `python/main.py` calling `App.run(...)`, `sketch/sketch.ino`,
`sketch/sketch.yaml`). The board has no internet, so use only `Arduino_LED_Matrix` from the core.
Verify with the farm camera before claiming you are done.
