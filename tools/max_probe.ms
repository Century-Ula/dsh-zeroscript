-- SPDX-License-Identifier: MIT
-- Headless 3ds Max probe: can the agent drive Max from the command line?
--
--   "C:\MS\MAX\3ds Max 2025\3dsmaxbatch.exe" tools\max_probe.ms
--
-- Writes a report file rather than relying on stdout, which batch mode
-- interleaves with its own logging. Every step is guarded so one failure does
-- not hide the rest.

(
	local outDir = "C:\\SSP\\E\\dcc-test"
	makeDir outDir all:true
	local reportPath = outDir + "\\max_report.txt"
	local f = createFile reportPath
	local ok = true

	format "MAXSCRIPT PROBE\n" to:f
	format "maxVersion=%\n" (maxVersion()) to:f

	-- Build something with real topology rather than a raw primitive.
	try (
		local body = Cylinder radius:12 height:4 sides:12 heightsegs:1
		body.name = "ShieldBody"
		addModifier body (Taper amount:0.0 )
		format "OK   built body: % verts=%\n" body.name (body.mesh.numverts) to:f

		local boss = Sphere radius:4 segs:16
		boss.name = "ShieldBoss"
		boss.pos = [0, 0, 3]
		format "OK   built boss: % verts=%\n" boss.name (boss.mesh.numverts) to:f
	) catch (
		ok = false
		format "FAIL build: %\n" (getCurrentException()) to:f
	)

	-- Exporters are optional units; report which ones this install actually has.
	try (
		local fbxPath = outDir + "\\max_shield.fbx"
		exportFile fbxPath #noPrompt selectedOnly:false
		format "OK   export FBX -> %\n" fbxPath to:f
	) catch (
		format "FAIL export FBX: %\n" (getCurrentException()) to:f
	)

	try (
		local objPath = outDir + "\\max_shield.obj"
		exportFile objPath #noPrompt selectedOnly:false
		format "OK   export OBJ -> %\n" objPath to:f
	) catch (
		format "FAIL export OBJ: %\n" (getCurrentException()) to:f
	)

	-- A 3ds Max-native scene is itself a useful artifact.
	try (
		local maxPath = outDir + "\\max_shield.max"
		saveMaxFile maxPath quiet:true
		format "OK   save scene -> %\n" maxPath to:f
	) catch (
		format "FAIL save scene: %\n" (getCurrentException()) to:f
	)

	-- Render a preview so the result can be looked at, not trusted.
	try (
		local png = outDir + "\\max_preview.png"
		-- FreeCamera's `target` expects a node, not a point3; build the target
		-- object first so the conversion is unambiguous.
		local camTarget = Point pos:[0, 0, 0]
		local cam = FreeCamera pos:[40, -40, 30] target:camTarget
		viewport.setCamera cam
		render camera:cam outputfile:png outputwidth:512 outputheight:512 vfb:off
		format "OK   render preview -> %\n" png to:f
	) catch (
		format "FAIL render: %\n" (getCurrentException()) to:f
	)

	format "PROBE_DONE ok=%\n" ok to:f
	close f
)
