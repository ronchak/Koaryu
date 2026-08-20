import inspect
from typing import Any, Awaitable, Callable, Literal, Optional, TypeVar

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.concurrency import run_in_threadpool
from app.core.security import get_user_id_from_token
from app.db.supabase import (
    DeadlineBoundSupabaseClient,
    create_operational_alert_supabase_client,
)
from app.core.provider_lane import (
    ProviderLaneOperationTimeoutError,
    ProviderLaneSaturatedError,
)
from app.core.provider_runtime import SupabaseProviderRuntime
from app.services.studio_scope import (
    resolve_belt_configuration_admin_staff_role_for_user,
    resolve_lead_conversion_manager_staff_role_for_user,
    resolve_lead_manager_staff_role_for_user,
    resolve_promotion_manager_staff_role_for_user,
    resolve_roster_schedule_manager_staff_role_for_user,
    resolve_staff_role_for_user,
    resolve_write_staff_role_for_user,
)
from supabase import Client

security = HTTPBearer(auto_error=False)
ACTIVE_STUDIO_COOKIE = "koaryu-active-studio"
AUTHENTICATION_REQUIRED_DETAIL = "Invalid authentication token"
OPERATIONAL_ALERT_POSTGREST_TIMEOUT_SECONDS = 1.5
PROVIDER_CAPACITY_UNAVAILABLE_DETAIL = "Provider capacity is temporarily unavailable."
PROVIDER_OPERATION_TIMEOUT_DETAIL = "Provider operation timed out."
ProviderDependency = Client | SupabaseProviderRuntime[Any]
ProviderLaneName = Literal["interactive", "bulk"]
ResultT = TypeVar("ResultT")


def _authentication_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=AUTHENTICATION_REQUIRED_DETAIL,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _normalized_requested_studio_id(value: Optional[str]) -> Optional[str]:
    normalized = value.strip() if value else None
    return normalized or None


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> str:
    """
    FastAPI dependency that extracts and validates the user ID from
    the Authorization Bearer token.
    """
    if credentials is None or not credentials.credentials:
        raise _authentication_exception()
    # JWKS verification can perform a bounded synchronous provider request on a
    # cold cache or key rotation. Keep that I/O off the ASGI event loop.
    return await run_in_threadpool(get_user_id_from_token, credentials.credentials)


async def get_supabase(request: Request) -> ProviderDependency:
    """Return the app-owned runtime; tests may override this with a fake Client."""
    return request.app.state.supabase_provider_runtime


async def run_supabase_operation(
    provider: ProviderDependency,
    operation: Callable[[Client], ResultT | Awaitable[ResultT]],
    *,
    lane: ProviderLaneName = "interactive",
) -> ResultT:
    """Run provider work on the owned lane or inline for fake-client overrides."""
    if isinstance(provider, SupabaseProviderRuntime):
        try:
            run = provider.run_bulk if lane == "bulk" else provider.run_interactive
            return await run(operation)
        except ProviderLaneSaturatedError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=PROVIDER_CAPACITY_UNAVAILABLE_DETAIL,
                headers={"Retry-After": "1"},
            ) from exc
        except ProviderLaneOperationTimeoutError as exc:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail=PROVIDER_OPERATION_TIMEOUT_DETAIL,
                headers={"Retry-After": "1"},
            ) from exc

    result = operation(provider)
    if inspect.isawaitable(result):
        return await result
    return result


async def get_operational_alert_supabase() -> DeadlineBoundSupabaseClient:
    """Provide an isolated client whose RPC timeout fits the evaluator budget."""
    return create_operational_alert_supabase_client(
        postgrest_client_timeout=OPERATIONAL_ALERT_POSTGREST_TIMEOUT_SECONDS,
    )


async def get_requested_studio_id(
    request: Request,
    studio_id_header: Optional[str] = Header(None, alias="X-Studio-Id"),
) -> Optional[str]:
    """
    Return an optional active-studio selector from request state.

    This value is not tenant identity proof. It only selects which membership
    the authenticated user wants to operate in; service dependencies must pass
    it through studio_scope resolution before using it for data access.
    """
    requested_from_header = _normalized_requested_studio_id(studio_id_header)
    if requested_from_header:
        return requested_from_header
    return _normalized_requested_studio_id(request.cookies.get(ACTIVE_STUDIO_COOKIE))


async def get_current_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    """
    FastAPI dependency that resolves the studio_id for the current user.
    Prefers an explicitly requested studio when present and validates that the
    user belongs to it. Falls back to a deterministic membership when the
    request does not yet carry active studio state.
    """
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]


async def get_current_write_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_write_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]


async def get_current_write_staff_role(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> dict:
    return await run_supabase_operation(
        provider,
        lambda client: resolve_write_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )


async def get_roster_schedule_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_roster_schedule_manager_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]


async def get_belt_configuration_admin_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_belt_configuration_admin_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]


async def get_promotion_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_promotion_manager_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]


async def get_lead_conversion_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_lead_conversion_manager_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]


async def get_lead_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    provider: ProviderDependency = Depends(get_supabase),
) -> str:
    membership = await run_supabase_operation(
        provider,
        lambda client: resolve_lead_manager_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        ),
    )
    return membership["studio_id"]
