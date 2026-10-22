# SPDX-License-Identifier: MIT
"""Test fixture standing in for ZeroScript's bridge.py.

`lib/launcher.js` locates a script named bridge.py in a candidate directory and
spawns it with `python`. This stub keeps the real spawn/probe/wait code path
under test without starting a second real bridge - a second bridge would spawn
its own StudioMCP.exe proxy and could disturb the Studio session the user
already has open.

It binds the port handed to it in ZS_BRIDGE_PORT and idles until killed.
"""
import os
import socket
import sys
import time

port = int(os.environ.get("ZS_BRIDGE_PORT", "17613"))
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", port))
sock.listen(8)
print(f"fixture bridge listening on {port}", flush=True)

deadline = time.time() + 60
while time.time() < deadline:
    try:
        sock.settimeout(1.0)
        conn, _ = sock.accept()
        conn.close()
    except socket.timeout:
        continue
    except OSError:
        break
sock.close()
sys.exit(0)
