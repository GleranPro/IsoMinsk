"""Decimate an aircraft model copy with Blender (headless).

Input: one FBX/GLB/GLTF/BLEND file. Output: a decimated GLB copy with a target
triangle budget. The raw download is never modified: this script always writes
to the requested output path (by convention under `decimated/<type>/`).

Usage (from the repo root):
    blender.exe --background --python scripts/qa/blender_decimate.py -- \
        --in assets/aviation-museum/raw/an-2/an2.fbx \
        --out assets/aviation-museum/decimated/an-2/an-2.glb \
        --target 2000

The museum collection uses 1500-4000 triangles per aircraft: recognizable
silhouette at map scale while keeping the whole open-air exhibit cheap.
"""

from __future__ import annotations

import argparse
import os
import sys

import bpy


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="source", required=True)
    parser.add_argument("--out", dest="target_path", required=True)
    parser.add_argument("--target", type=int, default=2500)
    parser.add_argument("--join", action="store_true", default=True)
    return parser.parse_args(argv)


def triangle_count(obj) -> int:
    mesh = obj.data
    return sum(len(poly.vertices) - 2 for poly in mesh.polygons)


def import_source(path: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    extension = os.path.splitext(path)[1].lower()
    if extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif extension in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=path)
    elif extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        raise SystemExit(f"unsupported input format: {extension}")


def main() -> None:
    args = parse_args()
    import_source(os.path.abspath(args.source))

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh objects imported")

    before = sum(triangle_count(obj) for obj in meshes)

    # Join everything into one object so the exhibit is a single draw call.
    if len(meshes) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    # The glTF importer may leave an empty/camera as the active object; pick a
    # real mesh explicitly instead of trusting the context after import.
    obj = next(
        (candidate for candidate in bpy.context.scene.objects if candidate.type == "MESH"),
        None,
    )
    if obj is None:
        raise SystemExit("no mesh object in the imported scene")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    triangles = triangle_count(obj)
    if triangles <= args.target:
        ratio = 1.0
    else:
        ratio = args.target / triangles
        modifier = obj.modifiers.new(name="Decimate", type="DECIMATE")
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    after = triangle_count(obj)
    os.makedirs(os.path.dirname(os.path.abspath(args.target_path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.target_path),
        export_format="GLB",
        export_apply=True,
    )
    size = os.path.getsize(args.target_path)
    print(
        f"[decimate] {os.path.basename(args.source)}: {before} -> {after} tris "
        f"(ratio {ratio:.3f}), glb {size / 1e6:.2f} MB -> {args.target_path}"
    )


if __name__ == "__main__":
    main()
