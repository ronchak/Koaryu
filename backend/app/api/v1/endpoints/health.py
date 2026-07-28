import asyncio
import os
import re

from fastapi import APIRouter, HTTPException, Response, status

from app.core.config import get_settings
from app.db.supabase import create_supabase_readiness_client

router = APIRouter()
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
READINESS_CHECK_TIMEOUT_SECONDS = 2.0
SUPABASE_REQUEST_TIMEOUT_SECONDS = 1.5
READINESS_FAILURE_DETAIL = "Service is not ready."


def _safe_deployment_metadata() -> dict[str, str | None]:
    settings = get_settings()
    environment = settings.ENVIRONMENT.strip().lower()
    raw_commit = os.environ.get("RENDER_GIT_COMMIT", "").strip().lower()
    commit_sha = raw_commit if COMMIT_SHA_PATTERN.fullmatch(raw_commit) else None
    return {
        "environment": environment,
        "commit_sha": commit_sha,
    }


def _set_health_headers(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, max-age=0"


def _health_payload(state: str) -> dict[str, str | None]:
    return {
        "status": state,
        "version": "1.0.0",
        "service": "koaryu-api",
        **_safe_deployment_metadata(),
    }


def _probe_required_supabase_path_sync() -> None:
    client = create_supabase_readiness_client(
        timeout_seconds=SUPABASE_REQUEST_TIMEOUT_SECONDS
    )
    postgrest = client.postgrest
    try:
        client.table("studios").select("id").limit(1).execute()
    finally:
        postgrest.session.close()


async def _probe_required_supabase_path() -> None:
    await asyncio.wait_for(
        asyncio.to_thread(_probe_required_supabase_path_sync),
        timeout=READINESS_CHECK_TIMEOUT_SECONDS,
    )


@router.get("/health")
@router.get("/health/live")
async def health_live(response: Response):
    """Return process liveness and safe deployment identity metadata."""
    _set_health_headers(response)
    return _health_payload("ok")


@router.head("/health", include_in_schema=False)
@router.head("/health/live", include_in_schema=False)
async def health_live_head(response: Response):
    return await health_live(response)


@router.get("/health/ready")
async def health_ready(response: Response):
    """Return readiness after checking configuration and the required database path."""
    _set_health_headers(response)
    try:
        get_settings().validate_runtime_configuration()
        await _probe_required_supabase_path()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=READINESS_FAILURE_DETAIL,
            headers={"Cache-Control": "no-store, max-age=0"},
        ) from exc
    return _health_payload("ready")


@router.head("/health/ready", include_in_schema=False)
async def health_ready_head(response: Response):
    return await health_ready(response)
