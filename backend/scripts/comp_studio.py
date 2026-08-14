from __future__ import annotations

import argparse
from datetime import datetime, timedelta
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
from app.services.studio_scope import _platform_subscription_access_from_row
from app.services.platform_billing_service import LIVE_STRIPE_SUBSCRIPTION_STATUSES
from app.services.platform_billing_helpers import build_idempotency_key
from app.services.stripe_service import StripeService


PAGE_SIZE = 200
AUTH_PAGE_SIZE = 100
MAX_REASON_LENGTH = 500
RECOGNIZED_ENVIRONMENTS = {"development", "test", "staging", "production"}
LIVE_SUBSCRIPTION_REFUSAL_SQLSTATE = "P0C01"
UNBOUND_LIVE_SUBSCRIPTION_OVERRIDE_SQLSTATE = "P0C02"
LIVE_SUBSCRIPTION_WARNING = (
    "WARNING: This studio has a live Stripe subscription. A comp is only an "
    "access override; provider billing continues."
)
SUBSCRIPTION_COLUMNS = (
    "studio_id,status,comped,stripe_customer_id,stripe_subscription_id,"
    "trial_start,trial_end,current_period_start,current_period_end,"
    "cancel_at_period_end,last_payment_status,metadata,created_at,updated_at"
)


class CompStudioError(RuntimeError):
    pass


# The exact set the RPC's BTRIM uses. `str.strip()` cannot be used here: it also
# strips Unicode whitespace such as U+00A0, which BTRIM leaves in place, so the
# two would disagree about whether a subscription exists and the dry run would
# predict a normalization the database refuses to perform. Erring towards
# "present" is the safe direction — the status is preserved and the revoke exits
# nonzero, rather than silently reporting an access removal that did not happen.
BLANK_ID_WHITESPACE = " \t\n\v\f\r"
POSTGRES_MAX_UTC_OFFSET = timedelta(hours=15, minutes=59, seconds=59)


def _has_stripe_subscription_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip(BLANK_ID_WHITESPACE))


def _has_live_stripe_subscription(subscription: dict[str, Any]) -> bool:
    return (
        _has_stripe_subscription_id(subscription.get("stripe_subscription_id"))
        and (subscription.get("status") or "") in LIVE_STRIPE_SUBSCRIPTION_STATUSES
    )


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

    commands.add_parser(
        "drift",
        help="List comp provenance, flag, timestamp, or legacy-status drift.",
    )

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


def _has_unusable_grant_timestamp(provenance: Optional[dict[str, Any]]) -> bool:
    if not provenance or provenance.get("state") != "granted":
        return False
    value = provenance.get("at")
    if not isinstance(value, str) or not value.strip():
        return True
    normalized = value.strip()
    if normalized.casefold() in {"infinity", "+infinity", "-infinity"}:
        return True
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return True
    utc_offset = parsed.utcoffset()
    if utc_offset is not None and abs(utc_offset) > POSTGRES_MAX_UTC_OFFSET:
        # Python accepts offsets through (but not including) 24 hours, while
        # PostgreSQL rejects magnitudes above 15:59:59. Mirror the database
        # boundary so drift catches provenance that wedges the real RPC cast.
        return True
    return False


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
    # Scanned unfiltered rather than filtered to `comped = false`. Provenance can
    # disagree with the flag in either direction: a grant erased by the
    # revocation defect leaves state='granted' with the flag false, and a manual
    # flag write leaves state='revoked' with the flag true. Filtering on the flag
    # can only ever surface the first. Active grants also need to surface when
    # their timestamp cannot safely order a billing event, when a live Stripe
    # subscription coexists with the comp regardless of timestamp ordering, or
    # when a Stripe customer exists but the local projection cannot confirm a
    # live subscription.
    subscriptions = _paginate(
        lambda: (
            supabase.table("studio_subscriptions")
            .select(SUBSCRIPTION_COLUMNS)
            .order("studio_id")
        )
    )
    studios = {row["id"]: row for row in _all_studios(supabase)}
    rows = []
    for subscription in subscriptions:
        provenance = _comp_provenance(subscription)
        comped = bool(subscription.get("comped"))
        recorded_state = provenance.get("state") if provenance else None
        provenance_disagrees = (
            recorded_state == "granted" and not comped
        ) or (
            recorded_state == "revoked" and comped
        )
        legacy_status_entitled = (
            subscription.get("status") == "comped" and not comped
        )
        unusable_grant_timestamp = (
            comped and _has_unusable_grant_timestamp(provenance)
        )
        live_subscription_with_comp = (
            comped and _has_live_stripe_subscription(subscription)
        )
        stripe_customer_needs_confirmation = (
            comped
            and _has_stripe_subscription_id(
                subscription.get("stripe_customer_id")
            )
            and not _has_live_stripe_subscription(subscription)
        )
        if not (
            provenance_disagrees
            or legacy_status_entitled
            or unusable_grant_timestamp
            or live_subscription_with_comp
            or stripe_customer_needs_confirmation
        ):
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
                (
                    recorded_state == "granted" and not comped,
                    "metadata.comp.state is granted while comped is false",
                ),
                (
                    recorded_state == "revoked" and comped,
                    "metadata.comp.state is revoked while comped is true",
                ),
                (legacy_status_entitled, "status is comped while comped is false"),
                (
                    unusable_grant_timestamp,
                    "metadata.comp.state is granted but metadata.comp.at is "
                    "absent, unparseable, PostgreSQL-incompatible, or non-finite",
                ),
                (
                    live_subscription_with_comp,
                    "comped is true while a live Stripe subscription is present",
                ),
                (
                    stripe_customer_needs_confirmation,
                    "comped is true with a Stripe customer but no live local "
                    "subscription; needs confirmation against Stripe",
                ),
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
    if not normalized:
        # An unset shell variable arrives as an empty string, and the email
        # comparison below coalesces a missing email to "" — so a blank actor
        # would silently match any Auth user without an email address and
        # attribute the change to them.
        raise CompStudioError("--actor must not be empty.")
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
    # Mirrors the RPC's no_change test, which is deliberately not "the flag
    # already matches": a legacy status still pending normalization is work to
    # do even when the flag is right. A dry run that promised provenance and an
    # audit row for a true no-op would describe writes that never happen, which
    # is the same dishonesty this tool exists to remove from revoke.
    flag_needs_change = bool(subscription.get("comped")) != requested_comped
    normalizes_legacy_status = (
        not requested_comped
        and subscription.get("status") == "comped"
        and not _has_stripe_subscription_id(subscription.get("stripe_subscription_id"))
    )
    changes_anything = flag_needs_change or normalizes_legacy_status
    if (
        not requested_comped
        and subscription.get("status") == "comped"
        and not _has_stripe_subscription_id(subscription.get("stripe_subscription_id"))
    ):
        status_after = "incomplete"
        status_note = "legacy provider-less comp status will be normalized"
    elif (
        not requested_comped
        and subscription.get("status") == "comped"
        and _has_stripe_subscription_id(subscription.get("stripe_subscription_id"))
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
        } if changes_anything else {
            "outcome": "no_change",
            "status": status_after,
            "status_note": status_note,
        },
        "audit_action": (
            ("platform_comp.granted" if requested_comped else "platform_comp.revoked")
            if changes_anything
            else None
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
) -> int:
    studio = _resolve_studio(supabase, slug=args.slug, studio_id=args.studio_id)
    subscription = _subscription_for_studio(supabase, studio["id"])
    actor_id, actor_email = _resolve_actor(supabase, args.actor)

    if args.command == "grant" and _has_live_stripe_subscription(subscription):
        if not args.override_live_subscription:
            raise CompStudioError(
                f"{LIVE_SUBSCRIPTION_WARNING} Re-run with "
                "--override-live-subscription only if continued billing is intended."
            )
        print(LIVE_SUBSCRIPTION_WARNING, file=stdout)

    if (
        args.command == "revoke"
        and subscription.get("status") == "comped"
        and _has_stripe_subscription_id(subscription.get("stripe_subscription_id"))
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
        # The dry run has to reach the same verdict as the execute path, or an
        # operator can be told the revoke is fine and only discover otherwise
        # after the write.
        _warn_if_still_entitled(
            args.command,
            plan["requested"]["status"],
            stdout,
            trial_end=subscription.get("trial_end"),
        )
        return 0

    _confirm_execute(args, settings, stdin, stdout)
    try:
        result = supabase.rpc(
            "set_studio_comp_v2_atomic",
            {
                "p_studio_id": studio["id"],
                "p_comped": args.command == "grant",
                "p_reason": args.reason,
                "p_actor_id": actor_id,
                "p_actor_email": actor_email,
                "p_allow_live_subscription": bool(
                    args.command == "grant" and args.override_live_subscription
                ),
            },
        ).execute()
    except Exception as exc:
        if getattr(exc, "code", None) == LIVE_SUBSCRIPTION_REFUSAL_SQLSTATE:
            raise CompStudioError(
                f"{LIVE_SUBSCRIPTION_WARNING} Re-run with "
                "--override-live-subscription only if continued billing is intended."
            ) from exc
        if getattr(exc, "code", None) == UNBOUND_LIVE_SUBSCRIPTION_OVERRIDE_SQLSTATE:
            raise CompStudioError(
                "The live subscription is not the exact accepted Core checkout "
                "binding, so Koaryu cannot safely preserve it through a comp grant."
            ) from exc
        raise CompStudioError(f"Atomic comp change failed: {exc}") from exc

    row = _first_rpc_row(result.data)
    if not row:
        raise CompStudioError("Atomic comp change returned no outcome.")
    if args.command == "grant":
        metadata = row.get("metadata")
        invalidated_session_id = (
            metadata.get("core_checkout_invalidated_session_id")
            if isinstance(metadata, dict)
            else None
        )
        invalidated_session_state = (
            metadata.get("core_checkout_invalidated_session_state")
            if isinstance(metadata, dict)
            else None
        )
        if invalidated_session_id and invalidated_session_state != "completed":
            try:
                StripeService().expire_core_checkout_session(
                    session_id=str(invalidated_session_id),
                    studio_id=studio["id"],
                    idempotency_key=build_idempotency_key(
                        "core-checkout-expire",
                        studio["id"],
                        invalidated_session_id,
                    ),
                )
            except Exception as exc:
                raise CompStudioError(
                    "Comp was granted, but its outstanding checkout session could not be expired. "
                    "The completion webhook will reject and cancel it; retry the grant command "
                    f"to finish provider cleanup. Provider error: {type(exc).__name__}."
                ) from exc
    outcome = row.get("outcome")
    if outcome == "no_change":
        print(
            "No change: the requested comp state and legacy status already match.",
            file=stdout,
        )
        return (
            3
            if _warn_if_still_entitled(
                args.command,
                row.get("subscription_status"),
                stdout,
                trial_end=subscription.get("trial_end"),
            )
            else 0
        )
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
    return (
        3
        if _warn_if_still_entitled(
            args.command,
            row.get("subscription_status"),
            stdout,
            trial_end=subscription.get("trial_end"),
        )
        else 0
    )


def _warn_if_still_entitled(
    command: str,
    status: Any,
    stdout: TextIO,
    *,
    trial_end: Any = None,
) -> bool:
    """Say plainly when a revoke did not actually remove access.

    Clearing `comped` is only half of the entitlement. The evaluator allows the
    row if the flag OR the status grants it, so a revoke that leaves an
    entitling status behind still reports "applied" while the studio keeps
    working. Reporting a successful revocation that did not revoke is the defect
    class this tool exists to make visible.

    The question is put to the real evaluator rather than to a mirrored status
    set. A mirrored set gets the trial case wrong in the opposite direction: a
    `trialing` row whose `trial_end` has passed is denied, so warning on status
    alone would tell the operator a completed revoke was unfinished. A false
    alarm here is not harmless -- an operator who learns the warning cries wolf
    will not read it on the day it is true.
    """
    if command != "revoke":
        return False
    access = _platform_subscription_access_from_row({
        "status": status,
        "comped": False,
        "trial_end": trial_end,
    })
    if not access["subscription_required"]:
        print(
            f"WARNING: Access is NOT removed. Status is still {status!r}, which entitles "
            "the studio on its own. Verify with `status` before telling anyone the comp "
            "is gone.",
            file=stdout,
        )
        return True
    return False


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
            return _change_comp(
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
