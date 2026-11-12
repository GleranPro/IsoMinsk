"""B-2 step 0: freeze the baseline of the current tile datasets.

Hashes every tile of the committed central dataset and of the current city
dataset so the 399-tile B-2 regeneration can be compared against the state it
replaces (counts, sizes, payload hashes). Read-only with respect to the data:
writes only `docs/B2/BASELINE.json`.

Run:
    .venv\\Scripts\\python.exe scripts/qa/b2_baseline.py
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "B2" / "BASELINE.json"

DATASETS = {
    "central": ROOT / "public" / "data" / "tiles",
    "city": ROOT / "public" / "data" / "city-tiles",
}

# Derived working files that a staging run must not overwrite.
DERIVED_WORKING_FILES = (
    "data/processed/coverage_city.json",
    "data/processed/city_area_normalized.json",
    "data/processed/coverage.json",
    "data/processed/city_normalized.json",
    "docs/COVERAGE_REPORT_CITY.md",
)

VOLATILE_MANIFEST_FIELDS = {"generatedAt"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def summarize(name: str, directory: Path) -> dict:
    manifest_path = directory / "manifest.json"
    if not manifest_path.exists():
        return {"name": name, "directory": str(directory), "missing": True}
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tiles = []
    total_bytes = 0
    for entry in manifest.get("tiles", []):
        file_name = entry["file"].split("/")[-1]
        path = directory / file_name
        if not path.exists():
            tiles.append({"x": entry["x"], "y": entry["y"], "missing": True})
            continue
        size = path.stat().st_size
        total_bytes += size
        tiles.append({
            "x": entry["x"],
            "y": entry["y"],
            "bytes": size,
            "sha256": sha256_file(path),
        })
    stable_manifest = {
        key: value
        for key, value in manifest.items()
        if key not in VOLATILE_MANIFEST_FIELDS
    }
    return {
        "name": name,
        "directory": str(directory.relative_to(ROOT)).replace("\\", "/"),
        "tileSize": manifest.get("tileSize"),
        "tileRange": manifest.get("tileRange"),
        "bounds": manifest.get("bounds"),
        "areaBounds": manifest.get("areaBounds"),
        "counts": manifest.get("counts"),
        "manifestSha256": hashlib.sha256(
            json.dumps(stable_manifest, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest(),
        "tileCount": len(tiles),
        "totalBytes": total_bytes,
        "tiles": tiles,
    }


def summarize_derived() -> dict:
    """Hashes of derived working files, so staging cannot silently replace them."""
    result = {}
    for relative in DERIVED_WORKING_FILES:
        path = ROOT / relative
        if not path.exists():
            result[relative] = {"missing": True}
            continue
        result[relative] = {
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    return result


def main() -> int:
    document = {
        "schema": 1,
        "generatedAt": "2026-11-10",
        "purpose": (
            "B-2 step 0 baseline: the tile datasets and derived working files in "
            "place before the MKAD expansion, so the 399-tile regeneration can be "
            "diffed against them and a staging run can be checked for side effects"
        ),
        "datasets": {name: summarize(name, directory) for name, directory in DATASETS.items()},
        "derived": summarize_derived(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")

    for name, data in document["datasets"].items():
        if data.get("missing"):
            print(f"{name}: missing manifest ({data['directory']})")
            continue
        print(
            f"{name}: {data['tileCount']} tiles, {data['totalBytes'] / 1e6:.2f} MB, "
            f"tileSize {data['tileSize']}, bounds {data['bounds']}, "
            f"manifest {data['manifestSha256'][:12]}"
        )
    for relative, data in document["derived"].items():
        if data.get("missing"):
            print(f"derived: {relative} (missing)")
        else:
            print(f"derived: {relative} {data['sha256'][:12]}…")
    print(f"Wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
