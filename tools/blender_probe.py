# SPDX-License-Identifier: MIT
"""Headless Blender probe: can the agent actually drive Blender end to end?

Run as:  blender.exe --background --python this_file.py

Builds a real (non-trivial) mesh, exports it, and renders a preview so the
result can be looked at rather than trusted. Everything is guarded so one
missing exporter does not hide the rest of the report.
"""
import os
import sys
import traceback

import bpy

OUT = r"C:\SSP\E\dcc-test"
os.makedirs(OUT, exist_ok=True)

report = []
report.append(f"BLENDER {bpy.app.version_string}")
report.append(f"PYTHON {sys.version.split()[0]}")


def attempt(label, fn):
    try:
        fn()
        report.append(f"OK   {label}")
        return True
    except Exception as exc:  # noqa: BLE001 - report, never abort the probe
        report.append(f"FAIL {label}: {exc}")
        report.append(traceback.format_exc(limit=2).strip().splitlines()[-1])
        return False


# ---------------------------------------------------------------- build a mesh
def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # A rounded, faceted form: the kind of thing Roblox's generator would not
    # give you, and the reason for driving a real modeller.
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=1.0, depth=0.35)
    body = bpy.context.active_object
    body.name = "ShieldBody"

    bevel = body.modifiers.new("Bevel", "BEVEL")
    bevel.width = 0.06
    bevel.segments = 2

    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.34, location=(0, 0, 0.2))
    boss = bpy.context.active_object
    boss.name = "ShieldBoss"

    for obj in (body, boss):
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier="Bevel") if obj.modifiers else None
        obj.select_set(False)

    total = sum(len(o.data.vertices) for o in bpy.data.objects if o.type == "MESH")
    report.append(f"OK   built mesh: {len([o for o in bpy.data.objects if o.type == 'MESH'])} objects, {total} vertices")


attempt("build mesh", build)


# ------------------------------------------------------------------- exporters
def export_fbx():
    bpy.ops.export_scene.fbx(filepath=os.path.join(OUT, "shield.fbx"), use_selection=False)
    size = os.path.getsize(os.path.join(OUT, "shield.fbx"))
    report.append(f"     shield.fbx = {size} bytes")


def export_obj():
    path = os.path.join(OUT, "shield.obj")
    if hasattr(bpy.ops.wm, "obj_export"):
        bpy.ops.wm.obj_export(filepath=path)
    else:
        bpy.ops.export_scene.obj(filepath=path)
    report.append(f"     shield.obj = {os.path.getsize(path)} bytes")


def export_gltf():
    path = os.path.join(OUT, "shield.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
    report.append(f"     shield.glb = {os.path.getsize(path)} bytes")


def export_stl():
    path = os.path.join(OUT, "shield.stl")
    bpy.ops.wm.stl_export(filepath=path) if hasattr(bpy.ops.wm, "stl_export") else bpy.ops.export_mesh.stl(filepath=path)
    report.append(f"     shield.stl = {os.path.getsize(path)} bytes")


for label, fn in (("export FBX", export_fbx), ("export OBJ", export_obj), ("export GLB", export_gltf), ("export STL", export_stl)):
    attempt(label, fn)


# --------------------------------------------------------------- render preview
def render():
    scene = bpy.context.scene
    bpy.ops.object.light_add(type="SUN", location=(4, -4, 6))
    bpy.context.active_object.data.energy = 4.0
    bpy.ops.object.camera_add(location=(3.4, -3.4, 2.6), rotation=(1.05, 0.0, 0.785))
    scene.camera = bpy.context.active_object
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = os.path.join(OUT, "preview.png")
    bpy.ops.render.render(write_still=True)
    report.append(f"     preview.png = {os.path.getsize(scene.render.filepath)} bytes")


attempt("render preview", render)

print("\n===BLENDER PROBE===")
for line in report:
    print(line)
print("===END===")
