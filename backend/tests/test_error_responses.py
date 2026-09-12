import unittest

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.deps import get_current_user_id, get_supabase
from app.core.error_handlers import (
    error_code_for_status,
    http_exception_handler,
    register_error_handlers,
    request_validation_exception_handler,
    unhandled_exception_handler,
)
from app.main import app


class ErrorResponseTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides[get_current_user_id] = lambda: "validation-contract-user"
        app.dependency_overrides[get_supabase] = lambda: object()

    def tearDown(self):
        app.dependency_overrides.clear()

    def assert_public_validation_detail(self, response):
        payload = response.json()
        self.assertEqual(
            payload["error"],
            {"code": "validation_error", "status_code": 422},
        )
        self.assertTrue(payload["detail"])
        for error in payload["detail"]:
            self.assertEqual(set(error), {"loc", "msg", "type"})

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

    def test_validation_errors_keep_public_fastapi_fields_with_metadata(self):
        class Payload(BaseModel):
            name: str

        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.post("/payload")
        async def payload(_payload: Payload):
            return {"ok": True}

        response = TestClient(test_app).post("/payload", json={})

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json(), {
            "detail": [{
                "loc": ["body", "name"],
                "msg": "Field required",
                "type": "missing",
            }],
            "error": {"code": "validation_error", "status_code": 422},
        })

    def test_main_app_validation_errors_preserve_missing_field_details(self):
        response = self.client.post("/api/v1/support/tickets", json={})

        self.assertEqual(response.status_code, 422)
        self.assert_public_validation_detail(response)
        self.assertEqual(
            {
                (tuple(error["loc"]), error["msg"], error["type"])
                for error in response.json()["detail"]
            },
            {
                (("body", "topic"), "Field required", "missing"),
                (("body", "subject"), "Field required", "missing"),
                (("body", "details"), "Field required", "missing"),
            },
        )

    def test_main_app_validation_errors_do_not_echo_secret_shaped_wrong_type_input(self):
        synthetic_secret = "sk_live_TEST_DO_NOT_USE_validation_echo"

        response = self.client.post(
            "/api/v1/support/tickets",
            json={
                "topic": "other",
                "subject": "Validation contract",
                "details": "Enough valid detail text.",
                "browser_context": synthetic_secret,
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assert_public_validation_detail(response)
        self.assertEqual(response.json()["detail"], [{
            "loc": ["body", "browser_context"],
            "msg": "Input should be a valid dictionary",
            "type": "dict_type",
        }])
        self.assertNotIn(synthetic_secret, response.text)

    def test_main_app_validation_errors_drop_rejected_body_and_error_context(self):
        synthetic_secret = "sk_live_TEST_DO_NOT_USE_validation_context"

        response = self.client.patch(
            "/api/v1/internal/support/tickets/11111111-1111-4111-8111-111111111111",
            json={"metadata": {"credential": synthetic_secret}},
        )

        self.assertEqual(response.status_code, 422)
        self.assert_public_validation_detail(response)
        self.assertEqual(response.json()["detail"], [{
            "loc": ["body"],
            "msg": "Value error, A status change or note is required.",
            "type": "value_error",
        }])
        self.assertNotIn(synthetic_secret, response.text)

    def test_unhandled_errors_return_user_safe_message(self):
        test_app = FastAPI()
        register_error_handlers(test_app)

        @test_app.get("/boom")
        async def boom():
            raise RuntimeError("provider leaked sk_live_secret")

        response = TestClient(test_app, raise_server_exceptions=False).get("/boom")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {
            "detail": "Internal server error.",
            "error": {"code": "internal_server_error", "status_code": 500},
        })
        self.assertNotIn("sk_live_secret", response.text)

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
        self.assertEqual(
            set(validation_detail["properties"]),
            {"loc", "msg", "type"},
        )
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
