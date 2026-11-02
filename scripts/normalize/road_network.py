"""Road network normalization (payload 0.2.0).

The old pipeline emitted one buffered polygon per OSM way. At junctions those
buffers overlap each other and the class-tinted fills + per-polygon height
jitter produced the visible "stacked layers" / patchwork artefacts: every new
detail layer (tint, marking, zebra) inevitably landed on top of another one.

This module replaces that with two clean layers:

1. **Surface partition** - non-overlapping polygons for one of
   ``drivable | paving | kerb | median``. Drivable surface is further split
   into material zones (``asphalt | stone | concrete | unpaved``) by a
   priority partition, so a material change is a crisp shared edge instead of
   two overlapping tints.
2. **Road network** - per-way centrelines with the normalized width, lane
   count, direction and material, plus junction boxes and pedestrian
   crossings. The renderer derives markings/zebras/stop lines from this
   semantic layer, never from the surface polygons.

Width normalization is the other half of the fix: the old model used
``max(class_default, lanes * 3.1)``, which gave every ``primary`` way 18 m -
including each carriageway of a dual carriageway tagged ``oneway=yes``. That
is why paired one-way carriageways (Independence Avenue, Pobediteley Avenue,
Nemiga, Gorodskoy Val, ...) overlapped by thousands of square metres. Widths
are now derived per carriageway (lanes x 3.0 m + shoulders) and made
consistent per named street.

The module is pure geometry over local-metre shapely objects; it knows nothing
about tiles, JSON or the renderer. ``normalize.py`` clips the results to the
tile grid.
"""

from __future__ import annotations

import math
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Iterable

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree

# --- tuning constants -------------------------------------------------------

LANE_WIDTH_M = 3.0
SHOULDER_M = 0.6
MIN_ROAD_WIDTH_M = 4.0
MAX_ROAD_WIDTH_M = 26.0
MIN_PATH_WIDTH_M = 1.0
MAX_PATH_WIDTH_M = 10.0
MIN_SURFACE_AREA_M2 = 0.5
MIN_PAVING_AREA_M2 = 2.0
MIN_KERB_AREA_M2 = 0.5
MIN_MEDIAN_AREA_M2 = 4.0

# Junction corner fillets (payload 0.2.0 round 2): see build_road_network.
JUNCTION_FILLET_RADIUS_M = 4.5
JUNCTION_FILLET_CONTEXT_M = 6.0
MIN_FILLET_AREA_M2 = 3.0

# --- OSM -> normalized classes / widths / materials -------------------------

ROAD_CLASS_NORMALISE = {
    "motorway_link": "motorway",
    "trunk_link": "trunk",
    "primary_link": "primary",
    "secondary_link": "secondary",
    "tertiary_link": "tertiary",
    "unclassified": "residential",
    "construction": "unknown",
    "road": "unknown",
}

# Two-way carriageway width by class, metres (kept in sync with the renderer's
# ROAD_WIDTH_M; this table is the pipeline source of truth).
ROAD_WIDTH_TWO_WAY = {
    "motorway": 22.0,
    "trunk": 20.0,
    "primary": 18.0,
    "secondary": 15.0,
    "tertiary": 13.0,
    "residential": 9.0,
    "service": 5.5,
    "living_street": 6.0,
    "pedestrian": 8.0,
    "unknown": 6.0,
    "track": 3.5,
    "footway": 2.5,
    "cycleway": 2.5,
    "path": 2.0,
    "steps": 2.5,
}

# One-way carriageway width by class: the class default describes a whole
# street, so each separately mapped direction gets roughly half of it.
ROAD_WIDTH_ONE_WAY = {
    "motorway": 11.0,
    "trunk": 10.5,
    "primary": 9.5,
    "secondary": 8.0,
    "tertiary": 7.0,
    "residential": 6.0,
    "service": 5.5,
    "living_street": 6.0,
    "unknown": 6.0,
    "pedestrian": 8.0,
    "track": 3.5,
    "footway": 2.5,
    "cycleway": 2.5,
    "path": 2.0,
    "steps": 2.5,
}

PATH_CLASSES = {"footway", "cycleway", "path", "steps", "pedestrian", "track"}
SIDEWALK_CLASSES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "living_street",
}
SIDEWALK_DEFAULT_WIDTH_M = 3.0

# Kerb strips are only derived along the street classes where a kerb reads at
# pixel scale (same set as the renderer's legacy KERB_CLASSES); deriving them
# around every service alley would multiply the triangle/payload budget.
KERB_CLASSES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "living_street",
}

# Higher rank wins a junction / overlap; keeps the "big street owns the
# junction" reading that real junctions have.
CLASS_RANK = {
    "motorway": 7,
    "trunk": 6,
    "primary": 5,
    "secondary": 4,
    "tertiary": 3,
    "residential": 2,
    "living_street": 1,
    "service": 0,
    "pedestrian": 0,
    "track": 0,
    "unknown": 0,
    "footway": 0,
    "cycleway": 0,
    "path": 0,
    "steps": 0,
}

MATERIAL_RANK = {"asphalt": 3, "stone": 2, "concrete": 1, "unpaved": 0}
PAVED_MATERIALS = {"asphalt", "stone", "concrete"}

# OSM `surface` values folded into the small renderer material palette.
SURFACE_MATERIAL = {
    "asphalt": "asphalt",
    "paved": "asphalt",
    "chipseal": "asphalt",
    "sett": "stone",
    "cobblestone": "stone",
    "cobblestone:flattened": "stone",
    "unhewn_cobblestone": "stone",
    "paving_stones": "stone",
    "concrete": "concrete",
    "concrete:plates": "concrete",
    "ground": "unpaved",
    "dirt": "unpaved",
    "earth": "unpaved",
    "unpaved": "unpaved",
    "gravel": "unpaved",
    "fine_gravel": "unpaved",
    "compacted": "unpaved",
    "sand": "unpaved",
    "grass": "unpaved",
    "wood": "unpaved",
    "dirt/sand": "unpaved",
}

# Material rules. An explicit OSM `surface` is authoritative for its way (a
# long street may legitimately change material along its length - e.g. Karl
# Marx Street is sett/cobblestone from the House of Officers towards Yanka
# Kupala and asphalt further on). Untagged ways inherit the street's majority
# material (weighted by length) so the surface does not flip arbitrarily
# between segments; only the material *zones* are resolved by the priority
# partition, never by stacking polygons on top of each other.
SURFACE_OVERRIDES: dict[tuple[str, int], str] = {}


# --- small helpers ----------------------------------------------------------

def _num(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def normalise_road_class(tags: dict[str, str]) -> str:
    raw = (tags.get("highway") or "unknown").strip().lower()
    return ROAD_CLASS_NORMALISE.get(raw, raw)


def parse_lanes(tags: dict[str, str]) -> int | None:
    for key in ("lanes", "lanes:forward", "lanes:backward"):
        value = _num(tags.get(key))
        if value is not None and 1 <= value <= 12:
            return int(round(value))
    return None


def parse_oneway(tags: dict[str, str]) -> bool:
    value = (tags.get("oneway") or "").strip().lower()
    if value in ("yes", "true", "1", "-1"):
        return True
    if value == "no":
        return False
    return (tags.get("junction") or "").strip().lower() == "roundabout"


def parse_material(tags: dict[str, str]) -> tuple[str | None, str | None]:
    """Return (material, raw surface) for an explicitly tagged surface."""
    raw = (tags.get("surface") or "").strip().lower()
    if not raw:
        return None, None
    return SURFACE_MATERIAL.get(raw, "asphalt"), raw


def carriageway_width(tags: dict[str, str], cls: str, oneway: bool, path: bool) -> float:
    """Normalized carriageway width in metres.

    Explicit ``width`` is used as the carriageway width. Otherwise the lane
    count wins; the class default is only a fallback and is *never* used as a
    floor (that was the paired-one-way bug).
    """
    explicit = _num(tags.get("width"))
    if explicit is not None and 0.5 <= explicit <= 60.0:
        low, high = (MIN_PATH_WIDTH_M, MAX_PATH_WIDTH_M) if path else (MIN_ROAD_WIDTH_M, MAX_ROAD_WIDTH_M)
        return min(max(explicit, low), high)
    lanes = parse_lanes(tags)
    if lanes is not None:
        width = lanes * LANE_WIDTH_M + SHOULDER_M
    else:
        table = ROAD_WIDTH_ONE_WAY if oneway else ROAD_WIDTH_TWO_WAY
        width = table.get(cls, 6.0)
    low, high = (MIN_PATH_WIDTH_M, MAX_PATH_WIDTH_M) if path else (MIN_ROAD_WIDTH_M, MAX_ROAD_WIDTH_M)
    return min(max(width, low), high)


def street_key(tags: dict[str, str], kind: str, osm_id: int) -> tuple:
    """Street identity used for consistent width/material.

    Named ways group by name (with name:ru / name:be fallbacks); unnamed ways
    stay individual so a service-alley network is never forced onto one width.
    """
    name = (
        (tags.get("name") or "").strip()
        or (tags.get("name:ru") or "").strip()
        or (tags.get("name:be") or "").strip()
    )
    if name:
        return (kind, name.lower())
    return (kind, "__way__", int(osm_id))


def _iter_polys(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        out: list[Polygon] = []
        for part in geom.geoms:
            out.extend(_iter_polys(part))
        return out
    return []


def _iter_lines(geom) -> list[LineString]:
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type in ("MultiLineString", "GeometryCollection"):
        out: list[LineString] = []
        for part in geom.geoms:
            out.extend(_iter_lines(part))
        return out
    return []


def _union(geoms: Iterable) -> object:
    items = [g for g in geoms if g is not None and not g.is_empty]
    if not items:
        return Polygon()
    if len(items) == 1:
        return items[0]
    return unary_union(items)


def _clean(geom, min_area: float = MIN_SURFACE_AREA_M2):
    """Buffer(0) repair + drop components smaller than min_area."""
    if geom is None or geom.is_empty:
        return Polygon()
    if not geom.is_valid:
        geom = geom.buffer(0)
    parts = [p for p in _iter_polys(geom) if p.area >= min_area]
    return _union(parts)


def _tangent_at(line: LineString, point: Point) -> tuple[float, float] | None:
    """Unit tangent of a line at the station nearest `point`."""
    station = line.project(point)
    a = line.interpolate(max(0.0, station - 1.0))
    b = line.interpolate(min(line.length, station + 1.0))
    dx, dy = b.x - a.x, b.y - a.y
    length = math.hypot(dx, dy)
    if not (length > 1e-9):
        return None
    return dx / length, dy / length


def _angle_between_lines(line_a: LineString, line_b: LineString, point: Point) -> float:
    ta = _tangent_at(line_a, point)
    tb = _tangent_at(line_b, point)
    if ta is None or tb is None:
        return 0.0
    dot = min(1.0, max(-1.0, ta[0] * tb[0] + ta[1] * tb[1]))
    angle = math.acos(abs(dot))
    return min(angle, math.pi - angle)


# --- way normalization ------------------------------------------------------

@dataclass
class RoadWay:
    osm_type: str
    osm_id: int
    tags: dict
    line: LineString
    cls: str
    kind: str  # 'road' | 'path'
    width: float
    lanes: int | None
    oneway: bool
    bridge: bool
    tunnel: bool
    name: str
    group: tuple = field(default_factory=tuple)
    material: str = "asphalt"
    surface: str | None = None
    width_raw: float = 0.0

    @property
    def priority(self) -> tuple:
        return (
            -CLASS_RANK.get(self.cls, 0),
            -self.width,
            -MATERIAL_RANK.get(self.material, 0),
            self.osm_id,
        )


def prepare_ways(ways: list[dict], pilot_rect) -> tuple[list[RoadWay], Counter]:
    """Project/validate raw ways and derive per-way width, direction, material."""
    stats = Counter()
    out: list[RoadWay] = []
    for entry in ways:
        tags = entry["tags"]
        raw_class = (tags.get("highway") or "unknown").strip().lower()
        cls = ROAD_CLASS_NORMALISE.get(raw_class, raw_class)
        if cls not in ROAD_WIDTH_TWO_WAY:
            stats["skipped_class"] += 1
            continue
        if tags.get("tunnel") == "yes":
            stats["tunnels_skipped"] += 1
            continue
        line = entry["line"]
        if not isinstance(line, LineString) or line.length < 1.0:
            stats["skipped_short"] += 1
            continue
        try:
            line = line.intersection(pilot_rect)
        except Exception:
            stats["skipped_invalid"] += 1
            continue
        segments = _iter_lines(line)
        for segment in segments:
            if segment.length < 1.0:
                continue
            oneway = parse_oneway(tags)
            kind = "path" if cls in PATH_CLASSES else "road"
            width_raw = carriageway_width(tags, cls, oneway, path=(kind == "path"))
            material, surface = parse_material(tags)
            override = SURFACE_OVERRIDES.get((entry.get("osm_type", "way"), int(entry["osm_id"])))
            if override is not None:
                material = override
                stats["material_overrides"] += 1
            way = RoadWay(
                osm_type=entry.get("osm_type", "way"),
                osm_id=int(entry["osm_id"]),
                tags=tags,
                line=segment,
                cls=cls,
                kind=kind,
                width=width_raw,
                lanes=parse_lanes(tags),
                oneway=oneway,
                bridge=tags.get("bridge") == "yes",
                tunnel=tags.get("tunnel") == "yes",
                name=(
                    (tags.get("name") or "")
                    or (tags.get("name:ru") or "")
                    or (tags.get("name:be") or "")
                ),
                material=material or "asphalt",
                surface=surface,
                width_raw=width_raw,
            )
            way.group = street_key(tags, kind, way.osm_id)
            out.append(way)
    stats["ways"] = len(out)
    return out, stats


def _weighted_median(values: list[tuple[float, float]]) -> float:
    """Median weighted by segment length (longer OSM ways dominate)."""
    items = sorted(values)
    total = sum(weight for _, weight in items)
    if total <= 0:
        return items[-1][0] if items else 0.0
    accumulated = 0.0
    for value, weight in items:
        accumulated += weight
        if accumulated >= total / 2.0:
            return value
    return items[-1][0]


def canonicalize(ways: list[RoadWay]) -> Counter:
    """One width and one material per street; drop near-duplicate ways."""
    stats = Counter()

    # 1. dedupe near-identical ways inside a street group
    groups: dict[tuple, list[RoadWay]] = defaultdict(list)
    for way in ways:
        groups[way.group].append(way)
    deduped: list[RoadWay] = []
    for group, members in groups.items():
        kept: list[RoadWay] = []
        for way in sorted(members, key=lambda w: (-w.line.length, -(w.lanes or 0), w.osm_id)):
            duplicate = False
            for other in kept:
                if way.line.length < 2.0 or other.line.length < 2.0:
                    continue
                if abs(way.line.length - other.line.length) > 0.25 * max(way.line.length, other.line.length):
                    continue
                if way.line.hausdorff_distance(other.line) <= 1.0:
                    duplicate = True
                    break
            if duplicate:
                stats["duplicates_dropped"] += 1
                continue
            kept.append(way)
        deduped.extend(kept)
    ways[:] = deduped

    # 2. canonical width per street AND direction. A street can be mapped as a
    #    pair of one-way carriageways over part of its length and as a single
    #    two-way road elsewhere; mixing both directions in one median makes a
    #    1-lane one-way section as wide as a 4-lane two-way one (the user saw
    #    exactly that on Engels Street). Group by `oneway` first.
    groups.clear()
    for way in ways:
        groups[way.group].append(way)
    for group, members in groups.items():
        road_members = [w for w in members if w.kind == "road"]
        path_members = [w for w in members if w.kind == "path"]
        for direction in (True, False):
            subset = [w for w in road_members if w.oneway == direction]
            if len(subset) >= 2:
                canonical = _weighted_median(
                    [(w.width_raw, w.line.length) for w in subset]
                )
                for way in subset:
                    if abs(way.width_raw - canonical) > 0.05:
                        stats["widths_normalized"] += 1
                    way.width = round(canonical, 2)
            elif len(subset) == 1:
                subset[0].width = round(subset[0].width_raw, 2)
        for way in path_members:
            way.width = round(way.width_raw, 2)
        stats["groups"] += 1

    # 3. material: explicit tags are authoritative, untagged ways inherit the
    #    street majority (weighted by length). Genuine long material changes
    #    survive as separate zones with a crisp shared edge.
    groups.clear()
    for way in ways:
        groups[way.group].append(way)
    for group, members in groups.items():
        tagged = [w for w in members if w.surface is not None]
        if not tagged:
            for way in members:
                way.material = "asphalt"
            continue
        by_material: dict[str, float] = defaultdict(float)
        for way in tagged:
            by_material[way.material] += way.line.length
        canonical_material = max(
            by_material.items(), key=lambda item: (item[1], MATERIAL_RANK.get(item[0], 0))
        )[0]
        if len(by_material) > 1:
            stats["mixed_material_groups"] += 1
        for way in members:
            if way.surface is None:
                way.material = canonical_material
                stats["material_inherited"] += 1
            elif way.material != canonical_material:
                stats["material_runs_kept"] += 1
    return stats


def way_buffers(ways: list[RoadWay]) -> list:
    buffers = []
    for way in ways:
        try:
            buffers.append(way.line.buffer(way.width / 2.0, cap_style=2, join_style=2))
        except Exception:
            buffers.append(Polygon())
    return buffers


# --- surface partition ------------------------------------------------------

def material_zones(ways: list[RoadWay]) -> tuple[dict[str, object], Counter]:
    """Priority-partition the drivable buffers into non-overlapping material zones."""
    stats = Counter()
    if not ways:
        return {}, stats
    buffers = way_buffers(ways)
    tree = STRtree(buffers)
    assigned: dict[int, object] = {}
    order = sorted(range(len(ways)), key=lambda index: ways[index].priority)
    for index in order:
        geom = buffers[index]
        if geom.is_empty:
            continue
        candidates = [int(j) for j in tree.query(geom) if int(j) in assigned and int(j) != index]
        if candidates:
            try:
                geom = geom.difference(_union([assigned[j] for j in candidates]))
            except Exception:
                stats["partition_failures"] += 1
                continue
        geom = _clean(geom, MIN_SURFACE_AREA_M2)
        if geom.is_empty:
            continue
        assigned[index] = geom
    by_material: dict[str, list] = defaultdict(list)
    for index, geom in assigned.items():
        by_material[ways[index].material].append(geom)
    zones = {material: _union(geoms) for material, geoms in by_material.items()}
    stats["zones"] = len(zones)
    return zones, stats


# --- junctions --------------------------------------------------------------

def junction_boxes(ways: list[RoadWay]) -> tuple[list[dict], dict[str, object], Counter]:
    """Junction boxes from pairwise buffer intersections of *different* streets."""
    stats = Counter()
    if not ways:
        return [], {}, stats
    buffers = way_buffers(ways)
    tree = STRtree(buffers)
    pieces: list[Polygon] = []
    for i, way_a in enumerate(ways):
        for raw_index in tree.query(buffers[i]):
            j = int(raw_index)
            if j <= i:
                continue
            way_b = ways[j]
            if way_a.group == way_b.group:
                continue
            if not buffers[i].intersects(buffers[j]):
                continue
            try:
                intersection = buffers[i].intersection(buffers[j])
            except Exception:
                continue
            for piece in _iter_polys(intersection):
                if piece.area < 2.0:
                    continue
                rect = piece.minimum_rotated_rectangle
                if rect.geom_type != "Polygon":
                    continue
                coords = list(rect.exterior.coords)
                if len(coords) < 5:
                    continue
                sides = [math.dist(coords[k], coords[k + 1]) for k in range(4)]
                if min(sides) < 2.0:
                    continue
                centre = piece.representative_point()
                if _angle_between_lines(way_a.line, way_b.line, centre) < math.radians(20.0):
                    continue
                pieces.append(piece.buffer(0.5, join_style=1))
    if not pieces:
        return [], {}, stats
    clusters = _clean(_union(pieces), 4.0)
    junction_polys = [p for p in _iter_polys(clusters) if p.area >= 4.0]
    junctions: list[dict] = []
    for poly in junction_polys:
        centre = poly.representative_point()
        radius = max(centre.distance(Point(coord)) for coord in poly.exterior.coords)
        radius = min(max(radius, 3.0), 30.0)
        # number of distinct streets whose corridor meets the box
        groups_near = {
            ways[int(i)].group for i in tree.query(poly) if buffers[int(i)].intersects(poly)
        }
        junctions.append({
            "x": round(centre.x, 2),
            "y": round(centre.y, 2),
            "radius": round(radius, 2),
            "approaches": max(2, len(groups_near)),
        })
    stats["junction_pair_pieces"] = len(pieces)
    stats["junctions"] = len(junctions)
    clip_geom = _union(junction_polys)
    return junctions, {"polygons": clip_geom}, stats


# --- crossings --------------------------------------------------------------

CROSSING_MATCH_RADIUS_M = 22.0
CROSSING_DEDUPE_SAME_STREET_M = 18.0
CROSSING_MERGE_M = 8.0
CROSSING_MERGE_ANGLE_RAD = math.radians(20.0)
CROSSING_SPAN_M = 4.0

KIND_RANK = {"signals": 3, "zebra": 2, "unmarked": 1}


def crossing_kind(tags: dict[str, str]) -> str:
    """Classify a crossing/signal node.

    A bare ``highway=traffic_signals`` node is a signal head (stop line only).
    A pedestrian crossing (``highway=crossing``), including the very common
    ``crossing=traffic_signals`` combination, is painted as a zebra: signalised
    pedestrian crossings in Minsk still carry zebra markings, and the renderer
    adds stop lines for the zebra kind as well. Only an explicitly unmarked
    crossing stays paint-free.
    """
    highway = (tags.get("highway") or "").strip().lower()
    crossing = (tags.get("crossing") or "").strip().lower()
    markings = (tags.get("crossing:markings") or "").strip().lower()
    if highway == "traffic_signals":
        return "signals"
    if crossing in ("unmarked", "no") or markings in ("no", "none"):
        return "unmarked"
    return "zebra"


def _strip_for_pair(way_a: RoadWay, way_b: RoadWay) -> Polygon | None:
    """Median strip between the inner edges of two parallel one-way ways."""
    a, b = way_a.line, way_b.line
    length = a.length
    samples = max(2, int(round(length / 6.0)))
    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []
    for step in range(samples + 1):
        station = length * step / samples
        point = a.interpolate(station)
        try:
            nearest = nearest_points(b, point)[0]
        except Exception:
            return None
        gap = point.distance(nearest)
        if gap < 0.5 or gap > 25.0:
            return None
        dx, dy = nearest.x - point.x, nearest.y - point.y
        norm = math.hypot(dx, dy)
        if norm < 1e-9:
            return None
        dx, dy = dx / norm, dy / norm
        inner_a = (point.x + dx * way_a.width / 2.0, point.y + dy * way_a.width / 2.0)
        inner_b = (nearest.x - dx * way_b.width / 2.0, nearest.y - dy * way_b.width / 2.0)
        if math.dist(inner_a, inner_b) < 1.0:
            return None
        left.append(inner_a)
        right.append(inner_b)
    if len(left) < 3:
        return None
    ring = left + right[::-1]
    if len(ring) < 4:
        return None
    poly = Polygon(ring)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly if not poly.is_empty else None


def derived_lanes(way: RoadWay) -> int:
    """Lane count for marking layout: tagged lanes, else inferred from width."""
    if way.lanes:
        return max(1, min(int(way.lanes), 8))
    return max(1, min(8, int(round((way.width - 0.6) / 3.0))))


def _midline_between(way_a: RoadWay, way_b: RoadWay) -> LineString | None:
    """Midline polyline between two near-coincident opposite carriageways."""
    a, b = way_a.line, way_b.line
    if a.length < b.length:
        a, b = b, a
    length = a.length
    samples = max(3, int(round(length / 8.0)))
    points: list[tuple[float, float]] = []
    for step in range(samples + 1):
        point = a.interpolate(length * step / samples)
        try:
            other = nearest_points(b, point)[0]
        except Exception:
            return None
        if point.distance(other) > 25.0:
            continue
        points.append(((point.x + other.x) / 2.0, (point.y + other.y) / 2.0))
    if len(points) < 2:
        return None
    line = LineString(points)
    if line.length < 8.0:
        return None
    simplified = line.simplify(0.5, preserve_topology=False)
    return simplified if simplified.length >= 8.0 else line


def _parallel_fraction(way_a: RoadWay, way_b: RoadWay, max_distance: float = 20.0) -> float:
    """Share of `way_a` that runs parallel to (and near) `way_b`."""
    line_a, line_b = way_a.line, way_b.line
    length = line_a.length
    if length < 1.0:
        return 0.0
    samples = max(4, int(round(length / 10.0)))
    good = 0
    total = 0
    for step in range(samples + 1):
        point = line_a.interpolate(length * step / samples)
        try:
            other = nearest_points(line_b, point)[0]
        except Exception:
            continue
        total += 1
        if point.distance(other) > max_distance:
            continue
        tangent_a = _tangent_at(line_a, point)
        tangent_b = _tangent_at(line_b, other)
        if tangent_a is None or tangent_b is None:
            continue
        if tangent_a[0] * tangent_b[0] + tangent_a[1] * tangent_b[1] <= -0.2:
            good += 1
    return good / max(total, 1)


def pair_analysis(ways: list[RoadWay]) -> dict:
    """Analyse opposite one-way carriageway pairs of the same street.

    Returns:
      merged: pairs so close that the corridor is effectively one road; the
              network layer emits a single two-way piece (double solid centre
              line instead of two one-way dash columns), and the pair is
              consumed from the per-way emission.
      median_strips: gap polygons for pairs that stay two separate
              carriageways with a physical median between them.
      consumed: osm ids of the merged ways.
    """
    stats = Counter()
    candidates = [
        w for w in ways if w.kind == "road" and w.oneway and w.material in PAVED_MATERIALS
    ]
    groups: dict[tuple, list[RoadWay]] = defaultdict(list)
    for way in candidates:
        groups[way.group].append(way)
    merged: list[dict] = []
    median_strips: list[Polygon] = []
    consumed: set[int] = set()
    for group, members in sorted(groups.items(), key=lambda item: str(item[0])):
        if len(members) < 2:
            continue
        tree = STRtree([w.line for w in members])
        pairs: list[tuple[float, float, int, int]] = []
        for index, way_a in enumerate(members):
            for raw_index in tree.query(way_a.line.buffer(23.0, join_style=1)):
                other = int(raw_index)
                if other <= index:
                    continue
                way_b = members[other]
                if way_a.bridge != way_b.bridge:
                    continue
                distance = way_a.line.distance(way_b.line)
                if distance > 22.0:
                    continue
                # Both directions of one carriageway pair must run parallel
                # along most of their length. Two opposite sides of a square or
                # a loop sharing a name are not a dual carriageway.
                if _parallel_fraction(way_a, way_b) < 0.7:
                    continue
                length_ratio = way_a.line.length / max(way_b.line.length, 1e-6)
                if length_ratio < 0.5 or length_ratio > 2.0:
                    continue
                inner_gap = distance - (way_a.width + way_b.width) / 2.0
                pairs.append((inner_gap, distance, index, other))
        pairs.sort(key=lambda item: (item[0], item[1]))
        used: set[int] = set()
        for inner_gap, distance, index, other in pairs:
            if index in used or other in used:
                continue
            way_a, way_b = members[index], members[other]
            if inner_gap <= 0.0:
                # Carriageway buffers overlap: the corridor is one continuous
                # asphalt surface, so the centre line can be painted as a double
                # solid line without any paint-containment problem.
                midline = _midline_between(way_a, way_b)
                if midline is None:
                    continue
                merged.append({
                    "a": way_a,
                    "b": way_b,
                    "midline": midline,
                    "width": round(distance + (way_a.width + way_b.width) / 2.0, 2),
                    "lanes": max(2, derived_lanes(way_a) + derived_lanes(way_b)),
                    "bridge": way_a.bridge,
                })
                consumed.add(way_a.osm_id)
                consumed.add(way_b.osm_id)
                used.add(index)
                used.add(other)
                stats["merged_pairs"] += 1
            else:
                strip = _strip_for_pair(way_a, way_b)
                if strip is not None and strip.area >= 1.0:
                    median_strips.append(strip)
                    used.add(index)
                    used.add(other)
                    stats["median_pairs"] += 1
    stats["median_strips"] = len(median_strips)
    return {
        "merged": merged,
        "median_strips": median_strips,
        "consumed": consumed,
        "stats": stats,
    }


def median_polygons_from_zones(
    zones,
    drivable_geom,
    junction_clip,
    crossings: list[dict],
) -> tuple[list[Polygon], Counter]:
    """Turn median gap zones into renderable median surface pieces."""
    stats = Counter()
    if zones is None or zones.is_empty:
        return [], stats
    try:
        median = zones.difference(drivable_geom)
    except Exception:
        stats["median_subtract_failed"] += 1
        return [], stats
    subtractors = []
    if junction_clip is not None and not junction_clip.is_empty:
        subtractors.append(junction_clip.buffer(1.0))
    for crossing in crossings:
        subtractors.append(Point(crossing["x"], crossing["y"]).buffer(6.0))
    if subtractors:
        try:
            median = median.difference(_union(subtractors))
        except Exception:
            stats["median_subtract_failed"] += 1
    median = _clean(median, MIN_MEDIAN_AREA_M2)
    medians = [p for p in _iter_polys(median) if p.area >= MIN_MEDIAN_AREA_M2]
    stats["medians"] = len(medians)
    return medians, stats


def build_crossings(nodes: list[dict], ways: list[RoadWay]) -> tuple[list[dict], Counter]:
    """Project OSM crossing/signal nodes onto the road network and dedupe."""
    stats = Counter()
    drivable = [w for w in ways if w.kind == "road" and not w.bridge]
    stats["crossing_nodes"] = len(nodes)
    if not drivable or not nodes:
        return [], stats
    lines = [w.line for w in drivable]
    tree = STRtree(lines)
    accepted: list[dict] = []
    for node in sorted(nodes, key=lambda item: item.get("osm_id", 0)):
        point = Point(node["x"], node["y"])
        # Prefer the most important road whose carriageway actually contains
        # the crossing node; a nearest-centreline match used to snap pedestrian
        # crossings of a big avenue onto a parallel service road, which then
        # painted a stop line across the wrong street.
        best_key: tuple[float, float] | None = None
        best_index = -1
        for raw_index in tree.query(point.buffer(CROSSING_MATCH_RADIUS_M + 1.0)):
            index = int(raw_index)
            candidate = drivable[index]
            distance = lines[index].distance(point)
            if distance > CROSSING_MATCH_RADIUS_M:
                continue
            # The node must actually lie on the carriageway; among the roads
            # whose asphalt contains it, the widest one wins (a crossing of a
            # 9.6 m street should not snap to a 4 m slip link that happens to be
            # classed higher).
            if distance > candidate.width / 2.0 + 1.0:
                continue
            key = (-candidate.width, distance)
            if best_key is None or key < best_key:
                best_key = key
                best_index = index
        if best_index < 0:
            stats["crossing_unmatched"] += 1
            continue
        index = best_index
        way = drivable[index]
        station = way.line.project(point)
        on_line = way.line.interpolate(station)
        tangent = _tangent_at(way.line, on_line)
        if tangent is None:
            stats["crossing_unmatched"] += 1
            continue
        record = {
            "x": round(on_line.x, 2),
            "y": round(on_line.y, 2),
            "angle": round(math.atan2(tangent[1], tangent[0]), 4),
            "width": round(way.width, 2),
            "span": CROSSING_SPAN_M,
            "kind": crossing_kind(node["tags"]),
            "roadClass": way.cls,
            "material": way.material,
            "oneway": bool(way.oneway),
            "group": way.group,
            "osm_id": node.get("osm_id", 0),
        }
        merged = False
        for existing in accepted:
            distance = math.hypot(existing["x"] - record["x"], existing["y"] - record["y"])
            angle_delta = abs((existing["angle"] - record["angle"]) % math.pi)
            angle_delta = min(angle_delta, math.pi - angle_delta)
            if angle_delta > CROSSING_MERGE_ANGLE_RAD:
                continue
            if distance > CROSSING_DEDUPE_SAME_STREET_M:
                continue
            same_street = existing["group"] == record["group"]
            if distance <= CROSSING_MERGE_M or same_street:
                existing["x"] = round((existing["x"] + record["x"]) / 2.0, 2)
                existing["y"] = round((existing["y"] + record["y"]) / 2.0, 2)
                if KIND_RANK[record["kind"]] > KIND_RANK[existing["kind"]]:
                    existing["kind"] = record["kind"]
                stats["crossing_deduped"] += 1
                merged = True
                break
        if not merged:
            accepted.append(record)
    for record in accepted:
        record.pop("group", None)
        record.pop("osm_id", None)
    stats["crossings"] = len(accepted)
    stats["crossings_zebra"] = sum(1 for r in accepted if r["kind"] == "zebra")
    stats["crossings_signals"] = sum(1 for r in accepted if r["kind"] == "signals")
    stats["crossings_unmarked"] = sum(1 for r in accepted if r["kind"] == "unmarked")
    return accepted, stats


# --- public entry point -----------------------------------------------------

def build_road_network(
    ways: list[dict],
    crossing_nodes: list[dict],
    pilot_rect,
    water_areas: list[Polygon] | None = None,
) -> dict:
    """Normalize the whole road network for one area.

    ``ways`` items are ``{osm_type, osm_id, tags, line: LineString}`` in local
    metres. The return value is area-global; ``normalize.py`` clips it to the
    tile grid and serialises it.
    """
    started = time.time()
    stats = Counter()

    prepared, prepare_stats = prepare_ways(ways, pilot_rect)
    stats.update(prepare_stats)
    canonical_stats = canonicalize(prepared)
    stats.update(canonical_stats)

    drivable_ground = [w for w in prepared if w.kind == "road" and not w.bridge]
    drivable_bridge = [w for w in prepared if w.kind == "road" and w.bridge]
    path_ground = [w for w in prepared if w.kind == "path" and not w.bridge]
    path_bridge = [w for w in prepared if w.kind == "path" and w.bridge]

    water_polys = [p for p in (water_areas or []) if p is not None and not p.is_empty]
    water_tree = STRtree(water_polys) if water_polys else None

    def mostly_over_water(way: RoadWay) -> bool:
        if water_tree is None:
            return False
        try:
            buffer = way.line.buffer(way.width / 2.0, cap_style=2, join_style=2)
        except Exception:
            return False
        if buffer.is_empty or buffer.area <= 0:
            return False
        covered = 0.0
        for raw_index in water_tree.query(buffer):
            try:
                piece = water_polys[int(raw_index)].intersection(buffer)
                if not piece.is_empty:
                    covered += piece.area
            except Exception:
                continue
        return covered > buffer.area * 0.5

    path_ground_kept = [w for w in path_ground if not mostly_over_water(w)]
    stats["footways_over_water_dropped"] = len(path_ground) - len(path_ground_kept)
    path_ground = path_ground_kept

    # Opposite one-way carriageways of one street: either merge them into one
    # two-way corridor (when they practically touch, so a double solid centre
    # line is the correct paint) or keep a median gap between them.
    pair_info = pair_analysis(prepared)
    stats.update(pair_info["stats"])
    median_zones = _union(pair_info["median_strips"])

    # --- drivable surface ---------------------------------------------------
    zones, zone_stats = material_zones(drivable_ground)
    stats.update(zone_stats)
    bridge_zones, bridge_zone_stats = material_zones(drivable_bridge)
    stats.update({f"bridge_{k}": v for k, v in bridge_zone_stats.items()})
    drivable_ground_geom = _clean(_union(way_buffers(drivable_ground)), MIN_SURFACE_AREA_M2)
    drivable_bridge_geom = _clean(_union(way_buffers(drivable_bridge)), MIN_SURFACE_AREA_M2)
    if not drivable_ground_geom.is_empty:
        drivable_ground_geom = drivable_ground_geom.intersection(pilot_rect)
    if not drivable_bridge_geom.is_empty:
        drivable_bridge_geom = drivable_bridge_geom.intersection(pilot_rect)

    # --- junction boxes -----------------------------------------------------
    junctions, junction_geom, junction_stats = junction_boxes(drivable_ground)
    stats.update(junction_stats)

    # Corner fillets: roads meeting at shallow angles leave narrow unfilled
    # notches between their buffers inside the junction mouth (visible as small
    # wedges of paving cutting into the asphalt - the reported crossing
    # artifact). A morphological closing limited to junction neighbourhoods
    # fills those notches with asphalt; it is claimed only where no other
    # material already covers it, so the surface partition stays disjoint.
    fillet_extra = Polygon()
    junction_polygons = junction_geom.get("polygons") if junction_geom else None
    if (
        not drivable_ground_geom.is_empty
        and junction_polygons is not None
        and not junction_polygons.is_empty
    ):
        try:
            clip = junction_polygons.buffer(JUNCTION_FILLET_CONTEXT_M, join_style=2)
            closed = drivable_ground_geom.buffer(
                JUNCTION_FILLET_RADIUS_M, join_style=2
            ).buffer(-JUNCTION_FILLET_RADIUS_M, join_style=2)
            fillet_extra = closed.difference(drivable_ground_geom).intersection(clip)
            if not median_zones.is_empty:
                fillet_extra = fillet_extra.difference(median_zones.buffer(0.5, join_style=1))
            fillet_extra = _clean(fillet_extra, MIN_FILLET_AREA_M2)
        except Exception:
            stats["junction_fillet_failed"] += 1
            fillet_extra = Polygon()
    if not fillet_extra.is_empty:
        drivable_ground_geom = _union([drivable_ground_geom, fillet_extra])
        other_materials = [
            geom for material, geom in zones.items() if material != "asphalt"
        ]
        fillet_claim = fillet_extra
        if other_materials:
            fillet_claim = fillet_extra.difference(_union(other_materials))
        fillet_claim = _clean(fillet_claim, MIN_FILLET_AREA_M2)
        if not fillet_claim.is_empty:
            asphalt_zone = zones.get("asphalt")
            if asphalt_zone is not None and not asphalt_zone.is_empty:
                zones["asphalt"] = _union([asphalt_zone, fillet_claim])
            else:
                zones["asphalt"] = fillet_claim
        stats["junction_fillets"] = len(_iter_polys(fillet_claim))
        stats["junction_fillet_area_m2"] = round(fillet_claim.area, 1)

    # --- crossings / medians (before paving: paving fills every gap that is
    # not asphalt and not an emitted median) ---------------------------------
    crossings, crossing_stats = build_crossings(crossing_nodes, prepared)
    stats.update(crossing_stats)
    medians, median_stats = median_polygons_from_zones(
        median_zones,
        drivable_ground_geom,
        junction_geom.get("polygons") if junction_geom else None,
        crossings,
    )
    stats.update(median_stats)
    median_union = _union(medians)

    # --- paving -------------------------------------------------------------
    def sidewalk_corridors(ways: list[RoadWay]) -> list:
        corridors = []
        for way in ways:
            if way.cls not in SIDEWALK_CLASSES:
                continue
            sidewalk_tag = (way.tags.get("sidewalk") or "").strip().lower()
            if sidewalk_tag in ("no", "none", "separate"):
                continue
            try:
                corridors.append(
                    way.line.buffer(way.width / 2.0 + SIDEWALK_DEFAULT_WIDTH_M, cap_style=2, join_style=2)
                )
            except Exception:
                continue
        return corridors

    ground_paving_union = _union(
        [w.line.buffer(w.width / 2.0, cap_style=2, join_style=2) for w in path_ground]
        + sidewalk_corridors(drivable_ground)
    )
    if not ground_paving_union.is_empty:
        # 2 cm margin: both layers are later snapped to the 1 cm payload grid
        # independently, and a snapped paving edge could otherwise creep up to
        # 1 cm into the asphalt (statistically ~5 m2 across the pilot). The gap
        # sits under the kerb strip, so it is never visible.
        ground_paving_union = ground_paving_union.difference(
            drivable_ground_geom.buffer(0.02, join_style=1)
        )
        # Keep only the median pieces that are actually emitted: a sidewalk must
        # never fill a median slot, but a median fragment that is later dropped
        # must not leave an empty slit between asphalt pieces either.
        if not median_union.is_empty:
            ground_paving_union = ground_paving_union.difference(
                median_union.buffer(0.02, join_style=1)
            )
        ground_paving_union = ground_paving_union.intersection(pilot_rect)
    paving_ground = _clean(ground_paving_union, MIN_PAVING_AREA_M2)
    if not paving_ground.is_empty:
        # Close sub-decimetre slivers between paving components (measurement
        # grid snapping can split a narrow sidewalk into two pieces). Then
        # re-assert the asphalt/median margins so closing never eats into them.
        paving_ground = paving_ground.buffer(0.15, join_style=2).buffer(
            -0.15, join_style=2
        )
        paving_ground = paving_ground.difference(
            drivable_ground_geom.buffer(0.02, join_style=1)
        )
        if not median_union.is_empty:
            paving_ground = paving_ground.difference(
                median_union.buffer(0.02, join_style=1)
            )
        paving_ground = _clean(paving_ground.intersection(pilot_rect), MIN_PAVING_AREA_M2)

    bridge_paving_union = _union(
        [w.line.buffer(w.width / 2.0, cap_style=2, join_style=2) for w in path_bridge]
        + sidewalk_corridors(drivable_bridge)
    )
    if not bridge_paving_union.is_empty and not drivable_bridge_geom.is_empty:
        bridge_paving_union = bridge_paving_union.difference(
            drivable_bridge_geom.buffer(0.02, join_style=1)
        )
        bridge_paving_union = bridge_paving_union.intersection(pilot_rect)
    paving_bridge = _clean(bridge_paving_union, MIN_PAVING_AREA_M2)

    # --- kerbs --------------------------------------------------------------
    kerb_ways = [
        w for w in drivable_ground if w.cls in KERB_CLASSES and w.material in PAVED_MATERIALS
    ]
    kerb = Polygon()
    if kerb_ways and not ground_paving_union.is_empty:
        try:
            paved_union = _union(way_buffers(kerb_ways))
            kerb = paved_union.buffer(0.6, join_style=1).difference(drivable_ground_geom)
            kerb = kerb.intersection(ground_paving_union)
        except Exception:
            stats["kerb_failed"] += 1
            kerb = Polygon()
    kerb = _clean(kerb, MIN_KERB_AREA_M2).simplify(0.2, preserve_topology=True)
    kerb = _clean(kerb, MIN_KERB_AREA_M2)

    # --- surface records ----------------------------------------------------
    def pieces_from(geom, kind: str, material: str | None, bridge: bool) -> list[dict]:
        # No simplification here: these pieces form an exact partition and are
        # split per tile afterwards. Simplifying each piece independently moves
        # shared material/kerb edges and breaks the "no overlap, no seam"
        # invariant (measured: 2 m tile-seam gaps and drivable/paving overlaps).
        out: list[dict] = []
        for poly in _iter_polys(geom):
            if poly.is_empty or poly.area < MIN_SURFACE_AREA_M2:
                continue
            record = {"kind": kind, "bridge": bridge, "geom": poly}
            if material is not None:
                record["material"] = material
            out.append(record)
        return out

    surfaces: list[dict] = []
    for material, geom in zones.items():
        clipped = geom.intersection(pilot_rect)
        surfaces.extend(pieces_from(clipped, "drivable", material, False))
    for material, geom in bridge_zones.items():
        clipped = geom.intersection(pilot_rect)
        surfaces.extend(pieces_from(clipped, "drivable", material, True))
    surfaces.extend(pieces_from(paving_ground, "paving", None, False))
    surfaces.extend(pieces_from(paving_bridge, "paving", None, True))
    surfaces.extend(pieces_from(kerb, "kerb", None, False))
    for median in medians:
        surfaces.extend(pieces_from(median, "median", None, False))

    # --- network records ----------------------------------------------------
    # Only drivable ways are needed for markings (paths/stairs carry no paint).
    network: list[dict] = []
    consumed = pair_info["consumed"]
    for way in prepared:
        if way.tunnel or way.kind != "road":
            continue
        if way.osm_id in consumed:
            # merged into one two-way corridor piece below
            continue
        line = way.line
        if line.length < 1.0:
            continue
        simplified = line.simplify(0.5, preserve_topology=False)
        points = list(simplified.coords)
        if len(points) < 2:
            continue
        offset = 0.0
        try:
            offset = line.project(Point(points[0][0], points[0][1]))
        except Exception:
            offset = 0.0
        flat: list[float] = []
        for x, y in points:
            flat.extend((round(float(x), 2), round(float(y), 2)))
        record = {
            "kind": "road" if way.kind == "road" else "footway",
            "class": way.cls,
            "width": round(way.width, 2),
            "centerline": flat,
            "centerlineOffset": round(float(offset), 2),
        }
        if way.lanes:
            record["lanes"] = int(way.lanes)
        if way.oneway:
            record["oneway"] = True
        if way.material:
            record["material"] = way.material
        if way.surface:
            record["surface"] = way.surface
        if way.bridge:
            record["bridge"] = True
        if way.name:
            record["name"] = way.name
        network.append(record)

    # Near-coincident opposite one-way carriageways become one two-way piece so
    # the renderer paints a double solid centre line (Independence Ave,
    # Pobediteley, Bogdanovicha) instead of two one-way dash columns.
    for item in pair_info["merged"]:
        way = item["a"]
        points = list(item["midline"].coords)
        if len(points) < 2:
            continue
        flat = []
        for x, y in points:
            flat.extend((round(float(x), 2), round(float(y), 2)))
        record = {
            "kind": "road",
            "class": way.cls,
            "width": item["width"],
            "lanes": int(item["lanes"]),
            "material": way.material or "asphalt",
            "centerline": flat,
            "centerlineOffset": 0.0,
            "name": way.name,
            "merged": True,
        }
        if item["bridge"]:
            record["bridge"] = True
        network.append(record)
    stats["merged_network_pieces"] = len(pair_info["merged"])

    # --- coverage stats -----------------------------------------------------
    stats["surfaces"] = len(surfaces)
    stats["surface_drivable"] = sum(1 for s in surfaces if s["kind"] == "drivable")
    stats["surface_paving"] = sum(1 for s in surfaces if s["kind"] == "paving")
    stats["surface_kerb"] = sum(1 for s in surfaces if s["kind"] == "kerb")
    stats["surface_median"] = sum(1 for s in surfaces if s["kind"] == "median")
    stats["network"] = len(network)
    stats["named_street_groups"] = len({w.group for w in prepared if w.name})
    stats["ways_with_surface_tag"] = sum(1 for w in prepared if w.surface is not None)
    stats["materials"] = dict(Counter(w.material for w in prepared))
    stats["classes"] = dict(Counter(w.cls for w in prepared))
    stats["build_seconds"] = round(time.time() - started, 2)

    return {
        "surfaces": surfaces,
        "network": network,
        "junctions": junctions,
        "crossings": crossings,
        "stats": dict(stats),
        "drivable_geom": drivable_ground_geom,
        "paving_geom": paving_ground,
        "bridge_geom": drivable_bridge_geom,
    }
