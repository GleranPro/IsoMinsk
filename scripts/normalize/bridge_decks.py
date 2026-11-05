"""Bridge decks (payload 0.4.2): raised 3D slabs built from bridge strokes.

Ground strokes with ``b: 1`` are never painted into the ground texture (the
river or the road below must stay visible). This module turns them into deck
records that the renderer draws as geometry:

* **footprint** - union of every bridge stroke's full cross-section
  (carriageway + parking + kerb + synthetic pavement, or the path width),
  morphologically closed by ``DECK_CLOSE_M`` so the carriageway and a separately
  mapped footway on the same bridge become one slab;
* **ends** - the parts of the outline where the deck meets a ground-level stroke
  that is *connected* to one of the bridge ways (shares its end node). A road
  passing underneath an overpass is not connected and never counts as an end;
* **height field** - 0 at the ends, ``DECK_RISE_M * layer`` on the span, with a
  smoothstep ramp of length ``R`` over the distance to the nearest end. The
  slope is capped, so a 20 m bridge rises less than an 80 m one. Heights are
  baked into the triangles (the deck is sliced into iso-distance bands so the
  linear interpolation inside a triangle follows the ramp);
* **edges** - every outline edge is ``1`` side (fascia + parapet), ``0`` end
  (no wall: the deck runs into the street) or ``2`` cut (chunk border, nothing);
* **strokes** - the bridge strokes themselves (``b`` removed), so the renderer
  paints the deck texture with exactly the ground compositor: same asphalt,
  kerbs, pavements and lane markings as the street it carries.

Long decks are cut on a ``DECK_CHUNK_M`` world grid (tile sizes are multiples
of it, so a chunk always lies inside one tile) to keep every deck texture small.
"""

from __future__ import annotations

import math
from collections import Counter

import shapely
from shapely.geometry import LineString, MultiLineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from ground_strokes import median_fills

DECK_RISE_M = 3.0
DECK_MAX_LAYERS = 2
DECK_RAMP_MAX_M = 15.0
DECK_RAMP_FRACTION = 0.8      # ramp length as a fraction of the end-to-middle distance
DECK_MAX_SLOPE = 0.22
# Closing radius: gaps up to 2 × DECK_CLOSE_M between strokes of one bridge
# become deck (= MEDIAN_MAX_BARE_GAP_M on the ground). With 2 m a footway 3.4–
# 4.2 m from its carriageway (Kastrychnitskaya) left a walled notch in the deck.
DECK_CLOSE_M = 3.0
# An outline edge running alongside the ground-level continuation of a
# connected way, at most this far from its footprint, is an end (no wall):
# the two halves of a divided street leave the bridge at different points
# (Kastrychnitskaya 5A: 20 m apart) and the step between them is not a side.
DECK_LATERAL_END_M = 3.0
DECK_MIN_AREA_M2 = 20.0
DECK_BAND_M = 1.5
DECK_OUTLINE_STEP_M = 1.5
DECK_CHUNK_M = 128.0
DECK_STROKE_MARGIN_M = 24.0
DECK_NODE_SNAP_M = 1.0
DECK_END_PROBE_M = 0.8
DECK_SHADOW_FROM = 0.35       # shadow starts this fraction of the ramp in from an end
KERB_M = 0.6                  # = groundRaster KERB_WIDTH_M
BED_EXTRA_M = 0.6             # rail/tram ballast beyond the gauge strip

DECK_KINDS = ("road", "path", "cycle", "steps", "ped", "track", "tram", "rail")


def _pairs(flat):
    return list(zip(flat[0::2], flat[1::2]))


def _line(stroke: dict) -> LineString:
    return LineString(_pairs(stroke["p"]))


def _kerb_band(stroke: dict) -> LineString:
    line = _line(stroke)
    parking = stroke.get("pk") or [0.0, 0.0]
    shift = (float(parking[0]) - float(parking[1])) / 2.0
    if abs(shift) < 1e-6:
        return line
    shifted = line.offset_curve(shift, join_style=2)
    return shifted if shifted.geom_type == "LineString" and not shifted.is_empty else line


def stroke_footprint(stroke: dict):
    """Full cross-section of one stroke as a polygon (flat caps)."""
    kind = stroke.get("k")
    if kind == "road":
        band = _kerb_band(stroke)
        parking = stroke.get("pk") or [0.0, 0.0]
        half = (float(stroke["w"]) + float(parking[0]) + float(parking[1])) / 2.0
        if stroke.get("kb"):
            half += KERB_M
        sw = stroke.get("sw") or [0.0, 0.0]
        left, right = half + float(sw[0]), half + float(sw[1])
        if abs(left - right) < 0.05:
            return band.buffer(left, cap_style="flat", join_style="mitre", quad_segs=4)
        parts = [
            band.buffer(left, single_sided=True, cap_style="flat", join_style="mitre"),
            band.buffer(-right, single_sided=True, cap_style="flat", join_style="mitre"),
        ]
        return unary_union([p for p in parts if not p.is_empty])
    extra = BED_EXTRA_M if kind in ("tram", "rail") else 0.0
    return _line(stroke).buffer(float(stroke["w"]) / 2.0 + extra, cap_style="flat", quad_segs=4)


def _smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def _clip_strokes(strokes: list[dict], area) -> list[dict]:
    """Clip strokes to a rectangle; keeps ``s0`` (dash phase) continuous."""
    out: list[dict] = []
    for stroke in strokes:
        line = _line(stroke)
        clipped = line.intersection(area)
        parts = [g for g in getattr(clipped, "geoms", [clipped]) if g.geom_type == "LineString"]
        for part in parts:
            if part.is_empty or part.length < 0.1 or len(part.coords) < 2:
                continue
            record = {k: v for k, v in stroke.items() if k not in ("b", "_ly")}
            flat: list[float] = []
            for x, y in part.coords:
                flat.extend((round(float(x), 2), round(float(y), 2)))
            record["p"] = flat
            record["s0"] = round(float(stroke.get("s0", 0.0)) + line.project(Point(part.coords[0])), 2)
            out.append(record)
    return out


def _lateral_end_pieces(part, lateral) -> list[LineString]:
    """Outline pieces running *alongside* a connected ground continuation.

    A piece is an end when it is within ``DECK_LATERAL_END_M`` of the ground
    stroke's footprint, parallel to it, and its projection falls inside the
    ground line (not past the shared node — that is the deck's own side
    continuing beyond the street end, which keeps its parapet).
    """
    if not lateral:
        return []
    pieces: list[LineString] = []
    rings = [part.exterior, *part.interiors]
    for ring in rings:
        coords = list(shapely.segmentize(LineString(ring.coords), 1.0).coords)
        for a, b in zip(coords, coords[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            mid = Point((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)
            for line, foot, node, reach in lateral:
                if mid.distance(node) > reach or foot.distance(mid) > DECK_LATERAL_END_M:
                    continue
                at = line.project(mid)
                if at < 0.5 or at > line.length - 0.5:
                    continue
                t0 = line.interpolate(max(0.0, at - 0.5))
                t1 = line.interpolate(min(line.length, at + 0.5))
                tx, ty = t1.x - t0.x, t1.y - t0.y
                tl = math.hypot(tx, ty)
                if tl < 1e-6 or abs(dx * tx + dy * ty) / (length * tl) < 0.8:
                    continue
                pieces.append(LineString([a, b]))
                break
    return pieces


def _short_side_runs(part, end_lines) -> list[LineString]:
    """Side runs of at most ``2 * DECK_CLOSE_M`` between two end runs.

    Where both halves of a divided street (or a carriageway and its footway)
    leave the bridge, the closed gap between them meets the street as a short
    edge that touches no ground stroke; it is part of the end, not a wall.
    """
    limit = 2.0 * DECK_CLOSE_M
    out: list[LineString] = []
    for ring in [part.exterior, *part.interiors]:
        coords = list(shapely.segmentize(LineString(ring.coords), 0.5).coords)
        segs = [(a, b) for a, b in zip(coords, coords[1:]) if a != b]
        if not segs:
            continue
        is_end = [end_lines.distance(Point((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)) < 0.05 for a, b in segs]
        if all(is_end) or not any(is_end):
            continue
        n = len(segs)
        start = is_end.index(True)  # walk the ring starting on an end segment
        i = 0
        while i < n:
            k = (start + i) % n
            if is_end[k]:
                i += 1
                continue
            run = []
            while i < n and not is_end[(start + i) % n]:
                run.append(segs[(start + i) % n])
                i += 1
            length = sum(math.dist(a, b) for a, b in run)
            if length <= limit:
                out.extend(LineString([a, b]) for a, b in run)
    return out


def _covered_fraction(segment: LineString, zone) -> float:
    if segment.length < 1e-9:
        return 0.0
    return segment.intersection(zone).length / segment.length


def _ring_record(ring_coords, height, cell, part_boundary, end_lines) -> dict:
    ring = LineString(list(ring_coords))
    dense = shapely.segmentize(ring, DECK_OUTLINE_STEP_M)
    coords = list(dense.coords)[:-1]
    flat: list[float] = []
    zs: list[float] = []
    for x, y in coords:
        flat.extend((round(float(x), 2), round(float(y), 2)))
        zs.append(round(height(x, y), 2))
    edges: list[int] = []
    cell_ring = cell.exterior
    # An edge is an end when end lines cover at least half of it. A midpoint
    # test missed edges whose midpoint fell in a ~0.2 m gap of the end lines
    # (a 1.4 m parapet stub at the Kastrychnitskaya 5A median).
    end_zone = end_lines.buffer(0.05) if end_lines is not None else None
    for i in range(len(coords)):
        ax, ay = coords[i]
        bx, by = coords[(i + 1) % len(coords)]
        mid = Point((ax + bx) / 2.0, (ay + by) / 2.0)
        if cell_ring.distance(mid) < 1e-3 and part_boundary.distance(mid) > 1e-3:
            edges.append(2)
        elif end_zone is not None and _covered_fraction(LineString([(ax, ay), (bx, by)]), end_zone) >= 0.5:
            edges.append(0)
        else:
            edges.append(1)
    return {"p": flat, "z": zs, "e": edges}


def bridge_decks(
    strokes: list[dict],
    tile_size: float,
    tile_keys,
) -> tuple[dict, list[dict], list[dict], dict]:
    """Build deck chunks from the ``b: 1`` strokes.

    Returns ``(decks_by_tile, shadows, ground_strokes, stats)`` where
    ``ground_strokes`` is ``strokes`` without the bridge strokes that became
    decks (bridge strokes too small for a deck stay on the ground, flattened).
    """
    stats: Counter = Counter()
    keys = set(tile_keys)
    decks_by_tile: dict = {key: [] for key in keys}
    shadows: list[dict] = []

    bridge = [s for s in strokes if s.get("b") and s.get("k") in DECK_KINDS and len(s.get("p") or []) >= 4]
    ground = [s for s in strokes if not s.get("b") and s.get("k") in DECK_KINDS and len(s.get("p") or []) >= 4]
    stats["deck_bridge_strokes"] = len(bridge)
    if not bridge:
        return decks_by_tile, shadows, list(strokes), dict(stats)

    footprints = []
    for stroke in bridge:
        try:
            footprints.append(stroke_footprint(stroke))
        except Exception:
            footprints.append(Polygon())
    union = unary_union([f for f in footprints if not f.is_empty])
    closed = union.buffer(DECK_CLOSE_M, join_style="mitre").buffer(-DECK_CLOSE_M, join_style="mitre")
    closed = closed.union(union).simplify(0.05)

    ground_lines = [_line(s) for s in ground]
    ground_tree = shapely.STRtree(ground_lines) if ground_lines else None
    bridge_lines = [_line(s) for s in bridge]
    bridge_tree = shapely.STRtree(bridge_lines)

    used: set[int] = set()
    parts = [g for g in getattr(closed, "geoms", [closed]) if g.geom_type == "Polygon"]
    for part in parts:
        members = [int(i) for i in bridge_tree.query(part) if bridge_lines[int(i)].intersects(part)]
        if not members:
            continue
        if part.area < DECK_MIN_AREA_M2:
            stats["deck_too_small"] += 1
            continue
        used.update(members)
        part = orient(part, 1.0)
        layer = max(int(bridge[i].get("_ly", 1) or 1) for i in members)
        layer = max(1, min(DECK_MAX_LAYERS, layer))

        # Ends: footprints of connected ground strokes near the shared node.
        end_zones = []
        lateral = []  # (ground line, its footprint, shared node, reach)
        for i in members:
            line = bridge_lines[i]
            for node in (Point(line.coords[0]), Point(line.coords[-1])):
                if ground_tree is None:
                    continue
                for j in ground_tree.query(node.buffer(DECK_NODE_SNAP_M)):
                    other = ground_lines[int(j)]
                    ends = (Point(other.coords[0]), Point(other.coords[-1]))
                    if min(node.distance(e) for e in ends) > DECK_NODE_SNAP_M:
                        continue
                    try:
                        foot = stroke_footprint(ground[int(j)])
                    except Exception:
                        continue
                    reach = float(ground[int(j)]["w"]) + float(bridge[i]["w"]) + 8.0
                    end_zones.append(foot.intersection(node.buffer(reach)))
                    lateral.append((other, foot, node, reach))
        end_lines = None
        if end_zones:
            zone = unary_union(end_zones).buffer(DECK_END_PROBE_M)
            hit = part.boundary.intersection(zone)
            lines = [g for g in getattr(hit, "geoms", [hit]) if g.geom_type in ("LineString", "MultiLineString")]
            flat_lines = []
            for g in lines:
                flat_lines.extend(getattr(g, "geoms", [g]))
            flat_lines = [g for g in flat_lines if g.length > 0.2]
            side_ends = _lateral_end_pieces(part, lateral)
            stats["deck_lateral_end_m"] += round(sum(g.length for g in side_ends))
            flat_lines.extend(side_ends)
            if flat_lines:
                gaps = _short_side_runs(part, MultiLineString(flat_lines))
                stats["deck_gap_end_m"] += round(sum(g.length for g in gaps))
                flat_lines.extend(gaps)
            if flat_lines:
                end_lines = MultiLineString(flat_lines)
        if end_lines is not None:
            # Farthest outline point from any end (dense: deck corners all lie on ends).
            far = max(end_lines.distance(Point(c))
                      for c in shapely.segmentize(part.exterior, 1.0).coords)
            ramp = max(1.0, min(DECK_RAMP_MAX_M, DECK_RAMP_FRACTION * far))
            rise = min(DECK_RISE_M * layer, DECK_MAX_SLOPE * ramp)
            stats["deck_ends"] += len(flat_lines)
        else:
            ramp = DECK_RAMP_MAX_M
            rise = DECK_RISE_M * layer
            stats["deck_no_ends"] += 1

        def height(x: float, y: float, _end=end_lines, _ramp=ramp, _rise=rise) -> float:
            if _end is None:
                return _rise
            return _rise * _smoothstep(_end.distance(Point(x, y)) / _ramp)

        # Iso-distance bands (ramp) + plateau.
        bands = []
        if end_lines is not None:
            steps = max(1, math.ceil(ramp / DECK_BAND_M))
            inner = Polygon()
            for k in range(1, steps + 1):
                outer = end_lines.buffer(ramp * k / steps, quad_segs=6)
                bands.append(part.intersection(outer).difference(inner))
                inner = outer
            bands.append(part.difference(inner))
        else:
            bands.append(part)

        # Under-deck shadow (painted into the ground texture).
        shade = part if end_lines is None else part.difference(end_lines.buffer(ramp * DECK_SHADOW_FROM))
        for poly in getattr(shade, "geoms", [shade]):
            if poly.geom_type == "Polygon" and poly.area > 2.0:
                record = {"p": [round(v, 2) for xy in list(poly.exterior.coords)[:-1] for v in xy]}
                holes = [[round(v, 2) for xy in list(r.coords)[:-1] for v in xy] for r in poly.interiors]
                if holes:
                    record["h"] = holes
                shadows.append(record)

        member_strokes = [bridge[i] for i in members]
        # The gap between the carriageways on the deck is asphalt: the closed
        # union of the road footprints minus the roads themselves. Sampled
        # median fills stopped short of the deck end and left a paving wedge
        # between the halves' flat ends (Kastrychnitskaya 5A); the divider line
        # still comes from the median sampler, exactly like on the ground.
        deck_fills, deck_dividers = [], []
        road_members = [s for s in member_strokes if s.get("k") == "road"]
        if len(road_members) >= 2:
            roads_fp = unary_union([stroke_footprint(s) for s in road_members])
            gap = (roads_fp.buffer(DECK_CLOSE_M, join_style="mitre").buffer(-DECK_CLOSE_M, join_style="mitre")
                   .difference(roads_fp).intersection(part))
            cls = str(road_members[0].get("c") or "unknown")
            for poly in getattr(gap, "geoms", [gap]):
                if poly.geom_type != "Polygon" or poly.area < 0.2:
                    continue
                fill = {"m": "asphalt", "c": cls,
                        "p": [round(v, 2) for xy in list(poly.exterior.coords)[:-1] for v in xy]}
                holes = [[round(v, 2) for xy in list(r.coords)[:-1] for v in xy] for r in poly.interiors]
                if holes:
                    fill["h"] = holes
                deck_fills.append(fill)
            stats["deck_median_fills"] += len(deck_fills)
            if sum(1 for s in road_members if s.get("ow")) >= 2:
                flat_members = [{k: v for k, v in s.items() if k not in ("b", "_ly")} for s in member_strokes]
                _, deck_dividers, _ = median_fills(flat_members, [])
        minx, miny, maxx, maxy = part.bounds
        for cx in range(math.floor(minx / DECK_CHUNK_M), math.floor(maxx / DECK_CHUNK_M) + 1):
            for cy in range(math.floor(miny / DECK_CHUNK_M), math.floor(maxy / DECK_CHUNK_M) + 1):
                cell = box(cx * DECK_CHUNK_M, cy * DECK_CHUNK_M, (cx + 1) * DECK_CHUNK_M, (cy + 1) * DECK_CHUNK_M)
                chunk = part.intersection(cell)
                if chunk.is_empty or chunk.area < 0.5:
                    continue
                tile = (math.floor((cx + 0.5) * DECK_CHUNK_M / tile_size),
                        math.floor((cy + 0.5) * DECK_CHUNK_M / tile_size))
                if tile not in keys:
                    stats["deck_chunks_outside"] += 1
                    continue
                tris: list[float] = []
                for band in bands:
                    piece = band.intersection(cell)
                    for poly in getattr(piece, "geoms", [piece]):
                        if poly.geom_type != "Polygon" or poly.area < 0.01:
                            continue
                        for tri in shapely.constrained_delaunay_triangles(poly).geoms:
                            coords = list(tri.exterior.coords)[:3]
                            # CCW in local x-east / y-north.
                            (ax, ay), (bx, by), (qx, qy) = coords
                            if (bx - ax) * (qy - ay) - (by - ay) * (qx - ax) < 0:
                                coords = [coords[0], coords[2], coords[1]]
                            for x, y in coords:
                                tris.extend((round(x, 2), round(y, 2), round(height(x, y), 2)))
                rings = []
                for poly in getattr(chunk, "geoms", [chunk]):
                    if poly.geom_type != "Polygon" or poly.area < 0.5:
                        continue
                    poly = orient(poly, 1.0)
                    rings.append(_ring_record(poly.exterior.coords, height, cell, part.boundary, end_lines))
                    for interior in poly.interiors:
                        rings.append(_ring_record(interior.coords, height, cell, part.boundary, end_lines))
                if not tris or not rings:
                    continue
                cbx = chunk.bounds
                strokes_in = _clip_strokes(
                    member_strokes,
                    box(cbx[0] - DECK_STROKE_MARGIN_M, cbx[1] - DECK_STROKE_MARGIN_M,
                        cbx[2] + DECK_STROKE_MARGIN_M, cbx[3] + DECK_STROKE_MARGIN_M),
                )
                record = {
                    "id": int(bridge[members[0]].get("id", 0)),
                    "bb": [round(v, 2) for v in cbx],
                    "hz": round(rise, 2),
                    "t": tris,
                    "r": rings,
                    "s": strokes_in,
                }
                window = box(cbx[0] - 2.0, cbx[1] - 2.0, cbx[2] + 2.0, cbx[3] + 2.0)
                fills_in = [f for f in deck_fills if Polygon(_pairs(f["p"])).intersects(window)]
                dividers_in = [d for d in deck_dividers if len(d) >= 4 and LineString(_pairs(d)).intersects(window)]
                if fills_in:
                    record["f"] = fills_in
                if dividers_in:
                    record["dv"] = dividers_in
                decks_by_tile[tile].append(record)
                stats["deck_chunks"] += 1
                stats["deck_triangles"] += len(tris) // 9
        stats["decks"] += 1
        stats["deck_m2"] += round(part.area)

    bridge_index = {id(s): i for i, s in enumerate(bridge)}
    kept: list[dict] = []
    for stroke in strokes:
        # Every bridge stroke that did not become a deck is flattened onto the
        # ground: the compositor never paints `b` strokes (they would vanish).
        if stroke.get("b"):
            index = bridge_index.get(id(stroke))
            if index is not None and index in used:
                continue
            flat = {k: v for k, v in stroke.items() if k not in ("b", "_ly")}
            stats["deck_flattened"] += 1
            kept.append(flat)
            continue
        if "_ly" in stroke:
            stroke = {k: v for k, v in stroke.items() if k != "_ly"}
        kept.append(stroke)
    stats["deck_shadows"] = len(shadows)
    return decks_by_tile, shadows, kept, dict(stats)
