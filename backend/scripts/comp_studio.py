from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import unicodedata
from typing import Any, Callable, Optional, TextIO
from urllib.parse import urlparse
from uuid import UUID

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import get_settings, is_placeholder_value
from app.db.supabase import create_supabase_client


PAGE_SIZE = 200
AUTH_PAGE_SIZE = 100
MAX_REASON_LENGTH = 500
RECOGNIZED_ENVIRONMENTS = {"development", "test", "staging", "production"}
# Mirrors studio_scope.ACTIVE_PLATFORM_SUBSCRIPTION_STATUSES. A revoke clears the
# `comped` flag, but any of these statuses entitles the studio on its own, so a
# cleared flag is not the same thing as removed access.
ENTITLING_STATUSES = {"active", "trialing", "comped"}
SUBSCRIPTION_COLUMNS = (
    "studio_id,status,comped,stripe_customer_id,stripe_subscription_id,"
    "trial_start,trial_end,current_period_start,current_period_end,"
    "cancel_at_period_end,last_payment_status,metadata,created_at,updated_at"
)


class CompStudioError(RuntimeError):
    pass


def _reason(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise argparse.ArgumentTypeError("reason must not be empty")
    if len(normalized) > MAX_REASON_LENGTH:
        raise argparse.ArgumentTypeError(
            f"reason must be {MAX_REASON_LENGTH} characters or fewer"
        )
    if any(unicodedata.category(character) == "Cc" for character in normalized):
        raise argparse.ArgumentTypeError("reason must not contain control characters")
    return normalized


def _add_selector(parser: argparse.ArgumentParser) -> None:
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--slug", help="Studio slug.")
    selector.add_argument("--studio-id", help="Studio UUID.")


def _add_write_arguments(parser: argparse.ArgumentParser) -> None:
    _add_selector(parser)
    parser.add_argument("--reason", required=True, type=_reason)
    parser.add_argument(
        "--actor",
        required=True,
        help="Real Supabase Auth user UUID or exact email address.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Apply the change. Without this flag, only print the plan.",
    )
    parser.add_argument(
        "--expect-project",
        help="Configured Supabase host or project ref. Required with --execute.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Inspect and manage owner-approved Koaryu platform comp access."
    )
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("list", help="List studios whose comp flag is currently enabled.")

    status_parser = commands.add_parser("status", help="Show one studio's subscription and comp provenance.")
    _add_selector(status_parser)

    commands.add_parser("drift", help="List comp provenance or legacy status that disagrees with the flag.")

    grant_parser = commands.add_parser("grant", help="Grant a platform access override.")
    _add_write_arguments(grant_parser)
    grant_parser.add_argument(
        "--override-live-subscription",
        action="store_true",
        help="Allow a comp while Stripe provider billing remains live.",
    )

    revoke_parser = commands.add_parser("revoke", help="Revoke a platform access override.")
    _add_write_arguments(revoke_parser)

    return parser


def _paginate(query_factory: Callable[[], Any], *, page_size: int = PAGE_SIZE) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        result = query_factory().range(offset, offset + page_size - 1).execute()
        batch = result.data or []
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        offset += page_size


def _all_studios(supabase: Any) -> list[dict[str, Any]]:
    return _paginate(
        lambda: supabase.table("studios").select("id,name,slug").order("id")
    )


def _resolve_studio(
    supabase: Any,
    *,
    slug: Optional[str],
    studio_id: Optional[str],
) -> dict[str, Any]:
    def query() -> Any:
        base = supabase.table("studios").select("id,name,slug").order("id")
        return base.eq("slug", slug) if slug is not None else base.eq("id", studio_id)

    rows = _paginate(query)
    if not rows:
        selector = f"slug {slug!r}" if slug is not None else f"id {studio_id!r}"
        raise CompStudioError(f"Studio with {selector} was not found.")
    if len(rows) != 1:
        raise CompStudioError("Studio selector matched more than one row.")
    return rows[0]


def _subscription_for_studio(supabase: Any, studio_id: str) -> dict[str, Any]:
    rows = _paginate(
        lambda: (
            supabase.table("studio_subscriptions")
            .select(SUBSCRIPTION_COLUMNS)
            .eq("studio_id", studio_id)
            .order("studio_id")
        )
    )
    if not rows:
        raise CompStudioError("Studio subscription row was not found.")
    if len(rows) != 1:
        raise CompStudioError("Studio has more than one subscription row.")
    return rows[0]


def _comp_provenance(row: dict[str, Any]) -> Optional[dict[str, Any]]:
    metadata = row.get("metadata")
    if not isinstance(metadata, dict):
        return None
    provenance = metadata.get("comp")
    return provenance if isinstance(provenance, dict) else None


def _display_row(studio: dict[str, Any], subscription: dict[str, Any]) -> dict[str, Any]:
    return {
        "studio": {
            "id": studio.get("id"),
            "name": studio.get("name"),
            "slug": studio.get("slug"),
        },
        "subscription": subscription,
        "comp_provenance": _comp_provenance(subscription),
    }


def _print_json(value: Any, stdout: TextIO) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, default=str), file=stdout)


def _list_comps(supabase: Any, stdout: TextIO) -> None:
    subscriptions = _paginate(
        lambda: (
            supabase.table("studio_subscriptions")
            .select(SUBSCRIPTION_COLUMNS)
            .eq("comped", True)
            .order("studio_id")
        )
    )
    studios = {row["id"]: row for row in _all_studios(supabase)}
    rows = [
        _display_row(
            studios.get(subscription["studio_id"], {
                "id": subscription["studio_id"],
                "name": None,
                "slug": None,
            }),
            subscription,
        )
        for subscription in subscriptions
    ]
    _print_json(rows, stdout)


def _show_status(supabase: Any, args: argparse.Namespace, stdout: TextIO) -> None:
    studio = _resolve_studio(supabase, slug=args.slug, studio_id=args.studio_id)
    subscription = _subscription_for_studio(supabase, studio["id"])
    _print_json(_display_row(studio, subscription), stdout)


def _show_drift(supabase: Any, stdout: TextIO) -> None:
    subscriptions = _paginate(
        lambda: (
            supabase.table("studio_subscriptions")
            .select(SUBSCRIPTION_COLUMNS)
            .eq("comped", False)
            .order("studio_id")
        )
    )
    studios = {row["id"]: row for row in _all_studios(supabase)}
    rows = []
    for subscription in subscriptions:
        provenance = _comp_provenance(subscription)
        provenance_granted = bool(provenance and provenance.get("state") == "granted")
        legacy_status_entitled = subscription.get("status") == "comped"
        if not (provenance_granted or legacy_status_entitled):
            continue
        display = _display_row(
            studios.get(subscription["studio_id"], {
                "id": subscription["studio_id"],
                "name": None,
                "slug": None,
            }),
            subscription,
        )
        display["drift_reasons"] = [
            reason
            for applies, reason in (
                (provenance_granted, "metadata.comp.state is granted while comped is false"),
                (legacy_status_entitled, "status is comped while comped is false"),
            )
            if applies
        ]
        rows.append(display)
    _print_json(rows, stdout)


def _auth_user_by_uuid(supabase: Any, actor_id: str) -> Any:
    try:
        response = supabase.auth.admin.get_user_by_id(actor_id)
    except Exception as exc:
        raise CompStudioError(f"Auth user {actor_id} was not found.") from exc
    user = getattr(response, "user", None)
    if user is None:
        raise CompStudioError(f"Auth user {actor_id} was not found.")
    return user


def _resolve_actor(supabase: Any, actor: str) -> tuple[str, Optional[str]]:
    normalized = actor.strip()
    try:
        actor_id = str(UUID(normalized))
    except (TypeError, ValueError):
        matches = []
        page = 1
        while True:
            users = supabase.auth.admin.list_users(page, AUTH_PAGE_SIZE) or []
            matches.extend(
                user
                for user in users
                if (getattr(user, "email", None) or "").casefold() == normalized.casefold()
            )
            if len(users) < AUTH_PAGE_SIZE:
                break
            page += 1

        if not matches:
            raise CompStudioError(f"No Auth user has email {normalized!r}.")
        if len(matches) > 1:
            raise CompStudioError(f"More than one Auth user has email {normalized!r}.")
        user = matches[0]
    else:
        user = _auth_user_by_uuid(supabase, actor_id)

    user_id = getattr(user, "id", None)
    if not user_id:
        raise CompStudioError("Resolved Auth user has no id.")
    email = getattr(user, "email", None)
    return str(user_id), str(email) if email else None


def _project_identity(settings: Any) -> tuple[str, str]:
    parsed = urlparse(str(settings.SUPABASE_URL).strip())
    host = (parsed.hostname or "").lower()
    if not parsed.scheme or not host or is_placeholder_value(host):
        raise CompStudioError("Configured SUPABASE_URL does not identify a real project host.")
    project_ref = host.removesuffix(".supabase.co") if host.endswith(".supabase.co") else host
    return host, project_ref


def _confirm_execute(
    args: argparse.Namespace,
    settings: Any,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    environment = str(settings.ENVIRONMENT).strip().lower()
    if environment not in RECOGNIZED_ENVIRONMENTS:
        raise CompStudioError(
            "ENVIRONMENT must be development, test, staging, or production before executing."
        )
    if not args.expect_project:
        raise CompStudioError("--expect-project is required with --execute.")

    host, project_ref = _project_identity(settings)
    expected = args.expect_project.strip().lower()
    if expected not in {host, project_ref}:
        raise CompStudioError(
            f"--expect-project {args.expect_project!r} does not match configured host {host!r}."
        )
    if not stdin.isatty():
        raise CompStudioError("Execution requires an interactive TTY confirmation.")

    print(
        f"Environment: {environment}; Supabase project: {host}",
        file=stdout,
    )
    print(f"Type {host} to confirm: ", end="", file=stdout, flush=True)
    confirmation = stdin.readline().strip().lower()
    if confirmation != host:
        raise CompStudioError("Project confirmation did not match; nothing was written.")


def _planned_change(
    command: str,
    studio: dict[str, Any],
    subscription: dict[str, Any],
    actor_id: str,
    actor_email: Optional[str],
    reason: str,
) -> dict[str, Any]:
    requested_comped = command == "grant"
    status_after = subscription.get("status")
    status_note = "unchanged"
    if (
        not requested_comped
        and subscription.get("status") == "comped"
        and not subscription.get("stripe_subscription_id")
    ):
        status_after = "incomplete"
        status_note = "legacy provider-less comp status will be normalized"
    elif (
        not requested_comped
        and subscription.get("status") == "comped"
        and subscription.get("stripe_subscription_id")
    ):
        status_note = "legacy comp status remains provider-owned"

    return {
        "operation": command,
        "studio": {
            "id": studio.get("id"),
            "name": studio.get("name"),
            "slug": studio.get("slug"),
        },
        "actor": {"id": actor_id, "email": actor_email},
        "reason": reason,
        "current": {
            "comped": bool(subscription.get("comped")),
            "status": subscription.get("status"),
            "stripe_subscription_id": subscription.get("stripe_subscription_id"),
            "comp_provenance": _comp_provenance(subscription),
        },
        "requested": {
            "comped": requested_comped,
            "status": status_after,
            "status_note": status_note,
            "metadata.comp": {
                "state": "granted" if requested_comped else "revoked",
                "reason": reason,
                "actor_id": actor_id,
                "actor_email": actor_email,
                "at": "<database transaction time>",
                "source": "comp_studio_cli",
                "previous": bool(subscription.get("comped")),
            },
        },
        "audit_action": (
            "platform_comp.granted" if requested_comped else "platform_comp.revoked"
        ),
    }


def _first_rpc_row(data: Any) -> Optional[dict[str, Any]]:
    if isinstance(data, list):
        return data[0] if data else None
    return data if isinstance(data, dict) else None


def _change_comp(
    supabase: Any,
    settings: Any,
    args: argparse.Namespace,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    studio = _resolve_studio(supabase, slug=args.slug, studio_id=args.studio_id)
    subscription = _subscription_for_studio(supabase, studio["id"])
    actor_id, actor_email = _resolve_actor(supabase, args.actor)

    if args.command == "grant" and subscription.get("stripe_subscription_id"):
        warning = (
            "WARNING: This studio has a live Stripe subscription. A comp is only an "
            "access override; provider billing continues."
        )
        if not args.override_live_subscription:
            raise CompStudioError(
                f"{warning} Re-run with --override-live-subscription only if continued billing is intended."
            )
        print(warning, file=stdout)

    if (
        args.command == "revoke"
        and subscription.get("status") == "comped"
        and subscription.get("stripe_subscription_id")
    ):
        print(
            "WARNING: Legacy status 'comped' will be left unchanged because a Stripe "
            "subscription exists; provider projection must set the authoritative status. "
            "THE STUDIO WILL STILL HAVE ACCESS after this revoke, because status "
            "'comped' entitles it on its own. Resolve the Stripe subscription, or wait "
            "for the next provider projection, and re-check with `status`.",
            file=stdout,
        )

    plan = _planned_change(
        args.command,
        studio,
        subscription,
        actor_id,
        actor_email,
        args.reason,
    )
    _print_json(plan, stdout)

    if not args.execute:
        print("Dry run only. Re-run with --execute to apply this change.", file=stdout)
        return

    _confirm_execute(args, settings, stdin, stdout)
    try:
        result = supabase.rpc(
            "set_studio_comp_atomic",
            {
                "p_studio_id": studio["id"],
                "p_comped": args.command == "grant",
                "p_reason": args.reason,
                "p_actor_id": actor_id,
                "p_actor_email": actor_email,
            },
        ).execute()
    except Exception as exc:
        raise CompStudioError(f"Atomic comp change failed: {exc}") from exc

    row = _first_rpc_row(result.data)
    if not row:
        raise CompStudioError("Atomic comp change returned no outcome.")
    outcome = row.get("outcome")
    if outcome == "no_change":
        print("No change: the requested comp state is already set.", file=stdout)
        _warn_if_still_entitled(args.command, row.get("subscription_status"), stdout)
        return
    if outcome != "applied":
        raise CompStudioError(f"Atomic comp change returned unknown outcome {outcome!r}.")

    if row.get("provider_status_preserved"):
        print(
            "WARNING: Legacy status 'comped' was left to the Stripe provider.",
            file=stdout,
        )
    print(
        f"Applied {args.command} for studio {studio['id']}; audit log written.",
        file=stdout,
    )
    _warn_if_still_entitled(args.command, row.get("subscription_status"), stdout)


def _warn_if_still_entitled(command: str, status: Any, stdout: TextIO) -> None:
    """Say plainly when a revoke did not actually remove access.

    Clearing `comped` is only half of the entitlement. `_platform_subscription_
    access_from_row` allows the row if the flag OR the status grants it, so a
    revoke that leaves an entitling status behind still reports "applied" while
    the studio keeps working. Reporting a successful revocation that did not
    revoke is the defect class this tool exists to make visible, so it is stated
    rather than left for the operator to infer.
    """
    if command != "revoke" or status not in ENTITLING_STATUSES:
        return
    print(
        f"WARNING: Access is NOT removed. Status is still {status!r}, which entitles "
        "the studio on its own. Verify with `status` before telling anyone the comp "
        "is gone.",
        file=stdout,
    )


def main(
    argv: Optional[list[str]] = None,
    *,
    supabase: Any = None,
    settings: Any = None,
    stdin: Optional[TextIO] = None,
    stdout: Optional[TextIO] = None,
    stderr: Optional[TextIO] = None,
) -> int:
    args = build_parser().parse_args(argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr

    try:
        client = supabase if supabase is not None else create_supabase_client()
        if args.command == "list":
            _list_comps(client, stdout)
        elif args.command == "status":
            _show_status(client, args, stdout)
        elif args.command == "drift":
            _show_drift(client, stdout)
        else:
            _change_comp(
                client,
                settings if settings is not None else get_settings(),
                args,
                stdin,
                stdout,
            )
    except CompStudioError as exc:
        print(f"Error: {exc}", file=stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
