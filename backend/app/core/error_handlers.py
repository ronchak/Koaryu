from __future__ import annotations

from collections.abc import Iterable
import json
import logging
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.utils import is_body_allowed_for_status_code
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException


logger = logging.getLogger(__name__)


ERROR_REFERENCE_HEADER = "X-Koaryu-Error-Reference"
UNHANDLED_EXCEPTION_EVENT = "backend.uncaught_exception"
SAFE_HTTP_METHODS = frozenset({"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"})


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
        "Access-Control-Expose-Headers": ERROR_REFERENCE_HEADER,
        "Vary": "Origin",
    }


def _safe_route_template(request: Request) -> str:
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    if (
        not isinstance(route_path, str)
        or not route_path.startswith("/")
        or "?" in route_path
        or "#" in route_path
        or len(route_path) > 256
    ):
        return "<unmatched>"
    return route_path


def _safe_http_method(request: Request) -> str:
    method = request.method.upper()
    return method if method in SAFE_HTTP_METHODS else "OTHER"


def _emit_unhandled_exception_event(
    request: Request,
    exc: Exception,
    *,
    error_reference: str,
) -> None:
    event = {
        "error_reference": error_reference,
        "event": UNHANDLED_EXCEPTION_EVENT,
        "exception_type": type(exc).__name__,
        "http_method": _safe_http_method(request),
        "route_template": _safe_route_template(request),
    }
    logger.error(
        json.dumps(event, separators=(",", ":"), sort_keys=True),
        extra=event,
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    error_reference = f"err_{uuid4().hex}"
    _emit_unhandled_exception_event(
        request,
        exc,
        error_reference=error_reference,
    )
    headers = _unhandled_error_cors_headers(request)
    headers[ERROR_REFERENCE_HEADER] = error_reference
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=error_response_payload(
            detail="Internal server error.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            code="internal_server_error",
        ),
        headers=headers,
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

        validation_detail_schema = schemas.get("ValidationError")
        if isinstance(validation_detail_schema, dict):
            properties = validation_detail_schema.get("properties")
            if isinstance(properties, dict):
                properties.pop("input", None)
                properties.pop("ctx", None)
            validation_detail_schema["required"] = ["loc", "msg", "type"]

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
