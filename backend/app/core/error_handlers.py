from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.utils import is_body_allowed_for_status_code
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException


class ErrorMeta(BaseModel):
    code: str
    status_code: int


class ErrorResponse(BaseModel):
    detail: Any
    error: ErrorMeta


STATUS_ERROR_CODES = {
    status.HTTP_400_BAD_REQUEST: "bad_request",
    status.HTTP_401_UNAUTHORIZED: "unauthorized",
    status.HTTP_402_PAYMENT_REQUIRED: "payment_required",
    status.HTTP_403_FORBIDDEN: "forbidden",
    status.HTTP_404_NOT_FOUND: "not_found",
    status.HTTP_409_CONFLICT: "conflict",
    status.HTTP_422_UNPROCESSABLE_ENTITY: "validation_error",
    status.HTTP_429_TOO_MANY_REQUESTS: "rate_limited",
    status.HTTP_500_INTERNAL_SERVER_ERROR: "internal_server_error",
    status.HTTP_503_SERVICE_UNAVAILABLE: "service_unavailable",
}


def error_code_for_status(status_code: int) -> str:
    return STATUS_ERROR_CODES.get(status_code, f"http_{status_code}")


def error_response_payload(
    *,
    detail: Any,
    status_code: int,
    code: str | None = None,
) -> dict[str, Any]:
    return {
        "detail": jsonable_encoder(detail),
        "error": {
            "code": code or error_code_for_status(status_code),
            "status_code": status_code,
        },
    }


async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> Response:
    if not is_body_allowed_for_status_code(exc.status_code):
        return Response(status_code=exc.status_code, headers=exc.headers)
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response_payload(detail=exc.detail, status_code=exc.status_code),
        headers=exc.headers,
    )


async def request_validation_exception_handler(
    _request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=error_response_payload(
            detail=exc.errors(),
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code="validation_error",
        ),
    )


def _unhandled_error_cors_headers(request: Request) -> dict[str, str]:
    origin = request.headers.get("origin")
    allowed_origins = getattr(request.app.state, "normalized_error_cors_origins", frozenset())
    if not origin or origin not in allowed_origins:
        return {}
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Vary": "Origin",
    }


async def unhandled_exception_handler(request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=error_response_payload(
            detail="Internal server error.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            code="internal_server_error",
        ),
        headers=_unhandled_error_cors_headers(request),
    )


def _install_error_openapi_contract(app: FastAPI) -> None:
    original_openapi = app.openapi

    def normalized_error_openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema

        schema = original_openapi()
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        error_response_schema = ErrorResponse.model_json_schema(
            ref_template="#/components/schemas/{model}",
        )
        for name, definition in (error_response_schema.pop("$defs", {}) or {}).items():
            schemas[name] = definition
        schemas["ErrorResponse"] = error_response_schema

        validation_schema = schemas.get("HTTPValidationError")
        if isinstance(validation_schema, dict):
            validation_schema.setdefault("properties", {})["error"] = {
                "$ref": "#/components/schemas/ErrorMeta",
            }
            required = validation_schema.setdefault("required", [])
            if "error" not in required:
                required.append("error")

        for path_item in (schema.get("paths") or {}).values():
            if not isinstance(path_item, dict):
                continue
            for operation in path_item.values():
                if not isinstance(operation, dict) or "responses" not in operation:
                    continue
                operation["responses"].setdefault(
                    "default",
                    {
                        "description": "Normalized error response",
                        "content": {
                            "application/json": {
                                "schema": {"$ref": "#/components/schemas/ErrorResponse"},
                            },
                        },
                    },
                )

        app.openapi_schema = schema
        return schema

    app.openapi = normalized_error_openapi  # type: ignore[method-assign]


def register_error_handlers(
    app: FastAPI,
    *,
    cors_allowed_origins: Iterable[str] = (),
) -> None:
    app.state.normalized_error_cors_origins = frozenset(cors_allowed_origins)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, request_validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
    _install_error_openapi_contract(app)
