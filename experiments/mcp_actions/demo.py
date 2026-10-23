"""Start an isolated synthetic action lab. Never reads Koaryu or provider credentials."""

import argparse
import json
import os
import secrets
import socket
import tempfile
from pathlib import Path

import uvicorn

from .server import build_app
from .store import Store, ensure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8110)
    parser.add_argument(
        "--state-directory",
        type=Path,
        help="New private directory outside this worktree; default is a fresh temporary directory.",
    )
    args = parser.parse_args()
    ensure(1024 <= args.port <= 65535, 422, "Choose an unprivileged loopback port.")
    root = Path(__file__).resolve().parents[2]
    directory = (
        args.state_directory
        or Path(tempfile.gettempdir()) / ("koaryu-action-lab-" + secrets.token_hex(8))
    ).absolute()
    ensure(
        not directory.resolve().is_relative_to(root),
        422,
        "Keep synthetic credentials outside the worktree.",
    )
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", args.port))
    store = Store.create(directory)
    fixtures = store.seed()
    descriptor = os.open(
        directory / "synthetic-credentials.json",
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "w") as output:
        json.dump(fixtures, output, indent=2)
        output.write("\n")
    origin = f"http://127.0.0.1:{args.port}"
    print(
        "Synthetic action lab only. No Koaryu, Supabase, Stripe or customer data is used.",
        flush=True,
    )
    print("Owner review: " + origin + "/owner", flush=True)
    print("Fixed-bearer MCP: " + origin + "/mcp", flush=True)
    print(
        "Private synthetic credentials and target IDs: "
        + str(directory / "synthetic-credentials.json"),
        flush=True,
    )
    uvicorn.run(
        build_app(store, origin),
        host="127.0.0.1",
        port=args.port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
