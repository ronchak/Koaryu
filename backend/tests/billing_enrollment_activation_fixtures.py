from __future__ import annotations

import copy

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.billing_fees import application_fee_percent
from app.services.platform_billing_helpers import build_idempotency_key
from tests.billing_lifecycle_helpers import _FakeSupabase


class _ActivationSupabase(_FakeSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.lose_provider_success_response_once = False
        self.autopay_consent_active = True
        self.autopay_reservation_hook = None
        self.lose_autopay_rejection_response_once = False
        self.fail_autopay_rejection_before_commit_once = False
        self.autopay_rejection_calls = 0

    def _rpc_reserve_billing_autopay_activation_v31(self, params):
        if self.autopay_reservation_hook is not None:
            self.autopay_reservation_hook()
        if not self.autopay_consent_active:
            raise PostgrestAPIError({
                "code": "55000",
                "message": "billing_autopay_activation_consent_invalid",
                "details": "",
                "hint": "",
            })
        payer = next(
            row for row in self.tables["billing_payers"]
            if row["id"] == params["p_payer_id"]
        )
        enrollment = next(
            row for row in self.tables["student_billing_enrollments"]
            if row["id"] == params["p_enrollment_id"]
        )
        rejection = (enrollment.get("metadata") or {}).get(
            "provider_activation_rejection"
        )
        if isinstance(rejection, dict):
            if rejection.get("caller_request_key_sha256") == params[
                "p_caller_request_key_sha256"
            ]:
                operation = next(
                    row for row in self.billing_provider_operations.values()
                    if row["id"] == rejection["operation_id"]
                )
                return {
                    "outcome": "definitive_rejected",
                    "payer": dict(payer),
                    "subscription": {},
                    "consent": {"completed_at": "2026-08-27T00:00:00Z"},
                    "operation": dict(operation),
                }
            enrollment["metadata"].pop("provider_activation_rejection", None)
        group = next(
            (
                row for row in self.tables.setdefault(
                    "billing_subscriptions", []
                )
                if row.get("payer_id") == params["p_payer_id"]
                and row.get("collection_mode") == "autopay"
                and row.get("status")
                in {"pending", "trialing", "active", "incomplete", "past_due"}
            ),
            None,
        )
        outcome = "existing"
        if group is None:
            group = {
                **self.insert_defaults["billing_subscriptions"],
                "studio_id": params["p_studio_id"],
                "payer_id": params["p_payer_id"],
                "stripe_account_id": params["p_stripe_connected_account_id"],
                "stripe_customer_id": payer["stripe_customer_id"],
                "collection_mode": "autopay",
                "billing_interval": "monthly",
                "currency": "usd",
                "status": "pending",
                "default_payment_method_id": payer[
                    "default_payment_method_id"
                ],
                "application_fee_percent": params[
                    "p_application_fee_percent"
                ],
                "metadata": {
                    "connect_account_generation": params[
                        "p_connect_account_generation"
                    ],
                    "activation_reservation": {
                        "version": 1,
                        "enrollment_id": params["p_enrollment_id"],
                    },
                },
            }
            self.tables["billing_subscriptions"].append(group)
            outcome = "created"
        elif (
            group.get("stripe_subscription_id") is None
            and (group.get("metadata") or {}).get("activation_reservation")
            == {"version": 1, "enrollment_id": params["p_enrollment_id"]}
        ):
            outcome = "created"
        return {
            "outcome": outcome,
            "payer": dict(payer),
            "subscription": dict(group),
            "consent": {"completed_at": "2026-08-27T00:00:00Z"},
        }

    def _rpc_reject_billing_autopay_activation_without_provider_v31(self, params):
        self.autopay_rejection_calls += 1
        if self.fail_autopay_rejection_before_commit_once:
            self.fail_autopay_rejection_before_commit_once = False
            raise RuntimeError("autopay rejection cleanup failed before commit")
        operation = next(
            row for row in self.billing_provider_operations.values()
            if row["id"] == params["p_operation_id"]
        )
        group = next(
            (
                row for row in self.tables["billing_subscriptions"]
                if row["id"] == params["p_billing_subscription_id"]
            ),
            None,
        )
        enrollment = next(
            row for row in self.tables["student_billing_enrollments"]
            if row["id"] == params["p_enrollment_id"]
        )
        if (
            operation["state"] == "definitive_rejected"
            and operation.get("error_code") == "provider_mutation_blocked"
        ):
            return {
                "outcome": "replay",
                "operation": dict(operation),
                "subscription_deleted": group is None,
            }
        assert operation["state"] in {"started", "provider_request_in_flight"}
        assert operation["provider_request_attempt_count"] == (
            0 if operation["state"] == "started" else 1
        )
        assert operation.get("provider_object_id") is None
        assert operation["revision"] == params["p_expected_operation_revision"]
        intent = (enrollment.get("metadata") or {}).get(
            "provider_activation_intent"
        ) or {}
        metadata = (group or {}).get("metadata") or {}
        linked = [
            row for row in self.tables["student_billing_enrollments"]
            if row.get("billing_subscription_id") == params[
                "p_billing_subscription_id"
            ]
        ]
        safe = bool(
            group
            and group.get("stripe_subscription_id") is None
            and group.get("status") == "pending"
            and metadata.get("activation_reservation") == {
                "version": 1,
                "enrollment_id": params["p_enrollment_id"],
            }
            and (metadata.get("stripe_quantity_sync_lock") or {}).get("token")
            == params["p_quantity_lock_token"]
            and intent.get("branch") == "create_subscription"
            and intent.get("desired_sha256") == params["p_request_sha256"]
            and not linked
        )
        if safe:
            enrollment["metadata"].pop("provider_activation_intent", None)
            enrollment["metadata"]["provider_activation_rejection"] = {
                "version": 1,
                "operation_id": params["p_operation_id"],
                "caller_request_key_sha256": params[
                    "p_caller_request_key_sha256"
                ],
                "request_sha256": params["p_request_sha256"],
            }
            self.tables["billing_subscriptions"].remove(group)
        operation.update({
            "state": "definitive_rejected",
            "error_code": "provider_mutation_blocked",
            "revision": operation["revision"] + 1,
        })
        result = {
            "outcome": "rejected",
            "operation": dict(operation),
            "subscription_deleted": safe,
        }
        if self.lose_autopay_rejection_response_once:
            self.lose_autopay_rejection_response_once = False
            raise RuntimeError("lost autopay rejection cleanup response")
        return result

    def _rpc_transition_billing_provider_operation_v1(self, params):
        result = super()._rpc_transition_billing_provider_operation_v1(params)
        if (
            self.lose_provider_success_response_once
            and params["p_operation_type"].startswith("enrollment.activate.")
            and params["p_to_state"] == "provider_succeeded"
        ):
            self.lose_provider_success_response_once = False
            raise RuntimeError("lost provider success response")
        return result


class _Accounts:
    def __init__(self, account):
        self.account = account

    def ensure_row(self, studio_id):
        return {"studio_id": studio_id, **self.account}


class _Facade:
    def __init__(self, tables):
        self.supabase = _ActivationSupabase(tables)
        self.account = {
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "status": "charges_enabled",
            "platform_fee_bps": 50,
            "metadata": {"connect_account_generation": 2},
        }
        self.authorized = True
        self.projection_failures = 0
        self.balance_recomputes = 0
        self.balance_failures = 0
        self.supabase.insert_defaults["billing_subscriptions"] = {
            "id": "group_created",
            "metadata": {},
            "created_at": "2026-08-27T00:00:00Z",
            "updated_at": "2026-08-27T00:00:00Z",
        }

    def _connect_accounts(self):
        return _Accounts(self.account)

    def _get_row_or_404(self, table, record_id, studio_id, detail):
        row = next((
            candidate
            for candidate in self.supabase.tables.setdefault(table, [])
            if candidate.get("id") == record_id
            and candidate.get("studio_id") == studio_id
        ), None)
        if row is None:
            raise HTTPException(status_code=404, detail=detail)
        return row

    def _ensure_record_in_studio(self, table, record_id, studio_id, detail):
        self._get_row_or_404(table, record_id, studio_id, detail)

    def _ensure_connect_ready(self, studio_id):
        return {"studio_id": studio_id, **self.account}

    @staticmethod
    def _idempotency_key(*parts):
        return build_idempotency_key(*parts)

    @staticmethod
    def _application_fee_percent(account):
        return application_fee_percent(account.get("platform_fee_bps"), default_bps=50)

    def _payer_autopay_authorized(self, _payer):
        return self.authorized

    def _project_subscription(self, provider, account_id):
        if self.projection_failures:
            self.projection_failures -= 1
            raise RuntimeError("local subscription projection failed")
        group_id = provider["metadata"]["billing_subscription_id"]
        group = self._get_row_or_404(
            "billing_subscriptions", group_id, "studio_1", "Group not found."
        )
        group.update({
            "stripe_subscription_id": provider["id"],
            "stripe_account_id": account_id,
            "stripe_customer_id": provider["customer"],
            "status": provider.get("status") or "active",
        })
        return dict(group)

    def _recompute_payer_balance(self, _studio_id, _payer_id):
        if self.balance_failures:
            self.balance_failures -= 1
            raise RuntimeError("payer balance projection failed")
        self.balance_recomputes += 1

    def _audit(self, studio_id, actor_id, action, entity_id, metadata):
        self.supabase.tables.setdefault("audit_logs", []).append({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        })


class _Stripe:
    subscriptions = {}
    create_subscription_calls = []
    add_item_calls = []
    update_item_calls = []
    retrieve_calls = []
    provider_error = None

    @classmethod
    def reset(cls):
        cls.subscriptions = {}
        cls.create_subscription_calls = []
        cls.add_item_calls = []
        cls.update_item_calls = []
        cls.retrieve_calls = []
        cls.provider_error = None

    def create_connected_subscription(self, **payload):
        self.__class__.create_subscription_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        item = {
            "id": "si_created",
            "price": {"id": payload["price_id"]},
            "quantity": 1,
            "metadata": copy.deepcopy(payload["item_metadata"]),
        }
        subscription = {
            "id": "sub_created",
            "status": "active",
            "customer": payload["customer_id"],
            "metadata": copy.deepcopy(payload["metadata"]),
            "items": {"data": [item]},
        }
        self.__class__.subscriptions[subscription["id"]] = subscription
        return copy.deepcopy(subscription)

    def create_connected_subscription_item(self, **payload):
        self.__class__.add_item_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        item = {
            "id": "si_added",
            "price": {"id": payload["price_id"]},
            "quantity": 1,
            "metadata": copy.deepcopy(payload["metadata"]),
        }
        self.__class__.subscriptions[payload["subscription_id"]]["items"]["data"].append(item)
        return copy.deepcopy(item)

    def update_connected_subscription_item(self, **payload):
        self.__class__.update_item_calls.append(copy.deepcopy(payload))
        if self.__class__.provider_error:
            raise self.__class__.provider_error
        for subscription in self.__class__.subscriptions.values():
            for item in subscription["items"]["data"]:
                if item["id"] == payload["subscription_item_id"]:
                    item["quantity"] = payload["quantity"]
                    return copy.deepcopy(item)
        raise AssertionError("subscription item missing")

    def retrieve_connected_subscription(self, **payload):
        self.__class__.retrieve_calls.append(copy.deepcopy(payload))
        return copy.deepcopy(self.__class__.subscriptions[payload["subscription_id"]])


def _enrollment(**overrides):
    return {
        "id": "enrollment_1",
        "studio_id": "studio_1",
        "student_id": "student_1",
        "payer_id": "payer_1",
        "billing_plan_id": "plan_1",
        "collection_mode": "invoice_link",
        "status": "pending",
        "billing_status": "upcoming",
        "start_date": "2026-08-27",
        "end_date": None,
        "next_bill_on": None,
        "metadata": {},
        "created_at": "2026-08-27T00:00:00Z",
        "updated_at": "2026-08-27T00:00:00Z",
        **overrides,
    }


def _plan(**overrides):
    return {
        "id": "plan_1",
        "studio_id": "studio_1",
        "name": "Core plan",
        "status": "active",
        "amount_cents": 5000,
        "currency": "usd",
        "billing_interval": "monthly",
        "trial_days": 0,
        "stripe_account_id": "acct_1",
        "stripe_product_id": "prod_1",
        "stripe_price_id": "price_1",
        **overrides,
    }


def _payer(**overrides):
    return {
        "id": "payer_1",
        "studio_id": "studio_1",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "connect_account_generation": 2,
        "default_payment_method_id": "pm_1",
        **overrides,
    }


def _price(**overrides):
    return {
        "id": "local_price_1",
        "studio_id": "studio_1",
        "billing_plan_id": "plan_1",
        "stripe_account_id": "acct_1",
        "stripe_product_id": "prod_1",
        "stripe_price_id": "price_1",
        "amount_cents": 5000,
        "currency": "usd",
        "billing_interval": "monthly",
        "recurring": True,
        "active": True,
        "metadata": {"connect_account_generation": 2},
        **overrides,
    }


def _tables(*, enrollment=None, group=None, peers=None):
    enrollments = [enrollment or _enrollment(), *(peers or [])]
    return {
        "student_billing_enrollments": enrollments,
        "billing_plans": [_plan()],
        "billing_plan_prices": [_price()],
        "billing_payers": [_payer()],
        "billing_subscriptions": [group] if group else [],
        "audit_logs": [],
    }


def _group(**overrides):
    return {
        "id": "group_1",
        "studio_id": "studio_1",
        "payer_id": "payer_1",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "stripe_subscription_id": "sub_1",
        "collection_mode": "invoice_link",
        "billing_interval": "monthly",
        "currency": "usd",
        "status": "active",
        "metadata": {"connect_account_generation": 2},
        **overrides,
    }


def _provider_subscription(*, items=None, status="active"):
    return {
        "id": "sub_1",
        "status": status,
        "customer": "cus_1",
        "metadata": {
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "billing_subscription_id": "group_1",
        },
        "items": {"data": list(items or [])},
    }


