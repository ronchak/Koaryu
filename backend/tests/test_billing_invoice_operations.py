from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import json
from datetime import date, datetime, time, timezone

import pytest
import httpx
from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from stripe import CardError as StripeCardError

from app.schemas.billing import BillingInvoiceCreate, BillingInvoiceItemCreate
from app.services.billing_invoice_operations import (
    BillingInvoiceOperationWorkflow,
    INVOICE_CREATE_AMBIGUOUS_DETAIL,
    INVOICE_FINALIZE_PREREAD_UNAVAILABLE_DETAIL,
    INVOICE_RETRY_AMBIGUOUS_DETAIL,
    INVOICE_RETRY_PREREAD_UNAVAILABLE_DETAIL,
    INVOICE_RETRY_PREREAD_RELEASE_FAILED_DETAIL,
    INVOICE_VOID_PREREAD_UNAVAILABLE_DETAIL,
)
from app.services.billing_invoices import BillingInvoiceManager
from app.services.billing_provider_operations import (
    AUTOPAY_TERMS_VERSION,
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
    OPERATION_TERMINAL_DETAIL,
)
from app.services.platform_billing_helpers import build_idempotency_key, stable_hash
from tests.fakes.billing_provider_operations import BillingProviderOperationRpcMixin
from tests.fakes.supabase import RpcBackedSupabase


def _unique_conflict(_table: str, _columns: tuple[str, ...]) -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })


class _InvoiceSupabase(BillingProviderOperationRpcMixin, RpcBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.initialize_billing_provider_operations()
        self.lose_step_success_response_once: int | None = None
        self.insert_defaults["billing_invoices"] = lambda _table: {
            "id": f"invoice_created_{len(self.tables['billing_invoices']) + 1}",
            "created_at": "2026-08-27T00:00:00Z",
            "updated_at": "2026-08-27T00:00:00Z",
        }
        self.insert_defaults["billing_invoice_items"] = lambda _table: {
            "created_at": f"2026-08-27T00:00:{len(self.tables['billing_invoice_items']):02d}Z",
        }
        self.unique_constraints["billing_invoices"] = [("studio_id", "idempotency_key")]
        self.unique_constraints["billing_invoice_items"] = [
            ("studio_id", "stripe_invoice_item_id")
        ]
        self.unique_constraints["audit_logs"] = [("id",)]
        self.unique_conflict_error_factory = _unique_conflict

    def _rpc_transition_billing_provider_operation_step_v1(self, params):
        result = super()._rpc_transition_billing_provider_operation_step_v1(params)
        if (
            self.lose_step_success_response_once == params["p_step_order"]
            and params["p_to_state"] == "provider_succeeded"
        ):
            self.lose_step_success_response_once = None
            raise RuntimeError("lost provider-success response")
        return result


class _Accounts:
    def __init__(self, account: dict):
        self.account = account

    def ensure_row(self, studio_id: str) -> dict:
        return {"studio_id": studio_id, **self.account}

    def by_stripe_account(self, account_id: str) -> dict | None:
        if account_id != self.account.get("stripe_connected_account_id"):
            return None
        return {"studio_id": "studio_1", **self.account}


class _Facade:
    def __init__(self, *, payer: dict | None = None, invoice: dict | None = None):
        self.account = {
            "stripe_connected_account_id": "acct_1",
            "charges_enabled": True,
            "status": "charges_enabled",
            "platform_fee_bps": 50,
            "metadata": {"connect_account_generation": 2},
        }
        self.supabase = _InvoiceSupabase({
            "billing_payers": [payer or _payer()],
            "billing_payer_payment_consents": [],
            "billing_invoices": [invoice] if invoice else [],
            "billing_invoice_items": [],
            "audit_logs": [],
        })
        self.projection_failures = 0
        self.balance_recomputes = 0
        self.customer_sync_calls = 0

    def _connect_accounts(self):
        return _Accounts(self.account)

    def _get_row_or_404(self, table, record_id, studio_id, detail):
        row = next(
            (
                candidate
                for candidate in self.supabase.tables.setdefault(table, [])
                if candidate.get("id") == record_id
                and candidate.get("studio_id") == studio_id
            ),
            None,
        )
        if row is None:
            raise HTTPException(status_code=404, detail=detail)
        return row

    def _ensure_record_in_studio(self, table, record_id, studio_id, detail):
        self._get_row_or_404(table, record_id, studio_id, detail)

    def _sync_payer_customer(self, *_args, **_kwargs):
        self.customer_sync_calls += 1
        raise AssertionError("invoice workflows must not synchronize a payer")

    @staticmethod
    def _payer_autopay_authorized(payer):
        return bool(payer.get("verified_consent"))

    @staticmethod
    def _application_fee_amount(amount_cents, account):
        return int(round(amount_cents * int(account.get("platform_fee_bps") or 0) / 10000))

    @staticmethod
    def _idempotency_key(*parts):
        return build_idempotency_key(*parts)

    def _audit(self, studio_id, actor_id, action, entity_id, metadata):
        self.supabase.tables["audit_logs"].append({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_id": entity_id,
            "metadata": metadata,
        })

    @staticmethod
    def _invoice_request_hash(data):
        payload = data.model_dump(mode="json", exclude_none=True)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _update_invoice_from_stripe(self, invoice_id, studio_id, provider, account_id):
        if self.projection_failures:
            self.projection_failures -= 1
            raise RuntimeError("local projection failed")
        invoice = self._get_row_or_404(
            "billing_invoices", invoice_id, studio_id, "Invoice not found."
        )
        invoice.update({
            "stripe_invoice_id": provider["id"],
            "stripe_account_id": account_id,
            "stripe_customer_id": provider.get("customer"),
            "status": provider["status"],
            "amount_due_cents": int(provider.get("amount_due") or 0),
            "amount_paid_cents": int(provider.get("amount_paid") or 0),
            "amount_remaining_cents": int(provider.get("amount_remaining") or 0),
            "currency": provider.get("currency") or invoice.get("currency"),
            "updated_at": "2026-08-27T00:01:00Z",
        })
        return dict(invoice)

    @staticmethod
    def _validate_invoice_item_refs(_item, _studio_id):
        return None

    @staticmethod
    def _date_to_epoch(value):
        parsed = date.fromisoformat(value)
        return int(datetime.combine(parsed, time.min, tzinfo=timezone.utc).timestamp())

    def _recompute_payer_balance(self, _studio_id, _payer_id):
        self.balance_recomputes += 1

    @staticmethod
    def _definitive_invoice_retry_error(exc):
        if isinstance(exc, _CardDecline):
            return 402, "The payment method was declined.", "invoice_payment_declined"
        return None


class _Stripe:
    invoices: dict[str, dict] = {}
    setup_intents: dict[str, dict] = {}
    invoice_create_calls: list[dict] = []
    item_create_calls: list[dict] = []
    retrieve_calls: list[dict] = []
    setup_intent_retrieve_calls: list[dict] = []
    setup_intent_retrieve_exception: Exception | None = None
    setup_intent_retrieve_hook = None
    finalize_before_mutation_hook = None
    pay_before_mutation_hook = None
    finalize_calls: list[dict] = []
    send_calls: list[dict] = []
    pay_calls: list[dict] = []
    void_calls: list[dict] = []
    pay_exception: Exception | None = None
    pay_exception_after_commit = False
    item_exception_on_call: int | None = None
    finalize_exception: Exception | None = None
    send_exception: Exception | None = None
    void_exception: Exception | None = None
    retrieve_exception: Exception | None = None
    readback_overrides: dict = {}

    @classmethod
    def reset(cls):
        cls.invoices = {}
        cls.setup_intents = {}
        cls.invoice_create_calls = []
        cls.item_create_calls = []
        cls.retrieve_calls = []
        cls.setup_intent_retrieve_calls = []
        cls.setup_intent_retrieve_exception = None
        cls.setup_intent_retrieve_hook = None
        cls.finalize_before_mutation_hook = None
        cls.pay_before_mutation_hook = None
        cls.finalize_calls = []
        cls.send_calls = []
        cls.pay_calls = []
        cls.void_calls = []
        cls.pay_exception = None
        cls.pay_exception_after_commit = False
        cls.item_exception_on_call = None
        cls.finalize_exception = None
        cls.send_exception = None
        cls.void_exception = None
        cls.retrieve_exception = None
        cls.readback_overrides = {}

    def create_connected_invoice(self, **payload):
        self.__class__.invoice_create_calls.append(copy.deepcopy(payload))
        provider_id = f"in_{len(self.__class__.invoice_create_calls)}"
        invoice = {
            "id": provider_id,
            "status": "draft",
            "amount_due": 0,
            "amount_paid": 0,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": payload["customer_id"],
            "metadata": copy.deepcopy(payload["metadata"]),
        }
        self.__class__.invoices[provider_id] = invoice
        return copy.deepcopy(invoice)

    def create_connected_invoice_item(self, **payload):
        self.__class__.item_create_calls.append(copy.deepcopy(payload))
        if self.__class__.item_exception_on_call == len(self.__class__.item_create_calls):
            raise TimeoutError("raw invoice item timeout")
        provider_id = f"ii_{len(self.__class__.item_create_calls)}"
        invoice = self.__class__.invoices[payload["invoice_id"]]
        invoice["amount_due"] += payload["amount"]
        invoice["amount_remaining"] += payload["amount"]
        return {"id": provider_id}

    def retrieve_connected_invoice(self, **payload):
        self.__class__.retrieve_calls.append(copy.deepcopy(payload))
        if self.__class__.retrieve_exception:
            raise self.__class__.retrieve_exception
        invoice = copy.deepcopy(self.__class__.invoices[payload["invoice_id"]])
        invoice.update(copy.deepcopy(self.__class__.readback_overrides))
        return invoice

    def retrieve_connected_setup_intent(self, **payload):
        self.__class__.setup_intent_retrieve_calls.append(copy.deepcopy(payload))
        if self.__class__.setup_intent_retrieve_exception:
            raise self.__class__.setup_intent_retrieve_exception
        setup_intent = copy.deepcopy(
            self.__class__.setup_intents[payload["setup_intent_id"]]
        )
        if self.__class__.setup_intent_retrieve_hook is not None:
            self.__class__.setup_intent_retrieve_hook()
        return setup_intent

    def finalize_connected_invoice(self, **payload):
        if self.__class__.finalize_before_mutation_hook is not None:
            self.__class__.finalize_before_mutation_hook()
        self.__class__.finalize_calls.append(copy.deepcopy(payload))
        if self.__class__.finalize_exception:
            raise self.__class__.finalize_exception
        invoice = self.__class__.invoices[payload["invoice_id"]]
        invoice["status"] = "open"
        return copy.deepcopy(invoice)

    def send_connected_invoice(self, **payload):
        self.__class__.send_calls.append(copy.deepcopy(payload))
        if self.__class__.send_exception:
            raise self.__class__.send_exception
        return copy.deepcopy(self.__class__.invoices[payload["invoice_id"]])

    def pay_connected_invoice(self, **payload):
        if self.__class__.pay_before_mutation_hook is not None:
            self.__class__.pay_before_mutation_hook()
        self.__class__.pay_calls.append(copy.deepcopy(payload))
        invoice = self.__class__.invoices[payload["invoice_id"]]
        if self.__class__.pay_exception and not self.__class__.pay_exception_after_commit:
            raise self.__class__.pay_exception
        invoice.update({
            "status": "paid",
            "amount_paid": invoice["amount_due"],
            "amount_remaining": 0,
        })
        if self.__class__.pay_exception:
            raise self.__class__.pay_exception
        return copy.deepcopy(invoice)

    def void_connected_invoice(self, **payload):
        self.__class__.void_calls.append(copy.deepcopy(payload))
        if self.__class__.void_exception:
            raise self.__class__.void_exception
        invoice = self.__class__.invoices[payload["invoice_id"]]
        invoice["status"] = "void"
        return copy.deepcopy(invoice)


def _payer(**overrides):
    return {
        "id": "payer_1",
        "studio_id": "studio_1",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "connect_account_generation": 2,
        "default_payment_method_id": None,
        "verified_consent": False,
        **overrides,
    }


def _autopay_payer(**overrides):
    return _payer(**{
        "default_payment_method_id": "pm_1",
        "autopay_status": "enabled",
        "autopay_authorized_at": "2026-08-27T00:00:00Z",
        "autopay_terms_accepted_at": "2026-08-26T23:59:00Z",
        **overrides,
    })


def _active_consent(**overrides):
    return {
        "id": "consent_1",
        "setup_request_id": "setup_request_1",
        "studio_id": "studio_1",
        "payer_id": "payer_1",
        "terms_version": AUTOPAY_TERMS_VERSION,
        "stripe_connected_account_id": "acct_1",
        "connect_account_generation": 2,
        "stripe_setup_intent_id": "seti_1",
        "accepted_at": "2026-08-26T23:59:00Z",
        "completed_at": "2026-08-27T00:00:00Z",
        "revoked_at": None,
        "superseded_at": None,
        **overrides,
    }


def _open_invoice(**overrides):
    return {
        "id": "invoice_existing",
        "studio_id": "studio_1",
        "payer_id": "payer_1",
        "invoice_type": "manual",
        "status": "open",
        "amount_due_cents": 5000,
        "amount_paid_cents": 0,
        "amount_remaining_cents": 5000,
        "currency": "usd",
        "stripe_invoice_id": "in_existing",
        "stripe_account_id": "acct_1",
        "stripe_customer_id": "cus_1",
        "collection_method": "send_invoice",
        "application_fee_amount_cents": 25,
        "external": False,
        "metadata": {"connect_account_generation": 2},
        "created_at": "2026-08-27T00:00:00Z",
        "updated_at": "2026-08-27T00:00:00Z",
        **overrides,
    }


def _seed_retry_provider(invoice: dict) -> None:
    _Stripe.invoices[str(invoice["stripe_invoice_id"])] = {
        "id": invoice["stripe_invoice_id"],
        "status": invoice["status"],
        "amount_due": invoice["amount_due_cents"],
        "amount_paid": invoice["amount_paid_cents"],
        "amount_remaining": invoice["amount_remaining_cents"],
        "currency": invoice["currency"],
        "customer": invoice["stripe_customer_id"],
        "collection_method": invoice.get("collection_method") or "send_invoice",
        "default_payment_method": invoice.get("default_payment_method_id"),
        "metadata": {
            "studio_id": invoice["studio_id"],
            "payer_id": invoice["payer_id"],
            "invoice_id": invoice["id"],
        },
    }


def _seed_autopay_consent(facade: _Facade, invoice: dict) -> None:
    facade.supabase.tables["billing_payer_payment_consents"] = [_active_consent()]
    _Stripe.setup_intents["seti_1"] = {
        "id": "seti_1",
        "status": "succeeded",
        "customer": invoice["stripe_customer_id"],
        "payment_method": "pm_1",
        "metadata": {
            "product": "koaryu_payments_autopay",
            "studio_id": invoice["studio_id"],
            "payer_id": invoice["payer_id"],
            "setup_request_id": "setup_request_1",
            "terms_version": AUTOPAY_TERMS_VERSION,
            "stripe_account_id": invoice["stripe_account_id"],
            "connect_account_generation": "2",
        },
    }


def _draft_invoice(**overrides):
    return _open_invoice(status="draft", **overrides)


def _create_data(amount: int = 5000):
    return BillingInvoiceCreate(
        payer_id="payer_1",
        due_date="2099-09-15",
        items=[
            {"description": "Tuition", "amount_cents": amount, "quantity": 1},
            {"description": "Uniform", "amount_cents": 1200, "quantity": 2},
        ],
    )


def _manager(facade: _Facade, *, utc_today=None) -> BillingInvoiceManager:
    return BillingInvoiceManager(
        facade,
        stripe_service_cls=_Stripe,
        utc_today=utc_today,
    )


@pytest.fixture(autouse=True)
def _reset_stripe():
    _Stripe.reset()


def _operation(facade: _Facade, operation_type: str) -> dict:
    return next(
        row
        for row in facade.supabase.billing_provider_operations.values()
        if row["operation_type"] == operation_type
    )


@pytest.mark.parametrize("metadata", ({}, {"connect_account_generation": ""}))
@pytest.mark.parametrize(
    ("workflow", "invoice_status"),
    (
        ("finalize", "draft"),
        ("retry", "open"),
        ("void", "open"),
    ),
)
def test_invoice_mutations_reject_ambiguous_legacy_generation_before_provider(
    metadata: dict,
    workflow: str,
    invoice_status: str,
):
    facade = _Facade(invoice=_open_invoice(status=invoice_status, metadata=metadata))
    manager = _manager(facade)

    with pytest.raises(HTTPException) as blocked:
        if workflow == "finalize":
            asyncio.run(manager.finalize_invoice(
                "invoice_existing", "studio_1", "actor_1", "legacy-finalize"
            ))
        elif workflow == "retry":
            asyncio.run(manager.retry_invoice_payment(
                "invoice_existing", "studio_1", "actor_1", "legacy-retry"
            ))
        else:
            asyncio.run(manager.void_invoice(
                "invoice_existing", "studio_1", "actor_1", "legacy-void"
            ))

    assert blocked.value.status_code == 409
    assert _Stripe.retrieve_calls == []
    assert facade.supabase.billing_provider_operations == {}


def test_create_requires_byte_bounded_key_and_exact_payer_generation():
    for key in (None, "é" * 128):
        facade = _Facade()
        with pytest.raises(HTTPException) as exc:
            _manager(facade).create_invoice_sync(
                _create_data(), "studio_1", "actor_1", key
            )
        assert exc.value.status_code == 400
        assert facade.supabase.billing_provider_operations == {}

    facade = _Facade(payer=_payer(connect_account_generation=1))
    with pytest.raises(HTTPException) as exc:
        _manager(facade).create_invoice_sync(
            _create_data(), "studio_1", "actor_1", "invoice-key"
        )
    assert exc.value.status_code == 409
    assert facade.supabase.billing_provider_operations == {}
    assert facade.customer_sync_calls == 0
    assert _Stripe.invoice_create_calls == []


def test_create_rejects_malformed_due_date_before_local_or_provider_claim():
    facade = _Facade()
    manager = _manager(facade)
    malformed = _create_data().model_copy(update={"due_date": "2026-99-99"})

    with pytest.raises(HTTPException) as invalid:
        manager.create_invoice_sync(
            malformed, "studio_1", "actor_1", "invoice-invalid-date"
        )

    assert invalid.value.status_code == 400
    assert "YYYY-MM-DD" in invalid.value.detail
    assert facade.supabase.tables["billing_invoices"] == []
    assert facade.supabase.tables["billing_invoice_items"] == []
    assert facade.supabase.billing_provider_operations == {}
    assert _Stripe.invoice_create_calls == []
    assert _Stripe.item_create_calls == []

    created = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "invoice-valid-date"
    )

    assert created.status == "draft"
    assert len(facade.supabase.billing_provider_operations) == 1
    assert len(_Stripe.invoice_create_calls) == 1
    expected_due_date = int(datetime.combine(
        date(2099, 9, 15),
        time.min,
        tzinfo=timezone.utc,
    ).timestamp())
    assert _Stripe.invoice_create_calls[0]["collection_method"] == "send_invoice"
    assert _Stripe.invoice_create_calls[0]["due_date"] == expected_due_date


def test_create_due_date_freshness_does_not_block_exact_replay_after_midnight():
    facade = _Facade()
    observed_today = {"value": date(2099, 9, 14)}
    manager = _manager(
        facade,
        utc_today=lambda: observed_today["value"],
    )
    data = _create_data()

    first = manager.create_invoice_sync(
        data, "studio_1", "actor_1", "invoice-clock-crossing"
    )
    request_hash = facade.supabase.tables["billing_invoices"][0]["request_hash"]
    observed_today["value"] = date(2099, 9, 16)
    provider_counts = (
        len(_Stripe.invoice_create_calls),
        len(_Stripe.item_create_calls),
    )

    replay = manager.create_invoice_sync(
        data, "studio_1", "actor_1", "invoice-clock-crossing"
    )

    assert replay.id == first.id
    assert provider_counts == (
        len(_Stripe.invoice_create_calls),
        len(_Stripe.item_create_calls),
    )
    assert len(facade.supabase.tables["billing_invoices"]) == 1
    assert facade.supabase.tables["billing_invoices"][0]["request_hash"] == request_hash

    with pytest.raises(HTTPException) as stale:
        manager.create_invoice_sync(
            data, "studio_1", "actor_1", "invoice-now-past"
        )

    assert stale.value.status_code == 400
    assert stale.value.detail == "Invoice due date must be a future date."
    assert len(facade.supabase.tables["billing_invoices"]) == 1
    assert len(facade.supabase.billing_provider_operations) == 1
    assert provider_counts == (
        len(_Stripe.invoice_create_calls),
        len(_Stripe.item_create_calls),
    )


def test_create_registers_real_v28_evidence_and_replays_without_duplicates():
    facade = _Facade()
    manager = _manager(facade)

    first = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "invoice-key"
    )
    facade.supabase.tables["billing_invoice_items"].reverse()
    replay = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "invoice-key"
    )

    assert first.id == replay.id == "invoice_created_1"
    assert first.amount_due_cents == first.amount_remaining_cents == 7400
    assert first.status == "draft"
    assert len(_Stripe.invoice_create_calls) == 1
    assert len(_Stripe.item_create_calls) == 2
    assert facade.customer_sync_calls == 0
    assert len(facade.supabase.tables["billing_invoice_items"]) == 2
    assert len(facade.supabase.tables["audit_logs"]) == 1
    parent = _operation(facade, "invoice.create")
    assert parent["state"] == "completed"
    assert parent["provider_request_attempt_count"] == 1
    assert parent["provider_object_id"] == "ii_2"
    assert parent["result_code"] == "invoice_create_completed"
    assert parent["result_summary"] == "invoice_create_mode:invoice_items"
    assert "Tuition" not in repr(parent)
    assert "https://" not in repr(parent)
    plan = facade.supabase.billing_provider_step_plans[parent["id"]]
    assert [step["provider_operation"] for step in plan["steps"]] == [
        "connected_invoice.create",
        "connected_invoice_item.create",
        "connected_invoice_item.create",
    ]


def test_create_changed_payload_conflicts_without_more_provider_calls():
    facade = _Facade()
    manager = _manager(facade)
    manager.create_invoice_sync(_create_data(), "studio_1", "actor_1", "invoice-key")

    with pytest.raises(HTTPException) as exc:
        manager.create_invoice_sync(
            _create_data(amount=5100), "studio_1", "actor_1", "invoice-key"
        )

    assert exc.value.status_code == 409
    assert len(_Stripe.invoice_create_calls) == 1
    assert len(_Stripe.item_create_calls) == 2


def test_create_old_key_replays_after_later_key_without_duplicate_audit():
    facade = _Facade()
    manager = _manager(facade)

    first = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "invoice-old"
    )
    later = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "invoice-later"
    )
    old_replay = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "invoice-old"
    )

    assert first.id == old_replay.id
    assert later.id != first.id
    assert len(_Stripe.invoice_create_calls) == 2
    assert len(_Stripe.item_create_calls) == 4
    assert len(facade.supabase.tables["audit_logs"]) == 2


@pytest.mark.parametrize("lost_step", [1, 2])
def test_create_lost_step_response_resumes_without_duplicate_provider_call(lost_step):
    facade = _Facade()
    facade.supabase.lose_step_success_response_once = lost_step
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        manager.create_invoice_sync(_create_data(), "studio_1", "actor_1", "lost-key")
    assert exc.value.status_code == 503
    facade.supabase.advance_billing_provider_clock(seconds=31)

    result = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "lost-key"
    )
    assert result.status == "draft"
    assert len(_Stripe.invoice_create_calls) == 1
    assert len(_Stripe.item_create_calls) == 2
    assert len(facade.supabase.tables["audit_logs"]) == 1


def test_create_provider_success_local_failure_marks_reconciliation_and_never_retries():
    facade = _Facade()
    facade.projection_failures = 1
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        manager.create_invoice_sync(_create_data(), "studio_1", "actor_1", "projection-key")
    assert exc.value.status_code == 503
    assert exc.value.detail == INVOICE_CREATE_AMBIGUOUS_DETAIL
    parent = _operation(facade, "invoice.create")
    assert parent["state"] == "reconciliation_required"
    provider_counts = (len(_Stripe.invoice_create_calls), len(_Stripe.item_create_calls))

    with pytest.raises(HTTPException) as replay_exc:
        manager.create_invoice_sync(_create_data(), "studio_1", "actor_1", "projection-key")
    assert replay_exc.value.status_code == 409
    assert provider_counts == (
        len(_Stripe.invoice_create_calls), len(_Stripe.item_create_calls)
    )


def test_create_readback_identity_mismatch_marks_reconciliation():
    facade = _Facade()
    _Stripe.readback_overrides = {"customer": "cus_other"}

    with pytest.raises(HTTPException) as exc:
        _manager(facade).create_invoice_sync(
            _create_data(), "studio_1", "actor_1", "identity-key"
        )

    assert exc.value.status_code == 503
    assert _operation(facade, "invoice.create")["state"] == "reconciliation_required"
    assert len(_Stripe.invoice_create_calls) == 1
    assert len(_Stripe.item_create_calls) == 2


def test_create_partial_item_failure_marks_step_and_parent_reconciliation():
    facade = _Facade()
    _Stripe.item_exception_on_call = 2
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        manager.create_invoice_sync(
            _create_data(), "studio_1", "actor_1", "partial-key"
        )
    assert exc.value.status_code == 503
    parent = _operation(facade, "invoice.create")
    assert parent["state"] == "reconciliation_required"
    steps = facade.supabase.billing_provider_step_plans[parent["id"]]["steps"]
    assert [step["state"] for step in steps] == [
        "provider_succeeded",
        "provider_succeeded",
        "reconciliation_required",
    ]
    provider_counts = (len(_Stripe.invoice_create_calls), len(_Stripe.item_create_calls))

    with pytest.raises(HTTPException) as replay_exc:
        manager.create_invoice_sync(
            _create_data(), "studio_1", "actor_1", "partial-key"
        )
    assert replay_exc.value.status_code == 409
    assert provider_counts == (
        len(_Stripe.invoice_create_calls), len(_Stripe.item_create_calls)
    )


def test_create_autopay_requires_verified_consent_and_passes_exact_method():
    data = BillingInvoiceCreate(
        payer_id="payer_1",
        amount_cents=5000,
        description="Tuition",
        collection_mode="autopay",
    )
    facade = _Facade(payer=_payer(default_payment_method_id="pm_1"))
    with pytest.raises(HTTPException) as exc:
        _manager(facade).create_invoice_sync(
            data, "studio_1", "actor_1", "autopay-key"
        )
    assert exc.value.status_code == 409
    assert _Stripe.invoice_create_calls == []

    facade = _Facade(payer=_payer(
        default_payment_method_id="pm_1",
        verified_consent=True,
    ))
    result = _manager(facade).create_invoice_sync(
        data, "studio_1", "actor_1", "autopay-key"
    )
    assert result.status == "draft"
    assert _Stripe.invoice_create_calls[0]["default_payment_method"] == "pm_1"
    assert _Stripe.invoice_create_calls[0]["collection_method"] == "charge_automatically"


def test_create_completed_local_identity_drift_is_sanitized_without_provider_retry():
    facade = _Facade()
    manager = _manager(facade)
    result = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "drift-key"
    )
    local = facade._get_row_or_404(
        "billing_invoices", result.id, "studio_1", "Invoice not found."
    )
    local["stripe_invoice_id"] = "in_corrupt"

    with pytest.raises(HTTPException) as exc:
        manager.create_invoice_sync(_create_data(), "studio_1", "actor_1", "drift-key")

    assert exc.value.status_code == 503
    assert exc.value.detail == INVOICE_CREATE_AMBIGUOUS_DETAIL
    assert len(_Stripe.invoice_create_calls) == 1
    assert len(_Stripe.item_create_calls) == 2


def test_create_projected_local_identity_drift_marks_reconciliation():
    facade = _Facade()
    manager = _manager(facade)
    result = manager.create_invoice_sync(
        _create_data(), "studio_1", "actor_1", "projected-drift-key"
    )
    parent = _operation(facade, "invoice.create")
    parent["state"] = "projected"
    local = facade._get_row_or_404(
        "billing_invoices", result.id, "studio_1", "Invoice not found."
    )
    local["stripe_invoice_id"] = "in_corrupt"
    facade.supabase.advance_billing_provider_clock(seconds=31)

    with pytest.raises(HTTPException) as exc:
        manager.create_invoice_sync(
            _create_data(), "studio_1", "actor_1", "projected-drift-key"
        )

    assert exc.value.status_code == 503
    assert parent["state"] == "reconciliation_required"
    assert len(_Stripe.invoice_create_calls) == 1
    assert len(_Stripe.item_create_calls) == 2


def test_finalize_send_registers_two_steps_and_replays_without_duplicates():
    invoice = _draft_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)

    first = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-key"
    ))
    replay = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-key"
    ))

    assert first.status == replay.status == "open"
    assert len(_Stripe.finalize_calls) == 1
    assert len(_Stripe.send_calls) == 1
    assert _Stripe.setup_intent_retrieve_calls == []
    assert len(facade.supabase.tables["audit_logs"]) == 1
    parent = _operation(facade, "invoice.finalize")
    assert parent["state"] == "completed"
    assert parent["result_summary"] == "invoice_finalize_mode:finalize_send"
    plan = facade.supabase.billing_provider_step_plans[parent["id"]]
    assert [step["provider_operation"] for step in plan["steps"]] == [
        "connected_invoice.finalize",
        "connected_invoice.send",
    ]


def test_finalize_send_does_not_hold_the_autopay_consent_guard():
    invoice = _draft_invoice()
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    committed_changes = []

    def change_autopay_during_hosted_finalize():
        facade.supabase.mutate_billing_payer(
            "payer_1",
            autopay_status="disabled",
        )
        facade.supabase.mutate_billing_payer_payment_consent(
            "consent_1",
            revoked_at="2026-08-27T00:05:00Z",
        )
        committed_changes.append(True)

    _Stripe.finalize_before_mutation_hook = change_autopay_during_hosted_finalize
    finalized = asyncio.run(_manager(facade).finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-send-no-consent-guard"
    ))

    assert finalized.status == "open"
    assert committed_changes == [True]
    assert _Stripe.setup_intent_retrieve_calls == []
    assert len(_Stripe.finalize_calls) == 1
    assert len(_Stripe.send_calls) == 1


def test_finalize_completed_replay_does_not_require_fresh_provider_read():
    invoice = _draft_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    first = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-offline-replay"
    ))
    reads_before = len(_Stripe.retrieve_calls)
    _Stripe.retrieve_exception = TimeoutError("provider read unavailable")

    replay = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-offline-replay"
    ))

    assert first.status == replay.status == "open"
    assert len(_Stripe.retrieve_calls) == reads_before
    assert len(_Stripe.finalize_calls) == 1
    assert len(_Stripe.send_calls) == 1


def test_finalize_new_claim_fails_definitively_when_provider_preread_fails():
    invoice = _draft_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.retrieve_exception = TimeoutError("provider read unavailable")

    with pytest.raises(HTTPException) as ambiguous:
        asyncio.run(_manager(facade).finalize_invoice(
            invoice["id"],
            "studio_1",
            "actor_1",
            "finalize-preread-timeout",
        ))

    operation = _operation(facade, "invoice.finalize")
    assert ambiguous.value.status_code == 503
    assert ambiguous.value.detail == INVOICE_FINALIZE_PREREAD_UNAVAILABLE_DETAIL
    assert operation["state"] == "definitive_failed"
    assert operation["error_code"] == "invoice_finalize_preread_unavailable"
    assert _Stripe.finalize_calls == []
    assert _Stripe.send_calls == []

    reads_before = len(_Stripe.retrieve_calls)
    with pytest.raises(HTTPException) as replay:
        asyncio.run(_manager(facade).finalize_invoice(
            invoice["id"],
            "studio_1",
            "actor_1",
            "finalize-preread-timeout",
        ))
    assert replay.value.status_code == 409
    assert replay.value.detail == OPERATION_TERMINAL_DETAIL
    assert len(_Stripe.retrieve_calls) == reads_before

    _Stripe.retrieve_exception = None
    recovered = asyncio.run(_manager(facade).finalize_invoice(
        invoice["id"],
        "studio_1",
        "actor_1",
        "finalize-preread-recovery",
    ))
    assert recovered.status == "open"


def test_finalize_new_claim_terminally_rejects_deterministic_preread_drift():
    invoice = _draft_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.readback_overrides = {"customer": "cus_other"}

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(_manager(facade).finalize_invoice(
            invoice["id"],
            "studio_1",
            "actor_1",
            "finalize-preread-drift",
        ))

    operation = _operation(facade, "invoice.finalize")
    assert rejected.value.status_code == 409
    assert operation["state"] == "definitive_rejected"
    assert operation["error_code"] == "invoice_finalize_preread_invalid"
    assert _Stripe.finalize_calls == []
    assert _Stripe.send_calls == []


def test_finalize_partial_send_failure_never_repeats_finalize_or_send():
    invoice = _draft_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.send_exception = TimeoutError("raw send timeout")
    manager = _manager(facade)

    with pytest.raises(HTTPException) as first:
        asyncio.run(manager.finalize_invoice(
            invoice["id"], "studio_1", "actor_1", "finalize-partial"
        ))
    assert first.value.status_code == 503
    assert _operation(facade, "invoice.finalize")["state"] == "reconciliation_required"

    _Stripe.send_exception = None
    with pytest.raises(HTTPException) as replay:
        asyncio.run(manager.finalize_invoice(
            invoice["id"], "studio_1", "actor_1", "finalize-partial"
        ))
    assert replay.value.status_code == 409
    assert len(_Stripe.finalize_calls) == 1
    assert len(_Stripe.send_calls) == 1


def test_finalize_autopay_uses_one_parent_mutation_without_step_plan():
    invoice = _draft_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.invoices["in_existing"]["metadata"]["benign_invoice_note"] = "ok"
    _Stripe.setup_intents["seti_1"]["metadata"]["benign_setup_note"] = "ok"

    result = asyncio.run(_manager(facade).finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-autopay"
    ))

    assert result.status == "open"
    assert len(_Stripe.finalize_calls) == 1
    assert _Stripe.send_calls == []
    parent = _operation(facade, "invoice.finalize")
    assert parent["state"] == "completed"
    assert parent["id"] not in facade.supabase.billing_provider_step_plans


@pytest.mark.parametrize(
    ("target", "field"),
    [
        ("invoice", "payer_id"),
        ("setup", "setup_request_id"),
    ],
)
def test_finalize_autopay_rejects_material_metadata_drift_with_benign_extras(
    target,
    field,
):
    invoice = _draft_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.invoices["in_existing"]["metadata"]["benign_invoice_note"] = "ok"
    _Stripe.setup_intents["seti_1"]["metadata"]["benign_setup_note"] = "ok"
    metadata = (
        _Stripe.invoices["in_existing"]["metadata"]
        if target == "invoice"
        else _Stripe.setup_intents["seti_1"]["metadata"]
    )
    metadata[field] = "mismatch"

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).finalize_invoice(
            invoice["id"], "studio_1", "actor_1", f"finalize-metadata-{target}"
        ))

    assert exc.value.status_code == 409
    assert _Stripe.finalize_calls == []


def test_finalize_autopay_projection_failure_recovers_by_readback_only():
    invoice = _draft_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    facade.projection_failures = 1
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)

    with pytest.raises(HTTPException) as first:
        asyncio.run(manager.finalize_invoice(
            invoice["id"], "studio_1", "actor_1", "finalize-projection"
        ))
    assert first.value.status_code == 503
    assert _operation(facade, "invoice.finalize")["state"] == "reconciliation_required"

    recovered = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-projection"
    ))
    assert recovered.status == "open"
    assert len(_Stripe.finalize_calls) == 1
    assert _Stripe.send_calls == []
    assert _operation(facade, "invoice.finalize")["state"] == "completed"


@pytest.mark.parametrize(
    ("consent_overrides", "provider_method", "setup_method"),
    [
        ({"revoked_at": "2026-08-27T00:05:00Z"}, "pm_1", "pm_1"),
        ({"superseded_at": "2026-08-27T00:05:00Z"}, "pm_1", "pm_1"),
        ({}, "pm_other", "pm_1"),
        ({}, "pm_1", "pm_other"),
        ({"connect_account_generation": 3}, "pm_1", "pm_1"),
    ],
)
def test_finalize_autopay_rejects_nonexact_consent_before_provider_mutation(
    consent_overrides,
    provider_method,
    setup_method,
):
    invoice = _draft_invoice(
        collection_method="charge_automatically",
        default_payment_method_id=provider_method,
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    facade.supabase.tables["billing_payer_payment_consents"][0].update(
        consent_overrides
    )
    _Stripe.setup_intents["seti_1"]["payment_method"] = setup_method

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(_manager(facade).finalize_invoice(
            invoice["id"], "studio_1", "actor_1", "finalize-invalid-consent"
        ))

    assert rejected.value.status_code == 409
    assert _Stripe.finalize_calls == []
    operation = _operation(facade, "invoice.finalize")
    assert operation["state"] == "definitive_rejected"
    assert operation["error_code"] == "invoice_finalize_autopay_consent_invalid"


@pytest.mark.parametrize("closed_field", ["revoked_at", "superseded_at"])
def test_finalize_autopay_rechecks_consent_after_setup_intent_read(
    closed_field,
):
    invoice = _draft_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)

    def close_consent_after_provider_read():
        facade.supabase.tables["billing_payer_payment_consents"][0][closed_field] = (
            "2026-08-27T00:05:00Z"
        )

    _Stripe.setup_intent_retrieve_hook = close_consent_after_provider_read

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(_manager(facade).finalize_invoice(
            invoice["id"], "studio_1", "actor_1", f"finalize-race-{closed_field}"
        ))

    assert rejected.value.status_code == 409
    assert _Stripe.finalize_calls == []
    assert _operation(facade, "invoice.finalize")["state"] == "definitive_rejected"


def test_finalize_autopay_owner_blocks_disable_inside_provider_mutation_boundary():
    invoice = _draft_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    blocked_changes = []

    def attempt_disable_after_final_validation():
        for mutate in (
            lambda: facade.supabase.mutate_billing_payer(
                "payer_1",
                autopay_status="disabled",
            ),
            lambda: facade.supabase.mutate_billing_payer_payment_consent(
                "consent_1",
                revoked_at="2026-08-27T00:05:00Z",
            ),
        ):
            try:
                mutate()
            except PostgrestAPIError as exc:
                blocked_changes.append((exc.code, exc.message))

    _Stripe.finalize_before_mutation_hook = attempt_disable_after_final_validation
    manager = _manager(facade)
    finalized = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-consent-owner"
    ))

    assert finalized.status == "open"
    assert blocked_changes == [
        ("55P03", "billing_invoice_mutation_in_progress"),
        ("55P03", "billing_invoice_mutation_in_progress"),
    ]
    assert facade.supabase.tables["billing_payers"][0]["autopay_status"] == "enabled"
    assert facade.supabase.tables["billing_payer_payment_consents"][0][
        "revoked_at"
    ] is None
    assert len(_Stripe.finalize_calls) == 1

    facade.supabase.mutate_billing_payer("payer_1", autopay_status="disabled")
    facade.supabase.mutate_billing_payer_payment_consent(
        "consent_1",
        revoked_at="2026-08-27T00:05:00Z",
    )
    replay = asyncio.run(manager.finalize_invoice(
        invoice["id"], "studio_1", "actor_1", "finalize-consent-owner"
    ))

    assert replay.status == "open"
    assert len(_Stripe.finalize_calls) == 1
    assert len(_Stripe.setup_intent_retrieve_calls) == 1


def test_void_resource_replays_without_duplicate_provider_mutation():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)

    first = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-key"
    ))
    reads_after_first = len(_Stripe.retrieve_calls)
    _Stripe.retrieve_exception = TimeoutError("provider unavailable after void")
    replay = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-key"
    ))

    assert first.status == replay.status == "void"
    assert reads_after_first == 1
    assert len(_Stripe.retrieve_calls) == reads_after_first
    assert len(_Stripe.void_calls) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1
    parent = _operation(facade, "invoice.void")
    assert parent["state"] == "completed"
    assert parent["result_summary"] == "invoice_void_mode:void"


def test_void_projected_replay_completes_from_exact_local_evidence_offline():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    first = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-projected-replay"
    ))
    operation = _operation(facade, "invoice.void")
    operation["state"] = "projected"
    reads_before = len(_Stripe.retrieve_calls)
    _Stripe.retrieve_exception = TimeoutError("provider unavailable after projection")

    replay = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-projected-replay"
    ))

    assert first.status == replay.status == "void"
    assert len(_Stripe.retrieve_calls) == reads_before
    assert len(_Stripe.void_calls) == 1
    assert operation["state"] == "completed"


def test_void_completed_replay_fails_closed_on_corrupt_local_projection():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-local-corrupt"
    ))
    facade.supabase.tables["billing_invoices"][0]["status"] = "open"
    reads_before = len(_Stripe.retrieve_calls)
    _Stripe.retrieve_exception = TimeoutError("provider unavailable after projection")

    with pytest.raises(HTTPException) as failed_closed:
        asyncio.run(manager.void_invoice(
            invoice["id"], "studio_1", "actor_1", "void-local-corrupt"
        ))

    assert failed_closed.value.status_code == 503
    assert len(_Stripe.retrieve_calls) == reads_before
    assert len(_Stripe.void_calls) == 1


def test_void_fresh_claim_rejects_provider_identity_mismatch_before_mutation():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.readback_overrides = {"customer": "cus_other"}

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(_manager(facade).void_invoice(
            invoice["id"], "studio_1", "actor_1", "void-provider-mismatch"
        ))

    assert rejected.value.status_code == 409
    assert len(_Stripe.retrieve_calls) == 1
    assert _Stripe.void_calls == []
    operation = _operation(facade, "invoice.void")
    assert operation["state"] == "definitive_rejected"
    assert operation["error_code"] == "invoice_void_preread_invalid"


def test_void_preread_failure_is_terminal_and_new_key_can_retry():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    _Stripe.retrieve_exception = TimeoutError("provider preread unavailable")

    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(manager.void_invoice(
            invoice["id"], "studio_1", "actor_1", "void-preread-failed"
        ))

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail == INVOICE_VOID_PREREAD_UNAVAILABLE_DETAIL
    operation = _operation(facade, "invoice.void")
    assert operation["state"] == "definitive_failed"
    assert operation["error_code"] == "invoice_void_preread_unavailable"
    assert _Stripe.void_calls == []

    reads_before_replay = len(_Stripe.retrieve_calls)
    _Stripe.retrieve_exception = None
    with pytest.raises(HTTPException) as terminal:
        asyncio.run(manager.void_invoice(
            invoice["id"], "studio_1", "actor_1", "void-preread-failed"
        ))
    assert terminal.value.status_code == 409
    assert terminal.value.detail == OPERATION_TERMINAL_DETAIL
    assert len(_Stripe.retrieve_calls) == reads_before_replay

    recovered = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-preread-retry"
    ))

    assert recovered.status == "void"
    assert len(_Stripe.retrieve_calls) == reads_before_replay + 1
    assert len(_Stripe.void_calls) == 1


def test_local_void_records_timestamp_without_provider_mutation():
    invoice = _open_invoice(
        stripe_invoice_id=None,
        stripe_account_id=None,
        stripe_customer_id=None,
    )
    facade = _Facade(invoice=invoice)
    manager = _manager(facade)

    result = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-local-key",
    ))

    assert result.status == "void"
    assert result.voided_at is not None
    assert _Stripe.void_calls == []


def test_invoice_request_rejects_more_items_than_durable_step_limit():
    item = BillingInvoiceItemCreate(description="Tuition", amount_cents=100)

    with pytest.raises(ValueError):
        BillingInvoiceCreate(payer_id="payer_1", items=[item] * 32)


def test_void_provider_success_projection_failure_recovers_by_readback_only():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    facade.projection_failures = 1
    _seed_retry_provider(invoice)
    manager = _manager(facade)

    with pytest.raises(HTTPException) as first:
        asyncio.run(manager.void_invoice(
            invoice["id"], "studio_1", "actor_1", "void-projection"
        ))
    assert first.value.status_code == 503
    assert _operation(facade, "invoice.void")["state"] == "reconciliation_required"

    recovered = asyncio.run(manager.void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-projection"
    ))
    assert recovered.status == "void"
    assert len(_Stripe.void_calls) == 1
    assert _operation(facade, "invoice.void")["state"] == "completed"


def test_retry_success_and_old_key_replay_pay_and_audit_once():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)

    first = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-key"
    ))
    replay = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-key"
    ))

    assert first.status == replay.status == "paid"
    assert first.amount_remaining_cents == 0
    assert len(_Stripe.pay_calls) == 1
    assert "payment_method" not in _Stripe.pay_calls[0]
    assert _Stripe.setup_intent_retrieve_calls == []
    assert len(facade.supabase.tables["audit_logs"]) == 1
    parent = _operation(facade, "invoice.retry")
    assert parent["state"] == "completed"
    assert parent["provider_object_id"] == "in_existing"
    assert parent["result_summary"] == "invoice_retry_mode:pay"
    assert parent["request_sha256"] == stable_hash({
        "operation_type": "invoice.retry",
        "studio_id": "studio_1",
        "invoice_id": invoice["id"],
        "stripe_invoice_id": invoice["stripe_invoice_id"],
        "stripe_connected_account_id": invoice["stripe_account_id"],
        "connect_account_generation": 2,
    })


@pytest.mark.parametrize(
    "mutation",
    [
        lambda result: result.pop("requested_base_sha256"),
        lambda result: result.update(effective_persisted_sha256="A" * 64),
        lambda result: result.update(effective_persisted_sha256="f" * 64),
        lambda result: result.update(compatibility_outcome="capture_legacy_hash_created"),
        lambda result: result["operation"].update(request_sha256="e" * 64),
        lambda result: result["operation"].update(state="completed"),
    ],
)
def test_retry_rejects_uncertified_v33_claim_before_evidence_reads(mutation):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    original_claim = facade.supabase._rpc_claim_billing_provider_operation_resource_v1

    def mutate_claim(params):
        result = original_claim(params)
        mutation(result)
        return result

    facade.supabase._rpc_claim_billing_provider_operation_resource_v1 = mutate_claim

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-uncertified-v33"
        ))

    assert rejected.value.status_code == 503
    assert _Stripe.retrieve_calls == []
    assert _Stripe.setup_intent_retrieve_calls == []
    assert _Stripe.pay_calls == []


@pytest.mark.parametrize(
    ("target", "field", "value"),
    [
        ("operation", "id", "not-a-uuid"),
        ("operation", "studio_id", "studio_other"),
        ("operation", "actor_id", "actor_other"),
        ("operation", "operation_type", "invoice.void"),
        ("operation", "caller_request_key", "key_other"),
        ("operation", "request_sha256", "a" * 64),
        ("operation", "stripe_connected_account_id", "acct_other"),
        ("operation", "connect_account_generation", 3),
        ("resource", "id", "not-a-uuid"),
        ("resource", "studio_id", "studio_other"),
        ("resource", "operation_type", "invoice.void"),
        ("resource", "resource_type", "invoice_void"),
        ("resource", "resource_id", "invoice_other"),
        ("resource", "payer_id", "payer_other"),
        ("resource", "operation_id", "00000000-0000-4000-8000-000000009999"),
        ("envelope", "requested_caller_request_key", "key_other"),
        ("envelope", "canonical_caller_request_key", "key_other"),
    ],
)
def test_retry_rejects_v33_claim_identity_drift_without_side_effects(
    target,
    field,
    value,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    original_claim = facade.supabase._rpc_claim_billing_provider_operation_resource_v1

    def mutate_claim(params):
        result = original_claim(params)
        if target == "envelope":
            result[field] = value
        else:
            result[target][field] = value
        return result

    facade.supabase._rpc_claim_billing_provider_operation_resource_v1 = mutate_claim

    with pytest.raises(HTTPException) as rejected:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-v33-identity-drift"
        ))

    assert rejected.value.status_code == 503
    assert _Stripe.retrieve_calls == []
    assert _Stripe.setup_intent_retrieve_calls == []
    assert _Stripe.pay_calls == []
    assert facade.supabase.release_billing_invoice_retry_preread_lease_calls == []
    assert facade.supabase.tables["audit_logs"] == []
    assert not any(
        name.startswith("transition_billing_provider_operation")
        for name, _params in facade.supabase.rpc_calls
    )


@pytest.mark.parametrize(
    ("payer_overrides", "consent_overrides"),
    [
        ({"autopay_status": "disabled"}, {}),
        ({}, {"revoked_at": "2026-08-27T00:05:00Z"}),
    ],
)
def test_retry_autopay_requires_enabled_unrevoked_consent_before_provider_mutation(
    payer_overrides,
    consent_overrides,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(**payer_overrides), invoice=invoice)
    facade.supabase.tables["billing_payer_payment_consents"] = [
        _active_consent(**consent_overrides)
    ]
    _seed_retry_provider(invoice)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-revoked-consent"
        ))

    assert exc.value.status_code == 409
    assert _Stripe.pay_calls == []
    assert _Stripe.setup_intent_retrieve_calls == []
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert operation["error_code"] == "invoice_retry_autopay_consent_invalid"


@pytest.mark.parametrize(
    ("payer_overrides", "consent_overrides", "setup_method"),
    [
        ({}, {}, "pm_other"),
        ({}, {"connect_account_generation": 3}, "pm_1"),
    ],
)
def test_retry_autopay_rejects_payment_method_or_generation_drift_before_pay(
    payer_overrides,
    consent_overrides,
    setup_method,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(
        payer=_autopay_payer(**payer_overrides),
        invoice=invoice,
    )
    facade.supabase.tables["billing_payer_payment_consents"] = [
        _active_consent(**consent_overrides)
    ]
    _seed_retry_provider(invoice)
    _Stripe.setup_intents["seti_1"] = {
        "id": "seti_1",
        "status": "succeeded",
        "customer": "cus_1",
        "payment_method": setup_method,
        "metadata": {
            "product": "koaryu_payments_autopay",
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "setup_request_id": "setup_request_1",
            "terms_version": AUTOPAY_TERMS_VERSION,
            "stripe_account_id": "acct_1",
            "connect_account_generation": "2",
        },
    }

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-identity-drift"
        ))

    assert exc.value.status_code == 409
    assert _Stripe.pay_calls == []


def test_retry_autopay_pays_failed_invoice_with_replacement_consent_method():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.invoices["in_existing"]["metadata"]["benign_invoice_note"] = "ok"
    _Stripe.setup_intents["seti_1"]["metadata"]["benign_setup_note"] = "ok"

    paid = asyncio.run(_manager(facade).retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-replacement-consent"
    ))

    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    assert _Stripe.pay_calls[0]["payment_method"] == "pm_1"
    assert _Stripe.invoices["in_existing"]["default_payment_method"] == "pm_failed"


@pytest.mark.parametrize(
    ("provider_customer", "setup_status", "consent_overrides", "setup_account"),
    [
        ("cus_other", "succeeded", {}, "acct_1"),
        ("cus_1", "requires_payment_method", {}, "acct_1"),
        ("cus_1", "succeeded", {"superseded_at": "2026-08-27T00:05:00Z"}, "acct_1"),
        ("cus_1", "succeeded", {}, "acct_other"),
    ],
)
def test_retry_autopay_rejects_provider_and_consent_identity_mismatch_after_claim(
    provider_customer,
    setup_status,
    consent_overrides,
    setup_account,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.invoices["in_existing"]["customer"] = provider_customer
    _Stripe.setup_intents["seti_1"]["status"] = setup_status
    _Stripe.setup_intents["seti_1"]["metadata"]["stripe_account_id"] = setup_account
    facade.supabase.tables["billing_payer_payment_consents"][0].update(
        consent_overrides
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-invalid-identity"
        ))

    assert exc.value.status_code == 409
    assert _Stripe.pay_calls == []
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert operation["error_code"] == "invoice_retry_autopay_consent_invalid"


def test_retry_autopay_consent_replacement_after_claim_prevents_provider_pay():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    original_claim = facade.supabase._rpc_claim_billing_provider_operation_resource_v1

    def claim_then_replace_consent(params):
        result = original_claim(params)
        consent = facade.supabase.tables["billing_payer_payment_consents"][0]
        consent["superseded_at"] = "2026-08-27T00:05:00Z"
        return result

    facade.supabase._rpc_claim_billing_provider_operation_resource_v1 = (
        claim_then_replace_consent
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-replaced-after-claim"
        ))

    assert exc.value.status_code == 409
    assert _Stripe.retrieve_calls == []
    assert _Stripe.setup_intent_retrieve_calls == []
    assert _Stripe.pay_calls == []
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert operation["provider_request_attempt_count"] == 0


def test_retry_autopay_initial_provider_snapshot_unavailable_resumes_same_key():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)
    _Stripe.setup_intent_retrieve_exception = TimeoutError(
        "sensitive setup transport failure"
    )

    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-initial-read-unavailable"
        ))

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail == INVOICE_RETRY_PREREAD_UNAVAILABLE_DETAIL
    assert "sensitive" not in unavailable.value.detail
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["reconciliation_reason_code"] is None
    assert operation["lease_owner"] is None
    assert operation["lease_acquired_at"] is None
    assert operation["lease_expires_at"] is None
    assert operation["revision"] == 2
    release_calls = (
        facade.supabase.release_billing_invoice_retry_preread_lease_calls
    )
    assert len(release_calls) == 1
    release_call = release_calls[0]
    assert release_call == {
        "p_operation_id": operation["id"],
        "p_studio_id": "studio_1",
        "p_actor_id": "actor_1",
        "p_caller_request_key": "retry-initial-read-unavailable",
        "p_request_sha256": operation["request_sha256"],
        "p_stripe_connected_account_id": "acct_1",
        "p_connect_account_generation": 2,
        "p_lease_owner": release_call["p_lease_owner"],
        "p_expected_revision": 1,
        "p_release_reason": "provider_preread_unavailable",
    }
    assert release_call["p_lease_owner"]
    assert operation["invoice_retry_preread_released_at"]
    assert operation["invoice_retry_preread_release_reason"] == (
        "provider_preread_unavailable"
    )
    assert _Stripe.pay_calls == []

    _Stripe.setup_intent_retrieve_exception = None
    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-initial-read-unavailable"
    ))

    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "completed"
    assert operation["provider_request_attempt_count"] == 1
    assert operation["reconciliation_reason_code"] is None
    assert operation["lease_owner"] != release_call["p_lease_owner"]
    assert operation["invoice_retry_preread_released_at"] is None


@pytest.mark.parametrize("fail_on_read", [1, 2, 3])
@pytest.mark.parametrize(
    "error_kind", ["not_found", "permission", "semantic", "type", "key", "assertion"]
)
def test_retry_active_consent_nonavailability_errors_never_release(
    fail_on_read,
    error_kind,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    original_read = facade.supabase._rpc_read_active_billing_payer_payment_consent_v1
    reads = 0
    programming_errors = {
        "type": TypeError("consent type bug"),
        "key": KeyError("consent_key"),
        "assertion": AssertionError("consent invariant"),
    }

    def fail_consent_read(params):
        nonlocal reads
        reads += 1
        if reads != fail_on_read:
            return original_read(params)
        if error_kind == "not_found":
            raise PostgrestAPIError({
                "code": "P0002",
                "message": "billing_payer_active_consent_not_found",
                "details": "",
                "hint": "",
            })
        if error_kind == "permission":
            raise PostgrestAPIError({
                "code": "42501",
                "message": "consent permission denied",
                "details": "",
                "hint": "",
            })
        if error_kind == "semantic":
            raise PostgrestAPIError({
                "code": "23514",
                "message": "consent semantic constraint",
                "details": "",
                "hint": "",
            })
        raise programming_errors[error_kind]

    facade.supabase._rpc_read_active_billing_payer_payment_consent_v1 = (
        fail_consent_read
    )

    if error_kind == "not_found":
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(_manager(facade).retry_invoice_payment(
                invoice["id"], "studio_1", "actor_1",
                f"retry-consent-error-{fail_on_read}-{error_kind}",
            ))
        assert rejected.value.status_code == 409
        operation = _operation(facade, "invoice.retry")
        assert operation["state"] == "definitive_rejected"
    else:
        expected_type = (
            PostgrestAPIError
            if error_kind in {"permission", "semantic"}
            else type(programming_errors[error_kind])
        )
        with pytest.raises(expected_type):
            asyncio.run(_manager(facade).retry_invoice_payment(
                invoice["id"], "studio_1", "actor_1",
                f"retry-consent-error-{fail_on_read}-{error_kind}",
            ))
        operation = _operation(facade, "invoice.retry")
        assert operation["state"] == "started"
        assert operation["provider_request_attempt_count"] == 0

    assert facade.supabase.release_billing_invoice_retry_preread_lease_calls == []
    assert operation["invoice_retry_preread_released_at"] is None
    assert _Stripe.pay_calls == []
    assert facade.supabase.tables["audit_logs"] == []
    assert operation["invoice_retry_preread_release_reason"] is None


def test_retry_autopay_final_provider_reread_unavailable_resumes_same_key():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)

    def fail_invoice_reads_after_initial_snapshot():
        _Stripe.setup_intent_retrieve_hook = None
        _Stripe.retrieve_exception = TimeoutError(
            "sensitive invoice transport failure"
        )

    _Stripe.setup_intent_retrieve_hook = fail_invoice_reads_after_initial_snapshot

    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-final-read-unavailable"
        ))

    assert unavailable.value.status_code == 503
    assert unavailable.value.detail == INVOICE_RETRY_PREREAD_UNAVAILABLE_DETAIL
    assert "sensitive" not in unavailable.value.detail
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["reconciliation_reason_code"] is None
    assert operation["lease_owner"] is None
    assert operation["lease_acquired_at"] is None
    assert operation["lease_expires_at"] is None
    assert operation["revision"] == 2
    release_calls = (
        facade.supabase.release_billing_invoice_retry_preread_lease_calls
    )
    assert len(release_calls) == 1
    release_call = release_calls[0]
    assert release_call["p_operation_id"] == operation["id"]
    assert release_call["p_expected_revision"] == 1
    assert release_call["p_lease_owner"]
    assert release_call["p_release_reason"] == "provider_preread_unavailable"
    assert operation["invoice_retry_preread_released_at"]
    assert _Stripe.pay_calls == []

    _Stripe.retrieve_exception = None
    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-final-read-unavailable"
    ))

    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "completed"
    assert operation["provider_request_attempt_count"] == 1
    assert operation["reconciliation_reason_code"] is None
    assert operation["lease_owner"] != release_call["p_lease_owner"]
    assert operation["invoice_retry_preread_released_at"] is None


@pytest.mark.parametrize("fail_on_read", [1, 2, 3])
@pytest.mark.parametrize(
    "failure_mode", ["pgrst", "timeout", "connection", "httpx", "http_503"]
)
def test_retry_autopay_transient_local_consent_read_releases_and_recovers(
    fail_on_read,
    failure_mode,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)
    original_read = facade.supabase._rpc_read_active_billing_payer_payment_consent_v1
    reads = 0

    def transient_read(params):
        nonlocal reads
        reads += 1
        if reads == fail_on_read:
            if failure_mode == "pgrst":
                raise PostgrestAPIError({
                    "code": "PGRST003",
                    "message": "sensitive database pool timeout",
                    "details": "",
                    "hint": "",
                })
            if failure_mode == "timeout":
                raise TimeoutError("sensitive consent timeout")
            if failure_mode == "connection":
                raise ConnectionError("sensitive consent connection failure")
            if failure_mode == "httpx":
                raise httpx.ReadError(
                    "sensitive consent network failure",
                    request=httpx.Request("GET", "https://example.invalid"),
                )
            raise HTTPException(status_code=503, detail="sensitive consent read")
        return original_read(params)

    facade.supabase._rpc_read_active_billing_payer_payment_consent_v1 = transient_read
    request_key = f"retry-local-read-{fail_on_read}-{failure_mode}"

    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", request_key
        ))

    assert unavailable.value.status_code == 503
    assert "sensitive" not in unavailable.value.detail
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["invoice_retry_preread_release_reason"] == (
        "local_consent_preread_unavailable"
    )
    assert operation["invoice_retry_preread_released_at"]
    assert _Stripe.pay_calls == []

    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", request_key
    ))

    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "completed"
    assert operation["invoice_retry_preread_released_at"] is None


@pytest.mark.parametrize(
    "failure_mode",
    ["postgrest", "timeout", "connection", "httpx_timeout", "httpx_connect", "http_503"],
)
def test_retry_autopay_payer_read_unavailable_releases_and_recovers_same_key(
    failure_mode,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)
    original_get = facade._get_row_or_404
    failed_once = False

    def fail_payer_read_once(table, record_id, studio_id, detail):
        nonlocal failed_once
        if table == "billing_payers" and not failed_once:
            failed_once = True
            if failure_mode == "postgrest":
                raise PostgrestAPIError({
                    "code": "PGRST000",
                    "message": "sensitive payer transport failure",
                    "details": "",
                    "hint": "",
                })
            if failure_mode == "http_503":
                raise HTTPException(status_code=503, detail="sensitive payer read")
            if failure_mode == "connection":
                raise ConnectionError("sensitive payer connection failure")
            if failure_mode == "httpx_timeout":
                raise httpx.ReadTimeout(
                    "sensitive payer timeout",
                    request=httpx.Request("GET", "https://example.invalid"),
                )
            if failure_mode == "httpx_connect":
                raise httpx.ConnectError(
                    "sensitive payer connect failure",
                    request=httpx.Request("GET", "https://example.invalid"),
                )
            raise TimeoutError("sensitive payer timeout")
        return original_get(table, record_id, studio_id, detail)

    facade._get_row_or_404 = fail_payer_read_once
    request_key = f"retry-payer-read-{failure_mode}"

    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", request_key
        ))

    assert unavailable.value.status_code == 503
    assert "sensitive" not in unavailable.value.detail
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["revision"] == 2
    assert operation["lease_owner"] is None
    assert operation["invoice_retry_preread_released_at"]
    assert operation["invoice_retry_preread_release_reason"] == (
        "local_consent_preread_unavailable"
    )
    release_calls = facade.supabase.release_billing_invoice_retry_preread_lease_calls
    assert len(release_calls) == 1
    assert release_calls[0]["p_release_reason"] == (
        "local_consent_preread_unavailable"
    )
    assert not any(
        name == "read_active_billing_payer_payment_consent_v1"
        for name, _params in facade.supabase.rpc_calls
    )
    assert _Stripe.retrieve_calls == []
    assert _Stripe.setup_intent_retrieve_calls == []
    assert _Stripe.pay_calls == []
    assert facade.supabase.tables["audit_logs"] == []
    assert not any(
        name.startswith("transition_billing_provider_operation")
        for name, _params in facade.supabase.rpc_calls
    )

    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", request_key
    ))
    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "completed"
    assert operation["invoice_retry_preread_released_at"] is None


def test_retry_payer_and_consent_reads_share_one_postgrest_availability_allowlist():
    payer_source = inspect.getsource(
        BillingInvoiceOperationWorkflow._read_autopay_consent
    )
    consent_source = inspect.getsource(
        BillingInvoiceOperationWorkflow._read_retry_active_payer_consent
    )
    assert "_RETRYABLE_POSTGREST_AVAILABILITY_CODES" in payer_source
    assert "_RETRYABLE_POSTGREST_AVAILABILITY_CODES" in consent_source


@pytest.mark.parametrize("fail_on_read", [1, 2, 3])
@pytest.mark.parametrize("error_code", ["PGRST000", "PGRST001", "PGRST002", "PGRST003"])
def test_retry_payer_postgrest_availability_releases_at_every_phase_and_recovers(
    fail_on_read,
    error_code,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)
    original_get = facade._get_row_or_404
    payer_reads = 0

    def fail_payer_phase(table, record_id, studio_id, detail):
        nonlocal payer_reads
        if table == "billing_payers":
            payer_reads += 1
            if payer_reads == fail_on_read:
                raise PostgrestAPIError({
                    "code": error_code,
                    "message": "sensitive payer availability failure",
                    "details": "",
                    "hint": "",
                })
        return original_get(table, record_id, studio_id, detail)

    facade._get_row_or_404 = fail_payer_phase
    request_key = f"retry-payer-{error_code}-{fail_on_read}"

    with pytest.raises(HTTPException) as unavailable:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", request_key
        ))

    assert unavailable.value.status_code == 503
    assert "sensitive" not in unavailable.value.detail
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["invoice_retry_preread_release_reason"] == (
        "local_consent_preread_unavailable"
    )
    assert operation["invoice_retry_preread_released_at"]
    assert _Stripe.pay_calls == []

    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", request_key
    ))
    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    assert _operation(facade, "invoice.retry")["state"] == "completed"


def test_retry_autopay_missing_payer_is_invalid_not_local_outage():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    facade.supabase.tables["billing_payers"] = []
    _seed_retry_provider(invoice)

    with pytest.raises(HTTPException) as invalid:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-missing-payer"
        ))

    assert invalid.value.status_code == 409
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert facade.supabase.release_billing_invoice_retry_preread_lease_calls == []
    assert _Stripe.pay_calls == []


def test_retry_autopay_payer_authorization_status_is_not_local_outage():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)

    def deny_payer_read(table, record_id, studio_id, detail):
        if table == "billing_payers":
            raise HTTPException(status_code=403, detail="Payer read is forbidden.")
        return _Facade._get_row_or_404(facade, table, record_id, studio_id, detail)

    facade._get_row_or_404 = deny_payer_read

    with pytest.raises(HTTPException) as forbidden:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-payer-forbidden"
        ))

    assert forbidden.value.status_code == 403
    assert forbidden.value.detail == "Payer read is forbidden."
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert facade.supabase.release_billing_invoice_retry_preread_lease_calls == []
    assert _Stripe.pay_calls == []


@pytest.mark.parametrize(
    "programming_error",
    [TypeError("payer type bug"), KeyError("payer_key"), AssertionError("payer invariant")],
)
def test_retry_autopay_payer_programming_error_propagates_without_release(
    programming_error,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)

    def fail_payer_programming_read(table, record_id, studio_id, detail):
        if table == "billing_payers":
            raise programming_error
        return _Facade._get_row_or_404(facade, table, record_id, studio_id, detail)

    facade._get_row_or_404 = fail_payer_programming_read

    with pytest.raises(type(programming_error)) as raised:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-payer-programming-error"
        ))

    assert raised.value is programming_error
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["invoice_retry_preread_released_at"] is None
    assert facade.supabase.release_billing_invoice_retry_preread_lease_calls == []
    assert not any(
        name == "read_active_billing_payer_payment_consent_v1"
        for name, _params in facade.supabase.rpc_calls
    )
    assert _Stripe.retrieve_calls == []
    assert _Stripe.setup_intent_retrieve_calls == []
    assert _Stripe.pay_calls == []
    assert facade.supabase.tables["audit_logs"] == []
    assert not any(
        name.startswith("transition_billing_provider_operation")
        for name, _params in facade.supabase.rpc_calls
    )


@pytest.mark.parametrize("fail_on_read", [1, 2, 3])
@pytest.mark.parametrize(
    "error_kind", ["missing", "permission", "semantic", "type", "key", "assertion"]
)
def test_retry_payer_nonavailability_errors_never_release_at_any_phase(
    fail_on_read,
    error_kind,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    original_get = facade._get_row_or_404
    payer_reads = 0
    programming_errors = {
        "type": TypeError("payer type bug"),
        "key": KeyError("payer_key"),
        "assertion": AssertionError("payer invariant"),
    }

    def fail_payer_phase(table, record_id, studio_id, detail):
        nonlocal payer_reads
        if table == "billing_payers":
            payer_reads += 1
            if payer_reads == fail_on_read:
                if error_kind == "missing":
                    raise HTTPException(status_code=404, detail="Payer not found.")
                if error_kind == "permission":
                    raise PostgrestAPIError({
                        "code": "42501",
                        "message": "payer permission denied",
                        "details": "",
                        "hint": "",
                    })
                if error_kind == "semantic":
                    raise PostgrestAPIError({
                        "code": "23514",
                        "message": "payer semantic constraint",
                        "details": "",
                        "hint": "",
                    })
                raise programming_errors[error_kind]
        return original_get(table, record_id, studio_id, detail)

    facade._get_row_or_404 = fail_payer_phase

    if error_kind == "missing":
        with pytest.raises(HTTPException) as rejected:
            asyncio.run(_manager(facade).retry_invoice_payment(
                invoice["id"], "studio_1", "actor_1",
                f"retry-payer-error-{error_kind}-{fail_on_read}",
            ))
        assert rejected.value.status_code == 409
        operation = _operation(facade, "invoice.retry")
        assert operation["state"] == "definitive_rejected"
    else:
        expected_type = (
            PostgrestAPIError
            if error_kind in {"permission", "semantic"}
            else type(programming_errors[error_kind])
        )
        with pytest.raises(expected_type):
            asyncio.run(_manager(facade).retry_invoice_payment(
                invoice["id"], "studio_1", "actor_1",
                f"retry-payer-error-{error_kind}-{fail_on_read}",
            ))
        operation = _operation(facade, "invoice.retry")
        assert operation["state"] == "started"
        assert operation["provider_request_attempt_count"] == 0

    assert facade.supabase.release_billing_invoice_retry_preread_lease_calls == []
    assert operation["invoice_retry_preread_released_at"] is None
    assert _Stripe.pay_calls == []
    assert facade.supabase.tables["audit_logs"] == []


def test_retry_released_consent_first_terminalizes_and_allows_void_owner():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.setup_intent_retrieve_exception = TimeoutError("provider unavailable")

    with pytest.raises(HTTPException):
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-consent-first"
        ))
    retry_operation = _operation(facade, "invoice.retry")
    assert retry_operation["invoice_retry_preread_released_at"]

    with pytest.raises(HTTPException) as blocked_void:
        asyncio.run(_manager(facade).void_invoice(
            invoice["id"], "studio_1", "actor_1", "void-before-consent"
        ))
    assert blocked_void.value.status_code == 409

    consent = facade.supabase.mutate_billing_payer_payment_consent(
        "consent_1",
        revoked_at="2026-08-27T00:05:00Z",
    )
    assert consent["revoked_at"] == "2026-08-27T00:05:00Z"
    assert retry_operation["state"] == "definitive_rejected"
    assert retry_operation["error_code"] == (
        "invoice_retry_consent_changed_before_provider"
    )
    assert retry_operation["invoice_retry_preread_released_at"] is None

    voided = asyncio.run(_manager(facade).void_invoice(
        invoice["id"], "studio_1", "actor_1", "void-after-consent"
    ))
    assert voided.status == "void"


def test_retry_reclaim_first_clears_marker_and_blocks_consent_change():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)
    _Stripe.setup_intent_retrieve_exception = TimeoutError("provider unavailable")

    with pytest.raises(HTTPException):
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-reclaim-first"
        ))
    _Stripe.setup_intent_retrieve_exception = None
    blocked = []

    def attempt_consent_change_after_reclaim():
        try:
            facade.supabase.mutate_billing_payer_payment_consent(
                "consent_1",
                revoked_at="2026-08-27T00:05:00Z",
            )
        except PostgrestAPIError as exc:
            blocked.append((exc.code, exc.message))

    _Stripe.pay_before_mutation_hook = attempt_consent_change_after_reclaim
    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-reclaim-first"
    ))

    assert paid.status == "paid"
    assert blocked == [("55P03", "billing_invoice_mutation_in_progress")]
    operation = _operation(facade, "invoice.retry")
    assert operation["invoice_retry_preread_released_at"] is None
    assert len(_Stripe.pay_calls) == 1


@pytest.mark.parametrize("failure_mode", ["rpc_error", "malformed_response"])
def test_retry_autopay_preread_release_failure_is_sanitized_and_fail_closed(
    failure_mode,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.setup_intent_retrieve_exception = TimeoutError("provider unavailable")
    original_release = (
        facade.supabase._rpc_release_billing_invoice_retry_preread_lease_v33
    )

    def fail_release(params):
        if failure_mode == "rpc_error":
            facade.supabase.release_billing_invoice_retry_preread_lease_calls.append(
                dict(params)
            )
            raise RuntimeError("sensitive release failure")
        result = original_release(params)
        result["operation"].pop("actor_id")
        return result

    facade.supabase._rpc_release_billing_invoice_retry_preread_lease_v33 = (
        fail_release
    )

    with pytest.raises(HTTPException) as failed:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", f"retry-release-{failure_mode}"
        ))

    assert failed.value.status_code == 503
    assert failed.value.detail == INVOICE_RETRY_PREREAD_RELEASE_FAILED_DETAIL
    assert "sensitive" not in failed.value.detail
    assert _Stripe.pay_calls == []
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "started"
    assert operation["provider_request_attempt_count"] == 0
    assert operation["reconciliation_reason_code"] is None
    assert len(
        facade.supabase.release_billing_invoice_retry_preread_lease_calls
    ) == 1


def test_retry_preread_release_allows_immediate_different_owner_reclaim():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    operations = BillingProviderOperationCoordinator(facade.supabase)
    request_hash = stable_hash({
        "operation_type": "invoice.retry",
        "studio_id": "studio_1",
        "invoice_id": invoice["id"],
        "stripe_invoice_id": invoice["stripe_invoice_id"],
        "stripe_connected_account_id": invoice["stripe_account_id"],
        "connect_account_generation": 2,
    })
    first = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        resource_type="invoice",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="retry-release-reclaim",
        request_sha256=request_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="owner-a",
    )
    operation = _operation(facade, "invoice.retry")

    busy = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        resource_type="invoice",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="retry-release-reclaim",
        request_sha256=request_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="owner-b",
    )
    assert busy["outcome"] == "busy"
    assert busy["operation"]["lease_owner"] == "owner-a"

    context = BillingProviderOperationContext(
        operation_id=first["operation"]["id"],
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        caller_request_key="retry-release-reclaim",
        request_sha256=request_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="owner-a",
    )
    released = operations.release_invoice_retry_preread_lease(
        context,
        busy["operation"],
        release_reason="provider_preread_unavailable",
    )
    assert released["outcome"] == "released"
    assert released["operation"]["lease_owner"] is None

    reclaimed = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        resource_type="invoice",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="retry-release-reclaim",
        request_sha256=request_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="owner-b",
    )
    assert reclaimed["outcome"] == "continued"
    assert reclaimed["operation"]["lease_owner"] == "owner-b"
    assert reclaimed["operation"]["revision"] == released["operation"]["revision"] + 2


@pytest.mark.parametrize(
    ("scope", "field", "value"),
    [
        ("parent", "provider_object_id", "in_evidence"),
        ("parent", "result_code", "provider_started"),
        ("parent", "error_code", "provider_error"),
        ("parent", "reconciliation_reason_code", "needs_review"),
        ("parent", "recovery_proof_sha256", "a" * 64),
        ("parent", "provider_request_in_flight_at", "2026-08-27T00:00:01Z"),
        ("parent", "provider_step_plan_sha256", "b" * 64),
        ("child", "state", "provider_request_in_flight"),
        ("child", "provider_request_attempt_count", 1),
        ("child", "provider_object_id", "ii_evidence"),
        ("child", "result_code", "step_started"),
        ("child", "error_code", "step_error"),
        ("child", "reconciliation_reason_code", "step_review"),
        ("child", "recovery_proof_sha256", "c" * 64),
        ("child", "provider_succeeded_at", "2026-08-27T00:00:01Z"),
    ],
)
def test_retry_preread_release_rejects_all_mutation_evidence_without_mutation(
    scope,
    field,
    value,
):
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    operations = BillingProviderOperationCoordinator(facade.supabase)
    request_hash = stable_hash({
        "operation_type": "invoice.retry",
        "studio_id": "studio_1",
        "invoice_id": invoice["id"],
        "stripe_invoice_id": invoice["stripe_invoice_id"],
        "stripe_connected_account_id": invoice["stripe_account_id"],
        "connect_account_generation": 2,
    })
    claimed = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        resource_type="invoice",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key=f"retry-release-evidence-{scope}-{field}",
        request_sha256=request_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="owner-evidence",
    )
    operation = _operation(facade, "invoice.retry")
    if scope == "parent":
        operation[field] = value
    else:
        step = {
            "state": "pending",
            "provider_request_attempt_count": 0,
            "provider_object_id": None,
            "provider_secondary_object_id": None,
            "provider_request_id": None,
            "result_code": None,
            "error_code": None,
            "reconciliation_reason_code": None,
            "recovery_proof_sha256": None,
            "recovery_outcome": None,
            "recovery_actor_id": None,
            "recovery_authorized_at": None,
            "provider_request_in_flight_at": None,
            "provider_succeeded_at": None,
            "reconciliation_required_at": None,
            "definitive_failed_at": None,
            "definitive_rejected_at": None,
        }
        step[field] = value
        facade.supabase.billing_provider_step_plans[operation["id"]] = {
            "steps": [step]
        }
    prior_revision = operation["revision"]
    prior_lease = (
        operation["lease_owner"],
        operation["lease_acquired_at"],
        operation["lease_expires_at"],
    )
    context = BillingProviderOperationContext(
        operation_id=operation["id"],
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        caller_request_key=operation["caller_request_key"],
        request_sha256=request_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="owner-evidence",
    )

    with pytest.raises((PostgrestAPIError, HTTPException)):
        operations.release_invoice_retry_preread_lease(
            context,
            claimed["operation"],
            release_reason="provider_preread_unavailable",
        )

    assert operation["revision"] == prior_revision
    assert (
        operation["lease_owner"],
        operation["lease_acquired_at"],
        operation["lease_expires_at"],
    ) == prior_lease


@pytest.mark.parametrize(
    ("target", "field", "value"),
    [
        ("setup", "status", "requires_payment_method"),
        ("setup", "customer", "cus_other"),
        ("setup", "payment_method", "pm_other"),
        ("setup_metadata", "setup_request_id", "setup_request_other"),
        ("invoice", "id", "in_other"),
        ("invoice", "status", "void"),
        ("invoice", "default_payment_method", "pm_other_failed"),
        ("invoice_metadata", "payer_id", "payer_other"),
    ],
)
def test_retry_autopay_provider_drift_after_claim_blocks_pay(target, field, value):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    _Stripe.invoices["in_existing"]["metadata"]["benign_invoice_note"] = "ok"
    _Stripe.setup_intents["seti_1"]["metadata"]["benign_setup_note"] = "ok"
    def drift_provider_after_initial_snapshot():
        _Stripe.setup_intent_retrieve_hook = None
        if target == "setup":
            _Stripe.setup_intents["seti_1"][field] = value
        elif target == "setup_metadata":
            _Stripe.setup_intents["seti_1"]["metadata"][field] = value
        elif target == "invoice":
            _Stripe.invoices["in_existing"][field] = value
        else:
            _Stripe.invoices["in_existing"]["metadata"][field] = value

    _Stripe.setup_intent_retrieve_hook = drift_provider_after_initial_snapshot

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", f"retry-provider-drift-{target}-{field}"
        ))

    assert exc.value.status_code == 409
    assert _Stripe.pay_calls == []
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert operation["provider_request_attempt_count"] == 0


def test_retry_autopay_legacy_started_resume_validates_then_pays_once():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_failed",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    legacy_hash = stable_hash({
        "operation_type": "invoice.retry",
        "studio_id": "studio_1",
        "invoice_id": invoice["id"],
        "stripe_invoice_id": invoice["stripe_invoice_id"],
        "stripe_connected_account_id": invoice["stripe_account_id"],
        "connect_account_generation": 2,
    })
    operations = BillingProviderOperationCoordinator(facade.supabase)
    claimed = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        resource_type="invoice",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="retry-legacy-started",
        request_sha256=legacy_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="legacy-lease-before-crash",
    )
    operation = _operation(facade, "invoice.retry")
    legacy_persisted_hash = "d" * 64
    operation["request_sha256"] = legacy_persisted_hash
    ledger = facade.supabase.billing_invoice_retry_hash_ledger_v33[
        ("studio_1", "retry-legacy-started")
    ]
    ledger["effective_persisted_sha256"] = legacy_persisted_hash
    context = BillingProviderOperationContext(
        operation_id=operation["id"],
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.retry",
        caller_request_key="retry-legacy-started",
        request_sha256=legacy_persisted_hash,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="legacy-lease-before-crash",
    )
    released = operations.release_invoice_retry_preread_lease(
        context,
        claimed["operation"],
        release_reason="provider_preread_unavailable",
    )
    assert released["operation"]["invoice_retry_preread_released_at"]

    paid = asyncio.run(_manager(facade).retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-legacy-started"
    ))

    assert paid.status == "paid"
    assert len(_Stripe.retrieve_calls) == 2
    assert len(_Stripe.setup_intent_retrieve_calls) == 2
    assert len(_Stripe.pay_calls) == 1
    assert _Stripe.pay_calls[0]["payment_method"] == "pm_1"
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "completed"
    assert operation["request_sha256"] == legacy_persisted_hash


def test_retry_autopay_completed_replay_after_revoke_has_no_provider_reads():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)

    first = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-active-consent"
    ))
    claim_hash = _operation(facade, "invoice.retry")["request_sha256"]
    assert claim_hash == stable_hash({
        "operation_type": "invoice.retry",
        "studio_id": "studio_1",
        "invoice_id": invoice["id"],
        "stripe_invoice_id": invoice["stripe_invoice_id"],
        "stripe_connected_account_id": invoice["stripe_account_id"],
        "connect_account_generation": 2,
    })
    facade.supabase.tables["billing_payer_payment_consents"][0]["revoked_at"] = (
        "2026-08-27T00:05:00Z"
    )
    replay = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-active-consent"
    ))

    assert first.status == replay.status == "paid"
    assert _operation(facade, "invoice.retry")["request_sha256"] == claim_hash
    assert len(_Stripe.pay_calls) == 1
    assert _Stripe.pay_calls[0]["payment_method"] == "pm_1"
    assert len(_Stripe.retrieve_calls) == 2
    assert len(_Stripe.setup_intent_retrieve_calls) == 2
    assert not any(
        query["table"] == "billing_provider_operations"
        for query in facade.supabase.query_log
    )


def test_retry_terminal_historical_replay_allows_repointed_resource_pointer():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    first = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-terminal-repointed"
    ))
    resource = next(iter(facade.supabase.billing_provider_operation_resources.values()))
    resource["operation_id"] = "00000000-0000-4000-8000-000000009999"
    provider_reads = len(_Stripe.retrieve_calls)

    replay = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-terminal-repointed"
    ))

    assert first.status == replay.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    assert len(_Stripe.retrieve_calls) == provider_reads


def test_retry_autopay_historical_legacy_hash_completed_replay_after_revoke():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    manager = _manager(facade)

    first = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-historical-completed"
    ))
    completed = _operation(facade, "invoice.retry")
    completed["request_sha256"] = "c" * 64
    facade.supabase.billing_invoice_retry_hash_ledger_v33[
        ("studio_1", "retry-historical-completed")
    ]["effective_persisted_sha256"] = "c" * 64
    facade.supabase.tables["billing_payer_payment_consents"][0]["revoked_at"] = (
        "2026-08-27T00:05:00Z"
    )
    invoice_reads = len(_Stripe.retrieve_calls)
    setup_reads = len(_Stripe.setup_intent_retrieve_calls)

    replay = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-historical-completed"
    ))

    assert first.status == replay.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    assert len(_Stripe.retrieve_calls) == invoice_reads
    assert len(_Stripe.setup_intent_retrieve_calls) == setup_reads


@pytest.mark.parametrize("closed_field", ["revoked_at", "superseded_at"])
def test_retry_autopay_rechecks_consent_after_setup_intent_read_before_pay(
    closed_field,
):
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)

    def close_consent_after_provider_read():
        facade.supabase.tables["billing_payer_payment_consents"][0][closed_field] = (
            "2026-08-27T00:05:00Z"
        )

    _Stripe.setup_intent_retrieve_hook = close_consent_after_provider_read

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", f"retry-race-{closed_field}"
        ))

    assert exc.value.status_code == 409
    assert len(_Stripe.retrieve_calls) == 1
    assert len(_Stripe.setup_intent_retrieve_calls) == 1
    assert _Stripe.pay_calls == []
    operation = _operation(facade, "invoice.retry")
    assert operation["state"] == "definitive_rejected"
    assert operation["provider_request_attempt_count"] == 0


def test_retry_autopay_owner_blocks_revoke_inside_provider_mutation_boundary():
    invoice = _open_invoice(
        collection_method="charge_automatically",
        default_payment_method_id="pm_1",
    )
    facade = _Facade(payer=_autopay_payer(), invoice=invoice)
    _seed_retry_provider(invoice)
    _seed_autopay_consent(facade, invoice)
    blocked_revocations = []

    def attempt_revoke_after_final_validation():
        try:
            facade.supabase.mutate_billing_payer_payment_consent(
                "consent_1",
                revoked_at="2026-08-27T00:05:00Z",
            )
        except PostgrestAPIError as exc:
            blocked_revocations.append((exc.code, exc.message))

    _Stripe.pay_before_mutation_hook = attempt_revoke_after_final_validation
    paid = asyncio.run(_manager(facade).retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-consent-owner"
    ))

    assert paid.status == "paid"
    assert blocked_revocations == [
        ("55P03", "billing_invoice_mutation_in_progress")
    ]
    assert facade.supabase.tables["billing_payer_payment_consents"][0][
        "revoked_at"
    ] is None
    assert len(_Stripe.pay_calls) == 1
    assert _operation(facade, "invoice.retry")["state"] == "completed"

    consent = facade.supabase.mutate_billing_payer_payment_consent(
        "consent_1",
        revoked_at="2026-08-27T00:05:00Z",
    )
    assert consent["revoked_at"] == "2026-08-27T00:05:00Z"


def test_retry_lost_provider_response_uses_readback_without_second_pay():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.pay_exception = TimeoutError("raw timeout with secret")
    _Stripe.pay_exception_after_commit = True
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-lost"
        ))
    assert exc.value.status_code == 503
    assert "secret" not in exc.value.detail
    assert _operation(facade, "invoice.retry")["state"] == "reconciliation_required"

    _Stripe.pay_exception = None
    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-lost"
    ))
    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1


def test_retry_different_key_is_rejected_before_canonical_reconciliation_resume():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.pay_exception = TimeoutError("raw timeout")
    _Stripe.pay_exception_after_commit = True
    manager = _manager(facade)

    with pytest.raises(HTTPException):
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-owner"
        ))
    with pytest.raises(HTTPException) as denied:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_2", "retry-cross-actor"
        ))
    _Stripe.pay_exception = None
    with pytest.raises(HTTPException) as changed_key:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-adopter"
        ))
    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-owner"
    ))

    assert denied.value.status_code == 409
    assert changed_key.value.status_code == 503
    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    canonical = _operation(facade, "invoice.retry")
    assert canonical["actor_id"] == "actor_1"
    assert canonical["caller_request_key"] == "retry-owner"
    assert canonical["state"] == "completed"
    resource_claims = [
        params
        for name, params in facade.supabase.rpc_calls
        if name == "claim_billing_provider_operation_resource_v1"
    ]
    assert resource_claims[-1]["p_actor_id"] == "actor_1"
    transitions = [
        params
        for name, params in facade.supabase.rpc_calls
        if name == "transition_billing_provider_operation_v1"
    ]
    assert transitions[-1]["p_actor_id"] == "actor_1"
    assert transitions[-1]["p_caller_request_key"] == "retry-owner"


def test_retry_caller_key_cannot_cross_invoice_resources():
    first = _open_invoice()
    second = _open_invoice(
        id="invoice_other",
        stripe_invoice_id="in_other",
    )
    facade = _Facade(invoice=first)
    facade.supabase.tables["billing_invoices"].append(second)
    _seed_retry_provider(first)
    _seed_retry_provider(second)
    manager = _manager(facade)
    asyncio.run(manager.retry_invoice_payment(
        first["id"], "studio_1", "actor_1", "resource-key"
    ))

    with pytest.raises(HTTPException) as conflict:
        asyncio.run(manager.retry_invoice_payment(
            second["id"], "studio_1", "actor_1", "resource-key"
        ))

    assert conflict.value.status_code == 409
    assert len(_Stripe.pay_calls) == 1


def test_retry_provider_success_local_failure_marks_reconciliation_then_readback_recovers():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    facade.projection_failures = 1
    _seed_retry_provider(invoice)
    manager = _manager(facade)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-projection"
        ))
    assert exc.value.status_code == 503
    assert exc.value.detail == INVOICE_RETRY_AMBIGUOUS_DETAIL
    assert _operation(facade, "invoice.retry")["state"] == "reconciliation_required"

    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-projection"
    ))
    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 1
    assert len(facade.supabase.tables["audit_logs"]) == 1


def test_retry_requires_proof_bound_admin_recovery_before_second_provider_attempt():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.pay_exception = TimeoutError("provider request did not reach Stripe")
    manager = _manager(facade)

    with pytest.raises(HTTPException):
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "recovery-key"
        ))
    canonical = _operation(facade, "invoice.retry")
    assert canonical["state"] == "reconciliation_required"
    assert len(_Stripe.pay_calls) == 1

    context = BillingProviderOperationContext(
        operation_id=canonical["id"],
        studio_id="studio_1",
        actor_id=canonical["actor_id"],
        operation_type="invoice.retry",
        caller_request_key=canonical["caller_request_key"],
        request_sha256=canonical["request_sha256"],
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner=canonical["lease_owner"],
    )
    stale = dict(canonical)
    operations = BillingProviderOperationCoordinator(facade.supabase)
    recovered = operations.authorize_recovery(
        context,
        canonical,
        recovery_actor_id="admin_1",
        recovery_proof_sha256="a" * 64,
        recovery_outcome="provider_no_object_safe_to_retry",
        lease_owner="00000000-0000-4000-8000-000000000222",
    )
    with pytest.raises(AssertionError):
        operations.authorize_recovery(
            context,
            stale,
            recovery_actor_id="admin_2",
            recovery_proof_sha256="b" * 64,
            recovery_outcome="provider_no_object_safe_to_retry",
            lease_owner="00000000-0000-4000-8000-000000000333",
        )
    assert recovered["state"] == "recovery_authorized"
    assert recovered["lease_owner"] == "00000000-0000-4000-8000-000000000222"
    facade.supabase.advance_billing_provider_clock(seconds=31)

    _Stripe.pay_exception = None
    with pytest.raises(HTTPException) as changed_key:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "recovery-alias"
        ))
    assert changed_key.value.status_code == 503
    paid = asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "recovery-key"
    ))
    assert paid.status == "paid"
    assert len(_Stripe.pay_calls) == 2
    assert canonical["state"] == "completed"


def test_retry_completed_projection_drift_is_sanitized_without_second_pay():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-drift"
    ))
    invoice["status"] = "open"
    invoice["amount_remaining_cents"] = 5000

    with pytest.raises(HTTPException) as exc:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-drift"
        ))

    assert exc.value.status_code == 503
    assert exc.value.detail == INVOICE_RETRY_AMBIGUOUS_DETAIL
    assert len(_Stripe.pay_calls) == 1


def test_retry_projected_projection_drift_marks_reconciliation_without_second_pay():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    manager = _manager(facade)
    asyncio.run(manager.retry_invoice_payment(
        invoice["id"], "studio_1", "actor_1", "retry-projected-drift"
    ))
    parent = _operation(facade, "invoice.retry")
    parent["state"] = "projected"
    invoice["status"] = "open"
    invoice["amount_remaining_cents"] = 5000

    with pytest.raises(HTTPException) as exc:
        asyncio.run(manager.retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-projected-drift"
        ))

    assert exc.value.status_code == 503
    assert parent["state"] == "reconciliation_required"
    assert len(_Stripe.pay_calls) == 1


def test_invoice_mutations_share_one_owner_across_finalize_void_and_retry():
    invoice = _open_invoice()
    invoice["status"] = "draft"
    facade = _Facade(invoice=invoice)
    operations = BillingProviderOperationCoordinator(facade.supabase)

    finalize = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.finalize",
        resource_type="invoice_finalize",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="finalize-owner",
        request_sha256="a" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000111",
    )
    finalize_operation = finalize["operation"]

    for operation_type, resource_type, key in (
        ("invoice.void", "invoice_void", "void-blocked"),
        ("invoice.retry", "invoice", "retry-blocked"),
    ):
        with pytest.raises(HTTPException) as blocked:
            operations.claim_resource(
                studio_id="studio_1",
                actor_id="actor_1",
                operation_type=operation_type,
                resource_type=resource_type,
                resource_id=invoice["id"],
                payer_id=invoice["payer_id"],
                caller_request_key=key,
                request_sha256="b" * 64,
                stripe_connected_account_id="acct_1",
                connect_account_generation=2,
                lease_owner="00000000-0000-4000-8000-000000000222",
            )
        assert blocked.value.status_code == 409

    finalize_context = BillingProviderOperationContext(
        operation_id=finalize_operation["id"],
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.finalize",
        caller_request_key="finalize-owner",
        request_sha256="a" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000111",
    )
    operations.transition(
        finalize_context,
        finalize_operation,
        "definitive_rejected",
        error_code="provider_mutation_blocked",
    )
    void = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.void",
        resource_type="invoice_void",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="void-owner",
        request_sha256="b" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000222",
    )
    assert void["outcome"] == "claimed"
    assert facade.supabase.billing_invoice_mutation_owners[
        ("studio_1", invoice["id"])
    ]["operation_id"] == void["operation"]["id"]

    historical = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.finalize",
        resource_type="invoice_finalize",
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="finalize-owner",
        request_sha256="a" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000333",
    )
    assert historical["outcome"] == "replay"
    assert historical["operation"]["id"] == finalize_operation["id"]

    void_operation = void["operation"]
    void_context = BillingProviderOperationContext(
        operation_id=void_operation["id"],
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type="invoice.void",
        caller_request_key="void-owner",
        request_sha256="b" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000222",
    )
    void_operation = operations.transition(
        void_context,
        void_operation,
        "provider_request_in_flight",
    )
    operations.transition(
        void_context,
        void_operation,
        "reconciliation_required",
        reconciliation_reason_code="invoice_void_outcome_ambiguous",
    )
    with pytest.raises(HTTPException) as reconciliation_block:
        operations.claim_resource(
            studio_id="studio_1",
            actor_id="actor_1",
            operation_type="invoice.retry",
            resource_type="invoice",
            resource_id=invoice["id"],
            payer_id=invoice["payer_id"],
            caller_request_key="retry-after-void-ambiguous",
            request_sha256="c" * 64,
            stripe_connected_account_id="acct_1",
            connect_account_generation=2,
            lease_owner="00000000-0000-4000-8000-000000000444",
        )
    assert reconciliation_block.value.status_code == 409


@pytest.mark.parametrize(
    ("operation_type", "resource_type"),
    (
        ("invoice.finalize", "invoice_finalize"),
        ("invoice.void", "invoice_void"),
        ("invoice.retry", "invoice"),
    ),
)
def test_terminal_invoice_mutation_replaces_same_resource_and_keeps_old_key(
    operation_type: str,
    resource_type: str,
):
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    operations = BillingProviderOperationCoordinator(facade.supabase)
    first = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type=operation_type,
        resource_type=resource_type,
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="terminal-k1",
        request_sha256="d" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000111",
    )
    first_operation = first["operation"]
    first_context = BillingProviderOperationContext(
        operation_id=first_operation["id"],
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type=operation_type,
        caller_request_key="terminal-k1",
        request_sha256="d" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000111",
    )
    operations.transition(
        first_context,
        first_operation,
        "definitive_rejected",
        error_code="provider_mutation_blocked",
    )
    second = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type=operation_type,
        resource_type=resource_type,
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="terminal-k2",
        request_sha256="d" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000222",
    )
    assert second["outcome"] == "replaced"
    assert second["resource"]["id"] == first["resource"]["id"]
    assert second["operation"]["id"] != first_operation["id"]
    historical = operations.claim_resource(
        studio_id="studio_1",
        actor_id="actor_1",
        operation_type=operation_type,
        resource_type=resource_type,
        resource_id=invoice["id"],
        payer_id=invoice["payer_id"],
        caller_request_key="terminal-k1",
        request_sha256="d" * 64,
        stripe_connected_account_id="acct_1",
        connect_account_generation=2,
        lease_owner="00000000-0000-4000-8000-000000000333",
    )
    assert historical["outcome"] == "replay"
    assert historical["operation"]["id"] == first_operation["id"]
    assert facade.supabase.billing_invoice_mutation_owners[
        ("studio_1", invoice["id"])
    ]["operation_id"] == second["operation"]["id"]


def test_retry_definitive_decline_is_terminal_and_sanitized():
    invoice = _open_invoice()
    facade = _Facade(invoice=invoice)
    _seed_retry_provider(invoice)
    _Stripe.pay_exception = StripeCardError(
        "raw card details",
        param=None,
        code="card_declined",
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_manager(facade).retry_invoice_payment(
            invoice["id"], "studio_1", "actor_1", "retry-decline"
        ))

    assert exc.value.status_code == 402
    assert "raw" not in exc.value.detail
    assert _operation(facade, "invoice.retry")["state"] == "definitive_rejected"
    assert "raw" not in repr(_operation(facade, "invoice.retry"))
