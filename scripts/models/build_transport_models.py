# -*- coding: utf-8 -*-
"""Build the Isometric Minsk transport fleet in Blender (headless).

The script authors seven low-poly vehicle templates from parametric triangle
soup, keeps them as real Blender mesh objects (one object per template, one
vertex-colour material), saves `assets/transport/transport.blend`, optionally
exports per-model GLB copies and a Cycles preview, and writes the compact web
payload consumed by the app:

    public/data/mobility/vehicles/manifest.json
    public/data/mobility/vehicles/vehicles.bin

Coordinate conventions (authorship, Blender Z-up):
    +X forward, +Y left, +Z up; wheel contact at z = 0; centred on X/Y.

Runtime convention (three.js): +X forward, +Y up, +Z right. The packer maps
Blender (x, y, z) -> runtime (x, z, -y); this is a rotation, so triangle
winding and outward normals are preserved.

The body panels are authored near-white: the runtime multiplies them by
`instanceColor` to apply the per-trip livery. Glass, rubber, lights, skirts and
roof equipment keep their authored colours, so a livery tint cannot destroy the
silhouette.

Usage (from the repo root):
    blender.exe --background --factory-startup \
        --python scripts/models/build_transport_models.py -- --render

Optional flags: --render (Cycles contact previews), --glb (per-model GLB),
--no-blend (skip the .blend save).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import os
import struct
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSET_DIR = os.path.join(ROOT, "assets", "transport")
GLB_DIR = os.path.join(ASSET_DIR, "models")
PAYLOAD_DIR = os.path.join(ROOT, "public", "data", "mobility", "vehicles")
PREVIEW_DIR = os.path.join(ROOT, "screenshots", "transport-models")

POSITION_SCALE = 100  # centimetres per metre (int16 is plenty for a 25 m car)
PAYLOAD_VERSION = 1


# ---------------------------------------------------------------------------
# colour helpers (authored in sRGB)
# ---------------------------------------------------------------------------
def rgb(value: str) -> tuple[float, float, float]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"expected #rrggbb, got {value!r}")
    return tuple(int(text[index : index + 2], 16) / 255.0 for index in (0, 2, 4))


def shade(color: tuple[float, float, float], factor: float) -> tuple[float, float, float]:
    return tuple(min(1.0, max(0.0, channel * factor)) for channel in color)


def mix(
    left: tuple[float, float, float],
    right: tuple[float, float, float],
    amount: float,
) -> tuple[float, float, float]:
    return tuple(left[i] + (right[i] - left[i]) * amount for i in range(3))


def srgb_to_linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


WHITE = rgb("#ffffff")
# Minsktrans liveries sampled from reference photos (2026-11-18):
# yellow MAZ-203 bus, mint MAZ-203T trolleybus, turquoise/white AKSM-60102 tram,
# blue/light-grey ER9M EMU with orange stripes, green VL80S freight locomotive.
BUS_YELLOW = rgb("#e9b900")
BUS_YELLOW_DARK = rgb("#c79c00")
TROLLEY_MINT = rgb("#c9d9c7")
TROLLEY_GREEN = rgb("#3d5144")
TRAM_TEAL = rgb("#35b4ad")
TRAM_TEAL_DARK = rgb("#2a938e")
TRAM_WHITE = rgb("#f1f1ec")
TRAM_PANTO = rgb("#b23a2f")
ER9_BLUE = rgb("#2f5f9e")
ER9_LIGHT = rgb("#c7d4dc")
ER9_ORANGE = rgb("#e87722")
ER9_RED = rgb("#8f3f38")
LOCO_GREEN = rgb("#2f5a3a")
LOCO_LIGHT = rgb("#c4cf6a")
LOCO_RED = rgb("#b3382c")
WAGON_BROWN = rgb("#5a4a3c")
WAGON_RIB = rgb("#43382e")
GLASS = rgb("#1f272e")
GLASS_LIGHT = rgb("#2c353c")
BUS_MASK = rgb("#0d1012")
BUS_GLASS = rgb("#5a6b74")
RUBBER = rgb("#141414")
HUB = rgb("#6a6a64")
SKIRT = rgb("#33322d")
UNDERBODY = rgb("#20201d")
ROOF = rgb("#d8d4c8")
ROOF_DARK = rgb("#9a9c96")
HEADLIGHT = rgb("#fff3c9")
TAILLIGHT = rgb("#b3352a")
TURN = rgb("#c98235")
BOARD = rgb("#e6dfc4")
BOARD_DARK = rgb("#24282c")
POLE = rgb("#5a5a56")
POLE_SHOE = rgb("#8a8a80")
BOGIE = rgb("#262624")
BUFFER = rgb("#4a4a46")
RIB = rgb("#6e6b63")
WAGON = rgb("#5c5a54")
WAGON_COAL = rgb("#1b1b1a")
HANDRAIL = rgb("#8f8f87")


# ---------------------------------------------------------------------------
# triangle-soup builder
# ---------------------------------------------------------------------------
def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _normalize(a):
    length = math.sqrt(_dot(a, a))
    if length < 1e-9:
        return (0.0, 0.0, 0.0)
    return (a[0] / length, a[1] / length, a[2] / length)


class MeshBuilder:
    """Non-indexed triangle soup with one sRGB colour per triangle corner."""

    def __init__(self, name: str):
        self.name = name
        self.vertices: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, int, int]] = []
        self.colors: list[tuple[float, float, float]] = []

    # -- primitives -------------------------------------------------------
    def tri(self, a, b, c, color) -> None:
        base = len(self.vertices)
        self.vertices.extend((a, b, c))
        self.faces.append((base, base + 1, base + 2))
        self.colors.extend((color, color, color))

    def tri_facing(self, a, b, c, color, outward) -> None:
        normal = _cross(_sub(b, a), _sub(c, a))
        if _dot(normal, outward) < 0:
            b, c = c, b
        self.tri(a, b, c, color)

    def quad(self, a, b, c, d, color, outward=None) -> None:
        if outward is not None:
            normal = _cross(_sub(b, a), _sub(c, a))
            if _dot(normal, outward) < 0:
                a, b, c, d = a, d, c, b
        self.tri(a, b, c, color)
        self.tri(a, c, d, color)

    def box(self, center, size, color, face_shade=None) -> None:
        cx, cy, cz = center
        hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
        x0, x1 = cx - hx, cx + hx
        y0, y1 = cy - hy, cy + hy
        z0, z1 = cz - hz, cz + hz
        p000 = (x0, y0, z0)
        p100 = (x1, y0, z0)
        p110 = (x1, y1, z0)
        p010 = (x0, y1, z0)
        p001 = (x0, y0, z1)
        p101 = (x1, y0, z1)
        p111 = (x1, y1, z1)
        p011 = (x0, y1, z1)
        shades = face_shade or {
            "top": 1.0,
            "bottom": 0.5,
            "front": 0.96,
            "back": 0.82,
            "left": 0.9,
            "right": 0.9,
        }
        self.quad(p001, p011, p111, p101, shade(color, shades["top"]), (0, 0, 1))
        self.quad(p000, p100, p110, p010, shade(color, shades["bottom"]), (0, 0, -1))
        self.quad(p100, p101, p111, p110, shade(color, shades["front"]), (1, 0, 0))
        self.quad(p000, p010, p011, p001, shade(color, shades["back"]), (-1, 0, 0))
        self.quad(p010, p011, p111, p110, shade(color, shades["left"]), (0, 1, 0))
        self.quad(p000, p100, p101, p001, shade(color, shades["right"]), (0, -1, 0))

    def cylinder(
        self,
        axis: str,
        center,
        radius: float,
        half_length: float,
        segments: int,
        side_color,
        cap_color=None,
        start_angle: float = 0.0,
    ) -> None:
        cap_color = cap_color or side_color
        count = max(3, int(segments))
        if axis == "x":
            direction, u, v = (1, 0, 0), (0, 1, 0), (0, 0, 1)
        elif axis == "y":
            direction, u, v = (0, 1, 0), (1, 0, 0), (0, 0, 1)
        else:
            direction, u, v = (0, 0, 1), (1, 0, 0), (0, 1, 0)
        lo = tuple(center[i] - direction[i] * half_length for i in range(3))
        hi = tuple(center[i] + direction[i] * half_length for i in range(3))
        for index in range(count):
            a0 = start_angle + (index / count) * math.tau
            a1 = start_angle + ((index + 1) / count) * math.tau
            p0 = tuple(
                lo[i] + u[i] * math.cos(a0) * radius + v[i] * math.sin(a0) * radius
                for i in range(3)
            )
            p1 = tuple(
                lo[i] + u[i] * math.cos(a1) * radius + v[i] * math.sin(a1) * radius
                for i in range(3)
            )
            q0 = tuple(hi[i] + (p0[i] - lo[i]) for i in range(3))
            q1 = tuple(hi[i] + (p1[i] - lo[i]) for i in range(3))
            mid = (a0 + a1) * 0.5
            outward = _normalize(
                tuple(u[i] * math.cos(mid) + v[i] * math.sin(mid) for i in range(3))
            )
            self.quad(p0, p1, q1, q0, side_color, outward)
            self.tri_facing(lo, p0, p1, cap_color, tuple(-direction[i] for i in range(3)))
            self.tri_facing(hi, q0, q1, cap_color, direction)

    def beam(self, start, end, width: float, height: float, color, up_ref=(0, 0, 1)) -> None:
        direction = _normalize(_sub(end, start))
        if abs(_dot(direction, up_ref)) > 0.95:
            up_ref = (1, 0, 0)
        side = _normalize(_cross(direction, up_ref))
        up = _normalize(_cross(side, direction))
        half_w, half_h = width * 0.5, height * 0.5

        def corner(point, sx, sy):
            return tuple(
                point[i] + side[i] * half_w * sx + up[i] * half_h * sy for i in range(3)
            )

        a00, a10 = corner(start, -1, -1), corner(start, 1, -1)
        a11, a01 = corner(start, 1, 1), corner(start, -1, 1)
        b00, b10 = corner(end, -1, -1), corner(end, 1, -1)
        b11, b01 = corner(end, 1, 1), corner(end, -1, 1)
        self.quad(a00, a10, b10, b00, color, tuple(-up[i] for i in range(3)))
        self.quad(a01, b01, b11, a11, color, up)
        self.quad(a00, b00, b01, a01, color, tuple(-side[i] for i in range(3)))
        self.quad(a10, a11, b11, b10, color, side)
        self.quad(a00, a01, a11, a10, color, tuple(-direction[i] for i in range(3)))
        self.quad(b00, b10, b11, b01, color, direction)

    def loft(self, profile, sections, segment_colors, cap_color) -> None:
        rings = []
        for section in sections:
            x = section["x"]
            scale_y = section.get("scale_y", 1.0)
            scale_z = section.get("scale_z", 1.0)
            bottom = section.get("bottom", min(point[1] for point in profile))
            ring = []
            for y, z in profile:
                ring.append((x, y * scale_y, bottom + (z - bottom) * scale_z))
            rings.append(ring)
        count = len(profile)
        for index in range(len(rings) - 1):
            left, right = rings[index], rings[index + 1]
            zs = [point[2] for point in left]
            z_center = (min(zs) + max(zs)) * 0.5
            for edge in range(count):
                nxt = (edge + 1) % count
                p0, p1 = left[edge], left[nxt]
                p2, p3 = right[nxt], right[edge]
                mid_y = (p0[1] + p1[1]) * 0.5
                mid_z = (p0[2] + p1[2]) * 0.5
                outward = _normalize((0.0, mid_y, mid_z - z_center))
                color = (
                    segment_colors(edge)
                    if callable(segment_colors)
                    else segment_colors[edge]
                )
                self.quad(p0, p1, p2, p3, color, outward)
        for ring, outward in ((rings[0], (-1, 0, 0)), (rings[-1], (1, 0, 0))):
            cx = sum(point[0] for point in ring) / count
            cy = sum(point[1] for point in ring) / count
            cz = sum(point[2] for point in ring) / count
            center = (cx, cy, cz)
            for edge in range(count):
                nxt = (edge + 1) % count
                self.tri_facing(center, ring[edge], ring[nxt], cap_color, outward)

    def arch(self, x, side_y, z_center, r_outer, r_inner, color, side, segments=7) -> None:
        """Flat dark wheel-arch ring on one body side (upper semicircle)."""
        y = side_y
        outward = (0, 1 if side > 0 else -1, 0)
        for index in range(segments):
            a0 = math.pi * index / segments
            a1 = math.pi * (index + 1) / segments
            p0 = (x + math.cos(a0) * r_inner, y, z_center + math.sin(a0) * r_inner)
            p1 = (x + math.cos(a1) * r_inner, y, z_center + math.sin(a1) * r_inner)
            p2 = (x + math.cos(a1) * r_outer, y, z_center + math.sin(a1) * r_outer)
            p3 = (x + math.cos(a0) * r_outer, y, z_center + math.sin(a0) * r_outer)
            self.quad(p0, p1, p2, p3, color, outward)

    def wheel(self, x, y, radius, width, segments=8, hub=True) -> None:
        # Start at -90 deg so a polygon vertex is exactly at the rail contact
        # point for wheel profiles with any segment count.
        self.cylinder(
            "y",
            (x, y, radius),
            radius,
            width * 0.5,
            segments,
            RUBBER,
            HUB,
            start_angle=-math.pi * 0.5,
        )
        if hub:
            for side in (-1, 1):
                self.cylinder(
                    "y",
                    (x, y + side * (width * 0.5 + 0.012), radius),
                    radius * 0.52,
                    0.015,
                    6,
                    HUB,
                    shade(HUB, 1.12),
                    start_angle=-math.pi * 0.5,
                )

    def count(self) -> int:
        return len(self.faces)


# ---------------------------------------------------------------------------
# shared body helpers
# ---------------------------------------------------------------------------
def headlight(
    builder: MeshBuilder,
    x: float,
    y: float,
    z: float,
    direction: int,
    radius: float = 0.095,
    ring: float = 0.13,
    lens=HEADLIGHT,
    ring_color=BUS_MASK,
    segments: int = 8,
) -> None:
    """Round headlight with a dark surround ring (MAZ / VL80 references)."""
    builder.cylinder(
        "x",
        (x + direction * 0.01, y, z),
        ring,
        0.02,
        segments,
        ring_color,
        ring_color,
    )
    builder.cylinder(
        "x",
        (x + direction * 0.03, y, z),
        radius,
        0.03,
        segments,
        lens,
        lens,
    )


def side_panel(
    builder: MeshBuilder,
    x0: float,
    x1: float,
    z0: float,
    z1: float,
    side: int,
    y: float,
    color,
    inset: float = 0.012,
) -> None:
    """A thin quad on a vertical body side (normal along +/-Y)."""
    y = side * (abs(y) + inset)
    outward = (0, 1 if side > 0 else -1, 0)
    builder.quad((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1), color, outward)


def front_panel(
    builder: MeshBuilder,
    x: float,
    y0: float,
    y1: float,
    z0: float,
    z1: float,
    color,
    direction: int = 1,
    inset: float = 0.012,
) -> None:
    x = x + direction * inset
    builder.quad(
        (x, y0, z0),
        (x, y1, z0),
        (x, y1, z1),
        (x, y0, z1),
        color,
        (direction, 0, 0),
    )


def door(
    builder: MeshBuilder,
    x_center: float,
    width: float,
    side: int,
    y: float,
    z_bottom: float,
    z_top: float,
    lower_height: float,
    glass=GLASS,
    frame=WHITE,
) -> None:
    """Double-leaf door with a lower panel, two glass leaves and a step.

    The four corner posts/header of the previous version were removed: at map
    scale the dark glass leaves and the yellow body already read as a framed
    door, and the saved geometry buys detail elsewhere.
    """
    half = width * 0.5
    y_face = side * (abs(y) + 0.016)
    outward = (0, 1 if side > 0 else -1, 0)
    builder.quad(
        (x_center - half, y_face, z_bottom),
        (x_center + half, y_face, z_bottom),
        (x_center + half, y_face, z_bottom + lower_height),
        (x_center - half, y_face, z_bottom + lower_height),
        shade(frame, 0.84),
        outward,
    )
    gap = 0.035
    leaf = (half - gap) * 0.5
    for leaf_index in (-1, 1):
        cx = x_center + leaf_index * (leaf + gap * 0.5)
        builder.quad(
            (cx - leaf, y_face, z_bottom + lower_height),
            (cx + leaf, y_face, z_bottom + lower_height),
            (cx + leaf, y_face, z_top),
            (cx - leaf, y_face, z_top),
            glass,
            outward,
        )
    # Thin frame edges and a centre post read as a double-leaf door without
    # the six boxes of the first version.
    for edge in (x_center - half, x_center + half):
        builder.quad(
            (edge - 0.025, y_face, z_bottom),
            (edge + 0.025, y_face, z_bottom),
            (edge + 0.025, y_face, z_top),
            (edge - 0.025, y_face, z_top),
            BOARD_DARK,
            outward,
        )
    builder.quad(
        (x_center - 0.02, y_face, z_bottom + lower_height),
        (x_center + 0.02, y_face, z_bottom + lower_height),
        (x_center + 0.02, y_face, z_top),
        (x_center - 0.02, y_face, z_top),
        BOARD_DARK,
        outward,
    )
    builder.box(
        (x_center, side * (abs(y) - 0.10), z_bottom - 0.05),
        (width * 0.9, 0.32, 0.10),
        UNDERBODY,
    )


def window_row(
    builder: MeshBuilder,
    spans,
    z0: float,
    z1: float,
    side: int,
    half_width: float,
    glass=GLASS,
) -> None:
    for x0, x1 in spans:
        side_panel(builder, x0, x1, z0, z1, side, half_width, glass)
        # A thin chassis-coloured sill under the glass reads as the window rail.
        side_panel(
            builder,
            x0 - 0.03,
            x1 + 0.03,
            z0 - 0.05,
            z0,
            side,
            half_width + 0.004,
            shade(WHITE, 0.82),
        )


def glass_band(
    builder: MeshBuilder,
    x0: float,
    x1: float,
    z0: float,
    z1: float,
    side: int,
    half_width: float,
    pillars: list[float],
    glass=GLASS,
    pillar_color=WHITE,
) -> None:
    """One continuous dark window band with body-coloured pillars on top.

    This is both cheaper and closer to the Minsk vehicles than ten separate
    panes: the reference bus/tram/EMU has a long dark glazing band split by
    thin body-coloured pillars.
    """
    side_panel(builder, x0, x1, z0, z1, side, half_width, glass)
    for x in pillars:
        side_panel(
            builder,
            x - 0.045,
            x + 0.045,
            z0 - 0.01,
            z1 + 0.01,
            side,
            half_width + 0.004,
            pillar_color,
        )


def roof_hatch(builder: MeshBuilder, x, y, z, width=0.7, length=0.9, color=ROOF_DARK) -> None:
    builder.box((x, y, z + 0.045), (length, width, 0.09), color)


# ---------------------------------------------------------------------------
# bus / trolleybus
# ---------------------------------------------------------------------------
BUS_LENGTH = 12.0
BUS_WIDTH = 2.5
BUS_HALF_W = BUS_WIDTH * 0.5
BUS_BOTTOM = 0.58
BUS_ROOF = 3.18
BUS_PROFILE = [
    (-BUS_HALF_W, BUS_BOTTOM),
    (-BUS_HALF_W, 2.18),
    (-BUS_HALF_W * 0.995, 2.62),
    (-BUS_HALF_W * 0.93, 2.96),
    (-BUS_HALF_W * 0.62, BUS_ROOF),
    (BUS_HALF_W * 0.62, BUS_ROOF),
    (BUS_HALF_W * 0.93, 2.96),
    (BUS_HALF_W * 0.995, 2.62),
    (BUS_HALF_W, 2.18),
    (BUS_HALF_W, BUS_BOTTOM),
]


def bus_segment_color(index: int):
    if index in (3, 4, 5):
        return shade(BUS_YELLOW, 0.93)
    if index == 9:
        return UNDERBODY
    return BUS_YELLOW


def bus_wheels(builder: MeshBuilder) -> None:
    for x in (3.35, -2.95):
        for side in (-1, 1):
            builder.wheel(x, side * (BUS_HALF_W - 0.10), 0.52, 0.30, 8, hub=True)
            builder.arch(
                x,
                side * (BUS_HALF_W + 0.011),
                0.52,
                0.65,
                0.50,
                RUBBER,
                side,
                segments=4,
            )


def bus_details(builder: MeshBuilder) -> None:
    front, back = BUS_LENGTH * 0.5, -BUS_LENGTH * 0.5
    # Long dark glazing band with yellow pillars (MAZ-203 reference).
    pillars = [-5.0, -3.9, -2.8, -1.7, -0.6, 0.5, 1.6, 2.7, 3.8, 4.9]
    glass_band(builder, -5.25, 5.25, 1.70, 2.58, 1, BUS_HALF_W, pillars, GLASS, BUS_YELLOW)
    glass_band(builder, -5.25, 5.25, 1.70, 2.58, -1, BUS_HALF_W, pillars, GLASS, BUS_YELLOW)
    # Doors on the right-hand side (right of travel = -Y).
    door(builder, 3.95, 1.10, -1, BUS_HALF_W, 0.62, 2.58, 0.76, GLASS, BUS_YELLOW)
    door(builder, -1.62, 1.10, -1, BUS_HALF_W, 0.62, 2.58, 0.76, GLASS, BUS_YELLOW)
    # Black front mask with a large windshield and destination display.
    # Black mask around the glazing only: yellow roof edge above, yellow
    # lower front with round headlights below (MAZ-203 reference).
    front_panel(builder, front, -1.08, 1.08, 1.10, 2.78, BUS_MASK)
    front_panel(builder, front, -0.84, 0.84, 2.56, 2.76, BOARD_DARK, inset=0.024)
    front_panel(builder, front, -0.76, 0.76, 2.60, 2.72, TURN, inset=0.036)
    front_panel(builder, front, -1.02, -0.05, 1.34, 2.52, BUS_GLASS, inset=0.024)
    front_panel(builder, front, 0.05, 1.02, 1.34, 2.52, BUS_GLASS, inset=0.024)
    front_panel(builder, front, -0.05, 0.05, 1.34, 2.52, BUS_MASK, inset=0.032)
    front_panel(builder, front, -0.90, 0.90, 1.10, 1.34, BUS_MASK, inset=0.02)
    # Rear mask, window, grille and lights.
    front_panel(builder, back, -1.02, 1.02, 0.68, 2.62, GLASS, direction=-1)
    front_panel(builder, back, -0.90, 0.90, 1.55, 2.36, GLASS_LIGHT, direction=-1)
    front_panel(builder, back, -0.86, 0.86, 0.86, 1.10, shade(WHITE, 0.45), direction=-1)
    # Bumpers.
    builder.box((front + 0.03, 0.0, 0.70), (0.16, BUS_WIDTH - 0.10, 0.26), SKIRT)
    builder.box((front + 0.05, 0.0, 0.94), (0.04, 0.62, 0.16), shade(WHITE, 0.85))
    builder.box((back - 0.03, 0.0, 0.74), (0.16, BUS_WIDTH - 0.14, 0.26), SKIRT)
    for side in (-1, 1):
        # Round headlights and amber indicators in the black mask.
        # MAZ-203: column of two lights on the outer side, the third beside
        # the upper one (MAZ front reference).
        headlight(builder, front, side * 0.86, 1.02, 1, 0.065, 0.095, segments=6)
        headlight(builder, front, side * 0.86, 0.82, 1, 0.065, 0.095, segments=6)
        headlight(builder, front, side * 0.60, 1.02, 1, 0.065, 0.095, segments=6)
        builder.box((front + 0.03, side * 0.55, 0.82), (0.08, 0.14, 0.10), TURN)
        builder.cylinder(
            "x", (back - 0.02, side * 0.80, 1.04), 0.085, 0.035, 8, TAILLIGHT, TAILLIGHT
        )
        builder.beam(
            (front + 0.05, side * 0.18, 1.52),
            (front + 0.05, side * 0.70, 2.10),
            0.024,
            0.024,
            RUBBER,
        )
        builder.beam(
            (front - 0.26, side * (BUS_HALF_W + 0.02), 2.18),
            (front + 0.02, side * (BUS_HALF_W + 0.18), 2.30),
            0.045,
            0.045,
            POLE,
        )
        builder.box(
            (front + 0.04, side * (BUS_HALF_W + 0.24), 2.28),
            (0.10, 0.08, 0.34),
            BOARD_DARK,
        )
    # Roof equipment: large white AC unit and one hatch.
    builder.box((-1.7, 0.0, BUS_ROOF + 0.16), (2.5, 1.45, 0.32), shade(WHITE, 0.94))
    builder.box((-1.7, 0.0, BUS_ROOF + 0.30), (1.8, 1.05, 0.10), shade(WHITE, 0.86))
    roof_hatch(builder, 4.1, 0.0, BUS_ROOF, 0.6, 0.7)
    builder.box((0.2, 0.0, 0.46), (7.6, 1.70, 0.30), UNDERBODY)


def trolley_equipment(builder: MeshBuilder) -> None:
    """Roof platform, insulators and two trolley poles angled back/up."""
    builder.box((-0.9, 0.0, BUS_ROOF + 0.12), (2.0, 1.55, 0.18), TROLLEY_GREEN)
    for side in (-1, 1):
        z = side * 0.58
        builder.box((0.55, z, BUS_ROOF + 0.26), (0.34, 0.22, 0.16), POLE_SHOE)
        builder.beam(
            (0.62, z, BUS_ROOF + 0.32),
            (-2.15, z, 4.62),
            0.075,
            0.075,
            POLE,
        )
        builder.box((-2.20, z, 4.66), (0.30, 0.22, 0.10), POLE_SHOE)
        builder.beam(
            (-2.20, z, 4.66),
            (-2.52, z, 4.74),
            0.035,
            0.035,
            POLE_SHOE,
        )


def build_bus() -> MeshBuilder:
    builder = MeshBuilder("bus")
    builder.loft(
        BUS_PROFILE,
        [
            {"x": -BUS_LENGTH / 2, "scale_y": 0.90, "scale_z": 0.97},
            {"x": -BUS_LENGTH / 2 + 0.30},
            {"x": BUS_LENGTH / 2 - 0.30},
            {"x": BUS_LENGTH / 2, "scale_y": 0.90, "scale_z": 0.97},
        ],
        bus_segment_color,
        WHITE,
    )
    bus_details(builder)
    bus_wheels(builder)
    return builder


def build_trolleybus() -> MeshBuilder:
    base = build_bus()
    builder = MeshBuilder("trolleybus")
    builder.vertices = list(base.vertices)
    builder.faces = list(base.faces)
    builder.colors = list(base.colors)
    # Mint MAZ-203T body: recolour every yellow body triangle, keep the baked
    # dark details. The proxy colour match is by authored colour, not a shader.
    mint = []
    for index in range(0, len(builder.colors), 3):
        color = builder.colors[index]
        # Yellow body panels (including the shaded roof edge and door lower
        # panels) become mint; dark glass/rubber/lights keep their colour.
        if color[0] > 0.6 and color[1] > 0.35 and color[2] < 0.15:
            factor = min(1.0, max(0.0, color[0] / BUS_YELLOW[0]))
            mapped = shade(TROLLEY_MINT, factor)
        else:
            mapped = color
        mint.extend((mapped, mapped, mapped))
    builder.colors = mint
    for side in (-1, 1):
        side_panel(builder, -5.35, 5.35, 0.60, 0.82, side, BUS_HALF_W, TROLLEY_GREEN)
    front_panel(builder, BUS_LENGTH / 2, -1.05, 1.05, 0.60, 0.82, TROLLEY_GREEN)
    front_panel(builder, -BUS_LENGTH / 2, -1.05, 1.05, 0.60, 0.82, TROLLEY_GREEN, direction=-1)
    trolley_equipment(builder)
    return builder


# ---------------------------------------------------------------------------
# tram
# ---------------------------------------------------------------------------
TRAM_LENGTH = 15.2
TRAM_HALF_W = 1.25
TRAM_BOTTOM = 0.55
TRAM_ROOF = 3.62
TRAM_PROFILE = [
    (-TRAM_HALF_W, TRAM_BOTTOM),
    (-TRAM_HALF_W, 2.55),
    (-TRAM_HALF_W * 0.995, 3.00),
    (-TRAM_HALF_W * 0.90, 3.35),
    (-TRAM_HALF_W * 0.55, TRAM_ROOF),
    (TRAM_HALF_W * 0.55, TRAM_ROOF),
    (TRAM_HALF_W * 0.90, 3.35),
    (TRAM_HALF_W * 0.995, 3.00),
    (TRAM_HALF_W, 2.55),
    (TRAM_HALF_W, TRAM_BOTTOM),
]


def tram_segment_color(index: int):
    if index in (3, 4, 5):
        return shade(TRAM_TEAL, 0.92)
    if index == 9:
        return UNDERBODY
    return TRAM_TEAL


def build_tram() -> MeshBuilder:
    builder = MeshBuilder("tram")
    builder.loft(
        TRAM_PROFILE,
        [
            {"x": -TRAM_LENGTH / 2, "scale_y": 0.88, "scale_z": 0.97},
            {"x": -TRAM_LENGTH / 2 + 0.32},
            {"x": TRAM_LENGTH / 2 - 0.32},
            {"x": TRAM_LENGTH / 2, "scale_y": 0.88, "scale_z": 0.97},
        ],
        tram_segment_color,
        TRAM_TEAL,
    )
    # AKSM-60102: turquoise body, white lower band, long dark glazing band.
    for side in (-1, 1):
        side_panel(builder, -7.15, 7.15, 0.56, 0.86, side, TRAM_HALF_W, TRAM_WHITE)
    front_panel(builder, TRAM_LENGTH / 2, -1.02, 1.02, 0.56, 0.86, TRAM_WHITE)
    front_panel(builder, -TRAM_LENGTH / 2, -1.02, 1.02, 0.56, 0.86, TRAM_WHITE, direction=-1)
    pillars = [-6.2, -5.1, -4.0, -2.9, -1.8, -0.7, 0.4, 1.5, 2.6, 3.7, 4.8, 5.9]
    glass_band(builder, -6.6, 6.6, 1.46, 2.74, 1, TRAM_HALF_W, pillars, GLASS, TRAM_TEAL)
    glass_band(builder, -6.6, 6.6, 1.46, 2.74, -1, TRAM_HALF_W, pillars, GLASS, TRAM_TEAL)
    for x in (-5.05, -1.65, 1.75, 5.05):
        door(builder, x, 1.30, -1, TRAM_HALF_W, 0.58, 2.78, 0.88, GLASS, TRAM_TEAL)
    for direction in (1, -1):
        x = direction * TRAM_LENGTH / 2
        # One large windshield, a black destination band and the white sill.
        front_panel(builder, x, -0.95, 0.95, 1.34, 2.86, GLASS, direction=direction)
        front_panel(builder, x, -0.84, 0.84, 2.94, 3.18, BOARD_DARK, direction=direction)
        front_panel(builder, x, -0.80, 0.80, 3.01, 3.11, TURN, direction=direction)
        builder.box((x + direction * 0.06, 0.0, 0.74), (0.18, 2.30, 0.30), SKIRT)
        builder.box((x + direction * 0.10, 0.0, 0.54), (0.24, 0.38, 0.28), BOGIE)
        for side in (-1, 1):
            headlight(
                builder,
                x,
                side * 0.78,
                0.98,
                direction,
                0.095,
                0.135,
                HEADLIGHT if direction > 0 else TAILLIGHT,
                SKIRT,
            )
    # Roof equipment and the red AKSM pantograph.
    builder.box((2.6, 0.0, TRAM_ROOF + 0.10), (1.6, 1.15, 0.20), ROOF_DARK)
    builder.box((-3.1, 0.0, TRAM_ROOF + 0.08), (1.2, 1.00, 0.16), ROOF_DARK)
    panto_x = -1.4
    builder.box((panto_x, 0.0, TRAM_ROOF + 0.10), (1.20, 1.20, 0.18), TRAM_TEAL_DARK)
    builder.beam(
        (panto_x - 0.55, 0.0, TRAM_ROOF + 0.26),
        (panto_x + 0.85, 0.0, 4.72),
        0.080,
        0.080,
        TRAM_PANTO,
    )
    builder.beam(
        (panto_x + 0.85, 0.0, 4.72),
        (panto_x - 0.55, 0.0, 4.92),
        0.065,
        0.065,
        TRAM_PANTO,
    )
    builder.beam(
        (panto_x - 0.55, 0.0, 4.55),
        (panto_x + 0.55, 0.0, 4.55),
        0.045,
        0.045,
        TRAM_PANTO,
    )
    builder.box((panto_x, 0.0, 4.95), (0.10, 1.65, 0.08), TRAM_PANTO)
    # Bogies and wheels.
    for x in (-4.75, 4.75):
        builder.box((x, 0.0, 0.42), (2.55, 2.02, 0.34), BOGIE)
        for axle in (-0.86, 0.86):
            for side in (-1, 1):
                builder.wheel(x + axle, side * 1.02, 0.36, 0.20, 6, hub=False)
    return builder


# ---------------------------------------------------------------------------
# commuter EMU
# ---------------------------------------------------------------------------
CAR_LENGTH = 24.5
CAR_HALF_W = 1.725
CAR_FLOOR = 1.02
CAR_ROOF = 4.22
CAR_PROFILE = [
    (-CAR_HALF_W, CAR_FLOOR),
    (-CAR_HALF_W, 2.92),
    (-CAR_HALF_W * 0.985, 3.36),
    (-CAR_HALF_W * 0.88, 3.76),
    (-CAR_HALF_W * 0.62, 4.06),
    (-CAR_HALF_W * 0.28, CAR_ROOF),
    (CAR_HALF_W * 0.28, CAR_ROOF),
    (CAR_HALF_W * 0.62, 4.06),
    (CAR_HALF_W * 0.88, 3.76),
    (CAR_HALF_W * 0.985, 3.36),
    (CAR_HALF_W, 2.92),
    (CAR_HALF_W, CAR_FLOOR),
]


def car_segment_color(index: int):
    if index in (4, 5, 6):
        return shade(ROOF_DARK, 0.92)
    if index == 11:
        return UNDERBODY
    if index in (0, 10):
        return ER9_BLUE
    return ER9_LIGHT


def commuter_body(builder: MeshBuilder, cab_front: bool = False) -> None:
    builder.loft(
        CAR_PROFILE,
        [
            {"x": -CAR_LENGTH / 2, "scale_y": 0.94, "scale_z": 0.98},
            {"x": -CAR_LENGTH / 2 + 0.42},
            {"x": CAR_LENGTH / 2 - 0.42},
            {"x": CAR_LENGTH / 2, "scale_y": 0.94, "scale_z": 0.98},
        ],
        car_segment_color,
        ER9_LIGHT,
    )
    # ER9M: long dark window band on a light-grey upper body, orange stripe
    # above the blue lower body.
    pillars = [-10.2, -8.9, -7.6, -5.9, -4.6, -3.3, -2.0, -0.7, 0.6, 1.9,
               3.2, 4.5, 5.8, 7.5, 8.8, 10.1]
    for side in (-1, 1):
        glass_band(builder, -10.8, 10.8, 2.18, 3.16, side, CAR_HALF_W, pillars, GLASS, ER9_LIGHT)
        side_panel(builder, -11.8, 11.8, 2.06, 2.20, side, CAR_HALF_W, ER9_ORANGE)
        for x in (-6.9, 6.9):
            door(builder, x, 1.55, side, CAR_HALF_W, 0.86, 3.18, 0.98, GLASS, ER9_BLUE)
    # Underframe, gangways and buffers at both ends; the cab end is built by
    # `build_commuter_lead` and skips the gangway.
    builder.box((0.0, 0.0, 0.72), (CAR_LENGTH - 2.2, 2.55, 0.42), UNDERBODY)
    for direction in (1, -1):
        if cab_front and direction > 0:
            continue
        x = direction * CAR_LENGTH / 2
        builder.box((x + direction * 0.02, 0.0, 2.35), (0.14, 1.65, 2.05), BOARD_DARK)
        builder.box((x + direction * 0.06, 0.0, 1.05), (0.20, 1.20, 0.24), BOGIE)
        for side in (-1, 1):
            builder.box((x + direction * 0.12, side * 1.12, 1.02), (0.30, 0.28, 0.30), BUFFER)
    # Roof equipment.
    for x in (-7.8, 7.8):
        builder.box((x, 0.0, CAR_ROOF + 0.09), (2.4, 1.35, 0.18), ROOF_DARK)
    # Bogies.
    for x in (-8.7, 8.7):
        builder.box((x, 0.0, 0.50), (3.05, 2.35, 0.46), BOGIE)
        for axle in (-1.05, 1.05):
            for side in (-1, 1):
                builder.wheel(x + axle, side * 1.18, 0.46, 0.24, 6, hub=False)


def commuter_pantograph(builder: MeshBuilder, x: float) -> None:
    builder.box((x, 0.0, CAR_ROOF + 0.09), (1.45, 1.30, 0.17), POLE_SHOE)
    builder.box((x, 0.0, CAR_ROOF + 0.23), (0.55, 0.85, 0.18), POLE)
    builder.beam(
        (x - 0.45, 0.0, CAR_ROOF + 0.31),
        (x + 0.65, 0.0, 5.15),
        0.065,
        0.065,
        POLE,
    )
    builder.beam(
        (x + 0.65, 0.0, 5.15),
        (x - 0.45, 0.0, 5.34),
        0.055,
        0.055,
        POLE,
    )
    builder.box((x, 0.0, 5.37), (0.10, 1.55, 0.07), POLE)


def build_commuter_lead() -> MeshBuilder:
    builder = MeshBuilder("commuterLead")
    commuter_body(builder, cab_front=True)
    front = CAR_LENGTH / 2
    # Blue cab face, two slanted windshields and orange ER9M stripes.
    front_panel(builder, front, -1.45, 1.45, 1.02, 2.92, ER9_BLUE)
    for side in (-1, 1):
        y0, y1 = side * 0.06, side * 1.36
        builder.quad(
            (front + 0.02, y0, 2.30),
            (front + 0.02, y1, 2.30),
            (front + 0.02, y1, 3.50),
            (front + 0.02, y0, 3.50),
            GLASS,
            (1, 0, 0),
        )
        builder.beam(
            (front - 0.02, side * 0.18, 2.34),
            (front - 0.02, side * 0.95, 3.00),
            0.03,
            0.03,
            RUBBER,
        )
        headlight(builder, front, side * 1.10, 1.45, 1, 0.085, 0.12, HEADLIGHT, ER9_BLUE)
    front_panel(builder, front, -1.42, 1.42, 2.10, 2.26, ER9_ORANGE)
    front_panel(builder, front, -1.30, 1.30, 1.16, 1.31, ER9_ORANGE)
    front_panel(builder, front, -0.82, 0.82, 0.72, 1.16, ER9_RED)
    # Headlight above the windshields and the small destination board.
    builder.cylinder("x", (front + 0.02, 0.0, 3.70), 0.17, 0.05, 8, HEADLIGHT, HEADLIGHT)
    builder.box((front + 0.04, 0.0, 3.90), (0.08, 1.15, 0.16), BOARD_DARK)
    for side in (-1, 1):
        builder.box((front + 0.04, side * 1.18, 3.60), (0.08, 0.12, 0.10), TAILLIGHT)
    # Buffer beam, buffers, coupler and plow.
    builder.box((front + 0.02, 0.0, 0.66), (0.18, 2.85, 0.30), SKIRT)
    builder.box((front + 0.20, 0.0, 0.58), (0.44, 0.36, 0.32), BOGIE)
    builder.box((front + 0.05, 0.0, 0.92), (0.24, 1.35, 0.22), BOGIE)
    return builder


def build_commuter_car() -> MeshBuilder:
    builder = MeshBuilder("commuterCar")
    commuter_body(builder)
    commuter_pantograph(builder, 1.8)
    return builder


# ---------------------------------------------------------------------------
# freight locomotive and gondola
# ---------------------------------------------------------------------------
LOCO_LENGTH = 19.0
LOCO_HALF_W = 1.55
LOCO_FLOOR = 1.10
LOCO_ROOF = 4.05


def build_freight_loco() -> MeshBuilder:
    builder = MeshBuilder("freightLoco")
    # VL80S-style twin-cab electric locomotive: dark green body, light green
    # side stripe, red front band, grey roof and a central pantograph.
    builder.box((0.0, 0.0, 1.02), (LOCO_LENGTH - 1.2, 2.70, 0.42), UNDERBODY)
    builder.box(
        (0.0, 0.0, 2.52),
        (11.6, 2.86, 2.20),
        LOCO_GREEN,
        {"top": 1.0, "bottom": 0.6, "front": 0.95, "back": 0.95, "left": 0.9, "right": 0.9},
    )
    builder.box((0.0, 0.0, 3.72), (11.9, 2.94, 0.22), ROOF_DARK)
    for side in (-1, 1):
        for x in (-4.6, -2.3, 0.0, 2.3, 4.6):
            side_panel(builder, x - 0.85, x + 0.85, 2.30, 2.86, side, LOCO_HALF_W, shade(LOCO_GREEN, 0.60))
        side_panel(builder, -5.6, 5.6, 1.95, 2.15, side, LOCO_HALF_W, LOCO_LIGHT)
    for direction in (1, -1):
        x = direction * 7.75
        builder.box((x, 0.0, 2.62), (2.5, 2.95, 2.85), LOCO_GREEN)
        for side in (-1, 1):
            y0, y1 = side * 0.05, side * 1.12
            x_outer = x + direction * 1.27
            builder.quad(
                (x_outer + direction * 0.02, y0, 2.30),
                (x_outer + direction * 0.02, y1, 2.30),
                (x_outer + direction * 0.02, y1, 3.30),
                (x_outer + direction * 0.02, y0, 3.30),
                GLASS,
                (direction, 0, 0),
            )
            side_panel(builder, x - 0.75, x + 0.65, 2.35, 3.20, side, 1.475, GLASS)
            headlight(builder, x_outer, side * 1.02, 1.42, direction, 0.085, 0.12, HEADLIGHT, LOCO_GREEN)
            headlight(builder, x_outer, side * 0.68, 1.20, direction, 0.06, 0.09, TURN, LOCO_GREEN)
        # Red band across the cab face.
        front_panel(builder, x + direction * 1.27, -1.40, 1.40, 1.08, 1.38, LOCO_RED, direction=direction, inset=0.01)
        # Grey cab roof plate.
        builder.box((x, 0.0, 4.12), (2.55, 2.95, 0.10), ROOF_DARK)
        x_outer = x + direction * 1.28
        builder.quad(
            (x_outer, -0.95, 3.44),
            (x_outer, 0.95, 3.44),
            (x_outer, 0.95, 3.68),
            (x_outer, -0.95, 3.68),
            BOARD_DARK,
            (direction, 0, 0),
        )
        builder.box((x + direction * 1.35, 0.0, 0.82), (0.28, 2.85, 0.34), BOGIE)
        for side in (-1, 1):
            builder.box((x + direction * 1.52, side * 1.18, 1.02), (0.32, 0.30, 0.34), BUFFER)
        builder.box((x + direction * 1.55, 0.0, 0.62), (0.52, 0.38, 0.34), BOGIE)
        builder.box((x + direction * 1.22, 0.0, 0.45), (0.34, 2.20, 0.24), SKIRT)
    # Simplified central pantograph.
    panto_x = 0.0
    builder.box((panto_x, 0.0, LOCO_ROOF + 0.10), (1.45, 1.30, 0.18), POLE_SHOE)
    builder.box((panto_x, 0.0, LOCO_ROOF + 0.24), (0.55, 0.85, 0.18), POLE)
    builder.beam(
        (panto_x - 0.48, 0.0, LOCO_ROOF + 0.33),
        (panto_x + 0.72, 0.0, 4.98),
        0.065,
        0.065,
        POLE,
    )
    builder.beam(
        (panto_x + 0.72, 0.0, 4.98),
        (panto_x - 0.50, 0.0, 5.16),
        0.055,
        0.055,
        POLE,
    )
    builder.box((panto_x, 0.0, 5.19), (0.10, 1.55, 0.07), POLE)
    for x in (-4.1, -2.4, 2.4, 4.1):
        builder.box((x, 0.0, LOCO_ROOF + 0.10), (0.85, 1.10, 0.14), ROOF_DARK)
    # Handrails near the cabs.
    for direction in (1, -1):
        for side in (-1, 1):
            x = direction * 7.75
            builder.beam(
                (x + direction * 1.34, side * 1.30, 0.90),
                (x + direction * 1.34, side * 1.30, 2.60),
                0.05,
                0.05,
                HANDRAIL,
            )
    for x in (-5.6, 5.6):
        builder.box((x, 0.0, 0.50), (3.35, 2.55, 0.48), BOGIE)
        for axle in (-1.15, 1.15):
            for side in (-1, 1):
                builder.wheel(x + axle, side * 1.28, 0.52, 0.26, 6, hub=False)
    return builder


def build_freight_wagon() -> MeshBuilder:
    builder = MeshBuilder("freightWagon")
    length = 14.5
    half = length / 2
    # Weathered brown gondola with a black coal load.
    builder.box((0.0, 0.0, 1.02), (length - 0.8, 2.70, 0.34), UNDERBODY)
    builder.box((0.0, 0.0, 1.22), (length - 0.4, 2.95, 0.14), shade(WAGON_BROWN, 0.82))
    builder.box(
        (0.0, 0.0, 2.26),
        (length - 1.0, 2.98, 1.90),
        WAGON_BROWN,
        {"top": 0.72, "bottom": 0.8, "front": 0.94, "back": 0.94, "left": 0.9, "right": 0.9},
    )
    builder.quad(
        (-half + 0.7, -1.24, 3.16),
        (half - 0.7, -1.24, 3.16),
        (half - 0.7, 1.24, 3.16),
        (-half + 0.7, 1.24, 3.16),
        WAGON_COAL,
        (0, 0, 1),
    )
    # Visible coal load: the top face of the body is replaced by a black quad.
    builder.quad(
        (-half + 0.8, -1.22, 3.225),
        (half - 0.8, -1.22, 3.225),
        (half - 0.8, 1.22, 3.225),
        (-half + 0.8, 1.22, 3.225),
        WAGON_COAL,
        (0, 0, 1),
    )
    for side in (-1, 1):
        for index in range(9):
            x = -half + 1.35 + index * 1.45
            builder.box((x, side * 1.53, 2.26), (0.16, 0.14, 1.80), WAGON_RIB)
        side_panel(builder, half - 1.50, half - 1.22, 1.35, 3.05, side, 1.54, HANDRAIL)
        for z in (1.55, 1.95, 2.35, 2.75):
            builder.box((half - 1.05, side * 1.55, z), (0.30, 0.10, 0.05), HANDRAIL)
        builder.cylinder(
            "y",
            (-half + 1.85, side * 1.58, 3.18),
            0.20,
            0.05,
            6,
            HANDRAIL,
            shade(HANDRAIL, 1.1),
        )
    for direction in (1, -1):
        x = direction * (half - 0.45)
        builder.box((x, 0.0, 3.08), (0.14, 3.02, 0.16), shade(WAGON_BROWN, 1.08))
        builder.box((x + direction * 0.24, 0.0, 0.74), (0.30, 1.20, 0.28), BOGIE)
        for side in (-1, 1):
            builder.box((x + direction * 0.34, side * 1.10, 0.98), (0.30, 0.28, 0.30), BUFFER)
    for side in (-1, 1):
        builder.box((0.0, side * 1.49, 3.15), (length - 1.0, 0.16, 0.14), shade(WAGON_BROWN, 1.1))
    for x in (-5.1, 5.1):
        builder.box((x, 0.0, 0.48), (2.85, 2.55, 0.44), BOGIE)
        for axle in (-0.96, 0.96):
            for side in (-1, 1):
                builder.wheel(x + axle, side * 1.28, 0.46, 0.24, 6, hub=False)
    return builder


# ---------------------------------------------------------------------------
# Blender scene / export
# ---------------------------------------------------------------------------
MODEL_BUILDERS = [
    ("bus", build_bus, 1100),
    ("trolleybus", build_trolleybus, 1250),
    ("tram", build_tram, 900),
    ("commuterLead", build_commuter_lead, 900),
    ("commuterCar", build_commuter_car, 780),
    ("freightLoco", build_freight_loco, 1200),
    ("freightWagon", build_freight_wagon, 900),
]

EXPECTED_BOUNDS = {
    "bus": (12.25, 3.10, 3.55),
    "trolleybus": (12.25, 3.10, 4.80),
    "tram": (15.65, 2.60, 5.00),
    "commuterLead": (25.20, 3.60, 4.45),
    "commuterCar": (25.20, 3.60, 5.45),
    "freightLoco": (19.15, 3.15, 5.25),
    "freightWagon": (14.60, 3.30, 3.40),
}


def make_material() -> bpy.types.Material:
    material = bpy.data.materials.new("TransportVertexColour")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get("Principled BSDF")
    attribute = nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "Col"
    links.new(attribute.outputs["Color"], principled.inputs["Base Color"])
    principled.inputs["Roughness"].default_value = 0.72
    principled.inputs["Metallic"].default_value = 0.05
    return material


def create_object(builder: MeshBuilder, material: bpy.types.Material):
    mesh = bpy.data.meshes.new(f"{builder.name}-mesh")
    mesh.from_pydata(builder.vertices, [], builder.faces)
    mesh.update()
    attribute = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    for index, color in enumerate(builder.colors):
        attribute.data[index].color = (
            srgb_to_linear(color[0]),
            srgb_to_linear(color[1]),
            srgb_to_linear(color[2]),
            1.0,
        )
    mesh.materials.append(material)
    obj = bpy.data.objects.new(builder.name, mesh)
    bpy.context.collection.objects.link(obj)
    obj["transportModel"] = builder.name
    return obj


def mesh_triangles(obj) -> list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]:
    """Read back evaluated triangles and per-corner linear colours from Blender."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    mesh.calc_loop_triangles()
    attribute = mesh.color_attributes.get("Col")
    if attribute is None:
        raise RuntimeError(f"{obj.name}: missing Col colour attribute")
    triangles = []
    for tri in mesh.loop_triangles:
        corners = []
        color = None
        for loop_index in tri.loops:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            corners.append((float(vertex.x), float(vertex.y), float(vertex.z)))
            if color is None:
                color = tuple(float(value) for value in attribute.data[loop_index].color[:3])
        triangles.append((corners[0], corners[1], corners[2], color))
    evaluated.to_mesh_clear()
    return triangles


def measure(triangles):
    xs = [point[0] for tri in triangles for point in tri[:3]]
    ys = [point[1] for tri in triangles for point in tri[:3]]
    zs = [point[2] for tri in triangles for point in tri[:3]]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def pack_payload(objects, manifest_path: str, binary_path: str) -> dict:
    all_positions: list[int] = []
    all_colors: list[int] = []
    models: dict[str, dict] = {}
    for name, obj in objects.items():
        triangles = mesh_triangles(obj)
        low, high = measure(triangles)
        vertex_start = len(all_positions) // 3
        for a, b, c, color in triangles:
            # Blender stores linear colours; convert back to authored sRGB bytes.
            srgb = []
            for channel in color:
                value = max(0.0, min(1.0, channel))
                srgb.append(
                    round(
                        255
                        * (
                            12.92 * value
                            if value <= 0.0031308
                            else 1.055 * (value ** (1 / 2.4)) - 0.055
                        )
                    )
                )
            for point in (a, b, c):
                # Blender (x, y, z) -> runtime (x, z, -y), centimetres.
                x = round(point[0] * POSITION_SCALE)
                y = round(point[2] * POSITION_SCALE)
                z = round(-point[1] * POSITION_SCALE)
                if not (-32768 <= x <= 32767 and -32768 <= y <= 32767 and -32768 <= z <= 32767):
                    raise RuntimeError(f"{name}: coordinate outside int16 range: {(x, y, z)}")
                all_positions.extend((x, y, z))
                all_colors.extend(srgb)
        vertex_count = len(triangles) * 3
        models[name] = {
            "vertexStart": vertex_start,
            "vertexCount": vertex_count,
            "triangles": len(triangles),
            "positionStart": vertex_start,
            "colorStart": vertex_start,
            "bounds": {
                "min": [round(low[0], 4), round(low[2], 4), round(-high[1], 4)],
                "max": [round(high[0], 4), round(high[2], 4), round(-low[1], 4)],
            },
            "lengthM": round(high[0] - low[0], 4),
            "widthM": round(high[1] - low[1], 4),
            "heightM": round(high[2] - low[2], 4),
        }
    total_vertices = len(all_positions) // 3
    positions = struct.pack(f"<{len(all_positions)}h", *all_positions)
    colors = bytes(all_colors)
    with open(binary_path, "wb") as handle:
        handle.write(positions)
        handle.write(colors)
    manifest = {
        "version": PAYLOAD_VERSION,
        "generatedAt": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": "scripts/models/build_transport_models.py",
        "source": "procedural low-poly transport templates authored in Blender 5.1",
        "positionScale": POSITION_SCALE,
        "colorSpace": "srgb",
        "axis": "runtime: +X forward, +Y up, +Z right",
        "vertexCount": total_vertices,
        "positionBytes": len(positions),
        "colorBytes": len(colors),
        "byteLength": len(positions) + len(colors),
        "models": models,
    }
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return manifest


def recenter_x(builder: MeshBuilder) -> None:
    """Shift the triangle soup so the X bounds are exactly centred on zero."""
    xs = [vertex[0] for vertex in builder.vertices]
    offset = -(min(xs) + max(xs)) * 0.5
    if abs(offset) > 1e-9:
        builder.vertices = [(x + offset, y, z) for x, y, z in builder.vertices]


def validate(name: str, triangles, budget: int, expected) -> None:
    low, high = measure(triangles)
    if os.environ.get("TRANSPORT_DEBUG"):
        widest = max((point for tri in triangles for point in tri[:3]), key=lambda p: abs(p[1]))
        print(f"[debug] {name} widest {widest}")
    count = len(triangles)
    if count < 120:
        raise RuntimeError(f"{name}: too coarse ({count} triangles)")
    if count > budget:
        raise RuntimeError(f"{name}: {count} triangles exceeds budget {budget}")
    length = high[0] - low[0]
    width = high[1] - low[1]
    height = high[2] - low[2]
    exp_length, exp_width, exp_height = expected
    if abs(length - exp_length) > 0.35:
        raise RuntimeError(f"{name}: length {length:.3f} != expected {exp_length}")
    if abs(width - exp_width) > 0.35:
        raise RuntimeError(f"{name}: width {width:.3f} != expected {exp_width}")
    if abs(height - exp_height) > 0.60:
        raise RuntimeError(f"{name}: height {height:.3f} != expected {exp_height}")
    if abs(low[2]) > 0.02:
        raise RuntimeError(f"{name}: wheel contact must be z=0, got {low[2]:.3f}")
    if abs(high[0] + low[0]) > 0.12:
        raise RuntimeError(f"{name}: model must be centred on X, got {low[0]:.3f}..{high[0]:.3f}")
    print(
        f"[model] {name:14s} {count:5d} tris  "
        f"L{length:5.2f} W{width:4.2f} H{height:4.2f}  z0={low[2]:.3f}"
    )


# ---------------------------------------------------------------------------
# preview render
# ---------------------------------------------------------------------------
def setup_preview_scene() -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 760
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (0.82, 0.81, 0.77, 1.0)
    background.inputs[1].default_value = 0.55

    ground_material = bpy.data.materials.new("PreviewGround")
    ground_material.use_nodes = True
    principled = ground_material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (0.62, 0.61, 0.57, 1.0)
    principled.inputs["Roughness"].default_value = 0.9
    bpy.ops.mesh.primitive_plane_add(size=140, location=(0, 0, 0))
    ground = bpy.context.object
    ground.name = "PreviewGround"
    ground.data.materials.append(ground_material)

    light_data = bpy.data.lights.new("Sun", type="SUN")
    light_data.energy = 3.2
    light_data.angle = math.radians(8)
    light = bpy.data.objects.new("Sun", light_data)
    bpy.context.collection.objects.link(light)
    light.rotation_euler = (math.radians(52), 0, math.radians(-38))

    fill_data = bpy.data.lights.new("Fill", type="AREA")
    fill_data.energy = 1200
    fill_data.size = 18
    fill = bpy.data.objects.new("Fill", fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (-18, 24, 16)
    fill.rotation_euler = (math.radians(55), 0, math.radians(150))

    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera


FRONT_PREVIEW_MODELS = {"bus", "trolleybus", "tram", "commuterLead", "freightLoco"}


def render_model_preview(obj, path: str, all_objects, front: bool = False) -> None:
    scene = bpy.context.scene
    for other in all_objects:
        other.hide_render = other is not obj
    low, high = measure(mesh_triangles(obj))
    center = Vector(
        (
            (low[0] + high[0]) * 0.5,
            (low[1] + high[1]) * 0.5,
            (low[2] + high[2]) * 0.5,
        )
    )
    length = high[0] - low[0]
    width = high[1] - low[1]
    height = high[2] - low[2]
    camera = scene.camera
    if front:
        direction = Vector((1.0, -0.30, 0.22)).normalized()
        camera.location = center + direction * (max(width, height) * 4.0)
        camera.data.ortho_scale = max(width * 2.6, height * 3.4, 7.0)
    else:
        direction = Vector((1.0, -1.55, 0.78)).normalized()
        camera.location = center + direction * (max(length, height) * 2.2)
        camera.data.ortho_scale = max(length * 1.30, height * 3.8, 8.0)
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"[preview] {os.path.basename(path)}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--glb", action="store_true")
    parser.add_argument("--no-blend", action="store_true")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(ASSET_DIR, exist_ok=True)
    os.makedirs(GLB_DIR, exist_ok=True)
    os.makedirs(PAYLOAD_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    material = make_material()
    objects = {}
    builders = {}
    for name, factory, budget in MODEL_BUILDERS:
        builder = factory()
        recenter_x(builder)
        builders[name] = builder
        obj = create_object(builder, material)
        objects[name] = obj
        validate(name, mesh_triangles(obj), budget, EXPECTED_BOUNDS[name])

    manifest_path = os.path.join(PAYLOAD_DIR, "manifest.json")
    binary_path = os.path.join(PAYLOAD_DIR, "vehicles.bin")
    manifest = pack_payload(objects, manifest_path, binary_path)
    print(
        f"[payload] {manifest['vertexCount']} vertices, "
        f"{manifest['byteLength'] / 1024:.1f} KiB -> {binary_path}"
    )

    if not args.no_blend:
        blend_path = os.path.join(ASSET_DIR, "transport.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend_path)
        print(f"[blend] {blend_path}")

    if args.glb:
        for name, obj in objects.items():
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            path = os.path.join(GLB_DIR, f"{name}.glb")
            try:
                bpy.ops.export_scene.gltf(
                    filepath=path,
                    export_format="GLB",
                    use_selection=True,
                    export_apply=True,
                )
                print(f"[glb] {path}")
            except Exception as error:  # pragma: no cover - Blender version dependent
                print(f"[glb] skipped {name}: {error}", file=sys.stderr)

    if args.render:
        setup_preview_scene()
        model_objects = list(objects.values())
        for name, obj in objects.items():
            render_model_preview(obj, os.path.join(PREVIEW_DIR, f"{name}.png"), model_objects)
            if name in FRONT_PREVIEW_MODELS:
                render_model_preview(
                    obj,
                    os.path.join(PREVIEW_DIR, f"{name}-front.png"),
                    model_objects,
                    front=True,
                )


if __name__ == "__main__":
    main()
