#!/usr/bin/env python3
"""Profile Koaryu's request limiter and Starlette parsers with synthetic bodies."""

from __future__ import annotations

import argparse
import asyncio
import gc
import hashlib
import json
import os
import resource
import statistics
import subprocess
import sys
import time
import tracemalloc
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.request_body_limits import (  # noqa: E402
    CSV_IMPORT_REQUEST_MAX_BYTES,
    DEFAULT_API_REQUEST_MAX_BYTES,
    RequestBodyLimitMiddleware,
)
from app.core.upload_limits import CSV_IMPORT_MAX_BYTES  # noqa: E402
from starlette.exceptions import HTTPException  # noqa: E402
from starlette.formparsers import MultiPartException, MultiPartParser  # noqa: E402
from starlette.requests import Request  # noqa: E402

MIB = 1024 * 1024
ASGI_CHUNK_BYTES = 64 * 1024
BOUNDARY = b"koaryu-profile-boundary"
FILE_PATTERN = b"0123456789abcdef"
TEXT_PATTERN = b"a"


@dataclass(frozen=True)
class Segment:
    pattern: bytes
    length: int


@dataclass(frozen=True)
class Scenario:
    name: str
    kind: str
    segments: tuple[Segment, ...]
    limit_bytes: int
    expected_status: int
    declared_length: int | None
    path: str

    @property
    def body_bytes(self) -> int:
        return sum(segment.length for segment in self.segments)


class SegmentedBody:
    """Lazily materialize a deterministic body in Uvicorn-sized chunks."""

    def __init__(self, segments: tuple[Segment, ...]):
        self._segments = segments
        self._segment_index = 0
        self._segment_offset = 0
        self.remaining = sum(segment.length for segment in segments)
        self.produced = 0
        self.digest = hashlib.sha256()

    def read(self, max_bytes: int) -> bytes:
        if self.remaining == 0:
            return b""

        chunks: list[bytes] = []
        wanted = min(max_bytes, self.remaining)
        while wanted:
            segment = self._segments[self._segment_index]
            available = segment.length - self._segment_offset
            take = min(wanted, available)
            pattern = segment.pattern
            pattern_offset = self._segment_offset % len(pattern)
            repeats = (pattern_offset + take + len(pattern) - 1) // len(pattern)
            materialized = (pattern * repeats)[pattern_offset : pattern_offset + take]
            chunks.append(materialized)
            self._segment_offset += take
            self.remaining -= take
            self.produced += take
            wanted -= take
            if self._segment_offset == segment.length:
                self._segment_index += 1
                self._segment_offset = 0

        body = b"".join(chunks)
        self.digest.update(body)
        return body


def fixed(value: bytes) -> Segment:
    return Segment(value, len(value))


def repeated(pattern: bytes, length: int) -> Segment:
    if not pattern or length < 0:
        raise ValueError("Repeated segments need a pattern and non-negative length.")
    return Segment(pattern, length)


def json_segments(total_bytes: int) -> tuple[Segment, ...]:
    prefix = b'{"payload":"'
    suffix = b'"}'
    filler_bytes = total_bytes - len(prefix) - len(suffix)
    if filler_bytes < 0:
        raise ValueError("JSON body is too small.")
    return (fixed(prefix), repeated(TEXT_PATTERN, filler_bytes), fixed(suffix))


def multipart_segments(*, file_bytes: int, total_bytes: int | None = None) -> tuple[Segment, ...]:
    file_prefix = (
        b"--"
        + BOUNDARY
        + b'\r\nContent-Disposition: form-data; name="file"; filename="students.csv"\r\n'
        + b"Content-Type: text/csv\r\n\r\n"
    )
    field_prefix = (
        b"\r\n--"
        + BOUNDARY
        + b'\r\nContent-Disposition: form-data; name="payload"\r\n'
        + b"Content-Type: application/json\r\n\r\n"
    )
    field_json_prefix = b'{"mapping":"'
    field_json_suffix = b'"}'
    closing = b"\r\n--" + BOUNDARY + b"--\r\n"
    fixed_bytes = (
        len(file_prefix)
        + file_bytes
        + len(field_prefix)
        + len(field_json_prefix)
        + len(field_json_suffix)
        + len(closing)
    )
    target_bytes = total_bytes if total_bytes is not None else fixed_bytes
    filler_bytes = target_bytes - fixed_bytes
    if filler_bytes < 0:
        raise ValueError("Multipart target is smaller than its framing.")
    return (
        fixed(file_prefix),
        repeated(FILE_PATTERN, file_bytes),
        fixed(field_prefix),
        fixed(field_json_prefix),
        repeated(TEXT_PATTERN, filler_bytes),
        fixed(field_json_suffix),
        fixed(closing),
    )


def scenarios(*, quick: bool) -> list[Scenario]:
    values = [
        Scenario(
            name="json-64k",
            kind="json",
            segments=json_segments(64 * 1024),
            limit_bytes=DEFAULT_API_REQUEST_MAX_BYTES,
            expected_status=204,
            declared_length=64 * 1024,
            path="/api/v1/profile",
        ),
        Scenario(
            name="json-512k",
            kind="json",
            segments=json_segments(512 * 1024),
            limit_bytes=DEFAULT_API_REQUEST_MAX_BYTES,
            expected_status=204,
            declared_length=512 * 1024,
            path="/api/v1/profile",
        ),
        Scenario(
            name="json-1m",
            kind="json",
            segments=json_segments(DEFAULT_API_REQUEST_MAX_BYTES),
            limit_bytes=DEFAULT_API_REQUEST_MAX_BYTES,
            expected_status=204,
            declared_length=DEFAULT_API_REQUEST_MAX_BYTES,
            path="/api/v1/profile",
        ),
        Scenario(
            name="multipart-256k",
            kind="multipart",
            segments=multipart_segments(file_bytes=256 * 1024),
            limit_bytes=CSV_IMPORT_REQUEST_MAX_BYTES,
            expected_status=204,
            declared_length=None,
            path="/api/v1/students/import/parse",
        ),
        Scenario(
            name="multipart-2m",
            kind="multipart",
            segments=multipart_segments(file_bytes=2 * MIB),
            limit_bytes=CSV_IMPORT_REQUEST_MAX_BYTES,
            expected_status=204,
            declared_length=None,
            path="/api/v1/students/import/parse",
        ),
        Scenario(
            name="multipart-10m",
            kind="multipart",
            segments=multipart_segments(file_bytes=CSV_IMPORT_MAX_BYTES),
            limit_bytes=CSV_IMPORT_REQUEST_MAX_BYTES,
            expected_status=204,
            declared_length=None,
            path="/api/v1/students/import/parse",
        ),
        Scenario(
            name="multipart-max-envelope",
            kind="multipart",
            segments=multipart_segments(
                file_bytes=CSV_IMPORT_MAX_BYTES,
                total_bytes=CSV_IMPORT_REQUEST_MAX_BYTES,
            ),
            limit_bytes=CSV_IMPORT_REQUEST_MAX_BYTES,
            expected_status=400,
            declared_length=CSV_IMPORT_REQUEST_MAX_BYTES,
            path="/api/v1/students/import/parse",
        ),
        Scenario(
            name="json-declared-overflow",
            kind="json",
            segments=json_segments(64 * 1024),
            limit_bytes=DEFAULT_API_REQUEST_MAX_BYTES,
            expected_status=413,
            declared_length=DEFAULT_API_REQUEST_MAX_BYTES + 1,
            path="/api/v1/profile",
        ),
        Scenario(
            name="json-streamed-overflow",
            kind="json",
            segments=json_segments(DEFAULT_API_REQUEST_MAX_BYTES + 1),
            limit_bytes=DEFAULT_API_REQUEST_MAX_BYTES,
            expected_status=413,
            declared_length=None,
            path="/api/v1/profile",
        ),
        Scenario(
            name="multipart-streamed-overflow",
            kind="multipart",
            segments=multipart_segments(
                file_bytes=CSV_IMPORT_MAX_BYTES,
                total_bytes=CSV_IMPORT_REQUEST_MAX_BYTES + 1,
            ),
            limit_bytes=CSV_IMPORT_REQUEST_MAX_BYTES,
            expected_status=413,
            declared_length=None,
            path="/api/v1/students/import/parse",
        ),
    ]
    if quick:
        return [values[0], values[4], values[7], values[8]]
    return values


def scenario_by_name(name: str) -> Scenario:
    for scenario in scenarios(quick=False):
        if scenario.name == name:
            return scenario
    raise ValueError(f"Unknown scenario: {name}")


def rss_mib() -> float:
    max_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = MIB if sys.platform == "darwin" else 1024
    return max_rss / divisor


async def drain_receive(receive: Any, last_more_body: bool) -> None:
    while last_more_body:
        message = await receive()
        if message["type"] != "http.request":
            return
        last_more_body = bool(message.get("more_body", False))


async def run_one(
    middleware: RequestBodyLimitMiddleware,
    scenario: Scenario,
    start: asyncio.Event,
) -> dict[str, Any]:
    source = SegmentedBody(scenario.segments)
    observed_digest = hashlib.sha256()
    observed_bytes = 0
    downstream_called = False
    upload_rolled: bool | None = None
    parser_status = 204
    response_status: int | None = None

    async def receive() -> dict[str, Any]:
        await asyncio.sleep(0)
        chunk = source.read(ASGI_CHUNK_BYTES)
        return {
            "type": "http.request",
            "body": chunk,
            "more_body": source.remaining > 0,
        }

    async def send(message: dict[str, Any]) -> None:
        nonlocal response_status
        if message["type"] == "http.response.start":
            response_status = int(message["status"])

    async def downstream(
        scope: dict[str, Any],
        replay_receive: Any,
        downstream_send: Any,
    ) -> None:
        nonlocal downstream_called, observed_bytes, parser_status, upload_rolled
        downstream_called = True
        last_more_body = True

        async def observing_receive() -> dict[str, Any]:
            nonlocal observed_bytes, last_more_body
            message = await replay_receive()
            if message["type"] == "http.request":
                chunk = message.get("body", b"")
                observed_digest.update(chunk)
                observed_bytes += len(chunk)
                last_more_body = bool(message.get("more_body", False))
            else:
                last_more_body = False
            return message

        request = Request(scope, observing_receive)
        try:
            if scenario.kind == "json":
                parsed = await request.json()
                if not isinstance(parsed.get("payload"), str):
                    parser_status = 500
            else:
                form = await request.form()
                upload = form["file"]
                upload_rolled = bool(getattr(upload.file, "_rolled", False))
                file_bytes = 0
                while chunk := await upload.read(ASGI_CHUNK_BYTES):
                    file_bytes += len(chunk)
                if file_bytes == 0:
                    parser_status = 500
                await form.close()
        except (HTTPException, MultiPartException):
            parser_status = 400
        finally:
            await drain_receive(observing_receive, last_more_body)

        await downstream_send(
            {"type": "http.response.start", "status": parser_status, "headers": []}
        )
        await downstream_send({"type": "http.response.body", "body": b""})

    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": scenario.path,
        "raw_path": scenario.path.encode(),
        "query_string": b"",
        "server": ("127.0.0.1", 8001),
        "client": ("127.0.0.1", 50000),
        "profile_downstream": downstream,
        "headers": [
            (
                b"content-type",
                b"application/json"
                if scenario.kind == "json"
                else b"multipart/form-data; boundary=" + BOUNDARY,
            )
        ],
    }
    if scenario.declared_length is not None:
        scope["headers"].append(
            (b"content-length", str(scenario.declared_length).encode())
        )

    await start.wait()
    started = time.perf_counter()
    await middleware(scope, receive, send)
    latency_ms = (time.perf_counter() - started) * 1000
    integrity_ok = (
        downstream_called
        and source.remaining == 0
        and observed_bytes == scenario.body_bytes
        and observed_digest.digest() == source.digest.digest()
    )
    return {
        "status": response_status,
        "latency_ms": latency_ms,
        "integrity_ok": integrity_ok,
        "downstream_called": downstream_called,
        "source_bytes_consumed": source.produced,
        "upload_rolled": upload_rolled,
    }


async def run_worker(
    scenario: Scenario,
    *,
    concurrency: int,
    trace_allocations: bool,
) -> dict[str, Any]:
    gc.collect()
    baseline_rss_mib = rss_mib()
    allocation_baseline = 0
    if trace_allocations:
        tracemalloc.start(1)
        allocation_baseline = tracemalloc.get_traced_memory()[0]
        tracemalloc.reset_peak()

    start = asyncio.Event()

    async def route_profile_request(
        scope: dict[str, Any],
        receive: Any,
        send: Any,
    ) -> None:
        await scope["profile_downstream"](scope, receive, send)

    middleware = RequestBodyLimitMiddleware(
        route_profile_request,
        api_v1_prefix="/api/v1",
    )
    tasks = [
        asyncio.create_task(run_one(middleware, scenario, start))
        for _ in range(concurrency)
    ]

    await asyncio.sleep(0)
    start.set()
    results = await asyncio.gather(*tasks)

    allocation_peak_mib: float | None = None
    if trace_allocations:
        _, allocation_peak = tracemalloc.get_traced_memory()
        allocation_peak_mib = (allocation_peak - allocation_baseline) / MIB
        tracemalloc.stop()

    peak_rss_mib = rss_mib()
    statuses = [result["status"] for result in results]
    latencies = [result["latency_ms"] for result in results]
    expected_integrity = scenario.expected_status not in {413}
    return {
        "profile": "direct-backend",
        "scenario": scenario.name,
        "kind": scenario.kind,
        "body_bytes": scenario.body_bytes,
        "concurrency": concurrency,
        "expected_status": scenario.expected_status,
        "statuses": statuses,
        "status_ok": all(status == scenario.expected_status for status in statuses),
        "byte_integrity_ok": (
            all(result["integrity_ok"] for result in results)
            if expected_integrity
            else all(not result["downstream_called"] for result in results)
        ),
        "source_bytes_consumed": [result["source_bytes_consumed"] for result in results],
        "upload_rolled": [result["upload_rolled"] for result in results],
        "baseline_rss_mib": round(baseline_rss_mib, 3),
        "peak_rss_mib": round(peak_rss_mib, 3),
        "rss_delta_mib": round(peak_rss_mib - baseline_rss_mib, 3),
        "python_allocation_peak_mib": (
            round(allocation_peak_mib, 3) if allocation_peak_mib is not None else None
        ),
        "latency_p50_ms": round(statistics.median(latencies), 3),
        "latency_max_ms": round(max(latencies), 3),
        "starlette_spool_mib": MultiPartParser.spool_max_size / MIB,
        "starlette_max_part_mib": MultiPartParser.max_part_size / MIB,
    }


def worker_command(
    scenario: Scenario,
    *,
    concurrency: int,
    trace_allocations: bool,
) -> list[str]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--worker",
        "--scenario",
        scenario.name,
        "--concurrency",
        str(concurrency),
    ]
    if trace_allocations:
        command.append("--trace-allocations")
    return command


def run_subprocess_worker(
    scenario: Scenario,
    *,
    concurrency: int,
    trace_allocations: bool,
) -> dict[str, Any]:
    completed = subprocess.run(
        worker_command(
            scenario,
            concurrency=concurrency,
            trace_allocations=trace_allocations,
        ),
        check=True,
        cwd=BACKEND_ROOT.parent,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONHASHSEED": "0"},
    )
    return json.loads(completed.stdout)


def render_markdown(results: list[dict[str, Any]]) -> str:
    lines = [
        "| path | body MiB | c | peak RSS Δ MiB | Python alloc peak MiB | p50 ms | max ms | status | bytes |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ]
    for result in results:
        lines.append(
            "| {scenario} | {body:.3f} | {concurrency} | {rss:.3f} | {alloc:.3f} | "
            "{p50:.3f} | {maximum:.3f} | {status} | {integrity} |".format(
                scenario=result["scenario"],
                body=result["body_bytes"] / MIB,
                concurrency=result["concurrency"],
                rss=result["rss_delta_mib"],
                alloc=result["python_allocation_peak_mib"],
                p50=result["latency_p50_ms"],
                maximum=result["latency_max_ms"],
                status="ok" if result["status_ok"] else "FAIL",
                integrity="ok" if result["byte_integrity_ok"] else "FAIL",
            )
        )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true", help="Run a small smoke profile.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of Markdown.")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--scenario", help=argparse.SUPPRESS)
    parser.add_argument("--concurrency", type=int, default=1, help=argparse.SUPPRESS)
    parser.add_argument("--trace-allocations", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.worker:
        if not args.scenario or args.concurrency < 1:
            raise SystemExit("Worker mode requires a scenario and positive concurrency.")
        result = asyncio.run(
            run_worker(
                scenario_by_name(args.scenario),
                concurrency=args.concurrency,
                trace_allocations=args.trace_allocations,
            )
        )
        print(json.dumps(result, sort_keys=True))
        return 0

    results: list[dict[str, Any]] = []
    concurrency_values = (1,) if args.quick else (1, 2, 4)
    for scenario in scenarios(quick=args.quick):
        if scenario.expected_status == 413:
            scenario_concurrency = (1,)
        elif scenario.name == "multipart-max-envelope" and not args.quick:
            scenario_concurrency = (*concurrency_values, 8)
        else:
            scenario_concurrency = concurrency_values
        for concurrency in scenario_concurrency:
            rss_result = run_subprocess_worker(
                scenario,
                concurrency=concurrency,
                trace_allocations=False,
            )
            allocation_result = run_subprocess_worker(
                scenario,
                concurrency=concurrency,
                trace_allocations=True,
            )
            rss_result["python_allocation_peak_mib"] = allocation_result[
                "python_allocation_peak_mib"
            ]
            results.append(rss_result)

    failed = [
        result
        for result in results
        if not result["status_ok"] or not result["byte_integrity_ok"]
    ]
    if args.json:
        print(json.dumps(results, indent=2, sort_keys=True))
    else:
        print(render_markdown(results))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
