# Changelog

All notable changes to **dsh-zeroscript** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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
