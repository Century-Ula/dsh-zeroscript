# SPDX-License-Identifier: GPL-3.0-or-later
# probe_bridge.py - read-only reconnaissance of a running ZeroScript bridge.
#
# Connects to ws://127.0.0.1:<port>, asks for the aggregated MCP tool list and
# prints the exact tool names + JSON Schemas. Writes nothing to the bridge.
#
# Usage:  python probe_bridge.py [port] [--json out.json]
from __future__ import annotations

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    print("pip install websockets", file=sys.stderr)
    raise SystemExit(1)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else int(
    os.environ.get("ZS_BRIDGE_PORT", "17613")
)
JSON_OUT = None
if "--json" in sys.argv:
    JSON_OUT = sys.argv[sys.argv.index("--json") + 1]


async def main() -> int:
    url = f"ws://127.0.0.1:{PORT}"
    print(f"connecting {url} ...")
    async with websockets.connect(url, open_timeout=5) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
        print("--- hello ---")
        print(json.dumps({k: v for k, v in hello.items() if k != "tools"},
                         indent=2, ensure_ascii=False)[:2000])
        tools = hello.get("tools") or []

        await ws.send(json.dumps({"type": "list_tools", "id": 1}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if msg.get("type") == "tools" and msg.get("id") == 1:
                tools = msg.get("tools") or []
                break
            if msg.get("type") in ("tool_result", "error"):
                break

        print(f"--- {len(tools)} tool(s) ---")
        for t in tools:
            name = t.get("name", "?")
            desc = (t.get("description") or "").strip().replace("\n", " ")
            if len(desc) > 110:
                desc = desc[:110] + "..."
            print(f"* {name}  [{t.get('server', '?')}]")
            print(f"    {desc}")
            schema = t.get("inputSchema") or t.get("input_schema") or {}
            props = schema.get("properties") or {}
            if props:
                req = set(schema.get("required") or [])
                for pname, pspec in props.items():
                    ptype = pspec.get("type", "?")
                    star = "*" if pname in req else " "
                    print(f"      {star} {pname}: {ptype}")
        if JSON_OUT:
            with open(JSON_OUT, "w", encoding="utf-8") as fh:
                json.dump({"hello": {k: v for k, v in hello.items() if k != "tools"},
                           "tools": tools}, fh, indent=2, ensure_ascii=False)
            print(f"wrote {JSON_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
