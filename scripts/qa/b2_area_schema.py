"""B-2 step 0: derive and freeze the map area schema from the pinned OSM data.

Writes (never overwrites the tile datasets):

    docs/B2/area.json      machine-readable area/source/coverage contract
    docs/B2/coverage.svg   human-readable map: target area, current 12 km frame,
                           first MKAD ring, Northern Cemetery, tile grid

The script is deliberately independent of the normaliser: it rebuilds the MKAD
ring and the cemetery footprint straight from the PBF, projects them into the
same local metre frame (EPSG:32635 relative to PILOT_CENTER) and checks the
proposed rectangle from `geo_config.CITY_BOUNDS_M`.

Run:
    .venv\\Scripts\\python.exe scripts/qa/b2_area_schema.py
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import osmium  # noqa: E402
from pyproj import Transformer  # noqa: E402
from shapely.geometry import LineString, box  # noqa: E402
from shapely.ops import polygonize, unary_union  # noqa: E402

from geo_config import (  # noqa: E402
    CITY_BOUNDS_M,
    CITY_TILE_SIZE_M,
    EPSG_UTM35N,
    EPSG_WGS84,
    PILOT_CENTER_LAT,
    PILOT_CENTER_LON,
    area_bounds_m,
    area_bbox,
    tile_range,
)

ROOT = Path(__file__).resolve().parents[2]
PBF = ROOT / "data/raw/Minsk.osm.pbf"
OUT_DIR = ROOT / "docs" / "B2"
CEMETERY_RELATION = 1692227
CURRENT_FRAME_M = (-6000.0, -6000.0, 6000.0, 6000.0)

_TO_UTM = Transformer.from_crs(EPSG_WGS84, EPSG_UTM35N, always_xy=True)
_TO_WGS = Transformer.from_crs(EPSG_UTM35N, EPSG_WGS84, always_xy=True)
_ORIGIN = _TO_UTM.transform(PILOT_CENTER_LON, PILOT_CENTER_LAT)


def to_local(lat: float, lon: float) -> tuple[float, float]:
    x, y = _TO_UTM.transform(lon, lat)
    return x - _ORIGIN[0], y - _ORIGIN[1]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_mkad(handler_target: dict) -> None:
    target: dict = {"ways": []}

    class Handler(osmium.SimpleHandler):
        def way(self, way) -> None:
            name = (way.tags.get("name") or "").upper()
            if not (name.startswith("МКАД,") or name == "МКАД"):
                return
            coords = [
                to_local(node.lat, node.lon)
                for node in way.nodes
                if node.location.valid()
            ]
            if len(coords) >= 2:
                target["ways"].append(coords)

    Handler().apply_file(str(PBF), locations=True)
    handler_target["ways"] = target["ways"]


def collect_cemetery(relation_id: int, handler_target: dict) -> None:
    member_refs: set[int] = set()
    tags: dict[str, str] = {}

    class RelationHandler(osmium.SimpleHandler):
        def relation(self, relation) -> None:
            if relation.id != relation_id:
                return
            for tag in relation.tags:
                tags[tag.k] = tag.v
            for member in relation.members:
                if member.type == "w":
                    member_refs.add(member.ref)

    RelationHandler().apply_file(str(PBF))

    target: dict = {"ways": []}

    class WayHandler(osmium.SimpleHandler):
        def way(self, way) -> None:
            if way.id not in member_refs:
                return
            coords = [
                to_local(node.lat, node.lon)
                for node in way.nodes
                if node.location.valid()
            ]
            if len(coords) >= 2:
                target["ways"].append(coords)

    WayHandler().apply_file(str(PBF), locations=True)
    handler_target["ways"] = target["ways"]
    handler_target["tags"] = tags


def polygon_union(way_coords: list[list[tuple[float, float]]]):
    """Union of every polygon the linework encloses.

    The MKAD is a dual carriageway, so polygonize() returns the outer and the
    inner loop; the enclosed city territory is the union (the outer loop). The
    Northern Cemetery relation has two separate outer components, and keeping
    only the largest ring silently dropped its southern part (27 ha).
    """
    merged = unary_union([LineString(line) for line in way_coords])
    rings = list(polygonize(merged))
    if not rings:
        return None
    return unary_union(rings)


def rounded_bounds(bounds: tuple[float, float, float, float]) -> list[float]:
    return [round(value, 1) for value in bounds]


def svg_map(area: dict, ring, cemetery) -> str:
    """Minimal SVG: target area, current frame, MKAD ring, cemetery, tile grid."""
    minx, miny, maxx, maxy = area["area"]["boundsLocalM"]
    pad = 2000.0
    vx0, vy0, vx1, vy1 = minx - pad, miny - pad, maxx + pad, maxy + pad
    width, height = vx1 - vx0, vy1 - vy0
    scale = 1000.0 / max(width, height)

    def pt(x: float, y: float) -> tuple[float, float]:
        # SVG y grows downwards, local y grows north
        return ((x - vx0) * scale, (vy1 - y) * scale)

    def rect(b: tuple[float, float, float, float], stroke: str, fill: str, w: float) -> str:
        x0, y0 = pt(b[0], b[3])
        x1, y1 = pt(b[2], b[1])
        return (
            f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{x1 - x0:.1f}" '
            f'height="{y1 - y0:.1f}" fill="{fill}" stroke="{stroke}" stroke-width="{w}"/>'
        )

    def poly(geometry, stroke: str, fill: str, w: float) -> str:
        if geometry is None or geometry.is_empty:
            return ""
        parts = [geometry] if geometry.geom_type == "Polygon" else list(geometry.geoms)
        out = []
        for part in parts:
            points = " ".join(
                f"{pt(x, y)[0]:.1f},{pt(x, y)[1]:.1f}"
                for x, y in part.exterior.coords
            )
            out.append(
                f'<polygon points="{points}" fill="{fill}" stroke="{stroke}" '
                f'stroke-width="{w}"/>'
            )
        return "\n".join(out)

    grid = []
    tile = area["tileSizeM"]
    for tx in range(area["area"]["tileRange"]["minX"], area["area"]["tileRange"]["maxX"] + 2):
        a = pt(tx * tile, miny)
        b = pt(tx * tile, maxy)
        grid.append(
            f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" '
            f'y2="{b[1]:.1f}" stroke="#2b3440" stroke-width="0.4"/>'
        )
    for ty in range(area["area"]["tileRange"]["minY"], area["area"]["tileRange"]["maxY"] + 2):
        a = pt(minx, ty * tile)
        b = pt(maxx, ty * tile)
        grid.append(
            f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" '
            f'y2="{b[1]:.1f}" stroke="#2b3440" stroke-width="0.4"/>'
        )

    label_y = 18
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="{1400 * height / width:.0f}"
     viewBox="0 0 {width * scale:.1f} {height * scale:.1f}">
  <rect width="100%" height="100%" fill="#101418"/>
  {rect(area["area"]["boundsLocalM"], "#e8c15a", "rgba(232,193,90,0.06)", 2.5)}
  {rect(CURRENT_FRAME_M, "#7f8ea3", "none", 1.6)}
  {poly(ring, "#e05a5a", "rgba(224,90,90,0.10)", 1.6)}
  {poly(cemetery, "#5ad07a", "rgba(90,208,122,0.18)", 1.2)}
  {"".join(grid)}
  <text x="12" y="{label_y}" fill="#e8c15a" font-family="monospace" font-size="14">
    B-2 target area: {int(area["area"]["tileCount"])} tiles of {int(tile)} m
    ({area["area"]["spanM"][0] / 1000:.3f} x {area["area"]["spanM"][1] / 1000:.3f} km),
    MKAD ring {area["mkad"]["ringAreaKm2"]:.1f} km2, cemetery {area["cemetery"]["areaHa"]:.1f} ha
  </text>
  <text x="12" y="{label_y + 18}" fill="#7f8ea3" font-family="monospace" font-size="12">
    grey: current 12 km frame; red: first MKAD; green: Northern Cemetery; grid: 1024 m tiles
  </text>
</svg>
"""


def main() -> int:
    if not PBF.exists():
        print(f"ERROR: PBF not found: {PBF}", file=sys.stderr)
        return 1

    header = osmium.io.Reader(str(PBF)).header()
    header_box = header.box()

    building: dict = {}
    collect_mkad(building)
    ring = polygon_union(building["ways"])
    if ring is None:
        print("ERROR: could not assemble the MKAD ring (no closed linework)", file=sys.stderr)
        return 1
    if not ring.is_valid:
        print(f"ERROR: MKAD ring is invalid ({ring.is_valid})", file=sys.stderr)
        return 1

    cemetery_raw: dict = {}
    collect_cemetery(CEMETERY_RELATION, cemetery_raw)
    cemetery = polygon_union(cemetery_raw.get("ways", []))

    minx, miny, maxx, maxy = area_bounds_m("city")
    target = box(minx, miny, maxx, maxy)
    current = box(*CURRENT_FRAME_M)
    tx0, ty0, tx1, ty1 = tile_range((minx, miny, maxx, maxy), CITY_TILE_SIZE_M)

    # Coverage is a hard requirement, not a note: the script fails instead of
    # publishing an area.json that claims a broken contract.
    failures: list[str] = []
    if not target.contains(ring):
        failures.append("the MKAD ring is not fully inside the target area")
    if cemetery is None:
        failures.append(
            f"Northern Cemetery relation {CEMETERY_RELATION} is missing from the PBF"
        )
    elif not target.contains(cemetery):
        failures.append("the Northern Cemetery is not fully inside the target area")
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    ring_bounds = ring.bounds
    margins = {
        "westM": round(ring_bounds[0] - minx, 1),
        "eastM": round(maxx - ring_bounds[2], 1),
        "southM": round(ring_bounds[1] - miny, 1),
        "northM": round(maxy - ring_bounds[3], 1),
    }
    coverage_pct = 100.0 * ring.intersection(current).area / ring.area

    area_doc = {
        "schema": 1,
        "generatedAt": "2026-11-10",
        "backlog": "B-2 — расширение карты как минимум до МКАД",
        "source": {
            "path": str(PBF.relative_to(ROOT)).replace("\\", "/"),
            "sha256": sha256_file(PBF),
            "sizeBytes": PBF.stat().st_size,
            "replicationTimestamp": header.get("osmosis_replication_timestamp"),
            "headerBboxLatLon": None if header_box is None else {
                "minLat": header_box.bottom_left.lat,
                "minLon": header_box.bottom_left.lon,
                "maxLat": header_box.top_right.lat,
                "maxLon": header_box.top_right.lon,
            },
            "provider": "BBBike Minsk extract (data/raw/Minsk.osm.pbf)",
        },
        "origin": {
            "lat": PILOT_CENTER_LAT,
            "lon": PILOT_CENTER_LON,
            "epsg": EPSG_UTM35N,
            "originUtm": [round(_ORIGIN[0], 3), round(_ORIGIN[1], 3)],
        },
        "tileSizeM": CITY_TILE_SIZE_M,
        "area": {
            "name": "city",
            "boundsLocalM": [minx, miny, maxx, maxy],
            "spanM": [maxx - minx, maxy - miny],
            "tileRange": {"minX": tx0, "minY": ty0, "maxX": tx1, "maxY": ty1},
            "tileCount": (tx1 - tx0 + 1) * (ty1 - ty0 + 1),
            "addresses": [
                f"{tx}_{ty}"
                for ty in range(ty0, ty1 + 1)
                for tx in range(tx0, tx1 + 1)
            ],
            "wgs84Approx": {
                "minLat": round(area_bbox("city")[0], 6),
                "minLon": round(area_bbox("city")[1], 6),
                "maxLat": round(area_bbox("city")[2], 6),
                "maxLon": round(area_bbox("city")[3], 6),
            },
        },
        "current": {
            "boundsLocalM": list(CURRENT_FRAME_M),
            "ringCoveragePct": round(coverage_pct, 1),
        },
        "mkad": {
            "definition": "first ring, OSM ways named 'МКАД' or 'МКАД, N-ы кіламетр' (МКАД-2 excluded)",
            "wayPieces": len(building["ways"]),
            "ringAreaKm2": round(ring.area / 1e6, 1),
            "boundsLocalM": rounded_bounds(ring_bounds),
            "valid": bool(ring.is_valid),
            "insideTargetArea": bool(target.contains(ring)),
            "marginsM": margins,
        },
        "cemetery": {
            "relationId": CEMETERY_RELATION,
            "name": cemetery_raw.get("tags", {}).get("name"),
            "nameRu": cemetery_raw.get("tags", {}).get("name:ru"),
            "areaHa": round(cemetery.area / 1e4, 1) if cemetery is not None else None,
            "boundsLocalM": rounded_bounds(cemetery.bounds) if cemetery is not None else None,
            "insideTargetArea": bool(target.contains(cemetery)) if cemetery is not None else False,
            "marginToNorthEdgeM": (
                round(maxy - cemetery.bounds[3], 1) if cemetery is not None else None
            ),
        },
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "area.json").write_text(
        json.dumps(area_doc, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (OUT_DIR / "coverage.svg").write_text(svg_map(area_doc, ring, cemetery), encoding="utf-8")

    print(f"MKAD: {len(building['ways'])} ways, ring {ring.area / 1e6:.1f} km2, "
          f"bounds {rounded_bounds(ring_bounds)}")
    print(f"Area: {area_doc['area']['tileCount']} tiles "
          f"({tx0}..{tx1} x {ty0}..{ty1}), span "
          f"{area_doc['area']['spanM'][0] / 1000:.3f} x {area_doc['area']['spanM'][1] / 1000:.3f} km")
    print(f"Margins: {margins}; ring inside area: {area_doc['mkad']['insideTargetArea']}")
    print(f"Current 12 km frame covers {coverage_pct:.1f}% of the ring territory")
    print(f"Cemetery: {area_doc['cemetery']['name']} "
          f"{area_doc['cemetery']['areaHa']} ha, inside: {area_doc['cemetery']['insideTargetArea']}, "
          f"north margin {area_doc['cemetery']['marginToNorthEdgeM']} m")
    print(f"Wrote {OUT_DIR / 'area.json'} and {OUT_DIR / 'coverage.svg'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
