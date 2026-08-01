from __future__ import annotations

from dataclasses import dataclass
import http.client
import ipaddress
import queue
import socket
import ssl
import threading
import time
from typing import Callable, Mapping, Protocol, Sequence
from urllib.parse import urlsplit


class PinnedHttpsError(RuntimeError):
    """Raised when an HTTPS target cannot be resolved or reached safely."""


@dataclass(frozen=True)
class PinnedAddress:
    family: int
    address: str
    socket_address: tuple


@dataclass(frozen=True)
class PinnedHttpsTarget:
    hostname: str
    port: int
    request_target: str
    addresses: tuple[PinnedAddress, ...]
    deadline_monotonic: float


@dataclass(frozen=True)
class PinnedHttpsResponse:
    status_code: int
    headers: Mapping[str, str]
    body: bytes


class HttpsConnection(Protocol):
    def request(
        self,
        method: str,
        url: str,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None: ...

    def getresponse(self) -> http.client.HTTPResponse: ...

    def close(self) -> None: ...


Resolver = Callable[..., Sequence[tuple]]
ConnectionFactory = Callable[[str, int, PinnedAddress, float], HttpsConnection]


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection whose TCP socket is already bound to one numeric answer."""

    def __init__(
        self,
        hostname: str,
        port: int,
        address: PinnedAddress,
        timeout: float,
        *,
        context: ssl.SSLContext | None = None,
    ) -> None:
        super().__init__(hostname, port=port, timeout=timeout, context=context)
        self._pinned_address = address

    def connect(self) -> None:
        raw_socket = socket.socket(self._pinned_address.family, socket.SOCK_STREAM)
        raw_socket.settimeout(self.timeout)
        try:
            raw_socket.connect(self._pinned_address.socket_address)
            # self.host remains the original DNS hostname, preserving both SNI
            # and certificate hostname validation while TCP uses only the
            # prevalidated numeric address.
            self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)
        except Exception:
            raw_socket.close()
            raise


def _default_connection_factory(
    hostname: str,
    port: int,
    address: PinnedAddress,
    timeout: float,
) -> HttpsConnection:
    return _PinnedHTTPSConnection(hostname, port, address, timeout)


class PinnedHttpsTransport:
    """Resolve once, validate every answer, and never delegate DNS to connect."""

    def __init__(
        self,
        *,
        resolver: Resolver = socket.getaddrinfo,
        connection_factory: ConnectionFactory = _default_connection_factory,
        timeout_seconds: float = 10.0,
        max_response_bytes: int = 4096,
    ) -> None:
        self._resolver = resolver
        self._connection_factory = connection_factory
        self._timeout_seconds = timeout_seconds
        self._max_response_bytes = max_response_bytes
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        if max_response_bytes < 1:
            raise ValueError("max_response_bytes must be positive")

    def pin(self, url: str, expected_hostname: str) -> PinnedHttpsTarget:
        deadline = time.monotonic() + self._timeout_seconds
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != expected_hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.port not in {None, 443}
        ):
            raise PinnedHttpsError("destination_target_invalid")

        port = parsed.port or 443
        answers = self._resolve_before_deadline(expected_hostname, port, deadline)

        pinned: list[PinnedAddress] = []
        seen: set[tuple[int, str, tuple]] = set()
        for family, socket_type, protocol, _canonical_name, socket_address in answers:
            if (
                family not in {socket.AF_INET, socket.AF_INET6}
                or socket_type != socket.SOCK_STREAM
                or protocol not in {0, socket.IPPROTO_TCP}
                or not isinstance(socket_address, tuple)
                or not socket_address
            ):
                raise PinnedHttpsError("destination_dns_answer_invalid")
            address = str(socket_address[0])
            try:
                parsed_address = ipaddress.ip_address(address)
            except ValueError as exc:
                raise PinnedHttpsError("destination_dns_answer_invalid") from exc
            if not parsed_address.is_global:
                raise PinnedHttpsError("destination_dns_answer_not_public")
            key = (family, address, socket_address)
            if key not in seen:
                seen.add(key)
                pinned.append(PinnedAddress(family, address, socket_address))

        if not pinned:
            raise PinnedHttpsError("destination_dns_answer_missing")
        request_target = parsed.path or "/"
        return PinnedHttpsTarget(
            hostname=expected_hostname,
            port=port,
            request_target=request_target,
            addresses=tuple(pinned),
            deadline_monotonic=deadline,
        )

    def _resolve_before_deadline(
        self,
        hostname: str,
        port: int,
        deadline: float,
    ) -> Sequence[tuple]:
        outcome: queue.Queue[tuple[bool, object]] = queue.Queue(maxsize=1)

        def resolve_once() -> None:
            try:
                answers = self._resolver(
                    hostname,
                    port,
                    family=socket.AF_UNSPEC,
                    type=socket.SOCK_STREAM,
                    proto=socket.IPPROTO_TCP,
                )
                outcome.put_nowait((True, answers))
            except Exception as exc:
                outcome.put_nowait((False, exc))

        threading.Thread(target=resolve_once, daemon=True).start()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PinnedHttpsError("destination_timeout")
        try:
            succeeded, value = outcome.get(timeout=remaining)
        except queue.Empty:
            raise PinnedHttpsError("destination_timeout") from None
        if not succeeded:
            assert isinstance(value, Exception)
            raise PinnedHttpsError("destination_dns_failure") from value
        return value  # type: ignore[return-value]

    def request(
        self,
        target: PinnedHttpsTarget,
        *,
        address_index: int,
        method: str,
        headers: Mapping[str, str],
        body: bytes,
    ) -> PinnedHttpsResponse:
        address = target.addresses[address_index % len(target.addresses)]
        remaining = target.deadline_monotonic - time.monotonic()
        if remaining <= 0:
            raise PinnedHttpsError("destination_timeout")
        connection = self._connection_factory(
            target.hostname,
            target.port,
            address,
            remaining,
        )
        try:
            connection.request(method, target.request_target, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read(self._max_response_bytes + 1)
            if time.monotonic() > target.deadline_monotonic:
                raise PinnedHttpsError("destination_timeout")
            if len(payload) > self._max_response_bytes:
                raise PinnedHttpsError("destination_response_too_large")
            response_headers = {
                name.lower(): value for name, value in response.getheaders()
            }
            return PinnedHttpsResponse(response.status, response_headers, payload)
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            raise PinnedHttpsError("destination_transport_failure") from exc
        finally:
            connection.close()
