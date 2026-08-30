from __future__ import annotations

import copy
import contextlib
import io
import importlib.util
import json
import tempfile
from pathlib import Path
import re
import unittest
from unittest import mock
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("collector", ROOT / "scripts" / "collect-stripe-provider-rehearsal-evidence.py")
assert SPEC and SPEC.loader
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)
READINESS = {"status":"ready","environment":"staging","commit_sha":"a" * 40,"configured_stripe_mode":"test"}


class FakeResponse:
    def __init__(self, data): self.data = data


class FakeQuery:
    def __init__(self, rows, ranges=None, on_execute=None, table_name=None, selections=None): self.rows, self.filters, self.bounds, self.ranges, self.columns, self.maximum, self.on_execute, self.table_name, self.selections = rows, [], None, ranges, None, None, on_execute, table_name, selections
    def select(self, columns="*"):
        if self.selections is not None: self.selections.append((self.table_name, columns))
        self.columns = None if columns == "*" else [column.strip() for column in columns.split(",")]
        return self
    def in_(self, key, values): self.filters.append(("in", key, set(values))); return self
    def eq(self, key, value): self.filters.append(("eq", key, value)); return self
    def gte(self, key, value): self.filters.append(("gte", key, value)); return self
    def lte(self, key, value): self.filters.append(("lte", key, value)); return self
    def order(self, key): self.filters.append(("order", key, None)); return self
    def or_(self, expression):
        match = re.fullmatch(r"created_at\.gt\.(.*),and\(created_at\.eq\.(.*),live_billing_ingest_sequence\.gt\.(\d+)\)", expression)
        if not match or match.group(1) != match.group(2): raise AssertionError("unexpected keyset expression")
        cursor = (match.group(1), int(match.group(3)))
        self.filters.append(("keyset", "created_at", cursor))
        if self.ranges is not None: self.ranges.append(("keyset", cursor))
        return self
    @property
    def not_(self): return self
    def is_(self, key, value):
        if value != "null": raise AssertionError("unexpected not-is predicate")
        self.filters.append(("not_null", key, None)); return self
    def limit(self, count): self.maximum = count; return self
    def range(self, start, end):
        self.bounds = (start, end)
        if self.ranges is not None: self.ranges.append((start, end))
        return self
    def execute(self):
        rows = self.rows
        for operation, key, value in self.filters:
            if operation == "in": rows = [row for row in rows if row.get(key) in value]
            elif operation == "eq": rows = [row for row in rows if row.get(key) == value]
            elif operation == "gte": rows = [row for row in rows if str(row.get(key) or "") >= value]
            elif operation == "lte": rows = [row for row in rows if str(row.get(key) or "") <= value]
            elif operation == "not_null": rows = [row for row in rows if row.get(key) is not None]
            elif operation == "keyset": rows = [row for row in rows if (str(row.get("created_at") or ""), row.get("live_billing_ingest_sequence")) > value]
        order_keys = [key for operation, key, _ in self.filters if operation == "order"]
        if order_keys: rows = sorted(rows, key=lambda row: tuple(row.get(key) for key in order_keys))
        if self.bounds: rows = rows[self.bounds[0]:self.bounds[1] + 1]
        if self.maximum is not None: rows = rows[:self.maximum]
        if self.columns is not None:
            projected = []
            for row in rows:
                output = {}
                for expression in self.columns:
                    alias, source = expression.split(":", 1) if ":" in expression else (expression, expression)
                    if "->>" in source:
                        column, key = source.split("->>", 1); value = (row.get(column) or {}).get(key)
                        value = None if value is None else str(value)
                    elif "->" in source:
                        column, key = source.split("->", 1); value = (row.get(column) or {}).get(key)
                    else: value = row.get(source)
                    output[alias] = value
                projected.append(output)
            rows = projected
        if self.on_execute is not None: self.on_execute(self, rows)
        return FakeResponse(copy.deepcopy(rows))


class FakeSupabase:
    def __init__(self, tables, late_event=None): self.tables, self.calls, self.ranges, self.selections, self.late_event, self.event_page_count = tables, [], [], [], late_event, 0
    def _after_execute(self, query, _rows):
        if query.maximum is not None:
            self.event_page_count += 1
            if self.event_page_count == 1 and self.late_event is not None:
                self.tables["stripe_events"].append(copy.deepcopy(self.late_event))
    def table(self, name): self.calls.append(name); return FakeQuery(self.tables.get(name, []), self.ranges if name == "stripe_events" else None, self._after_execute if name == "stripe_events" else None, name, self.selections)
    def rpc(self, *_args, **_kwargs): raise AssertionError("RPC forbidden")


class FakeStripe:
    def __init__(self, objects):
        self.objects, self.calls = objects, []
        def owner(name): return SimpleNamespace(retrieve=lambda identifier, **kwargs: self.retrieve(name, identifier, kwargs))
        for name in ("Account", "Customer", "SetupIntent", "Product", "Price", "Subscription", "SubscriptionItem", "SubscriptionSchedule", "Invoice", "PaymentIntent", "Charge", "Refund", "Dispute", "Event"):
            setattr(self, name, owner(name))
        self.checkout = SimpleNamespace(Session=owner("checkout.Session"))
        self.test_helpers = SimpleNamespace(TestClock=owner("test_helpers.TestClock"))
    def retrieve(self, owner, identifier, kwargs):
        self.calls.append((owner, identifier, kwargs))
        row = copy.deepcopy(self.objects[identifier])
        if row.pop("last_payment_error_present", False): row["last_payment_error"] = {"code":"declined"}
        return row


def manifest():
    local = {owner: {role: f"{owner}_{index}" for index, role in enumerate(sorted(roles), 1)} for owner, roles in C.LOCAL_ROLE_SCHEMA.items()}
    for first, second in (("plan_product_create","plan_price_create"),("invoice_link_invoice_create","invoice_link_item_create"),("invoice_link_finalize","invoice_link_send"),("automatic_invoice_create","automatic_item_create"),("enrollment_subscription_create","enrollment_shared_quantity_update"),("period_end_revoke_schedule_create","period_end_revoke_schedule_update"),("period_end_due_schedule_create","period_end_due_schedule_update")):
        local["operations"][second] = local["operations"][first]
    local["webhook_events"] = {"connect_checkout":"evt_connect","dispute_created":"evt_disputecreated","dispute_closed":"evt_disputeclosed","platform_subscription":"evt_platform"}
    local["platform_core_rows"] = {"platform_subscription":"studio_1"}
    bootstrap_logs = {}
    for index, operation in enumerate(sorted(C.BOOTSTRAP_LOG_OPERATIONS)):
        account = operation == "connect_account.create"
        bootstrap_logs[operation] = {
            "query_started_at": f"2026-08-29T09:0{index * 2}:00Z",
            "query_ended_at": f"2026-08-29T09:0{index * 2 + 1}:00Z",
            "filters": {"operation": operation, "method": "POST", "test_mode": True},
            "pages": [{"cursor": None, "next_cursor": None, "has_more": False, "entries": [{
                "request_id": f"req_{index}", "operation": operation,
                "provider_created_at": f"2026-08-29T09:0{index * 2}:30Z", "method": "POST",
                "path": "/v2/core/accounts" if account else "/v2/core/account_links",
                "http_status": 200, "test_mode": True, "idempotency_key_sha256": "b" * 64,
                "caller_input_sha256": "c" * 64,
                "request_facts": ({"studio_id": "studio_1", "connect_account_generation": 1} if account else {"account_id": "acct_Test1", "studio_id": "studio_1"}),
                "response_facts": ({"object": "account", "account_id": "acct_Test1", "metadata_studio_id": "studio_1"} if account else {"object": "account_link", "account_id": "acct_Test1", "expires_at": 1788000000, "single_use": True}),
            }]}], "total_matching_count": 1,
        }
    provider_ids = {
        "account": "acct_Test1", "payer_customer": "cus_payer", "initial_checkout": "cs_initial",
        "initial_setup_intent": "seti_initial", "replacement_checkout": "cs_replacement",
        "replacement_setup_intent": "seti_replacement", "product": "prod_1", "price": "price_1",
        "shared_subscription": "sub_shared", "shared_subscription_item": "si_shared",
        "invoice_link": "in_link", "automatic_invoice": "in_auto",
        "automatic_payment_intent": "pi_auto", "automatic_charge": "ch_auto",
        "revoke_schedule": "sub_sched_revoke", "due_schedule": "sub_sched_due",
        "refund": "re_1", "dispute": "dp_1", "test_clock": "clock_1",
        "platform_customer": "cus_platform", "platform_subscription": "sub_platform",
        "connect_checkout_event": "evt_connect", "dispute_created_event": "evt_disputecreated",
        "dispute_closed_event": "evt_disputeclosed", "platform_subscription_event": "evt_platform",
    }
    return C.validate_manifest({
        "manifest_schema_version": 1, "candidate_sha": "a" * 40,
        "readiness_origin": "https://staging.example.invalid", "studio_id": "studio_1",
        "stripe_account_id": "acct_Test1", "connect_account_generation": 1,
        "rehearsal_started_at": "2026-08-29T10:00:00Z", "local_ids": local,
        "provider_objects": {role: {"id": provider_ids[role], "kind": kind, "context": context, "phase": list(C.PHASES)} for role, (kind, context) in C.PROVIDER_ROLE_SCHEMA.items()},
        "actor_bindings": {"actor_1": "admin", "actor_2": "front_desk"},
        "external_payment_audit_ids": ["audit_1"],
        "workbench_bootstrap_request_logs": bootstrap_logs,
        "workbench_delivery_attempts": [
            {"attempt_id":"attempt_1","role":"original","surface":"connect","event_id":"evt_connect","event_type":"checkout.session.completed","checkout_session_id":"cs_replacement","endpoint_url":"https://staging.example.invalid/api/v1/webhooks/stripe/connect","delivery_status":"delivered","http_status":200,"delivered_at":"2026-08-29T10:02:00Z"},
            {"attempt_id":"attempt_2","role":"manual_resend","surface":"connect","event_id":"evt_connect","event_type":"checkout.session.completed","checkout_session_id":"cs_replacement","endpoint_url":"https://staging.example.invalid/api/v1/webhooks/stripe/connect","delivery_status":"delivered","http_status":200,"delivered_at":"2026-08-29T10:03:00Z"},
            {"attempt_id":"attempt_3","role":"original","surface":"platform","event_id":"evt_platform","event_type":"customer.subscription.created","checkout_session_id":None,"endpoint_url":"https://staging.example.invalid/api/v1/webhooks/stripe/platform","delivery_status":"delivered","http_status":200,"delivered_at":"2026-08-29T10:04:00Z"},
        ],
    })


def chain():
    m = manifest()
    rows = [{"owner": owner, **({"stripe_event_id": identifier} if owner == "webhook_events" else ({"studio_id": identifier} if owner == "platform_core_rows" else {"id": identifier})), "studio_id":"studio_1", "status": "completed", "created_at":"2026-08-29T10:00:00Z"} for owner, roles in m["local_ids"].items() for identifier in dict.fromkeys(roles.values())]
    for row in rows:
        if row["owner"] in {"operations","steps","setup_requests","consents","transitions"}:
            row.update(stripe_connected_account_id="acct_Test1", connect_account_generation=1)
        if row["owner"] in {"invoices","payments","refunds","disputes"}:
            row["stripe_account_id"] = "acct_Test1"
        if row["owner"] in {"payments","refunds","disputes"}:
            row["connect_account_generation"] = 1
        if row["owner"] == "webhook_events":
            row.pop("studio_id", None)
    validator, _ = C._load_contract()
    for step_name, source_role in C.MUTATION_SOURCE_ROLES.items():
        row = next(row for row in rows if row["owner"] == "operations" and row["id"] == m["local_ids"]["operations"][source_role])
        workflow, operation, scope, actor_role, _ = validator.REQUIRED_MUTATIONS[step_name]
        row.update(operation_type=C.PARENT_OPERATION_TYPES.get(workflow, workflow), state="completed", stripe_connected_account_id="acct_Test1", connect_account_generation=1,
                   actor_id="actor_internal" if actor_role == "internal" else ("actor_2" if actor_role == "front_desk" else "actor_1"),
                   request_sha256="c" * 64, caller_request_key=f"caller-{row['id']}", caller_request_key_sha256="d" * 64, provider_request_attempt_count=1, completed_at="2026-08-29T10:01:00Z")
        if step_name == "payer.customer_create":
            row.update(recovery_outcome="provider_succeeded_reconcile_only", provider_object_id="cus_payer")
        else:
            step = next(item for item in rows if item["owner"] == "steps" and item["id"] == m["local_ids"]["steps"][source_role])
            step.update(operation_id=row["id"], provider_operation=operation, state="provider_succeeded", provider_request_attempt_count=1,
                        stripe_connected_account_id="acct_Test1", connect_account_generation=1, request_sha256="e" * 64,
                        stripe_idempotency_key=f"step-{step['id']}", caller_request_key_sha256="f" * 64)
    due = next(row for row in rows if row["owner"] == "transitions" and row["id"] == m["local_ids"]["transitions"]["due"])
    due.update(provider_operation_id=m["local_ids"]["operations"]["period_end_due_release"], transition_kind="execute_due", initiated_by="actor_internal")
    payer = next(row for row in rows if row["owner"] == "payers")
    payer.update(stripe_customer_id="cus_payer", billing_status="current")
    plan = next(row for row in rows if row["owner"] == "plans")
    plan.update(stripe_product_id="prod_1", stripe_price_id="price_1")
    for phase_name, pm in (("initial", "pm_initial"), ("replacement", "pm_replacement")):
        request = next(row for row in rows if row["owner"] == "setup_requests" and row["id"] == m["local_ids"]["setup_requests"][phase_name])
        consent = next(row for row in rows if row["owner"] == "consents" and row["id"] == m["local_ids"]["consents"][phase_name])
        request.update(stripe_checkout_session_id=m["provider_objects"][f"{phase_name}_checkout"]["id"])
        consent.update(payer_id=payer["id"], stripe_connected_account_id="acct_Test1", connect_account_generation=1,
                       setup_request_id=request["id"], stripe_checkout_session_id=m["provider_objects"][f"{phase_name}_checkout"]["id"], stripe_setup_intent_id=m["provider_objects"][f"{phase_name}_setup_intent"]["id"],
                       terms_version=f"terms-{phase_name}", accepted_at="2026-08-29T10:00:00Z", completed_at="2026-08-29T10:01:00Z",
                       superseded_at="2026-08-29T10:02:00Z" if phase_name == "initial" else None,
                       revoked_at=None)
    for number, role in enumerate(("student_one", "student_two"), 1):
        enrollment = next(row for row in rows if row["owner"] == "subscriptions" and row["id"] == m["local_ids"]["subscriptions"][role])
        enrollment.update(student_id=f"student_{number}", payer_id=payer["id"], status="active", stripe_subscription_id="sub_shared", stripe_subscription_item_id="si_shared")
    invoice_link = next(row for row in rows if row["owner"] == "invoices" and row["id"] == m["local_ids"]["invoices"]["invoice_link"])
    invoice_link.update(stripe_invoice_id="in_link", finalized_at="2026-08-29T10:03:00Z", sent_at="2026-08-29T10:04:00Z")
    automatic = next(row for row in rows if row["owner"] == "invoices" and row["id"] == m["local_ids"]["invoices"]["automatic"])
    automatic.update(stripe_invoice_id="in_auto", amount_remaining_cents=0)
    payment = next(row for row in rows if row["owner"] == "payments" and row["id"] == m["local_ids"]["payments"]["automatic"])
    payment.update(stripe_payment_intent_id="pi_auto", stripe_charge_id="ch_auto", amount_cents=10000, application_fee_cents=50,
                   gross_paid_cents=10000, refunded_cents=1000, disputed_cents=0, net_collected_cents=9000,
                   refundable_remaining_cents=9000, application_fee_amount_cents=50, gross_paid_amount_cents=10000,
                   refunded_amount_cents=1000, disputed_amount_cents=0, net_collected_amount_cents=9000,
                   refundable_amount_cents=9000, adjustment_reconciliation_required=False, reconciliation_required=False)
    refund = next(row for row in rows if row["owner"] == "refunds")
    refund.update(payment_id=payment["id"], stripe_refund_id="re_1", amount_cents=1000, status="succeeded", reconciliation_required=False, stripe_account_id="acct_Test1", connect_account_generation=1)
    dispute = next(row for row in rows if row["owner"] == "disputes")
    dispute.update(payment_id=payment["id"], stripe_dispute_id="dp_1", status="won", state_category="won", reconciliation_required=False)
    for role, state, schedule_id in (("schedule", "scheduled", None), ("revoke", "revoked", "sub_sched_revoke"), ("due", "completed", "sub_sched_due")):
        transition = next(row for row in rows if row["owner"] == "transitions" and row["id"] == m["local_ids"]["transitions"][role])
        transition.update(state=state, mutation_strategy="subscription_item_delete_at_period_end", provider_quantity=2, expected_quantity=1)
    next(row for row in rows if row["owner"] == "operations" and row["id"] == m["local_ids"]["operations"]["period_end_revoke_schedule_create"])["provider_object_id"] = "sub_sched_revoke"
    next(row for row in rows if row["owner"] == "operations" and row["id"] == m["local_ids"]["operations"]["period_end_due_schedule_create"])["provider_object_id"] = "sub_sched_due"
    ambiguity = next(row for row in rows if row["owner"] == "operations" and row["id"] == m["local_ids"]["operations"]["ambiguity_parent"])
    ambiguity.update(actor_id="actor_1", state="completed", operation_type="payer.sync", stripe_connected_account_id="acct_Test1", connect_account_generation=1, recovery_outcome="provider_succeeded_reconcile_only", provider_request_attempt_count=1, provider_object_id="cus_payer", completed_at="2026-08-29T10:01:00Z", caller_request_key="ambiguity-key", caller_request_key_sha256="e" * 64)
    resource = next(row for row in rows if row["owner"] == "resources")
    resource.update(operation_id=ambiguity["id"], resource_type="payer", resource_id=payer["id"], payer_id=payer["id"], revision=1)
    void_op = next(row for row in rows if row["owner"] == "operations" and row["id"] == m["local_ids"]["operations"]["invoice_void"])
    void_op.update(actor_id="actor_1", state="completed", operation_type="invoice.void", stripe_connected_account_id="acct_Test1", connect_account_generation=1, provider_object_id="in_link", provider_request_attempt_count=1, caller_request_key="void-key", caller_request_key_sha256="f" * 64)
    immediate_op = next(row for row in rows if row["owner"] == "operations" and row["id"] == m["local_ids"]["operations"]["immediate_cancellation"])
    immediate_op.update(actor_id="actor_1", state="completed", operation_type="enrollment.cancel.immediate", stripe_connected_account_id="acct_Test1", connect_account_generation=1, provider_object_id="sub_shared", provider_request_attempt_count=1, caller_request_key="immediate-key", caller_request_key_sha256="1" * 64)
    immediate_transition = next(row for row in rows if row["owner"] == "transitions" and row["id"] == m["local_ids"]["transitions"]["immediate"])
    immediate_transition.update(state="completed", transition_kind="immediate_cancel", provider_operation_id=immediate_op["id"], enrollment_id=m["local_ids"]["subscriptions"]["student_two"])
    external = next(row for row in rows if row["owner"] == "payments" and row["id"] == m["local_ids"]["payments"]["payments.external"])
    external.update(status="externally_recorded", amount_cents=2500, currency="usd", external_method="cash", idempotency_key="external-key", request_hash="3" * 64, caller_request_key_sha256="2" * 64, invoice_id=None)
    rows.append({"owner":"audit_logs","id":"audit_1","studio_id":"studio_1","actor_id":"actor_1","action":"billing.external_payment_recorded","entity_type":"billing","entity_id":external["id"],"metadata":{"amount_cents":2500,"external_method":"cash"},"created_at":"2026-08-29T10:01:00Z"})
    for role, event_id, event_type, sequence in (("dispute_created", "evt_disputecreated", "charge.dispute.created", 3), ("dispute_closed", "evt_disputeclosed", "charge.dispute.closed", 4)):
        event = next(row for row in rows if row["owner"] == "webhook_events" and row["stripe_event_id"] == m["local_ids"]["webhook_events"][role])
        event.update(stripe_event_id=event_id, type=event_type, processing_status="processed", livemode=False, stripe_account_id="acct_Test1", live_billing_ingest_sequence=sequence, created_at="2026-08-29T10:00:00Z")
    for role, event_id, event_type, sequence in (("connect_checkout", "evt_connect", "checkout.session.completed", 1), ("platform_subscription", "evt_platform", "customer.subscription.created", 5)):
        event = next(row for row in rows if row["owner"] == "webhook_events" and row["stripe_event_id"] == m["local_ids"]["webhook_events"][role])
        event.update(stripe_event_id=event_id, type=event_type, processing_status="processed", livemode=False, stripe_account_id=None if role == "platform_subscription" else "acct_Test1", live_billing_ingest_sequence=sequence, created_at="2026-08-29T10:00:00Z")
    core = next(row for row in rows if row["owner"] == "platform_core_rows")
    core.update(stripe_customer_id="cus_platform", stripe_subscription_id="sub_platform", status="active")
    result = []
    for index, phase in enumerate(C.PHASES):
        phase_rows = copy.deepcopy(rows)
        provider = [{"role": role, "id": spec["id"], "kind": spec["kind"], "context": spec["context"], "livemode": False} for role, spec in m["provider_objects"].items()]
        by_role = {row["role"]: row for row in provider}
        by_role["test_clock"].pop("livemode")
        by_role["account"]["metadata"] = {"studio_id": "studio_1"}
        by_role["payer_customer"]["metadata"] = {"payer_id": payer["id"]}
        by_role["price"]["product"] = "prod_1"
        by_role["initial_checkout"].update(setup_intent="seti_initial", status="complete")
        by_role["initial_setup_intent"].update(payment_method="pm_initial", status="succeeded")
        by_role["replacement_checkout"].update(setup_intent="seti_replacement", status="complete")
        by_role["replacement_setup_intent"].update(payment_method="pm_replacement", status="succeeded")
        by_role["shared_subscription_item"]["quantity"] = 2
        by_role["refund"].update(status="succeeded", amount=1000, charge="ch_auto")
        by_role["dispute"].update(status="won", charge="ch_auto", amount=10000)
        by_role["dispute_created_event"]["type"] = "charge.dispute.created"
        by_role["dispute_closed_event"]["type"] = "charge.dispute.closed"
        by_role["connect_checkout_event"]["type"] = "checkout.session.completed"
        by_role["platform_subscription_event"]["type"] = "customer.subscription.created"
        by_role["platform_customer"].update(metadata={"studio_id":"studio_1"}, created=100)
        by_role["platform_subscription"].update(metadata={"studio_id":"studio_1"}, customer="cus_platform", status="active", created=200)
        by_role["test_clock"].update(created=50, frozen_time=100 if index == 0 else 300)
        if phase == "failed_before_retry":
            by_role["automatic_invoice"]["status"] = "open"
            by_role["automatic_payment_intent"].update(status="requires_payment_method", last_payment_error_present=True)
        else:
            by_role["automatic_invoice"]["status"] = "paid"
            by_role["automatic_payment_intent"].update(status="succeeded", payment_method="pm_replacement")
            by_role["automatic_charge"]["status"] = "succeeded"
        if phase in {"final_provider_1", "final_provider_2"}:
            by_role["shared_subscription_item"]["quantity"] = 1
        for row in phase_rows:
            if row["owner"] == "invoices" and row["id"] == m["local_ids"]["invoices"]["automatic"]:
                row["status"] = "open" if phase == "failed_before_retry" else "paid"
            if row["owner"] == "payments" and row["id"] == payment["id"]:
                row["status"] = "failed" if phase == "failed_before_retry" else "succeeded"
            if phase in {"final_local_1", "final_local_2"} and row["owner"] == "invoices" and row["id"] == invoice_link["id"]:
                row["status"] = "void"
            if phase in {"final_local_1", "final_local_2"} and row["owner"] == "subscriptions" and row["id"] == m["local_ids"]["subscriptions"]["student_two"]:
                row["status"] = "canceled"
        if phase in {"final_provider_1", "final_provider_2"}:
            by_role["invoice_link"]["status"] = "void"
            by_role["shared_subscription"]["status"] = "canceled"
        result.append(C.artifact({"artifact_schema_version": 1, "phase": phase, "candidate_sha": m["candidate_sha"], "studio_id": m["studio_id"], "stripe_account_id": m["stripe_account_id"], "connect_account_generation": 1, "observed_at": f"2026-08-29T10:0{index}:00Z", "readiness": copy.deepcopy(READINESS), "manifest_ids": {"local": sorted(v for values in m["local_ids"].values() for v in values.values()), "provider": sorted(spec["id"] for spec in m["provider_objects"].values())}, "local_rows": phase_rows, "provider_objects": sorted(provider, key=lambda row: row["role"])}))
    result[4]["local_rows"] = copy.deepcopy(result[2]["local_rows"])
    result[4] = C.artifact({key: result[4][key] for key in C.ARTIFACT_BODY_KEYS})
    result[5]["provider_objects"] = copy.deepcopy(result[3]["provider_objects"])
    result[5] = C.artifact({key: result[5][key] for key in C.ARTIFACT_BODY_KEYS})
    return m, result


def assembled_chain():
    return chain()


def adapter_chain(source=None):
    m, source = chain() if source is None else source
    captures, supabase_clients, stripe_clients = [], [], []
    staff = [
        {"id":"staff1","studio_id":"studio_1","user_id":"actor_1","role":"admin","created_at":"2026-08-29T09:00:00Z","updated_at":"2026-08-29T09:00:00Z","archived_at":None},
        {"id":"staff2","studio_id":"studio_1","user_id":"actor_2","role":"front_desk","created_at":"2026-08-29T09:00:00Z","updated_at":"2026-08-29T09:00:00Z","archived_at":None},
    ]
    for index, phase in enumerate(C.PHASES):
        local_rows = source[index]["local_rows"]
        tables = {table: [{key:value for key,value in row.items() if key != "owner"} for row in local_rows if row.get("owner") == owner] for owner, (table, _) in C.TABLES.items()}
        for payer_row in tables["billing_payers"]:
            payer_row.update(display_name="Private Payer", email="private@example.invalid", phone="555-private", address_line1="Private", address_city="Private", address_state="ZZ", address_zip="00000", metadata={"private":True})
        for table_name in ("billing_plans","student_billing_enrollments","billing_invoices","billing_payments","studio_subscriptions"):
            for private_row in tables[table_name]: private_row["metadata"] = {"private":True}
        for invoice_row in tables["billing_invoices"]: invoice_row["hosted_invoice_url"] = "https://private.invalid/invoice"
        for payment_row in tables["billing_payments"]: payment_row["note"] = "private note"
        for event in tables["stripe_events"]:
            event.update(payload={"private":"must-not-emit"}, error=None, error_reference=None)
        tables["staff_roles"] = staff
        tables["audit_logs"] = [{key:value for key,value in row.items() if key != "owner"} for row in local_rows if row.get("owner") == "audit_logs"]
        supabase = FakeSupabase(tables)
        provider_rows = source[index]["provider_objects"]
        stripe = FakeStripe({row["id"]: {key:value for key,value in row.items() if key not in {"role","kind","context"}} for row in provider_rows})
        captures.append(C.capture_phase(m, phase, readiness=READINESS, local_reader=lambda boundary, client=supabase: C.collect_local(client, m, event_window_ended_at=boundary), provider_reader=lambda current, client=stripe: C.collect_provider(client, m, current), now=lambda index=index: f"2026-08-29T10:0{index}:00Z"))
        supabase_clients.append(supabase); stripe_clients.append(stripe)
    return m, captures, supabase_clients, stripe_clients


class CollectorArtifactTest(unittest.TestCase):
    def test_manifest_requires_exact_local_and_provider_roles(self):
        valid = manifest()
        self.assertEqual(set(valid["local_ids"]), set(C.LOCAL_ROLE_SCHEMA))
        self.assertEqual(set(valid["provider_objects"]), set(C.PROVIDER_ROLE_SCHEMA))
        for owner in C.LOCAL_ROLE_SCHEMA:
            with self.subTest(owner=owner, case="missing"):
                value = copy.deepcopy(valid)
                value["local_ids"][owner].pop(next(iter(value["local_ids"][owner])))
                with self.assertRaisesRegex(C.CollectorError, owner): C.validate_manifest(value)
            with self.subTest(owner=owner, case="extra"):
                value = copy.deepcopy(valid)
                value["local_ids"][owner]["arbitrary"] = f"extra_{owner}"
                with self.assertRaisesRegex(C.CollectorError, owner): C.validate_manifest(value)
        for case in ("missing", "extra"):
            with self.subTest(provider=case):
                value = copy.deepcopy(valid)
                if case == "missing": value["provider_objects"].pop("account")
                else: value["provider_objects"]["arbitrary"] = {"id": "obj_extra", "kind": "customer", "context": "connected", "phase": list(C.PHASES)}
                with self.assertRaisesRegex(C.CollectorError, "inventory"):
                    C.validate_manifest(value)

    def test_indexes_complete_strict_sources(self):
        m, values = assembled_chain()
        phases = C.validate_phase_chain(m, values)
        index = C._artifact_index(m, phases[1])
        self.assertIn("provider:account", index)
        self.assertIn("local:payers:payer", index)

    def test_projects_identity_steps_mutations_and_capabilities(self):
        m, values = chain()
        phases = C.validate_phase_chain(m, values)
        index = C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])
        validator, _ = C._load_contract()
        projected = C._project_group_one(m, index, READINESS, validator)
        self.assertEqual([row["name"] for row in projected["steps"]], list(validator.REQUIRED_STEP_ORDER))
        self.assertEqual([row["step_name"] for row in projected["mutation_attempts"]], list(validator.REQUIRED_MUTATIONS))
        self.assertEqual(projected["mutation_attempts"][-2]["actor_role"], "internal")
        self.assertEqual(projected["role_capabilities"]["instructor"], [])

    def test_projects_plan_payer_consent_subscription_and_invoices(self):
        m, values = chain()
        phases = C.validate_phase_chain(m, values)
        index = C._artifact_index(m, phases[1])
        validator, _ = C._load_contract()
        facts, setup = C._project_group_two(m, index, phases[5]["observed_at"], validator)
        self.assertEqual(facts["shared_provider_quantity"], 2)
        self.assertEqual(facts["student_ids"], ["student_1", "student_2"])
        self.assertFalse(setup["initial"]["active"])
        self.assertTrue(setup["replacement"]["active"])
        self.assertTrue(facts["invoice_link_sent"])

    def test_projects_retry_period_accounting_and_ambiguity(self):
        m, values = chain()
        phases = C.validate_phase_chain(m, values)
        index = C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])
        validator, _ = C._load_contract()
        facts, supplemental = C._project_group_three(m, phases, index, phases[5]["observed_at"], validator)
        self.assertEqual(facts["automatic_amount_cents"], 10000)
        self.assertEqual(facts["provider_application_fee_cents"], 50)
        self.assertEqual((facts["period_quantity_before"], facts["period_quantity_after"]), (2, 1))
        self.assertEqual((facts["refunded_cents"], facts["net_collected_cents"]), (1000, 9000))
        self.assertEqual(supplemental["failed_payment_retry"]["failed_provider_readback"]["invoice_status"], "open")
        self.assertEqual(set(supplemental["dispute_lifecycle"]), validator.DISPUTE_LIFECYCLE_KEYS)
        self.assertEqual(set(supplemental["refund_convergence"]), validator.REFUND_KEYS)

    def test_rejects_group_three_source_drift(self):
        cases = (
            ("refund", "refunds", "amount_cents", 999, "accounting"),
            ("dispute", "disputes", "status", "lost", "accounting"),
            ("event", "webhook_events", "processing_status", "failed", "event"),
            ("period", "transitions", "state", "due_claimed", "period"),
            ("ambiguity", "resources", "resource_id", "cus_wrong", "ambiguity"),
            ("invariant", "invoices", "amount_remaining_cents", None, "invariants"),
        )
        for label, owner, field, value, message in cases:
            with self.subTest(label=label):
                m, artifacts = chain()
                for phase_index in (2, 4):
                    for row in artifacts[phase_index]["local_rows"]:
                        if row["owner"] == owner:
                            row[field] = value
                    artifacts[phase_index] = C.artifact({key: artifacts[phase_index][key] for key in C.ARTIFACT_BODY_KEYS})
                phases = C.validate_phase_chain(m, artifacts)
                final = C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])
                validator, _ = C._load_contract()
                with self.assertRaisesRegex(C.CollectorError, message):
                    C._project_group_three(m, phases, final, phases[5]["observed_at"], validator)

    def test_projects_replay_deliveries_and_platform_fixture(self):
        m, artifacts = chain()
        phases = C.validate_phase_chain(m, artifacts)
        final = C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])
        validator, _ = C._load_contract()
        replay, deliveries, platform = C._project_group_four_deliveries(m, final, phases[5]["observed_at"], validator)
        self.assertEqual([row["role"] for row in replay["provider_replay"]["attempts"]], ["original", "manual_resend"])
        self.assertIsNone(deliveries["platform"]["stripe_account_id"])
        self.assertEqual(deliveries["connect"]["stripe_account_id"], "acct_Test1")
        self.assertTrue(platform["customer_preexisted"])
        self.assertEqual(platform["cleanup_timing"], "after_evidence_validation")

    def test_projects_void_immediate_external_and_unsupported(self):
        m, artifacts = chain()
        phases = C.validate_phase_chain(m, artifacts)
        final = C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])
        validator, _ = C._load_contract()
        rows = C._project_group_four_local(m, final, phases[4]["local_rows"], phases[5]["observed_at"], validator)
        self.assertEqual(rows["invoice_void"]["provider_readback"]["status"], "void")
        self.assertEqual(rows["immediate_cancellation"]["local_readback"]["enrollment_status"], "canceled")
        self.assertEqual(rows["external_payment"]["audit_count"], 1)
        self.assertEqual(len(rows["unsupported_operations"]), 4)

    def test_assembles_validator_clean_packet_without_template(self):
        m, artifacts = chain()
        packet = C.assemble(m, artifacts)
        self.assertEqual(packet["schema_version"], 4)
        self.assertTrue(all(row["count"] == 0 for row in packet["terminal_counts"]["counts"].values()))

    def test_rejects_each_nonzero_terminal_count(self):
        def local(owner, **changes):
            def mutate(m, values):
                for phase in (2, 4):
                    row = next(row for row in values[phase]["local_rows"] if row["owner"] == owner)
                    row.update(changes)
                    values[phase] = C.artifact({key: values[phase][key] for key in C.ARTIFACT_BODY_KEYS})
            return mutate

        def provider(**changes):
            def mutate(m, values):
                for phase in (3, 5):
                    values[phase]["provider_objects"][0].update(changes)
                    values[phase] = C.artifact({key: values[phase][key] for key in C.ARTIFACT_BODY_KEYS})
            return mutate

        cases = {
            "failed": local("operations", state="definitive_failed"),
            "stuck": local("operations", state="provider_request_in_flight", lease_expires_at="2026-08-29T09:00:00Z"),
            "unmapped": local("webhook_events", processing_status="unmapped"),
            "wrong_mode": provider(livemode=True),
            "wrong_generation": local("payments", connect_account_generation=2),
            "pending_transition": local("transitions", state="due_claimed"),
            "reconciliation_required": local("refunds", reconciliation_required=True),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                m, values = assembled_chain()
                mutate(m, values)
                phases = C.validate_phase_chain(m, values)
                validator, _ = C._load_contract()
                counts = C._terminal_counts(m, phases[4]["local_rows"], phases[5]["provider_objects"], phases[5]["observed_at"], validator)
                self.assertGreater(counts["counts"][name]["count"], 0)
                with self.assertRaisesRegex(C.CollectorError, f"terminal count {name} must be zero"):
                    C.assemble(m, values)

    def test_rejects_missing_extra_duplicate_and_wrong_source_classes(self):
        for label, mutate in (
            ("missing", lambda rows: rows.pop(0)),
            ("extra", lambda rows: rows.append({"owner": "operations", "id": "unlisted"})),
            ("duplicate", lambda rows: rows.append(copy.deepcopy(rows[0]))),
            ("owner", lambda rows: rows[0].update(owner="payments")),
        ):
            with self.subTest(label=label):
                m, values = assembled_chain()
                for phase in (2, 4):
                    mutate(values[phase]["local_rows"])
                    values[phase] = C.artifact({key: values[phase][key] for key in C.ARTIFACT_BODY_KEYS})
                phases = C.validate_phase_chain(m, values)
                with self.assertRaisesRegex(C.CollectorError, "source"):
                    C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])

    def test_cli_assembles_canonical_private_output_and_rejects_repo_output(self):
        m, artifacts = chain()
        packet = C.assemble(m, artifacts)
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            manifest_path = base / "manifest.json"
            manifest_path.write_text(json.dumps(m))
            artifact_paths = []
            for index, artifact in enumerate(artifacts):
                path = base / f"phase-{index}.json"
                path.write_text(json.dumps(artifact))
                artifact_paths.append(str(path))
            output = base / "evidence.json"
            output.write_text("old")
            output.chmod(0o644)
            args = ["--manifest", str(manifest_path), "--assemble", *artifact_paths, "--output", str(output)]
            self.assertEqual(C.main(args), 0)
            self.assertEqual(output.read_text(), C.canonical(packet).decode() + "\n")
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(C.main([*args[:-1], str(C.ROOT / "forbidden-evidence.json")]), 1)

    def test_cli_sanitizes_unexpected_adapter_failures(self):
        m, artifacts = chain()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); manifest_path = base / "manifest.json"
            manifest_path.write_text(json.dumps(m)); paths = []
            for index, artifact in enumerate(artifacts):
                path = base / f"phase-{index}.json"; path.write_text(json.dumps(artifact)); paths.append(str(path))
            stderr = io.StringIO()
            with mock.patch.object(C, "assemble", side_effect=RuntimeError("PRIVATE_VALUE raw payload")), contextlib.redirect_stderr(stderr):
                self.assertEqual(C.main(["--manifest", str(manifest_path), "--assemble", *paths]), 1)
            self.assertEqual(stderr.getvalue(), "collector refused: sanitized adapter failure\n")

    def test_live_adapters_capture_and_assemble_without_mutations(self):
        m, captures, supabase_clients, stripe_clients = adapter_chain()
        packet = C.assemble(m, captures)
        validator, _ = C._load_contract()
        self.assertEqual(validator.validate_evidence(packet, m["candidate_sha"], m["readiness_origin"]), [])
        self.assertTrue(all(row["count"] == 0 for row in packet["terminal_counts"]["counts"].values()))
        self.assertEqual(packet["workflow_facts"]["period_quantity_after"], 1)
        self.assertEqual(packet["supplemental_evidence"]["ambiguity_recovery"]["provider_mutation_count"], 1)
        expected_tables = set(table for table, _ in C.TABLES.values()) | {"staff_roles", "audit_logs"}
        for client in supabase_clients:
            self.assertEqual(set(client.calls), expected_tables)
            self.assertEqual(client.ranges, [("keyset", ("2026-08-29T10:00:00Z", 3)), ("keyset", ("2026-08-29T10:00:00Z", 3))])
            self.assertTrue(all(columns != "*" for _table, columns in client.selections))
            for owner, (table, _id_column) in C.TABLES.items():
                expected = C.EVENT_SAFE_PROJECTION if owner == "webhook_events" else C.LOCAL_PROJECTION[owner]
                self.assertIn((table, expected), client.selections)
            audit_selects = [columns for table, columns in client.selections if table == "audit_logs"]
            self.assertTrue(audit_selects and all(columns == C.AUDIT_PROJECTION for columns in audit_selects))
            for table, columns in client.selections:
                if table != "audit_logs":
                    self.assertFalse(any(private in columns.split(",") for private in ("display_name","email","phone","address_line1","address_city","address_state","address_zip","metadata","payload","error","error_reference","hosted_invoice_url","note")))
        for client in stripe_clients:
            self.assertEqual(len(client.calls), len(C.PROVIDER_ROLE_SCHEMA))
            for _owner, identifier, kwargs in client.calls:
                role = next(role for role, spec in m["provider_objects"].items() if spec["id"] == identifier)
                self.assertEqual(kwargs, {"stripe_account": "acct_Test1"} if m["provider_objects"][role]["context"] == "connected" else {})
        self.assertTrue(all("studio_id" not in row for row in captures[4]["local_rows"] if row["owner"] == "webhook_events"))
        payer_row = next(row for row in captures[4]["local_rows"] if row["owner"] == "payers")
        self.assertFalse(set(payer_row) & {"display_name","email","phone","address_line1","address_city","address_state","address_zip","metadata"})
        self.assertEqual(packet["supplemental_evidence"]["external_payment"]["audit_count"], 1)
        self.assertTrue(all(artifact["readiness"] == READINESS for artifact in captures))
        self.assertEqual(packet["health_commit_sha"], READINESS["commit_sha"])

    def test_live_adapter_state_drift_is_refused(self):
        m, source = chain()
        for phase_index in (2, 4):
            operation = next(row for row in source[phase_index]["local_rows"] if row.get("owner") == "operations")
            operation.update(state="definitive_failed", definitive_failed_at="2026-08-29T10:04:00Z", error_code="declined")
        m, captures, _, _ = adapter_chain((m, source))
        with self.assertRaisesRegex(C.CollectorError, "terminal count failed must be zero"):
            C.assemble(m, captures)

    def test_connect_event_window_and_real_failure_semantics(self):
        m, _captures, clients, _ = adapter_chain()
        wrong_account = copy.deepcopy(clients[4])
        event = next(row for row in wrong_account.tables["stripe_events"] if row["stripe_event_id"] == "evt_connect")
        event["stripe_account_id"] = "acct_Wrong"
        with self.assertRaisesRegex(C.CollectorError, "Connect webhook event window"):
            C.collect_local(wrong_account, m, event_window_ended_at="2026-08-29T10:04:00Z")
        extra = copy.deepcopy(clients[4])
        extra.tables["stripe_events"].append({"id":"extra","stripe_event_id":"evt_extra","stripe_account_id":"acct_Test1","type":"invoice.paid","processing_status":"processed","livemode":False,"created_at":"2026-08-29T10:01:00Z","live_billing_ingest_sequence":5,"payload":{},"error":None,"error_reference":None})
        with self.assertRaisesRegex(C.CollectorError, "Connect webhook event window"):
            C.collect_local(extra, m, event_window_ended_at="2026-08-29T10:04:00Z")
        duplicate = copy.deepcopy(clients[4])
        duplicate.tables["stripe_events"].append(copy.deepcopy(next(row for row in duplicate.tables["stripe_events"] if row["stripe_event_id"] == "evt_connect")))
        with self.assertRaisesRegex(C.CollectorError, "webhook_events exact-ID"):
            C.collect_local(duplicate, m, event_window_ended_at="2026-08-29T10:04:00Z")
        m, artifacts = chain()
        for phase in (2, 4):
            event = next(row for row in artifacts[phase]["local_rows"] if row.get("stripe_event_id") == "evt_connect")
            event.update(processing_status="failed", error="handler_failed")
            artifacts[phase] = C.artifact({key: artifacts[phase][key] for key in C.ARTIFACT_BODY_KEYS})
        with self.assertRaisesRegex(C.CollectorError, "terminal count unmapped must be zero"):
            C.assemble(m, artifacts)

    def test_readiness_is_required_hash_bound_and_source_derived(self):
        m, artifacts = chain()
        with self.assertRaisesRegex(C.CollectorError, "capture readiness"):
            C.capture_phase(m, C.PHASES[0], readiness={**READINESS, "commit_sha":"0" * 40}, local_reader=lambda _boundary: [], provider_reader=lambda _phase: [])
        tampered = copy.deepcopy(artifacts); tampered[0]["readiness"]["commit_sha"] = "0" * 40
        with self.assertRaisesRegex(C.CollectorError, "hash mismatch"):
            C.validate_phase_chain(m, tampered)
        rebound = copy.deepcopy(artifacts)
        rebound[0]["readiness"]["commit_sha"] = "0" * 40
        rebound[0] = C.artifact({key: rebound[0][key] for key in C.ARTIFACT_BODY_KEYS})
        with self.assertRaisesRegex(C.CollectorError, "readiness"):
            C.validate_phase_chain(m, rebound)
        missing = copy.deepcopy(artifacts); missing[0].pop("readiness")
        with self.assertRaisesRegex(C.CollectorError, "fields are not exact"):
            C.validate_phase_chain(m, missing)

    def test_event_projection_excludes_payload_and_raw_errors(self):
        m, _captures, clients, _ = adapter_chain()
        client = copy.deepcopy(clients[4])
        event = next(row for row in client.tables["stripe_events"] if row["stripe_event_id"] == "evt_connect")
        event.update(payload={"secret":"never-emit"}, error="private handler detail", error_reference="a" * 32)
        captured = C.collect_local(client, m, event_window_ended_at="2026-08-29T10:04:00Z")
        emitted = next(row for row in captured if row.get("stripe_event_id") == "evt_connect")
        self.assertNotIn("payload", emitted); self.assertNotIn("error", emitted); self.assertNotIn("error_reference", emitted)
        self.assertTrue(emitted["error_present"]); self.assertTrue(emitted["error_reference_present"])

    def test_keyset_pagination_is_stable_across_concurrent_boundary_inserts(self):
        rows = [
            {"stripe_event_id":f"evt_{sequence}","stripe_account_id":"acct_Test1","created_at":"2026-08-29T10:00:00Z","live_billing_ingest_sequence":sequence}
            for sequence in (1, 2, 3)
        ]
        inserted = False
        def make_query(cursor):
            nonlocal inserted
            if cursor is not None and not inserted:
                rows.append({"stripe_event_id":"evt_4","stripe_account_id":"acct_Test1","created_at":"2026-08-29T10:00:00Z","live_billing_ingest_sequence":4}); inserted = True
            query = FakeQuery(rows).eq("stripe_account_id", "acct_Test1").gte("created_at", "2026-08-29T10:00:00Z").lte("created_at", "2026-08-29T10:04:00Z").order("created_at").order("live_billing_ingest_sequence")
            if cursor: query.or_(f"created_at.gt.{cursor[0]},and(created_at.eq.{cursor[0]},live_billing_ingest_sequence.gt.{cursor[1]})")
            return query
        observed = C._rows_paginated(make_query, label="concurrent event window")
        self.assertEqual([row["stripe_event_id"] for row in observed], ["evt_1", "evt_2", "evt_3", "evt_4"])
        duplicate = copy.deepcopy(rows); duplicate.append(copy.deepcopy(rows[-1]))
        with self.assertRaisesRegex(C.CollectorError, "keyset order"):
            C._rows_paginated(lambda _cursor: FakeQuery(duplicate).order("created_at").order("live_billing_ingest_sequence"), label="duplicate event window")

    def test_second_enumeration_catches_late_event_behind_first_cursor(self):
        m, _captures, clients, _ = adapter_chain()
        late = {"id":"late","stripe_event_id":"evt_late","stripe_account_id":"acct_Test1","type":"invoice.paid","processing_status":"processed","livemode":False,"created_at":"2026-08-29T10:00:00Z","live_billing_ingest_sequence":2,"payload":{},"error":None,"error_reference":None}
        client = FakeSupabase(copy.deepcopy(clients[4].tables), late_event=late)
        with self.assertRaisesRegex(C.CollectorError, "enumerations are unstable"):
            C.collect_local(client, m, event_window_ended_at="2026-08-29T10:04:00Z")

    def test_each_proof_step_requires_its_projected_predicate(self):
        m, artifacts = chain(); validator, _ = C._load_contract()
        mutations = {
            "health_exact_candidate": lambda p: p.update(health_commit_sha="0" * 40),
            "operation_bounded_role_capabilities": lambda p: p["role_capabilities"].update(instructor=["bad"]),
            "plan_product_price": lambda p: p["workflow_facts"].update(product_id=None),
            "payer_customer": lambda p: p["workflow_facts"].update(payer_id=None),
            "payer_consent_duplicate_replay": lambda p: p["supplemental_evidence"]["payer_setup_lifecycle"]["replacement"].update(active=False),
            "shared_subscription_quantity_two": lambda p: p["workflow_facts"].update(shared_provider_quantity=1),
            "invoice_link_finalize_send": lambda p: p["workflow_facts"].update(invoice_link_sent=False),
            "automatic_payment_fee_50bps": lambda p: p["workflow_facts"].update(automatic_amount_cents=9999),
            "failed_payment_named_retry": lambda p: p["supplemental_evidence"]["failed_payment_retry"]["failed_provider_readback"].update(invoice_status="paid"),
            "period_end_schedule_revoke_due": lambda p: p["workflow_facts"].update(period_due_state="pending"),
            "refund_dispute_convergence": lambda p: p["workflow_facts"].update(net_collected_cents=1),
            "ambiguous_same_key_readback_recovery": lambda p: p["workflow_facts"].update(ambiguous_recovery_outcome="failed"),
            "platform_webhook_delivery_readback": lambda p: p["webhook_delivery_evidence"]["platform"].update(local_processing_status="failed"),
            "connect_webhook_delivery_readback": lambda p: p["webhook_delivery_evidence"]["connect"].update(local_processing_status="failed"),
            "terminal_zero_counts": lambda p: p["terminal_counts"]["counts"]["failed"].update(count=1),
        }
        packet = C.assemble(m, artifacts)
        for name in validator.REQUIRED_STEP_ORDER:
            with self.subTest(name=name):
                changed = copy.deepcopy(packet); mutations[name](changed)
                with self.assertRaisesRegex(C.CollectorError, name): C._proof_steps(changed, validator)

    def test_shared_parents_keep_distinct_exact_steps(self):
        m, artifacts = chain()
        self.assertEqual(m["local_ids"]["operations"]["plan_product_create"], m["local_ids"]["operations"]["plan_price_create"])
        self.assertNotEqual(m["local_ids"]["steps"]["plan_product_create"], m["local_ids"]["steps"]["plan_price_create"])
        for label, mutate, message in (
            ("wrong_parent", lambda rows: next(row for row in rows if row.get("owner") == "steps" and row.get("id") == m["local_ids"]["steps"]["plan_price_create"]).update(operation_id="wrong"), "parent"),
            ("duplicate_operation", lambda rows: next(row for row in rows if row.get("owner") == "steps" and row.get("id") == m["local_ids"]["steps"]["plan_price_create"]).update(provider_operation="connected_product.create"), "provider state"),
        ):
            with self.subTest(label=label):
                changed = copy.deepcopy(artifacts)
                for phase in (2, 4): mutate(changed[phase]["local_rows"]); changed[phase] = C.artifact({key: changed[phase][key] for key in C.ARTIFACT_BODY_KEYS})
                phases = C.validate_phase_chain(m, changed); index = C._source_index(m, phases[4]["local_rows"], phases[5]["provider_objects"])
                validator, _ = C._load_contract()
                with self.assertRaisesRegex(C.CollectorError, message): C._project_group_one(m, index, READINESS, validator)

    def test_test_clock_mode_is_kind_and_context_guarded_without_livemode(self):
        m, artifacts = chain()
        clock = next(row for row in artifacts[5]["provider_objects"] if row["role"] == "test_clock")
        self.assertNotIn("livemode", clock)
        normalized = C.normalize_provider({"id":"clock_1","created":300}, kind="test_clock", context="connected")
        self.assertNotIn("livemode", normalized)
        for field, value in (("kind", "customer"), ("context", "platform")):
            with self.subTest(field=field):
                changed = copy.deepcopy(m); changed["provider_objects"]["test_clock"][field] = value
                with self.assertRaisesRegex(C.CollectorError, "provider object test_clock"):
                    C.validate_manifest(changed)

    def test_counted_owner_window_rejects_extra_and_missing_rows(self):
        m, _captures, clients, _ = adapter_chain()
        for label, mutate in (
            ("extra", lambda rows: rows.append({**copy.deepcopy(rows[0]), "id":"extra-payment"})),
            ("missing", lambda rows: rows.pop()),
        ):
            with self.subTest(label=label):
                client = copy.deepcopy(clients[4]); mutate(client.tables["billing_payments"])
                with self.assertRaisesRegex(C.CollectorError, "payments"):
                    C.collect_local(client, m, event_window_ended_at="2026-08-29T10:04:00Z")
    def test_accepts_hash_bound_stable_phase_chain(self):
        m, values = chain()
        self.assertEqual(len(C.validate_phase_chain(m, values)), 6)

    def test_rejects_hash_fact_context_order_and_missing_phase(self):
        for mutate, message in (
            (lambda rows: rows[0].update({"sha256": "0" * 64}), "hash"),
            (lambda rows: rows[0].update({"studio_id": "other"}), "hash"),
            (lambda rows: rows.reverse(), "out of order"),
            (lambda rows: rows.pop(), "missing or out of order"),
        ):
            with self.subTest(message=message):
                m, values = chain()
                mutate(values)
                with self.assertRaisesRegex(C.CollectorError, message):
                    C.validate_phase_chain(m, values)

    def test_rejects_unstable_final_rereads(self):
        m, values = chain()
        values[4]["local_rows"][0]["status"] = "changed"
        values[4] = C.artifact({key: values[4][key] for key in C.ARTIFACT_BODY_KEYS})
        with self.assertRaisesRegex(C.CollectorError, "local reread changed"):
            C.validate_phase_chain(m, values)

    def test_live_guard_requires_explicit_exact_staging_test_context(self):
        m = manifest()
        with self.assertRaisesRegex(C.CollectorError, "--collect-read-only"):
            C.validate_live_context(m, collect_read_only=False, environment={})
        with self.assertRaisesRegex(C.CollectorError, "staging"):
            C.validate_live_context(m, collect_read_only=True, environment={})


if __name__ == "__main__":
    unittest.main()
