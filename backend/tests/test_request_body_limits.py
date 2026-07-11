import asyncio
import unittest

from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.request_body_limits import (
    CSV_IMPORT_MAPPING_JSON_MAX_BYTES,
    CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES,
    CSV_IMPORT_REQUEST_MAX_BYTES,
    DEFAULT_API_REQUEST_MAX_BYTES,
    RequestBodyLimitMiddleware,
    STRIPE_WEBHOOK_REQUEST_MAX_BYTES,
    STUDENT_PHOTO_REQUEST_MAX_BYTES,
    request_body_limit_for_route,
)
from app.core.upload_limits import (
    CSV_IMPORT_MAX_BYTES,
    CSV_IMPORT_MAX_CELL_CHARS,
    CSV_IMPORT_MAX_COLUMNS,
)
from app.main import app


class RequestBodyLimitTest(unittest.TestCase):
    def test_route_limits_cover_public_upload_and_webhook_ingress(self):
        prefix = "/api/v1"
        for action in ("parse", "validate", "execute"):
            self.assertEqual(
                request_body_limit_for_route(
                    path=f"{prefix}/students/import/{action}",
                    method="POST",
                    api_v1_prefix=prefix,
                ),
                CSV_IMPORT_REQUEST_MAX_BYTES,
            )
        self.assertEqual(
            request_body_limit_for_route(
                path=f"{prefix}/students/student-1/photo",
                method="POST",
                api_v1_prefix=prefix,
            ),
            STUDENT_PHOTO_REQUEST_MAX_BYTES,
        )
        self.assertEqual(
            request_body_limit_for_route(
                path=f"{prefix}/webhooks/stripe/connect",
                method="POST",
                api_v1_prefix=prefix,
            ),
            STRIPE_WEBHOOK_REQUEST_MAX_BYTES,
        )
        self.assertIsNone(
            request_body_limit_for_route(
                path=f"{prefix}/students",
                method="GET",
                api_v1_prefix=prefix,
            )
        )
        self.assertIsNone(
            request_body_limit_for_route(
                path="/api/v1-unrelated/students",
                method="POST",
                api_v1_prefix=prefix,
            )
        )
        for method in ("POST", "PATCH", "PUT", "DELETE"):
            self.assertEqual(
                request_body_limit_for_route(
                    path=f"{prefix}/students/student-1",
                    method=method,
                    api_v1_prefix=prefix,
                ),
                DEFAULT_API_REQUEST_MAX_BYTES,
            )

    def test_csv_envelope_covers_worst_case_json_escaped_header_mapping(self):
        self.assertEqual(
            CSV_IMPORT_MAPPING_JSON_MAX_BYTES,
            CSV_IMPORT_MAX_COLUMNS * CSV_IMPORT_MAX_CELL_CHARS * 6,
        )
        self.assertEqual(
            CSV_IMPORT_REQUEST_MAX_BYTES,
            CSV_IMPORT_MAX_BYTES
            + CSV_IMPORT_MAPPING_JSON_MAX_BYTES
            + CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES,
        )

    def test_valid_multipart_messages_are_replayed_downstream_byte_for_byte(self):
        boundary = b"browser-boundary"
        body = (
            b"--" + boundary
            + b'\r\nContent-Disposition: form-data; name="file"; filename="photo.png"'
            + b"\r\nContent-Type: image/png\r\n\r\n"
            + b"\x89PNG\r\n\x1a\nimage-bytes\r\n--"
            + boundary
            + b"--\r\n"
        )
        first_message = {"type": "http.request", "body": body[:37], "more_body": True}
        second_message = {"type": "http.request", "body": body[37:], "more_body": False}
        inbound = [first_message, second_message]
        replayed = []
        sent = []

        async def receive():
            return inbound.pop(0)

        async def send(message):
            sent.append(message)

        async def downstream(_scope, downstream_receive, downstream_send):
            while True:
                message = await downstream_receive()
                replayed.append(message)
                if not message.get("more_body", False):
                    break
            await downstream_send({"type": "http.response.start", "status": 204, "headers": []})
            await downstream_send({"type": "http.response.body", "body": b""})

        middleware = RequestBodyLimitMiddleware(downstream, api_v1_prefix="/api/v1")
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/api/v1/students/student-1/photo",
            "headers": [
                (b"content-type", b"multipart/form-data; boundary=" + boundary),
            ],
        }

        asyncio.run(middleware(scope, receive, send))

        self.assertEqual(b"".join(message.get("body", b"") for message in replayed), body)
        self.assertEqual([message.get("more_body", False) for message in replayed], [True, False])
        self.assertIs(replayed[0], first_message)
        self.assertIs(replayed[1], second_message)
        self.assertEqual(sent[0]["status"], 204)

    def test_valid_default_json_body_is_replayed_downstream_byte_for_byte(self):
        body = b'{"legal_first_name":"Aiko","legal_last_name":"Tanaka"}'
        first_message = {"type": "http.request", "body": body[:17], "more_body": True}
        second_message = {"type": "http.request", "body": body[17:], "more_body": False}
        inbound = [first_message, second_message]
        replayed = []
        sent = []

        async def receive():
            return inbound.pop(0)

        async def send(message):
            sent.append(message)

        async def downstream(_scope, downstream_receive, downstream_send):
            while True:
                message = await downstream_receive()
                replayed.append(message)
                if not message.get("more_body", False):
                    break
            await downstream_send({"type": "http.response.start", "status": 204, "headers": []})
            await downstream_send({"type": "http.response.body", "body": b""})

        middleware = RequestBodyLimitMiddleware(downstream, api_v1_prefix="/api/v1")
        scope = {
            "type": "http",
            "method": "PATCH",
            "path": "/api/v1/students/student-1",
            "headers": [(b"content-type", b"application/json")],
        }

        asyncio.run(middleware(scope, receive, send))

        self.assertEqual(b"".join(message["body"] for message in replayed), body)
        self.assertIs(replayed[0], first_message)
        self.assertIs(replayed[1], second_message)
        self.assertEqual(sent[0]["status"], 204)

    def test_bodyless_delete_is_replayed_without_changing_downstream_semantics(self):
        bodyless_message = {"type": "http.request", "body": b"", "more_body": False}
        inbound = [bodyless_message]
        replayed = []
        sent = []

        async def receive():
            return inbound.pop(0)

        async def send(message):
            sent.append(message)

        async def downstream(_scope, downstream_receive, downstream_send):
            replayed.append(await downstream_receive())
            await downstream_send({"type": "http.response.start", "status": 204, "headers": []})
            await downstream_send({"type": "http.response.body", "body": b""})

        middleware = RequestBodyLimitMiddleware(downstream, api_v1_prefix="/api/v1")
        scope = {
            "type": "http",
            "method": "DELETE",
            "path": "/api/v1/students/student-1",
            "headers": [],
        }

        asyncio.run(middleware(scope, receive, send))

        self.assertEqual(replayed, [bodyless_message])
        self.assertIs(replayed[0], bodyless_message)
        self.assertEqual(sent[0]["status"], 204)

    def test_backend_rejects_csv_content_length_before_auth_or_multipart_parsing(self):
        settings = get_settings()
        response = TestClient(app).post(
            "/api/v1/students/import/validate",
            content=b"x",
            headers={
                "Content-Length": str(CSV_IMPORT_REQUEST_MAX_BYTES + 1),
                "Content-Type": "multipart/form-data; boundary=unused",
                "Origin": settings.FRONTEND_URL,
            },
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")
        self.assertEqual(response.json()["error"], {"code": "http_413", "status_code": 413})
        self.assertEqual(response.headers["access-control-allow-origin"], settings.FRONTEND_URL)

    def test_backend_rejects_photo_content_length_before_auth_or_multipart_parsing(self):
        response = TestClient(app).post(
            "/api/v1/students/student-1/photo",
            content=b"x",
            headers={
                "Content-Length": str(STUDENT_PHOTO_REQUEST_MAX_BYTES + 1),
                "Content-Type": "multipart/form-data; boundary=unused",
            },
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")

    def test_backend_rejects_chunked_photo_before_downstream_multipart_parsing(self):
        def chunks():
            yield b"x" * STUDENT_PHOTO_REQUEST_MAX_BYTES
            yield b"x"

        response = TestClient(app).post(
            "/api/v1/students/student-1/photo",
            content=chunks(),
            headers={
                "Transfer-Encoding": "chunked",
                "Content-Type": "multipart/form-data; boundary=unused",
            },
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")

    def test_backend_default_rejects_declared_overflow_for_all_body_capable_methods(self):
        client = TestClient(app)
        cases = (
            ("POST", "/api/v1/students"),
            ("PATCH", "/api/v1/students/student-1"),
            ("PUT", "/api/v1/students/student-1"),
            ("DELETE", "/api/v1/students/student-1"),
        )

        for method, path in cases:
            with self.subTest(method=method):
                response = client.request(
                    method,
                    path,
                    content=b"{}",
                    headers={
                        "Content-Length": str(DEFAULT_API_REQUEST_MAX_BYTES + 1),
                        "Content-Type": "application/json",
                    },
                )
                self.assertEqual(response.status_code, 413)
                self.assertEqual(response.json()["detail"], "Request body is too large.")

    def test_backend_default_rejects_chunked_json_overflow(self):
        def chunks():
            yield b"x" * DEFAULT_API_REQUEST_MAX_BYTES
            yield b"x"

        response = TestClient(app).patch(
            "/api/v1/students/student-1",
            content=chunks(),
            headers={
                "Transfer-Encoding": "chunked",
                "Content-Type": "application/json",
            },
        )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Request body is too large.")


if __name__ == "__main__":
    unittest.main()
