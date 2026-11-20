# -*- coding: utf-8 -*-
"""Build the War Museum Li-2 exhibit model (Blender 5.x, headless).

The real aircraft is Lisunov Li-2 c/n 33444309, displayed on the round pad
north-west of the Belarusian State Museum of the History of the Great
Patriotic War (OSM way 384806738; w127103385 is the museum building).

Sources used:
  * Sketchfab "Li 2" by 3Ddesmark (CC-BY-4.0) - raw/scene.gltf;
  * Wikimedia Commons photos of this exact c/n (olive upper, light-blue
    underside, red star on the fin).

The script joins the downloaded model, normalises it to nose +X, pitches the
airframe into the parked tail-dragger stance (main wheels and tail wheel on
z=0), decimates, paints the exhibit livery into a corner colour attribute,
adds the fin star and a dark cabin liner (the source has open window holes),
then writes baked/li-2.json in the museum payload format plus verification
renders.

Run:
  blender -b --factory-startup --python scripts/war-museum/build_li2.py -- \
      assets/war-museum/raw/li-2/scene.gltf assets/war-museum 25000
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
INFILE, ASSET_DIR = argv[0], os.path.abspath(argv[1])
TARGET_TRIS = int(argv[2]) if len(argv) > 2 else 25000
OUT_DIR = os.path.join(ASSET_DIR, "baked")
RENDER_DIR = os.path.join(ASSET_DIR, "renders")
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(RENDER_DIR, exist_ok=True)


def srgb(hex_value: str) -> tuple[float, float, float]:
    h = hex_value.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def to_srgb(value: float) -> float:
    return value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1.0 / 2.4) - 0.055


# Palette sampled from the Commons photos of c/n 33444309.
OLIVE = srgb("#6A6A48")   # faded olive drab
CAMO = srgb("#4C5236")    # darker green blotches
UNDER = srgb("#8FB4C4")   # light-blue underside
GLASS = srgb("#22303A")
BLACK = srgb("#202124")
YELLOW = srgb("#D8B93A")
STAR_RED = srgb("#B23A2E")
STAR_WHITE = srgb("#E6E1D3")
LINER = srgb("#1A2228")

PAINT_SPECS = {
    "paint_prop": BLACK,
    "paint_glass": GLASS,
    "paint_tire": BLACK,
    "paint_liner": LINER,
    "paint_star_white": STAR_WHITE,
    "paint_star_red": STAR_RED,
}


def make_paint_materials() -> dict[str, bpy.types.Material]:
    materials = {}
    for name, color in PAINT_SPECS.items():
        material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        material.diffuse_color = (*color, 1.0)
        material.use_nodes = True
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (*color, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.85
        materials[name] = material
    return materials


def assign_material(obj, material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for poly in obj.data.polygons:
        poly.material_index = 0


def box_of(obj):
    points = [obj.matrix_world @ v.co for v in obj.data.vertices]
    mn = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    mx = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return mn, mx, (mn + mx) / 2, mx - mn


def tag_source_parts(objects, materials) -> None:
    """Give propellers, cockpit glazing and tyres their own paint materials.

    This is far more reliable than guessing from face normals after joining:
    the source parts are separate glTF nodes with distinctive bounds.
    """
    for obj in objects:
        mn, mx, center, size = box_of(obj)
        name = None
        # Four flat blades around the two engine nacelles.
        if size.y < 0.08 and size.z > 0.8 and abs(center.y + 6.98) < 0.6 and 2.4 < abs(center.x) < 4.8:
            name = "paint_prop"
        # The segmented cockpit windshield panels at the nose.
        elif size.y < 0.06 and abs(center.y + 8.57) < 0.35 and center.z > 5.3 and abs(center.x) < 1.3:
            name = "paint_glass"
        # Main wheels and their hubs (axle height ~2.5 m in source space).
        elif center.z < 3.1 and abs(center.y + 4.14) < 0.5 and abs(center.x) > 2.3 and size.x < 0.6:
            name = "paint_tire"
        if name:
            assign_material(obj, materials[name])


def load_and_normalise(path: str, materials):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    tag_source_parts(meshes, materials)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = "Li2"

    # Bake the world matrix into the mesh, then normalise in plain Python.
    bpy.context.view_layer.update()
    mesh = obj.data
    world = obj.matrix_world.copy()
    for vertex in mesh.vertices:
        vertex.co = world @ vertex.co
    obj.parent = None
    obj.matrix_world = Matrix.Identity(4)
    mesh.update()

    # Source fuselage runs along Y, nose at -Y. Rotate +90 deg about Z so the
    # nose points +X (museum payload convention).
    rotate = Matrix.Rotation(math.radians(90.0), 4, "Z")
    for vertex in mesh.vertices:
        vertex.co = rotate @ vertex.co
    mesh.update()

    zs = [v.co.z for v in mesh.vertices]
    zmin, zmax = min(zs), max(zs)
    fin = [v.co.x for v in mesh.vertices if v.co.z > zmin + (zmax - zmin) * 0.88]
    if fin and sum(fin) / len(fin) > 0:  # the fin belongs to the tail
        flip = Matrix.Rotation(math.radians(180.0), 4, "Z")
        for vertex in mesh.vertices:
            vertex.co = flip @ vertex.co
        mesh.update()

    xs = [v.co.x for v in mesh.vertices]
    scale = 19.65 / (max(xs) - min(xs))  # real Li-2 length
    for vertex in mesh.vertices:
        vertex.co *= scale
    mesh.update()

    zmin = min(v.co.z for v in mesh.vertices)  # main wheels touch the ground
    for vertex in mesh.vertices:
        vertex.co.z -= zmin
    mesh.update()
    return obj


def apply_parked_stance(obj) -> None:
    """Pitch the level source model into the real Li-2's tail-low stance.

    The Sketchfab airframe is modelled level, so only the main wheels reach the
    ground and the tail wheel hangs ~2.5 m up. Rotate the whole mesh (fin star
    decals included) nose-up about the main-gear contact line until the tail
    wheel reaches the same plane, then drop every wheel onto z=0. The Li-2
    rests at roughly 12 degrees nose-up.
    """
    mesh = obj.data
    zmin = min(v.co.z for v in mesh.vertices)
    main_contact_x = [v.co.x for v in mesh.vertices if v.co.z < zmin + 0.03]
    main_x = sum(main_contact_x) / len(main_contact_x)
    xmin = min(v.co.x for v in mesh.vertices)
    xmax = max(v.co.x for v in mesh.vertices)
    tail_zone = [
        vertex for vertex in mesh.vertices
        if vertex.co.x < xmin + (xmax - xmin) * 0.25 and abs(vertex.co.y) < 0.6
    ]
    if not tail_zone:
        return
    # Main-gear tyres (the only low geometry away from the centreline).
    main_zone = [
        vertex for vertex in mesh.vertices
        if vertex.co.x > main_x - 1.2 and abs(vertex.co.y) > 1.5 and vertex.co.z < 2.0
    ]
    tail_z = min(v.co.z for v in tail_zone)
    tail_low_x = [v.co.x for v in tail_zone if v.co.z < tail_z + 0.03]
    tail_x = sum(tail_low_x) / len(tail_low_x)
    arm = main_x - tail_x
    if arm > 0.5 and tail_z > zmin + 0.02:
        pitch = -math.asin(min(1.0, (tail_z - zmin) / arm))
        pivot = Vector((main_x, 0.0, zmin))
        rotate_y = Matrix.Rotation(pitch, 4, "Y")
        for vertex in mesh.vertices:
            vertex.co = rotate_y @ (vertex.co - pivot) + pivot
        mesh.update()

    # The tyre arcs make a single asin pass leave one pair a few centimetres
    # high; equalise the two contact heights before the final drop.
    if main_zone:
        for _ in range(3):
            zmin = min(v.co.z for v in mesh.vertices)
            main_min = min(v.co.z for v in main_zone)
            tail_min = min(v.co.z for v in tail_zone)
            if abs(main_min - tail_min) < 0.005:
                break
            delta = math.atan2(main_min - tail_min, arm)
            pivot = Vector((main_x, 0.0, zmin))
            rotate_y = Matrix.Rotation(delta, 4, "Y")
            for vertex in mesh.vertices:
                vertex.co = rotate_y @ (vertex.co - pivot) + pivot
            mesh.update()
            zmin = min(v.co.z for v in mesh.vertices)
            for vertex in mesh.vertices:
                vertex.co.z -= zmin
            mesh.update()

    zmin = min(v.co.z for v in mesh.vertices)  # every wheel touches the ground
    for vertex in mesh.vertices:
        vertex.co.z -= zmin
    mesh.update()


def triangle_count(obj) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate(obj, target: int) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    mod = obj.modifiers.new("triangulate", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=mod.name)
    current = triangle_count(obj)
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = min(1.0, target / max(current, 1))
    bpy.ops.object.modifier_apply(modifier=mod.name)


def skin_point(obj, x, z, sign, offset=0.02, fallback=1.12):
    """Project (x, z) onto the near fuselage/fin skin and lift it by offset."""
    direction = Vector((0.0, -sign, 0.0))
    for dx, dz in ((0.0, 0.0), (0.0, 0.06), (0.0, -0.06), (0.06, 0.0), (-0.06, 0.0)):
        hit, location, normal, index = obj.ray_cast(
            Vector((x + dx, 6.0 * sign, z + dz)), direction
        )
        if hit and location.y * sign > 0.02:
            return Vector((x, location.y + offset * sign, z))
    return Vector((x, fallback * sign, z))


def add_star(obj, bm, x0, z0, radius, material_index, sign, offset):
    points = []
    for i in range(10):
        angle = math.radians(90.0 + i * 36.0)
        r = radius if i % 2 == 0 else radius * 0.42
        points.append(skin_point(obj, x0 + r * math.cos(angle), z0 + r * math.sin(angle), sign, offset, fallback=0.18))
    center = bm.verts.new(skin_point(obj, x0, z0, sign, offset, fallback=0.18))
    verts = [bm.verts.new(p) for p in points]
    for i in range(10):
        try:
            face = bm.faces.new((center, verts[i], verts[(i + 1) % 10]))
        except ValueError:
            continue
        face.normal_update()
        if face.normal.y * sign < 0:
            face.normal_flip()
        face.material_index = material_index


def add_rect(bm, points, material_index, sign):
    verts = [bm.verts.new(p) for p in points]
    try:
        face = bm.faces.new(verts)
    except ValueError:
        return
    face.normal_update()
    if face.normal.y * sign < 0:
        face.normal_flip()
    face.material_index = material_index


def make_extras(obj, materials):
    """Cabin liner and fin stars as separate geometry."""
    extra = bpy.data.objects.new("Li2Extras", bpy.data.meshes.new("Li2Extras"))
    bpy.context.scene.collection.objects.link(extra)
    slot_order = ["paint_liner", "paint_star_white", "paint_star_red"]
    for name in slot_order:
        extra.data.materials.append(materials[name])
    index = {name: i for i, name in enumerate(slot_order)}

    bm = bmesh.new()

    # Fin stars (white outline + red fill), wrapped onto the fin skin.
    star_x, star_z = -8.05, 6.02
    for sign in (1.0, -1.0):
        add_star(obj, bm, star_x, star_z, 0.62, index["paint_star_white"], sign, 0.018)
        add_star(obj, bm, star_x, star_z, 0.50, index["paint_star_red"], sign, 0.024)

    bm.to_mesh(extra.data)
    bm.free()
    extra.data.update()

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    extra.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def paint(mesh, materials_indices):
    """Keep the model's detailed source paint, override the exhibit livery.

    The Sketchfab model already carries a 16-colour camo/panel paint in its
    COLOR_0 attribute: it is much richer than anything we could repaint at this
    triangle budget. We keep it for the airframe, windows and cockpit, and only
    replace what the real c/n 33444309 shows differently: light-blue underside,
    black tyres, black props with yellow tips, plus the fin star decals.
    """
    special = {name: color for name, color in PAINT_SPECS.items()}
    source = mesh.color_attributes.get("Color")

    # Centroids of the tagged propeller blades: yellow tips are faces far from
    # the hub. Blades are symmetric around the hub, so their mean is the hub.
    hubs = {}
    for poly in mesh.polygons:
        material = mesh.materials[poly.material_index].name
        if material == "paint_prop":
            side = 1 if poly.center.y > 0 else -1
            hubs.setdefault(side, []).append(poly.center.copy())
    hubs = {side: sum(points, Vector()) / len(points) for side, points in hubs.items() if points}

    colors = []
    for poly in mesh.polygons:
        material = mesh.materials[poly.material_index].name
        if material in special:
            color = special[material]
            if material == "paint_prop":
                hub = hubs.get(1 if poly.center.y > 0 else -1)
                if hub is not None and (poly.center - hub).length > 1.15:
                    color = YELLOW
            colors.append(color)
            continue

        c, n = poly.center, poly.normal
        if source is not None:
            linear = source.data[poly.loop_indices[0]].color
            color = tuple(to_srgb(max(0.0, min(1.0, v))) for v in linear[:3])
        else:
            color = OLIVE

        if c.z < 0.95:
            color = BLACK
        elif (abs(c.y) > 2.0 and n.z < -0.45) or (c.z < 2.55 and n.z < 0.25):
            color = UNDER
        colors.append(color)

    attr = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    for poly in mesh.polygons:
        r, g, b = colors[poly.index]
        for loop in poly.loop_indices:
            attr.data[loop].color = (to_linear(r), to_linear(g), to_linear(b), 1.0)
    try:
        mesh.color_attributes.active_color = attr
        mesh.color_attributes.render_color_index = mesh.color_attributes.find("Col")
    except Exception as error:  # pragma: no cover - Blender API drift
        print("could not make Col active:", error)
    return colors


def export_payload(mesh, colors) -> dict:
    positions, out_colors = [], []
    for tri in mesh.loop_triangles:
        r, g, b = colors[tri.polygon_index]
        for vertex_index in tri.vertices:
            v = mesh.vertices[vertex_index].co
            positions.extend([round(v.x, 3), round(v.y, 3), round(v.z, 3)])
            out_colors.extend([round(r * 255), round(g * 255), round(b * 255)])
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]
    payload = {
        "slug": "li-2",
        "lengthM": round(max(xs) - min(xs), 2),
        "spanM": round(max(ys) - min(ys), 2),
        "heightM": round(max(zs), 2),
        "triangles": len(mesh.loop_triangles),
        "noseAxis": "+X",
        "positions": positions,
        "colors": out_colors,
        "indices": list(range(len(positions) // 3)),
    }
    path = os.path.join(OUT_DIR, "li-2.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    print(f"wrote {path}: {payload['triangles']} tris, span {payload['spanM']} m")
    return payload


def look_at(camera, location, target, up):
    forward = (target - location).normalized()
    right = up.cross(forward).normalized()
    true_up = forward.cross(right)
    camera.matrix_world = Matrix(
        (
            (right.x, true_up.x, -forward.x, location.x),
            (right.y, true_up.y, -forward.y, location.y),
            (right.z, true_up.z, -forward.z, location.z),
            (0.0, 0.0, 0.0, 1.0),
        )
    )


def render(obj) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.studio_light = "paint.sl"
    shading.color_type = "VERTEX"
    shading.show_shadows = True
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    shading.show_specular_highlight = False
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 900
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
    cam.data.ortho_scale = size * 1.15

    def shot(label, direction, up):
        direction = Vector(direction).normalized()
        look_at(cam, center + direction * size * 4, center, Vector(up))
        scene.render.filepath = os.path.join(RENDER_DIR, f"li2_{label}.png")
        bpy.ops.render.render(write_still=True)

    shot("side", (0, 1, 0), (0, 0, 1))
    shot("front", (1, 0, 0), (0, 0, 1))
    shot("rear", (-1, 0, 0), (0, 0, 1))
    shot("top", (0, 0, 1), (1, 0, 0))
    shot("iso", (1, 1, 0.8), (0, 0, 1))

    shading.light = "FLAT"
    shading.show_shadows = False
    shading.show_cavity = False
    shot("flat_side", (0, 1, 0), (0, 0, 1))
    shot("flat_iso", (1, 1, 0.8), (0, 0, 1))


def main() -> None:
    materials = make_paint_materials()
    obj = load_and_normalise(INFILE, materials)
    decimate(obj, TARGET_TRIS)
    obj = make_extras(obj, materials)
    # Livery first: the underside/tyre classification thresholds are defined on
    # the level airframe. Painting after the pitch would shift the olive/blue
    # border and make it ragged.
    mesh = obj.data
    mesh.calc_loop_triangles()
    colors = paint(mesh, materials)
    apply_parked_stance(obj)
    mesh = obj.data
    mesh.calc_loop_triangles()
    export_payload(mesh, colors)
    render(obj)
    blend_path = os.path.join(ASSET_DIR, "source", "li-2.blend")
    os.makedirs(os.path.dirname(blend_path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    print(f"saved {blend_path}")


if __name__ == "__main__":
    main()
