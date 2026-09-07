import asyncio
from types import SimpleNamespace
import pytest
from app.core.request_deadline import RequestDeadlineMiddleware, is_bulk_request, request_deadline


def run(app, *, budget=0.025, path="/api/v1/students/private-id"):
    messages = []
    async def receive(): return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message): messages.append(message)
    async def invoke():
        scope = {"type": "http", "method": "GET", "path": path, "route": SimpleNamespace(path="/api/v1/students/{student_id}")}
        try: await RequestDeadlineMiddleware(app, interactive_seconds=budget)(scope, receive, send)
        finally: assert request_deadline.get() is None
    return invoke, messages


def test_total_deadline_covers_multiple_individually_fast_stages(caplog):
    async def app(_scope, _receive, send):
        assert request_deadline.get() is not None
        await asyncio.sleep(0.02)
        await asyncio.sleep(0.02)
        await send({"type": "http.response.start", "status": 200, "headers": []})
    invoke, messages = run(app)
    with caplog.at_level("INFO", logger="uvicorn.error.request_timing"): asyncio.run(invoke())
    assert messages[0]["status"] == 504
    assert "private-id" not in caplog.text
    assert "/students/{student_id}" in caplog.text


def test_stalled_body_ends_without_sending_a_second_response():
    async def app(_scope, _receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"partial", "more_body": True})
        await asyncio.sleep(0.1)
    invoke, messages = run(app)
    with pytest.raises(TimeoutError): asyncio.run(invoke())
    assert len([m for m in messages if m["type"] == "http.response.start"]) == 1


def test_completed_body_allows_cleanup_and_preserves_existing_timing_headers():
    cleaned = []
    async def app(_scope, _receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"server-timing", b"koaryu_facts;dur=1")]})
        await send({"type": "http.response.body", "body": b"{}", "more_body": False})
        assert request_deadline.get() is None
        await asyncio.sleep(0.05)
        cleaned.append(True)
    invoke, messages = run(app)
    asyncio.run(invoke())
    assert cleaned == [True]
    assert (b"server-timing", b"koaryu_facts;dur=1") in messages[0]["headers"]
    assert any(value.startswith(b"koaryu_request;") for key, value in messages[0]["headers"] if key == b"server-timing")


@pytest.mark.parametrize("path,method,bulk", [
    ("/students/import/execute", "POST", True), ("/students/bulk/archive", "POST", True),
    ("/reports/exports/attendance", "GET", True), ("/schedule/window/materialize", "POST", True),
    ("/schedule/window", "GET", False), ("/billing/landing", "GET", False),
])
def test_workload_classes(path, method, bulk):
    assert is_bulk_request(path, method) is bulk
