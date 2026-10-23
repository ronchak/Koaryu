"""The disposable native verifier must not shadow a developer's local stack."""

import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from mcp_oauth_native_stack import NativeStack, reserve_gateway_socket


@pytest.mark.parametrize("host", ["127.0.0.1", "0.0.0.0"])
def test_reservation_refuses_existing_loopback_and_wildcard_listeners(host):
    with socket.socket() as existing:
        existing.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        existing.bind((host, 0))
        existing.listen()
        port = existing.getsockname()[1]
        with pytest.raises(RuntimeError, match="occupied; leave that stack alone"):
            reserve_gateway_socket(port)
        assert existing.getsockname()[1] == port


def test_reservation_holds_port_without_reuse_until_cleanup():
    listener = reserve_gateway_socket(0)
    port = listener.getsockname()[1]
    assert listener.getsockname()[0] == "127.0.0.1"
    assert listener.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR) == 0
    with socket.socket() as competing:
        competing.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with pytest.raises(OSError):
            competing.bind(("127.0.0.1", port))

    stack = NativeStack.__new__(NativeStack)
    stack.children, stack.logs, stack.temporary = [], [], None
    stack.gateway_socket = listener
    stack.close()
    stack.close()
    assert listener.fileno() == -1
    with socket.socket() as next_owner:
        next_owner.bind(("127.0.0.1", port))
