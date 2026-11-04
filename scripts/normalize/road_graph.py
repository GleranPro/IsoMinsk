"""OSM topology graph for the normalized road network (payload 0.3.0).

The graph is built from the already projected OSM way geometries: shared OSM
nodes appear as identical vertices in every way that uses them, so the topology
can be reconstructed without keeping OSM node ids. Ways are split at shared
vertices into edges; nodes with three or more distinct approaches become
junctions, and each junction gets a single asphalt face polygon derived from the
approach cross-sections (see ``junction_faces``).

The module is deliberately independent of ``road_network`` (no circular imports):
it only reads attributes from the way objects passed in:

    osm_id, line, group, cls, width, lanes_forward, lanes_backward, oneway,
    link, roundabout, channelization, bridge, tunnel, material, name

The output is consumed by ``road_network.build_road_network`` for lane
canonicalization, junction faces and channelization classification.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

# Two projected OSM vertices of the same node are bit-identical; a 1 cm key is
# enough. The snap radius only guards against ways clipped at the dataset edge.
VERTEX_KEY_DECIMALS = 2
MIN_EDGE_M = 0.8
# Two incident edges closer than this angle at a node are the same approach
# (e.g. a way split only for tagging); keep the wider one for the face.
PARALLEL_APPROACH_RAD = math.radians(12.0)
# A junction face corner further than this from the node is rejected.
MIN_APPROACH_OFFSET_M = 2.0
MAX_APPROACH_OFFSET_M = 6.0
FACE_MIN_AREA_M2 = 2.0
FACE_MAX_RADIUS_M = 34.0
FACE_TRIANGLE_GRID = 0.01


@dataclass
class GraphNode:
    index: int
    x: float
    y: float
    edges: list[int] = field(default_factory=list)

    @property
    def degree(self) -> int:
        return len(self.edges)


@dataclass
class GraphEdge:
    index: int
    way: object
    coords: list[tuple[float, float]]
    a: int
    b: int
    length: float

    @property
    def osm_id(self) -> int:
        return int(self.way.osm_id)


@dataclass
class JunctionFace:
    node: int
    x: float
    y: float
    polygon: Polygon
    fallback: bool
    approaches: list[dict]


@dataclass
class RoadGraph:
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    way_edges: dict[int, list[int]]
    channelization_ways: set[int]

    def node(self, index: int) -> GraphNode:
        return self.nodes[index]

    def edge(self, index: int) -> GraphEdge:
        return self.edges[index]

    def degree(self, node_index: int) -> int:
        return len(self.nodes[node_index].edges)


def vertex_key(point: tuple[float, float]) -> tuple[float, float]:
    return (
        round(float(point[0]), VERTEX_KEY_DECIMALS),
        round(float(point[1]), VERTEX_KEY_DECIMALS),
    )


def _unit(vector: tuple[float, float]) -> tuple[float, float] | None:
    length = math.hypot(vector[0], vector[1])
    if length <= 1e-9:
        return None
    return vector[0] / length, vector[1] / length


def _direction_away(edge: GraphEdge, node_index: int) -> tuple[float, float]:
    """Unit direction from ``node_index`` along ``edge`` (away from the node)."""
    coords = edge.coords
    if edge.a == node_index:
        origin = coords[0]
        for point in coords[1:]:
            if math.hypot(point[0] - origin[0], point[1] - origin[1]) > 0.5:
                direction = _unit((point[0] - origin[0], point[1] - origin[1]))
                if direction is not None:
                    return direction
    else:
        origin = coords[-1]
        for point in reversed(coords[:-1]):
            if math.hypot(point[0] - origin[0], point[1] - origin[1]) > 0.5:
                direction = _unit((point[0] - origin[0], point[1] - origin[1]))
                if direction is not None:
                    return direction
    # Fallback: chord between the endpoints.
    start, end = coords[0], coords[-1]
    if edge.a == node_index:
        direction = _unit((end[0] - start[0], end[1] - start[1]))
    else:
        direction = _unit((start[0] - end[0], start[1] - end[1]))
    return direction or (1.0, 0.0)


def _line_intersection(
    point_a: tuple[float, float],
    direction_a: tuple[float, float],
    point_b: tuple[float, float],
    direction_b: tuple[float, float],
) -> tuple[float, float] | None:
    cross = direction_a[0] * direction_b[1] - direction_a[1] * direction_b[0]
    if abs(cross) < 1e-6:
        return None
    delta = (point_b[0] - point_a[0], point_b[1] - point_a[1])
    t = (delta[0] * direction_b[1] - delta[1] * direction_b[0]) / cross
    s = (delta[0] * direction_a[1] - delta[1] * direction_a[0]) / cross
    if t < -0.5 or s < -0.5:
        return None
    return point_a[0] + t * direction_a[0], point_a[1] + t * direction_a[1]


def build_graph(ways: list) -> RoadGraph:
    """Split the prepared ways into a topology graph.

    ``ways`` are ``RoadWay``-like objects from ``road_network.prepare_ways``.
    Shared vertices (same projected coordinate in two or more ways) become
    graph nodes; each way is split at them so every edge connects two nodes.
    """
    way_keys: list[tuple[object, list[tuple[float, float]]]] = []
    usage: Counter[tuple[float, float]] = Counter()
    for way in ways:
        keys = [vertex_key(point) for point in way.line.coords]
        way_keys.append((way, keys))
        for key in set(keys):
            usage[key] += 1

    node_index: dict[tuple[float, float], int] = {}
    nodes: list[GraphNode] = []

    def node_for(key: tuple[float, float]) -> int:
        index = node_index.get(key)
        if index is not None:
            return index
        index = len(nodes)
        node_index[key] = index
        nodes.append(GraphNode(index=index, x=key[0], y=key[1]))
        return index

    edges: list[GraphEdge] = []
    way_edges: dict[int, list[int]] = defaultdict(list)

    for way, keys in way_keys:
        coords = [(float(x), float(y)) for x, y in way.line.coords]
        if len(coords) < 2:
            continue
        split_positions = {0, len(coords) - 1}
        for position, key in enumerate(keys):
            if position in (0, len(coords) - 1):
                continue
            if usage[key] >= 2:
                split_positions.add(position)
        ordered = sorted(split_positions)
        for start, end in zip(ordered, ordered[1:]):
            chain = coords[start : end + 1]
            if len(chain) < 2:
                continue
            segment = LineString(chain)
            if segment.length < MIN_EDGE_M:
                continue
            a = node_for(keys[start])
            b = node_for(keys[end])
            edge = GraphEdge(
                index=len(edges),
                way=way,
                coords=chain,
                a=a,
                b=b,
                length=segment.length,
            )
            edges.append(edge)
            way_edges[int(way.osm_id)].append(edge.index)
            nodes[a].edges.append(edge.index)
            nodes[b].edges.append(edge.index)

    # Ways that are short, unnamed connectors between junctions are junction
    # channelization (slip lanes / turn loops): the renderer must not paint them
    # as full streets. This is a graph-level classification because it depends
    # on both endpoints being junctions.
    junction_nodes = _junction_node_indices(nodes, edges)
    channelization: set[int] = set()
    for way in ways:
        if getattr(way, "link", False) or getattr(way, "channelization", False):
            channelization.add(int(way.osm_id))
            continue
        if getattr(way, "name", ""):
            continue
        if getattr(way, "cls", "") not in ("primary", "secondary", "tertiary", "unclassified"):
            continue
        edge_ids = way_edges.get(int(way.osm_id), [])
        if not edge_ids:
            continue
        total = sum(edges[i].length for i in edge_ids)
        if total > 120.0:
            continue
        endpoints: set[int] = set()
        for edge_id in edge_ids:
            endpoints.add(edges[edge_id].a)
            endpoints.add(edges[edge_id].b)
        # A short unnamed connector is channelization when it ends in at least
        # one junction (the other end is often a merge node with degree 2).
        if endpoints and endpoints.intersection(junction_nodes):
            channelization.add(int(way.osm_id))

    return RoadGraph(
        nodes=nodes,
        edges=edges,
        way_edges=dict(way_edges),
        channelization_ways=channelization,
    )


def _junction_node_indices(nodes: list[GraphNode], edges: list[GraphEdge]) -> set[int]:
    """Nodes with three or more distinct approach directions.

    Two edges that leave the node in nearly the same direction (usually a way
    split for tagging) count once, so a simple bend is not a junction.
    """
    junctions: set[int] = set()
    for node in nodes:
        if not node.edges:
            continue
        directions: list[tuple[float, float]] = []
        for edge_id in node.edges:
            edge = edges[edge_id]
            direction = _direction_away(edge, node.index)
            duplicate = False
            for existing in directions:
                dot = max(-1.0, min(1.0, direction[0] * existing[0] + direction[1] * existing[1]))
                if math.acos(dot) < PARALLEL_APPROACH_RAD:
                    duplicate = True
                    break
            if not duplicate:
                directions.append(direction)
        if len(directions) >= 3:
            junctions.add(node.index)
    return junctions


def _approach_width(way) -> float:
    width = float(getattr(way, "width", 6.0) or 6.0)
    if getattr(way, "link", False) or getattr(way, "channelization", False):
        width = min(width, 4.5)
    return max(2.5, width)


def junction_faces(graph: RoadGraph, ways_by_id: dict[int, object]) -> list[JunctionFace]:
    """Build one asphalt face polygon per graph junction node."""
    junction_nodes = _junction_node_indices(graph.nodes, graph.edges)
    faces: list[JunctionFace] = []
    for node_index in sorted(junction_nodes):
        node = graph.nodes[node_index]
        approaches: list[dict] = []
        seen_directions: list[tuple[float, float]] = []
        for edge_id in node.edges:
            edge = graph.edge(edge_id)
            way = edge.way
            direction = _direction_away(edge, node_index)
            duplicate = False
            for existing in seen_directions:
                dot = max(-1.0, min(1.0, direction[0] * existing[0] + direction[1] * existing[1]))
                if math.acos(dot) < PARALLEL_APPROACH_RAD:
                    duplicate = True
                    break
            if duplicate:
                continue
            seen_directions.append(direction)
            width = _approach_width(way)
            approaches.append({
                "edge": edge_id,
                "way": way,
                "direction": direction,
                "width": width,
                "lanes_forward": int(getattr(way, "lanes_forward", 1) or 0),
                "lanes_backward": int(getattr(way, "lanes_backward", 0) or 0),
                "oneway": bool(getattr(way, "oneway", False)),
                "link": bool(
                    getattr(way, "link", False)
                    or getattr(way, "channelization", False)
                    or node_index is not None and int(way.osm_id) in graph.channelization_ways
                ),
            })
        if len(approaches) < 3:
            continue
        # Driveway/service-only nodes are not street junctions: do not cover the
        # yard with an asphalt circle. Keep the face when at least one real
        # street class approaches (a street+service T still needs a mouth).
        major_classes = {
            "motorway",
            "trunk",
            "primary",
            "secondary",
            "tertiary",
            "residential",
            "living_street",
        }
        has_major = any(
            (not approach["link"])
            and getattr(approach["way"], "cls", "unknown") in major_classes
            for approach in approaches
        )
        if not has_major:
            continue
        approaches.sort(key=lambda item: math.atan2(item["direction"][1], item["direction"][0]))

        points_left: list[tuple[float, float]] = []
        points_right: list[tuple[float, float]] = []
        directions: list[tuple[float, float]] = []
        for approach in approaches:
            direction = approach["direction"]
            half = approach["width"] / 2.0
            offset = min(
                MAX_APPROACH_OFFSET_M,
                max(MIN_APPROACH_OFFSET_M, 0.5 * approach["width"] + 1.5),
            )
            left_normal = (-direction[1], direction[0])
            base_x = node.x + direction[0] * offset
            base_y = node.y + direction[1] * offset
            points_left.append((base_x + left_normal[0] * half, base_y + left_normal[1] * half))
            points_right.append((base_x - left_normal[0] * half, base_y - left_normal[1] * half))
            directions.append(direction)

        ring: list[tuple[float, float]] = []
        count = len(approaches)
        corner_limit = max(
            MAX_APPROACH_OFFSET_M * 2.0,
            max(approach["width"] for approach in approaches) * 3.0,
        )
        for index in range(count):
            next_index = (index + 1) % count
            left = points_left[index]
            right_next = points_right[next_index]
            corner = _line_intersection(
                left, directions[index], right_next, directions[next_index]
            )
            if corner is not None:
                delta = (corner[0] - node.x, corner[1] - node.y)
                distance = math.hypot(delta[0], delta[1])
                forward_a = delta[0] * directions[index][0] + delta[1] * directions[index][1]
                forward_b = (
                    delta[0] * directions[next_index][0] + delta[1] * directions[next_index][1]
                )
                if (
                    distance > corner_limit + 12.0
                    or forward_a < -1.0
                    or forward_b < -1.0
                ):
                    corner = None
            if corner is None:
                corner = (
                    (left[0] + right_next[0]) / 2.0,
                    (left[1] + right_next[1]) / 2.0,
                )
            ring.extend((left, corner, right_next))

        # Candidate 1: the corner-joined ring (fills the kerb corners). It is
        # only usable when the approach geometry is sane (no self-intersection).
        ring_polygon = Polygon(ring)
        ring_ok = (
            ring_polygon.is_valid
            and ring_polygon.area >= FACE_MIN_AREA_M2
            and ring_polygon.contains(Point(node.x, node.y))
        )
        # Candidate 2: the union of the approach mouth rectangles. Always
        # geometrically sound (a plus/Y-shaped junction face); the kerb corners
        # stay outside and become paving, which is what a real corner kerb does.
        mouth_rects: list[Polygon] = []
        for approach in approaches:
            direction = approach["direction"]
            width = approach["width"]
            offset = min(
                MAX_APPROACH_OFFSET_M,
                max(MIN_APPROACH_OFFSET_M, 0.5 * width + 1.5),
            )
            segment = LineString([
                (node.x, node.y),
                (node.x + direction[0] * offset, node.y + direction[1] * offset),
            ])
            mouth_rects.append(segment.buffer(width / 2.0, cap_style=2))
        mouth_polygon = unary_union(mouth_rects)
        if not mouth_polygon.is_valid:
            mouth_polygon = mouth_polygon.buffer(0)
        mouth_ok = (
            not mouth_polygon.is_empty
            and mouth_polygon.area >= FACE_MIN_AREA_M2
            and mouth_polygon.contains(Point(node.x, node.y))
        )
        fallback = False
        if ring_ok:
            polygon = ring_polygon
        elif mouth_ok:
            polygon = mouth_polygon
        else:
            radius = max(approach["width"] for approach in approaches) / 2.0 + 2.0
            polygon = Point(node.x, node.y).buffer(radius, quad_segs=8)
            fallback = True
        if polygon.is_empty or polygon.area < FACE_MIN_AREA_M2:
            continue
        max_radius = max(
            math.hypot(point[0] - node.x, point[1] - node.y) for point in polygon.exterior.coords
        )
        if max_radius > FACE_MAX_RADIUS_M:
            if mouth_ok:
                polygon = mouth_polygon
            else:
                radius = max(approach["width"] for approach in approaches) / 2.0 + 2.0
                polygon = Point(node.x, node.y).buffer(radius, quad_segs=8)
                fallback = True
        polygon = polygon.buffer(0)
        if polygon.is_empty or polygon.area < FACE_MIN_AREA_M2:
            continue
        faces.append(
            JunctionFace(
                node=node_index,
                x=node.x,
                y=node.y,
                polygon=polygon,
                fallback=fallback,
                approaches=approaches,
            )
        )
    return faces


def face_material(face: JunctionFace, fallback: str = "asphalt") -> str:
    """Dominant carriageway material of the approaches (width-weighted)."""
    weights: dict[str, float] = defaultdict(float)
    for approach in face.approaches:
        material = getattr(approach["way"], "material", None) or fallback
        weights[material] += approach["width"]
    if not weights:
        return fallback
    return max(weights.items(), key=lambda item: (item[1], item[0]))[0]


def dual_carriageway_pairs(graph: RoadGraph) -> list[tuple[int, int, float]]:
    """Candidate opposite one-way edge pairs of one street (graph-adjacent).

    Returns ``(edge_a, edge_b, inner_gap)`` where the two edges lie within 22 m
    and run in opposite directions. The caller still decides whether to merge
    them (overlapping buffers) or to draw a median between them.
    """
    pairs: list[tuple[int, int, float]] = []
    edges = graph.edges
    for first in edges:
        if not getattr(first.way, "oneway", False):
            continue
        if getattr(first.way, "link", False) or getattr(first.way, "channelization", False):
            continue
        for second in edges:
            if second.index <= first.index:
                continue
            if getattr(second.way, "oneway", False) is not True:
                continue
            if getattr(second.way, "link", False) or getattr(second.way, "channelization", False):
                continue
            if first.way.group != second.way.group:
                continue
            distance = LineString(first.coords).distance(LineString(second.coords))
            if distance > 22.0:
                continue
            direction_a = _unit(
                (first.coords[-1][0] - first.coords[0][0], first.coords[-1][1] - first.coords[0][1])
            )
            direction_b = _unit(
                (second.coords[-1][0] - second.coords[0][0], second.coords[-1][1] - second.coords[0][1])
            )
            if direction_a is None or direction_b is None:
                continue
            if direction_a[0] * direction_b[0] + direction_a[1] * direction_b[1] > -0.2:
                continue
            inner_gap = distance - (_approach_width(first.way) + _approach_width(second.way)) / 2.0
            pairs.append((first.index, second.index, inner_gap))
    return pairs
