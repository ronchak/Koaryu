from __future__ import annotations

import logging
import socket
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Optional
from uuid import uuid4

try:  # pragma: no cover - exercised by whichever stripe version is installed
    from stripe import error as stripe_error
except ImportError:  # pragma: no cover
    stripe_error = None

from fastapi import HTTPException, status
from supabase import Client

from app.core.config import get_settings
from app.schemas.billing import (
    BillingLinkResponse,
    EmailUsageResponse,
    PlatformBillingStatusResponse,
)
from app.services.platform_billing_helpers import (
    INVOICE_PAYMENT_EVENT_METADATA_KEY,
    PENDING_CHECKOUT_METADATA_KEY,
    SUBSCRIPTION_EVENT_METADATA_KEY,
    build_core_checkout_idempotency_key,
    build_idempotency_key,
    merge_metadata,
    pending_checkout_metadata_update,
    pending_checkout_url,
    row_metadata,
    safe_redirect_url,
    status_response,
)
from app.services.platform_subscription_projection import PlatformSubscriptionProjector
from app.services.supabase_rpc import execute_required_rpc
from app.services.stripe_service import StripeService


logger = logging.getLogger(__name__)


EMAIL_INCLUDED_PER_MONTH = 500
EMAIL_OVERAGE_RATE_CENTS = 0.2
LIVE_STRIPE_SUBSCRIPTION_STATUSES = {"active", "trialing", "past_due", "unpaid", "paused"}
MISSING_STRIPE_CONFIGURATION_DETAIL = "Stripe is not configured for this environment."
NO_COMP_CLEAR_EVENT = object()

# A studio whose local subscription row is already non-entitled re-attempts a
# Stripe repair on every authenticated request: the repair writes the same
# non-live status back, so the trigger condition never clears. During a provider
# degradation each such request waits out a full Stripe timeout on the single
# production Uvicorn worker, so one lapsed studio can slow every other tenant.
#
# Throttling that retry has to reckon with the fact that repairing on every
# request was also an accidental safety net: when webhook delivery fails, only
# another repair can notice that a studio has paid. So the two outcomes are
# throttled very differently, because they are not the same risk.
#
# The repair call FAILED and Stripe was UNREACHABLE. This is the case that
# stalls the worker, and it costs nothing to back off hard: Stripe cannot
# confirm a payment while it is unreachable, so no amount of retrying would let
# a paid studio in any sooner.
#
# That justification covers connection failures and timeouts and nothing else.
# A reachable-but-erroring Stripe — a 5xx, a rate limit, a bad subscription id —
# returns fast, so it never ties up the worker, and checkout and webhook
# delivery are separate surfaces from the retrieve: a payment can genuinely land
# while a retrieve is erroring. Backing those off buys no availability and costs
# a paid studio real time, so they take the short window instead.
ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS = 60

# The repair call SUCCEEDED and the studio is still not entitled. Stripe is
# healthy, so a recheck is one fast call rather than a timeout, and it is the
# only thing that will notice a payment whose webhook was lost. Keep this below
# the threshold where a person waiting on a confirmed payment would notice, and
# treat it as burst collapsing for a single page load rather than a rate limit.
ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS = 5


class AccessRepairProviderError(Exception):
    """A repair failed inside the Stripe call itself.

    Raised only at the provider call sites, so anything that reaches the
    authorization path *without* this wrapper came from our own code — a failed
    persistence write, a projector defect, a Supabase fault. That distinction
    cannot be recovered by inspecting the exception afterwards, because
    `_update_subscription_row` raises the same `HTTPException` type the provider
    layer does, so it is recorded at the point where it is still known.
    """

    def __init__(self, original: Exception, *, reachable: bool):
        super().__init__(str(original))
        self.original = original
        # False only for connection failures and timeouts. Those are the ones
        # that stall the worker and the only ones the 60s backoff is justified
        # for; a reachable Stripe returning an error returns fast.
        self.reachable = reachable


def _provider_failure(exc: Exception) -> AccessRepairProviderError:
    unreachable = isinstance(exc, (TimeoutError, ConnectionError, socket.timeout))
    if not unreachable and stripe_error is not None:
        unreachable = isinstance(exc, stripe_error.APIConnectionError)
    return AccessRepairProviderError(exc, reachable=not unreachable)


class AccessRepairDeferred(Exception):
    """A repair was suppressed by the throttle and its recorded outcome was a fault.

    Raised so the caller reproduces the answer the failed repair produced rather
    than evaluating an unverified row. It carries no provider information and is
    deliberately not a provider error: nothing was contacted.
    """

    def __init__(self, studio_id: str):
        super().__init__(f"Koaryu Core subscription repair deferred for studio {studio_id}.")
        self.studio_id = studio_id


class _AccessRepairWindow:
    """What a suppressed request must replay, and until when.

    An earlier version stored only the deadline, on the premise that suppressing
    a repair "can never grant access that local state does not already support".
    That premise is false: the three repair guards inspect Stripe identifiers and
    period integrity, while the access evaluator inspects only status, comped and
    trial_end. An `active` row with null periods satisfies the first and is
    admitted by the second, so replaying it as a plain row turned a fail-closed
    503 into an allow on every request after the first.
    """

    __slots__ = ("retry_after", "replay_fault", "row_fingerprint")

    def __init__(self, retry_after: float, *, replay_fault: bool, row_fingerprint: tuple):
        self.retry_after = retry_after
        # True: the repair raised, and the caller failed closed. False: the
        # repair succeeded against a reachable Stripe and left the row
        # unrepaired, so the row it returned is verified and may be replayed.
        self.replay_fault = replay_fault
        # A recorded outcome is a statement about one row state, not about a
        # studio. The row is re-read from Supabase on every request, and webhook
        # projection or an Admin refresh can rewrite it mid-window, so an
        # outcome replayed onto a row it was not recorded for is a different
        # claim than the one that was verified — which is the same mistake, one
        # level up, as assuming a repair-pending row must be deny-side.
        self.row_fingerprint = row_fingerprint


# Keyed by studio_id. Process-local by design: it is a retry throttle, not a
# cache of entitlement. Losing it on restart is harmless.
#
# The invariant that makes suppression safe is not a claim about which rows
# reach it — it is that suppression replays the outcome recorded when the window
# opened, and never a different one. A fault replays as a fault; a verified row
# replays as that row. Access-neutrality is then structural rather than argued,
# and holds for every row shape in both directions.
#
# CONCURRENCY — read this before moving the authorization path off the event
# loop. Checking the window and recording it are not atomic. That is safe today
# only because no `await` separates them: every caller of this path reaches it
# through a synchronous call inside an async dependency, so requests for one
# studio serialise on the event-loop thread and the first records its window
# before the second checks it.
#
# The invariant is the absence of an await boundary, not the word "synchronous".
# A plain `def` path operation or dependency puts this code in FastAPI's
# threadpool today, with no other refactor required, and a burst of requests for
# one studio would then all call Stripe. Anything that introduces such a
# boundary — the threadpool move in #61 above all — must first make
# check-and-record atomic or single-flight, or accept and document a bounded
# herd of one burst per window. Running uvicorn with --workers > 1 is a separate
# and milder matter: the throttle simply becomes per-worker.
_access_repair_retry_after: dict[str, _AccessRepairWindow] = {}


class PlatformBillingService:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.settings = get_settings()

    def _subscription_projector(self) -> PlatformSubscriptionProjector:
        return PlatformSubscriptionProjector()

    async def get_status(self, studio_id: str) -> PlatformBillingStatusResponse:
        return self.get_status_sync(studio_id)

    def get_status_sync(self, studio_id: str) -> PlatformBillingStatusResponse:
        row = self.get_access_status_row(studio_id)
        return status_response(row, self._email_usage(studio_id))

    def get_access_status_row(self, studio_id: str, *, strict_repairs: bool = False) -> dict[str, Any]:
        row = self._ensure_subscription_row(studio_id)
        # strict_repairs marks the authorization path. Only that path is
        # throttled; explicit billing reads still reconcile on every call.
        if strict_repairs:
            window = self._active_access_repair_window(studio_id)
            if window is not None and window.row_fingerprint != self._row_fingerprint(row):
                # The row is not the one the outcome was recorded for — webhook
                # projection or an Admin refresh rewrote it. The recorded
                # outcome says nothing about this row, so the window is void and
                # the new state is resolved on its own merits.
                #
                # Logged because a fingerprint that flapped on an *unchanged*
                # row would void every window and silently restore the
                # unthrottled retry this whole path exists to prevent, while
                # looking exactly like the pre-throttle behaviour. Volume is the
                # signal: this should be rare, so a steady stream means the
                # fingerprint is not round-tripping.
                #
                # No studio_id: the only other logger call in this module
                # deliberately emits a random reference rather than identifiers,
                # and a rate is all the signal needs to be.
                logger.debug("Access repair window voided by a changed subscription row")
                _access_repair_retry_after.pop(studio_id, None)
                window = None
            if window is not None:
                if not self._access_repair_pending(row):
                    # Defensive. Pending-ness is a pure function of the
                    # fingerprinted fields plus a clock term that only ever
                    # moves deny-ward, so an unchanged fingerprint should not be
                    # able to stop being pending. Kept because the cost is one
                    # comparison and the failure it guards against is silent.
                    _access_repair_retry_after.pop(studio_id, None)
                    return row
                if window.replay_fault:
                    raise AccessRepairDeferred(studio_id)
                # The repair succeeded against a reachable Stripe and left the
                # row unrepaired. This is provably that same row, so returning
                # it reproduces exactly what the repair itself returned.
                return row
        try:
            for _guard, repair in ACCESS_REPAIR_STEPS:
                row = repair(self, row, strict_repairs=strict_repairs)
        except AccessRepairProviderError as exc:
            # The provider call failed and the caller will fail closed. Record
            # the backoff before re-raising: this is the path that repeats a
            # full Stripe timeout on every request, and an earlier version of
            # this throttle recorded nothing here, so the outage it was written
            # to contain went entirely unthrottled.
            if strict_repairs:
                # `row` here is whatever the chain last persisted before the
                # failure, which is what the next request will read back.
                self._open_access_repair_window(
                    studio_id,
                    ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS
                    if exc.reachable
                    else ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
                    replay_fault=True,
                    row=row,
                )
            raise
        except Exception:
            # Not a provider fault: our own persistence, projection or
            # configuration failed. It opens no window — backing off cannot help
            # and would present our outage as Stripe's — and the caller must not
            # answer it from local state, because a bug here is no evidence
            # about the studio's entitlement.
            raise
        if strict_repairs:
            self._note_access_repair_outcome(studio_id, row)
        return row

    @staticmethod
    def _row_fingerprint(row: dict[str, Any]) -> tuple:
        """Every field either repair guard or the access evaluator reads.

        Deliberately the union of both, not just the evaluator's three: a change
        that flips only a guard changes whether a repair is pending, which is
        what the window is a statement about.

        Four of the seven are load-bearing today, and each is pinned by a
        mutation-tested case: `status` and `trial_end` because the evaluator
        reads them, and the two Stripe ids for a subtler reason — they select
        *which provider endpoint* a pending repair consults.
        `_should_repair_missing_subscription` asks `list_customer_subscriptions`
        while the other two guards ask `retrieve_subscription`, and those can
        answer differently for the same studio, so moving an id can change the
        status a repair arrives at rather than merely whether one runs.

        The remaining two are defensive, for reasons that are contingent:

        - the period fields are read by the guards but not by
          `_platform_subscription_access_from_row`, and they only ever switch
          the periods guard on and off — which consults the same endpoint with
          the same id, so the repair reaches the same status either way;

        `comped` is load-bearing: the evaluator reads it, and every repair guard
        treats it as an override. Reconciliation projections structurally omit
        the column, but a concurrent operator grant still has to void a window
        recorded for the pre-grant row.

        The defensive period fields become load-bearing the moment the evaluator
        learns to read one. Narrowing this tuple to what is provably
        load-bearing today would make that future change silently reintroduce
        the widening this window exists to prevent, so it stays the full union.
        """
        return (
            row.get("status"),
            bool(row.get("comped", False)),
            row.get("trial_end"),
            row.get("current_period_start"),
            row.get("current_period_end"),
            row.get("stripe_subscription_id"),
            row.get("stripe_customer_id"),
        )

    @staticmethod
    def _active_access_repair_window(studio_id: str) -> Optional[_AccessRepairWindow]:
        window = _access_repair_retry_after.get(studio_id)
        if window is None:
            return None
        if monotonic() >= window.retry_after:
            _access_repair_retry_after.pop(studio_id, None)
            return None
        return window

    def _note_access_repair_outcome(self, studio_id: str, row: dict[str, Any]) -> None:
        """Open a short recheck window when a successful repair left the row unrepaired."""
        if not self._access_repair_pending(row):
            _access_repair_retry_after.pop(studio_id, None)
            return
        self._open_access_repair_window(
            studio_id,
            ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS,
            replay_fault=False,
            row=row,
        )

    @classmethod
    def _open_access_repair_window(
        cls,
        studio_id: str,
        seconds: float,
        *,
        replay_fault: bool,
        row: dict[str, Any],
    ) -> None:
        now = monotonic()
        # The map only holds studios that stayed unrepaired, so it is bounded by
        # tenant count, but prune expired entries so a long-lived process cannot
        # retain studios that have since been fixed.
        for key, window in list(_access_repair_retry_after.items()):
            if now >= window.retry_after:
                _access_repair_retry_after.pop(key, None)
        _access_repair_retry_after[studio_id] = _AccessRepairWindow(
            now + seconds,
            replay_fault=replay_fault,
            row_fingerprint=cls._row_fingerprint(row),
        )

    def _access_repair_pending(self, row: dict[str, Any]) -> bool:
        return any(guard(self, row) for guard, _repair in ACCESS_REPAIR_STEPS)

    async def get_email_usage(self, studio_id: str) -> EmailUsageResponse:
        return self._email_usage(studio_id)

    async def create_checkout_link(
        self,
        studio_id: str,
        actor_id: str,
        success_url: Optional[str] = None,
        cancel_url: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> BillingLinkResponse:
        row = self._ensure_subscription_row(studio_id)
        row = self._repair_missing_subscription(row)
        row = self._repair_subscription_periods(row)
        if row.get("stripe_subscription_id") and (row.get("status") or "") in LIVE_STRIPE_SUBSCRIPTION_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Koaryu Core billing is already active. Open the billing portal to manage this subscription.",
            )
        studio = self._get_studio(studio_id)
        customer_id = row.get("stripe_customer_id")
        stripe_service = StripeService()

        if not customer_id:
            customer_id = self._create_platform_customer(stripe_service, studio_id, studio)

        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        checkout_urls = {
            "success_url": safe_redirect_url(
                success_url,
                f"{frontend_url}/billing?koaryu_checkout=success",
                self.settings.FRONTEND_URL,
            ),
            "cancel_url": safe_redirect_url(
                cancel_url,
                f"{frontend_url}/billing?koaryu_checkout=cancelled",
                self.settings.FRONTEND_URL,
            ),
        }
        pending_url = pending_checkout_url(row)
        if pending_url:
            self._audit(studio_id, actor_id, "platform_billing.checkout_reused", studio_id, {"customer_id": customer_id})
            return BillingLinkResponse(url=pending_url)
        checkout_key = build_core_checkout_idempotency_key(
            studio_id,
            customer_id,
            checkout_urls,
            idempotency_key,
            self.settings.STRIPE_KOARYU_CORE_PRICE_ID,
        )
        try:
            session = stripe_service.create_core_checkout_session(
                customer_id=customer_id,
                studio_id=studio_id,
                idempotency_key=checkout_key,
                **checkout_urls,
            )
        except Exception as exc:
            if not self._is_missing_stripe_customer_error(exc):
                raise
            customer_id = self._create_platform_customer(stripe_service, studio_id, studio)
            checkout_key = build_core_checkout_idempotency_key(
                studio_id,
                customer_id,
                checkout_urls,
                idempotency_key,
                self.settings.STRIPE_KOARYU_CORE_PRICE_ID,
            )
            session = stripe_service.create_core_checkout_session(
                customer_id=customer_id,
                studio_id=studio_id,
                idempotency_key=checkout_key,
                **checkout_urls,
            )
        session_url = session["url"] if isinstance(session, dict) else session.url
        session_id = session.get("id") if isinstance(session, dict) else getattr(session, "id", None)
        expires_at = session.get("expires_at") if isinstance(session, dict) else getattr(session, "expires_at", None)
        pending_update = pending_checkout_metadata_update(
            row,
            session_id=session_id,
            session_url=session_url,
            expires_at=expires_at,
        )
        if pending_update:
            self._update_subscription_row(row["studio_id"], pending_update)
        self._audit(studio_id, actor_id, "platform_billing.checkout_created", studio_id, {"customer_id": customer_id})
        return BillingLinkResponse(url=session_url)

    async def create_portal_link(
        self,
        studio_id: str,
        actor_id: str,
        return_url: Optional[str] = None,
    ) -> BillingLinkResponse:
        row = self._ensure_subscription_row(studio_id)
        customer_id = row.get("stripe_customer_id")
        if not customer_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Add a Koaryu Core payment method before opening the billing portal.",
            )
        frontend_url = self.settings.FRONTEND_URL.rstrip("/")
        stripe_service = StripeService()
        try:
            session = stripe_service.create_customer_portal_session(
                customer_id=customer_id,
                studio_id=studio_id,
                return_url=safe_redirect_url(return_url, f"{frontend_url}/billing", self.settings.FRONTEND_URL),
                idempotency_key=build_idempotency_key("core-portal", studio_id, customer_id),
            )
        except Exception as exc:
            if not self._is_missing_stripe_customer_error(exc):
                raise
            studio = self._get_studio(studio_id)
            self._create_platform_customer(stripe_service, studio_id, studio)
            self._update_subscription_row(
                studio_id,
                {
                    "stripe_subscription_id": None,
                    "status": "incomplete",
                    "metadata": merge_metadata(row, {PENDING_CHECKOUT_METADATA_KEY: None}),
                },
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Koaryu Core billing customer was repaired. Start checkout again to restore this subscription.",
            ) from exc
        self._audit(studio_id, actor_id, "platform_billing.portal_created", studio_id, {"customer_id": customer_id})
        return BillingLinkResponse(url=session["url"] if isinstance(session, dict) else session.url)

    def project_subscription_event(self, event: dict[str, Any], *, hydrate_subscription: bool = True) -> None:
        event_type = event.get("type") or ""
        event_created = event.get("created")
        data_object = ((event.get("data") or {}).get("object") or {})

        if event_type == "checkout.session.completed":
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                return
            row = self._ensure_subscription_row(studio_id)
            stale_for_subscription_state = self._is_stale_subscription_event(row, event_created)
            stale_for_payment_state = self._is_stale_invoice_payment_event(row, event_created)
            subscription_id = self._stripe_id(data_object.get("subscription"))
            update = {"metadata": merge_metadata(row, {PENDING_CHECKOUT_METADATA_KEY: None})}
            if not stale_for_payment_state:
                update["last_payment_status"] = data_object.get("payment_status")
                self._mark_invoice_payment_event_created(update, row, event_created)
            if not stale_for_subscription_state:
                update["stripe_customer_id"] = self._stripe_id(data_object.get("customer"))
                update["stripe_subscription_id"] = subscription_id
                update["comped"] = False
                if subscription_id and hydrate_subscription:
                    try:
                        subscription = StripeService().retrieve_subscription(subscription_id)
                        update.update(self._project_subscription(subscription, clear_comp=True))
                    except Exception as exc:
                        logger.error(
                            "Stripe checkout completion subscription hydration failed; "
                            "reference=%s; error_type=%s",
                            uuid4().hex,
                            type(exc).__name__,
                        )
                        update["status"] = "incomplete"
                else:
                    update["status"] = "incomplete"
                self._mark_subscription_event_created(update, row, event_created)
            self._update_subscription_row(
                studio_id,
                {k: v for k, v in update.items() if v is not None},
                comp_clear_event_created=(
                    event_created if not stale_for_subscription_state else NO_COMP_CLEAR_EVENT
                ),
            )
            return

        if event_type.startswith("customer.subscription."):
            metadata = data_object.get("metadata") or {}
            studio_id = metadata.get("studio_id")
            if not studio_id:
                row = self._find_subscription_by_stripe_id(data_object.get("id"), data_object.get("customer"))
                studio_id = row.get("studio_id") if row else None
            if not studio_id:
                return
            row = self._ensure_subscription_row(studio_id)
            if self._is_stale_subscription_event(row, event_created):
                return
            update = self._project_subscription(data_object, clear_comp=True)
            self._mark_subscription_event_created(update, row, event_created)
            self._update_subscription_row(
                studio_id,
                update,
                comp_clear_event_created=event_created,
            )
            return

        if event_type in {"invoice.paid", "invoice.payment_failed"}:
            row = self._find_subscription_by_stripe_id(data_object.get("subscription"), data_object.get("customer"))
            if not row:
                return
            if self._is_stale_invoice_payment_event(row, event_created):
                return
            status_value = "paid" if event_type == "invoice.paid" else "failed"
            update = {"last_payment_status": status_value}
            self._mark_invoice_payment_event_created(update, row, event_created)
            self._update_subscription_row(row["studio_id"], update)

    def _ensure_subscription_row(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studio_subscriptions")
            .select("*")
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if result.data:
            return result.data
        insert_result = (
            self.supabase.table("studio_subscriptions")
            .insert({"studio_id": studio_id, "status": "incomplete", "comped": False})
            .execute()
        )
        if not insert_result.data:
            raise HTTPException(status_code=500, detail="Failed to initialize Koaryu Core billing.")
        return insert_result.data[0]

    def _create_platform_customer(self, stripe_service: StripeService, studio_id: str, studio: dict[str, Any]) -> str:
        customer = stripe_service.create_customer(
            name=studio.get("name") or "Koaryu studio",
            metadata={"studio_id": studio_id, "product": "koaryu_core"},
            studio_id=studio_id,
            idempotency_key=build_idempotency_key("core-customer", studio_id),
        )
        customer_id = customer["id"] if isinstance(customer, dict) else customer.id
        self._update_subscription_row(
            studio_id,
            {"stripe_customer_id": customer_id, "status": "incomplete"},
        )
        return customer_id

    @staticmethod
    def _is_missing_stripe_customer_error(exc: Exception) -> bool:
        if not exc.__class__.__module__.startswith("stripe"):
            return False
        message = str(exc).lower()
        return "no such customer" in message

    @staticmethod
    def is_noncritical_access_repair_error(exc: Exception) -> bool:
        return (
            isinstance(exc, HTTPException)
            and exc.status_code == status.HTTP_409_CONFLICT
            and exc.detail == MISSING_STRIPE_CONFIGURATION_DETAIL
        )

    def _can_degrade_access_repair(self, exc: Exception) -> bool:
        environment = getattr(self.settings, "ENVIRONMENT", "development")
        if isinstance(exc, AccessRepairProviderError):
            exc = exc.original
        return self.is_noncritical_access_repair_error(exc) and environment.strip().lower() == "development"

    @staticmethod
    def _is_stripe_deployment_error(exc: Exception) -> bool:
        """Stripe could not be called because this deployment is not set up.

        Neither a provider fault nor a bug in the request: nothing was
        contacted, and no retry schedule can help. A missing configuration also
        has to stay recognisable by type so `_can_degrade_access_repair` can
        keep degrading it in development.
        """
        if PlatformBillingService.is_noncritical_access_repair_error(exc):
            return True
        # The SDK-missing sibling is raised one function away from the config
        # error and means the same class of thing. Wrapping it as a provider
        # fault bought a 5s window and answered a lapsed studio with
        # SUBSCRIPTION_REQUIRED, which is a broken deploy reported as a billing
        # problem.
        return (
            isinstance(exc, HTTPException)
            and exc.status_code == status.HTTP_500_INTERNAL_SERVER_ERROR
            and isinstance(exc.detail, str)
            and "Stripe SDK is not installed" in exc.detail
        )

    @staticmethod
    def _provider_call(call, *args):
        """Run a Stripe call so its failures stay distinguishable from ours.

        Deployment errors are deliberately left untagged so they are treated as
        our own fault rather than the provider's.
        """
        try:
            return call(*args)
        except Exception as exc:
            if PlatformBillingService._is_stripe_deployment_error(exc):
                raise
            raise _provider_failure(exc) from exc

    def _update_subscription_row(
        self,
        studio_id: str,
        update: dict[str, Any],
        *,
        comp_clear_event_created: Any = NO_COMP_CLEAR_EVENT,
    ) -> dict[str, Any]:
        persisted_update = dict(update)
        if comp_clear_event_created is not NO_COMP_CLEAR_EVENT:
            # Provider projection and operator grants are ordered in the
            # database. Sending `comped=False` in this snapshot update would
            # let a webhook that read before a grant erase it after waiting for
            # the grant's row lock.
            persisted_update.pop("comped", None)
        result = (
            self.supabase.table("studio_subscriptions")
            .update(persisted_update)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Koaryu Core billing record not found.")
        if comp_clear_event_created is not NO_COMP_CLEAR_EVENT:
            # This RPC is mandatory even after the projection write. If it
            # fails, the webhook must remain failed and retryable so an ordered
            # comp clear is not silently skipped.
            execute_required_rpc(
                self.supabase,
                "clear_studio_comp_for_billing_event",
                {
                    "p_studio_id": studio_id,
                    "p_event_created": comp_clear_event_created,
                },
            )
        return result.data[0]

    def _is_stale_subscription_event(self, row: dict[str, Any], event_created: Optional[int]) -> bool:
        if event_created is None:
            return False
        last_created = row_metadata(row).get(SUBSCRIPTION_EVENT_METADATA_KEY)
        if last_created is None:
            last_created = row.get("last_stripe_event_created")
        return last_created is not None and int(last_created) > int(event_created)

    def _is_stale_invoice_payment_event(self, row: dict[str, Any], event_created: Optional[int]) -> bool:
        if event_created is None:
            return False
        last_created = row_metadata(row).get(INVOICE_PAYMENT_EVENT_METADATA_KEY)
        return last_created is not None and int(last_created) > int(event_created)

    @staticmethod
    def _merge_update_metadata(update: dict[str, Any], row: dict[str, Any], patch: dict[str, Any]) -> None:
        update["metadata"] = merge_metadata({"metadata": update.get("metadata", row.get("metadata"))}, patch)

    def _mark_subscription_event_created(
        self,
        update: dict[str, Any],
        row: dict[str, Any],
        event_created: Optional[int],
    ) -> None:
        if event_created is None:
            return
        event_created_int = int(event_created)
        previous = row_metadata(row).get(SUBSCRIPTION_EVENT_METADATA_KEY)
        if previous is None:
            previous = row.get("last_stripe_event_created")
        if previous is not None and int(previous) > event_created_int:
            return
        update["last_stripe_event_created"] = event_created_int
        self._merge_update_metadata(update, row, {SUBSCRIPTION_EVENT_METADATA_KEY: event_created_int})

    def _mark_invoice_payment_event_created(
        self,
        update: dict[str, Any],
        row: dict[str, Any],
        event_created: Optional[int],
    ) -> None:
        if event_created is None:
            return
        event_created_int = int(event_created)
        previous = row_metadata(row).get(INVOICE_PAYMENT_EVENT_METADATA_KEY)
        if previous is not None and int(previous) > event_created_int:
            return
        self._merge_update_metadata(update, row, {INVOICE_PAYMENT_EVENT_METADATA_KEY: event_created_int})

    def _find_subscription_by_stripe_id(self, subscription_id: Optional[str], customer_id: Optional[str]) -> Optional[dict[str, Any]]:
        query = self.supabase.table("studio_subscriptions").select("*")
        if subscription_id:
            result = query.eq("stripe_subscription_id", subscription_id).limit(1).execute()
            if result.data:
                return result.data[0]
        if customer_id:
            result = self.supabase.table("studio_subscriptions").select("*").eq("stripe_customer_id", customer_id).limit(1).execute()
            if result.data:
                return result.data[0]
        return None

    def _repair_subscription_periods(self, row: dict[str, Any], *, strict_repairs: bool = False) -> dict[str, Any]:
        if not self._should_repair_subscription_periods(row):
            return row
        subscription_id = row.get("stripe_subscription_id")
        try:
            subscription = self._provider_call(StripeService().retrieve_subscription, subscription_id)
            return self._update_subscription_row(row["studio_id"], self._project_subscription(subscription))
        except Exception as exc:
            if strict_repairs and not self._can_degrade_access_repair(exc):
                raise
            return row

    def _repair_stale_subscription_state(self, row: dict[str, Any], *, strict_repairs: bool = False) -> dict[str, Any]:
        if not self._should_repair_subscription_state(row):
            return row
        try:
            subscription = self._provider_call(
                StripeService().retrieve_subscription,
                row["stripe_subscription_id"],
            )
            return self._update_subscription_row(row["studio_id"], self._project_subscription(subscription))
        except Exception as exc:
            if strict_repairs and not self._can_degrade_access_repair(exc):
                raise
            return row

    def _should_repair_missing_subscription(self, row: dict[str, Any]) -> bool:
        if row.get("stripe_subscription_id"):
            return False
        if not row.get("stripe_customer_id"):
            return False
        # `comped` defaults to False here to match _should_repair_subscription_state
        # and _platform_subscription_access_from_row. The guards previously
        # disagreed (True vs False), so a row without the key skipped
        # subscription-link repair while still being eligible for stale-state
        # repair. The column is NOT NULL and the row is selected with `*`, so the
        # key is always present in practice; this only removes a latent trap.
        return not bool(row.get("comped", False))

    def _repair_missing_subscription(self, row: dict[str, Any], *, strict_repairs: bool = False) -> dict[str, Any]:
        if not self._should_repair_missing_subscription(row):
            return row

        try:
            subscriptions = self._provider_call(
                StripeService().list_customer_subscriptions,
                row["stripe_customer_id"],
            )
        except Exception as exc:
            if strict_repairs and not self._can_degrade_access_repair(exc):
                raise
            return row

        subscription = self._select_core_subscription(subscriptions, row["studio_id"])
        if not subscription:
            return row

        update = self._project_subscription(subscription)
        return self._update_subscription_row(row["studio_id"], update)

    def _select_core_subscription(self, subscriptions: Any, studio_id: str) -> Optional[Any]:
        return self._subscription_projector().select_core_subscription(
            subscriptions,
            studio_id,
            LIVE_STRIPE_SUBSCRIPTION_STATUSES,
        )

    def _should_repair_subscription_periods(self, row: dict[str, Any]) -> bool:
        """Whether provider period reconciliation is safe and necessary.

        A comp is an access override, so every reconciliation path leaves its
        provider snapshot untouched until the comp is revoked. That means Admin
        status can remain stale, checkout can remain blocked by a locally live
        status that Stripe has canceled, and lost webhooks are not repaired
        incidentally. Those display and recovery costs are preferable to a
        routine request overriding a newer operator decision.
        """
        if bool(row.get("comped", False)):
            return False
        if not row.get("stripe_subscription_id"):
            return False
        if (row.get("status") or "") not in LIVE_STRIPE_SUBSCRIPTION_STATUSES:
            return False
        if (row.get("status") or "") == "trialing" and not row.get("trial_end"):
            return True
        current_period_start = row.get("current_period_start")
        current_period_end = row.get("current_period_end")
        if not current_period_start or not current_period_end:
            return True
        start_epoch = self._timestamp_epoch(current_period_start)
        end_epoch = self._timestamp_epoch(current_period_end)
        return start_epoch is not None and end_epoch is not None and start_epoch > end_epoch

    def _should_repair_subscription_state(self, row: dict[str, Any]) -> bool:
        if not row.get("stripe_subscription_id") or bool(row.get("comped", False)):
            return False
        status_value = row.get("status") or "incomplete"
        if status_value not in LIVE_STRIPE_SUBSCRIPTION_STATUSES:
            return True
        if status_value == "trialing":
            trial_end_value = row.get("trial_end")
            trial_end = self._timestamp_epoch(trial_end_value)
            if trial_end is None:
                # A trial_end that is present but unreadable used to land here
                # as "not expired, nothing to repair", while the access
                # evaluator's `_trial_has_ended` fails closed on a parse error
                # and reads the same value as "trial is over". The two
                # disagreed about one field, so the studio was denied 402 on
                # every request and no repair ever ran to correct the row —
                # a permanent denial with no path out of it, since webhook
                # projection and the Admin refresh are the only other writers.
                #
                # Repair it instead. The evaluator stays pessimistic, which is
                # the fail-closed behaviour the billing boundary asks for; what
                # changes is that the pessimism is no longer permanent.
                #
                # An absent or empty trial_end is deliberately not this case:
                # the evaluator ignores a falsy trial_end and admits the row,
                # and _should_repair_subscription_periods already treats a
                # trialing row without a trial_end as repairable.
                return bool(trial_end_value)
            return trial_end <= datetime.now(timezone.utc).timestamp()
        return False

    def _project_subscription(
        self,
        subscription: Any,
        *,
        clear_comp: bool = False,
    ) -> dict[str, Any]:
        return self._subscription_projector().project_subscription(
            subscription,
            clear_comp=clear_comp,
        )

    def _get_studio(self, studio_id: str) -> dict[str, Any]:
        result = self.supabase.table("studios").select("id, name").eq("id", studio_id).single().execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found.")
        return result.data

    def _email_usage(self, studio_id: str) -> EmailUsageResponse:
        now = datetime.now(timezone.utc)
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if period_start.month == 12:
            period_end = period_start.replace(year=period_start.year + 1, month=1)
        else:
            period_end = period_start.replace(month=period_start.month + 1)
        result = execute_required_rpc(self.supabase, "sum_email_usage_for_period", {
            "p_studio_id": studio_id,
            "p_period_start": period_start.isoformat(),
            "p_period_end": period_end.isoformat(),
        })
        sent = self._email_usage_rpc_value(getattr(result, "data", 0))
        overage_count = max(0, sent - EMAIL_INCLUDED_PER_MONTH)
        return EmailUsageResponse(
            included=EMAIL_INCLUDED_PER_MONTH,
            sent=sent,
            overage_count=overage_count,
            estimated_overage_cents=int(round(overage_count * EMAIL_OVERAGE_RATE_CENTS)),
            period_start=period_start.isoformat(),
            period_end=period_end.isoformat(),
        )

    @staticmethod
    def _email_usage_rpc_value(value: Any) -> int:
        if isinstance(value, list):
            value = value[0] if value else 0
        if isinstance(value, dict):
            value = next(iter(value.values()), 0)
        return int(value or 0)

    @staticmethod
    def _timestamp_epoch(value: Any) -> Optional[float]:
        return PlatformSubscriptionProjector.timestamp_epoch(value)

    @classmethod
    def _stripe_id(cls, value: Any) -> Optional[str]:
        return PlatformSubscriptionProjector.stripe_id(value)

    def _audit(self, studio_id: str, actor_id: str, action: str, entity_id: str, metadata: dict[str, Any]) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()


# One ordered list, two consumers: the repair chain runs these in sequence, and
# the throttle predicate asks whether any of them would still fire on the
# post-repair row. They used to be two hand-maintained lists that happened to
# agree. A fourth repair added to the chain and missed in the predicate would
# have silently restored an unthrottled retry for whatever shape it covers —
# deny-side and availability-only, and therefore invisible. Pairing them here
# means a new repair cannot be added to one without the other.
ACCESS_REPAIR_STEPS = (
    (
        PlatformBillingService._should_repair_missing_subscription,
        PlatformBillingService._repair_missing_subscription,
    ),
    (
        PlatformBillingService._should_repair_subscription_state,
        PlatformBillingService._repair_stale_subscription_state,
    ),
    (
        PlatformBillingService._should_repair_subscription_periods,
        PlatformBillingService._repair_subscription_periods,
    ),
)
