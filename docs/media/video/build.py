#!/usr/bin/env python3
"""Renders title cards, lower thirds, cover as PNG. Run: python3 build.py (then build_mov.sh)."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
F = os.path.expanduser("~/Library/Fonts/JetBrainsMono-")
def font(w, s): return ImageFont.truetype(F + w + ".ttf", s)
BG=(11,15,20); FG=(214,222,232); DIM=(139,151,167); GREEN=(61,220,132); RED=(255,92,92); AMBER=(255,181,71); LINE=(34,44,58); ACC=(122,162,255)

def base(w=1920, h=1080):
    im = Image.new("RGB", (w, h), BG); d = ImageDraw.Draw(im)
    for y in range(0, h, 32):
        for x in range(0, w, 32):
            # dot grid fades toward the edges
            dx = abs(x - w/2)/(w/2); dy = abs(y - h/2)/(h/2)
            a = max(0, 1 - max(dx, dy)**1.6) * 0.9
            c = tuple(int(BG[i] + (LINE[i]+10-BG[i]) * a) for i in range(3))
            d.point((x, y), c); d.point((x+1, y), c); d.point((x, y+1), c); d.point((x+1, y+1), c)
    return im

def glow(im, box, color, r=40, alpha=90):
    g = Image.new("RGBA", im.size, (0,0,0,0)); ImageDraw.Draw(g).rounded_rectangle(box, 12, fill=color+(alpha,))
    g = g.filter(ImageFilter.GaussianBlur(r)); im.paste(g, (0,0), g)

def tw(d, t, f): return d.textlength(t, font=f)

def segs(d, x, y, parts, f, anchor="l"):
    """parts: [(text,color)]; draws left-aligned at x, or centered at x if anchor=='m'."""
    total = sum(tw(d, t, f) for t, _ in parts)
    if anchor == "m": x -= total/2
    for t, c in parts:
        d.text((x, y), t, font=f, fill=c); x += tw(d, t, f)

def chrome(d, w, h, label):
    d.text((96, 72), "DEVIN FARM", font=font("Bold", 22), fill=DIM)
    d.text((w-96, 72), label, font=font("Medium", 22), fill=DIM, anchor="ra")
    d.line((96, 112, w-96, 112), fill=LINE, width=2)

def card(name, kicker, title_parts, sub, accent=GREEN, label=""):
    im = base(); d = ImageDraw.Draw(im); W,H = im.size
    chrome(d, W, H, label)
    d.rectangle((96, 400, 104, 640), fill=accent)
    d.text((140, 396), kicker, font=font("Medium", 30), fill=accent)
    y = 450
    for line in title_parts:
        segs(d, 140, y, line, font("ExtraBold", 92)); y += 112
    d.text((140, y+24), sub, font=font("Regular", 36), fill=DIM)
    im.save(f"{name}.png")

def txt(s): return [(s, FG)]
cards = [
 ("card-01-problem", "01 / THE PROBLEM", [txt("Agents say done."), [("The hardware ", FG), ("disagrees.", RED)]], "Code that passes its own logs can still light the wrong LED.", RED, "PROBLEM"),
 ("card-02-rig", "02 / THE RIG", [txt("One rig. Many boards."), txt("One camera.")], "Real boards on a private tailnet. Sessions never get a shell.", ACC, "RIG"),
 ("card-03-leases", "03 / SHARING", [txt("One lock per board."), txt("Everyone else queues.")], "Leases, a queue and fencing tokens, per device.", AMBER, "LEASES"),
 ("card-04-verify", "04 / VERIFICATION", [[("Measured, ", FG), ("not claimed.", GREEN)]], "A camera the agent can't touch decides what the board did.", GREEN, "VERIFIER"),
 ("card-05-evidence", "05 / EVIDENCE", [txt("Evidence ships"), txt("with the PR.")], "Claimed vs. camera-confirmed: [E1 result].", ACC, "RESULTS"),
]
for c in cards: card(*c)

# opener
im = base(); d = ImageDraw.Draw(im); W,H = im.size
glow(im, (660, 590, 1260, 600), ACC, 30, 140); d = ImageDraw.Draw(im)
d.text((W/2, 380), "DEVIN FARM", font=font("ExtraBold", 150), fill=FG, anchor="ma")
d.text((W/2, 590), "A camera decides whether the agent's hardware code worked.", font=font("Regular", 36), fill=DIM, anchor="ma")
segs(d, W/2, 700, [("CLAIMED ", AMBER), ("✓", AMBER), ("   ·   CAMERA ", RED), ("✗", RED)], font("Bold", 34), "m")
d.text((W/2, 960), "the corgis", font=font("Medium", 26), fill=DIM, anchor="ma")
im.save("card-00-opener.png")

# end card
im = base(); d = ImageDraw.Draw(im)
chrome(d, W, H, "THANKS")
d.text((W/2, 330), "DEVIN FARM", font=font("ExtraBold", 130), fill=FG, anchor="ma")
d.text((W/2, 500), "Cloud agents share real hardware.", font=font("Regular", 42), fill=DIM, anchor="ma")
d.text((W/2, 556), "A camera checks the work.", font=font("Regular", 42), fill=ACC, anchor="ma")
d.rounded_rectangle((W/2-520, 690, W/2+520, 770), 10, outline=LINE, width=2, fill=(17,23,31))
d.text((W/2, 705), "github.com/anshulk08/devin-farm", font=font("Medium", 40), fill=FG, anchor="ma")
d.text((W/2, 850), "the corgis", font=font("Bold", 56), fill=FG, anchor="ma")
d.text((W/2, 930), "live map: [PUBLIC URL]", font=font("Regular", 26), fill=DIM, anchor="ma")
im.save("card-99-end.png")

# lower thirds: transparent, bottom-left, inside 90% safe area
def lower(name, parts, sub=None, accent=GREEN, scale=1):
    im = Image.new("RGBA", (1920,1080), (0,0,0,0)); d = ImageDraw.Draw(im)
    f = font("Bold", 46); fs = font("Regular", 26)
    w = max(sum(tw(d,t,f) for t,_ in parts), tw(d, sub or "", fs)) + 72
    h = 96 + (44 if sub else 0)
    x0, y1 = 120, 1080-120; y0 = y1 - h
    d.rounded_rectangle((x0, y0, x0+w, y1), 10, fill=(11,15,20,225), outline=(34,44,58,255), width=2)
    d.rectangle((x0, y0, x0+8, y1), fill=accent+(255,))
    segs(d, x0+40, y0+24, parts, f)
    if sub: d.text((x0+40, y0+88), sub, font=fs, fill=DIM+(255,))
    im.save(f"lt-{name}.png")
lower("claimed-vs-camera", [("CLAIMED ", AMBER), ("✓", AMBER), ("  ·  CAMERA ", RED), ("✗", RED)], "same commit, re-run on the rig", RED)
lower("one-rig", [("One rig. Many boards. One camera.", FG)], None, ACC)
lower("one-lock", [("One lock per board. Everyone else queues.", FG)], None, AMBER)
lower("measured", [("Measured, not claimed.", FG)], None, GREEN)
lower("handover", [("Reset, confirmed by camera, first.", FG)], "release → resetting → idle ✓ → next grant", GREEN)
lower("steer", [("Steer agents from the map.", FG)], None, ACC)
lower("numbers", [("n = [N]   ·   95% CI [CI]", FG)], "claimed vs camera-confirmed, by arm", ACC)
lower("sped-up", [("Sped up 8×", AMBER)], None, AMBER)
lower("recorded", [("RECORDED RUN", AMBER)], "[date]", AMBER)

# Devpost cover 1280x640
im = base(1280, 640); d = ImageDraw.Draw(im)
glow(im, (90, 300, 700, 306), GREEN, 30, 120); d = ImageDraw.Draw(im)
d.text((80, 150), "DEVIN FARM", font=font("ExtraBold", 110), fill=FG)
d.text((84, 290), "Cloud agents share real hardware.", font=font("Regular", 34), fill=DIM)
d.text((84, 336), "A camera checks the work.", font=font("Regular", 34), fill=ACC)
segs(d, 84, 450, [("CLAIMED ✓", AMBER), ("  ·  ", DIM), ("CAMERA ✗", RED)], font("Bold", 30))
d.text((84, 560), "the corgis  ·  github.com/anshulk08/devin-farm", font=font("Medium", 22), fill=DIM)
# decorative: 3 board nodes with one lease
for i,(x,y,c) in enumerate([(960,200,ACC),(1100,330,AMBER),(940,450,DIM)]):
    d.ellipse((x-46,y-46,x+46,y+46), outline=c, width=4, fill=(17,23,31))
d.line((1006,226,1054,304), fill=ACC, width=3); d.line((1060,372,986,428), fill=AMBER, width=3)
im.save("cover.png")
