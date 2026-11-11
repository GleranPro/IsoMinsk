"""Decimate every downloaded museum model into a separate decimated/ copy.

Runs Blender headless once per raw model (FBX/GLB/GLTF/BLEND) via
`blender_decimate.py`. Raw downloads are never modified; outputs go to
`assets/aviation-museum/decimated/<slug>/<slug>.glb` with a 1500-4000 triangle
budget (default 2500).

Usage:
    .venv\\Scripts\\python.exe scripts/qa/decimate_models.py
    .venv\\Scripts\\python.exe scripts/qa/decimate_models.py --target 3000 --only mi-26
"""

from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
MANIFEST = ASSETS / "MODELS.json"
DECIMATOR = ROOT / "scripts" / "qa" / "blender_decimate.py"
BLENDER = os.environ.get(
    "BLENDER_EXE", r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe"
)

SOURCE_SUFFIXES = (".fbx", ".glb", ".gltf", ".blend")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, default=2500)
    parser.add_argument("--only", default=None, help="comma-separated slugs")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    only = {slug.strip() for slug in args.only.split(",")} if args.only else None
    processed = 0
    for item in manifest["items"]:
        if only and item["slug"] not in only:
            continue
        raw = item.get("raw")
        if item.get("status") != "downloaded" or not raw:
            continue
        source = ASSETS / raw
        if not source.exists() or source.suffix.lower() not in SOURCE_SUFFIXES:
            print(f"[skip] {item['slug']}: raw source missing ({raw})", file=sys.stderr)
            continue
        destination = ASSETS / "decimated" / item["slug"] / f"{item['slug']}.glb"
        command = [
            BLENDER,
            "--background",
            "--factory-startup",
            "--python",
            str(DECIMATOR),
            "--",
            "--in",
            str(source),
            "--out",
            str(destination),
            "--target",
            str(args.target),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=600)
        tail = [line for line in (result.stdout + result.stderr).splitlines() if "[decimate]" in line]
        if result.returncode != 0 or not destination.exists():
            print(f"[fail] {item['slug']}: blender exit {result.returncode}", file=sys.stderr)
            if tail:
                print("       " + tail[-1], file=sys.stderr)
            continue
        item["decimated"] = str(destination.relative_to(ASSETS)).replace("\\", "/")
        item["triangles"] = tail[-1] if tail else None
        processed += 1
        print(tail[-1] if tail else f"[ok] {item['slug']}")

    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nDecimated: {processed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
