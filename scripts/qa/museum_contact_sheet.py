"""Build a labelled contact sheet from the Blender model thumbnails."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
RENDERS = ASSETS / "renders"
MANIFEST = ASSETS / "MODELS.json"
OUT = RENDERS / "contact-sheet.png"

TILE_W = 300
TILE_H = 250
LABEL_H = 26
COLS = 5
BACKGROUND = (27, 32, 44)
TILE_BG = (38, 45, 60)
TEXT = (228, 232, 240)
MUTED = (150, 160, 176)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in (r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    items = {item["slug"]: item for item in manifest["items"]}
    slugs = sorted(
        slug
        for slug in items
        if (RENDERS / f"{slug}.png").exists()
    )
    rows = (len(slugs) + COLS - 1) // COLS
    width = COLS * TILE_W + (COLS + 1) * 8
    height = rows * (TILE_H + LABEL_H) + (rows + 1) * 8 + 34
    sheet = Image.new("RGB", (width, height), BACKGROUND)
    draw = ImageDraw.Draw(sheet)
    title_font = load_font(20)
    label_font = load_font(15)
    draw.text((12, 10), f"Muzeum aviace — {len(slugs)} model(s), decimated ~2.5k tris", fill=TEXT, font=title_font)

    for index, slug in enumerate(slugs):
        row, col = divmod(index, COLS)
        x = 8 + col * (TILE_W + 8)
        y = 40 + 8 + row * (TILE_H + LABEL_H + 8)
        draw.rounded_rectangle((x, y, x + TILE_W, y + TILE_H), radius=8, fill=TILE_BG)
        image = Image.open(RENDERS / f"{slug}.png").convert("RGBA")
        image.thumbnail((TILE_W - 16, TILE_H - 16), Image.LANCZOS)
        offset = ((TILE_W - image.width) // 2, (TILE_H - image.height) // 2)
        sheet.paste(image, (x + offset[0], y + offset[1]), image)
        label = items[slug]["label"]
        draw.text((x + 8, y + TILE_H + 3), label, fill=TEXT, font=label_font)
        draw.text(
            (x + TILE_W - 8, y + TILE_H + 4),
            items[slug].get("license", ""),
            fill=MUTED,
            font=load_font(11),
            anchor="ra",
        )

    sheet.save(OUT)
    print(f"Wrote {OUT.relative_to(ROOT)} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
