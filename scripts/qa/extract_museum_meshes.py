# -*- coding: utf-8 -*-
"""Dump museum GLB geometry to npz for offline re-baking.

Run with Blender:
    blender.exe --background --factory-startup --python scripts/qa/extract_museum_meshes.py

Each decimated model is joined, transform-applied, triangulated and written to
`data/interim/museum_meshes/<slug>.npz` with float32 positions, uint8 colours
and int32 triangle indices in Blender world space (metres, Z up).
"""
import os

import bpy
import numpy as np

ROOT = os.path.abspath("assets/aviation-museum")
DECIMATED = os.path.join(ROOT, "decimated")
OUT = os.path.abspath("data/interim/museum_meshes")
os.makedirs(OUT, exist_ok=True)


def material_color(material):
    """Mean sRGB colour of a material's base texture (or base colour)."""
    if material is None or not material.use_nodes:
        return (180, 180, 180)
    base = None
    texture = None
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            socket = node.inputs.get("Base Color")
            if socket is None:
                continue
            if socket.is_linked:
                source = socket.links[0].from_node
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
                base = tuple(socket.default_value)
            break
    if texture is not None:
        try:
            pixels = np.array(texture.pixels[:], dtype=np.float32).reshape(-1, 4)
            mean = pixels[:, :3].mean(axis=0) if len(pixels) else (0.5, 0.5, 0.5)
            return tuple(int(max(0, min(255, round(c * 255)))) for c in mean)
        except Exception:  # noqa: BLE001
            pass
    if base is not None:
        return tuple(int(max(0, min(255, round(c * 255)))) for c in base[:3])
    return (180, 180, 180)


def load_joined(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        return None
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
    triangulate = obj.modifiers.new("Triangulate", type="TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=triangulate.name)
    return obj


def main():
    slugs = sorted(d for d in os.listdir(DECIMATED) if os.path.isdir(os.path.join(DECIMATED, d)))
    for slug in slugs:
        glb = os.path.join(DECIMATED, slug, f"{slug}.glb")
        if not os.path.exists(glb):
            print(f"[skip] {slug}: no glb")
            continue
        obj = load_joined(glb)
        if obj is None:
            print(f"[skip] {slug}: no mesh")
            continue
        colours = [material_color(slot.material) for slot in obj.material_slots]
        positions = []
        colors = []
        indices = []
        matrix = obj.matrix_world
        for polygon in obj.data.polygons:
            colour = colours[polygon.material_index] if polygon.material_index < len(colours) else (180, 180, 180)
            base = len(positions) // 3
            for loop_index in polygon.loop_indices:
                vertex_index = obj.data.loops[loop_index].vertex_index
                co = matrix @ obj.data.vertices[vertex_index].co
                positions.extend((co.x, co.y, co.z))
                colors.extend(colour)
            for offset in range(1, len(polygon.loop_indices) - 1):
                indices.extend((base, base + offset, base + offset + 1))
        arr_pos = np.asarray(positions, dtype=np.float32)
        arr_col = np.asarray(colors, dtype=np.uint8)
        arr_idx = np.asarray(indices, dtype=np.int32)
        np.savez_compressed(
            os.path.join(OUT, f"{slug}.npz"),
            positions=arr_pos,
            colors=arr_col,
            indices=arr_idx,
        )
        print(f"[dump] {slug}: {len(arr_idx)//3} tris, {len(arr_pos)//3} verts")


main()
