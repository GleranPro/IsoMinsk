# -*- coding: utf-8 -*-
"""Create the initial landmark catalog (idempotent: keeps existing curated fields)."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "src" / "shared" / "landmarks" / "catalog.json"

ENTRIES = [
    ("archangel", "Арханёл Міхаіл, які пранізвае змея", "n462268066", []),
    ("red-church", "Касцёл Святога Сымона і Святой Алены", "w100418249", ["w100418249"]),
    ("holy-spirit", "Кафедральны сабор Сашэсця Святога Духа", "w538208752", ["w538208752"]),
    ("victory-monument", "Манумент Перамогі", "w346312699", ["w346312699"]),
    ("war-museum", "Музей гісторыі Вялікай Айчыннай Вайны", "w127103385", ["w127103385"]),
    ("minsk-arena", "Мінск-Арэна", "w292848094", ["w292848094"]),
    ("national-library", "Нацыянальная бібліятэка Беларусі", "w25319604", ["w25319604"]),
    (
        "opera",
        "Нацыянальны акадэмічны Вялікі тэатр оперы і балета Рэспублікі Беларусь",
        "w25327478",
        ["w25327478"],
    ),
    (
        "art-museum-karl-marx",
        "Нацыянальны мастацкі музей — вуліца Карла Маркса, 24",
        "w25327593",
        ["w25327593"],
    ),
    ("art-museum", "Нацыянальны мастацкі музей", "w25327627", ["w25327627"]),
    ("palace-republic", "Палац Рэспублікі", "w25327560", ["w25327560"]),
    ("gorky-gate", "Парадны ўваход у цэнтральны дзіцячы парк імя Горкага", "n9776899217", []),
    ("ratusha", "Ратуша", "w25387231", ["w25387231"]),
    ("stela-hero-city", "Стэла «Мінск-Горад Герой»", "w346345132", ["w346345132"]),
    (
        "railway-station",
        "Чыгуначны вакзал станцыі Мінск-Пасажырскі",
        "w358224860",
        ["w358224860", "w232130720"],
    ),
]


def main() -> None:
    existing = {}
    if CATALOG.exists():
        existing = {e["slug"]: e for e in json.loads(CATALOG.read_text(encoding="utf-8"))["landmarks"]}
    out = []
    for slug, label, osm, fit_to in ENTRIES:
        entry = existing.get(slug, {})
        entry.update({"slug": slug, "glb": label + ".glb", "label": label, "osm": osm})
        entry.setdefault("fitTo", fit_to)
        out.append(entry)
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(
        json.dumps({"version": 1, "landmarks": out}, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print("wrote", CATALOG, len(out))


if __name__ == "__main__":
    main()
