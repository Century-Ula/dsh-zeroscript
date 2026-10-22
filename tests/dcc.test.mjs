// SPDX-License-Identifier: MIT
/**
 * Live test for the DCC bridge against the real Blender and 3ds Max installs.
 *
 * This is the test that matters for "can the agent actually model something":
 * it builds geometry, exports it, and renders a preview through each host's own
 * scripting host, then checks the artefacts really exist on disk.
 *
 *   node tests/dcc.test.mjs
 */
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { detectDccApps, runBlender, runMax } from '../lib/dcc.js'

let failures = 0
let skipped = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}
const skip = (label, why) => {
  skipped++
  console.log(`[SKIP] ${label}  ${why}`)
}

// ---------------------------------------------------------------- detection
const apps = detectDccApps()
console.log('detected:')
for (const [key, value] of Object.entries(apps)) console.log(`  ${key.padEnd(8)} ${value ? value.exe : '(not found)'}`)

check('Blender is detected', Boolean(apps.blender), apps.blender?.exe)
check('3ds Max batch is detected', Boolean(apps.max), apps.max?.exe)
check('ZBrush is detected', Boolean(apps.zbrush), apps.zbrush?.exe)
check(
  'the newest Blender wins over older side-by-side installs',
  !apps.blender || /5\.1/.test(apps.blender.exe),
  apps.blender?.exe,
)

// ------------------------------------------------------------------ Blender
if (apps.blender) {
  const result = await runBlender({
    exe: apps.blender.exe,
    timeoutMs: 240_000,
    log: (m) => console.log(`  · ${m}`),
    code: `
import bpy, math
bpy.ops.wm.read_factory_settings(use_empty=True)

# A chamfered hexagonal plate with a raised rim: real topology, not a primitive.
bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=1.2, depth=0.18)
plate = bpy.context.active_object
plate.name = "Plate"
bev = plate.modifiers.new("Bevel", "BEVEL"); bev.width = 0.05; bev.segments = 2
bpy.context.view_layer.objects.active = plate
bpy.ops.object.modifier_apply(modifier="Bevel")

bpy.ops.mesh.primitive_torus_add(major_radius=0.95, minor_radius=0.07, major_segments=24, minor_segments=8, location=(0, 0, 0.1))
ring = bpy.context.active_object
ring.name = "Rim"

verts = sum(len(o.data.vertices) for o in bpy.data.objects if o.type == "MESH")
faces = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
print("MESHSTATS verts=%d faces=%d objects=%d" % (verts, faces, len(bpy.data.objects)))

bpy.ops.export_scene.fbx(filepath=workspace + "/plate.fbx", use_selection=False)
print("EXPORTED fbx")

import mathutils
scene = bpy.context.scene
d = bpy.data.lights.new("Key", type="SUN"); d.energy = 5.0
lo = bpy.data.objects.new("Key", d); lo.location = (3, -3, 6); scene.collection.objects.link(lo)
cam_data = bpy.data.cameras.new("Cam"); cam = bpy.data.objects.new("Cam", cam_data)
cam.location = (3.2, -3.2, 2.8); cam.rotation_euler = (1.05, 0.0, 0.785)
scene.collection.objects.link(cam); scene.camera = cam
scene.render.resolution_x = 480; scene.render.resolution_y = 480
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = workspace + "/preview.png"
bpy.ops.render.render(write_still=True)
print("RENDERED preview")
`,
  })

  check('Blender ran to completion', result.ok === true, `code=${result.code} ${result.ms}ms`)
  check('the script reported its own mesh statistics', /MESHSTATS verts=\d+ faces=\d+/.test(result.report), result.report.split('\n').find((l) => l.startsWith('MESHSTATS')) || '(none)')
  check('Blender exported an FBX', result.files.some((f) => f.path.endsWith('.fbx')), result.files.map((f) => path.basename(f.path)).join(', '))
  check('Blender rendered a preview image', result.images.length >= 1, `${result.images.length} image(s)`)
  check('the FBX on disk is non-trivial', (statSync(result.files.find((f) => f.path.endsWith('.fbx')).path).size ?? 0) > 5000)
  check('the run reports its workspace', existsSync(result.workspace), result.workspace)
} else {
  skip('Blender end-to-end modelling', 'Blender not found')
}

// ------------------------------------------------------------------ 3ds Max
if (apps.max) {
  const result = await runMax({
    exe: apps.max.exe,
    timeoutMs: 420_000,
    log: (m) => console.log(`  · ${m}`),
    script: `
		local plate = Cylinder radius:12 height:3 sides:6 heightsegs:1
		plate.name = "Plate"
		addModifier plate (Taper amount:0)

		local ring = Torus radius1:9 radius2:1 segs:24 sides:8
		ring.name = "Rim"
		ring.pos = [0, 0, 2]

		exportFile (dccWorkspace + "\\\\plate.fbx") #noPrompt selectedOnly:false
`,
  })

  check('3ds Max ran to completion', result.ok === true, `code=${result.code} ${result.ms}ms`)
  check('the MAXScript report was written', existsSync(path.join(result.workspace, '_dcc_report.txt')))
  // A plain `format` never reaches batch stdout, so the wrapper instruments the
  // scene itself - a script that prints nothing must still report its geometry.
  const stats = /DCC STATS objects=(\d+) vertices=(\d+) faces=(\d+)/.exec(result.report)
  check('3ds Max reports its own scene statistics', Boolean(stats), stats ? stats[0] : result.report.slice(0, 200))
  check('the instrumented scene is not empty', stats ? Number(stats[1]) >= 2 && Number(stats[3]) > 0 : false, stats ? `objects=${stats[1]} faces=${stats[3]}` : '')
  check('3ds Max exported an FBX', result.files.some((f) => f.path.endsWith('.fbx')), result.files.map((f) => path.basename(f.path)).join(', '))
} else {
  skip('3ds Max end-to-end modelling', '3dsmaxbatch.exe not found')
}

if (apps.zbrush) {
  skip('ZBrush headless run', 'CLI mode not yet established - see the notes in the README')
}

console.log(failures === 0 ? `\nALL PASS${skipped ? ` (${skipped} skipped)` : ''}` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
