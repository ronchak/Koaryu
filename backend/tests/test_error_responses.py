import unittest

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.error_handlers import (
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

    def test_main_app_registers_normalized_error_handlers(self):
        self.assertIs(app.exception_handlers[StarletteHTTPException], http_exception_handler)
        self.assertIs(app.exception_handlers[RequestValidationError], request_validation_exception_handler)
        self.assertIs(app.exception_handlers[Exception], unhandled_exception_handler)


if __name__ == "__main__":
    unittest.main()
