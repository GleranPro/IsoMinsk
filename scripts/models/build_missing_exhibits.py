# -*- coding: utf-8 -*-
"""Build the four Lipki exhibit types that have no downloadable CC model.

Yak-25M, Ka-26, PZL-104 Wilga 35A and L-13 Blanik are modelled procedurally
from the reference photos in `assets/aviation-museum/references/<slug>/`.
The output is `assets/aviation-museum/baked/<slug>.json` in the same format as
the decimated Sketchfab models (nose +X, metres, z up, per-triangle colours).
Nothing is added to `placement.json` or the web payload: the models are staged
only, as requested.

Run:
  blender -b --factory-startup --python scripts/models/build_missing_exhibits.py -- all
  blender -b --factory-startup --python scripts/models/build_missing_exhibits.py -- yak-25
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ASSETS = os.path.join(ROOT, "assets", "aviation-museum")
OUT_DIR = os.path.join(ASSETS, "baked")
RENDER_DIR = os.path.join(ASSETS, "analysis", "missing")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(RENDER_DIR, exist_ok=True)


def srgb(hex_value: str) -> tuple[float, float, float]:
    h = hex_value.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


# Shared palette (sRGB).
SILVER = srgb("#C2C6CA")
SILVER_DARK = srgb("#92989D")
RED = srgb("#B23A2E")
GLASS = srgb("#263640")
BLACK = srgb("#1B1D1F")
YELLOW = srgb("#D8B93A")
GREY = srgb("#7A8085")
WHITE = srgb("#DCDDD8")
BLUE = srgb("#2E5E8A")
OLIVE = srgb("#4E5538")
OLIVE_DARK = srgb("#3B422B")
BLUE_LIGHT = srgb("#7FA6B8")


class MeshBuilder:
    """Small triangle soup builder with per-face colours."""

    def __init__(self) -> None:
        self.verts: list[tuple[float, float, float]] = []
        self.tris: list[tuple[int, int, int]] = []
        self.colors: list[tuple[float, float, float]] = []

    # -- primitives ---------------------------------------------------------
    def v(self, point) -> int:
        self.verts.append((float(point[0]), float(point[1]), float(point[2])))
        return len(self.verts) - 1

    def tri(self, a, b, c, color) -> None:
        self.tris.append((a, b, c))
        self.colors.append(color)

    def quad(self, a, b, c, d, color) -> None:
        self.tri(a, b, c, color)
        self.tri(a, c, d, color)

    def poly(self, points, color) -> None:
        self.poly_idx([self.v(p) for p in points], color)

    def poly_idx(self, idx, color) -> None:
        for i in range(1, len(idx) - 1):
            self.tri(idx[0], idx[i], idx[i + 1], color)

    def box(self, x0, x1, y0, y1, z0, z1, color) -> None:
        p = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ]
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        for face in f:
            self.quad(*[self.v(p[i]) for i in face], color)

    def loft(self, sections, color, segments=14, cap_start=True, cap_end=True) -> None:
        """sections: [(x, cy, cz, ry, rz), ...] rings in the YZ plane."""
        rings = []
        for x, cy, cz, ry, rz in sections:
            ring = []
            for i in range(segments):
                angle = 2.0 * math.pi * i / segments
                ring.append(self.v((x, cy + ry * math.cos(angle), cz + rz * math.sin(angle))))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for i in range(segments):
                j = (i + 1) % segments
                self.quad(a[i], a[j], b[j], b[i], color)
        if cap_start:
            x, cy, cz, _, _ = sections[0]
            c = self.v((x, cy, cz))
            for i in range(segments):
                j = (i + 1) % segments
                self.tri(c, rings[0][j], rings[0][i], color)
        if cap_end:
            x, cy, cz, _, _ = sections[-1]
            c = self.v((x, cy, cz))
            for i in range(segments):
                j = (i + 1) % segments
                self.tri(c, rings[-1][i], rings[-1][j], color)

    def slab(self, plan_xy, z_points, thickness, color) -> None:
        """Closed plate: plan polygon (x, y) extruded by thickness around z_points."""
        top, bottom = [], []
        for (x, y), z in zip(plan_xy, z_points):
            top.append(self.v((x, y, z + thickness / 2)))
            bottom.append(self.v((x, y, z - thickness / 2)))
        self.poly_idx(top, color)
        self.poly_idx(list(reversed(bottom)), color)
        n = len(plan_xy)
        for i in range(n):
            j = (i + 1) % n
            self.quad(bottom[i], bottom[j], top[j], top[i], color)

    def tube_x(self, x0, x1, cy, cz, radius, color, segments=12, cap=True) -> None:
        self.loft(
            [(x0, cy, cz, radius, radius), (x1, cy, cz, radius, radius)],
            color,
            segments=segments,
            cap_start=cap,
            cap_end=cap,
        )

    def disc_y(self, x, y, z, radius, width, color, segments=12) -> None:
        """Wheel: short cylinder with its axis along Y."""
        left, right = [], []
        for i in range(segments):
            angle = 2.0 * math.pi * i / segments
            left.append(self.v((x + radius * math.cos(angle), y - width / 2, z + radius * math.sin(angle))))
            right.append(self.v((x + radius * math.cos(angle), y + width / 2, z + radius * math.sin(angle))))
        for i in range(segments):
            j = (i + 1) % segments
            self.quad(left[i], left[j], right[j], right[i], color)
        self.poly_idx(left, color)
        self.poly_idx(list(reversed(right)), color)

    def plate_xz(self, points_xz, y_half, color) -> None:
        """Closed plate in the XZ plane (fins, struts) with thickness in Y."""
        left = [self.v((x, -y_half, z)) for x, z in points_xz]
        right = [self.v((x, y_half, z)) for x, z in points_xz]
        self.poly_idx(left, color)
        self.poly_idx(list(reversed(right)), color)
        n = len(points_xz)
        for i in range(n):
            j = (i + 1) % n
            self.quad(left[i], left[j], right[j], right[i], color)

    # -- Blender / files ----------------------------------------------------
    def to_object(self, name: str):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.verts, [], self.tris)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)

        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()

        attr = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
        for poly, color in zip(mesh.polygons, self.colors):
            linear = tuple(to_linear(max(0.0, min(1.0, v))) for v in color)
            for loop in poly.loop_indices:
                attr.data[loop].color = (*linear, 1.0)
        mesh.color_attributes.active_color = attr
        try:
            mesh.color_attributes.render_color_index = mesh.color_attributes.find("Col")
        except Exception:
            pass
        return obj

    def export(self, slug: str, length: float, span: float) -> dict:
        positions, colors = [], []
        for tri, color in zip(self.tris, self.colors):
            for index in tri:
                positions.extend(round(value, 3) for value in self.verts[index])
                colors.extend(round(value * 255.0) for value in color)
        zs = [v[2] for v in self.verts]
        payload = {
            "slug": slug,
            "lengthM": round(length, 2),
            "spanM": round(span, 2),
            "heightM": round(max(zs), 2),
            "triangles": len(self.tris),
            "noseAxis": "+X",
            "positions": positions,
            "colors": colors,
            "indices": list(range(len(positions) // 3)),
        }
        path = os.path.join(OUT_DIR, f"{slug}.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        print(f"wrote {path}: {len(self.tris)} tris")
        return payload


# --------------------------------------------------------------------------- Yak-25M
def build_yak25() -> MeshBuilder:
    m = MeshBuilder()
    # Fuselage: pointed radar nose, slim barrel, tapered tail.
    m.loft(
        [
            (7.85, 0.0, 0.55, 0.03, 0.03),
            (7.35, 0.0, 0.48, 0.24, 0.26),
            (6.55, 0.0, 0.40, 0.48, 0.52),
            (5.55, 0.0, 0.32, 0.66, 0.70),
            (4.30, 0.0, 0.28, 0.78, 0.82),
            (2.70, 0.0, 0.26, 0.84, 0.88),
            (0.00, 0.0, 0.26, 0.84, 0.88),
            (-2.60, 0.0, 0.30, 0.78, 0.82),
            (-4.70, 0.0, 0.40, 0.60, 0.66),
            (-6.30, 0.0, 0.58, 0.36, 0.44),
            (-7.30, 0.0, 0.76, 0.14, 0.20),
            (-7.80, 0.0, 0.88, 0.02, 0.02),
        ],
        SILVER,
    )
    # Swept mid wing, 45 degrees.
    for sign in (1.0, -1.0):
        root_le, root_te = 2.35, -1.65
        tip_le, tip_te = -2.35, -3.55
        plan = [
            (root_le, 0.80 * sign),
            (root_te, 0.80 * sign),
            (tip_te, 5.48 * sign),
            (tip_le, 5.48 * sign),
        ]
        m.slab(plan, [0.16, 0.10, 0.28, 0.34], 0.24 if False else 0.22, SILVER)
    # Engine pods integrated at the wing roots.
    for sign in (1.0, -1.0):
        m.loft(
            [
                (2.55, 1.28 * sign, 0.02, 0.18, 0.18),
                (2.10, 1.30 * sign, 0.02, 0.50, 0.50),
                (0.40, 1.30 * sign, 0.02, 0.56, 0.56),
                (-1.60, 1.30 * sign, 0.02, 0.55, 0.55),
                (-2.60, 1.30 * sign, 0.04, 0.44, 0.44),
                (-2.95, 1.30 * sign, 0.06, 0.30, 0.30),
            ],
            SILVER,
            segments=12,
        )
        # Dark intake and exhaust faces (X-axis discs).
        m.tube_x(2.54, 2.58, 1.30 * sign, 0.02, 0.19, BLACK, segments=12)
        m.tube_x(-2.98, -2.94, 1.30 * sign, 0.06, 0.29, BLACK, segments=12)
    # Tail fin and stabilizer.
    m.plate_xz([(-6.05, 0.95), (-7.70, 0.95), (-7.95, 3.25), (-7.05, 3.25)], 0.09, SILVER)
    for sign in (1.0, -1.0):
        plan = [(-6.80, 0.0), (-7.75, 0.0), (-8.00, 3.10 * sign), (-7.15, 3.10 * sign)]
        m.slab(plan, [1.05, 1.05, 1.10, 1.10], 0.10, SILVER)
    # Canopy.
    m.loft(
        [
            (3.60, 0.0, 1.06, 0.05, 0.04),
            (4.30, 0.0, 1.10, 0.34, 0.18),
            (5.20, 0.0, 1.10, 0.40, 0.22),
            (5.95, 0.0, 1.04, 0.30, 0.16),
            (6.30, 0.0, 0.96, 0.05, 0.03),
        ],
        GLASS,
        segments=10,
    )
    # Bicycle gear: nose and main units, plus wingtip outriggers.
    m.disc_y(5.35, 0.0, -0.95, 0.34, 0.20, BLACK)
    m.box(5.20, 5.50, -0.10, 0.10, -0.65, 0.10, SILVER_DARK)
    for y in (-0.34, 0.34):
        m.disc_y(-1.25, y, -0.95, 0.38, 0.22, BLACK)
    m.box(-1.50, -1.00, -0.55, 0.55, -0.60, 0.12, SILVER_DARK)
    for sign in (1.0, -1.0):
        m.disc_y(0.95, 4.95 * sign, -0.30, 0.18, 0.12, BLACK)
        m.box(0.85, 1.05, 0.80 * sign, 5.10 * sign, -0.35, 0.10, SILVER_DARK)
    # Red "20" on both sides of the forward fuselage (blocky).
    for sign in (1.0, -1.0):
        y = 0.70 * sign
        m.box(5.05, 5.55, y, y + 0.03 * sign, 0.05, 0.95, RED)
        m.box(5.55, 5.95, y, y + 0.03 * sign, 0.55, 0.95, RED)
        m.box(5.55, 5.95, y, y + 0.03 * sign, 0.15, 0.55, RED)
    return m


BUILDERS = {
    "yak-25": (build_yak25, 15.67, 10.96),
}


def clear_scene() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def render_views(obj, slug: str) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.studio_light = "paint.sl"
    shading.color_type = "VERTEX"
    shading.show_shadows = True
    shading.show_cavity = True
    try:
        shading.show_backface_culling = False
    except Exception:
        pass
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 760
    scene.world.color = (0.22, 0.22, 0.22)

    bbox = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mn = Vector((min(v.x for v in bbox), min(v.y for v in bbox), min(v.z for v in bbox)))
    mx = Vector((max(v.x for v in bbox), max(v.y for v in bbox), max(v.z for v in bbox)))
    center = (mn + mx) / 2
    size = max((mx - mn).x, (mx - mn).y, (mx - mn).z)

    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = size * 1.18
    out = os.path.join(RENDER_DIR, slug)
    os.makedirs(out, exist_ok=True)

    def look_at(location, up):
        forward = (center - location).normalized()
        right = up.cross(forward).normalized()
        true_up = forward.cross(right)
        cam.matrix_world = (
            (right.x, true_up.x, -forward.x, location.x),
            (right.y, true_up.y, -forward.y, location.y),
            (right.z, true_up.z, -forward.z, location.z),
            (0.0, 0.0, 0.0, 1.0),
        )

    for label, direction, up in (
        ("side", (0, 1, 0), (0, 0, 1)),
        ("front", (1, 0, 0), (0, 0, 1)),
        ("top", (0, 0, 1), (1, 0, 0)),
        ("iso", (1, 1, 0.8), (0, 0, 1)),
    ):
        look_at(center + Vector(direction).normalized() * size * 4, Vector(up))
        scene.render.filepath = os.path.join(out, f"{label}.png")
        bpy.ops.render.render(write_still=True)


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["all"]
    wanted = list(BUILDERS) if argv[0] == "all" else argv
    for slug in wanted:
        builder, length, span = BUILDERS[slug]
        clear_scene()
        mesh = builder()
        obj = mesh.to_object(slug)
        mesh.export(slug, length, span)
        render_views(obj, slug)
        print("built", slug)


if __name__ == "__main__":
    main()
