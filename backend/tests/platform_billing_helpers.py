from __future__ import annotations

import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from math import floor
from threading import Lock
from unittest.mock import patch

from app.services.platform_billing_service import PlatformBillingService
from tests.fakes.supabase import RpcBackedSupabase


# This fake must mirror clear_studio_comp_for_billing_event in SQL. Easy-to-miss
# boundaries include PostgreSQL's +/-15:59:59 UTC-offset limit, its finite event
# epoch range, and the same-second provider-wins ordering rule.
class FakeSupabase(RpcBackedSupabase):
    POSTGRES_MAX_UTC_OFFSET = timedelta(hours=15, minutes=59, seconds=59)
    POSTGRES_MIN_EVENT_EPOCH = -210866803200
    POSTGRES_END_EVENT_EPOCH = 9224318016000

    def __init__(self, rows: list[dict]):
        studio_ids = {"studio_1"} | {
            str(row["studio_id"])
            for row in rows
            if row.get("studio_id")
        }
        super().__init__({
            "studio_subscriptions": rows,
            "email_usage_events": [],
            "studios": [
                {"id": studio_id, "name": "Koaryu Test Studio"}
                for studio_id in sorted(studio_ids)
            ],
            "audit_logs": [],
        })
        self.on_update_query = self._apply_studio_subscription_update
        self._core_checkout_lock = Lock()
        self.before_reserve_core_checkout = None

    def _subscription_row(self, studio_id: str) -> dict:
        return next(
            row for row in self.tables["studio_subscriptions"]
            if row.get("studio_id") == studio_id
        )

    def _rpc_reserve_core_checkout_v2_atomic(self, params: dict) -> list[dict]:
        with self._core_checkout_lock:
            if self.before_reserve_core_checkout is not None:
                callback = self.before_reserve_core_checkout
                self.before_reserve_core_checkout = None
                callback()
            row = self._subscription_row(params["p_studio_id"])
            if row.get("comped") or row.get("status") == "comped":
                return [{"outcome": "comped", "trial_period_days": None}]
            if row.get("stripe_subscription_id") and row.get("status") in {
                "active", "trialing", "past_due", "unpaid", "paused",
            }:
                return [{"outcome": "active", "trial_period_days": None}]
            metadata = dict(row.get("metadata") or {})
            session = metadata.get("core_checkout_session")
            acceptances = dict(metadata.get("core_checkout_acceptances") or {})
            if (
                isinstance(session, dict)
                and session.get("state") == "completed"
                and session.get("accepted_subscription_id")
            ):
                accepted_subscription_id = session["accepted_subscription_id"]
                if (
                    row.get("stripe_subscription_id") != accepted_subscription_id
                    or row.get("status") not in {"canceled", "incomplete_expired"}
                ):
                    return [{"outcome": "active", "trial_period_days": None}]
                acceptances[accepted_subscription_id] = dict(session)
                metadata["core_checkout_acceptances"] = acceptances
            if (
                isinstance(session, dict)
                and session.get("state") == "published"
                and session.get("url")
                and int(session.get("expires_at") or 0) > 999999999
            ):
                return [{
                    "outcome": "existing",
                    "reservation_token": session.get("token"),
                    "checkout_epoch": session.get("epoch"),
                    "session_id": session.get("id"),
                    "session_url": session.get("url"),
                    "expires_at": session.get("expires_at"),
                    "trial_period_days": None,
                }]
            if isinstance(metadata.get("core_checkout_reservation"), dict):
                reservation = metadata["core_checkout_reservation"]
                return [{
                    "outcome": "in_progress",
                    "reservation_token": reservation["token"],
                    "checkout_epoch": reservation["epoch"],
                    "trial_period_days": None,
                }]
            trial_period_days = (
                30
                if row.get("stripe_subscription_id") is None
                and metadata.get("core_trial_consumed", False) is False
                else None
            )
            epoch = int(metadata.get("core_checkout_epoch") or 0) + 1
            token = f"00000000-0000-4000-8000-{epoch:012d}"
            metadata["core_checkout_epoch"] = epoch
            metadata["core_checkout_reservation"] = {
                "state": "reserved", "token": token, "epoch": epoch,
            }
            metadata.pop("core_checkout_session", None)
            row["metadata"] = metadata
            return [{
                "outcome": "reserved",
                "reservation_token": token,
                "checkout_epoch": epoch,
                "trial_period_days": trial_period_days,
            }]

    def _rpc_publish_core_checkout_atomic(self, params: dict) -> list[dict]:
        with self._core_checkout_lock:
            row = self._subscription_row(params["p_studio_id"])
            metadata = dict(row.get("metadata") or {})
            reservation = metadata.get("core_checkout_reservation") or {}
            if row.get("comped") or row.get("status") == "comped":
                return [{"outcome": "comped"}]
            if (
                reservation.get("token") != params["p_reservation_token"]
                or reservation.get("epoch") != params["p_checkout_epoch"]
            ):
                existing = metadata.get("core_checkout_session") or {}
                return [{
                    "outcome": "existing" if existing.get("url") else "stale",
                    "session_id": existing.get("id"),
                    "session_url": existing.get("url"),
                }]
            metadata.pop("core_checkout_reservation", None)
            metadata["core_checkout_session"] = {
                "state": "published",
                "token": params["p_reservation_token"],
                "epoch": params["p_checkout_epoch"],
                "id": params["p_session_id"],
                "url": params["p_session_url"],
                "expires_at": params["p_expires_at"],
            }
            row["metadata"] = metadata
            return [{
                "outcome": "published",
                "session_id": params["p_session_id"],
                "session_url": params["p_session_url"],
            }]

    def _rpc_release_core_checkout_reservation_atomic(self, params: dict) -> bool:
        with self._core_checkout_lock:
            row = self._subscription_row(params["p_studio_id"])
            metadata = dict(row.get("metadata") or {})
            reservation = metadata.get("core_checkout_reservation") or {}
            if reservation.get("token") != params["p_reservation_token"]:
                return False
            metadata.pop("core_checkout_reservation", None)
            row["metadata"] = metadata
            return True

    def _rpc_accept_core_checkout_subscription_atomic(self, params: dict) -> str:
        with self._core_checkout_lock:
            row = self._subscription_row(params["p_studio_id"])
            metadata = dict(row.get("metadata") or {})
            session = dict(metadata.get("core_checkout_session") or {})
            acceptances = dict(metadata.get("core_checkout_acceptances") or {})
            if row.get("comped") or row.get("status") == "comped":
                return "invalid"
            accepted = acceptances.get(params["p_subscription_id"])
            archived_binding = (
                isinstance(accepted, dict)
                and accepted.get("state") == "completed"
                and accepted.get("token") == params["p_reservation_token"]
                and accepted.get("epoch") == params["p_checkout_epoch"]
                and accepted.get("accepted_subscription_id") == params["p_subscription_id"]
                and (
                    params.get("p_session_id") is None
                    or accepted.get("id") == params["p_session_id"]
                )
            )
            if archived_binding:
                return "already_accepted"
            exact_binding = (
                session.get("token") == params["p_reservation_token"]
                and session.get("epoch") == params["p_checkout_epoch"]
                and session.get("accepted_subscription_id") == params["p_subscription_id"]
                and (
                    params.get("p_session_id") is None
                    or session.get("id") == params["p_session_id"]
                )
            )
            if session.get("state") == "completed" and exact_binding:
                acceptances[params["p_subscription_id"]] = dict(session)
                metadata["core_checkout_acceptances"] = acceptances
                row["metadata"] = metadata
                return "already_accepted"
            if (
                session.get("state") != "published"
                or session.get("token") != params["p_reservation_token"]
                or session.get("epoch") != params["p_checkout_epoch"]
                or (
                    params.get("p_session_id") is not None
                    and session.get("id") != params["p_session_id"]
                )
                or not params.get("p_subscription_id")
            ):
                return "invalid"
            session.pop("url", None)
            session.pop("expires_at", None)
            session.update({
                "state": "completed",
                "accepted_subscription_id": params["p_subscription_id"],
                "completed_event_created": params.get("p_event_created"),
            })
            metadata["core_checkout_session"] = session
            acceptances[params["p_subscription_id"]] = dict(session)
            metadata["core_checkout_acceptances"] = acceptances
            metadata["core_trial_consumed"] = True
            row["metadata"] = metadata
            return "accepted"

    @staticmethod
    def _parse_timestamp(value: str):
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    def _rpc_sum_email_usage_for_period(self, params: dict) -> int:
        period_start = self._parse_timestamp(params["p_period_start"])
        period_end = self._parse_timestamp(params["p_period_end"])
        return sum(
            int(row.get("quantity") or 0)
            for row in self.tables.setdefault("email_usage_events", [])
            if row.get("studio_id") == params["p_studio_id"]
            and period_start <= self._parse_timestamp(row.get("sent_at")) < period_end
        )

    def _rpc_clear_studio_comp_for_billing_event(self, params: dict) -> bool:
        row = next(
            (
                item
                for item in self.tables["studio_subscriptions"]
                if item.get("studio_id") == params["p_studio_id"]
            ),
            None,
        )
        if row is None:
            raise RuntimeError("Studio subscription not found.")
        if not row.get("comped", False):
            return False

        event_created = params.get("p_event_created")
        if (
            event_created is not None
            and not (
                self.POSTGRES_MIN_EVENT_EPOCH
                <= event_created
                < self.POSTGRES_END_EVENT_EPOCH
            )
        ):
            return False

        metadata = row.get("metadata")
        comp_value = metadata.get("comp") if isinstance(metadata, dict) else None
        comp = comp_value if isinstance(comp_value, dict) else {}
        if comp.get("state") == "granted":
            granted_at = comp.get("at")
            if event_created is None or not granted_at:
                return False
            try:
                granted_at_timestamp = self._parse_timestamp(granted_at)
                utc_offset = granted_at_timestamp.utcoffset()
                if (
                    utc_offset is not None
                    and abs(utc_offset) > self.POSTGRES_MAX_UTC_OFFSET
                ):
                    return False
                grant_epoch = granted_at_timestamp.timestamp()
            except (OSError, OverflowError, TypeError, ValueError):
                return False
            if float(event_created) < floor(grant_epoch):
                return False

        row["comped"] = False
        return True

    def _apply_studio_subscription_update(self, query, rows):
        if query.name != "studio_subscriptions":
            return None

        before_update = self.before_update
        if before_update:
            self.before_update = None
            before_update(rows)

        matched = query._matched_rows(rows)
        for row in matched:
            update = deepcopy(query.update_payload)
            previous_comp = (row.get("metadata") or {}).get("comp")
            if "metadata" in update and previous_comp is not None:
                metadata = deepcopy(update.get("metadata") or {})
                if metadata.get("comp") != previous_comp:
                    metadata["comp"] = deepcopy(previous_comp)
                update["metadata"] = metadata
            row.update(update)
        return [dict(row) for row in matched]


class FakeSettings:
    FRONTEND_URL = "https://koaryu.test"
    STRIPE_KOARYU_CORE_PRICE_ID = "price_core"


class PlatformBillingServiceTestCase(unittest.TestCase):
    def service(self, rows: list[dict]) -> PlatformBillingService:
        with patch("app.services.platform_billing_service.get_settings", return_value=FakeSettings()):
            return PlatformBillingService(FakeSupabase(rows))
