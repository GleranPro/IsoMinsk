"""Ground strokes (payload 0.4.0): roads/paths as painter's-order centrelines.

The renderer rasterises the whole flat ground of a tile into one texture with
the cartographic "casing then fill" technique (the same approach as the
Isometric Warsaw reference): every road is a stroked centreline, all kerb
casings are drawn before all asphalt fills, fills are drawn in class order so
the major street owns a junction. Painting one colour over the same colour is
idempotent, so overlapping ways, multi-way junctions and twin carriageways merge
into one clean surface without any boolean geometry. A data error therefore
degrades into a slightly irregular edge, never into a hole, sliver or stacked
layer.

This module only *describes* the strokes. It reuses the per-way lane/width/
material model of ``road_network.py`` (``RoadWay`` after ``canonicalize``) and
adds two small per-way attributes:

* ``sw`` - synthetic sidewalk width on the left/right side of the centreline
  (0 when OSM says ``sidewalk=no/separate`` or a mapped ``footway=sidewalk``
  already runs alongside that side);
* ``r``  - fill rank (class rank), so the renderer draws minor roads first.

No polygon union/difference is performed here.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict

from shapely.geometry import LineString
from shapely.ops import unary_union
from shapely.strtree import STRtree

# Kept in sync with road_network.py (imported lazily to avoid a cycle).
SIDEWALK_SEARCH_OFFSET_M = 2.5
SIDEWALK_MATCH_RADIUS_M = 4.0
SIDEWALK_MATCH_FRACTION = 0.4

ROAD_STROKE_CLASSES_NO_SIDEWALK = {"service", "unknown", "track"}


def _num(value) -> float | None:
    if value is None:
        return None
    try:
        text = str(value).strip().lower().replace(",", ".")
        for suffix in (" m", "m"):
            if text.endswith(suffix):
                text = text[: -len(suffix)].strip()
        number = float(text)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _flat(line: LineString, precision: int = 2) -> list[float]:
    flat: list[float] = []
    for x, y in line.coords:
        flat.extend((round(float(x), precision), round(float(y), precision)))
    return flat


def _is_underground(tags: dict) -> bool:
    if (tags.get("tunnel") or "").strip().lower() not in ("", "no"):
        return True
    if (tags.get("covered") or "").strip().lower() == "yes":
        return True
    if (tags.get("indoor") or "").strip().lower() == "yes":
        return True
    layer = _num(tags.get("layer"))
    return layer is not None and layer < 0


def _side_has_mapped_sidewalk(
    line: LineString,
    offset: float,
    tree: STRtree | None,
    sidewalks: list[LineString],
) -> bool:
    """True when a mapped ``footway=sidewalk`` runs along this side."""
    if tree is None:
        return False
    try:
        probe = line.offset_curve(offset, join_style=2)
    except Exception:
        return False
    if probe.is_empty or probe.length < 1.0:
        return False
    candidates = [sidewalks[int(i)] for i in tree.query(probe.buffer(SIDEWALK_MATCH_RADIUS_M))]
    if not candidates:
        return False
    try:
        zone = unary_union([c.buffer(SIDEWALK_MATCH_RADIUS_M, cap_style=2) for c in candidates])
        covered = probe.intersection(zone).length
    except Exception:
        return False
    return covered >= probe.length * SIDEWALK_MATCH_FRACTION


def _direction(line: LineString) -> tuple[float, float] | None:
    (x0, y0), (x1, y1) = line.coords[0], line.coords[-1]
    length = math.hypot(x1 - x0, y1 - y0)
    if length < 1e-6:
        return None
    return ((x1 - x0) / length, (y1 - y0) / length)


def _has_opposite_carriageway_on_left(way, oneway_tree: STRtree | None, oneways: list) -> bool:
    """True when an opposite one-way carriageway runs on the left of this
    one-way way (right-hand traffic: the inner side of a dual carriageway). The
    inner side gets no synthetic sidewalk.

    No street-name match is required: the halves of one avenue are often
    tagged differently (a named half beside an unnamed channelization half on
    Lenina south of Ulyanovskaya), and two opposite carriageways whose edges are
    within 6 m never have a pavement between them."""
    if oneway_tree is None or not way.oneway:
        return False
    own = _direction(way.line)
    if own is None:
        return False
    try:
        probe = way.line.offset_curve(way.width / 2.0 + 6.0, join_style=2)
    except Exception:
        return False
    if probe.is_empty:
        return False
    zone = probe.buffer(10.0, cap_style=2)
    for index in oneway_tree.query(zone):
        other = oneways[int(index)]
        if other is way:
            continue
        direction = _direction(other.line)
        if direction is None or direction[0] * own[0] + direction[1] * own[1] > -0.2:
            continue
        try:
            if other.line.intersection(zone).length >= min(15.0, other.line.length * 0.5):
                return True
        except Exception:
            continue
    return False


def sidewalk_widths(way, tree: STRtree | None, sidewalks: list[LineString], default_width: float,
                    sidewalk_classes: set[str], oneway_tree: STRtree | None = None,
                    oneways: list | None = None) -> tuple[float, float]:
    """Synthetic sidewalk width (left, right) for one carriageway."""
    if way.kind != "road" or way.cls not in sidewalk_classes:
        return (0.0, 0.0)
    if way.link or way.channelization:
        return (0.0, 0.0)
    tag = (way.tags.get("sidewalk") or "").strip().lower()
    if tag in ("no", "none", "separate"):
        return (0.0, 0.0)
    width = (
        _num(way.tags.get("sidewalk:width"))
        or _num(way.tags.get("sidewalk:both:width"))
        or default_width
    )
    width = max(1.0, min(6.0, width))
    left = width
    right = width
    if tag == "left":
        right = 0.0
    elif tag == "right":
        left = 0.0
    for key, side in (("sidewalk:left", "left"), ("sidewalk:right", "right")):
        value = (way.tags.get(key) or "").strip().lower()
        if value in ("no", "none", "separate"):
            if side == "left":
                left = 0.0
            else:
                right = 0.0
    if left > 0 and _has_opposite_carriageway_on_left(way, oneway_tree, oneways or []):
        left = 0.0
    half = way.width / 2.0 + SIDEWALK_SEARCH_OFFSET_M
    if left > 0 and _side_has_mapped_sidewalk(way.line, half, tree, sidewalks):
        left = 0.0
    if right > 0 and _side_has_mapped_sidewalk(way.line, -half, tree, sidewalks):
        right = 0.0
    return (round(left, 2), round(right, 2))


LINK_PAINT_MIN_M = 25.0

# On-street parking (payload 0.4.1): a strip beside the carriageway, part of the
# kerb-to-kerb asphalt. `parking:<side>` = lane / street_side widens that side;
# on_kerb / half_on_kerb / shoulder / separate / no do not (the cars stand on
# the pavement, or the bays are mapped as their own areas).
PARKING_WIDTH_M = {"parallel": 2.3, "diagonal": 4.6, "perpendicular": 5.0}
PARKING_ORIENTATION_CODE = {"parallel": 1, "diagonal": 2, "perpendicular": 3}
PARKING_ON_CARRIAGEWAY = {"lane", "street_side", "yes"}


def street_parking(tags: dict) -> tuple[list[float], list[int]]:
    """Parking strip width and orientation code per side ([left, right])."""
    widths = [0.0, 0.0]
    codes = [0, 0]
    for index, side in enumerate(("left", "right")):
        value = (tags.get(f"parking:{side}") or tags.get("parking:both") or "").strip().lower()
        orientation = (
            tags.get(f"parking:{side}:orientation") or tags.get("parking:both:orientation") or ""
        ).strip().lower()
        # Legacy scheme: parking:lane:<side>=parallel|diagonal|perpendicular.
        legacy = (tags.get(f"parking:lane:{side}") or tags.get("parking:lane:both") or "").strip().lower()
        if not value and legacy in PARKING_WIDTH_M:
            value, orientation = "lane", legacy
        if value not in PARKING_ON_CARRIAGEWAY:
            continue
        if orientation not in PARKING_WIDTH_M:
            orientation = "parallel"
        widths[index] = PARKING_WIDTH_M[orientation]
        codes[index] = PARKING_ORIENTATION_CODE[orientation]
    return widths, codes

JUNCTION_TRIM_PAD_M = 1.0
JUNCTION_TRIM_MIN_M = 3.0
JUNCTION_TRIM_MAX_M = 30.0
JUNCTION_MIN_SIN = 0.3


def _vertex_key(point) -> tuple[float, float]:
    return (round(float(point[0]), 2), round(float(point[1]), 2))


def _direction_at(coords: list, index: int) -> tuple[float, float] | None:
    """Unit direction of a polyline at vertex ``index`` (along increasing index)."""
    if len(coords) < 2:
        return None
    a = coords[max(0, index - 1)] if index == len(coords) - 1 else coords[index]
    b = coords[index] if index == len(coords) - 1 else coords[index + 1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return None
    return (dx / length, dy / length)


def junction_trims(roads: list) -> dict[int, list[tuple[tuple[float, float], float]]]:
    """Lane-paint trims at graph junctions, per road way (by list index).

    A junction is a shared OSM vertex with three or more approaches (an end
    vertex is one approach, an interior vertex two). For way W at junction N the
    trim radius is ``max_k(hw_k / max(sin θ_k, 0.3)) + 1 m`` over the other
    incident ways k (θ = angle between W and k at N), clamped to [3, 30] m: the
    distance at which W's lane paint leaves the other carriageways' asphalt.
    Returns ``{way_index: [(node_point, radius), ...]}``.
    """
    incidence: dict[tuple[float, float], list[tuple[int, int]]] = defaultdict(list)
    approaches: Counter = Counter()
    coords_of: list[list] = []
    for way_index, way in enumerate(roads):
        coords = list(way.line.coords)
        coords_of.append(coords)
        last = len(coords) - 1
        for vertex_index, point in enumerate(coords):
            key = _vertex_key(point)
            incidence[key].append((way_index, vertex_index))
            approaches[key] += 1 if vertex_index in (0, last) else 2
    trims: dict[int, list[tuple[tuple[float, float], float]]] = defaultdict(list)
    for key, members in incidence.items():
        if approaches[key] < 3 or len({m[0] for m in members}) < 2:
            continue
        for way_index, vertex_index in members:
            own = _direction_at(coords_of[way_index], vertex_index)
            if own is None:
                continue
            radius = 0.0
            for other_index, other_vertex in members:
                if other_index == way_index:
                    continue
                other = _direction_at(coords_of[other_index], other_vertex)
                if other is None:
                    continue
                sin = abs(own[0] * other[1] - own[1] * other[0])
                half = float(roads[other_index].width) / 2.0
                radius = max(radius, half / max(sin, JUNCTION_MIN_SIN))
            radius = max(JUNCTION_TRIM_MIN_M, min(JUNCTION_TRIM_MAX_M, radius + JUNCTION_TRIM_PAD_M))
            trims[way_index].append((key, radius))
    return trims


def build_ground_strokes(
    prepared: list,
    dropped_path_ids: set[int],
    *,
    class_rank: dict[str, int],
    material_rank: dict[str, int],
    sidewalk_classes: set[str],
    kerb_classes: set[str],
    sidewalk_default_width: float,
    channelization_widths: dict[int, float] | None = None,
) -> tuple[list[dict], Counter]:
    """Describe every surface road/path way as one stroke record (area-global)."""
    stats = Counter()
    channelization_widths = channelization_widths or {}

    sidewalk_lines = [
        way.line
        for way in prepared
        if way.kind == "path"
        and (way.tags.get("footway") or "").strip().lower() == "sidewalk"
        and not _is_underground(way.tags)
    ]
    sidewalk_tree = STRtree(sidewalk_lines) if sidewalk_lines else None
    # Any mapped pavement-like line (footway / path / pedestrian / cycleway, not
    # crossings): bounds how far an on-street parking strip may reach.
    walk_lines = [
        way.line
        for way in prepared
        if way.kind == "path"
        and (way.tags.get("footway") or "").strip().lower() != "crossing"
        and not _is_underground(way.tags)
    ]
    walk_tree = STRtree(walk_lines) if walk_lines else None
    oneways = [way for way in prepared if way.kind == "road" and way.oneway and not way.link]
    oneway_tree = STRtree([way.line for way in oneways]) if oneways else None

    surface_roads = [
        way for way in prepared if way.kind == "road" and not _is_underground(way.tags)
    ]
    trims_by_index = junction_trims(surface_roads)
    trims_by_way = {id(way): trims_by_index.get(i, []) for i, way in enumerate(surface_roads)}

    strokes: list[dict] = []
    for way in prepared:
        if _is_underground(way.tags):
            stats["underground_skipped"] += 1
            continue
        if way.kind == "path" and int(way.osm_id) in dropped_path_ids:
            stats["path_over_water_skipped"] += 1
            continue
        line = way.line
        if line.length < 0.5:
            continue
        simplified = line.simplify(0.15, preserve_topology=False)
        if simplified.is_empty or len(simplified.coords) < 2:
            continue
        width = float(way.width)
        if way.channelization:
            # Channelization connectors were capped to 3 m for the old paving
            # partition; as strokes they keep their lane-model width (they are
            # real asphalt slip lanes and simply merge into the junction).
            width = float(channelization_widths.get(int(way.osm_id), width))
        record: dict = {
            "id": int(way.osm_id),
            "k": _stroke_kind(way),
            "c": way.cls,
            "w": round(width, 2),
            "p": _flat(simplified),
            "s0": 0.0,
            "r": int(class_rank.get(way.cls, 0)) * 4 + int(material_rank.get(way.material, 0)),
        }
        if way.material and way.material != "asphalt":
            record["mat"] = way.material
        if way.bridge:
            record["b"] = 1
        if way.kind == "road":
            sw = sidewalk_widths(way, sidewalk_tree, sidewalk_lines,
                                 sidewalk_default_width, sidewalk_classes,
                                 oneway_tree, oneways)
            if sw[0] > 0 or sw[1] > 0:
                record["sw"] = [sw[0], sw[1]]
                stats["sidewalk_sides"] += int(sw[0] > 0) + int(sw[1] > 0)
            if way.cls in kerb_classes and way.material in ("asphalt", "stone", "concrete"):
                record["kb"] = 1
            parking_widths, parking_codes = street_parking(way.tags)
            if parking_widths[0] > 0 or parking_widths[1] > 0:
                record["pk"] = parking_widths
                record["po"] = parking_codes
                stats["parking_sides"] += int(parking_widths[0] > 0) + int(parking_widths[1] > 0)
                record["_pkfit"] = fit_parking(simplified, width, parking_widths, parking_codes,
                                               walk_tree, walk_lines)
            record["lf"] = int(way.lanes_forward)
            record["lb"] = int(way.lanes_backward)
            if way.oneway:
                record["ow"] = 1
            if way.link or way.channelization:
                record["ln"] = 1
            if way.link:
                # Internal (stripped before the tiles are written): true *_link
                # ramps never form a dual carriageway with the opposite half.
                record["_lk"] = 1
            if (way.link or way.channelization) and way.oneway and simplified.length >= LINK_PAINT_MIN_M:
                # Multi-lane slip roads / connectors (Lenina's right-turn pair:
                # lanes=2) keep their tagged lanes and get lane dividers; the
                # 0.3.0 model forced connectors to one lane.
                tagged = _num(way.tags.get("lanes"))
                if tagged is not None and tagged >= 2:
                    record["lf"] = int(min(6, tagged))
                    record["pl"] = 1
                    stats["link_lane_paint"] += 1
            if way.roundabout:
                record["ra"] = 1
            intervals: list[float] = []
            from shapely.geometry import Point

            for point, radius in trims_by_way.get(id(way), []):
                try:
                    at = simplified.project(Point(point))
                except Exception:
                    continue
                a = max(0.0, at - radius)
                b = min(simplified.length, at + radius)
                if b > a:
                    intervals.extend((round(a, 2), round(b, 2)))
            if intervals:
                record["nj"] = intervals
                stats["junction_trims"] += len(intervals) // 2
        fitted = record.pop("_pkfit", None)
        if fitted:
            pieces = split_by_parking(record, simplified, fitted)
            stats["parking_pieces"] += len(pieces)
            strokes.extend(pieces)
            for piece in pieces:
                stats[f"stroke_{piece['k']}"] += 1
            continue
        strokes.append(record)
        stats[f"stroke_{record['k']}"] += 1
    stats["strokes"] = len(strokes)
    return strokes, stats


def _stroke_kind(way) -> str:
    if way.kind == "road":
        return "road"
    if way.cls == "cycleway":
        return "cycle"
    if way.cls == "steps":
        return "steps"
    if way.cls == "pedestrian":
        return "ped"
    if way.cls == "track":
        return "track"
    return "path"


# --- dual-carriageway gaps (payload 0.4.1) ---------------------------------
#
# OSM maps a divided street as two opposite one-way centrelines. Their painted
# widths come from the lane model, which rarely matches the real distance
# between the centrelines, so a strip of bare ground used to show between the
# halves: a fake traffic island (Lenina south of Ulyanovskaya: centrelines
# 11.7 m apart, painted half-widths 4.8 + 3.3 m → a 3.6 m "island" with a
# pavement in it). Measured over the pilot: ~1 150 probe samples have a bare
# 0–5 m gap, tram reservations sit in 4–11 m gaps, and the only bare gaps above
# 8 m are real green medians. So:
#   * bare gap ≤ 6 m  → asphalt fill + a solid divider line on the gap centre;
#   * tram in a gap ≤ 14 m → the whole gap is tram track bed;
#   * anything wider stays ground.
# Overlapping halves (gap ≤ 0) get the divider line only.

MEDIAN_SAMPLE_M = 2.0
MEDIAN_MAX_BARE_GAP_M = 6.0
MEDIAN_MAX_TRAM_GAP_M = 14.0
MEDIAN_MIN_OVERLAP_GAP_M = -2.5
MEDIAN_FILL_OVERLAP_M = 0.3
MEDIAN_MAX_JUMP_M = 1.5
MEDIAN_MIN_DIVIDER_M = 6.0
MEDIAN_OPPOSITE_DOT = -0.8


def _pairs(flat: list[float]) -> list[tuple[float, float]]:
    return list(zip(flat[0::2], flat[1::2]))


def _tangent(line: LineString, at: float) -> tuple[float, float] | None:
    a = line.interpolate(max(0.0, at - 0.5))
    b = line.interpolate(min(line.length, at + 0.5))
    dx, dy = b.x - a.x, b.y - a.y
    length = math.hypot(dx, dy)
    if length < 1e-6:
        return None
    return (dx / length, dy / length)


def _in_intervals(value: float, intervals: list[float]) -> bool:
    for i in range(0, len(intervals) - 1, 2):
        if intervals[i] <= value <= intervals[i + 1]:
            return True
    return False


def median_fills(strokes: list[dict], tram_lines: list[LineString]) -> tuple[list[dict], list[list[float]], Counter]:
    """Fill the gaps between opposite one-way carriageways (see above).

    Returns ``(fills, dividers, stats)``: fills are ``{"m": "asphalt"|"tram",
    "c": cls, "p": flat ring}`` polygons, dividers are flat centre polylines of
    the solid line between the halves (cut out of junction trims ``nj``).
    """
    from shapely.geometry import Point

    stats: Counter = Counter()
    candidates = [
        s for s in strokes
        if s.get("k") == "road" and s.get("ow") and not s.get("b") and not s.get("ra")
        and not s.get("_lk") and len(s.get("p") or []) >= 4
    ]
    if not candidates:
        return [], [], stats
    lines = [LineString(_pairs(s["p"])) for s in candidates]
    tree = STRtree(lines)
    tram_tree = STRtree(tram_lines) if tram_lines else None

    fills: list[dict] = []
    dividers: list[list[float]] = []
    for index, stroke in enumerate(candidates):
        line = lines[index]
        if line.length < MEDIAN_SAMPLE_M:
            continue
        half = float(stroke["w"]) / 2.0
        reach = half + MEDIAN_MAX_TRAM_GAP_M + 12.0
        count = int(line.length // MEDIAN_SAMPLE_M)
        samples: list[tuple | None] = []
        for step in range(count + 1):
            at = min(line.length, step * MEDIAN_SAMPLE_M)
            tangent = _tangent(line, at)
            if tangent is None:
                samples.append(None)
                continue
            point = line.interpolate(at)
            nx, ny = -tangent[1], tangent[0]
            probe = LineString([
                (point.x + nx * 0.05, point.y + ny * 0.05),
                (point.x + nx * reach, point.y + ny * reach),
            ])
            best = None
            for other_index in tree.query(probe):
                other_index = int(other_index)
                if other_index == index:
                    continue
                other = candidates[other_index]
                hit = lines[other_index].intersection(probe)
                if hit.is_empty:
                    continue
                for hit_point in getattr(hit, "geoms", [hit]):
                    if hit_point.geom_type != "Point":
                        continue
                    distance = point.distance(hit_point)
                    other_tangent = _tangent(lines[other_index], lines[other_index].project(hit_point))
                    if other_tangent is None:
                        continue
                    dot = other_tangent[0] * tangent[0] + other_tangent[1] * tangent[1]
                    if best is None or distance < best[0]:
                        best = (distance, other, dot)
            if best is None or best[2] > MEDIAN_OPPOSITE_DOT:
                samples.append(None)
                continue
            distance, other, _ = best
            # Each pair is filled once, from the half with the smaller id.
            if int(other.get("id", 0)) < int(stroke.get("id", 0)):
                samples.append(None)
                continue
            other_half = float(other["w"]) / 2.0
            gap = distance - half - other_half
            kind = None
            if 0.1 < gap <= MEDIAN_MAX_TRAM_GAP_M and tram_tree is not None:
                segment = LineString([
                    (point.x + nx * half, point.y + ny * half),
                    (point.x + nx * (distance - other_half), point.y + ny * (distance - other_half)),
                ])
                if any(tram_lines[int(t)].intersects(segment) for t in tram_tree.query(segment)):
                    kind = "tram"
            if kind is None and 0.1 < gap <= MEDIAN_MAX_BARE_GAP_M:
                kind = "asphalt"
            if kind is None and MEDIAN_MIN_OVERLAP_GAP_M <= gap <= 0.1:
                kind = "overlap"
            if kind is None:
                samples.append(None)
                continue
            samples.append((at, point.x, point.y, nx, ny, half, distance, other_half, gap, kind,
                            str(other.get("c") or stroke.get("c"))))

        # Runs of consecutive samples of one kind with a continuous distance.
        runs: list[list[tuple]] = []
        current: list[tuple] = []
        for sample in samples:
            if sample is None:
                if current:
                    runs.append(current)
                current = []
                continue
            if current and (
                sample[9] != current[-1][9] or abs(sample[6] - current[-1][6]) > MEDIAN_MAX_JUMP_M
            ):
                runs.append(current)
                current = []
            current.append(sample)
        if current:
            runs.append(current)

        trims = list(stroke.get("nj") or [])
        for run in runs:
            if len(run) < 2:
                continue
            kind = run[0][9]
            if kind in ("asphalt", "tram"):
                pad = MEDIAN_FILL_OVERLAP_M if kind == "asphalt" else 0.0
                near = []
                far = []
                for _, x, y, nx, ny, half, distance, other_half, _, _, _ in run:
                    near.append((x + nx * (half - pad), y + ny * (half - pad)))
                    far.append((x + nx * (distance - other_half + pad), y + ny * (distance - other_half + pad)))
                ring = near + far[::-1]
                flat: list[float] = []
                for x, y in ring:
                    flat.extend((round(x, 2), round(y, 2)))
                fills.append({"m": kind, "c": str(stroke.get("c") or "unknown"), "p": flat})
                stats[f"median_{kind}_runs"] += 1
                stats[f"median_{kind}_m"] += round((len(run) - 1) * MEDIAN_SAMPLE_M)
            if kind in ("asphalt", "overlap"):
                piece: list[tuple[float, float]] = []
                pieces: list[list[tuple[float, float]]] = []
                for at, x, y, nx, ny, half, _, _, gap, _, _ in run:
                    if _in_intervals(at, trims):
                        if piece:
                            pieces.append(piece)
                        piece = []
                        continue
                    centre = half + gap / 2.0
                    piece.append((x + nx * centre, y + ny * centre))
                if piece:
                    pieces.append(piece)
                for piece in pieces:
                    if len(piece) < 2 or LineString(piece).length < MEDIAN_MIN_DIVIDER_M:
                        continue
                    flat = []
                    for x, y in LineString(piece).simplify(0.1).coords:
                        flat.extend((round(x, 2), round(y, 2)))
                    dividers.append(flat)
                    stats["median_dividers"] += 1
    return fills, dividers, stats


# --- tram stops (payload 0.4.1) ---------------------------------------------
#
# Minsk maps tram stops as `railway=tram_stop` / `public_transport=stop_position`
# nodes on the track plus (sometimes) `public_transport=platform` nodes; platform
# areas are virtually absent. Each stop becomes a 32 × 2.6 m raised platform
# beside its track: on the side of the nearest platform node when one is mapped,
# otherwise on the side away from the parallel track (median tram lines have
# their platforms between the track and the carriageway), otherwise on the right.

TRAM_PLATFORM_LENGTH_M = 32.0
TRAM_PLATFORM_WIDTH_M = 2.6
TRAM_PLATFORM_OFFSET_M = 1.6
TRAM_STOP_SNAP_M = 8.0
TRAM_PLATFORM_NODE_M = 30.0
TRAM_PARALLEL_TRACK_M = 6.0


def tram_platforms(
    stops: list[tuple[float, float]],
    platform_nodes: list[tuple[float, float]],
    tram_lines: list[LineString],
) -> tuple[list[dict], Counter]:
    from shapely.geometry import Point

    stats: Counter = Counter()
    if not stops or not tram_lines:
        return [], stats
    tree = STRtree(tram_lines)
    placed: list[tuple[float, float]] = []
    out: list[dict] = []
    for sx, sy in stops:
        stop = Point(sx, sy)
        nearest = None
        for index in tree.query(stop.buffer(TRAM_STOP_SNAP_M)):
            line = tram_lines[int(index)]
            distance = line.distance(stop)
            if distance <= TRAM_STOP_SNAP_M and (nearest is None or distance < nearest[0]):
                nearest = (distance, line)
        if nearest is None:
            stats["tram_stops_unsnapped"] += 1
            continue
        line = nearest[1]
        at = line.project(stop)
        tangent = _tangent(line, at)
        if tangent is None:
            continue
        centre = line.interpolate(at)
        nx, ny = -tangent[1], tangent[0]

        side = 0
        best_node = None
        for px, py in platform_nodes:
            distance = math.hypot(px - centre.x, py - centre.y)
            if distance <= TRAM_PLATFORM_NODE_M and (best_node is None or distance < best_node[0]):
                best_node = (distance, px, py)
        if best_node is not None:
            dot = (best_node[1] - centre.x) * nx + (best_node[2] - centre.y) * ny
            if abs(dot) > 0.5:
                side = 1 if dot > 0 else -1
        if side == 0:
            for sign in (1, -1):
                probe = LineString([
                    (centre.x + sign * nx * 0.5, centre.y + sign * ny * 0.5),
                    (centre.x + sign * nx * TRAM_PARALLEL_TRACK_M, centre.y + sign * ny * TRAM_PARALLEL_TRACK_M),
                ])
                if any(tram_lines[int(i)] is not line and tram_lines[int(i)].intersects(probe)
                       for i in tree.query(probe)):
                    side = -sign
                    break
        if side == 0:
            side = -1  # right of the way's direction
            stats["tram_platform_default_side"] += 1

        a = max(0.0, at - TRAM_PLATFORM_LENGTH_M / 2.0)
        b = min(line.length, at + TRAM_PLATFORM_LENGTH_M / 2.0)
        if b - a < 8.0:
            continue
        from shapely.ops import substring

        piece = substring(line, a, b)
        try:
            inner = piece.offset_curve(side * TRAM_PLATFORM_OFFSET_M, join_style=2)
            outer = piece.offset_curve(side * (TRAM_PLATFORM_OFFSET_M + TRAM_PLATFORM_WIDTH_M), join_style=2)
        except Exception:
            continue
        if inner.is_empty or outer.is_empty or inner.geom_type != "LineString" or outer.geom_type != "LineString":
            continue
        mid = outer.interpolate(0.5, normalized=True)
        if any(math.hypot(mid.x - qx, mid.y - qy) < 8.0 for qx, qy in placed):
            stats["tram_platforms_duplicate"] += 1
            continue
        placed.append((mid.x, mid.y))
        # offset_curve keeps the input direction for both signs (shapely ≥ 2).
        ring = list(inner.coords) + list(outer.coords)[::-1]
        flat: list[float] = []
        for x, y in ring:
            flat.extend((round(x, 2), round(y, 2)))
        out.append({"m": "platform", "p": flat})
        stats["tram_platforms"] += 1
    return out, stats


# --- carriageway closing (payload 0.4.1) -------------------------------------
#
# Every way is painted as its own ribbon, so whatever lies between ribbons used
# to stay ground: the gore between a carriageway and a diverging slip road
# (Lenina × Ulyanovskaya), the triangles between turn links inside a junction
# (Bogdanovicha × Yanki Kupaly). In reality these are asphalt, often with
# painted chevrons. Per tile window (tile + 64 m) the carriageway ribbons are
# unioned once and
#   * closed with radius r (buffer +r then -r): gaps < 2r become asphalt and
#     junction corners get an r kerb radius;
#   * enclosed holes of the closed union up to 40 m across / 400 m² become
#     asphalt;
# minus protected ground (tram beds, platforms, mapped grass / water / pitch /
# plaza polygons, buildings). The result only ADDS asphalt painted over the
# ribbons, so a geometric imprecision is invisible: there is no chained
# partition whose invariants could break.

CLOSE_RADIUS_M = 3.0
CLOSE_MAX_HOLE_SPAN_M = 40.0
CLOSE_MAX_HOLE_AREA_M2 = 400.0
CLOSE_TILE_PAD_M = 2.0
CLOSE_MIN_PART_M2 = 0.5


def _flat_ring(coords) -> list[float]:
    flat: list[float] = []
    for x, y in list(coords)[:-1]:
        flat.extend((round(float(x), 2), round(float(y), 2)))
    return flat


def _kerb_width(stroke: dict) -> float:
    """Kerb-to-kerb width: carriageway plus on-street parking strips."""
    parking = stroke.get("pk") or [0.0, 0.0]
    return float(stroke["w"]) + float(parking[0]) + float(parking[1])


def _kerb_band(stroke: dict) -> LineString:
    """Centre line of the kerb-to-kerb band (shifted towards the wider parking side)."""
    line = LineString(_pairs(stroke["p"]))
    parking = stroke.get("pk") or [0.0, 0.0]
    shift = (float(parking[0]) - float(parking[1])) / 2.0
    if abs(shift) < 1e-6:
        return line
    shifted = line.offset_curve(shift, join_style=2)
    return shifted if shifted.geom_type == "LineString" and not shifted.is_empty else line


PARKING_FIT_STEP_M = 5.0
PARKING_FIT_REACH_M = 20.0
PARKING_FOOTWAY_HALF_M = 1.0
PARKING_MIN_RUN_M = 25.0


def _room_to_walkway(line: LineString, at: float, side: int, half: float,
                     walk_tree: STRtree | None, walk_lines: list) -> float | None:
    """Free distance from the carriageway edge to the nearest parallel mapped
    walkway on one side (minus its half-width), or None when there is none."""
    if walk_tree is None:
        return None
    tangent = _tangent(line, at)
    if tangent is None:
        return None
    point = line.interpolate(at)
    nx, ny = -tangent[1] * side, tangent[0] * side
    probe = LineString([
        (point.x + nx * half, point.y + ny * half),
        (point.x + nx * PARKING_FIT_REACH_M, point.y + ny * PARKING_FIT_REACH_M),
    ])
    best = None
    for index in walk_tree.query(probe):
        walk = walk_lines[int(index)]
        hit = walk.intersection(probe)
        if hit.is_empty:
            continue
        for hit_point in getattr(hit, "geoms", [hit]):
            if hit_point.geom_type != "Point":
                continue
            walk_tangent = _tangent(walk, walk.project(hit_point))
            if walk_tangent is None or abs(walk_tangent[0] * tangent[0] + walk_tangent[1] * tangent[1]) < 0.9:
                continue
            distance = point.distance(hit_point)
            best = distance if best is None else min(best, distance)
    if best is None:
        return None
    return best - half - PARKING_FOOTWAY_HALF_M


PARKING_MIN_DEPTH_M = {1: 2.0, 2: 3.6, 3: 4.2}


def _fit_side(requested: float, code: int, room: float | None) -> tuple[float, int]:
    """Parking strip that fits the measured room: the requested orientation
    narrowed to the room (down to its minimum depth), else parallel, else none.
    Widths are quantised to 0.5 m so sample noise does not chop the kerb."""
    if room is None or room >= requested:
        return requested, code
    if room >= PARKING_MIN_DEPTH_M.get(code, 2.0):
        return math.floor(room * 2.0) / 2.0, code
    if code >= 2 and room >= PARKING_MIN_DEPTH_M[1]:
        return min(PARKING_WIDTH_M["parallel"], math.floor(room * 2.0) / 2.0), PARKING_ORIENTATION_CODE["parallel"]
    return 0.0, 0


def fit_parking(line: LineString, width: float, widths: list[float], codes: list[int],
                walk_tree: STRtree | None, walk_lines: list) -> list[tuple]:
    """On-street parking per stretch of a way, limited by mapped walkways.

    Returns runs ``(a, b, left_w, right_w, left_code, right_code)`` over the
    way's arc length. Tags (or curation) say THAT a street has parking; the
    mapped pavements say where there is room for it: Internatsionalnaya's
    pavement runs 3 m from the centre line on one stretch and 7 m on another.
    """
    half = width / 2.0
    count = max(1, int(line.length // PARKING_FIT_STEP_M))
    stations = [min(line.length, step * PARKING_FIT_STEP_M) for step in range(count + 1)]
    sides = []
    for index, sign in ((0, 1), (1, -1)):
        values = []
        for at in stations:
            room = _room_to_walkway(line, at, sign, half, walk_tree, walk_lines) if widths[index] > 0 else None
            values.append(_fit_side(widths[index], codes[index], room) if widths[index] > 0 else (0.0, 0))
        sides.append(_smooth_runs(stations, values, line.length))
    # Union of both sides' breakpoints.
    cuts = sorted({0.0, line.length, *[a for a, _, _ in sides[0]], *[a for a, _, _ in sides[1]]})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-6:
            continue
        mid = (a + b) / 2.0
        left = next(value for ra, rb, value in sides[0] if ra <= mid <= rb)
        right = next(value for ra, rb, value in sides[1] if ra <= mid <= rb)
        if out and out[-1][2:] == (left[0], right[0], left[1], right[1]):
            out[-1] = (out[-1][0], b, *out[-1][2:])
        else:
            out.append((a, b, left[0], right[0], left[1], right[1]))
    return out


def _smooth_runs(stations: list[float], values: list[tuple], length: float) -> list[tuple]:
    """Run-length encode one side's fitted parking; runs shorter than
    PARKING_MIN_RUN_M take the value of the longer neighbour."""
    runs: list[list] = []
    for at, value in zip(stations, values):
        if runs and runs[-1][2] == value:
            runs[-1][1] = at
        else:
            if runs:
                runs[-1][1] = at
            runs.append([at, at, value])
    runs[-1][1] = length
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for i, run in enumerate(runs):
            if run[1] - run[0] >= PARKING_MIN_RUN_M:
                continue
            prev_len = runs[i - 1][1] - runs[i - 1][0] if i > 0 else -1
            next_len = runs[i + 1][1] - runs[i + 1][0] if i + 1 < len(runs) else -1
            target = i - 1 if prev_len >= next_len else i + 1
            if target == i - 1:
                runs[i - 1][1] = run[1]
            else:
                runs[i + 1][0] = run[0]
            runs.pop(i)
            changed = True
            break
        merged = [runs[0]]
        for run in runs[1:]:
            if run[2] == merged[-1][2]:
                merged[-1][1] = run[1]
            else:
                merged.append(run)
        runs = merged
    return [tuple(run) for run in runs]


def split_by_parking(record: dict, line: LineString, runs: list[tuple]) -> list[dict]:
    """Split one stroke record into consecutive pieces with their own parking.

    Pieces keep the way id, `nj` (absolute arc length, same frame as `s0`) and
    get `s0` = their start arc length, exactly like the tile clipping.
    """
    from shapely.ops import substring

    if len(runs) == 1:
        a, b, left, right, left_code, right_code = runs[0]
        out = dict(record)
        _set_parking(out, left, right, left_code, right_code)
        return [out]
    pieces = []
    for a, b, left, right, left_code, right_code in runs:
        if b - a < 0.5:
            continue
        part = substring(line, a, b)
        if part.is_empty or part.geom_type != "LineString" or len(part.coords) < 2:
            continue
        out = dict(record)
        out["p"] = _flat(part)
        out["s0"] = round(float(record.get("s0", 0.0)) + a, 2)
        _set_parking(out, left, right, left_code, right_code)
        pieces.append(out)
    return pieces or [record]


def _set_parking(record: dict, left: float, right: float, left_code: int, right_code: int) -> None:
    if left > 0 or right > 0:
        record["pk"] = [round(left, 2), round(right, 2)]
        record["po"] = [int(left_code), int(right_code)]
    else:
        record.pop("pk", None)
        record.pop("po", None)


def carriageway_closing(
    strokes: list[dict],
    extra_asphalt: list[dict],
    protected_geoms: list,
    tile_size: float,
    tile_keys,
    margin: float,
) -> tuple[dict[tuple[int, int], list[dict]], Counter]:
    """Per-tile asphalt fills closing the gaps between carriageway ribbons."""
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union

    stats: Counter = Counter()
    ribbons = []
    for stroke in strokes:
        if stroke.get("k") != "road" or stroke.get("b") or len(stroke.get("p") or []) < 4:
            continue
        try:
            ribbons.append(_kerb_band(stroke).buffer(_kerb_width(stroke) / 2.0, quad_segs=4))
        except Exception:
            continue
    for fill in extra_asphalt:
        try:
            poly = Polygon(_pairs(fill["p"]))
            if not poly.is_valid:
                poly = poly.buffer(0)
            ribbons.append(poly)
        except Exception:
            continue
    out: dict[tuple[int, int], list[dict]] = {key: [] for key in tile_keys}
    if not ribbons:
        return out, stats
    ribbon_tree = STRtree(ribbons)
    protected = [g for g in protected_geoms if g is not None and not g.is_empty]
    protected_tree = STRtree(protected) if protected else None

    for key in out:
        tx, ty = key
        window = box(tx * tile_size - margin, ty * tile_size - margin,
                     (tx + 1) * tile_size + margin, (ty + 1) * tile_size + margin)
        target = box(tx * tile_size - CLOSE_TILE_PAD_M, ty * tile_size - CLOSE_TILE_PAD_M,
                     (tx + 1) * tile_size + CLOSE_TILE_PAD_M, (ty + 1) * tile_size + CLOSE_TILE_PAD_M)
        parts = [ribbons[int(i)] for i in ribbon_tree.query(window)]
        if not parts:
            continue
        union = unary_union(parts).intersection(window)
        closed = union.buffer(CLOSE_RADIUS_M, quad_segs=4).buffer(-CLOSE_RADIUS_M, quad_segs=4)
        pieces = [closed.difference(union)]
        for poly in getattr(closed, "geoms", [closed]):
            if poly.geom_type != "Polygon":
                continue
            for interior in poly.interiors:
                hole = Polygon(interior)
                minx, miny, maxx, maxy = hole.bounds
                if not hole.intersects(target):
                    continue
                if max(maxx - minx, maxy - miny) > CLOSE_MAX_HOLE_SPAN_M or hole.area > CLOSE_MAX_HOLE_AREA_M2:
                    stats["close_holes_large"] += 1
                    continue
                if protected_tree is not None and any(
                    protected[int(i)].intersects(hole) for i in protected_tree.query(hole)
                ):
                    stats["close_holes_protected"] += 1
                    continue
                stats["close_holes_filled"] += 1
                stats["close_holes_filled_m2"] += round(hole.area)
                pieces.append(hole)
        # Window-level geometry first (protected cut, simplify, tiny-part
        # filter), the tile clip last: both neighbours then keep the same parts
        # along their shared border (a part clipped to a sliver in one tile and
        # dropped there showed as a 1–5 texel seam).
        added = unary_union(pieces)
        if added.is_empty:
            continue
        if protected_tree is not None:
            blockers = [protected[int(i)] for i in protected_tree.query(added)]
            if blockers:
                added = added.difference(unary_union(blockers))
        added = added.simplify(0.05)
        kept_parts = [
            poly for poly in getattr(added, "geoms", [added])
            if poly.geom_type == "Polygon" and poly.area >= CLOSE_MIN_PART_M2 and poly.intersects(target)
        ]
        clipped_parts = []
        for part in kept_parts:
            clipped = part.intersection(target)
            clipped_parts.extend(
                p for p in getattr(clipped, "geoms", [clipped]) if p.geom_type == "Polygon" and p.area > 0
            )
        for poly in clipped_parts:
            record: dict = {"m": "asphalt", "c": "primary", "p": _flat_ring(poly.exterior.coords), "kb": 1}
            holes = [_flat_ring(ring.coords) for ring in poly.interiors if Polygon(ring).area >= CLOSE_MIN_PART_M2]
            if holes:
                record["h"] = holes
            out[key].append(record)
            stats["close_fill_parts"] += 1
            stats["close_fill_m2"] += round(poly.area)
    return out, stats


def assign_fills_to_tiles(
    fills: list[dict],
    tile_size: float,
    tile_keys,
    margin: float,
) -> dict[tuple[int, int], list[dict]]:
    """Attach whole (unclipped) fill polygons / polylines to every tile whose
    grown rectangle meets their bbox: neighbours paint the identical shape."""
    keys = set(tile_keys)
    out: dict[tuple[int, int], list[dict]] = {key: [] for key in keys}
    for fill in fills:
        flat = fill["p"] if isinstance(fill, dict) else fill
        xs, ys = flat[0::2], flat[1::2]
        if len(xs) < 2:
            continue
        for tx in range(math.floor((min(xs) - margin) / tile_size), math.floor((max(xs) + margin) / tile_size) + 1):
            for ty in range(math.floor((min(ys) - margin) / tile_size), math.floor((max(ys) + margin) / tile_size) + 1):
                if (tx, ty) in keys:
                    out[(tx, ty)].append(fill)
    return out


def rail_strokes(rail_pieces: list[dict]) -> list[dict]:
    """Tram/heavy-rail centrelines (already merged/deduplicated upstream)."""
    out: list[dict] = []
    for piece in rail_pieces:
        flat = piece.get("centerline") or []
        if len(flat) < 4:
            continue
        width = float(piece.get("width") or 2.2)
        out.append({
            "k": "tram" if width < 3.0 else "rail",
            "c": "unknown",
            "w": round(width, 2),
            "p": list(flat),
            "s0": 0.0,
            "r": 0,
        })
    return out


def assign_strokes_to_tiles(
    strokes: list[dict],
    tile_size: float,
    tile_keys,
    margin: float,
) -> dict[tuple[int, int], list[dict]]:
    """Clip area-global strokes to every tile rectangle grown by ``margin``.

    The margin is larger than any stroke half-width (+ sidewalk), so the round
    caps created by clipping are always outside the tile: neighbouring tiles
    rasterise exactly the same pixels along their shared border. ``s0`` keeps
    the arc length of the first clipped vertex (dash phase continuity).
    """
    from shapely.geometry import Point, box

    keys = set(tile_keys)
    out: dict[tuple[int, int], list[dict]] = {key: [] for key in keys}
    for stroke in strokes:
        flat = stroke["p"]
        xs = flat[0::2]
        ys = flat[1::2]
        if len(xs) < 2:
            continue
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
        line = None
        for tx in range(math.floor((minx - margin) / tile_size), math.floor((maxx + margin) / tile_size) + 1):
            for ty in range(math.floor((miny - margin) / tile_size), math.floor((maxy + margin) / tile_size) + 1):
                if (tx, ty) not in keys:
                    continue
                gx0, gy0 = tx * tile_size - margin, ty * tile_size - margin
                gx1, gy1 = (tx + 1) * tile_size + margin, (ty + 1) * tile_size + margin
                if minx >= gx0 and maxx <= gx1 and miny >= gy0 and maxy <= gy1:
                    out[(tx, ty)].append(stroke)
                    continue
                if line is None:
                    line = LineString(list(zip(xs, ys)))
                try:
                    clipped = line.intersection(box(gx0, gy0, gx1, gy1))
                except Exception:
                    continue
                if clipped.geom_type == "LineString":
                    parts = [clipped]
                elif clipped.geom_type in ("MultiLineString", "GeometryCollection"):
                    parts = [g for g in clipped.geoms if g.geom_type == "LineString"]
                else:
                    parts = []
                for part in parts:
                    if part.is_empty or part.length < 0.1 or len(part.coords) < 2:
                        continue
                    record = dict(stroke)
                    record["p"] = _flat(part)
                    try:
                        record["s0"] = round(
                            float(stroke.get("s0", 0.0)) + line.project(Point(part.coords[0])), 2
                        )
                    except Exception:
                        pass
                    out[(tx, ty)].append(record)
    return out
