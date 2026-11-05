"""Deterministic tree placement for parks, forests, tree rows and cemeteries.

This module is the tree placement stage of the normaliser. It is kept free of
I/O and of the rest of the pipeline so every rule can be unit-tested on
synthetic local-metre polygons (see `tests/test_trees.py`).

Status (payload 0.4.3)
----------------------
* W2: the placement used to live inline in `normalize.py`; it now lives here as
  pure functions. `normalize.py` only loads the raw GeoJSON/JSON, builds the
  exclusion geometry and writes the statistics.
* W3: mapped OSM trees (`natural=tree` nodes) and `natural=tree_row` lines are
  the authoritative data. Rows become evenly spaced points (7 m) and are marked
  `mapped` like the nodes; duplicates near a mapped node are dropped. A mapped
  tree is removed only when it stands on a hard surface (building, water, rail,
  carriageway) with a 0.5 m margin - footpaths, pavements, plazas and other open
  surfaces never remove mapped trees.
* W4: overlapping vegetation polygons become disjoint `VegetationZone`s. In an
  overlap the smaller (more specific) polygon wins, so grass inside a park stays
  grass, forest inside a park stays forest and forest inside a cemetery stays
  forest. Open surfaces (pitch, plaza, sand, water, construction, railway) are
  cut out of the zones.
* W5: cемetery zones are planted on a grid aligned with the long side of the
  `minimum_rotated_rectangle` (7 m between rows, 6 m between trees in a row,
  < 1 m offset) with a deterministic fraction of the grid nodes kept to reach
  1 tree / 90 m2, heights 8-16 m.
* W6: the city-wide cap is a *budget*, not an order-based truncation. Every zone
  gets a target (area / density minus the mapped trees already standing there),
  all heuristic targets are scaled by one common coefficient `k` when their sum
  plus the mapped trees exceeds `max_total_trees`, heuristic trees keep
  `radius + 2 m` clear of mapped trunks, and a tile over `MAX_TREES_PER_TILE`
  is thinned deterministically in the pipeline (mapped trees are never thinned).
  An optional pass keeps the tiered triangle count (see
  `src/city/environment/treeMeshes.ts`) inside a `triangle_budget`; it is off
  by default since the full-density decision (B-1, measured: +0.38 ms per
  frame on the whole-city overview for 3.9 M instead of 1.6 M tree triangles).
* Every zone has its own RNG seeded from a stable zone feature (kind + rounded
  centroid + area), so the result does not depend on polygon order.
"""

from __future__ import annotations

import hashlib
import math
import random
from collections.abc import Callable, Iterable, Sequence

from shapely import STRtree, union_all
from shapely.geometry import LineString, Point, Polygon, box

# --- placement model --------------------------------------------------------

# One heuristic tree per N square metres of zone area.
TREE_DENSITY: dict[str, float] = {
    "forest": 55.0,
    "park": 125.0,
    "cemetery": 90.0,
    "scrub": 180.0,
    "grass": 650.0,
}

# Smaller pieces do not justify vegetation at all (kept from the pre-0.4.3
# heuristic; the narrow-strip test below throws out road medians and verges).
MIN_POLY_AREA: dict[str, float] = {
    "forest": 180.0,
    "park": 220.0,
    "cemetery": 400.0,
    "scrub": 260.0,
    "grass": 900.0,
}

TREE_HEIGHT: dict[str, tuple[float, float]] = {
    "forest": (9.0, 17.0),
    "park": (6.5, 13.5),
    "cemetery": (8.0, 16.0),
    "scrub": (4.0, 9.0),
    "grass": (5.5, 11.0),
}

# Road medians, verges and river banks are min(rect side) < 7 m.
MIN_STRIP_WIDTH_M = 7.0

# Rows: a point every 7 m along the mapped line.
TREE_ROW_STEP_M = 7.0
# A row point this close to a mapped node is a duplicate of that node.
ROW_DUPLICATE_RADIUS_M = 3.0

# Mapped trees are dropped only when they stand inside a hard surface
# (building / water / rail / carriageway); the margin absorbs small mapping
# offsets. Footpaths, pavements and plazas never remove a mapped tree.
MAPPED_MARGIN_M = 0.5
# Heuristic trees stay clear of every paved / open surface with a wider margin.
HEURISTIC_MARGIN_M = 3.0
# Heuristic trees also stay radius + 2 m away from a mapped trunk (W6).
MAPPED_TRUNK_CLEARANCE_M = 2.0

# W5 cemetery grid: rows are parallel to the long side of the minimum rotated
# rectangle (7 m between rows, 6 m between trees in a row) and the whole grid is
# offset by less than 1 m from the bounding corner. Only a deterministic
# fraction of the nodes is kept so the planted density is 1 tree / 90 m2.
CEMETERY_ROW_STEP_M = 7.0
CEMETERY_IN_ROW_STEP_M = 6.0
CEMETERY_GRID_OFFSET_M = 1.0

# Mirrors MAX_TREES_PER_TILE in src/city/environment/treeMeshes.ts. At full
# density the densest city tile holds ~12 200 trees.
MAX_TREES_PER_TILE = 16000
# Triangles for one tree at each detail tier of src/city/environment/treeMeshes.ts.
TREE_TRIANGLES_FULL = 38
TREE_TRIANGLES_LOD = 28
TREE_TRIANGLES_SIMPLE = 18
TREE_TRIANGLES_DENSE = 12
TREE_FULL_MAX = 160
TREE_LOD_MAX = 320
TREE_SIMPLE_MAX = 600
# Tree triangles of payload 0.4.2, kept as a reference value for callers that
# want the old budget back (`normalize.py --tree-triangle-budget 1603664`).
TREE_TRIANGLE_BUDGET_0_4_2 = 1_603_664

VEGETATION_KINDS = ("forest", "park", "cemetery", "scrub", "grass")
OPEN_SURFACE_KINDS = ("water", "river", "pitch", "plaza", "sand", "construction", "railway")


# --- geometry helpers -------------------------------------------------------


def iter_polygons(geom) -> list[Polygon]:
    """Every Polygon inside a shapely geometry (no nesting in the pipeline)."""
    if geom is None or geom.is_empty:
        return []
    kind = geom.geom_type
    if kind == "Polygon":
        return [geom]
    if kind in {"MultiPolygon", "GeometryCollection"}:
        out: list[Polygon] = []
        for part in geom.geoms:
            if part.geom_type == "Polygon" and not part.is_empty:
                out.append(part)
            elif part.geom_type in {"MultiPolygon", "GeometryCollection"}:
                out.extend(iter_polygons(part))
        return out
    return []


def iter_lines(geom) -> list[LineString]:
    """Every LineString inside a shapely geometry."""
    if geom is None or geom.is_empty:
        return []
    kind = geom.geom_type
    if kind == "LineString":
        return [geom]
    if kind in {"MultiLineString", "GeometryCollection"}:
        out: list[LineString] = []
        for part in geom.geoms:
            if part.geom_type == "LineString" and not part.is_empty:
                out.append(part)
            elif part.geom_type in {"MultiLineString", "GeometryCollection"}:
                out.extend(iter_lines(part))
        return out
    return []


def repair(geom):
    """make_valid + keep the polygonal part only."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        from shapely import make_valid

        geom = make_valid(geom)
    parts = iter_polygons(geom)
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    from shapely.geometry import MultiPolygon

    return MultiPolygon(parts)


def ring_polygon(rings: Sequence[Sequence[Sequence[float]]]) -> Polygon | None:
    """Payload rings ([[[x, y], ...], [hole...]]) -> repaired Polygon."""
    try:
        poly = Polygon(rings[0], [Polygon(ring).exterior.coords for ring in rings[1:]])
    except Exception:
        return None
    return repair(poly)


class Mask:
    """Point-in-polygon test against a set of exclusion polygons."""

    def __init__(self, geoms: Iterable[Polygon] | None):
        self.geoms = [geom for geom in (geoms or []) if geom is not None and not geom.is_empty]
        self.tree = STRtree(self.geoms) if self.geoms else None

    def __len__(self) -> int:
        return len(self.geoms)

    def blocked(self, x: float, y: float, margin: float) -> bool:
        if self.tree is None:
            return False
        return bool(self.tree.query(Point(x, y), predicate="dwithin", distance=margin).size)


class MappedTrunks:
    """`radius + 2 m` keep-out test around every mapped tree (W6).

    A plain STRtree of points with one shared radius would be wrong (crown
    radii differ), so the tree is queried with the largest radius and the exact
    per-tree radius is checked on the few candidates that come back.
    """

    def __init__(self, trees: Sequence[dict]):
        self.points = [Point(float(tree["x"]), float(tree["y"])) for tree in trees]
        self.radii = [
            float(tree["radius"]) + MAPPED_TRUNK_CLEARANCE_M for tree in trees
        ]
        self.max_radius = max(self.radii, default=0.0)
        self.tree = STRtree(self.points) if self.points else None

    def blocked(self, x: float, y: float) -> bool:
        if self.tree is None:
            return False
        point = Point(x, y)
        indices = self.tree.query(point, predicate="dwithin", distance=self.max_radius)
        return any(point.distance(self.points[i]) <= self.radii[i] for i in indices)


# --- mapped trees -----------------------------------------------------------


def _number(value) -> float | None:
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def mapped_tree_instance(raw: dict, to_local: Callable, half: float) -> dict | None:
    """OSM `natural=tree` node -> TreeInstance (height/crown fallbacks as 0.4.2)."""
    x, y = to_local(raw["lon"], raw["lat"])
    if not (-half <= x <= half and -half <= y <= half):
        return None
    seed = int(raw.get("osm_id") or 0) % 1000 / 1000.0
    height = _number(raw.get("height"))
    if height is None or not (2 <= height <= 40):
        height = 7.0 + seed * 8.0
    crown = _number(raw.get("crown"))
    radius = crown / 2 if crown and 0.5 <= crown <= 25 else height * 0.32
    return {
        "x": round(x, 2),
        "y": round(y, 2),
        "height": round(height, 2),
        "radius": round(radius, 2),
        "variation": round(seed, 3),
        "mapped": True,
    }


def _stable_row_seed(osm_id, index: int) -> float:
    """Per-point seed for a tree row (stable, independent of dict ordering)."""
    base = int(osm_id or 0)
    return ((base * 7919 + index * 104729 + 17) % 1000) / 1000.0


def _row_height(raw: dict, seed: float) -> float:
    height = _number(raw.get("height"))
    if height is None or not (2 <= height <= 40):
        height = 7.0 + seed * 8.0
    return height


def row_line(raw: dict, to_local: Callable) -> LineString | None:
    """`natural=tree_row` raw record -> local-metre polyline (or None)."""
    coords = raw.get("coords") or []
    points: list[tuple[float, float]] = []
    for coord in coords:
        try:
            lon, lat = float(coord[0]), float(coord[1])
        except (TypeError, ValueError, IndexError):
            continue
        try:
            points.append(to_local(lon, lat))
        except Exception:
            continue
    if len(points) < 2:
        return None
    try:
        line = LineString(points)
    except Exception:
        return None
    return None if line.is_empty or line.length <= 0 else line


def sample_row_line(line: LineString, step: float = TREE_ROW_STEP_M) -> list[tuple[float, float]]:
    """Points along a line every `step` metres, starting at the first vertex."""
    length = float(line.length)
    if length <= 0 or step <= 0:
        return []
    points: list[tuple[float, float]] = []
    distance = 0.0
    # The small epsilon keeps the end point when the length is an exact
    # multiple of the step despite floating-point projection noise.
    while distance <= length + 1e-9:
        point = line.interpolate(min(distance, length))
        points.append((float(point.x), float(point.y)))
        distance += step
    return points


def row_point_instances(
    rows: Sequence[dict],
    to_local: Callable,
    half: float,
) -> list[tuple[dict, int, dict]]:
    """Tree-row records -> `(raw row, point index, TreeInstance)` candidates.

    Rows are clipped to the area square ([-half, half]^2) before sampling. The
    instances carry the same fields as mapped nodes; `TreeInstance` has no
    `leaf_type` field, so conifers are only counted in the statistics (the
    payload format change is deliberately avoided in W3).
    """
    candidates: list[tuple[dict, int, dict]] = []
    area = box(-half, -half, half, half)
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        line = row_line(raw, to_local)
        if line is None:
            continue
        try:
            clipped = line.intersection(area)
        except Exception:
            continue
        index = 0
        for segment in iter_lines(clipped):
            for x, y in sample_row_line(segment):
                if not (-half <= x <= half and -half <= y <= half):
                    continue
                seed = _stable_row_seed(raw.get("osm_id"), index)
                index += 1
                height = _row_height(raw, seed)
                candidates.append((
                    raw,
                    index,
                    {
                        "x": round(x, 2),
                        "y": round(y, 2),
                        "height": round(height, 2),
                        "radius": round(height * 0.32, 2),
                        "variation": round(seed, 3),
                        "mapped": True,
                    },
                ))
    return candidates


# --- W4: non-overlapping vegetation zones -----------------------------------


def _zone_sort_key(kind: str, poly: Polygon) -> tuple:
    """Stable ordering key: smaller (more specific) polygons first.

    The WKB tail makes the key independent of the order in which the source
    polygons arrived (equal-area/centroid polygons still get a stable order).
    """
    centroid = poly.centroid
    minx, miny, maxx, maxy = poly.bounds
    return (
        round(float(poly.area), 6),
        kind,
        round(float(centroid.x), 3),
        round(float(centroid.y), 3),
        round(float(minx), 3),
        round(float(miny), 3),
        round(float(maxx), 3),
        round(float(maxy), 3),
        poly.wkb,
    )


def _zone_seed(kind: str, poly: Polygon) -> int:
    """RNG seed from a stable zone feature: kind + rounded centroid + area."""
    centroid = poly.centroid
    payload = f"{kind}|{centroid.x:.2f}|{centroid.y:.2f}|{poly.area:.1f}".encode()
    return int.from_bytes(hashlib.blake2b(payload, digest_size=8).digest(), "big")


def build_vegetation_zones(
    surfaces: Sequence[tuple[str, Polygon]],
    open_masks: Sequence[Polygon] = (),
    stats: dict | None = None,
) -> list[dict]:
    """Turn overlapping vegetation polygons into disjoint planting zones (W4).

    `surfaces` are `(kind, polygon)` pairs; only the five `VEGETATION_KINDS`
    participate. In an overlap the *smaller* polygon wins: grass inside a park
    stays grass, forest inside a park stays forest. `open_masks` (pitch, plaza,
    sand, water, construction, railway) are carved out of every zone.

    Returns a list of `{"kind", "polygon", "area", "seed"}` dicts ordered by a
    stable key. Zones below `MIN_POLY_AREA` / narrower than `MIN_STRIP_WIDTH_M`
    are dropped; `stats`, when given, receives the skip counters.
    """
    vegetation: list[tuple[str, Polygon]] = []
    for kind, polygon in surfaces:
        if kind not in VEGETATION_KINDS:
            continue
        poly = repair(polygon)
        if poly is None:
            continue
        for piece in iter_polygons(poly):
            if piece.area > 0:
                vegetation.append((kind, piece))
    if not vegetation:
        if stats is not None:
            stats["trees_zones_skipped_small"] = 0
            stats["trees_narrow_skipped"] = 0
        return []

    vegetation.sort(key=lambda item: _zone_sort_key(item[0], item[1]))
    geometry_index = STRtree([piece for _kind, piece in vegetation])

    # Process smallest first: an earlier polygon already owns the ground it
    # covers, so a later (larger) polygon only keeps the remainder.
    carved: list[Polygon | None] = []
    for index, (_kind, piece) in enumerate(vegetation):
        earlier_indices = sorted(
            int(j) for j in geometry_index.query(piece) if int(j) < index
        )
        earlier = [
            carved[j] for j in earlier_indices
            if carved[j] is not None and not carved[j].is_empty
        ]
        if earlier:
            try:
                remaining = piece.difference(union_all(earlier))
            except Exception:
                remaining = piece
        else:
            remaining = piece
        carved.append(repair(remaining))

    open_geoms: list[Polygon] = []
    for mask in open_masks:
        mask_poly = repair(mask)
        if mask_poly is not None:
            open_geoms.extend(iter_polygons(mask_poly))
    open_index = STRtree(open_geoms) if open_geoms else None

    zones: list[dict] = []
    skipped_small = 0
    skipped_narrow = 0
    for (kind, _piece), geom in zip(vegetation, carved):
        if geom is None or geom.is_empty:
            continue
        if open_index is not None:
            hole_indices = sorted(int(j) for j in open_index.query(geom))
            holes = [open_geoms[j] for j in hole_indices if not open_geoms[j].is_empty]
            if holes:
                try:
                    geom = repair(geom.difference(union_all(holes)))
                except Exception:
                    pass
        if geom is None or geom.is_empty:
            continue
        for part in iter_polygons(geom):
            if part.area < MIN_POLY_AREA[kind]:
                skipped_small += 1
                continue
            if narrow_strip(part):
                skipped_narrow += 1
                continue
            zones.append({
                "kind": kind,
                "polygon": part,
                "area": float(part.area),
                "seed": _zone_seed(kind, part),
            })

    zones.sort(key=lambda zone: _zone_sort_key(zone["kind"], zone["polygon"]))
    if stats is not None:
        stats["trees_zones_skipped_small"] = skipped_small
        stats["trees_narrow_skipped"] = skipped_narrow
    return zones


# --- heuristic placement ----------------------------------------------------


def narrow_strip(poly: Polygon) -> bool:
    """True for road medians, verges and river banks (min MBR side < 7 m)."""
    rect = poly.minimum_rotated_rectangle
    if rect.geom_type != "Polygon" or len(rect.exterior.coords) < 5:
        return False
    sides = [
        math.dist(rect.exterior.coords[i], rect.exterior.coords[i + 1])
        for i in range(4)
    ]
    return min(sides) < MIN_STRIP_WIDTH_M


def tile_of_point(x: float, y: float, tile_size: float) -> tuple[int, int]:
    """Tile index of a local-metre point (same partition as `normalize.py`)."""
    return (math.floor(x / tile_size), math.floor(y / tile_size))


def tree_detail_tier(count: int) -> str:
    """Tier chosen by the client for a tile with `count` trees."""
    if count <= TREE_FULL_MAX:
        return "full"
    if count <= TREE_LOD_MAX:
        return "lod"
    if count <= TREE_SIMPLE_MAX:
        return "simple"
    return "dense"


def triangles_for_tier(tier: str) -> int:
    if tier == "full":
        return TREE_TRIANGLES_FULL
    if tier == "lod":
        return TREE_TRIANGLES_LOD
    if tier == "simple":
        return TREE_TRIANGLES_SIMPLE
    return TREE_TRIANGLES_DENSE


def tile_triangles(count: int) -> int:
    """Triangles `treeMeshes.ts` would emit for a tile with `count` trees."""
    if count <= 0:
        return 0
    return count * triangles_for_tier(tree_detail_tier(count))


def _tree_priority(tree: dict) -> int:
    """Stable per-tree priority used for deterministic thinning."""
    payload = (
        f'{tree["x"]:.2f}|{tree["y"]:.2f}|{tree["height"]:.2f}|'
        f'{tree["radius"]:.2f}|{tree["variation"]:.3f}'
    )
    return int.from_bytes(hashlib.blake2b(payload.encode(), digest_size=8).digest(), "big")


def _heuristic_instance(rng: random.Random, x: float, y: float, kind: str) -> dict:
    low, high = TREE_HEIGHT[kind]
    seed = rng.random()
    height = low + seed * (high - low)
    return {
        "x": round(x, 2),
        "y": round(y, 2),
        "height": round(height, 2),
        "radius": round(height * (0.26 + 0.12 * seed), 2),
        "variation": round(seed, 3),
        "mapped": False,
    }


def _place_zone_trees(
    zone: dict,
    target: int,
    rng: random.Random,
    soft: Mask,
    trunks: MappedTrunks,
) -> list[dict]:
    """Rejection-sample `target` heuristic trees inside one non-cemetery zone."""
    placed: list[dict] = []
    if target <= 0:
        return placed
    kind = zone["kind"]
    poly = zone["polygon"]
    minx, miny, maxx, maxy = poly.bounds
    attempts = 0
    max_attempts = target * 14 + 20
    while len(placed) < target and attempts < max_attempts:
        attempts += 1
        x = rng.uniform(minx, maxx)
        y = rng.uniform(miny, maxy)
        if not poly.contains(Point(x, y)):
            continue
        if soft.blocked(x, y, HEURISTIC_MARGIN_M):
            continue
        if trunks.blocked(x, y):
            continue
        placed.append(_heuristic_instance(rng, x, y, kind))
    return placed


def cemetery_grid_points(poly: Polygon, rng: random.Random) -> list[tuple[float, float]]:
    """Grid nodes aligned with the long side of the minimum rotated rectangle.

    Rows run along the long side and are `CEMETERY_ROW_STEP_M` apart; nodes in a
    row are `CEMETERY_IN_ROW_STEP_M` apart. The grid is shifted by less than
    `CEMETERY_GRID_OFFSET_M` in both axes (deterministic from `rng`), so it does
    not sit exactly on the bounding rectangle. Only nodes inside the polygon are
    returned, in a stable order.
    """
    rect = poly.minimum_rotated_rectangle
    if rect is None or rect.geom_type != "Polygon" or rect.is_empty:
        return []
    corners = list(rect.exterior.coords)[:4]
    if len(corners) < 4:
        return []
    sides = [math.dist(corners[i], corners[(i + 1) % 4]) for i in range(4)]
    longest = max(range(4), key=lambda i: sides[i])
    start = corners[longest]
    end = corners[(longest + 1) % 4]
    length = math.hypot(end[0] - start[0], end[1] - start[1])
    if length <= 0:
        return []
    ux = (end[0] - start[0]) / length
    uy = (end[1] - start[1]) / length
    nx, ny = -uy, ux

    projections_u = [x * ux + y * uy for x, y in corners]
    projections_v = [x * nx + y * ny for x, y in corners]
    min_u, max_u = min(projections_u), max(projections_u)
    min_v, max_v = min(projections_v), max(projections_v)

    offset_u = rng.uniform(0.0, CEMETERY_GRID_OFFSET_M)
    offset_v = rng.uniform(0.0, CEMETERY_GRID_OFFSET_M)

    points: list[tuple[float, float]] = []
    u = min_u + offset_u
    while u <= max_u + 1e-9:
        v = min_v + offset_v
        while v <= max_v + 1e-9:
            x = u * ux + v * nx
            y = u * uy + v * ny
            if poly.contains(Point(x, y)):
                points.append((x, y))
            v += CEMETERY_ROW_STEP_M
        u += CEMETERY_IN_ROW_STEP_M
    return points


def _place_cemetery_trees(
    zone: dict,
    target: int,
    rng: random.Random,
    soft: Mask,
    trunks: MappedTrunks,
) -> list[dict]:
    """Plant a deterministic fraction of the aligned grid nodes (W5)."""
    placed: list[dict] = []
    if target <= 0:
        return placed
    poly = zone["polygon"]
    nodes = cemetery_grid_points(poly, rng)
    eligible = [
        (x, y) for x, y in nodes
        if not soft.blocked(x, y, HEURISTIC_MARGIN_M) and not trunks.blocked(x, y)
    ]
    if not eligible:
        return placed
    wanted = min(target, len(eligible))
    fraction = wanted / len(eligible)
    for x, y in eligible:
        if len(placed) >= wanted:
            break
        if rng.random() < fraction:
            placed.append(_heuristic_instance(rng, x, y, "cemetery"))
    if len(placed) < wanted:
        # The random pass can undershoot; fill the rest deterministically from
        # the same eligible node list so the density target is met exactly.
        used = {(tree["x"], tree["y"]) for tree in placed}
        for x, y in eligible:
            if len(placed) >= wanted:
                break
            key = (round(x, 2), round(y, 2))
            if key in used:
                continue
            placed.append(_heuristic_instance(rng, x, y, "cemetery"))
            used.add(key)
    return placed


# --- W6: budget, per-tile cap and triangle budget ---------------------------


def _apply_tile_cap(
    heuristic: list[dict],
    mapped_per_tile: dict[tuple[int, int], int],
    tile_size: float,
    max_trees_per_tile: int,
) -> tuple[dict[tuple[int, int], list[int]], int]:
    """Thin heuristic trees per tile; mapped trees are never thinned.

    Returns `(per-tile kept indices sorted by stable priority, removed count)`.
    The per-tile priority order is what the triangle pass re-uses, so both
    passes agree on which trees go first.
    """
    tile_entries: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for index, tree in enumerate(heuristic):
        tile = tile_of_point(tree["x"], tree["y"], tile_size)
        tile_entries.setdefault(tile, []).append((_tree_priority(tree), index))

    tile_kept: dict[tuple[int, int], list[int]] = {}
    removed = 0
    for tile, entries in tile_entries.items():
        entries.sort()
        allowed = max(0, max_trees_per_tile - mapped_per_tile.get(tile, 0))
        kept = entries[:allowed]
        removed += len(entries) - len(kept)
        tile_kept[tile] = [index for _priority, index in kept]
    return tile_kept, removed


def _apply_triangle_budget(
    tile_kept: dict[tuple[int, int], list[int]],
    mapped_per_tile: dict[tuple[int, int], int],
    triangle_budget: int | None,
) -> tuple[float, int]:
    """Keep the tiered triangle count inside `triangle_budget`.

    The per-tree triangle cost depends on the tile tier, and a tier boundary can
    make one removed tree *increase* a tile's triangle count (600 -> 18, 601 ->
    12), so this scans keep-fractions from 1.0 down instead of bisecting.
    """
    def total(keep_fraction: float) -> int:
        result = 0
        for tile, indices in tile_kept.items():
            kept = int(math.floor(len(indices) * keep_fraction + 1e-9))
            count = mapped_per_tile.get(tile, 0) + kept
            result += tile_triangles(count)
        return result

    if triangle_budget is None or total(1.0) <= triangle_budget:
        return 1.0, 0

    scale = 0.0
    steps = 512
    for step in range(steps, -1, -1):
        candidate = step / steps
        if total(candidate) <= triangle_budget:
            scale = candidate
            break
    removed = 0
    for indices in tile_kept.values():
        removed += len(indices) - int(math.floor(len(indices) * scale + 1e-9))
    return scale, removed


def build_trees(
    *,
    surfaces: Sequence[tuple[str, Polygon]],
    mapped_raw: Sequence[dict],
    row_raw: Sequence[dict] = (),
    hard_masks: Sequence[Polygon] = (),
    soft_masks: Sequence[Polygon] = (),
    to_local: Callable,
    half: float,
    max_total_trees: int,
    tile_size: float = 1024.0,
    max_trees_per_tile: int = MAX_TREES_PER_TILE,
    triangle_budget: int | None = None,
) -> tuple[list[dict], dict]:
    """Place mapped trees, tree rows and the W4-W6 heuristic fill.

    `surfaces` are `(kind, polygon)` pairs in local metres, `mapped_raw` is the
    `trees` list of `city_trees.json` and `row_raw` its `rows` list. Everything
    else is pre-built geometry: `hard_masks` are building / water / rail /
    carriageway polygons used for the 0.5 m mapped-tree rule, `soft_masks` are
    all surfaces heuristic trees must avoid.

    Returns `(trees, stats)`. Mapped trees come first, then row points, then the
    heuristic fill. Heuristic placement is budgeted (W6): a common scale `k` is
    applied to every zone target, then per-tile and triangle caps thin
    heuristic trees only.
    """
    stats: dict = {}

    # 1. mapped OSM nodes
    mapped_points: list[dict] = []
    for raw in mapped_raw:
        if not isinstance(raw, dict) or "lon" not in raw or "lat" not in raw:
            continue
        try:
            instance = mapped_tree_instance(raw, to_local, half)
        except Exception:
            continue
        if instance is not None:
            mapped_points.append(instance)
    stats["trees_mapped_points_raw"] = len(mapped_points)

    hard = Mask(hard_masks)
    # Heuristic placement also avoids the hard surfaces; keep the lists joined
    # so a caller may pass only one of them.
    soft = Mask([*soft_masks, *hard_masks])

    # 2. W3: a mapped node is authoritative unless it stands on a hard surface.
    kept_points = [
        tree for tree in mapped_points
        if not hard.blocked(tree["x"], tree["y"], MAPPED_MARGIN_M)
    ]
    stats["trees_mapped_points"] = len(kept_points)
    stats["trees_mapped_points_dropped"] = len(mapped_points) - len(kept_points)

    # 3. W3: tree rows become evenly spaced mapped points, then get the same
    # hard-surface rule and a 3 m duplicate check against mapped nodes.
    row_candidates = row_point_instances(row_raw, to_local, half)
    stats["trees_rows_raw"] = len(row_raw)
    stats["trees_mapped_rows_points_raw"] = len(row_candidates)
    point_tree = (
        STRtree([Point(tree["x"], tree["y"]) for tree in kept_points])
        if kept_points else None
    )
    row_trees: list[dict] = []
    row_dropped_mask = 0
    row_dropped_duplicate = 0
    row_needleleaved = 0
    for raw, _index, instance in row_candidates:
        if hard.blocked(instance["x"], instance["y"], MAPPED_MARGIN_M):
            row_dropped_mask += 1
            continue
        if point_tree is not None and point_tree.query(
            Point(instance["x"], instance["y"]),
            predicate="dwithin",
            distance=ROW_DUPLICATE_RADIUS_M,
        ).size:
            row_dropped_duplicate += 1
            continue
        row_trees.append(instance)
        if str(raw.get("leaf_type") or "").strip().lower() == "needleleaved":
            row_needleleaved += 1
    stats["trees_mapped_rows"] = len(row_trees)
    stats["trees_mapped_rows_dropped_mask"] = row_dropped_mask
    stats["trees_mapped_rows_dropped_duplicate"] = row_dropped_duplicate
    stats["trees_mapped_rows_needleleaved"] = row_needleleaved

    mapped_trees: list[dict] = [*kept_points, *row_trees]

    # 4. W4: disjoint vegetation zones. Open surfaces are cut out of the zones
    # so `area / density` counts plantable ground; the masks below still keep a
    # margin around them.
    open_masks: list[Polygon] = []
    for kind, polygon in surfaces:
        if kind not in OPEN_SURFACE_KINDS:
            continue
        open_poly = repair(polygon)
        if open_poly is not None:
            open_masks.extend(iter_polygons(open_poly))
    zones = build_vegetation_zones(surfaces, open_masks, stats)

    # 5. W6: per-zone target = area / density minus mapped trees in the zone.
    mapped_points_all = [Point(tree["x"], tree["y"]) for tree in mapped_trees]
    mapped_index = STRtree(mapped_points_all) if mapped_points_all else None
    zone_targets: list[int] = []
    zones_by_class: dict[str, int] = {}
    zone_area_by_class: dict[str, float] = {}
    mapped_in_zones = 0
    for zone in zones:
        kind = zone["kind"]
        zones_by_class[kind] = zones_by_class.get(kind, 0) + 1
        zone_area_by_class[kind] = zone_area_by_class.get(kind, 0.0) + zone["area"]
        target = int(zone["area"] / TREE_DENSITY[kind])
        mapped_inside = 0
        if mapped_index is not None and target > 0:
            # shapely evaluates the predicate as query.predicate(tree_geometry).
            mapped_inside = int(
                mapped_index.query(zone["polygon"], predicate="contains").size
            )
        mapped_in_zones += mapped_inside
        zone["mapped_inside"] = mapped_inside
        zone_targets.append(max(0, target - mapped_inside))

    total_mapped = len(mapped_trees)
    total_target = sum(zone_targets)
    available = max(0, max_total_trees - total_mapped)
    if total_target <= available or total_target == 0:
        budget_scale = 1.0
    else:
        budget_scale = available / total_target
    scaled_targets = [
        int(math.floor(target * budget_scale + 1e-9)) for target in zone_targets
    ]

    # 6. W5 + W6: one RNG per zone, seeded from a stable zone feature. This is
    # what makes the result independent of the polygon order.
    trunks = MappedTrunks(mapped_trees)
    heuristic: list[dict] = []
    heuristic_kinds: list[str] = []
    for zone, target in zip(zones, scaled_targets):
        rng = random.Random(zone["seed"])
        if zone["kind"] == "cemetery":
            placed = _place_cemetery_trees(zone, target, rng, soft, trunks)
        else:
            placed = _place_zone_trees(zone, target, rng, soft, trunks)
        heuristic.extend(placed)
        heuristic_kinds.extend([zone["kind"]] * len(placed))

    # 7. W6: per-tile cap, then the triangle budget. Both thin heuristic trees
    # only; mapped trees always stay.
    mapped_per_tile: dict[tuple[int, int], int] = {}
    for tree in mapped_trees:
        tile = tile_of_point(tree["x"], tree["y"], tile_size)
        mapped_per_tile[tile] = mapped_per_tile.get(tile, 0) + 1

    tile_kept, tile_thinned = _apply_tile_cap(
        heuristic, mapped_per_tile, tile_size, max_trees_per_tile
    )
    triangle_scale, triangle_thinned = _apply_triangle_budget(
        tile_kept, mapped_per_tile, triangle_budget
    )
    # The tile cap and the triangle pass both keep prefixes of the per-tile
    # priority lists, so the two filters compose into one final index set.
    final_indices: set[int] = set()
    for indices in tile_kept.values():
        kept = int(math.floor(len(indices) * triangle_scale + 1e-9))
        final_indices.update(indices[:kept])
    heuristic = [
        tree for index, tree in enumerate(heuristic) if index in final_indices
    ]
    heuristic_kinds = [
        kind for index, kind in enumerate(heuristic_kinds) if index in final_indices
    ]

    trees: list[dict] = [*mapped_trees, *heuristic]

    # 8. statistics
    heuristic_by_class = {kind: 0 for kind in VEGETATION_KINDS}
    for kind in heuristic_kinds:
        if kind in heuristic_by_class:
            heuristic_by_class[kind] += 1

    per_tile_count = dict(mapped_per_tile)
    for tree in heuristic:
        tile = tile_of_point(tree["x"], tree["y"], tile_size)
        per_tile_count[tile] = per_tile_count.get(tile, 0) + 1
    tile_triangle_counts = {
        tile: tile_triangles(count) for tile, count in per_tile_count.items()
    }

    stats["trees_mapped"] = total_mapped
    stats["trees_heuristic"] = len(heuristic)
    stats["trees_total"] = len(trees)
    stats["trees_heuristic_by_class"] = heuristic_by_class
    stats["trees_budget_scale"] = round(budget_scale, 6)
    stats["trees_budget_target_total"] = total_target
    stats["trees_budget_available"] = available
    stats["trees_mapped_in_zones"] = mapped_in_zones
    stats["trees_zones"] = len(zones)
    stats["trees_zones_by_class"] = zones_by_class
    stats["trees_zone_area_m2_by_class"] = {
        kind: round(area, 1) for kind, area in zone_area_by_class.items()
    }
    stats["trees_limit_reached"] = int(budget_scale < 1.0)
    stats["trees_tile_thinned"] = tile_thinned
    stats["trees_max_per_tile"] = max(per_tile_count.values(), default=0)
    stats["trees_tiles_with_trees"] = len(per_tile_count)
    stats["trees_triangles"] = sum(tile_triangle_counts.values())
    stats["trees_max_triangles_per_tile"] = max(tile_triangle_counts.values(), default=0)
    stats["trees_triangle_scale"] = round(triangle_scale, 6)
    stats["trees_triangle_thinned"] = triangle_thinned
    stats["trees_triangle_budget"] = triangle_budget
    stats["trees_narrow_skipped"] = stats.get("trees_narrow_skipped", 0)
    return trees, stats
