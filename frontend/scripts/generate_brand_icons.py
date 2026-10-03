from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "src" / "app"
PUBLIC_ICONS_DIR = ROOT / "public" / "icons"

INK = "#2D2212"
BEAM = "#56431F"
GOLD = "#CFAE60"
WOOD = "#9B7E4F"
PAPER = "#F7F3E9"
WOOD_PALE = "#C6B183"


def draw_koaryu_mark(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    scale = size / 64

    def point(x: float, y: float) -> tuple[int, int]:
        return (round(x * scale), round(y * scale))

    draw.rounded_rectangle(
        (*point(3, 3), *point(61, 61)),
        radius=round(14 * scale),
        fill=INK,
    )

    planes = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    planes_draw = ImageDraw.Draw(planes)
    planes_draw.rectangle((*point(16, 16), *point(48, 48)), fill=PAPER)

    polygons = (
        ([(48, 16), (38, 16), (48, 26)], BEAM),
        ([(38, 16), (26, 16), (48, 38), (48, 26)], GOLD),
        ([(26, 16), (16, 16), (16, 24), (40, 48), (48, 48), (48, 38)], WOOD),
        ([(16, 24), (16, 34), (30, 48), (40, 48)], PAPER),
        ([(16, 34), (16, 42), (22, 48), (30, 48)], WOOD_PALE),
        ([(16, 42), (16, 48), (22, 48)], GOLD),
    )
    for coordinates, color in polygons:
        planes_draw.polygon([point(x, y) for x, y in coordinates], fill=color)

    divider_width = max(1, round(scale))
    for start, end in (
        ((38, 16), (48, 26)),
        ((26, 16), (48, 38)),
        ((16, 24), (40, 48)),
        ((16, 34), (30, 48)),
        ((16, 42), (22, 48)),
    ):
        planes_draw.line((*point(*start), *point(*end)), fill=INK, width=divider_width)

    image.alpha_composite(planes)

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
