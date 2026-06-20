from __future__ import annotations

from typing import Any, Callable, Optional

from postgrest.exceptions import APIError as PostgrestAPIError


MISSING_RPC_CODES = {"PGRST202", "42883"}


def rpc_method(supabase: Any) -> Optional[Callable[[str, dict[str, Any]], Any]]:
    method = getattr(supabase, "rpc", None)
    return method if callable(method) else None


def execute_required_rpc(supabase: Any, name: str, params: dict[str, Any]) -> Any:
    method = rpc_method(supabase)
    if not method:
        raise RuntimeError(f"Supabase RPC {name} is required but the client does not expose rpc().")
    try:
        return method(name, params).execute()
    except PostgrestAPIError as exc:
        if _is_missing_rpc_function(exc, name):
            raise RuntimeError(
                f"Supabase RPC {name} is required. Apply the database migrations before starting this backend."
            ) from exc
        raise


def _is_missing_rpc_function(exc: PostgrestAPIError, name: str) -> bool:
    code = getattr(exc, "code", None)
    if code not in MISSING_RPC_CODES:
        return False
    message = (getattr(exc, "message", None) or str(exc)).lower()
    return name.lower() in message or "schema cache" in message or "could not find the function" in message


def rpc_rows(result: Any) -> list[dict[str, Any]]:
    data = getattr(result, "data", None)
    if data is None:
        return []
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        return [data]
    return []


def first_rpc_row(result: Any) -> Optional[dict[str, Any]]:
    rows = rpc_rows(result)
    return rows[0] if rows else None
