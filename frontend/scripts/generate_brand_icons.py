from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "src" / "app"
PUBLIC_ICONS_DIR = ROOT / "public" / "icons"

GOLD = "#D6B25E"
DARK = "#0B0D10"


def draw_koaryu_mark(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    pad = round(size * 0.10)
    rect = (pad, pad, size - pad, size - pad)
    radius = round(size * 0.18)
    draw.rounded_rectangle(rect, radius=radius, fill=GOLD)

    stroke = max(1, round(size * 0.11))
    left_x = round(size * 0.31)
    top_y = round(size * 0.24)
    mid_y = round(size * 0.50)
    bottom_y = round(size * 0.76)
    right_x = round(size * 0.67)

    draw.line((left_x, top_y, left_x, bottom_y), fill=DARK, width=stroke)
    draw.line((left_x + round(stroke * 0.2), mid_y, right_x, top_y), fill=DARK, width=stroke)
    draw.line((left_x + round(stroke * 0.2), mid_y, right_x, bottom_y), fill=DARK, width=stroke)

    return image


def save_png(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    draw_koaryu_mark(size).save(path, format="PNG")


def save_ico(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    base = draw_koaryu_mark(64)
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64)]
    base.save(path, format="ICO", sizes=sizes)


def main() -> None:
    save_ico(APP_DIR / "favicon.ico")
    save_png(APP_DIR / "apple-icon.png", 180)
    save_png(PUBLIC_ICONS_DIR / "icon-192.png", 192)
    save_png(PUBLIC_ICONS_DIR / "icon-512.png", 512)


if __name__ == "__main__":
    main()
