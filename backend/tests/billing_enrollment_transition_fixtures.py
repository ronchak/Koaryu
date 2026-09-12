from __future__ import annotations

import copy
from datetime import datetime, timedelta

from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.billing_subscription_webhook_projection import (
    BillingSubscriptionWebhookProjector,
)
from app.services.billing_enrollments import BillingEnrollmentManager
from app.services.platform_billing_helpers import stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked
from tests.billing_enrollment_activation_fixtures import (
    _Facade,
    _Stripe,
    _enrollment,
    _group,
    _payer,
    _plan,
)


PERIOD_END = "2026-09-01T00:00:00+00:00"
PERIOD_END_EPOCH = 1788220800


class _TransitionFacade(_Facade):
    def _project_subscription(self, provider, account_id, event_type=""):
        group = self._get_row_or_404(
            "billing_subscriptions", "group_1", "studio_1", "Group not found."
        )
        group.update(
            {
                "stripe_account_id": account_id,
                "status": "canceled"
                if event_type == "customer.subscription.deleted"
                else provider["status"],
                "cancel_at_period_end": bool(provider.get("cancel_at_period_end")),
            }
        )
        if event_type == "customer.subscription.deleted":
            for enrollment in self.supabase.tables["student_billing_enrollments"]:
                if enrollment.get("billing_subscription_id") == group["id"]:
                    enrollment.update(
                        {
                            "status": "canceled",
                            "billing_status": "unpaid",
                            "stripe_subscription_id": None,
                            "stripe_subscription_item_id": None,
                        }
                    )
        return dict(group)


class _TransitionStripe(_Stripe):
    subscription_update_calls = []
    subscription_cancel_calls = []
    delete_item_calls = []
    schedule_create_calls = []
    schedule_update_calls = []
    schedule_release_calls = []
    schedule_retrieve_calls = []
    schedule_list_calls = []
    schedules = {}
    schedule_idempotency = {}
    schedule_create_error = None
    schedule_update_error = None
    schedule_release_error = None
    schedule_create_response_error_after = None
    schedule_update_response_error_after = None
    schedule_release_response_error_after = None
    schedule_retrieve_error = None
    schedule_retrieve_override = None

    @classmethod
    def reset(cls):
        super().reset()
        cls.subscription_update_calls = []
        cls.subscription_cancel_calls = []
        cls.delete_item_calls = []
        cls.schedule_create_calls = []
        cls.schedule_update_calls = []
        cls.schedule_release_calls = []
        cls.schedule_retrieve_calls = []
        cls.schedule_list_calls = []
        cls.schedules = {}
        cls.schedule_idempotency = {}
        cls.schedule_create_error = None
        cls.schedule_update_error = None
        cls.schedule_release_error = None
        cls.schedule_create_response_error_after = None
        cls.schedule_update_response_error_after = None
        cls.schedule_release_response_error_after = None
        cls.schedule_retrieve_error = None
        cls.schedule_retrieve_override = None

    def update_connected_subscription(self, **payload):
        self.__class__.subscription_update_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        subscription = self.__class__.subscriptions[payload["subscription_id"]]
        subscription["cancel_at_period_end"] = payload["cancel_at_period_end"]
        return copy.deepcopy(subscription)

    def cancel_connected_subscription(self, **payload):
        self.__class__.subscription_cancel_calls.append(copy.deepcopy(payload))
        subscription = self.__class__.subscriptions[payload["subscription_id"]]
        subscription["status"] = "canceled"
        return copy.deepcopy(subscription)

    def delete_connected_subscription_item(self, **payload):
        self.__class__.delete_item_calls.append(copy.deepcopy(payload))
        for subscription in self.__class__.subscriptions.values():
            subscription["items"]["data"] = [
                item
                for item in subscription["items"]["data"]
                if item["id"] != payload["subscription_item_id"]
            ]
        return {"id": payload["subscription_item_id"], "deleted": True}

    def create_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_create_calls.append(copy.deepcopy(payload))
        if self.__class__.schedule_create_error or self.__class__.provider_error:
            raise self.__class__.schedule_create_error or self.__class__.provider_error
        prior = self.__class__.schedule_idempotency.get(payload["idempotency_key"])
        if prior:
            return copy.deepcopy(self.__class__.schedules[prior])
        subscription = self.__class__.subscriptions[payload["subscription_id"]]
        schedule_id = f"sub_sched_{len(self.__class__.schedules) + 1}"
        phase_items = [
            {
                "price": copy.deepcopy(item["price"]),
                "quantity": item["quantity"],
                "metadata": copy.deepcopy(item.get("metadata") or {}),
            }
            for item in subscription["items"]["data"]
        ]
        default_settings = {
            "collection_method": subscription["collection_method"],
            "application_fee_percent": subscription.get("application_fee_percent"),
            "default_payment_method": subscription.get("default_payment_method"),
        }
        if subscription.get("days_until_due") is not None:
            default_settings["invoice_settings"] = {
                "days_until_due": subscription["days_until_due"]
            }
        phase = {
            "start_date": PERIOD_END_EPOCH - 2_592_000,
            "end_date": PERIOD_END_EPOCH,
            "items": phase_items,
            "metadata": copy.deepcopy(subscription["metadata"]),
            "collection_method": None,
            "invoice_settings": None,
            "proration_behavior": "none",
        }
        schedule = {
            "id": schedule_id,
            "status": "active",
            "subscription": subscription["id"],
            "released_subscription": None,
            "customer": subscription["customer"],
            "metadata": {},
            "default_settings": default_settings,
            "end_behavior": "release",
            "current_phase": {
                "start_date": PERIOD_END_EPOCH - 2_592_000,
                "end_date": PERIOD_END_EPOCH,
            },
            "phases": [phase],
        }
        self.__class__.schedules[schedule_id] = schedule
        self.__class__.schedule_idempotency[payload["idempotency_key"]] = schedule_id
        subscription["schedule"] = schedule_id
        if self.__class__.schedule_create_response_error_after:
            raise self.__class__.schedule_create_response_error_after
        return copy.deepcopy(schedule)

    def retrieve_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_retrieve_calls.append(copy.deepcopy(payload))
        if self.__class__.schedule_retrieve_error:
            raise self.__class__.schedule_retrieve_error
        if self.__class__.schedule_retrieve_override is not None:
            return copy.deepcopy(self.__class__.schedule_retrieve_override)
        return copy.deepcopy(self.__class__.schedules[payload["schedule_id"]])

    def update_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_update_calls.append(copy.deepcopy(payload))
        if self.__class__.schedule_update_error or self.__class__.provider_error:
            raise self.__class__.schedule_update_error or self.__class__.provider_error
        prior = self.__class__.schedule_idempotency.get(payload["idempotency_key"])
        schedule_id = prior or payload["schedule_id"]
        schedule = self.__class__.schedules[schedule_id]
        returned_phases = copy.deepcopy(payload["phases"])
        defaults = schedule.get("default_settings") or {}
        for phase in returned_phases:
            for field in (
                "collection_method",
                "application_fee_percent",
                "default_payment_method",
            ):
                if phase.get(field) == defaults.get(field):
                    phase[field] = None
            if phase.get("invoice_settings") == defaults.get("invoice_settings"):
                phase["invoice_settings"] = None
        schedule.update(
            {
                "metadata": copy.deepcopy(payload["metadata"]),
                "end_behavior": "release",
                "phases": returned_phases,
            }
        )
        self.__class__.schedule_idempotency[payload["idempotency_key"]] = schedule_id
        if self.__class__.schedule_update_response_error_after:
            raise self.__class__.schedule_update_response_error_after
        return copy.deepcopy(schedule)

    def release_connected_subscription_schedule(self, **payload):
        self.__class__.schedule_release_calls.append(copy.deepcopy(payload))
        prior = self.__class__.schedule_idempotency.get(payload["idempotency_key"])
        schedule_id = prior or payload["schedule_id"]
        schedule = self.__class__.schedules[schedule_id]
        subscription_id = schedule.get("subscription") or schedule.get("released_subscription")
        if self.__class__.schedule_release_error or self.__class__.provider_error:
            raise self.__class__.schedule_release_error or self.__class__.provider_error
        schedule.update(
            {
                "status": "released",
                "subscription": None,
                "released_subscription": subscription_id,
            }
        )
        self.__class__.subscriptions[subscription_id]["schedule"] = None
        self.__class__.schedule_idempotency[payload["idempotency_key"]] = schedule_id
        if self.__class__.schedule_release_response_error_after:
            raise self.__class__.schedule_release_response_error_after
        return copy.deepcopy(schedule)

    def list_connected_subscription_schedules(self, **payload):
        self.__class__.schedule_list_calls.append(copy.deepcopy(payload))
        return {
            "data": [
                copy.deepcopy(schedule)
                for schedule in self.__class__.schedules.values()
                if schedule.get("customer") == payload["customer_id"]
            ]
        }


def _provider(
    *,
    items,
    status="active",
    cancel_at_period_end=False,
    collection_method="charge_automatically",
    days_until_due=None,
    application_fee_percent=0.5,
    default_payment_method="pm_1",
):
    provider = {
        "id": "sub_1",
        "status": status,
        "customer": "cus_1",
        "collection_method": collection_method,
        "application_fee_percent": application_fee_percent,
        "default_payment_method": default_payment_method,
        "billing_cycle_anchor": PERIOD_END_EPOCH - 2_592_000,
        "invoice_settings": {"issuer": {"type": "self"}},
        "cancel_at_period_end": cancel_at_period_end,
        "current_period_end": PERIOD_END_EPOCH,
        "schedule": None,
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "billing_subscription_id": "group_1",
        },
        "items": {"data": items},
    }
    if days_until_due is not None:
        provider["days_until_due"] = days_until_due
    return provider


def _item(item_id="si_1", quantity=1, price_id="price_1"):
    return {
        "id": item_id,
        "quantity": quantity,
        "price": {"id": price_id},
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "enrollment_id": "enrollment_1" if item_id == "si_1" else "enrollment_2",
            "student_id": "student_1" if item_id == "si_1" else "student_2",
            "billing_plan_id": "plan_1" if price_id == "price_1" else "plan_2",
            "billing_subscription_id": "group_1",
            "product": "koaryu_payments",
        },
    }


def _apply_scheduled_item_phase(subscription_id="sub_1", *, rotate_items=False):
    subscription = _TransitionStripe.subscriptions[subscription_id]
    schedule = _TransitionStripe.schedules[subscription["schedule"]]
    by_price = {item["price"]["id"]: item for item in subscription["items"]["data"]}
    transitioned = []
    for index, phase_item in enumerate(schedule["phases"][1]["items"], start=1):
        price_id = phase_item["price"]
        item = copy.deepcopy(by_price[price_id])
        if rotate_items:
            item["id"] = f"si_replacement_{index}"
        item["quantity"] = phase_item["quantity"]
        item["metadata"] = copy.deepcopy(phase_item.get("metadata") or {})
        transitioned.append(item)
    subscription["items"]["data"] = transitioned
    schedule["current_phase"] = {
        "start_date": PERIOD_END_EPOCH,
        "end_date": PERIOD_END_EPOCH + 2_592_000,
    }


def _tables(*, peers=None):
    enrollment = _enrollment(
        status="active",
        billing_subscription_id="group_1",
        stripe_subscription_id="sub_1",
        stripe_subscription_item_id="si_1",
    )
    return {
        "student_billing_enrollments": [enrollment, *(peers or [])],
        "billing_plans": [_plan()],
        "billing_payers": [_payer()],
        "billing_subscriptions": [
            _group(current_period_end=PERIOD_END, cancel_at_period_end=False)
        ],
        "audit_logs": [],
    }


def _manager(facade):
    return BillingEnrollmentManager(facade, stripe_service_cls=_TransitionStripe)
