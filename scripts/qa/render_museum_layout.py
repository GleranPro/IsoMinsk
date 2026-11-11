"""Preview render of the museum layout from the baked exhibit meshes.

Reads `assets/aviation-museum/placement.json` + `baked/<slug>.json`, builds one
coloured mesh for all exhibits, adds a ground plate and a hangar block for
orientation, and renders a top-down and a 3/4 view (Cycles CPU).

Usage:
    blender.exe --background --factory-startup --python scripts/qa/render_museum_layout.py
"""

import json
import math
import os

import bpy
from mathutils import Vector

ROOT = os.path.abspath("assets/aviation-museum")
PLACEMENT = os.path.join(ROOT, "placement.json")
BAKED = os.path.join(ROOT, "baked")
OUT_DIR = os.path.join(ROOT, "renders")
os.makedirs(OUT_DIR, exist_ok=True)


def load_models() -> dict:
    models = {}
    for name in os.listdir(BAKED):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(BAKED, name), encoding="utf-8") as handle:
            models[name[:-5]] = json.load(handle)
    return models


def build_exhibit_mesh(models: dict) -> None:
    with open(PLACEMENT, encoding="utf-8") as handle:
        placement = json.load(handle)

    vertices: list[tuple[float, float, float]] = []
    colors: list[tuple[float, float, float, float]] = []
    faces: list[tuple[int, int, int]] = []

    for exhibit in placement["exhibits"]:
        model = models.get(exhibit["slug"])
        if model is None:
            continue
        heading = math.radians(exhibit["heading"])
        cos_h, sin_h = math.cos(heading), math.sin(heading)
        base = len(vertices)
        positions = model["positions"]
        vertex_colors = model["colors"]
        for index in range(0, len(positions), 3):
            lx, ly, lz = positions[index], positions[index + 1], positions[index + 2]
            wx = lx * cos_h - ly * sin_h + exhibit["x"]
            wy = lx * sin_h + ly * cos_h + exhibit["y"]
            vertices.append((wx, wy, lz))
            r, g, b = vertex_colors[index], vertex_colors[index + 1], vertex_colors[index + 2]
            colors.append((r / 255.0, g / 255.0, b / 255.0, 1.0))
        for index in model["indices"]:
            faces.append((base + index, base + index + 1, base + index + 2)) if False else None
        # indices are flat triples
        indices = model["indices"]
        for offset in range(0, len(indices), 3):
            faces.append((base + indices[offset], base + indices[offset + 1], base + indices[offset + 2]))

    mesh = bpy.data.meshes.new("MuseumExhibits")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    attribute = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    for index, color in enumerate(colors):
        attribute.data[index].color = color

    material = bpy.data.materials.new("MuseumVertexColour")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    attribute_node = nodes.new("ShaderNodeVertexColor")
    attribute_node.layer_name = "Col"
    material.node_tree.links.new(attribute_node.outputs["Color"], principled.inputs["Base Color"])
    principled.inputs["Roughness"].default_value = 0.7
    mesh.materials.append(material)

    obj = bpy.data.objects.new("MuseumExhibits", mesh)
    bpy.context.scene.collection.objects.link(obj)


def ground_and_hangar() -> None:
    ground_mesh = bpy.data.meshes.new("Ground")
    ground_mesh.from_pydata(
        [(9150, 420, -0.05), (9420, 420, -0.05), (9420, 880, -0.05), (9150, 880, -0.05)],
        [],
        [(0, 1, 2, 3)],
    )
    ground_mesh.materials.append(_flat_material("GroundMat", (0.36, 0.37, 0.36)))
    ground = bpy.data.objects.new("Ground", ground_mesh)
    bpy.context.scene.collection.objects.link(ground)

    # The exhibition hangar north of the open-air rows, as a simple block.
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(9342, 821, 4.0))
    hangar = bpy.context.active_object
    hangar.scale = (34.0, 18.0, 8.0)
    hangar.data.materials.append(_flat_material("HangarMat", (0.55, 0.56, 0.55)))


def _flat_material(name: str, color: tuple[float, float, float]):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*color, 1.0)
    principled.inputs["Roughness"].default_value = 0.9
    return material


def setup_scene() -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.6, 0.68, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world

    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 3.5
    sun = bpy.data.objects.new("Sun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))


def render_view(name: str, location, rotation, scale, resolution=(1700, 1200)) -> None:
    scene = bpy.context.scene
    camera_data = bpy.data.cameras.new(name)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = scale
    camera = bpy.data.objects.new(name, camera_data)
    scene.collection.objects.link(camera)
    camera.location = location
    camera.rotation_euler = rotation
    scene.camera = camera
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.filepath = os.path.join(OUT_DIR, name)
    bpy.ops.render.render(write_still=True)
    print(f"[layout] wrote {name}")


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_scene()
    models = load_models()
    build_exhibit_mesh(models)
    ground_and_hangar()

    center = (9285.0, 650.0)
    # Top-down plan view.
    render_view(
        "museum-layout-top.png",
        (center[0], center[1], 400.0),
        (0.0, 0.0, 0.0),
        560.0,
    )
    # Three-quarter view, similar to the map camera.
    render_view(
        "museum-layout-3d.png",
        (center[0] + 300.0, center[1] - 300.0, 260.0),
        (math.radians(55), 0.0, math.radians(45)),
        560.0,
    )


main()
