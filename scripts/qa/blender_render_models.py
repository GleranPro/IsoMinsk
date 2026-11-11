"""Render 3/4-view thumbnails of the decimated museum models (Cycles CPU).

Loads every `decimated/<slug>/<slug>.glb`, joins the meshes, frames the model
with an orthographic 3/4 camera and renders a transparent PNG into
`assets/aviation-museum/renders/<slug>.png`. CPU rendering only, so it does not
compete with GPU work.

Usage:
    blender.exe --background --factory-startup --python scripts/qa/blender_render_models.py -- \
        --dir assets/aviation-museum/decimated --out assets/aviation-museum/renders
"""

from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--samples", type=int, default=16)
    parser.add_argument("--resolution", type=int, default=560)
    parser.add_argument("--only", default=None, help="comma-separated slugs")
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)


def setup_render(scene, samples: int, resolution: int) -> None:
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = resolution
    scene.render.resolution_y = int(resolution * 0.75)
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs[0].default_value = (0.35, 0.38, 0.42, 1.0)
    background.inputs[1].default_value = 0.7
    scene.world = world

    sun_data = bpy.data.lights.new("KeySun", type="SUN")
    sun_data.energy = 4.0
    sun_data.angle = math.radians(15)
    sun = bpy.data.objects.new("KeySun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(52), math.radians(8), math.radians(35))

    fill_data = bpy.data.lights.new("Fill", type="AREA")
    fill_data.energy = 350.0
    fill_data.size = 8.0
    fill = bpy.data.objects.new("Fill", fill_data)
    scene.collection.objects.link(fill)
    fill.location = (6.0, 6.0, 5.0)
    fill.rotation_euler = (math.radians(55), 0.0, math.radians(135))


def robust_bounds(obj) -> tuple[Vector, Vector, Vector]:
    """Percentile bounds: some source models carry far interior geometry that
    inflates the bounding box (e.g. An-26 with a full interior), which made the
    aircraft microscopic in the frame. 2-98th percentile per axis frames the
    visible airframe instead."""
    world = obj.matrix_world
    xs: list[float] = []
    ys: list[float] = []
    zs: list[float] = []
    for vertex in obj.data.vertices:
        point = world @ vertex.co
        xs.append(point.x)
        ys.append(point.y)
        zs.append(point.z)
    xs.sort()
    ys.sort()
    zs.sort()

    def band(values: list[float]) -> tuple[float, float]:
        lo = values[int(len(values) * 0.02)]
        hi = values[int(len(values) * 0.98)]
        return lo, hi

    x0, x1 = band(xs)
    y0, y1 = band(ys)
    z0, z1 = band(zs)
    minimum = Vector((x0, y0, z0))
    maximum = Vector((x1, y1, z1))
    return minimum, maximum, (minimum + maximum) / 2.0


def frame_model(scene, obj) -> None:
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    minimum, maximum, center = robust_bounds(obj)
    size = maximum - minimum
    max_dim = max(size.x, size.y, size.z, 0.1)

    camera_data = bpy.data.cameras.get("MuseumCam") or bpy.data.cameras.new("MuseumCam")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max_dim * 1.35
    camera = bpy.data.objects.get("MuseumCam")
    if camera is None:
        camera = bpy.data.objects.new("MuseumCam", camera_data)
        scene.collection.objects.link(camera)
    scene.camera = camera

    direction = Vector((0.9, -1.0, 0.55)).normalized()
    distance = max_dim * 4.0
    camera.location = center + direction * distance
    camera_data.clip_start = max(0.05, distance / 1000.0)
    camera_data.clip_end = max(1000.0, distance * 4.0)
    look = center - camera.location
    camera.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    root = os.path.abspath(args.dir)
    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    only = {slug.strip() for slug in args.only.split(",")} if args.only else None

    scene = bpy.context.scene
    setup_render(scene, args.samples, args.resolution)

    slugs = sorted(
        name
        for name in os.listdir(root)
        if os.path.isdir(os.path.join(root, name)) and (only is None or name in only)
    )
    for index, slug in enumerate(slugs, start=1):
        model = os.path.join(root, slug, f"{slug}.glb")
        if not os.path.exists(model):
            print(f"[skip] {slug}: {model} missing", file=sys.stderr)
            continue
        clear_scene()
        setup_render(scene, args.samples, args.resolution)
        bpy.ops.import_scene.gltf(filepath=model)
        meshes = [obj for obj in scene.objects if obj.type == "MESH"]
        if not meshes:
            print(f"[skip] {slug}: no meshes", file=sys.stderr)
            continue
        if len(meshes) > 1:
            bpy.ops.object.select_all(action="DESELECT")
            for mesh in meshes:
                mesh.select_set(True)
            bpy.context.view_layer.objects.active = meshes[0]
            bpy.ops.object.join()
        obj = next(o for o in scene.objects if o.type == "MESH")
        frame_model(scene, obj)
        scene.render.filepath = os.path.join(out_dir, f"{slug}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[render] {index}/{len(slugs)} {slug}", flush=True)


if __name__ == "__main__":
    main()
