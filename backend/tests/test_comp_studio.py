from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from io import StringIO
from pathlib import Path
import re
import threading
import unittest
from contextlib import redirect_stderr

from gotrue.types import User, UserResponse
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.studio_scope import _platform_subscription_access_from_row
from scripts import comp_studio
from tests.fakes.supabase import RpcBackedSupabase


COMP_MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "supabase"
    / "migrations"
    / "20260727100000_atomic_studio_comp_management.sql"
)

STUDIO_ID = "11111111-1111-4111-8111-111111111111"
ACTOR_ID = "22222222-2222-4222-8222-222222222222"
OTHER_ACTOR_ID = "33333333-3333-4333-8333-333333333333"


def auth_user(
    user_id: str,
    email: str | None,
) -> User:
    now = datetime(2026, 7, 27, tzinfo=timezone.utc)
    return User(
        id=user_id,
        app_metadata={},
        user_metadata={},
        aud="authenticated",
        email=email,
        created_at=now,
        updated_at=now,
    )


class FakeAuthAdmin:
    def __init__(self, users: list[User]):
        self.users = users
        self.get_calls: list[str] = []
        self.list_calls: list[tuple[int, int]] = []

    def get_user_by_id(self, user_id: str) -> UserResponse:
        self.get_calls.append(user_id)
        matches = [user for user in self.users if str(user.id) == user_id]
        if not matches:
            raise RuntimeError("User not found")
        return UserResponse(user=matches[0])

    def list_users(self, page: int, per_page: int) -> list[User]:
        self.list_calls.append((page, per_page))
        start = (page - 1) * per_page
        return self.users[start:start + per_page]


class FakeAuth:
    def __init__(self, users: list[User]):
        self.admin = FakeAuthAdmin(users)


class CompSupabase(RpcBackedSupabase):
    def __init__(
        self,
        *,
        studios: list[dict] | None = None,
        subscriptions: list[dict] | None = None,
        users: list[User] | None = None,
    ):
        super().__init__({
            "studios": studios if studios is not None else [{
                "id": STUDIO_ID,
                "name": "Koaryu Test",
                "slug": "koaryu-test",
            }],
            "studio_subscriptions": subscriptions if subscriptions is not None else [{
                "studio_id": STUDIO_ID,
                "status": "incomplete",
                "comped": False,
                "stripe_subscription_id": None,
                "metadata": {},
            }],
            "audit_logs": [],
        })
        self.auth = FakeAuth(users or [auth_user(ACTOR_ID, "owner@example.com")])
        self.transaction_lock = threading.RLock()
        self.fail_audit_insert = False
        self.after_comp_update = None
        self.before_comp_lock = None

    def replace_subscription_metadata(self, replacement: dict) -> None:
        with self.transaction_lock:
            row = self.tables["studio_subscriptions"][0]
            metadata = deepcopy(replacement)
            previous_comp = (row.get("metadata") or {}).get("comp")
            if previous_comp is not None and metadata.get("comp") != previous_comp:
                metadata["comp"] = deepcopy(previous_comp)
            row["metadata"] = metadata

    def _rpc_set_studio_comp_atomic(self, params: dict) -> list[dict]:
        with self.transaction_lock:
            if self.before_comp_lock is not None:
                before_comp_lock = self.before_comp_lock
                self.before_comp_lock = None
                before_comp_lock()
            subscriptions_before = deepcopy(self.tables["studio_subscriptions"])
            audits_before = deepcopy(self.tables["audit_logs"])
            try:
                row = next(
                    (
                        item
                        for item in self.tables["studio_subscriptions"]
                        if item["studio_id"] == params["p_studio_id"]
                    ),
                    None,
                )
                if row is None:
                    raise RuntimeError("Studio subscription not found.")

                requested = params["p_comped"]
                has_subscription_id = (
                    isinstance(row.get("stripe_subscription_id"), str)
                    and bool(row["stripe_subscription_id"].strip())
                )
                has_live_subscription = (
                    has_subscription_id
                    and (row.get("status") or "")
                    in comp_studio.LIVE_STRIPE_SUBSCRIPTION_STATUSES
                )
                if (
                    requested
                    and has_live_subscription
                    and not params.get("p_allow_live_subscription", False)
                ):
                    raise PostgrestAPIError({
                        "code": comp_studio.LIVE_SUBSCRIPTION_REFUSAL_SQLSTATE,
                        "message": "Live Stripe subscription requires explicit override.",
                        "details": "",
                        "hint": "",
                    })

                flag_needs_change = bool(row["comped"]) != requested
                status_normalized = bool(
                    not requested
                    and row["status"] == "comped"
                    and not has_subscription_id
                )
                if not flag_needs_change and not status_normalized:
                    return [{
                        "outcome": "no_change",
                        "subscription_status": row["status"],
                        "comped": row["comped"],
                        "stripe_subscription_id": row.get("stripe_subscription_id"),
                        "metadata": deepcopy(row.get("metadata") or {}),
                        "status_normalized": False,
                        "provider_status_preserved": False,
                    }]

                previous = bool(row["comped"])
                provider_status_preserved = bool(
                    not requested
                    and row["status"] == "comped"
                    and has_subscription_id
                )
                metadata = deepcopy(row.get("metadata") or {})
                metadata["comp"] = {
                    "state": "granted" if requested else "revoked",
                    "reason": params["p_reason"],
                    "actor_id": params["p_actor_id"],
                    "actor_email": params["p_actor_email"],
                    "at": "2026-07-27T00:00:00+00:00",
                    "source": "comp_studio_cli",
                    "previous": previous,
                }
                row["metadata"] = metadata
                row["comped"] = requested
                if status_normalized:
                    row["status"] = "incomplete"

                if self.after_comp_update is not None:
                    self.after_comp_update()
                if self.fail_audit_insert:
                    raise RuntimeError("forced comp audit failure")

                self.tables["audit_logs"].append({
                    "studio_id": row["studio_id"],
                    "actor_id": params["p_actor_id"],
                    "action": (
                        "platform_comp.granted"
                        if requested
                        else "platform_comp.revoked"
                    ),
                    "entity_type": "studio_subscription",
                    "entity_id": row["studio_id"],
                    "metadata": {
                        "reason": params["p_reason"],
                        "previous": previous,
                        "current": requested,
                    },
                })
                return [{
                    "outcome": "applied",
                    "subscription_status": row["status"],
                    "comped": row["comped"],
                    "stripe_subscription_id": row.get("stripe_subscription_id"),
                    "metadata": deepcopy(row["metadata"]),
                    "status_normalized": status_normalized,
                    "provider_status_preserved": provider_status_preserved,
                }]
            except Exception:
                self.tables["studio_subscriptions"] = subscriptions_before
                self.tables["audit_logs"] = audits_before
                raise


class FakeSettings:
    SUPABASE_URL = "https://project-ref.supabase.co"
    ENVIRONMENT = "production"


class TTYInput(StringIO):
    def isatty(self) -> bool:
        return True


def run_cli(
    supabase: CompSupabase,
    argv: list[str],
    *,
    stdin: StringIO | None = None,
    settings: object | None = None,
) -> tuple[int, str, str]:
    stdout = StringIO()
    stderr = StringIO()
    exit_code = comp_studio.main(
        argv,
        supabase=supabase,
        settings=settings or FakeSettings(),
        stdin=stdin or StringIO(),
        stdout=stdout,
        stderr=stderr,
    )
    return exit_code, stdout.getvalue(), stderr.getvalue()


def execute_args(command: str, *, actor: str = ACTOR_ID) -> list[str]:
    return [
        command,
        "--studio-id",
        STUDIO_ID,
        "--reason",
        f"{command} test",
        "--actor",
        actor,
        "--execute",
        "--expect-project",
        "project-ref",
    ]


class CompStudioCliTests(unittest.TestCase):
    def test_revoke_legacy_comp_denies_access_through_real_evaluator(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "comped",
            "comped": True,
            "stripe_subscription_id": None,
            "metadata": {"backfilled": True},
        }])

        exit_code, _stdout, stderr = run_cli(
            supabase,
            execute_args("revoke"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 0, stderr)
        access = _platform_subscription_access_from_row(
            supabase.tables["studio_subscriptions"][0]
        )
        self.assertTrue(access["subscription_required"])
        self.assertEqual(access["status"], "incomplete")
        self.assertFalse(access["comped"])

    def test_revoke_normalizes_legacy_status_when_flag_is_already_false(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "comped",
            "comped": False,
            "stripe_subscription_id": None,
            "metadata": {"comp": {"state": "granted"}},
        }])

        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("revoke"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertIn("Applied revoke", stdout)
        persisted = supabase.tables["studio_subscriptions"][0]
        self.assertEqual(persisted["status"], "incomplete")
        self.assertFalse(persisted["comped"])
        self.assertEqual(persisted["metadata"]["comp"]["state"], "revoked")
        self.assertEqual(len(supabase.tables["audit_logs"]), 1)
        self.assertTrue(
            _platform_subscription_access_from_row(persisted)["subscription_required"]
        )

    def test_revoke_treats_empty_or_whitespace_subscription_id_as_absent(self):
        for subscription_id in ("", " \t "):
            with self.subTest(subscription_id=repr(subscription_id)):
                supabase = CompSupabase(subscriptions=[{
                    "studio_id": STUDIO_ID,
                    "status": "comped",
                    "comped": True,
                    "stripe_subscription_id": subscription_id,
                    "metadata": {},
                }])

                exit_code, stdout, stderr = run_cli(
                    supabase,
                    execute_args("revoke"),
                    stdin=TTYInput("project-ref.supabase.co\n"),
                )

                self.assertEqual(exit_code, 0, stderr)
                self.assertNotIn("left to the Stripe provider", stdout)
                persisted = supabase.tables["studio_subscriptions"][0]
                self.assertEqual(persisted["status"], "incomplete")
                self.assertFalse(persisted["comped"])

    def test_failed_audit_insert_rolls_back_subscription_update(self):
        supabase = CompSupabase()
        original = deepcopy(supabase.tables["studio_subscriptions"])
        supabase.fail_audit_insert = True

        exit_code, _stdout, stderr = run_cli(
            supabase,
            execute_args("grant"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 1)
        self.assertIn("forced comp audit failure", stderr)
        self.assertEqual(supabase.tables["studio_subscriptions"], original)
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_concurrent_core_metadata_first_is_preserved_by_comp_patch(self):
        supabase = CompSupabase()
        core_has_lock = threading.Event()
        release_core = threading.Event()

        def core_writer() -> None:
            with supabase.transaction_lock:
                core_has_lock.set()
                release_core.wait(2)
                metadata = deepcopy(
                    supabase.tables["studio_subscriptions"][0]["metadata"]
                )
                metadata["core_subscription_event_created"] = 123
                supabase.tables["studio_subscriptions"][0]["metadata"] = metadata

        thread = threading.Thread(target=core_writer)
        thread.start()
        self.assertTrue(core_has_lock.wait(1))
        result: list[tuple[int, str, str]] = []
        cli_thread = threading.Thread(
            target=lambda: result.append(run_cli(
                supabase,
                execute_args("grant"),
                stdin=TTYInput("project-ref.supabase.co\n"),
            ))
        )
        cli_thread.start()
        release_core.set()
        thread.join(2)
        cli_thread.join(2)

        self.assertEqual(result[0][0], 0, result[0][2])
        metadata = supabase.tables["studio_subscriptions"][0]["metadata"]
        self.assertEqual(metadata["core_subscription_event_created"], 123)
        self.assertEqual(metadata["comp"]["state"], "granted")

    def test_concurrent_comp_first_survives_a_stale_core_metadata_snapshot(self):
        stale_comp = {
            "state": "revoked",
            "reason": "Previous decision",
        }
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "incomplete",
            "comped": False,
            "stripe_subscription_id": None,
            "metadata": {"comp": stale_comp},
        }])
        comp_has_lock = threading.Event()
        release_comp = threading.Event()
        stale_core_metadata = {
            "core_subscription_event_created": 456,
            "comp": stale_comp,
        }

        def pause_comp() -> None:
            comp_has_lock.set()
            release_comp.wait(2)

        supabase.after_comp_update = pause_comp
        result: list[tuple[int, str, str]] = []
        cli_thread = threading.Thread(
            target=lambda: result.append(run_cli(
                supabase,
                execute_args("grant"),
                stdin=TTYInput("project-ref.supabase.co\n"),
            ))
        )
        cli_thread.start()
        self.assertTrue(comp_has_lock.wait(1))

        def core_writer() -> None:
            supabase.replace_subscription_metadata(stale_core_metadata)

        core_thread = threading.Thread(target=core_writer)
        core_thread.start()
        release_comp.set()
        cli_thread.join(2)
        core_thread.join(2)

        self.assertEqual(result[0][0], 0, result[0][2])
        metadata = supabase.tables["studio_subscriptions"][0]["metadata"]
        self.assertEqual(metadata["core_subscription_event_created"], 456)
        self.assertEqual(metadata["comp"]["state"], "granted")

    def test_dry_run_writes_nothing(self):
        supabase = CompSupabase()

        exit_code, stdout, stderr = run_cli(
            supabase,
            [
                "grant",
                "--slug",
                "koaryu-test",
                "--reason",
                "Courtesy access",
                "--actor",
                ACTOR_ID,
            ],
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertIn("Dry run only", stdout)
        self.assertEqual(supabase.rpc_calls, [])
        self.assertFalse(supabase.tables["studio_subscriptions"][0]["comped"])
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_actor_resolution_by_uuid_uses_user_response_and_allows_null_email(self):
        supabase = CompSupabase(users=[auth_user(ACTOR_ID, None)])

        exit_code, stdout, stderr = run_cli(
            supabase,
            [
                "grant",
                "--studio-id",
                STUDIO_ID,
                "--reason",
                "Owner approved",
                "--actor",
                ACTOR_ID,
            ],
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertEqual(supabase.auth.admin.get_calls, [ACTOR_ID])
        self.assertIn('"email": null', stdout)

    def test_actor_resolution_by_email_pages_realistic_users(self):
        users = [
            auth_user(
                f"00000000-0000-4000-8000-{index:012d}",
                f"user{index}@example.com",
            )
            for index in range(100)
        ]
        users.append(auth_user(ACTOR_ID, "Owner@Example.com"))
        supabase = CompSupabase(users=users)

        exit_code, stdout, stderr = run_cli(
            supabase,
            [
                "grant",
                "--studio-id",
                STUDIO_ID,
                "--reason",
                "Owner approved",
                "--actor",
                "owner@example.com",
            ],
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertEqual(supabase.auth.admin.list_calls, [(1, 100), (2, 100)])
        self.assertIn(ACTOR_ID, stdout)

    def test_unknown_actor_email_is_error(self):
        supabase = CompSupabase()
        exit_code, _stdout, stderr = run_cli(
            supabase,
            [
                "grant",
                "--studio-id",
                STUDIO_ID,
                "--reason",
                "Owner approved",
                "--actor",
                "missing@example.com",
            ],
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("No Auth user", stderr)

    def test_ambiguous_actor_email_is_error(self):
        supabase = CompSupabase(users=[
            auth_user(ACTOR_ID, "owner@example.com"),
            auth_user(OTHER_ACTOR_ID, "OWNER@example.com"),
        ])
        exit_code, _stdout, stderr = run_cli(
            supabase,
            [
                "grant",
                "--studio-id",
                STUDIO_ID,
                "--reason",
                "Owner approved",
                "--actor",
                "owner@example.com",
            ],
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("More than one Auth user", stderr)

    def test_idempotent_grant_reports_no_change_without_audit(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "incomplete",
            "comped": True,
            "stripe_subscription_id": None,
            "metadata": {},
        }])
        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("grant"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )
        self.assertEqual(exit_code, 0, stderr)
        self.assertIn("No change", stdout)
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_idempotent_revoke_reports_no_change_without_audit(self):
        supabase = CompSupabase()
        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("revoke"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )
        self.assertEqual(exit_code, 0, stderr)
        self.assertIn("No change", stdout)
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_missing_studio_is_error(self):
        supabase = CompSupabase(studios=[])
        exit_code, _stdout, stderr = run_cli(
            supabase,
            ["status", "--slug", "missing"],
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("was not found", stderr)

    def test_missing_subscription_is_error(self):
        supabase = CompSupabase(subscriptions=[])
        exit_code, _stdout, stderr = run_cli(
            supabase,
            ["status", "--studio-id", STUDIO_ID],
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("subscription row was not found", stderr)

    def test_both_and_neither_selector_are_parser_errors(self):
        cases = [
            ["status"],
            ["status", "--slug", "koaryu-test", "--studio-id", STUDIO_ID],
            [
                "grant",
                "--reason",
                "Owner approved",
                "--actor",
                ACTOR_ID,
            ],
            [
                "revoke",
                "--slug",
                "koaryu-test",
                "--studio-id",
                STUDIO_ID,
                "--reason",
                "Owner approved",
                "--actor",
                ACTOR_ID,
            ],
        ]
        for argv in cases:
            with self.subTest(argv=argv), redirect_stderr(StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    comp_studio.main(argv)
                self.assertEqual(raised.exception.code, 2)

    def test_invalid_reasons_are_parser_errors(self):
        reasons = [" \t ", "x" * 501, "line one\nline two"]
        for reason in reasons:
            argv = [
                "grant",
                "--studio-id",
                STUDIO_ID,
                "--reason",
                reason,
                "--actor",
                ACTOR_ID,
            ]
            with self.subTest(reason=repr(reason)), redirect_stderr(StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    comp_studio.main(argv)
                self.assertEqual(raised.exception.code, 2)

    def test_execute_refuses_environment_or_host_mismatch(self):
        class UnknownEnvironment(FakeSettings):
            ENVIRONMENT = "prod"

        cases = [
            (FakeSettings(), "other-project", "does not match"),
            (UnknownEnvironment(), "project-ref", "ENVIRONMENT must be"),
        ]
        for settings, project, message in cases:
            with self.subTest(message=message):
                supabase = CompSupabase()
                args = execute_args("grant")
                args[-1] = project
                exit_code, _stdout, stderr = run_cli(
                    supabase,
                    args,
                    stdin=TTYInput("project-ref.supabase.co\n"),
                    settings=settings,
                )
                self.assertEqual(exit_code, 1)
                self.assertIn(message, stderr)
                self.assertEqual(supabase.rpc_calls, [])

    def test_execute_refuses_placeholder_project_host(self):
        class PlaceholderSettings(FakeSettings):
            SUPABASE_URL = "https://placeholder.supabase.co"

        supabase = CompSupabase()
        args = execute_args("grant")
        args[-1] = "placeholder"
        exit_code, _stdout, stderr = run_cli(
            supabase,
            args,
            stdin=TTYInput("placeholder.supabase.co\n"),
            settings=PlaceholderSettings(),
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("does not identify a real project", stderr)
        self.assertEqual(supabase.rpc_calls, [])

    def test_execute_refuses_non_tty(self):
        supabase = CompSupabase()
        exit_code, _stdout, stderr = run_cli(
            supabase,
            execute_args("grant"),
            stdin=StringIO("project-ref.supabase.co\n"),
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("interactive TTY", stderr)
        self.assertEqual(supabase.rpc_calls, [])

    def test_grant_refuses_live_stripe_subscription_without_override(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "active",
            "comped": False,
            "stripe_subscription_id": "sub_live",
            "metadata": {},
        }])
        exit_code, _stdout, stderr = run_cli(
            supabase,
            execute_args("grant"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )
        self.assertEqual(exit_code, 1)
        self.assertIn("provider billing continues", stderr)
        self.assertEqual(supabase.rpc_calls, [])

    def test_grant_override_warns_that_provider_billing_continues(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "active",
            "comped": False,
            "stripe_subscription_id": "sub_live",
            "metadata": {},
        }])
        args = execute_args("grant") + ["--override-live-subscription"]
        exit_code, stdout, stderr = run_cli(
            supabase,
            args,
            stdin=TTYInput("project-ref.supabase.co\n"),
        )
        self.assertEqual(exit_code, 0, stderr)
        self.assertIn("provider billing continues", stdout)
        self.assertEqual(
            supabase.tables["studio_subscriptions"][0]["stripe_subscription_id"],
            "sub_live",
        )

    def test_grant_allows_canceled_subscription_id_without_override_or_warning(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "canceled",
            "comped": False,
            "stripe_subscription_id": "sub_canceled",
            "metadata": {},
        }])

        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("grant"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertNotIn("provider billing continues", stdout)
        self.assertTrue(supabase.tables["studio_subscriptions"][0]["comped"])

    def test_locked_rpc_refuses_live_subscription_that_appears_after_preflight(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "canceled",
            "comped": False,
            "stripe_subscription_id": "sub_previous",
            "metadata": {},
        }])

        def project_live_subscription() -> None:
            row = supabase.tables["studio_subscriptions"][0]
            row["status"] = "active"
            row["stripe_subscription_id"] = "sub_now_live"

        supabase.before_comp_lock = project_live_subscription
        exit_code, _stdout, stderr = run_cli(
            supabase,
            execute_args("grant"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 1)
        self.assertIn("provider billing continues", stderr)
        persisted = supabase.tables["studio_subscriptions"][0]
        self.assertEqual(persisted["status"], "active")
        self.assertEqual(persisted["stripe_subscription_id"], "sub_now_live")
        self.assertFalse(persisted["comped"])
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_revoke_with_provider_preserves_legacy_status_and_warns(self):
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "comped",
            "comped": True,
            "stripe_subscription_id": "sub_live",
            "metadata": {},
        }])
        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("revoke"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )
        self.assertEqual(exit_code, 3, stderr)
        self.assertIn("left to the Stripe provider", stdout)
        self.assertIn("Access is NOT removed", stdout)
        self.assertEqual(
            supabase.tables["studio_subscriptions"][0]["status"],
            "comped",
        )

    def test_a_revoke_that_does_not_remove_access_says_so(self):
        """The operator must not read "Applied revoke" as "access removed".

        Asserting the persisted status is 'comped' is not enough: that row is
        still entitled, because studio_scope allows on flag OR status. A revoke
        that reports success while the studio keeps working is exactly the
        failure this tool is meant to expose, so it has to be stated in words.
        """
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "comped",
            "comped": True,
            "stripe_subscription_id": "sub_live",
            "metadata": {},
        }])

        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("revoke"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 3, stderr)
        persisted = supabase.tables["studio_subscriptions"][0]
        self.assertTrue(
            persisted["comped"] is False and persisted["status"] in comp_studio.ENTITLING_STATUSES,
            "precondition: the row must still be entitled after the revoke",
        )
        self.assertFalse(
            _platform_subscription_access_from_row(persisted)["subscription_required"],
            "the real evaluator still allows this row, which is why the warning matters",
        )
        self.assertIn("Access is NOT removed", stdout)

    def test_a_revoke_that_does_remove_access_stays_quiet(self):
        """The warning has to discriminate, or operators will learn to ignore it."""
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "canceled",
            "comped": True,
            "stripe_subscription_id": None,
            "metadata": {},
        }])

        exit_code, stdout, stderr = run_cli(
            supabase,
            execute_args("revoke"),
            stdin=TTYInput("project-ref.supabase.co\n"),
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertTrue(
            _platform_subscription_access_from_row(supabase.tables["studio_subscriptions"][0])["subscription_required"]
        )
        self.assertNotIn("Access is NOT removed", stdout)

    def test_a_dry_run_does_not_promise_writes_a_true_no_op_would_not_make(self):
        """The plan has to predict the execute path, not a generic change.

        A grant on an already-comped row is a no-op: the RPC returns no_change
        and writes neither provenance nor an audit row. A plan that still showed
        a metadata.comp block and an audit action would be describing writes
        that never happen.
        """
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "incomplete",
            "comped": True,
            "stripe_subscription_id": None,
            "metadata": {},
        }])

        exit_code, stdout, stderr = run_cli(
            supabase,
            ["grant", "--studio-id", STUDIO_ID, "--reason", "again", "--actor", ACTOR_ID],
        )

        self.assertEqual(exit_code, 0, stderr)
        plan = json.loads(stdout[:stdout.rindex("}") + 1])
        self.assertEqual(plan["requested"].get("outcome"), "no_change")
        self.assertIsNone(plan["audit_action"])
        self.assertNotIn("metadata.comp", plan["requested"])
        self.assertEqual(supabase.tables["audit_logs"], [])

    def test_a_dry_run_warns_when_the_revoke_would_not_remove_access(self):
        """A dry run that looks clean, followed by an execute that warns, is a trap."""
        supabase = CompSupabase(subscriptions=[{
            "studio_id": STUDIO_ID,
            "status": "comped",
            "comped": True,
            "stripe_subscription_id": "sub_live",
            "metadata": {},
        }])

        exit_code, stdout, stderr = run_cli(
            supabase,
            ["revoke", "--studio-id", STUDIO_ID, "--reason", "stop", "--actor", ACTOR_ID],
        )

        self.assertEqual(exit_code, 0, stderr)
        self.assertIn("Access is NOT removed", stdout)

    def test_drift_reports_provenance_disagreement_in_both_directions(self):
        """Filtering on the flag can only ever surface half the drift."""
        supabase = CompSupabase(
            studios=[
                {"id": "studio-erased", "name": "Erased", "slug": "erased"},
                {"id": "studio-resurrected", "name": "Resurrected", "slug": "resurrected"},
                {"id": "studio-consistent", "name": "Consistent", "slug": "consistent"},
            ],
            subscriptions=[
                # A grant the revocation defect erased.
                {"studio_id": "studio-erased", "status": "incomplete", "comped": False,
                 "stripe_subscription_id": None, "metadata": {"comp": {"state": "granted"}}},
                # A flag switched back on by hand after a recorded revoke.
                {"studio_id": "studio-resurrected", "status": "incomplete", "comped": True,
                 "stripe_subscription_id": None, "metadata": {"comp": {"state": "revoked"}}},
                # Agreeing; must not be reported.
                {"studio_id": "studio-consistent", "status": "incomplete", "comped": True,
                 "stripe_subscription_id": None, "metadata": {"comp": {"state": "granted"}}},
            ],
        )

        exit_code, stdout, stderr = run_cli(supabase, ["drift"])

        self.assertEqual(exit_code, 0, stderr)
        reported = {row["studio"]["id"] for row in json.loads(stdout)}
        self.assertEqual(reported, {"studio-erased", "studio-resurrected"})

    def test_list_paginates_until_short_page(self):
        studios = []
        subscriptions = []
        for index in range(comp_studio.PAGE_SIZE + 1):
            studio_id = f"studio-{index:04d}"
            studios.append({
                "id": studio_id,
                "name": f"Studio {index}",
                "slug": f"studio-{index}",
            })
            subscriptions.append({
                "studio_id": studio_id,
                "status": "incomplete",
                "comped": True,
                "stripe_subscription_id": None,
                "metadata": {},
            })
        supabase = CompSupabase(studios=studios, subscriptions=subscriptions)

        exit_code, _stdout, stderr = run_cli(supabase, ["list"])

        self.assertEqual(exit_code, 0, stderr)
        subscription_ranges = [
            entry["range"]
            for entry in supabase.query_log
            if entry["table"] == "studio_subscriptions"
        ]
        self.assertEqual(subscription_ranges, [(0, 199), (200, 399)])

    def test_drift_paginates_until_short_page(self):
        studios = []
        subscriptions = []
        for index in range(comp_studio.PAGE_SIZE + 1):
            studio_id = f"studio-{index:04d}"
            studios.append({
                "id": studio_id,
                "name": f"Studio {index}",
                "slug": f"studio-{index}",
            })
            subscriptions.append({
                "studio_id": studio_id,
                "status": "incomplete",
                "comped": False,
                "stripe_subscription_id": None,
                "metadata": (
                    {"comp": {"state": "granted"}}
                    if index == comp_studio.PAGE_SIZE
                    else {}
                ),
            })
        supabase = CompSupabase(studios=studios, subscriptions=subscriptions)

        exit_code, stdout, stderr = run_cli(supabase, ["drift"])

        self.assertEqual(exit_code, 0, stderr)
        subscription_ranges = [
            entry["range"]
            for entry in supabase.query_log
            if entry["table"] == "studio_subscriptions"
        ]
        self.assertEqual(subscription_ranges, [(0, 199), (200, 399)])
        self.assertIn(f"studio-{comp_studio.PAGE_SIZE:04d}", stdout)

    def test_read_only_commands_issue_no_mutating_call(self):
        subscriptions = [{
            "studio_id": STUDIO_ID,
            "status": "comped",
            "comped": False,
            "stripe_subscription_id": None,
            "metadata": {"comp": {"state": "granted", "reason": "test"}},
        }]
        commands = [
            ["list"],
            ["status", "--studio-id", STUDIO_ID],
            ["drift"],
        ]
        for argv in commands:
            with self.subTest(argv=argv):
                supabase = CompSupabase(subscriptions=deepcopy(subscriptions))
                exit_code, stdout, stderr = run_cli(supabase, argv)
                self.assertEqual(exit_code, 0, stderr)
                self.assertEqual(supabase.rpc_calls, [])
                self.assertTrue(all(
                    entry["insert"] is None
                    and entry["upsert"] is None
                    and entry["update"] is None
                    and not entry["delete"]
                    for entry in supabase.query_log
                ))
                self.assertTrue(all(entry["range"] is not None for entry in supabase.query_log))
                if argv[0] == "drift":
                    self.assertIn("metadata.comp.state is granted", stdout)
                    self.assertIn('"status": "comped"', stdout)
                    self.assertIn('"reason": "test"', stdout)

    def test_migration_text_declares_the_locking_and_ordering_it_relies_on(self):
        """A text assertion, not an execution test — named so it cannot be mistaken.

        This would pass on SQL that does not parse. The behaviour it gestures at
        is actually proven by supabase/verification/studio_comp_atomic_contract.sql,
        which CI runs against a real database via scripts/verify-supabase-contracts.sh.
        Keep this only as a cheap guard against someone deleting the lock or
        reordering the audit insert without noticing.
        """
        normalized = " ".join(COMP_MIGRATION.read_text().split()).lower()
        self.assertIn("security invoker", normalized)
        self.assertIn("for update", normalized)
        self.assertIn("metadata = jsonb_set(", normalized)
        self.assertIn("preserve_studio_comp_provenance_on_metadata_update", normalized)
        self.assertIn("set_config('koaryu.comp_provenance_write', 'allowed', true)", normalized)
        self.assertLess(
            normalized.index("update public.studio_subscriptions"),
            normalized.index("insert into public.audit_logs"),
        )

    def test_sql_live_subscription_statuses_match_billing_service_constant(self):
        migration = COMP_MIGRATION.read_text()
        normalized = " ".join(migration.split()).lower()
        declaration = re.search(
            r"v_live_subscription_statuses constant text\[\] := "
            r"array\[(.*?)\]::text\[\];",
            normalized,
        )
        self.assertIsNotNone(declaration)
        sql_statuses = set(re.findall(r"'([^']+)'", declaration.group(1)))
        self.assertEqual(
            sql_statuses,
            comp_studio.LIVE_STRIPE_SUBSCRIPTION_STATUSES,
        )
        self.assertIn(
            "nullif(btrim(v_existing.stripe_subscription_id, whitespace), '') is not null",
            normalized,
        )
        # The second BTRIM argument is the whole point: one-argument BTRIM strips
        # spaces only, so a tab-only identifier read as present in SQL while
        # Python's str.strip() read it as absent, and the two disagreed about
        # whether a subscription existed.
        whitespace = re.search(r"whitespace constant text := e'([^']*)';", normalized)
        self.assertIsNotNone(whitespace)
        declared = whitespace.group(1).encode().decode("unicode_escape")
        self.assertEqual(set(declared), set(" \t\n\r\f\v"))
        self.assertEqual(
            {character for character in declared if not character.strip()},
            set(declared),
            "every declared character must be whitespace to Python as well",
        )
        self.assertIn("using errcode = 'p0c01'", normalized)


if __name__ == "__main__":
    unittest.main()
