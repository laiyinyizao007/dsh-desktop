#!/usr/bin/env python3
"""Tiny RPC client for the local DSH Harness.

The Harness serves its RPC surface under `/api/<endpoint>` with a
`client-request` envelope. `payload` must contain exactly one plain-object
`args` field, and `args` must match the endpoint's descriptor — most
endpoints wrap their fields in a `request` object.

Usage:
  python3 scripts/dsh-rpc.py <endpoint> '<json args>'
  python3 scripts/dsh-rpc.py --session-list
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

BASE = os.environ.get("DSH_HARNESS_BASE", "")
LOG = Path(os.environ.get("DSH_HARNESS_LOG", "/var/log/dsh-web.log"))
COOKIE_JAR = Path(os.environ.get("DSH_COOKIE_JAR", "/tmp/.dsh-rpc-cookies.txt"))


def harness_base() -> str:
    """The address the Harness actually listens on.

    The default is not `127.0.0.1`: the Harness refuses a wildcard host, so a
    deployment that serves other devices binds a concrete interface address
    and loopback is not listening at all. The startup log names the address
    it printed.
    """
    if BASE:
        return BASE
    if LOG.exists():
        matches = re.findall(r"dsh web: http://([^\s/]+):(\d+)/", LOG.read_text(errors="replace"))
        if matches:
            host, port = matches[-1]
            return f"http://{host}:{port}"
    return "http://127.0.0.1:43129"


def launch_token() -> str:
    """The harness prints a fresh launch token on every start."""
    for _ in range(60):
        if LOG.exists():
            matches = re.findall(r"token=([A-Za-z0-9_-]+)", LOG.read_text(errors="replace"))
            if matches:
                return matches[-1]
        time.sleep(1)
    raise SystemExit("no harness launch token found in the log")


def session() -> None:
    """Trade the launch token for a session cookie."""
    subprocess.run(
        ["curl", "-s", "-c", str(COOKIE_JAR), "-o", "/dev/null", "--max-time", "10",
         f"{harness_base()}/?token={launch_token()}"],
        check=True,
    )


def rpc(endpoint: str, args: dict) -> dict:
    body = json.dumps(
        {"type": "client-request", "rpcId": "r1", "method": endpoint, "payload": {"args": args}}
    )
    Path("/tmp/.dsh-rpc-body.json").write_text(body)
    result = subprocess.run(
        ["curl", "-s", "-b", str(COOKIE_JAR), "-X", "POST",
         "-H", "content-type: application/json",
         "--data-binary", "@/tmp/.dsh-rpc-body.json", "--max-time", "30",
         f"{harness_base()}/api/{endpoint}"],
        capture_output=True,
        text=True,
    )
    raw = result.stdout.strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "error": raw}
    return parsed.get("result", parsed)


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    session()
    if sys.argv[1] == "--session-list":
        print(json.dumps(rpc("session/list", {"request": {}}), indent=2, ensure_ascii=False))
        return
    endpoint = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(json.dumps(rpc(endpoint, args), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
