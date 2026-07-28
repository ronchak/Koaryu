import json
import unittest

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.error_handlers import (
    ERROR_REFERENCE_HEADER,
    UNHANDLED_EXCEPTION_EVENT,
    error_code_for_status,
    http_exception_handler,
    register_error_handlers,
    request_validation_exception_handler,
    unhandled_exception_handler,
)
from app.main import app


class ErrorResponseTest(unittest.TestCase):
    def test_status_codes_map_to_stable_error_codes(self):
        self.assertEqual(error_code_for_status(400), "bad_request")
        self.assertEqual(error_code_for_status(401), "unauthorized")
        self.assertEqual(error_code_for_status(404), "not_found")
        self.assertEqual(error_code_for_status(409), "conflict")
        self.assertEqual(error_code_for_status(499), "http_499")

    def test_http_exception_preserves_detail_and_adds_error_metadata(self):
        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.get("/missing")
        async def missing():
            raise HTTPException(status_code=404, detail="Student not found.")

        response = TestClient(test_app).get("/missing")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {
            "detail": "Student not found.",
            "error": {"code": "not_found", "status_code": 404},
        })

    def test_http_exception_preserves_structured_detail_payloads(self):
        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.get("/structured")
        async def structured():
            raise HTTPException(status_code=409, detail={"failed": 1})

        response = TestClient(test_app).get("/structured")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], {"failed": 1})
        self.assertEqual(response.json()["error"], {"code": "conflict", "status_code": 409})

    def test_http_exception_keeps_bodyless_statuses_empty(self):
        for status_code in (204, 304):
            with self.subTest(status_code=status_code):
                test_app = FastAPI()
                register_error_handlers(test_app)

                @test_app.get("/bodyless")
                async def bodyless():
                    raise HTTPException(
                        status_code=status_code,
                        detail="must not be serialized",
                        headers={"X-Koaryu-Test": "preserved"},
                    )

                response = TestClient(test_app).get("/bodyless")

                self.assertEqual(response.status_code, status_code)
                self.assertEqual(response.content, b"")
                self.assertEqual(response.headers["X-Koaryu-Test"], "preserved")

    def test_validation_errors_keep_fastapi_detail_shape_with_metadata(self):
        class Payload(BaseModel):
            name: str

        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.post("/payload")
        async def payload(_payload: Payload):
            return {"ok": True}

        response = TestClient(test_app).post("/payload", json={})

        self.assertEqual(response.status_code, 422)
        self.assertIsInstance(response.json()["detail"], list)
        self.assertEqual(response.json()["error"], {"code": "validation_error", "status_code": 422})

    def test_unhandled_errors_return_user_safe_message_and_correlatable_event(self):
        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.get("/boom")
        async def boom():
            raise RuntimeError("provider leaked sk_live_secret")

        with self.assertLogs("app.core.error_handlers", level="ERROR") as captured_logs:
            response = TestClient(test_app, raise_server_exceptions=False).get("/boom")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {
            "detail": "Internal server error.",
            "error": {"code": "internal_server_error", "status_code": 500},
        })
        self.assertNotIn("sk_live_secret", response.text)
        self.assertRegex(response.headers[ERROR_REFERENCE_HEADER], r"^err_[0-9a-f]{32}$")

        self.assertEqual(len(captured_logs.records), 1)
        log_record = captured_logs.records[0]
        event = json.loads(log_record.getMessage())
        self.assertEqual(event, {
            "error_reference": response.headers[ERROR_REFERENCE_HEADER],
            "event": UNHANDLED_EXCEPTION_EVENT,
            "exception_type": "RuntimeError",
            "http_method": "GET",
            "route_template": "/boom",
        })
        self.assertIsNone(log_record.exc_info)
        self.assertEqual(log_record.error_reference, response.headers[ERROR_REFERENCE_HEADER])
        self.assertNotIn("sk_live_secret", repr(log_record.__dict__))

    def test_unhandled_event_excludes_sensitive_request_context(self):
        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.post("/studios/{studio_id}/students/{student_id}/billing")
        async def boom(studio_id: str, student_id: str):
            raise RuntimeError(
                f"raw-provider-error tenant={studio_id} student={student_id} invoice=inv_private"
            )

        with self.assertLogs("app.core.error_handlers", level="ERROR") as captured_logs:
            response = TestClient(test_app, raise_server_exceptions=False).post(
                "/studios/studio_private/students/student_private/billing",
                params={"payer": "payer_private"},
                headers={
                    "Authorization": "Bearer auth_private",
                    "Cookie": "session=cookie_private",
                },
                json={"cardholder": "body_private"},
            )

        self.assertEqual(response.status_code, 500)
        event = json.loads(captured_logs.records[0].getMessage())
        self.assertEqual(set(event), {
            "error_reference",
            "event",
            "exception_type",
            "http_method",
            "route_template",
        })
        self.assertEqual(event["route_template"], "/studios/{studio_id}/students/{student_id}/billing")
        self.assertEqual(event["http_method"], "POST")
        self.assertEqual(event["exception_type"], "RuntimeError")
        self.assertEqual(event["error_reference"], response.headers[ERROR_REFERENCE_HEADER])

        emitted_context = repr(captured_logs.records[0].__dict__)
        response_context = repr((response.text, dict(response.headers)))
        for sensitive_value in (
            "raw-provider-error",
            "studio_private",
            "student_private",
            "inv_private",
            "payer_private",
            "auth_private",
            "cookie_private",
            "body_private",
        ):
            with self.subTest(sensitive_value=sensitive_value):
                self.assertNotIn(sensitive_value, emitted_context)
                self.assertNotIn(sensitive_value, response_context)

    def test_unhandled_errors_preserve_cors_for_allowed_browser_origin(self):
        allowed_origin = "https://app.koaryu.test"
        test_app = FastAPI()
        register_error_handlers(test_app, cors_allowed_origins={allowed_origin})
        test_app.add_middleware(
            CORSMiddleware,
            allow_origins=[allowed_origin],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        @test_app.get("/boom")
        async def boom():
            raise RuntimeError("provider failure")

        response = TestClient(test_app, raise_server_exceptions=False).get(
            "/boom",
            headers={"Origin": allowed_origin},
        )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], allowed_origin)
        self.assertEqual(response.headers["Access-Control-Allow-Credentials"], "true")
        self.assertIn(
            ERROR_REFERENCE_HEADER.lower(),
            response.headers["Access-Control-Expose-Headers"].lower(),
        )
        self.assertIn("Origin", response.headers["Vary"])

    def test_openapi_documents_normalized_error_metadata(self):
        schema = app.openapi()
        error_response = schema["components"]["schemas"]["ErrorResponse"]
        validation_error = schema["components"]["schemas"]["HTTPValidationError"]
        validation_detail = schema["components"]["schemas"]["ValidationError"]

        self.assertEqual(
            error_response["properties"]["error"]["$ref"],
            "#/components/schemas/ErrorMeta",
        )
        self.assertIn("error", validation_error["required"])
        self.assertEqual(
            validation_error["properties"]["error"]["$ref"],
            "#/components/schemas/ErrorMeta",
        )
        self.assertEqual(validation_detail["required"], ["loc", "msg", "type"])
        self.assertNotIn("input", validation_detail["properties"])
        self.assertNotIn("ctx", validation_detail["properties"])
        self.assertEqual(
            schema["paths"]["/api/v1/auth/me"]["get"]["responses"]["default"]["content"]
            ["application/json"]["schema"]["$ref"],
            "#/components/schemas/ErrorResponse",
        )

    def test_main_app_registers_normalized_error_handlers(self):
        self.assertIs(app.exception_handlers[StarletteHTTPException], http_exception_handler)
        self.assertIs(app.exception_handlers[RequestValidationError], request_validation_exception_handler)
        self.assertIs(app.exception_handlers[Exception], unhandled_exception_handler)


if __name__ == "__main__":
    unittest.main()
