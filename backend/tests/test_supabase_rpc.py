from __future__ import annotations

import unittest

from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.supabase_rpc import execute_required_rpc


class _RpcCall:
    def __init__(self, error: PostgrestAPIError):
        self.error = error

    def execute(self):
        raise self.error


class _RpcSupabase:
    def __init__(self, error: PostgrestAPIError):
        self.error = error

    def rpc(self, _name: str, _params: dict):
        return _RpcCall(self.error)


class SupabaseRpcTest(unittest.TestCase):
    def test_missing_required_rpc_raises_migration_error(self):
        supabase = _RpcSupabase(PostgrestAPIError({
            "code": "PGRST202",
            "message": "Could not find the function public.claim_student_import_run in the schema cache",
            "details": "",
            "hint": "",
        }))

        with self.assertRaises(RuntimeError) as raised:
            execute_required_rpc(supabase, "claim_student_import_run", {})
        self.assertIn("Apply the database migrations", str(raised.exception))

    def test_non_missing_rpc_error_is_not_swallowed(self):
        supabase = _RpcSupabase(PostgrestAPIError({
            "code": "42501",
            "message": "permission denied for function claim_student_import_run",
            "details": "",
            "hint": "",
        }))

        with self.assertRaises(PostgrestAPIError):
            execute_required_rpc(supabase, "claim_student_import_run", {})


if __name__ == "__main__":
    unittest.main()
