import asyncio
import time
from typing import Optional

from supabase import AsyncClient, Client, acreate_client, create_client
from supabase.lib.client_options import AsyncClientOptions
from app.core.config import get_settings

_client: Optional[Client] = None

class SupabaseClientCleanupError(RuntimeError):
    """Raised after every initialized synchronous client transport was closed."""

    def __init__(self, failures: list[BaseException]) -> None:
        self.failures = tuple(failures)
        self.causes = self.failures
        super().__init__(
            f"supabase client cleanup failed for {len(failures)} transport(s)"
        )


def close_supabase_client(client: Client) -> None:
    """Close a Supabase 2.9.0 synchronous client without initializing clients.

    The sync SDK keeps PostgREST, Storage, and Functions clients lazy.  These
    private attributes and transport methods are intentionally pinned to the
    installed ``supabase==2.9.0`` dependency shape.
    """
    close_operations: list[tuple[str, object]] = [("auth", client.auth.close)]

    postgrest = client._postgrest
    if postgrest is not None:
        close_operations.append(("postgrest", postgrest.aclose))

    storage = client._storage
    if storage is not None:
        close_operations.append(("storage", storage.aclose))

    functions = client._functions
    if functions is not None:
        close_operations.append(("functions", functions._client.close))

    failures: list[BaseException] = []
    for _name, close in close_operations:
        try:
            close()
        except BaseException as exc:
            failures.append(exc)

    if failures:
        raise SupabaseClientCleanupError(failures) from failures[0]


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


def get_supabase_client() -> Client:
    """Legacy owner-run CLI accessor; request paths use the runtime instead."""
    global _client
    if _client is None:
        _client = create_supabase_client()
    return _client


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
