# Changelog

All notable changes to **dsh-zeroscript** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.1] — 2026-11-13

### Fixed

- **Auto-launch failed when a newer Python landed on PATH without `websockets`.**
  `findPython()` only checked `python --version`, so a freshly installed Python
  3.13 was chosen even though bridge.py dies on `import websockets` — invisibly,
  because the spawn is hidden. The panel then stayed on "Bridge offline" with no
  explanation. Interpreter selection now probes the real requirement
  (`Python >= 3.9` **and** an importable `websockets`), skips candidates that
  fail, and logs each rejection.
- **`py` was selected but cannot be used for the hidden launch.** `py -3.11` and
  even a full path to `py.exe` pass the probe yet do not start the script through
  `WScript.Shell.Run` (verified). Candidates are now resolved to the concrete
  `python.exe` reported by `sys.executable`, and explicit install paths are
  tried before launcher shims.
- Launch failures are now written to `logs/startup.log`
  (`launch (auto-heal): started ... (python: ...)` / `launch (...): FAILED - ...`)
  and exposed as `launch` in `/zeroscript-version`, so "bridge offline" always has
  a readable cause.

## [1.2.0] — 2026-10-23

### Added

- **DSH bundle packaging.** `package.json` now declares
  `dsh.bundle.patch: ./cordis.patch.yml` and the repo ships that patch layer, so
  the plugin can be installed as a normal DSH profile bundle (plugin manager)
  in addition to the `install.ps1` profile-patch route. Use one of the two
  routes at a time — both at once would register the plugin twice.
- `cordis.patch.yml` (bundle layer) added to `files`.

### Changed

- Repository renamed from `mspd-ms` to **`dsh-zeroscript`**; all links in
  README / package.json / docs updated.
- Version bumped to `1.2.0`; release asset `dsh-zeroscript-1.2.0.zip`.

## [1.1.0] — 2026-10-23

First public release, verified against **DSH 0.2.0-rc.2** on Windows 11.

### Fixed

- **The plugin could silently fail to load on DSH 0.2.** `lib/index.js` had a
  static `import '@deepseek-ai/schemastery'`. That package is a DSH internal, and
  when the profile's link to it went stale the import failed *before* any plugin
  code ran — no tools, no routes, no `logs/startup.log` entry, while the loader
  entry still read `active`. The dependency is gone; config defaults are applied
  inside `start()` instead, so the plugin now imports nothing but Node built-ins.
- **`roblox_status` reported a false "verified" state when several Studios were
  open.** With more than one Studio attached, MCP requires an explicit
  `studio_id`; the rejection arrives as ordinary text with `ok: true`, so the old
  verification call treated an error message as proof. Detection now lists the
  attached Studios (`list_roblox_studios`, no `studio_id` needed), reads one
  Studio's state with its id, and requires the real state text back.

### Added

- `install.ps1` / `uninstall.ps1`: one-command install and removal for a DSH
  profile (idempotent, backs up `cordis.patch.yml`, never touches your config
  block).
- `tools/verify-detect.mjs`: runs the detection ladder against a live bridge,
  outside DSH, for troubleshooting.
- `README.en.md`, `docs/DEVELOPMENT.md`, and this changelog.
- `.gitignore` that keeps generated models, logs and secrets out of git.

### Changed

- Reworked the README into a public introduction + installation tutorial.
- Version bumped to `1.1.0`; tests updated to resolve a `studio_id` so they pass
  with multiple Studio windows open.

## [1.0.0] — 2026-10-15

Initial internal version.

- Host half: 28–30 Studio tools registered as first-class DSH tools, plus
  `roblox_status`, `roblox_list_tools` and `roblox_call`.
- Standalone console page at `/zeroscript` and a DSH sidebar panel.
- WebSocket client for `bridge.py` with reconnect, status polling and request
  correlation.
- Hidden (`wscript`) auto-start of `bridge.py`, crash healing, and a four-layer
  Studio detection ladder.
- Optional DCC tools that drive Blender and 3ds Max headlessly, and upload the
  resulting models to Roblox through Open Cloud.
