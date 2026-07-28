import asyncio
import time
from typing import Optional

from supabase import AsyncClient, Client, acreate_client, create_client
from supabase.client import ClientOptions
from supabase.lib.client_options import AsyncClientOptions
from app.core.config import get_settings

_client: Optional[Client] = None


class DeadlineBoundSupabaseClient:
    """Run evaluator RPCs on a cancellable private async client and loop."""

    def __init__(
        self,
        url: str,
        service_role_key: str,
        *,
        postgrest_client_timeout: float,
        async_client_factory=acreate_client,
        clock=time.monotonic,
    ) -> None:
        self._url = url
        self._service_role_key = service_role_key
        self._postgrest_client_timeout = postgrest_client_timeout
        self._async_client_factory = async_client_factory
        self._clock = clock

    async def _execute_rpc(
        self,
        name: str,
        params: dict,
        remaining_seconds: float,
    ):
        async with asyncio.timeout(remaining_seconds):
            client: AsyncClient = await self._async_client_factory(
                self._url,
                self._service_role_key,
                options=AsyncClientOptions(
                    postgrest_client_timeout=self._postgrest_client_timeout,
                ),
            )
            try:
                return await client.rpc(name, params).execute()
            finally:
                await client.postgrest.aclose()

    def execute_rpc_with_deadline(
        self,
        name: str,
        params: dict,
        deadline_monotonic: float,
    ):
        remaining = deadline_monotonic - self._clock()
        if remaining <= 0:
            raise TimeoutError("operational alert RPC deadline exceeded")
        return asyncio.run(self._execute_rpc(name, params, remaining))


def create_supabase_client() -> Client:
    """Create an isolated Supabase admin client."""
    settings = get_settings()
    settings.validate_supabase_service_role_configuration()
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


def create_operational_alert_supabase_client(
    *,
    postgrest_client_timeout: float,
) -> DeadlineBoundSupabaseClient:
    settings = get_settings()
    settings.validate_supabase_service_role_configuration()
    if postgrest_client_timeout <= 0:
        raise ValueError("postgrest_client_timeout must be positive")
    return DeadlineBoundSupabaseClient(
        settings.SUPABASE_URL,
        settings.SUPABASE_SERVICE_ROLE_KEY,
        postgrest_client_timeout=postgrest_client_timeout,
    )


def create_supabase_readiness_client(*, timeout_seconds: float) -> Client:
    """Create an isolated admin client with a bounded PostgREST timeout."""
    settings = get_settings()
    return create_client(
        settings.SUPABASE_URL,
        settings.SUPABASE_SERVICE_ROLE_KEY,
        options=ClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            postgrest_client_timeout=timeout_seconds,
        ),
    )


def get_supabase_client() -> Client:
    """
    Get the Supabase admin client (service role).
    Uses a singleton pattern to avoid recreating the client.
    """
    global _client
    if _client is None:
        _client = create_supabase_client()
    return _client
