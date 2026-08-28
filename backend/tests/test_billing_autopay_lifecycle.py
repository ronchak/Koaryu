from __future__ import annotations

import re
from types import SimpleNamespace

from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.platform_billing_helpers import stable_hash
from app.services.stripe_mutation_policy import StripeMutationBlocked

from tests.billing_lifecycle_helpers import (
    BillingInvoiceCreate,
    BillingInvoiceResponse,
    BillingPayerAutopaySetupRequest,
    BillingPaymentsLifecycleTestBase,
    BillingReconcileRequest,
    BillingService,
    HTTPException,
    StripeService,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
    _FakeBillingSettings,
    _FakeStripe,
    _FakeStripeService,
    _FakeStripeWithMismatchedAccount,
    _FakeSupabase,
    _StripeV2RequestError,
    _test_invoice_request_hash,
    asyncio,
    datetime,
    patch,
    timedelta,
    timezone,
)


def _operation_conflict() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "billing_provider_operation_request_conflict",
        "details": "",
        "hint": "",
    })


def _setup_request_not_found() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "P0002",
        "message": "billing_payer_setup_request_not_found",
        "details": "",
        "hint": "",
    })


def _autopay_disable_pending() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "55000",
        "message": "billing_payer_autopay_disable_setup_pending",
        "details": "",
        "hint": "",
    })


class _AutopayOperationSupabase(_FakeSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.operation: dict | None = None
        self.setup_request: dict | None = None
        self.consent: dict | None = None
        self.prior_consent: dict | None = None
        self.fail_bind = False
        self.fail_payer_enable_once = False
        self.fail_active_consent_read = False
        self.closed_operations: list[dict] = []
        self.close_calls: list[dict] = []
        self.prepare_calls: list[dict] = []
        self.disable_calls: list[dict] = []
        self.operation_started_at = datetime.now(timezone.utc).isoformat()
        self.on_update_query = self._handle_update

    def _handle_update(self, query, _rows):
        if (
            self.fail_payer_enable_once
            and query.name == "billing_payers"
            and (query.update_payload or {}).get("autopay_status") == "enabled"
        ):
            self.fail_payer_enable_once = False
            return []
        return None

    def _rpc_claim_billing_provider_operation_v1(self, params: dict) -> dict:
        if self.operation is None:
            operation_number = len(self.closed_operations) + 1
            self.operation = {
                "id": f"00000000-0000-4000-8000-{8100 + operation_number:012d}",
                "studio_id": params["p_studio_id"],
                "actor_id": params["p_actor_id"],
                "operation_type": params["p_operation_type"],
                "caller_request_key": params["p_caller_request_key"],
                "request_sha256": params["p_request_sha256"],
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "connect_account_generation": params["p_connect_account_generation"],
                "state": "started",
                "provider_request_attempt_count": 0,
                "provider_object_id": None,
                "provider_secondary_object_id": None,
                "reconciliation_reason_code": None,
                "revision": 0,
                "started_at": self.operation_started_at,
            }
            return {"outcome": "claimed", "operation": dict(self.operation)}
        if (
            self.operation["caller_request_key"] != params["p_caller_request_key"]
            and self.operation["state"] == "definitive_rejected"
            and (
                self.setup_request is None
                or self.setup_request.get("superseded_at")
                or (
                    self.operation["provider_request_attempt_count"] == 0
                    and self.operation.get("provider_object_id") is None
                    and self.setup_request.get("stripe_checkout_session_id") is None
                )
            )
        ):
            if self.setup_request is not None and not self.setup_request.get("superseded_at"):
                self.setup_request["superseded_at"] = "2026-08-26T12:27:00+00:00"
            self.closed_operations.append({
                "operation": dict(self.operation),
                "setup_request": (
                    dict(self.setup_request)
                    if self.setup_request is not None
                    else None
                ),
            })
            self.operation = None
            self.setup_request = None
            self.consent = None
            return self._rpc_claim_billing_provider_operation_v1(params)
        exact = all(
            self.operation[field] == params[param]
            for field, param in (
                ("studio_id", "p_studio_id"),
                ("actor_id", "p_actor_id"),
                ("operation_type", "p_operation_type"),
                ("caller_request_key", "p_caller_request_key"),
                ("request_sha256", "p_request_sha256"),
                ("stripe_connected_account_id", "p_stripe_connected_account_id"),
                ("connect_account_generation", "p_connect_account_generation"),
            )
        )
        if not exact:
            raise _operation_conflict()
        state = self.operation["state"]
        if state == "provider_request_in_flight":
            outcome = "provider_request_in_flight"
        elif state == "reconciliation_required":
            outcome = "reconciliation_required"
        elif state in {"completed", "definitive_failed", "definitive_rejected"}:
            outcome = "replay"
        else:
            outcome = "continued"
        return {"outcome": outcome, "operation": dict(self.operation)}

    def _rpc_transition_billing_provider_operation_v1(self, params: dict) -> dict:
        assert self.operation is not None
        if self.operation["revision"] != params["p_expected_revision"]:
            raise AssertionError("stale operation revision")
        self.operation["state"] = params["p_to_state"]
        self.operation["provider_object_id"] = (
            params.get("p_provider_object_id") or self.operation.get("provider_object_id")
        )
        self.operation["provider_secondary_object_id"] = (
            params.get("p_provider_secondary_object_id")
            or self.operation.get("provider_secondary_object_id")
        )
        self.operation["reconciliation_reason_code"] = params.get(
            "p_reconciliation_reason_code"
        )
        self.operation["error_code"] = params.get("p_error_code")
        self.operation["error_summary"] = params.get("p_error_summary")
        if params["p_to_state"] == "provider_request_in_flight":
            self.operation["provider_request_attempt_count"] += 1
        self.operation["revision"] += 1
        return {"outcome": "transitioned", "operation": dict(self.operation)}

    def _rpc_complete_billing_provider_operation_v1(self, params: dict) -> dict:
        assert self.operation is not None
        self.operation["state"] = "completed"
        self.operation["revision"] += 1
        return {"outcome": "completed", "operation": dict(self.operation)}

    def _rpc_prepare_billing_payer_setup_request_v1(self, params: dict) -> dict:
        self.prepare_calls.append(dict(params))
        if self.setup_request is None:
            self.setup_request = {
                "id": params["p_setup_request_id"],
                "operation_id": params["p_operation_id"],
                "studio_id": params["p_studio_id"],
                "payer_id": params["p_payer_id"],
                "initiated_by": params["p_actor_id"],
                "terms_version": params["p_terms_version"],
                "stripe_checkout_session_id": None,
                "stripe_setup_intent_id": None,
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "connect_account_generation": params["p_connect_account_generation"],
                "setup_request_expires_at": params["p_expires_at"],
                "accepted_at": None,
                "completed_at": None,
                "revoked_at": None,
                "superseded_at": None,
                "revision": 0,
            }
            return {"outcome": "prepared", "setup_request": dict(self.setup_request)}
        return {"outcome": "replay", "setup_request": dict(self.setup_request)}

    def _rpc_bind_billing_payer_setup_session_v1(self, params: dict) -> dict:
        if self.fail_bind:
            raise RuntimeError("database projection failed")
        assert self.setup_request is not None
        self.setup_request["stripe_checkout_session_id"] = params[
            "p_stripe_checkout_session_id"
        ]
        self.setup_request["revision"] += 1
        return {"outcome": "bound", "setup_request": dict(self.setup_request)}

    def _rpc_read_billing_payer_setup_request_v1(self, _params: dict) -> dict:
        if self.setup_request is None:
            raise _setup_request_not_found()
        return {"outcome": "read", "setup_request": dict(self.setup_request)}

    def _rpc_read_billing_payer_setup_webhook_v1(self, params: dict) -> dict:
        assert self.setup_request is not None
        assert self.operation is not None
        if (
            self.setup_request.get("revoked_at")
            or self.setup_request.get("superseded_at")
            or str(self.setup_request.get("setup_request_expires_at") or "").startswith("2000-")
        ):
            raise AssertionError("setup request is not active")
        if (
            self.setup_request["id"] != params["p_setup_request_id"]
            or self.setup_request["stripe_checkout_session_id"]
            != params["p_stripe_checkout_session_id"]
            or self.setup_request["stripe_connected_account_id"]
            != params["p_stripe_connected_account_id"]
            or self.setup_request["connect_account_generation"]
            != params["p_connect_account_generation"]
        ):
            raise AssertionError("webhook identity mismatch")
        return {
            "outcome": "read",
            "setup_request": dict(self.setup_request),
            "operation": {
                key: self.operation.get(key)
                for key in (
                    "id",
                    "state",
                    "operation_type",
                    "provider_object_id",
                    "provider_secondary_object_id",
                    "revision",
                )
            },
        }

    def _rpc_accept_billing_payer_payment_consent_v1(self, params: dict) -> dict:
        if self.consent is None:
            self.consent = {
                "id": "00000000-0000-4000-8000-000000008103",
                "setup_request_id": params["p_setup_request_id"],
                "studio_id": params["p_studio_id"],
                "payer_id": params["p_payer_id"],
                "terms_version": params["p_terms_version"],
                "stripe_checkout_session_id": params["p_stripe_checkout_session_id"],
                "stripe_setup_intent_id": None,
                "stripe_connected_account_id": params["p_stripe_connected_account_id"],
                "connect_account_generation": params["p_connect_account_generation"],
                "acceptance_proof_sha256": params["p_acceptance_proof_sha256"],
                "accepted_at": params["p_accepted_at"],
                "completed_at": None,
            }
            return {"outcome": "accepted", "consent": dict(self.consent)}
        return {"outcome": "replay", "consent": dict(self.consent)}

    def _rpc_complete_billing_payer_payment_consent_v1(self, params: dict) -> dict:
        assert self.consent is not None
        assert self.setup_request is not None
        assert self.operation is not None
        self.consent["stripe_setup_intent_id"] = params["p_stripe_setup_intent_id"]
        self.consent["completed_at"] = params["p_completed_at"]
        self.setup_request["stripe_setup_intent_id"] = params["p_stripe_setup_intent_id"]
        self.setup_request["completed_at"] = params["p_completed_at"]
        self.operation["provider_secondary_object_id"] = params["p_stripe_setup_intent_id"]
        self.operation["state"] = "projected"
        self.operation["revision"] += 1
        if (
            self.prior_consent
            and self.prior_consent.get("completed_at")
            and not self.prior_consent.get("revoked_at")
            and not self.prior_consent.get("superseded_at")
        ):
            self.prior_consent["superseded_at"] = params["p_completed_at"]
        return {
            "outcome": "completed",
            "consent": dict(self.consent),
            "operation": dict(self.operation),
        }

    def _rpc_finalize_billing_payer_setup_projection_v1(self, params: dict) -> dict:
        assert self.operation is not None
        assert self.setup_request is not None
        assert self.consent is not None
        payer = next(
            row for row in self.tables["billing_payers"]
            if row["id"] == params["p_payer_id"]
        )
        assert self.operation["state"] == "projected"
        assert payer["autopay_status"] == "enabled"
        assert payer["default_payment_method_id"]
        assert payer["autopay_authorized_at"] == self.consent["completed_at"]
        assert payer["autopay_terms_accepted_at"] == self.consent["accepted_at"]
        self.operation["state"] = "completed"
        self.operation["revision"] += 1
        return {
            "outcome": "completed",
            "consent": dict(self.consent),
            "setup_request": dict(self.setup_request),
            "operation": dict(self.operation),
        }

    def _rpc_read_active_billing_payer_payment_consent_v1(self, _params: dict) -> dict:
        if self.fail_active_consent_read:
            raise RuntimeError("active consent read unavailable")
        active_consent = next(
            (
                consent
                for consent in (self.consent, self.prior_consent)
                if consent is not None
                and consent.get("completed_at")
                and not consent.get("revoked_at")
                and not consent.get("superseded_at")
            ),
            None,
        )
        assert active_consent is not None
        return {"outcome": "read", "consent": dict(active_consent)}

    def _rpc_disable_billing_payer_autopay_v1(self, params: dict) -> dict:
        self.disable_calls.append(dict(params))
        payer = next(
            row for row in self.tables["billing_payers"]
            if row["id"] == params["p_payer_id"]
            and row["studio_id"] == params["p_studio_id"]
        )
        if (
            self.setup_request
            and not self.setup_request.get("revoked_at")
            and not self.setup_request.get("superseded_at")
            and not self.setup_request.get("completed_at")
            and self.operation
            and self.operation.get("state") in {
                "started",
                "provider_request_in_flight",
                "provider_succeeded",
                "projected",
                "reconciliation_required",
                "recovery_authorized",
            }
        ):
            raise _autopay_disable_pending()
        revoked_consent_id = None
        if (
            self.consent
            and self.consent.get("completed_at")
            and not self.consent.get("revoked_at")
            and not self.consent.get("superseded_at")
        ):
            revoked_consent_id = self.consent["id"]
            self.consent.update({
                "revoked_at": params["p_disabled_at"],
                "revoked_by": params["p_actor_id"],
                "revocation_reason_code": params["p_reason_code"],
            })
            if self.setup_request:
                self.setup_request["revoked_at"] = params["p_disabled_at"]
        payer.update({
            "autopay_status": "disabled",
            "autopay_disabled_at": params["p_disabled_at"],
        })
        return {
            "outcome": "disabled",
            "payer": dict(payer),
            "revoked_consent_id": revoked_consent_id,
        }

    def _rpc_mark_billing_payer_setup_reconciliation_v1(self, params: dict) -> dict:
        assert self.operation is not None
        assert self.setup_request is not None
        assert self.operation["state"] in {
            "provider_succeeded",
            "projected",
            "completed",
            "reconciliation_required",
        }
        assert self.operation["provider_object_id"] == params[
            "p_stripe_checkout_session_id"
        ]
        if self.setup_request.get("stripe_checkout_session_id") is None:
            self.setup_request["stripe_checkout_session_id"] = params[
                "p_stripe_checkout_session_id"
            ]
            self.setup_request["revision"] += 1
        else:
            assert self.setup_request["stripe_checkout_session_id"] == params[
                "p_stripe_checkout_session_id"
            ]
        self.operation["state"] = "reconciliation_required"
        self.operation["reconciliation_reason_code"] = params[
            "p_reconciliation_reason_code"
        ]
        self.operation["revision"] += 1
        return {"outcome": "transitioned", "operation": dict(self.operation)}

    def _rpc_reject_billing_payer_setup_without_provider_v1(self, params: dict) -> dict:
        assert self.operation is not None
        assert self.setup_request is not None
        assert self.operation["id"] == params["p_operation_id"]
        assert self.setup_request["id"] == params["p_setup_request_id"]
        assert self.operation["studio_id"] == params["p_studio_id"]
        assert self.operation["actor_id"] == params["p_actor_id"]
        assert self.setup_request["payer_id"] == params["p_payer_id"]
        assert self.operation["caller_request_key"] == params["p_caller_request_key"]
        assert self.operation["request_sha256"] == params["p_request_sha256"]
        assert self.operation["stripe_connected_account_id"] == params[
            "p_stripe_connected_account_id"
        ]
        assert self.operation["connect_account_generation"] == params[
            "p_connect_account_generation"
        ]
        assert self.operation["revision"] == params["p_expected_operation_revision"]
        assert self.setup_request["revision"] == params["p_expected_setup_revision"]
        assert self.operation["state"] == "provider_request_in_flight"
        assert self.operation["provider_request_attempt_count"] == 1
        assert self.operation.get("provider_object_id") is None
        assert self.operation.get("provider_secondary_object_id") is None
        assert self.setup_request.get("stripe_checkout_session_id") is None
        assert self.setup_request.get("stripe_setup_intent_id") is None
        if (
            self.consent
            and not self.consent.get("completed_at")
            and not self.consent.get("revoked_at")
            and not self.consent.get("superseded_at")
        ):
            self.consent["superseded_at"] = "2026-08-26T12:21:00+00:00"
        self.setup_request.update({
            "superseded_at": "2026-08-26T12:21:00+00:00",
            "closed_at": "2026-08-26T12:21:00+00:00",
            "close_reason_code": "provider_mutation_blocked",
            "provider_read_proof_sha256": None,
            "revision": self.setup_request["revision"] + 1,
        })
        self.operation.update({
            "state": "definitive_rejected",
            "error_code": "provider_mutation_blocked",
            "revision": self.operation["revision"] + 1,
        })
        return {
            "outcome": "rejected",
            "setup_request": dict(self.setup_request),
            "operation": dict(self.operation),
        }

    def _rpc_close_billing_payer_setup_request_v1(self, params: dict) -> dict:
        assert self.operation is not None
        assert self.setup_request is not None
        assert self.operation["state"] in {
            "provider_succeeded",
            "reconciliation_required",
        }
        assert params["p_close_reason_code"] in {
            "checkout_session_expired",
            "checkout_session_terminal_unusable",
        }
        assert re.fullmatch(r"[0-9a-f]{64}", params["p_provider_read_proof_sha256"])
        assert self.operation["id"] == params["p_operation_id"]
        assert self.setup_request["id"] == params["p_setup_request_id"]
        assert self.operation["provider_object_id"] == params[
            "p_stripe_checkout_session_id"
        ]
        assert self.setup_request["stripe_checkout_session_id"] == params[
            "p_stripe_checkout_session_id"
        ]
        self.close_calls.append(dict(params))
        self.operation["state"] = "definitive_rejected"
        self.operation["error_code"] = "payer_setup_session_closed"
        self.operation["error_summary"] = params["p_close_reason_code"]
        self.operation["revision"] += 1
        self.setup_request["close_reason_code"] = params["p_close_reason_code"]
        self.setup_request["provider_read_proof_sha256"] = params[
            "p_provider_read_proof_sha256"
        ]
        self.setup_request["closed_at"] = "2026-08-26T12:31:00+00:00"
        self.setup_request["superseded_at"] = "2026-08-26T12:31:00+00:00"
        self.setup_request["revision"] += 1
        return {
            "outcome": "closed",
            "setup_request": dict(self.setup_request),
            "operation": dict(self.operation),
        }


def _autopay_tables(*, saved_card: bool = False) -> dict[str, list[dict]]:
    payer = {
        "id": "payer_1",
        "studio_id": "studio_1",
        "display_name": "Rehearsal Payer",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "connect_account_generation": 1,
        "autopay_status": "not_configured",
        "billing_status": "current",
        "metadata": {},
    }
    if saved_card:
        payer.update({
            "default_payment_method_id": "pm_saved",
            "default_payment_method_brand": "visa",
            "default_payment_method_last4": "4242",
        })
    return {
        "studio_payment_accounts": [{
            "studio_id": "studio_1",
            "stripe_connected_account_id": "acct_1",
            "status": "charges_enabled",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements_due": [],
            "platform_fee_bps": 50,
            "metadata": {"connect_account_generation": 1},
        }],
        "billing_payers": [payer],
        "audit_logs": [],
    }


class BillingAutopayLifecycleTest(BillingPaymentsLifecycleTestBase):
    def _enabled_payer_replacement_setup(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        tables = _autopay_tables(saved_card=True)
        payer = tables["billing_payers"][0]
        payer.update({
            "autopay_status": "enabled",
            "autopay_authorized_at": "2026-08-26T12:06:00+00:00",
            "autopay_terms_accepted_at": "2026-08-26T12:05:00+00:00",
        })
        database = _AutopayOperationSupabase(tables)
        database.prior_consent = {
            "id": "00000000-0000-4000-8000-000000008099",
            "setup_request_id": "00000000-0000-4000-8000-000000008098",
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "terms_version": "koaryu-autopay-v1",
            "stripe_checkout_session_id": "cs_setup_old",
            "stripe_setup_intent_id": "seti_old",
            "stripe_connected_account_id": "acct_1",
            "connect_account_generation": 1,
            "accepted_at": "2026-08-26T12:05:00+00:00",
            "completed_at": "2026-08-26T12:06:00+00:00",
            "revoked_at": None,
            "superseded_at": None,
        }
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        return service, database

    def _prepared_consent_setup(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "autopay-key",
            ))
        session = {
            "id": "cs_setup_1",
            "status": "complete",
            "customer": "cus_1",
            "setup_intent": "seti_1",
            "consent": {"terms_of_service": "accepted"},
            "metadata": dict(_FakeStripeService.setup_calls[0]["metadata"]),
        }
        return service, database, session

    def test_setup_checkout_collects_provider_terms_in_setup_mode(self):
        captured: dict = {}

        class Session:
            @staticmethod
            def create(**payload):
                captured.update(payload)
                return {"id": "cs_1", "url": "https://checkout.stripe.test/setup"}

        stripe_service = object.__new__(StripeService)
        stripe_service._stripe = lambda: SimpleNamespace(  # type: ignore[method-assign]
            checkout=SimpleNamespace(Session=Session),
        )
        metadata = {
            "product": "koaryu_payments_autopay",
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "billing_operation_id": "operation_1",
            "terms_version": "koaryu-autopay-v1",
        }

        result = StripeService.create_setup_checkout_session.__wrapped__(
            stripe_service,
            account_id="acct_1",
            studio_id="studio_1",
            customer_id="cus_1",
            success_url="https://app.koaryu.test/billing?autopay=success",
            cancel_url="https://app.koaryu.test/billing?autopay=cancelled",
            metadata=metadata,
            idempotency_key="autopay-operation-key",
            expires_at=1_800_000_000,
        )

        self.assertEqual(result["id"], "cs_1")
        self.assertEqual(captured["mode"], "setup")
        self.assertEqual(captured["customer"], "cus_1")
        self.assertEqual(
            captured["consent_collection"],
            {"terms_of_service": "required"},
        )
        self.assertEqual(captured["setup_intent_data"], {"metadata": metadata})
        self.assertEqual(captured["metadata"], metadata)
        self.assertEqual(captured["expires_at"], 1_800_000_000)
        self.assertEqual(captured["stripe_account"], "acct_1")
        self.assertEqual(captured["idempotency_key"], "autopay-operation-key")
    def test_successful_invoice_payment_does_not_replace_payer_consent_method(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payments": [],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "status": "open",
                "amount_due_cents": 200,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 200,
                "currency": "usd",
                "application_fee_amount_cents": 1,
                "created_at": "2026-05-18T19:00:00Z",
            }],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "autopay_status": "enabled",
                "default_payment_method_id": "pm_consented",
                "default_payment_method_brand": "visa",
                "default_payment_method_last4": "4242",
            }],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "invoice": "in_1",
            "latest_charge": "ch_1",
            "payment_method": {
                "id": "pm_1",
                "type": "card",
                "card": {"brand": "visa", "last4": "2167"},
            },
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["default_payment_method_id"], "pm_consented")
        self.assertEqual(payer["default_payment_method_brand"], "visa")
        self.assertEqual(payer["default_payment_method_last4"], "4242")
        self.assertEqual(payer["autopay_status"], "enabled")

    def test_saved_card_and_legacy_staff_fields_do_not_authorize_without_durable_consent(self):
        service = self.service()
        tables = _autopay_tables(saved_card=True)
        payer = tables["billing_payers"][0]
        payer["autopay_status"] = "enabled"
        payer["autopay_terms_accepted_at"] = "2026-08-26T12:05:00+00:00"
        service.supabase = _AutopayOperationSupabase(tables)

        self.assertFalse(service._payer_autopay_authorized(payer))

    def test_abandoned_replacement_setup_keeps_existing_consent_enabled(self):
        service, database = self._enabled_payer_replacement_setup()
        payer = database.tables["billing_payers"][0]
        prior_projection = {
            key: payer.get(key)
            for key in (
                "autopay_status",
                "autopay_authorized_at",
                "autopay_terms_accepted_at",
                "default_payment_method_id",
            )
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            link = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "replacement-key",
            ))

        self.assertEqual(link.url, "https://checkout.stripe.test/setup")
        self.assertEqual(
            {
                key: payer.get(key)
                for key in prior_projection
            },
            prior_projection,
        )
        self.assertIsNone(database.prior_consent["superseded_at"])
        self.assertIsNone(database.consent)
        self.assertIsNone(database.setup_request["completed_at"])

    def test_replacement_setup_fails_closed_when_active_consent_read_is_unavailable(self):
        service, database = self._enabled_payer_replacement_setup()
        payer = database.tables["billing_payers"][0]
        prior_projection = dict(payer)
        prior_consent = dict(database.prior_consent)
        setup_call_count = len(_FakeStripeService.setup_calls)
        database.fail_active_consent_read = True

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as blocked:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "replacement-consent-read-unavailable",
                ))

        self.assertEqual(blocked.exception.status_code, 503)
        self.assertIn("Existing autopay consent could not be verified", blocked.exception.detail)
        self.assertEqual(payer, prior_projection)
        self.assertEqual(database.prior_consent, prior_consent)
        self.assertEqual(len(_FakeStripeService.setup_calls), setup_call_count)
        self.assertIsNone(database.setup_request)
        self.assertEqual(database.operation["state"], "started")

    def test_successful_replacement_switches_consent_and_payment_method_at_completion(self):
        service, database = self._enabled_payer_replacement_setup()
        payer = database.tables["billing_payers"][0]

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "replacement-key",
            ))

        self.assertEqual(payer["autopay_status"], "enabled")
        self.assertEqual(payer["default_payment_method_id"], "pm_saved")
        session = {
            "id": "cs_setup_1",
            "status": "complete",
            "customer": "cus_1",
            "setup_intent": "seti_replacement",
            "consent": {"terms_of_service": "accepted"},
            "metadata": dict(_FakeStripeService.setup_calls[0]["metadata"]),
        }

        class SuccessfulReplacementStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                return {
                    "id": "seti_replacement",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_replacement",
                        "type": "card",
                        "card": {"brand": "mastercard", "last4": "4444"},
                    },
                }

        with patch(
            "app.services.billing_service.StripeService",
            SuccessfulReplacementStripeService,
        ):
            service._project_checkout_session(session, "acct_1", event_created=200)

        self.assertEqual(payer["autopay_status"], "enabled")
        self.assertEqual(payer["default_payment_method_id"], "pm_replacement")
        self.assertEqual(payer["autopay_authorized_at"], database.consent["completed_at"])
        self.assertEqual(
            payer["autopay_terms_accepted_at"],
            database.consent["accepted_at"],
        )
        self.assertEqual(
            database.prior_consent["superseded_at"],
            database.consent["completed_at"],
        )
        self.assertEqual(database.operation["state"], "completed")

    def test_policy_rejection_restores_payer_and_new_key_supersedes_no_object_request(self):
        class PolicyBlockedStripeService(_FakeStripeService):
            blocked = True

            def create_setup_checkout_session(self, **payload):
                if self.__class__.blocked:
                    raise StripeMutationBlocked(
                        status_code=503,
                        detail="provider mutation blocked",
                    )
                return super().create_setup_checkout_session(**payload)

        PolicyBlockedStripeService.reset()
        PolicyBlockedStripeService.blocked = True
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        PolicyBlockedStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        payer = database.tables["billing_payers"][0]
        prior_projection = {
            key: payer.get(key)
            for key in (
                "autopay_status",
                "autopay_authorized_at",
                "autopay_terms_accepted_at",
            )
        }

        with (
            patch(
                "app.services.billing_service.StripeService",
                PolicyBlockedStripeService,
            ),
            self.assertRaises(StripeMutationBlocked) as blocked,
        ):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "blocked-key",
            ))

        self.assertEqual(blocked.exception.status_code, 503)
        self.assertEqual(database.operation["state"], "definitive_rejected")
        self.assertEqual(database.operation["provider_request_attempt_count"], 1)
        self.assertIsNone(database.operation["provider_object_id"])
        self.assertEqual(
            database.setup_request["close_reason_code"],
            "provider_mutation_blocked",
        )
        self.assertEqual(
            database.setup_request["closed_at"],
            database.setup_request["superseded_at"],
        )
        self.assertEqual(
            {key: payer.get(key) for key in prior_projection},
            prior_projection,
        )
        self.assertEqual(PolicyBlockedStripeService.setup_calls, [])
        with (
            patch(
                "app.services.billing_service.StripeService",
                PolicyBlockedStripeService,
            ),
            self.assertRaises(HTTPException) as same_key,
        ):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "blocked-key",
            ))

        self.assertEqual(same_key.exception.status_code, 409)
        PolicyBlockedStripeService.blocked = False
        database.operation_started_at = datetime.now(timezone.utc).isoformat()
        with patch(
            "app.services.billing_service.StripeService",
            PolicyBlockedStripeService,
        ):
            recovered = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "fresh-key",
            ))

        self.assertEqual(recovered.url, "https://checkout.stripe.test/setup")
        self.assertEqual(len(PolicyBlockedStripeService.setup_calls), 1)
        self.assertEqual(len(database.closed_operations), 1)
        closed = database.closed_operations[0]
        self.assertEqual(closed["operation"]["state"], "definitive_rejected")
        self.assertEqual(closed["operation"]["provider_request_attempt_count"], 1)
        self.assertIsNotNone(closed["setup_request"]["superseded_at"])

    def test_autopay_setup_rejects_missing_or_malformed_idempotency_key(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()

        for value in ("", "   ", "é" * 128):
            with self.subTest(value=value), self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    value,
                ))

            self.assertEqual(context.exception.status_code, 400)
            self.assertIn("Idempotency-Key", context.exception.detail)

    def test_saved_card_never_bypasses_provider_consent_checkout(self):
        class AtTwelveTwenty(datetime):
            @classmethod
            def now(cls, tz=None):
                value = cls(2026, 8, 26, 12, 20, tzinfo=timezone.utc)
                return value if tz is None else value.astimezone(tz)

        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _AutopayOperationSupabase(_autopay_tables(saved_card=True))
        service.supabase.operation_started_at = "2026-08-26T12:00:00+00:00"
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.setup_calls = []

        with (
            patch("app.services.billing_service.StripeService", _FakeStripeService),
            patch("app.services.billing_autopay.datetime", AtTwelveTwenty),
        ):
            link = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(
                    return_url="https://app.koaryu.test/billing",
                ),
                "studio_1",
                "user_1",
                "autopay-key",
            ))

        self.assertEqual(link.url, "https://checkout.stripe.test/setup")
        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertIsNone(payer.get("autopay_authorized_at"))
        self.assertIsNone(payer.get("autopay_terms_accepted_at"))
        self.assertEqual(len(_FakeStripeService.setup_calls), 1)
        checkout = _FakeStripeService.setup_calls[0]
        self.assertEqual(checkout["customer_id"], "cus_1")
        self.assertEqual(checkout["metadata"]["terms_version"], "koaryu-autopay-v1")
        self.assertIn("setup_request_id", checkout["metadata"])
        self.assertIn("operation_id", checkout["metadata"])
        self.assertNotIn("actor_id", checkout["metadata"])
        self.assertNotIn("url", repr(service.supabase.operation))
        self.assertNotIn("url", repr(service.supabase.setup_request))
        self.assertEqual(
            checkout["expires_at"],
            int(datetime(2026, 8, 26, 12, 55, tzinfo=timezone.utc).timestamp()),
        )
        self.assertEqual(
            service.supabase.setup_request["setup_request_expires_at"],
            "2026-08-26T12:55:00+00:00",
        )
        self.assertGreaterEqual(
            checkout["expires_at"]
            - int(datetime(2026, 8, 26, 12, 20, tzinfo=timezone.utc).timestamp()),
            30 * 60,
        )
        audit_metadata = service.supabase.tables["audit_logs"][0]["metadata"]
        self.assertEqual(
            set(audit_metadata),
            {"operation_id", "setup_request_id", "terms_version"},
        )

    def test_lost_response_same_key_replays_without_second_stripe_mutation(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        request = BillingPayerAutopaySetupRequest(
            return_url="https://app.koaryu.test/internal/staff-page",
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            first = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                request,
                "studio_1",
                "user_1",
                "autopay-key",
            ))
            replay = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                request,
                "studio_1",
                "user_1",
                "autopay-key",
            ))
            database.operation["state"] = "completed"
            with self.assertRaises(HTTPException) as completed:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    request,
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(first.url, "https://checkout.stripe.test/setup")
        self.assertEqual(replay.url, first.url)
        self.assertEqual(completed.exception.status_code, 409)
        self.assertIn("new Idempotency-Key", completed.exception.detail)
        self.assertNotIn("internal/staff-page", completed.exception.detail)
        self.assertEqual(len(_FakeStripeService.setup_calls), 1)
        self.assertEqual(database.operation["provider_request_attempt_count"], 1)

    def test_same_key_pre_provider_replay_inside_final_five_minutes_keeps_exact_request(self):
        class AtTwelveOhOne(datetime):
            @classmethod
            def now(cls, tz=None):
                value = cls(2026, 8, 26, 12, 1, tzinfo=timezone.utc)
                return value if tz is None else value.astimezone(tz)

        class AtTwelveTwentySeven(datetime):
            @classmethod
            def now(cls, tz=None):
                value = cls(2026, 8, 26, 12, 27, tzinfo=timezone.utc)
                return value if tz is None else value.astimezone(tz)

        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        database.operation_started_at = "2026-08-26T12:00:00+00:00"
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with (
            patch("app.services.billing_service.StripeService", _FakeStripeService),
            patch("app.services.billing_autopay.datetime", AtTwelveOhOne),
            patch(
                "app.services.billing_provider_operations.BillingProviderOperationCoordinator.transition",
                side_effect=RuntimeError("crash after setup request preparation"),
            ),
            self.assertRaisesRegex(RuntimeError, "crash after setup request preparation"),
        ):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "autopay-key",
            ))

        original_request_id = database.setup_request["id"]
        self.assertEqual(database.operation["state"], "started")
        self.assertEqual(_FakeStripeService.setup_calls, [])

        with (
            patch("app.services.billing_service.StripeService", _FakeStripeService),
            patch("app.services.billing_autopay.datetime", AtTwelveTwentySeven),
            self.assertRaises(HTTPException) as expiring,
        ):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "autopay-key",
            ))

        self.assertEqual(expiring.exception.status_code, 409)
        self.assertIn("new Idempotency-Key", expiring.exception.detail)
        self.assertEqual(database.setup_request["id"], original_request_id)
        self.assertEqual(
            database.setup_request["setup_request_expires_at"],
            "2026-08-26T12:36:00+00:00",
        )
        self.assertEqual(database.operation["state"], "definitive_rejected")
        self.assertEqual(database.operation["provider_request_attempt_count"], 0)
        self.assertEqual(len(database.prepare_calls), 2)
        self.assertEqual(
            database.prepare_calls[0]["p_setup_request_id"],
            database.prepare_calls[1]["p_setup_request_id"],
        )
        self.assertEqual(_FakeStripeService.setup_calls, [])

        database.operation_started_at = "2026-08-26T12:27:00+00:00"
        with (
            patch("app.services.billing_service.StripeService", _FakeStripeService),
            patch("app.services.billing_autopay.datetime", AtTwelveTwentySeven),
        ):
            fresh = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "autopay-key-new",
            ))

        self.assertEqual(fresh.url, "https://checkout.stripe.test/setup")
        self.assertEqual(len(_FakeStripeService.setup_calls), 1)
        self.assertEqual(
            database.closed_operations[0]["operation"]["provider_request_attempt_count"],
            0,
        )

    def test_expired_checkout_closes_old_request_before_deliberate_new_key(self):
        class ExpiredCheckoutStripeService(_FakeStripeService):
            def create_setup_checkout_session(self, **payload):
                self.__class__.setup_calls.append(payload)
                sequence = len(self.__class__.setup_calls)
                return {
                    "id": f"cs_setup_{sequence}",
                    "url": f"https://checkout.stripe.test/setup/{sequence}",
                    "expires_at": payload["expires_at"],
                }

            def retrieve_connected_checkout_session(
                self,
                *,
                account_id: str,
                session_id: str,
                expand=None,
            ):
                return {
                    "id": session_id,
                    "url": "https://checkout.stripe.test/setup/1",
                    "status": "expired",
                    "expires_at": int(
                        datetime(2026, 8, 26, 12, 30, tzinfo=timezone.utc).timestamp()
                    ),
                }

        class AtTwelveThirtyOne(datetime):
            @classmethod
            def now(cls, tz=None):
                value = cls(2026, 8, 26, 12, 31, tzinfo=timezone.utc)
                return value if tz is None else value.astimezone(tz)

        class AtTwelveOhOne(datetime):
            @classmethod
            def now(cls, tz=None):
                value = cls(2026, 8, 26, 12, 1, tzinfo=timezone.utc)
                return value if tz is None else value.astimezone(tz)

        ExpiredCheckoutStripeService.reset()
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        ExpiredCheckoutStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", ExpiredCheckoutStripeService):
            with patch("app.services.billing_autopay.datetime", AtTwelveOhOne):
                first = asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key-old",
                ))
            with (
                patch("app.services.billing_autopay.datetime", AtTwelveThirtyOne),
                self.assertRaises(HTTPException) as expired,
            ):
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key-old",
                ))

            database.operation_started_at = "2026-08-26T12:31:00+00:00"
            with patch("app.services.billing_autopay.datetime", AtTwelveThirtyOne):
                second = asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key-new",
                ))

        self.assertEqual(expired.exception.status_code, 409)
        self.assertIn("new Idempotency-Key", expired.exception.detail)
        self.assertEqual(first.url, "https://checkout.stripe.test/setup/1")
        self.assertEqual(second.url, "https://checkout.stripe.test/setup/2")
        self.assertEqual(len(ExpiredCheckoutStripeService.setup_calls), 2)
        self.assertEqual(len(database.close_calls), 1)
        close = database.close_calls[0]
        self.assertEqual(
            set(close),
            {
                "p_setup_request_id",
                "p_operation_id",
                "p_studio_id",
                "p_payer_id",
                "p_stripe_checkout_session_id",
                "p_stripe_connected_account_id",
                "p_connect_account_generation",
                "p_close_reason_code",
                "p_provider_read_proof_sha256",
            },
        )
        self.assertEqual(close["p_close_reason_code"], "checkout_session_expired")
        self.assertEqual(
            close["p_provider_read_proof_sha256"],
            stable_hash({
                "operation_id": close["p_operation_id"],
                "setup_request_id": close["p_setup_request_id"],
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_checkout_session_id": "cs_setup_1",
                "stripe_connected_account_id": "acct_1",
                "connect_account_generation": 1,
                "checkout_session_status": "expired",
                "checkout_session_expires_at": int(
                    datetime(2026, 8, 26, 12, 30, tzinfo=timezone.utc).timestamp()
                ),
                "close_reason_code": "checkout_session_expired",
            }),
        )
        self.assertNotIn("url", repr(close))
        old = database.closed_operations[0]
        self.assertEqual(old["operation"]["state"], "definitive_rejected")
        self.assertEqual(old["operation"]["provider_request_attempt_count"], 1)
        self.assertEqual(old["setup_request"]["superseded_at"], "2026-08-26T12:31:00+00:00")
        self.assertNotIn("checkout.stripe.test", repr(old))
        self.assertEqual(
            len({call["idempotency_key"] for call in ExpiredCheckoutStripeService.setup_calls}),
            2,
        )

    def test_ambiguous_or_in_flight_setup_is_never_definitively_closed(self):
        for operation_state in ("provider_request_in_flight", "reconciliation_required"):
            with self.subTest(operation_state=operation_state):
                _FakeStripeService.reset()
                service = self.service()
                service.settings = type("Settings", (), {
                    "BILLING_PLATFORM_FEE_BPS": 50,
                    "FRONTEND_URL": "https://app.koaryu.test",
                })()
                database = _AutopayOperationSupabase(_autopay_tables())
                service.supabase = database
                _FakeStripeService.retrieve_account_response = {
                    "id": "acct_1",
                    "charges_enabled": True,
                    "payouts_enabled": True,
                    "details_submitted": True,
                    "requirements": {"currently_due": []},
                }
                with patch("app.services.billing_service.StripeService", _FakeStripeService):
                    asyncio.run(service.create_autopay_setup_link(
                        "payer_1",
                        BillingPayerAutopaySetupRequest(),
                        "studio_1",
                        "user_1",
                        "autopay-key",
                    ))
                    database.operation["state"] = operation_state
                    with self.assertRaises(HTTPException):
                        asyncio.run(service.create_autopay_setup_link(
                            "payer_1",
                            BillingPayerAutopaySetupRequest(),
                            "studio_1",
                            "user_1",
                            "autopay-key",
                        ))

                self.assertEqual(database.close_calls, [])
                self.assertEqual(len(_FakeStripeService.setup_calls), 1)

    def test_unknown_checkout_status_does_not_close_or_mutate_provider(self):
        class UnknownStatusStripeService(_FakeStripeService):
            def retrieve_connected_checkout_session(
                self,
                *,
                account_id: str,
                session_id: str,
                expand=None,
            ):
                return {
                    "id": session_id,
                    "url": "https://checkout.stripe.test/setup",
                    "status": "provider_status_not_understood",
                }

        UnknownStatusStripeService.reset()
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        UnknownStatusStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", UnknownStatusStripeService):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "autopay-key",
            ))
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(ambiguous.exception.status_code, 409)
        self.assertEqual(database.operation["state"], "provider_succeeded")
        self.assertEqual(database.close_calls, [])
        self.assertEqual(len(UnknownStatusStripeService.setup_calls), 1)

    def test_projected_replay_completes_locally_without_provider_retry(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
                "autopay-key",
            ))
            database.operation["state"] = "projected"
            with self.assertRaises(HTTPException) as replay:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(replay.exception.status_code, 409)
        self.assertIn("local completion", replay.exception.detail)
        self.assertEqual(database.operation["state"], "projected")
        self.assertEqual(len(_FakeStripeService.setup_calls), 1)

    def test_autopay_setup_requires_separately_synchronized_customer(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        tables = _autopay_tables()
        tables["billing_payers"][0]["stripe_customer_id"] = None
        database = _AutopayOperationSupabase(tables)
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as missing_customer:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(missing_customer.exception.status_code, 409)
        self.assertIn("Sync this payer", missing_customer.exception.detail)
        self.assertIsNone(database.operation)
        self.assertEqual(_FakeStripeService.setup_calls, [])

    def test_same_key_with_different_request_hash_conflicts(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _AutopayOperationSupabase(_autopay_tables())
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(
                    return_url="https://app.koaryu.test/billing",
                ),
                "studio_1",
                "user_1",
                "autopay-key",
            ))
            with self.assertRaises(HTTPException) as conflict:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(
                        return_url="https://app.koaryu.test/account",
                    ),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(conflict.exception.status_code, 409)
        self.assertIn("different billing request", conflict.exception.detail)
        self.assertEqual(len(_FakeStripeService.setup_calls), 1)

    def test_ambiguous_provider_outcome_requires_reconciliation_without_retry(self):
        class AmbiguousStripeService(_FakeStripeService):
            @classmethod
            def reset(cls):
                super().reset()

            def create_setup_checkout_session(self, **payload):
                self.__class__.setup_calls.append(payload)
                raise RuntimeError("provider timeout with unknown outcome")

        AmbiguousStripeService.reset()
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        service.supabase = database
        AmbiguousStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", AmbiguousStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))
            with self.assertRaises(HTTPException) as replay:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(ambiguous.exception.status_code, 503)
        self.assertEqual(replay.exception.status_code, 409)
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertEqual(
            database.operation["reconciliation_reason_code"],
            "provider_setup_outcome_ambiguous",
        )
        self.assertEqual(database.operation["error_code"], "provider_outcome_ambiguous")
        self.assertIsNone(database.operation["error_summary"])
        self.assertNotIn("timeout", repr(database.operation))
        self.assertEqual(len(AmbiguousStripeService.setup_calls), 1)

    def test_setup_projection_failure_marks_reconciliation_without_hosted_url(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        database = _AutopayOperationSupabase(_autopay_tables())
        database.fail_bind = True
        service.supabase = database
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as failed:
                asyncio.run(service.create_autopay_setup_link(
                    "payer_1",
                    BillingPayerAutopaySetupRequest(),
                    "studio_1",
                    "user_1",
                    "autopay-key",
                ))

        self.assertEqual(failed.exception.status_code, 503)
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertEqual(
            database.operation["reconciliation_reason_code"],
            "setup_session_projection_failed",
        )
        self.assertEqual(
            database.setup_request["stripe_checkout_session_id"],
            database.operation["provider_object_id"],
        )
        self.assertNotIn("checkout.stripe.test", repr(database.operation))
        self.assertNotIn("checkout.stripe.test", repr(database.setup_request))
        self.assertEqual(database.tables["audit_logs"], [])

    def test_checkout_projection_failure_requires_reconciliation(self):
        service, database, session = self._prepared_consent_setup()

        class FailingStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                raise RuntimeError("Stripe timeout")

        with patch("app.services.billing_service.StripeService", FailingStripeService):
            service._project_checkout_session(session, "acct_1", event_created=200)

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertIsNone(payer.get("autopay_authorized_at"))
        self.assertIsNone(payer.get("autopay_terms_accepted_at"))
        self.assertEqual(
            payer["metadata"]["autopay_projection_error"]["code"],
            "setup_payment_method_projection_ambiguous",
        )
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertIsNotNone(database.consent)
        self.assertIsNone(database.consent["completed_at"])

    def test_setup_intent_identity_mismatch_requires_reconciliation(self):
        service, database, session = self._prepared_consent_setup()

        class MismatchedStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_other",
                    "metadata": session["metadata"],
                    "payment_method": {"id": "pm_123", "type": "card"},
                }

        with patch("app.services.billing_service.StripeService", MismatchedStripeService):
            service._project_checkout_session(session, "acct_1", event_created=200)

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertIsNotNone(database.consent)
        self.assertIsNone(database.consent["completed_at"])

    def test_successful_consent_projection_and_duplicate_webhook_replay(self):
        service, database, session = self._prepared_consent_setup()
        payer = database.tables["billing_payers"][0]
        payer["metadata"] = {
            "autopay_projection_error": {"code": "old_error"},
            "support_note": "keep me",
        }
        payer["billing_status"] = "past_due"

        class SuccessfulStripeService:
            retrieve_calls = []

            def retrieve_connected_setup_intent(self, **_payload):
                self.__class__.retrieve_calls.append(_payload)
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {
                            "brand": "visa",
                            "last4": "2167",
                            "exp_month": 12,
                            "exp_year": 2030,
                        },
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            service._project_checkout_session(session, "acct_1", event_created=200)
            service._project_checkout_session(session, "acct_1", event_created=200)

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "enabled")
        self.assertEqual(payer["billing_status"], "past_due")
        self.assertEqual(payer["default_payment_method_id"], "pm_123")
        self.assertNotIn("autopay_projection_error", payer["metadata"])
        self.assertEqual(payer["metadata"]["support_note"], "keep me")
        self.assertIsNotNone(payer["autopay_terms_accepted_at"])
        self.assertEqual(database.operation["state"], "completed")
        self.assertEqual(database.operation["provider_secondary_object_id"], "seti_1")
        self.assertIsNotNone(database.consent["completed_at"])
        self.assertEqual(len(SuccessfulStripeService.retrieve_calls), 1)
        consent_audits = [
            row for row in database.tables["audit_logs"]
            if row["action"] == "billing.autopay_consent_recorded"
        ]
        self.assertEqual(len(consent_audits), 1)
        self.assertEqual(
            set(consent_audits[0]["metadata"]),
            {"operation_id", "setup_request_id", "terms_version"},
        )

    def test_completed_consent_missing_local_payment_method_marks_reconciliation(self):
        service, database, session = self._prepared_consent_setup()

        class SuccessfulStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {"brand": "visa", "last4": "2167"},
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            service._project_checkout_session(session, "acct_1", event_created=200)

        payer = database.tables["billing_payers"][0]
        payer["default_payment_method_id"] = None
        service._project_checkout_session(session, "acct_1", event_created=200)

        self.assertEqual(payer["autopay_status"], "pending")
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertEqual(
            database.operation["reconciliation_reason_code"],
            "completed_consent_payment_method_missing",
        )

        payer["default_payment_method_id"] = "pm_repaired"
        service._project_checkout_session(session, "acct_1", event_created=200)

        self.assertEqual(database.operation["state"], "completed")
        self.assertEqual(payer["autopay_status"], "enabled")
        self.assertEqual(payer["autopay_authorized_at"], database.consent["completed_at"])

    def test_projected_consent_missing_local_payment_method_marks_reconciliation(self):
        service, database, session = self._prepared_consent_setup()
        database.fail_payer_enable_once = True

        class SuccessfulStripeService:
            retrieve_calls = []

            def retrieve_connected_setup_intent(self, **payload):
                self.__class__.retrieve_calls.append(payload)
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {"brand": "visa", "last4": "2167"},
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            with self.assertRaisesRegex(
                RuntimeError,
                "completed_consent_payer_enable_failed",
            ):
                service._project_checkout_session(session, "acct_1", event_created=200)

        payer = database.tables["billing_payers"][0]
        self.assertEqual(database.operation["state"], "projected")
        self.assertIsNotNone(database.consent["completed_at"])
        payer["default_payment_method_id"] = None

        service._project_checkout_session(session, "acct_1", event_created=200)

        self.assertEqual(payer["autopay_status"], "pending")
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertEqual(
            database.operation["reconciliation_reason_code"],
            "completed_consent_payment_method_missing",
        )
        self.assertEqual(len(SuccessfulStripeService.retrieve_calls), 1)

    def test_crash_after_consent_completion_resumes_enable_and_finalizer_without_provider_work(self):
        service, database, session = self._prepared_consent_setup()
        database.fail_payer_enable_once = True

        class SuccessfulStripeService:
            retrieve_calls = []

            def retrieve_connected_setup_intent(self, **payload):
                self.__class__.retrieve_calls.append(payload)
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {"brand": "visa", "last4": "2167"},
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            with self.assertRaises(RuntimeError):
                service._project_checkout_session(session, "acct_1", event_created=200)

        payer = database.tables["billing_payers"][0]
        self.assertEqual(database.operation["state"], "projected")
        self.assertIsNotNone(database.consent["completed_at"])
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertEqual(payer["default_payment_method_id"], "pm_123")

        service._project_checkout_session(session, "acct_1", event_created=200)

        self.assertEqual(database.operation["state"], "completed")
        self.assertEqual(payer["autopay_status"], "enabled")
        self.assertEqual(payer["autopay_authorized_at"], database.consent["completed_at"])
        self.assertEqual(len(SuccessfulStripeService.retrieve_calls), 1)

    def test_revoked_durable_consent_fails_autopay_authorization_closed(self):
        service, database, session = self._prepared_consent_setup()

        class SuccessfulStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {"brand": "visa", "last4": "2167"},
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            service._project_checkout_session(session, "acct_1", event_created=200)

        payer = database.tables["billing_payers"][0]
        self.assertTrue(service._payer_autopay_authorized(payer))
        database.consent["revoked_at"] = "2026-08-26T12:10:00+00:00"
        self.assertFalse(service._payer_autopay_authorized(payer))

    def test_missing_provider_consent_never_enables_autopay(self):
        service, database, session = self._prepared_consent_setup()
        session["consent"] = {}

        service._project_checkout_session(session, "acct_1", event_created=200)

        payer = database.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertIsNone(payer.get("autopay_terms_accepted_at"))
        self.assertEqual(database.operation["state"], "reconciliation_required")
        self.assertEqual(
            database.operation["reconciliation_reason_code"],
            "provider_terms_or_setup_incomplete",
        )

    def test_expired_revoked_and_wrong_identity_setup_completion_fail_closed(self):
        for scenario in ("expired", "revoked", "cross_payer", "cross_studio", "wrong_generation"):
            with self.subTest(scenario=scenario):
                service, database, session = self._prepared_consent_setup()
                if scenario == "expired":
                    database.setup_request["setup_request_expires_at"] = "2000-01-01T00:00:00+00:00"
                elif scenario == "revoked":
                    database.setup_request["revoked_at"] = "2026-08-26T12:05:00+00:00"
                elif scenario == "cross_payer":
                    session["metadata"]["payer_id"] = "payer_2"
                elif scenario == "cross_studio":
                    session["metadata"]["studio_id"] = "studio_2"
                else:
                    database.tables["studio_payment_accounts"][0]["metadata"] = {
                        "connect_account_generation": 2,
                    }

                try:
                    service._project_checkout_session(session, "acct_1", event_created=200)
                except (AssertionError, HTTPException):
                    pass

                payer = database.tables["billing_payers"][0]
                self.assertEqual(payer["autopay_status"], "pending")
                self.assertIsNone(payer.get("autopay_terms_accepted_at"))
                self.assertNotEqual(database.operation["state"], "completed")

    def test_disable_autopay_rewires_active_subscription_to_invoice_collection(self):
        service = self.service()
        service.supabase = _AutopayOperationSupabase({
            "billing_payers": [{
                "id": "payer_1", "studio_id": "studio_1",
                "display_name": "Family One", "autopay_status": "enabled",
                "default_payment_method_id": "pm_123",
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1", "studio_id": "studio_1",
                "payer_id": "payer_1", "collection_mode": "autopay",
                "status": "active", "stripe_subscription_id": "sub_1",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "billing_subscription_id": "subscription_1",
                "collection_mode": "autopay", "status": "active",
            }],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as blocked:
                asyncio.run(service.disable_autopay(
                    "payer_1", "studio_1", "user_1"
                ))

        self.assertEqual(blocked.exception.status_code, 409)
        self.assertIn("named cancellation workflow", blocked.exception.detail)
        self.assertEqual(
            service.supabase.tables["billing_payers"][0]["autopay_status"],
            "enabled",
        )
        self.assertEqual(
            service.supabase.tables["billing_subscriptions"][0]["collection_mode"],
            "autopay",
        )
        self.assertEqual(
            service.supabase.tables["student_billing_enrollments"][0]["collection_mode"],
            "autopay",
        )
        self.assertEqual(_FakeStripeService.subscription_update_calls, [])
        self.assertEqual(service.supabase.tables["audit_logs"], [])
    def test_disable_autopay_marks_subscription_pending_before_stripe_mutation(self):
        service = self.service()
        service.supabase = _AutopayOperationSupabase({
            "billing_payers": [{
                "id": "payer_1", "studio_id": "studio_1",
                "display_name": "Family One", "autopay_status": "enabled",
                "default_payment_method_id": "pm_123",
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.disable_autopay(
                "payer_1", "studio_1", "user_1"
            ))

        self.assertEqual(response.autopay_status, "disabled")
        self.assertEqual(_FakeStripeService.subscription_update_calls, [])
        self.assertEqual(
            service.supabase.tables["audit_logs"][0]["metadata"][
                "rewired_subscription_ids"
            ],
            [],
        )

    def test_disable_autopay_rejects_usable_pending_setup_without_state_change(self):
        service, database, _session = self._prepared_consent_setup()
        payer = database.tables["billing_payers"][0]

        with self.assertRaises(HTTPException) as blocked:
            asyncio.run(service.disable_autopay("payer_1", "studio_1", "user_1"))

        self.assertEqual(blocked.exception.status_code, 409)
        self.assertIn("setup session or consent is pending", blocked.exception.detail)
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertIsNone(database.setup_request.get("revoked_at"))
        self.assertIsNone(database.consent)
        self.assertEqual(len(database.disable_calls), 1)

    def test_disable_after_completion_revokes_consent_before_webhook_replay(self):
        service, database, session = self._prepared_consent_setup()

        class SuccessfulStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                return {
                    "id": "seti_1",
                    "status": "succeeded",
                    "customer": "cus_1",
                    "metadata": session["metadata"],
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {"brand": "visa", "last4": "2167"},
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            service._project_checkout_session(session, "acct_1", event_created=200)

        database.tables["billing_payers"][0].setdefault(
            "created_at", "2026-08-26T12:00:00+00:00"
        )
        database.tables["billing_payers"][0].setdefault(
            "updated_at", "2026-08-26T12:00:00+00:00"
        )
        response = asyncio.run(service.disable_autopay("payer_1", "studio_1", "user_1"))
        self.assertEqual(response.autopay_status, "disabled")
        self.assertIsNotNone(database.consent["revoked_at"])
        self.assertEqual(database.consent["revoked_by"], "user_1")
        self.assertEqual(
            database.consent["revocation_reason_code"],
            "staff_disabled_autopay",
        )
        self.assertEqual(
            database.setup_request["revoked_at"],
            database.consent["revoked_at"],
        )

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            try:
                service._project_checkout_session(session, "acct_1", event_created=201)
            except (AssertionError, HTTPException):
                pass
        self.assertEqual(
            database.tables["billing_payers"][0]["autopay_status"],
            "disabled",
        )
    def test_autopay_invoice_requires_authorized_payer_terms(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "stripe_account_id": "acct_1",
                "connect_account_generation": 1,
                "default_payment_method_id": "pm_123",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_invoices": [],
            "billing_invoice_items": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_invoice(
                    BillingInvoiceCreate(
                        payer_id="payer_1",
                        collection_mode="autopay",
                        amount_cents=200,
                        description="Autopay consent rehearsal",
                    ),
                    "studio_1",
                    "user_1",
                    idempotency_key="autopay-consent-required",
                ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("verified payer-owned consent", context.exception.detail)

    def test_autopay_enrollment_requires_authorized_payer_terms(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 2},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "connect_account_generation": 2,
                "default_payment_method_id": "pm_123",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_plans": [{
                "id": "plan_1",
                "studio_id": "studio_1",
                "name": "Live Autopay Rehearsal",
                "status": "active",
                "amount_cents": 200,
                "currency": "usd",
                "billing_interval": "monthly",
                "trial_days": 0,
                "stripe_account_id": "acct_1",
                "stripe_product_id": "prod_1",
                "stripe_price_id": "price_1",
            }],
            "billing_plan_prices": [{
                "id": "plan_price_1",
                "studio_id": "studio_1",
                "billing_plan_id": "plan_1",
                "stripe_account_id": "acct_1",
                "stripe_product_id": "prod_1",
                "stripe_price_id": "price_1",
                "amount_cents": 200,
                "currency": "usd",
                "billing_interval": "monthly",
                "recurring": True,
                "active": True,
                "metadata": {"connect_account_generation": 2},
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "collection_mode": "autopay",
                "status": "pending",
                "billing_status": "no_payment_method",
                "metadata": {},
            }],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.activate_enrollment(
                    "enrollment_1",
                    "studio_1",
                    "user_1",
                    "autopay-consent-required",
                ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("verified payer consent", context.exception.detail)

    def _named_activation_service(self, *, existing_group: bool, locked: bool = False):
        service = self.service()
        group_metadata = {"connect_account_generation": 2}
        if locked:
            group_metadata["stripe_quantity_sync_lock"] = {
                "token": "other-worker",
                "locked_at": "2026-08-26T00:00:00Z",
            }
        groups = [{
            "id": "subscription_1", "studio_id": "studio_1",
            "payer_id": "payer_1", "stripe_account_id": "acct_1",
            "stripe_customer_id": "cus_1", "stripe_subscription_id": "sub_1",
            "collection_mode": "invoice_link", "billing_interval": "monthly",
            "currency": "usd", "status": "active", "metadata": group_metadata,
        }] if existing_group else []
        peers = [{
            "id": "enrollment_existing", "studio_id": "studio_1",
            "student_id": "student_2", "payer_id": "payer_1",
            "billing_plan_id": "plan_1",
            "billing_subscription_id": "subscription_1",
            "stripe_subscription_id": "sub_1",
            "stripe_subscription_item_id": "si_existing",
            "collection_mode": "invoice_link", "status": "active",
            "billing_status": "current", "start_date": "2026-05-18",
            "metadata": {}, "created_at": "2026-05-18T00:00:00Z",
            "updated_at": "2026-05-18T00:00:00Z",
        }] if existing_group else []
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled", "charges_enabled": True,
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 2},
            }],
            "billing_payers": [{
                "id": "payer_1", "studio_id": "studio_1",
                "stripe_account_id": "acct_1", "stripe_customer_id": "cus_1",
                "connect_account_generation": 2,
            }],
            "billing_plans": [{
                "id": "plan_1", "studio_id": "studio_1", "name": "Monthly Tuition",
                "status": "active", "amount_cents": 200, "currency": "usd",
                "billing_interval": "monthly", "trial_days": 0,
                "stripe_account_id": "acct_1", "stripe_product_id": "prod_1",
                "stripe_price_id": "price_1",
            }],
            "billing_plan_prices": [{
                "id": "local_price_1", "studio_id": "studio_1",
                "billing_plan_id": "plan_1", "stripe_account_id": "acct_1",
                "stripe_product_id": "prod_1", "stripe_price_id": "price_1",
                "amount_cents": 200, "currency": "usd",
                "billing_interval": "monthly", "recurring": True, "active": True,
                "metadata": {"connect_account_generation": 2},
            }],
            "billing_subscriptions": groups,
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "student_id": "student_1", "payer_id": "payer_1",
                "billing_plan_id": "plan_1", "collection_mode": "invoice_link",
                "status": "pending", "billing_status": "no_payment_method",
                "start_date": "2026-05-18", "metadata": {},
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }, *peers],
            "audit_logs": [],
        })
        service.supabase.insert_defaults["billing_subscriptions"] = {
            "id": "subscription_created", "metadata": {},
            "created_at": "2026-05-18T00:00:00Z",
            "updated_at": "2026-05-18T00:00:00Z",
        }
        return service

    def test_activation_marks_enrollment_attach_pending_before_subscription_item_mutation(self):
        service = self._named_activation_service(existing_group=True)
        test_case = self
        _FakeStripeService.subscription_response = {
            "id": "sub_1", "status": "active", "customer": "cus_1",
            "metadata": {
                "studio_id": "studio_1", "payer_id": "payer_1",
                "billing_subscription_id": "subscription_1",
            },
            "items": {"data": [{
                "id": "si_existing", "price": {"id": "price_1"}, "quantity": 1,
                "metadata": {
                    "studio_id": "studio_1", "payer_id": "payer_1",
                    "billing_plan_id": "plan_1",
                    "billing_subscription_id": "subscription_1",
                },
            }]},
        }

        class ObservingStripeService(_FakeStripeService):
            def update_connected_subscription_item(self, **payload):
                enrollment = service.supabase.tables["student_billing_enrollments"][0]
                intent = enrollment["metadata"]["provider_activation_intent"]
                test_case.assertEqual(intent["branch"], "update_quantity")
                test_case.assertEqual(intent["expected_quantity"], 2)
                test_case.assertIn(
                    "stripe_quantity_sync_lock",
                    service.supabase.tables["billing_subscriptions"][0]["metadata"],
                )
                self.__class__.subscription_response["items"]["data"][0]["quantity"] = 2
                return super().update_connected_subscription_item(**payload)

        with patch("app.services.billing_service.StripeService", ObservingStripeService):
            response = asyncio.run(service.activate_enrollment(
                "enrollment_1", "studio_1", "user_1", "quantity-key"
            ))

        self.assertEqual(response.status, "active")
        self.assertEqual(response.stripe_subscription_item_id, "si_existing")
        self.assertEqual(
            _FakeStripeService.subscription_item_update_calls[-1]["quantity"], 2
        )
        self.assertNotIn(
            "stripe_quantity_sync_lock",
            service.supabase.tables["billing_subscriptions"][0]["metadata"],
        )

    def test_activation_holds_quantity_lock_while_creating_first_subscription(self):
        service = self._named_activation_service(existing_group=False)
        test_case = self

        class ObservingStripeService(_FakeStripeService):
            def create_connected_subscription(self, **payload):
                group = service.supabase.tables["billing_subscriptions"][0]
                test_case.assertIn("stripe_quantity_sync_lock", group["metadata"])
                response = {
                    "id": "sub_created", "status": "active",
                    "customer": payload["customer_id"],
                    "metadata": payload["metadata"],
                    "items": {"data": [{
                        "id": "si_created", "price": {"id": payload["price_id"]},
                        "quantity": 1, "metadata": payload["item_metadata"],
                    }]},
                }
                self.__class__.subscription_response = response
                self.__class__.subscription_create_calls.append(payload)
                return response

        with patch("app.services.billing_service.StripeService", ObservingStripeService):
            response = asyncio.run(service.activate_enrollment(
                "enrollment_1", "studio_1", "user_1", "create-key"
            ))

        self.assertEqual(response.status, "active")
        self.assertEqual(response.stripe_subscription_id, "sub_created")
        self.assertEqual(response.stripe_subscription_item_id, "si_created")
        self.assertNotIn(
            "stripe_quantity_sync_lock",
            service.supabase.tables["billing_subscriptions"][0]["metadata"],
        )

    def test_subscription_item_quantity_update_rejects_concurrent_sync_lock(self):
        service = self._named_activation_service(existing_group=True, locked=True)

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as blocked:
                asyncio.run(service.activate_enrollment(
                    "enrollment_1", "studio_1", "user_1", "locked-key"
                ))

        self.assertEqual(blocked.exception.status_code, 409)
        self.assertEqual(_FakeStripeService.subscription_item_update_calls, [])
        self.assertEqual(service.supabase.billing_provider_operations, {})

    def test_cancel_last_subscription_enrollment_cancels_subscription_without_deleting_last_item(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "collection_mode": "autopay", "status": "active",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as unavailable:
                asyncio.run(service.set_enrollment_status(
                    "enrollment_1", "canceled", "studio_1", "user_1"
                ))

        self.assertEqual(unavailable.exception.status_code, 409)
        self.assertIn("named supported workflows", unavailable.exception.detail)
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [])
        self.assertEqual(_FakeStripeService.subscription_item_delete_calls, [])
        self.assertEqual(_FakeStripeService.subscription_item_update_calls, [])
    def test_cancel_uses_subscription_stripe_account_when_studio_account_rotated(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "collection_mode": "autopay", "status": "active",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as unavailable:
                asyncio.run(service.set_enrollment_status(
                    "enrollment_1", "canceled", "studio_1", "user_1"
                ))

        self.assertEqual(unavailable.exception.status_code, 409)
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [])
    def test_cancel_marks_enrollment_detach_pending_before_stripe_mutation(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "collection_mode": "autopay", "status": "active",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "metadata": {},
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException):
                asyncio.run(service.set_enrollment_status(
                    "enrollment_1", "canceled", "studio_1", "user_1"
                ))

        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(enrollment["metadata"], {})
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [])
    def test_update_enrollment_to_external_records_local_detach_before_canceling_stripe(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "collection_mode": "autopay", "status": "active",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "metadata": {},
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as unavailable:
                asyncio.run(service.update_enrollment(
                    "enrollment_1",
                    StudentBillingEnrollmentUpdate(collection_mode="external"),
                    "studio_1",
                    "user_1",
                ))

        self.assertEqual(unavailable.exception.status_code, 409)
        self.assertIn("Generic update is unavailable", unavailable.exception.detail)
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [])
    def test_cancel_one_of_multiple_subscription_enrollments_deletes_only_that_item(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "student_billing_enrollments": [{
                "id": "enrollment_1", "studio_id": "studio_1",
                "collection_mode": "autopay", "status": "active",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as unavailable:
                asyncio.run(service.set_enrollment_status(
                    "enrollment_1", "canceled", "studio_1", "user_1"
                ))

        self.assertEqual(unavailable.exception.status_code, 409)
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [])
        self.assertEqual(_FakeStripeService.subscription_item_delete_calls, [])
        self.assertEqual(_FakeStripeService.subscription_item_update_calls, [])
