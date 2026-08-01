import socket
import ssl
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from app.services.pinned_https import (
    PinnedAddress,
    PinnedHttpsError,
    PinnedHttpsTransport,
    _PinnedHTTPSConnection,
)


class _Response:
    def __init__(self, body=b'{}'):
        self.status = 200
        self._body = body

    def read(self, amount):
        return self._body[:amount]

    def getheaders(self):
        return [("Content-Type", "application/json")]


class _Connection:
    def __init__(self, response=None):
        self.response = response or _Response()
        self.requests = []
        self.closed = False

    def request(self, method, url, body=None, headers=None):
        self.requests.append((method, url, body, headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class PinnedHttpsTransportTest(unittest.TestCase):
    def test_resolves_once_and_reuses_only_the_frozen_public_answer_set(self):
        resolver_calls = []
        factory_calls = []

        def resolver(*args, **kwargs):
            resolver_calls.append((args, kwargs))
            if len(resolver_calls) > 1:
                return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.9", 443))]
            return [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443)),
                (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("2001:4860:4860::8888", 443, 0, 0)),
            ]

        def factory(hostname, port, address, timeout):
            factory_calls.append((hostname, port, address, timeout))
            return _Connection()

        transport = PinnedHttpsTransport(resolver=resolver, connection_factory=factory)
        target = transport.pin("https://alerts.example.net/check", "alerts.example.net")
        transport.request(target, address_index=0, method="POST", headers={}, body=b"{}")
        transport.request(target, address_index=1, method="POST", headers={}, body=b"{}")

        self.assertEqual(len(resolver_calls), 1)
        self.assertEqual([call[2].address for call in factory_calls], [
            "8.8.8.8", "2001:4860:4860::8888",
        ])
        self.assertTrue(all(call[0] == "alerts.example.net" for call in factory_calls))

    def test_rejects_private_or_mixed_dns_before_connection_construction(self):
        for answers in (
            [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("10.0.0.1", 443))],
            [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443)),
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 443)),
            ],
        ):
            with self.subTest(answers=answers):
                connected = False

                def factory(*_args):
                    nonlocal connected
                    connected = True
                    return _Connection()

                transport = PinnedHttpsTransport(
                    resolver=lambda *_args, **_kwargs: answers,
                    connection_factory=factory,
                )
                with self.assertRaisesRegex(PinnedHttpsError, "not_public"):
                    transport.pin("https://alerts.example.net/check", "alerts.example.net")
                self.assertFalse(connected)

    def test_total_deadline_includes_dns_resolution(self):
        release_resolver = threading.Event()
        connected = False

        def resolver(*_args, **_kwargs):
            release_resolver.wait()
            return [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443)),
            ]

        def factory(*_args):
            nonlocal connected
            connected = True
            return _Connection()

        transport = PinnedHttpsTransport(
            resolver=resolver,
            connection_factory=factory,
            timeout_seconds=0.02,
        )
        started = time.monotonic()
        try:
            with self.assertRaisesRegex(PinnedHttpsError, "destination_timeout"):
                transport.pin("https://alerts.example.net/check", "alerts.example.net")
        finally:
            release_resolver.set()

        self.assertLess(time.monotonic() - started, 0.5)
        self.assertFalse(connected)

    def test_numeric_socket_preserves_original_hostname_for_tls(self):
        raw_socket = SimpleNamespace(
            settimeout=lambda value: setattr(raw_socket, "timeout", value),
            connect=lambda address: setattr(raw_socket, "connected_to", address),
            close=lambda: setattr(raw_socket, "closed", True),
        )
        context = SimpleNamespace(
            verify_mode=ssl.CERT_REQUIRED,
            check_hostname=True,
            wrap_socket=lambda sock, server_hostname: (
                setattr(context, "server_hostname", server_hostname) or sock
            ),
        )
        address = PinnedAddress(socket.AF_INET, "8.8.8.8", ("8.8.8.8", 443))
        connection = _PinnedHTTPSConnection(
            "alerts.example.net",
            443,
            address,
            5.0,
            context=context,
        )

        with patch("app.services.pinned_https.socket.socket", return_value=raw_socket):
            connection.connect()

        self.assertEqual(raw_socket.connected_to, ("8.8.8.8", 443))
        self.assertEqual(context.server_hostname, "alerts.example.net")

    def test_response_body_is_bounded(self):
        transport = PinnedHttpsTransport(
            resolver=lambda *_args, **_kwargs: [
                (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", 443)),
            ],
            connection_factory=lambda *_args: _Connection(_Response(b"x" * 6)),
            max_response_bytes=5,
        )
        target = transport.pin("https://alerts.example.net/check", "alerts.example.net")

        with self.assertRaisesRegex(PinnedHttpsError, "too_large"):
            transport.request(target, address_index=0, method="POST", headers={}, body=b"{}")


if __name__ == "__main__":
    unittest.main()
