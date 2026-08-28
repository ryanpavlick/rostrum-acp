"""
Annotate the Rostrum window capture.

With the chat in the secondary sidebar the window divides cleanly: tracking
views on the left, the file under edit in the middle, the conversation on the
right. Labels therefore sit in the margin nearest what they describe and their
arrows stay short, instead of crossing the window and covering the thing being
pointed at.
"""
import math
from PIL import Image, ImageDraw, ImageFont

SRC, OUT = "shot8.png", "rostrum-annotated.png"
BG, INK, MUTED = (11, 20, 38), (232, 238, 248), (146, 162, 190)
ARROW = (226, 92, 74)
PAD_L, PAD_R, PAD_TOP, PAD_BOTTOM = 620, 620, 210, 90

BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
PLAIN = "/System/Library/Fonts/Supplemental/Arial.ttf"

shot = Image.open(SRC).convert("RGB")
W, H = shot.size

canvas = Image.new("RGB", (W + PAD_L + PAD_R, H + PAD_TOP + PAD_BOTTOM), BG)
canvas.paste(shot, (PAD_L, PAD_TOP))
d = ImageDraw.Draw(canvas)
font = ImageFont.truetype(BOLD, 30)

def at(x, y):
    return (x + PAD_L, y + PAD_TOP)

def arrow(start, end, width=4):
    d.line([start, end], fill=ARROW, width=width)
    a = math.atan2(end[1] - start[1], end[0] - start[0])
    for spread in (2.7, -2.7):
        d.line([end, (end[0] + 20 * math.cos(a + spread), end[1] + 20 * math.sin(a + spread))],
               fill=ARROW, width=width)

def label(text, y, target, side):
    lines = text.split("\n")
    widths = [d.textbbox((0, 0), ln, font=font)[2] for ln in lines]
    top = y - (38 * len(lines)) // 2
    if side == "left":
        edge = PAD_L - 90
        for ln, wid in zip(lines, widths):
            d.text((edge - wid, top), ln, font=font, fill=INK)
            top += 38
        arrow((edge + 22, y), at(*target))
    else:
        edge = PAD_L + W + 90
        for ln in lines:
            d.text((edge, top), ln, font=font, fill=INK)
            top += 38
        arrow((edge - 22, y), at(*target))

# --- left: what the agent has touched ---------------------------------------
label("Live conversations,\nwith status",      PAD_TOP + 250,  (300, 252),  "left")
label("Files this agent\nchanged",             PAD_TOP + 580,  (300, 580),  "left")
label("Every edit, across\nfiles and sessions", PAD_TOP + 1230, (280, 1228), "left")
label("Outline and\ntoken usage",              PAD_TOP + 1570, (210, 1560), "left")

# --- right: the conversation ------------------------------------------------
label("Agent, and its\nsessions",              PAD_TOP + 168,  (2420, 166),  "right")
label("Reasoning, folded\nuntil wanted",       PAD_TOP + 278,  (2560, 276),  "right")
label("Diagrams open in\ntheir own viewer",    PAD_TOP + 440,  (2700, 424),  "right")
label("Maths rendered\ninline",                PAD_TOP + 700,  (2600, 706),  "right")
label("Tool calls, with\ninput and output",    PAD_TOP + 870,  (2560, 866),  "right")
label("File diff",                             PAD_TOP + 990,  (2560, 988),  "right")
label("Queue, steer or\nstop a running turn",  PAD_TOP + 1416, (2540, 1416), "right")
label("Session mode and\npermission mode",     PAD_TOP + 1570, (2560, 1573), "right")

# --- centre -----------------------------------------------------------------
d.text((PAD_L + 700, PAD_TOP + H + 22),
       "The file under edit, with the agent's changes marked in the gutter",
       font=ImageFont.truetype(PLAIN, 28), fill=MUTED)

d.text((PAD_L, 66), "Rostrum ACP", font=ImageFont.truetype(BOLD, 58), fill=INK)
d.text((PAD_L, 140),
       "One VS Code panel for any Agent Client Protocol agent. Nothing runs until you approve it.",
       font=ImageFont.truetype(PLAIN, 29), fill=MUTED)

canvas.save(OUT, optimize=True)
print("wrote", OUT, canvas.size)
