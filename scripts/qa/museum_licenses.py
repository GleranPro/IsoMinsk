"""Generate assets/aviation-museum/LICENSES.md from MODELS.json.

CC-BY models must keep their author/licence/source visible wherever the map is
published; this file is the single source of that attribution list.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
MANIFEST = ASSETS / "MODELS.json"
OUT = ASSETS / "LICENSES.md"


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    lines = [
        "# 3D-модели музея авиации — лицензии и авторы",
        "",
        "Модели скачаны для экспозиции музея на аэродроме Липки и децимированы",
        "в отдельные копии: `raw/` — оригиналы, `decimated/` — рабочие копии",
        "(цель ~2 500 треугольников). CC-BY требует указания автора и лицензии",
        "при публикации карты; CC0 — без обязательств.",
        "",
    ]
    for item in manifest["items"]:
        if item.get("status") != "downloaded":
            continue
        lines.append(f"## {item['label']} ({item['slug']})")
        lines.append("")
        lines.append(f"- Автор: {item.get('author') or 'unknown'}")
        lines.append(f"- Лицензия: {item.get('license')}")
        if item.get("source") == "sketchfab":
            lines.append(f"- Источник: https://sketchfab.com/3d-models/{item['uid']}")
        else:
            lines.append(f"- Источник: {item.get('url')}")
        lines.append(f"- Оригинал: `{item.get('raw')}`")
        lines.append(f"- Децимированная копия: `{item.get('decimated')}`")
        lines.append("")

    missing = [item for item in manifest["items"] if item.get("status") == "missing"]
    lines.append("## Нет CC-модели (нужно моделирование или покупка)")
    lines.append("")
    for item in missing:
        lines.append(f"- {item['label']} ({item['slug']})")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} ({len(lines)} lines)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
