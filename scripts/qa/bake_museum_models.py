"""Bake decimated aircraft models into compact coloured triangle meshes.

Output: `assets/aviation-museum/baked/<slug>.json` with:
  positions  - flat metres, fuselage along +X, origin at ground/horizontal centre
  colors     - flat sRGB 0-255 per vertex (one mean colour per material)
  indices    - triangle indices

The bake is offline only: the map payload carries the resulting triangles, so the
runtime needs no glTF loader or textures for the museum exhibits.
"""

import bpy
import json
import math
import os
import sys

import numpy as np
from mathutils import Vector

ROOT = os.path.abspath("assets/aviation-museum")
DECIMATED = os.path.join(ROOT, "decimated")
OUT = os.path.join(ROOT, "baked")
os.makedirs(OUT, exist_ok=True)

# Real length / wingspan (metres) used to normalise the downloaded models.
SPECS = {
    "an-2": (12.4, 18.2),
    "an-26": (23.8, 29.2),
    "il-18": (35.9, 37.4),
    "l-29": (10.6, 10.3),
    "mig-15": (10.1, 10.1),
    "mig-17": (11.3, 9.6),
    "mig-19": (12.6, 9.0),
    "mig-21": (15.8, 7.2),
    "mig-23": (16.7, 7.8),
    "mig-25": (23.8, 14.0),
    "mig-27": (17.1, 7.8),
    "mig-29": (17.3, 11.4),
    "su-17": (18.7, 10.0),
    "su-24": (22.5, 17.6),
    "su-25": (15.5, 14.4),
    "tu-134": (37.1, 29.0),
    "yak-18": (8.6, 10.6),
    "yak-28": (20.0, 12.5),
    "yak-40": (20.4, 25.0),
    "mi-1": (12.1, 14.3),
    "mi-2": (11.4, 14.6),
    "mi-8": (18.2, 21.3),
    "mi-24": (17.5, 17.3),
    "mi-26": (40.0, 32.0),
    "citation-x": (22.0, 19.4),
}


def material_color(material) -> tuple[int, int, int]:
    """Mean sRGB colour of a material's base texture (or base colour)."""
    if material is None or not material.use_nodes:
        return (180, 180, 180)
    base = None
    texture = None
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            input_socket = node.inputs.get("Base Color")
            if input_socket is None:
                continue
            if input_socket.is_linked:
                source = input_socket.links[0].from_node
                if source.type == "TEX_IMAGE" and source.image is not None:
                    texture = source.image
                elif source.type == "MIX":
                    for leaf in source.inputs:
                        if leaf.is_linked:
                            candidate = leaf.links[0].from_node
                            if candidate.type == "TEX_IMAGE" and candidate.image is not None:
                                texture = candidate.image
                                break
            else:
                base = tuple(input_socket.default_value)
            break
    if texture is not None:
        try:
            pixels = np.array(texture.pixels[:], dtype=np.float32).reshape(-1, 4)
            mean = pixels[:, :3].mean(axis=0) if len(pixels) else (0.5, 0.5, 0.5)
            return tuple(int(max(0, min(255, round(channel * 255)))) for channel in mean)
        except Exception:  # noqa: BLE001
            pass
    if base is not None:
        return tuple(int(max(0, min(255, round(channel * 255)))) for channel in base[:3])
    return (180, 180, 180)


def bake(slug: str) -> dict:
    path = os.path.join(DECIMATED, slug, f"{slug}.glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)

    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if len(meshes) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for mesh in meshes:
            mesh.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Triangulate so the baked index buffer is unambiguous.
    triangulate = obj.modifiers.new("Triangulate", type="TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=triangulate.name)

    vertices = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    xs = [v.x for v in vertices]
    ys = [v.y for v in vertices]
    zs = [v.z for v in vertices]
    size_x = max(xs) - min(xs)
    size_y = max(ys) - min(ys)
    size_z = max(zs) - min(zs)

    length, span = SPECS[slug]
    # Decide which horizontal model axis is the fuselage: compare the model's
    # aspect ratio with both real spec ratios.
    error_xy = abs((size_x / max(size_y, 1e-6)) - (length / span))
    error_yx = abs((size_y / max(size_x, 1e-6)) - (length / span))
    fuselage_is_x = error_xy <= error_yx
    fuselage_size = size_x if fuselage_is_x else size_y
    scale = length / max(fuselage_size, 1e-6)

    angle = 0.0 if fuselage_is_x else math.pi / 2.0
    rotation = math.cos(angle), math.sin(angle)

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    center_x, center_y = (min_x + max_x) / 2, (min_y + max_y) / 2

    def transform(point: Vector) -> tuple[float, float, float]:
        x = (point.x - center_x) * scale
        y = (point.y - center_y) * scale
        # Rotate so the fuselage points along +X.
        rx = x * rotation[0] + y * rotation[1]
        ry = -x * rotation[1] + y * rotation[0]
        z = (point.z - min(zs)) * scale
        return round(rx, 2), round(ry, 2), round(z, 2)

    colors = [material_color(slot.material) for slot in obj.material_slots]
    positions: list[float] = []
    colors_out: list[int] = []
    indices: list[int] = []
    for polygon in obj.data.polygons:
        material_index = polygon.material_index
        color = colors[material_index] if material_index < len(colors) else (180, 180, 180)
        base = len(positions) // 3
        for loop_index in polygon.loop_indices:
            vertex_index = obj.data.loops[loop_index].vertex_index
            positions.extend(transform(vertices[vertex_index]))
            colors_out.extend(color)
        for offset in range(1, len(polygon.loop_indices) - 1):
            indices.extend((base, base + offset, base + offset + 1))

    return {
        "slug": slug,
        "lengthM": length,
        "spanM": span,
        "heightM": round(size_z * scale, 2),
        "triangles": len(indices) // 3,
        "positions": positions,
        "colors": colors_out,
        "indices": indices,
    }


def main() -> None:
    slugs = [name for name in sorted(os.listdir(DECIMATED)) if os.path.isdir(os.path.join(DECIMATED, name))]
    for slug in slugs:
        if slug not in SPECS:
            print(f"[skip] {slug}: no specs")
            continue
        data = bake(slug)
        out_path = os.path.join(OUT, f"{slug}.json")
        with open(out_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"))
        print(f"[bake] {slug}: {data['triangles']} tris, {os.path.getsize(out_path) // 1024} KiB")


main()
