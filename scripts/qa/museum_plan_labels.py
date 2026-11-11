# -*- coding: utf-8 -*-
"""Annotate the museum plan render and build a photo/render comparison sheet.

The Blender plan render is a north-up orthographic view centred on
(9297, 652) with `ortho_scale` covering the 1700 px height, so world metres map
to pixels linearly:

    px_x = width/2 + (x - cx) * px_per_m
    px_y = height/2 - (y - cy) * px_per_m
    px_per_m = height / ortho_scale

Outputs:
  renders/museum-layout-top-labelled.png   plan render with exhibit names
  analysis/plan_vs_photo.jpg               photo and plan side by side
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
RENDERS = ASSETS / "renders"
ANALYSIS = ASSETS / "analysis"
PHOTO = ROOT / "data" / "interim" / "lipki_analysis" / "drone_grid1.png"

CENTER = (9297.0, 652.0)
ORTHO = 384.0
WIDTH, HEIGHT = 1200, 1700
PX_PER_M = HEIGHT / ORTHO

LABELS = {
    "mi-1": "Ми-1М",
    "mi-2": "Ми-2",
    "mi-8": "Ми-8Т",
    "mi-24": "Ми-24П",
    "mi-26": "Ми-26",
    "an-2": "Ан-2",
    "an-26": "Ан-26",
    "il-18": "Ил-18",
    "tu-134": "Ту-134",
    "yak-18": "Як-18",
    "yak-28": "Як-28ПП",
    "yak-40": "Як-40",
    "l-29": "Л-29",
    "mig-15": "МиГ-15УТИ",
    "mig-17": "МиГ-17",
    "mig-19": "МиГ-19П",
    "mig-21": "МиГ-21СМТ",
    "mig-23": "МиГ-23УБ",
    "mig-25": "МиГ-25",
    "mig-27": "МиГ-27К",
    "mig-29": "МиГ-29",
    "su-17": "Су-17М",
    "su-24": "Су-24М",
    "su-25": "Су-25",
    "citation-x": "Citation X",
}

EMPTY = {
    "Ту-154": "Ту-154",
    "PZL-104": "PZL-104",
    "L-13": "L-13",
    "Як-52": "Як-52",
    "Ан-12Б": "Ан-12",
    "Як-25М": "Як-25М",
    "Ан-24Б": "Ан-24",
    "Ил-14П": "Ил-14",
    "Ка-26": "Ка-26",
}


def world_to_px(x: float, y: float) -> tuple[float, float]:
    return (
        WIDTH / 2 + (x - CENTER[0]) * PX_PER_M,
        HEIGHT / 2 - (y - CENTER[1]) * PX_PER_M,
    )


def load_font(size: int):
    for name in ("segoeuib.ttf", "arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        for base in (Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/dejavu")):
            path = base / name
            if path.exists():
                return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def main() -> None:
    placement = json.loads((ASSETS / "placement.json").read_text(encoding="utf-8"))
    render = Image.open(RENDERS / "museum-layout-top.png").convert("RGB")
    labelled = render.copy()
    draw = ImageDraw.Draw(labelled)
    font = load_font(22)
    small = load_font(17)

    for exhibit in placement["exhibits"]:
        px = world_to_px(exhibit["x"], exhibit["y"])
        name = LABELS.get(exhibit["slug"], exhibit["slug"])
        draw.ellipse([px[0] - 3, px[1] - 3, px[0] + 3, px[1] + 3], fill=(255, 60, 60))
        text = name if name not in [LABELS.get(e["slug"]) for e in placement["exhibits"][:0]] else name
        draw.text((px[0] + 8, px[1] - 10), text, font=small, fill=(20, 20, 20),
                  stroke_width=3, stroke_fill=(255, 255, 255))

    for spot in placement["missing"]:
        px = world_to_px(spot["x"], spot["y"])
        r = 16
        for start in range(0, 360, 20):
            draw.arc([px[0] - r, px[1] - r, px[0] + r, px[1] + r], start, start + 10,
                     fill=(90, 90, 90), width=2)
        draw.text((px[0] + 10, px[1] - 8), f"{spot['label']} — нет модели", font=small,
                  fill=(80, 80, 80), stroke_width=3, stroke_fill=(255, 255, 255))

    # North arrow and scale bar.
    draw.line([(70, 120), (70, 60)], fill=(20, 20, 20), width=4)
    draw.polygon([(70, 48), (60, 70), (80, 70)], fill=(20, 20, 20))
    draw.text((58, 124), "N", font=font, fill=(20, 20, 20))
    bar = 50.0 * PX_PER_M
    draw.line([(60, HEIGHT - 60), (60 + bar, HEIGHT - 60)], fill=(20, 20, 20), width=5)
    draw.text((60, HEIGHT - 95), "50 м", font=small, fill=(20, 20, 20))

    labelled.save(RENDERS / "museum-layout-top-labelled.png")
    print(f"wrote {(RENDERS / 'museum-layout-top-labelled.png').relative_to(ROOT)}")

    # Side-by-side comparison: the photo (museum rows) next to the same extent of the plan.
    photo = Image.open(PHOTO).convert("RGB").crop((40, 380, 990, 1510))
    photo = photo.resize((int(photo.width * (HEIGHT / photo.height)), HEIGHT), Image.LANCZOS)
    sheet = Image.new("RGB", (photo.width + WIDTH + 30, HEIGHT + 50), (250, 250, 248))
    sheet.paste(photo, (10, 40))
    sheet.paste(labelled, (photo.width + 20, 40))
    sdraw = ImageDraw.Draw(sheet)
    sdraw.text((14, 10), "Фото с разметкой (курс — красные стрелки)", font=small, fill=(0, 0, 0))
    sdraw.text((photo.width + 24, 10), "Расстановка моделей, север сверху", font=small, fill=(0, 0, 0))
    sheet.save(ANALYSIS / "plan_vs_photo.jpg", quality=90)
    print(f"wrote {(ANALYSIS / 'plan_vs_photo.jpg').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
