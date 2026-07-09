from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
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


async def http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
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


async def unhandled_exception_handler(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=error_response_payload(
            detail="Internal server error.",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            code="internal_server_error",
        ),
    )


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, request_validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
