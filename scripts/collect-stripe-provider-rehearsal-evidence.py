#!/usr/bin/env python3
"""Read-only Stripe test-provider rehearsal evidence collector.

The script has two data products. Capture-phase artifacts preserve transient raw
readbacks that Stripe later overwrites. Final assembly verifies those artifacts and
paired current-state rereads before producing evidence. Local capture uses one
read-only evidence RPC per phase. No code path performs a Stripe mutation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, Callable, Mapping


ROOT = Path(__file__).resolve().parents[1]
STAGING_SUPABASE_URL = "https://nxgsektqsgrtyfhawxbc.supabase.co"
ARTIFACT_VERSION = 1
MANIFEST_VERSION = 1
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
PHASES = ("failed_before_retry", "paid_after_retry", "final_local_1", "final_provider_1", "final_local_2", "final_provider_2")
TABLES = {
    "operations": ("billing_provider_operations", "id"),
    "steps": ("billing_provider_operation_steps", "id"),
    "resources": ("billing_provider_operation_resources", "id"),
    "setup_requests": ("billing_payer_setup_requests", "id"),
    "consents": ("billing_payer_payment_consents", "id"),
    "payers": ("billing_payers", "id"),
    "plans": ("billing_plans", "id"),
    "subscriptions": ("student_billing_enrollments", "id"),
    "invoices": ("billing_invoices", "id"),
    "payments": ("billing_payments", "id"),
    "refunds": ("billing_refunds", "id"),
    "disputes": ("billing_disputes", "id"),
    "transitions": ("billing_enrollment_transition_intents", "id"),
    "webhook_events": ("stripe_events", "stripe_event_id"),
    "platform_core_rows": ("studio_subscriptions", "studio_id"),
}
LOCAL_EVIDENCE_RPC = "read_stripe_rehearsal_local_evidence_v1"
LOCAL_EVIDENCE_RPC_VERSION = 1
LOCAL_EVIDENCE_RESPONSE_KEYS = {"schema_version", "studio_id", "stripe_account_id", "connect_account_generation", "rehearsal_started_at", "event_window_ended_at", "local_id_bindings", "local_rows"}
LOCAL_EVIDENCE_RPC_PARAM_KEYS = {"p_studio_id", "p_stripe_account_id", "p_connect_account_generation", "p_rehearsal_started_at", "p_event_window_ended_at", "p_local_ids", "p_actor_ids", "p_external_audit_id", "p_connect_event_ids", "p_platform_event_ids"}
MUTATION_ROLES = {
    "payer_customer_create", "payer_initial_setup_checkout", "payer_replacement_setup_checkout",
    "plan_product_create", "plan_price_create", "enrollment_subscription_create",
    "enrollment_shared_quantity_update", "invoice_link_invoice_create", "invoice_link_item_create",
    "invoice_link_finalize", "invoice_link_send", "automatic_invoice_create",
    "automatic_item_create", "automatic_finalize", "invoice_retry_pay",
    "period_end_revoke_schedule_create", "period_end_revoke_schedule_update",
    "period_end_revoke_release", "period_end_due_schedule_create",
    "period_end_due_schedule_update", "period_end_due_release", "payment_refund",
}
LOCAL_ROLE_SCHEMA = {
    "operations": MUTATION_ROLES | {"invoice_void", "immediate_cancellation", "ambiguity_parent"},
    "steps": MUTATION_ROLES - {"payer_customer_create"},
    "resources": {"ambiguity_customer"},
    "setup_requests": {"initial", "replacement"},
    "consents": {"initial", "replacement"},
    "payers": {"payer"}, "plans": {"plan"},
    "subscriptions": {"student_one", "student_two"},
    "invoices": {"invoice_link", "automatic"},
    "payments": {"automatic", "payments.external"},
    "refunds": {"refund"}, "disputes": {"dispute"},
    "transitions": {"schedule", "revoke", "due", "immediate"},
    "webhook_events": {"connect_checkout", "dispute_created", "dispute_closed", "platform_subscription"},
    "platform_core_rows": {"platform_subscription"},
}
PROVIDER_ROLE_SCHEMA = {
    "account": ("account", "platform"), "payer_customer": ("customer", "connected"),
    "initial_checkout": ("checkout_session", "connected"),
    "initial_setup_intent": ("setup_intent", "connected"),
    "replacement_checkout": ("checkout_session", "connected"),
    "replacement_setup_intent": ("setup_intent", "connected"),
    "product": ("product", "connected"), "price": ("price", "connected"),
    "shared_subscription": ("subscription", "connected"),
    "shared_subscription_item": ("subscription_item", "connected"),
    "invoice_link": ("invoice", "connected"), "automatic_invoice": ("invoice", "connected"),
    "automatic_payment_intent": ("payment_intent", "connected"),
    "automatic_charge": ("charge", "connected"),
    "revoke_schedule": ("subscription_schedule", "connected"),
    "due_schedule": ("subscription_schedule", "connected"),
    "refund": ("refund", "connected"), "dispute": ("dispute", "connected"),
    "test_clock": ("test_clock", "connected"),
    "platform_customer": ("customer", "platform"),
    "platform_subscription": ("subscription", "platform"),
    "connect_checkout_event": ("event", "connected"),
    "dispute_created_event": ("event", "connected"),
    "dispute_closed_event": ("event", "connected"),
    "platform_subscription_event": ("event", "platform"),
}
MUTATION_SOURCE_ROLES = {
    "payer.customer_create": "payer_customer_create",
    "payer.initial_setup_checkout": "payer_initial_setup_checkout",
    "payer.replacement_setup_checkout": "payer_replacement_setup_checkout",
    "plan.product_create": "plan_product_create", "plan.price_create": "plan_price_create",
    "enrollment.subscription_create": "enrollment_subscription_create",
    "enrollment.shared_quantity_update": "enrollment_shared_quantity_update",
    "invoice_link.invoice_create": "invoice_link_invoice_create",
    "invoice_link.item_create": "invoice_link_item_create",
    "invoice_link.finalize": "invoice_link_finalize", "invoice_link.send": "invoice_link_send",
    "automatic.invoice_create": "automatic_invoice_create", "automatic.item_create": "automatic_item_create",
    "automatic.finalize": "automatic_finalize", "invoice_retry.pay": "invoice_retry_pay",
    "period_end.revoke_schedule_create": "period_end_revoke_schedule_create",
    "period_end.revoke_schedule_update": "period_end_revoke_schedule_update",
    "period_end.revoke_release": "period_end_revoke_release",
    "period_end.due_schedule_create": "period_end_due_schedule_create",
    "period_end.due_schedule_update": "period_end_due_schedule_update",
    "period_end.due_release": "period_end_due_release", "payment.refund": "payment_refund",
}
PARENT_OPERATION_TYPES = {
    "enrollment.activate": "enrollment.activate.autopay",
}
PROVIDER_RETRIEVERS = {
    "account": ("Account", "retrieve"),
    "customer": ("Customer", "retrieve"),
    "checkout_session": ("checkout.Session", "retrieve"),
    "setup_intent": ("SetupIntent", "retrieve"),
    "product": ("Product", "retrieve"),
    "price": ("Price", "retrieve"),
    "subscription": ("Subscription", "retrieve"),
    "subscription_item": ("SubscriptionItem", "retrieve"),
    "subscription_schedule": ("SubscriptionSchedule", "retrieve"),
    "invoice": ("Invoice", "retrieve"),
    "payment_intent": ("PaymentIntent", "retrieve"),
    "charge": ("Charge", "retrieve"),
    "refund": ("Refund", "retrieve"),
    "dispute": ("Dispute", "retrieve"),
    "test_clock": ("test_helpers.TestClock", "retrieve"),
    "event": ("Event", "retrieve"),
}
MANIFEST_KEYS = {"manifest_schema_version", "candidate_sha", "readiness_origin", "studio_id", "stripe_account_id", "connect_account_generation", "rehearsal_started_at", "local_ids", "provider_objects", "actor_bindings", "external_payment_audit_ids", "workbench_delivery_attempts", "workbench_bootstrap_request_logs"}
PROVIDER_SPEC_KEYS = {"id", "kind", "context", "phase"}
READINESS_KEYS = {"status", "environment", "commit_sha", "configured_stripe_mode"}
ARTIFACT_BODY_KEYS = {"artifact_schema_version", "phase", "candidate_sha", "studio_id", "stripe_account_id", "connect_account_generation", "observed_at", "readiness", "manifest_ids", "local_rows", "provider_objects"}
ARTIFACT_KEYS = ARTIFACT_BODY_KEYS | {"sha256"}
FORBIDDEN_KEYS = {"email", "name", "address", "card", "client_secret", "secret", "payload", "raw_payload", "checkout_url", "url"}
BOOTSTRAP_LOG_OPERATIONS = {"connect_account.create", "connect_onboarding_link.create"}
BOOTSTRAP_INVENTORY_KEYS = {"query_started_at", "query_ended_at", "filters", "pages", "total_matching_count"}
BOOTSTRAP_FILTER_KEYS = {"operation", "method", "test_mode"}
BOOTSTRAP_PAGE_KEYS = {"cursor", "next_cursor", "has_more", "entries"}
BOOTSTRAP_ENTRY_KEYS = {"request_id", "operation", "provider_created_at", "method", "path", "http_status", "test_mode", "idempotency_key_sha256", "caller_input_sha256", "request_facts", "response_facts"}
ACCOUNT_REQUEST_KEYS = {"studio_id", "connect_account_generation"}
ACCOUNT_RESPONSE_KEYS = {"object", "account_id", "metadata_studio_id"}
LINK_REQUEST_KEYS = {"account_id", "studio_id"}
LINK_RESPONSE_KEYS = {"object", "account_id", "expires_at", "single_use"}
CONNECT_PATHS = {
    "connect_account.create": {"/v2/core/accounts", "/v1/accounts"},
    "connect_onboarding_link.create": {"/v2/core/account_links", "/v1/account_links"},
}
DELIVERY_ATTEMPT_KEYS = {"attempt_id", "role", "surface", "event_id", "event_type", "checkout_session_id", "endpoint_url", "delivery_status", "http_status", "delivered_at"}
LOCAL_ALLOWED = {
    "id", "stripe_event_id", "studio_id", "student_id", "actor_id", "user_id", "initiated_by", "payer_id", "plan_id", "billing_plan_id", "billing_subscription_id", "setup_request_id", "consent_id", "invoice_id", "payment_id", "operation_id", "provider_operation_id", "source_intent_id", "parent_operation_id", "step_id", "resource_id", "workflow_id", "operation", "operation_type", "transition_kind", "provider_operation", "step_name", "step_order", "resource_type", "resource_key", "actor_role", "role", "status", "state", "processing_status", "state_category", "scope", "stripe_account_id", "stripe_connected_account_id", "connect_account_generation", "livemode", "revision", "request_sha256", "provider_request_sha256", "caller_request_key_sha256", "automatic_retry_count", "provider_mutation_count", "provider_request_attempt_count", "reconciliation_required", "reconciliation_required_at", "reconciliation_reason_code", "definitive_failed_at", "definitive_rejected_at", "error_code", "lease_expires_at", "created_at", "updated_at", "archived_at", "processed_at", "completed_at", "accepted_at", "superseded_at", "revoked_at", "finalized_at", "sent_at", "scheduled_at", "due_claimed_at", "period_boundary", "provider_succeeded_at", "projected_at", "amount", "amount_cents", "currency", "external_method", "application_fee_cents", "application_fee_amount_cents", "gross_paid_cents", "refunded_cents", "disputed_cents", "disputed_amount_cents", "net_collected_cents", "net_collected_amount_cents", "refundable_remaining_cents", "refundable_amount_cents", "expected_quantity", "expected_subscription_item_count", "same_item_active_count", "provider_quantity", "mutation_strategy", "stripe_customer_id", "stripe_product_id", "stripe_price_id", "stripe_subscription_id", "stripe_subscription_item_id", "stripe_subscription_schedule_id", "provider_object_id", "provider_secondary_object_id", "stripe_invoice_id", "stripe_payment_intent_id", "stripe_charge_id", "stripe_refund_id", "stripe_dispute_id", "stripe_checkout_session_id", "stripe_setup_intent_id", "stripe_payment_method_id", "checkout_session_id", "setup_intent_id", "payment_method_id", "terms_version", "active", "initiator", "type", "action", "entity_type", "entity_id",
    "billing_status", "amount_remaining_cents", "enrollment_id", "recovery_outcome", "adjustment_reconciliation_required", "error_present", "error_reference_present",
}
PROVIDER_ALLOWED = {"id", "object", "livemode", "status", "created", "frozen_time", "customer", "subscription", "subscription_item", "setup_intent", "payment_method", "payment_intent", "latest_charge", "charge", "invoice", "refund", "amount", "amount_refunded", "application_fee_amount", "quantity", "product", "price", "test_clock", "account", "type", "metadata", "last_payment_error", "canceled_at", "ended_at", "released_at"}
METADATA_ALLOWED = {"studio_id", "connect_account_generation", "payer_id", "plan_id", "payment_id", "invoice_id", "operation_id"}


class CollectorError(RuntimeError):
    pass


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_instant(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo is not None else None


def _same_instant(left: str, right: str) -> bool:
    """Compare RFC 3339 instants across JSON timestamp renderings."""
    left_value = _parse_instant(left)
    right_value = _parse_instant(right)
    return left_value is not None and right_value is not None and left_value == right_value


def _at_or_after(left: str, right: str) -> bool:
    left_value = _parse_instant(left)
    right_value = _parse_instant(right)
    return left_value is not None and right_value is not None and left_value >= right_value


def exact(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise CollectorError(f"{label} fields are not exact")
    return value


def validate_manifest(value: Any) -> dict[str, Any]:
    manifest = exact(value, MANIFEST_KEYS, "manifest")
    if manifest["manifest_schema_version"] != MANIFEST_VERSION or not SHA_RE.fullmatch(str(manifest["candidate_sha"])):
        raise CollectorError("manifest version or candidate SHA is invalid")
    if not str(manifest["readiness_origin"]).startswith("https://") or not RFC3339_RE.fullmatch(str(manifest["rehearsal_started_at"])):
        raise CollectorError("manifest readiness origin or rehearsal start is invalid")
    if not isinstance(manifest["studio_id"], str) or not re.fullmatch(r"acct_[A-Za-z0-9]+", str(manifest["stripe_account_id"])) or type(manifest["connect_account_generation"]) is not int or manifest["connect_account_generation"] < 1:
        raise CollectorError("manifest studio, account, or generation is invalid")
    local_ids = exact(manifest["local_ids"], set(TABLES), "local ID inventory")
    for owner, role_map in local_ids.items():
        duplicates = len(set(role_map.values())) != len(role_map) if isinstance(role_map, dict) else True
        if not isinstance(role_map, dict) or set(role_map) != LOCAL_ROLE_SCHEMA[owner] or any(not isinstance(identifier, str) or not identifier for identifier in role_map.values()) or (owner != "operations" and duplicates):
            raise CollectorError(f"local ID inventory {owner} is incomplete or duplicated")
    specs = manifest["provider_objects"]
    if not isinstance(specs, dict) or set(specs) != set(PROVIDER_ROLE_SCHEMA):
        raise CollectorError("provider object inventory is required")
    seen: set[str] = set()
    for role, spec in specs.items():
        spec = exact(spec, PROVIDER_SPEC_KEYS, f"provider object {role}")
        phases = spec["phase"]
        if (spec["kind"], spec["context"]) != PROVIDER_ROLE_SCHEMA[role] or not isinstance(phases, list) or not phases or any(phase not in PHASES for phase in phases) or len(phases) != len(set(phases)) or not isinstance(spec["id"], str) or spec["id"] in seen:
            raise CollectorError(f"provider object {role} has invalid kind, context, phase, or duplicate ID")
        seen.add(spec["id"])
    attempts = manifest["workbench_delivery_attempts"]
    if not isinstance(attempts, list) or len(attempts) != 3:
        raise CollectorError("typed Workbench delivery attempts are required")
    seen_attempts: set[str] = set()
    roles = []
    for raw in attempts:
        row = exact(raw, DELIVERY_ATTEMPT_KEYS, "Workbench delivery attempt")
        if row["attempt_id"] in seen_attempts or row["surface"] not in {"platform", "connect"} or row["delivery_status"] != "delivered" or type(row["http_status"]) is not int or not 200 <= row["http_status"] < 300 or not RFC3339_RE.fullmatch(str(row["delivered_at"])):
            raise CollectorError("Workbench delivery attempt is duplicated or unsuccessful")
        seen_attempts.add(row["attempt_id"]); roles.append((row["surface"], row["role"]))
    if roles != [("connect", "original"), ("connect", "manual_resend"), ("platform", "original")] or attempts[0]["delivered_at"] >= attempts[1]["delivered_at"]:
        raise CollectorError("Workbench delivery attempts lack exact ordered Connect replay and platform delivery")
    bindings = manifest["actor_bindings"]
    if not isinstance(bindings, dict) or not bindings or any(not isinstance(actor_id, str) or role not in {"admin", "front_desk", "instructor", "internal"} for actor_id, role in bindings.items()):
        raise CollectorError("manifest actor bindings are invalid")
    audit_ids = manifest["external_payment_audit_ids"]
    if not isinstance(audit_ids, list) or len(audit_ids) != 1 or not isinstance(audit_ids[0], str):
        raise CollectorError("manifest must contain one exact external-payment audit ID")
    _validate_bootstrap_logs(manifest)
    return manifest


def _digest(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _validate_bootstrap_logs(manifest: dict[str, Any]) -> None:
    inventories = manifest["workbench_bootstrap_request_logs"]
    if not isinstance(inventories, dict) or set(inventories) != BOOTSTRAP_LOG_OPERATIONS:
        raise CollectorError("Workbench bootstrap inventories must contain exactly two operations")
    request_ids: set[str] = set()
    windows: list[tuple[str, str]] = []
    for operation, raw_inventory in inventories.items():
        inventory = exact(raw_inventory, BOOTSTRAP_INVENTORY_KEYS, f"Workbench {operation} inventory")
        start, end = inventory["query_started_at"], inventory["query_ended_at"]
        if not RFC3339_RE.fullmatch(str(start)) or not RFC3339_RE.fullmatch(str(end)) or not start < end:
            raise CollectorError(f"Workbench {operation} query window is invalid")
        windows.append((start, end))
        filters = exact(inventory["filters"], BOOTSTRAP_FILTER_KEYS, f"Workbench {operation} filters")
        if filters != {"operation": operation, "method": "POST", "test_mode": True}:
            raise CollectorError(f"Workbench {operation} filters are not exact")
        pages = inventory["pages"]
        if not isinstance(pages, list) or not pages:
            raise CollectorError(f"Workbench {operation} pages are missing")
        entries: list[dict[str, Any]] = []
        expected_cursor = None
        for index, raw_page in enumerate(pages):
            page = exact(raw_page, BOOTSTRAP_PAGE_KEYS, f"Workbench {operation} page")
            if page["cursor"] != expected_cursor or not isinstance(page["entries"], list):
                raise CollectorError(f"Workbench {operation} page cursor chain is incomplete")
            if index < len(pages) - 1 and (page["has_more"] is not True or not page["next_cursor"]):
                raise CollectorError(f"Workbench {operation} omitted a page")
            if index == len(pages) - 1 and (page["has_more"] is not False or page["next_cursor"] is not None):
                raise CollectorError(f"Workbench {operation} final page is incomplete")
            expected_cursor = page["next_cursor"]
            entries.extend(page["entries"])
        if inventory["total_matching_count"] != 1 or len(entries) != 1:
            raise CollectorError(f"Workbench {operation} must prove one matching request")
        entry = exact(entries[0], BOOTSTRAP_ENTRY_KEYS, f"Workbench {operation} entry")
        if entry["request_id"] in request_ids:
            raise CollectorError("Workbench bootstrap request IDs must be distinct")
        request_ids.add(entry["request_id"])
        if entry["operation"] != operation or entry["method"] != "POST" or entry["path"] not in CONNECT_PATHS[operation] or type(entry["http_status"]) is not int or not 200 <= entry["http_status"] < 300 or entry["test_mode"] is not True or not start <= entry["provider_created_at"] <= end or not _digest(entry["idempotency_key_sha256"]) or not _digest(entry["caller_input_sha256"]):
            raise CollectorError(f"Workbench {operation} request is not one successful bounded test mutation")
        request_keys, response_keys = (
            (ACCOUNT_REQUEST_KEYS, ACCOUNT_RESPONSE_KEYS)
            if operation == "connect_account.create"
            else (LINK_REQUEST_KEYS, LINK_RESPONSE_KEYS)
        )
        request_facts = exact(entry["request_facts"], request_keys, f"Workbench {operation} request facts")
        response_facts = exact(entry["response_facts"], response_keys, f"Workbench {operation} response facts")
        if request_facts.get("studio_id") != manifest["studio_id"]:
            raise CollectorError(f"Workbench {operation} request has the wrong studio")
        if operation == "connect_account.create" and (request_facts["connect_account_generation"] != manifest["connect_account_generation"] or response_facts != {"object": "account", "account_id": manifest["stripe_account_id"], "metadata_studio_id": manifest["studio_id"]}):
            raise CollectorError("Workbench Account create facts do not bind the rehearsal account")
        if operation == "connect_onboarding_link.create" and (request_facts["account_id"] != manifest["stripe_account_id"] or response_facts["object"] != "account_link" or response_facts["account_id"] != manifest["stripe_account_id"] or type(response_facts["expires_at"]) is not int or response_facts["expires_at"] <= 0 or response_facts["single_use"] is not True):
            raise CollectorError("Workbench Account Link facts do not bind one expiring single-use link")
    if windows[0][1] > windows[1][0] and windows[1][1] > windows[0][0]:
        raise CollectorError("Workbench bootstrap query windows must not overlap")


def _plain(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict_recursive"):
        return value.to_dict_recursive()
    return dict(value)


def _scalar(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get("id")
    return getattr(value, "id", value)


def normalize_local(row: Mapping[str, Any]) -> dict[str, Any]:
    forbidden = set(row) & FORBIDDEN_KEYS
    if forbidden:
        raise CollectorError("local row contains a forbidden field")
    result = {key: row[key] for key in sorted(set(row) & LOCAL_ALLOWED) if row[key] is not None}
    caller_key = row.get("caller_request_key") or row.get("stripe_idempotency_key") or row.get("provider_caller_request_key") or row.get("idempotency_key")
    if caller_key is not None:
        if not isinstance(caller_key, str) or not caller_key:
            raise CollectorError("local caller key is invalid")
        result["caller_request_key_sha256"] = hashlib.sha256(caller_key.encode()).hexdigest()
    if row.get("error") is not None:
        result["error_present"] = True
    if row.get("error_reference") is not None:
        result["error_reference_present"] = True
    return result


def normalize_audit(row: Mapping[str, Any]) -> dict[str, Any]:
    result = normalize_local(row)
    amount, method = row.get("audit_amount_cents"), row.get("audit_external_method")
    if type(amount) is not int or not isinstance(method, str) or not method:
        raise CollectorError("external-payment audit JSON facts are missing or invalid")
    result["metadata"] = {"amount_cents": amount, "external_method": method}
    return result


def normalize_provider(value: Any, *, kind: str, context: str) -> dict[str, Any]:
    row = _plain(value)
    if set(row) & FORBIDDEN_KEYS:
        raise CollectorError("provider object contains a forbidden field")
    result: dict[str, Any] = {"kind": kind, "context": context}
    for key in sorted(set(row) & PROVIDER_ALLOWED):
        item = row[key]
        if key == "metadata":
            metadata = _plain(item) if item else {}
            result[key] = {name: metadata[name] for name in sorted(set(metadata) & METADATA_ALLOWED)}
        elif key == "last_payment_error":
            result["last_payment_error_present"] = item is not None
        elif isinstance(item, (dict,)) or hasattr(item, "id"):
            result[key] = _scalar(item)
        elif isinstance(item, (str, int, bool, float)) or item is None:
            result[key] = item
    if result.get("id") is None:
        raise CollectorError(f"provider {kind} retrieval returned no ID")
    if kind == "test_clock":
        if context != "connected" or result.get("livemode") is True:
            raise CollectorError(f"provider test_clock {result['id']} has the wrong guarded test context")
    elif result.get("livemode") is not False:
        raise CollectorError(f"provider {kind} {result['id']} is not test mode")
    return result


def artifact(body: dict[str, Any]) -> dict[str, Any]:
    exact(body, ARTIFACT_BODY_KEYS, "artifact body")
    return {**body, "sha256": hashlib.sha256(canonical(body)).hexdigest()}


def validate_artifact(value: Any, manifest: dict[str, Any]) -> dict[str, Any]:
    row = exact(value, ARTIFACT_KEYS, "phase artifact")
    body = {key: row[key] for key in ARTIFACT_BODY_KEYS}
    if row["sha256"] != hashlib.sha256(canonical(body)).hexdigest():
        raise CollectorError("phase artifact hash mismatch")
    if row["artifact_schema_version"] != ARTIFACT_VERSION or row["phase"] not in PHASES or not RFC3339_RE.fullmatch(str(row["observed_at"])):
        raise CollectorError("phase artifact version, phase, or timestamp is invalid")
    for key in ("candidate_sha", "studio_id", "stripe_account_id", "connect_account_generation"):
        if row[key] != manifest[key]:
            raise CollectorError(f"phase artifact {key} does not match manifest")
    readiness = exact(row["readiness"], READINESS_KEYS, "phase artifact readiness")
    if readiness != {"status": "ready", "environment": "staging", "commit_sha": row["candidate_sha"], "configured_stripe_mode": "test"}:
        raise CollectorError("phase artifact readiness does not bind its exact candidate")
    expected_provider = sorted(spec["id"] for spec in manifest["provider_objects"].values() if row["phase"] in spec["phase"])
    expected_local = sorted(identifier for role_map in manifest["local_ids"].values() for identifier in role_map.values())
    if row["manifest_ids"] != {"local": expected_local, "provider": expected_provider}:
        raise CollectorError("phase artifact ID subset does not match manifest")
    return row


def validate_live_context(manifest: dict[str, Any], *, collect_read_only: bool, environment: Mapping[str, str] = os.environ) -> str:
    if not collect_read_only:
        raise CollectorError("live capture requires --collect-read-only")
    if environment.get("ENVIRONMENT") != "staging" or environment.get("SUPABASE_URL") != STAGING_SUPABASE_URL:
        raise CollectorError("live capture is pinned to the staging environment and Supabase project")
    key = str(environment.get("STRIPE_RESTRICTED_KEY") or environment.get("STRIPE_SECRET_KEY") or "")
    if not key.startswith(("rk_test_", "sk_test_")):
        raise CollectorError("live capture requires a mode-identifiable Stripe test key")
    return key


def verify_readiness(manifest: dict[str, Any]) -> dict[str, Any]:
    httpx = importlib.import_module("httpx")
    url = manifest["readiness_origin"].rstrip("/") + "/health/ready"
    response = httpx.get(url, timeout=15, follow_redirects=False, headers={"cache-control": "no-cache"})
    response.raise_for_status()
    payload = response.json()
    readiness = {key: payload.get(key) for key in READINESS_KEYS} if isinstance(payload, dict) else {}
    if readiness != {"status": "ready", "environment": "staging", "commit_sha": manifest["candidate_sha"], "configured_stripe_mode": "test"}:
        raise CollectorError("pinned readiness did not report the exact staging test candidate")
    return readiness


def collect_local(supabase: Any, manifest: dict[str, Any], *, event_window_ended_at: str) -> list[dict[str, Any]]:
    manifest = validate_manifest(manifest)
    if not RFC3339_RE.fullmatch(str(event_window_ended_at)) or not _at_or_after(event_window_ended_at, manifest["rehearsal_started_at"]):
        raise CollectorError("event window upper boundary is invalid")
    connect_roles = {"connect_checkout", "dispute_created", "dispute_closed"}
    params = {
        "p_studio_id": manifest["studio_id"],
        "p_stripe_account_id": manifest["stripe_account_id"],
        "p_connect_account_generation": manifest["connect_account_generation"],
        "p_rehearsal_started_at": manifest["rehearsal_started_at"],
        "p_event_window_ended_at": event_window_ended_at,
        "p_local_ids": manifest["local_ids"],
        "p_actor_ids": sorted(manifest["actor_bindings"]),
        "p_external_audit_id": manifest["external_payment_audit_ids"][0],
        "p_connect_event_ids": sorted(manifest["local_ids"]["webhook_events"][role] for role in connect_roles),
        "p_platform_event_ids": [manifest["local_ids"]["webhook_events"]["platform_subscription"]],
    }
    if set(params) != LOCAL_EVIDENCE_RPC_PARAM_KEYS:
        raise CollectorError("local evidence RPC parameters are not exact")
    try:
        response = supabase.rpc(LOCAL_EVIDENCE_RPC, params).execute()
        payload = response.data
    except Exception as exc:
        raise CollectorError("local evidence RPC failed") from None
    try:
        envelope_value = _plain(payload)
    except Exception:
        raise CollectorError("local evidence RPC response is malformed") from None
    envelope = exact(envelope_value, LOCAL_EVIDENCE_RESPONSE_KEYS, "local evidence RPC response")
    if type(envelope["schema_version"]) is not int or envelope["schema_version"] != LOCAL_EVIDENCE_RPC_VERSION or not isinstance(envelope["studio_id"], str) or envelope["studio_id"] != manifest["studio_id"] or not isinstance(envelope["stripe_account_id"], str) or envelope["stripe_account_id"] != manifest["stripe_account_id"] or type(envelope["connect_account_generation"]) is not int or envelope["connect_account_generation"] != manifest["connect_account_generation"]:
        raise CollectorError("local evidence RPC response context is invalid")
    if not isinstance(envelope["rehearsal_started_at"], str) or not isinstance(envelope["event_window_ended_at"], str) or not _same_instant(envelope["rehearsal_started_at"], manifest["rehearsal_started_at"]) or not _same_instant(envelope["event_window_ended_at"], event_window_ended_at):
        raise CollectorError("local evidence RPC response boundary is invalid")
    if not isinstance(envelope["local_id_bindings"], dict) or canonical(envelope["local_id_bindings"]) != canonical(manifest["local_ids"]):
        raise CollectorError("local evidence RPC response bindings differ from manifest")
    raw_rows = envelope["local_rows"]
    if not isinstance(raw_rows, list) or any(not isinstance(row, dict) for row in raw_rows):
        raise CollectorError("local evidence RPC local_rows must be a list of objects")
    allowed_owners = set(TABLES) | {"staff_roles", "audit_logs"}
    output: list[dict[str, Any]] = []
    for raw in raw_rows:
        row = _plain(raw)
        owner = row.pop("owner", None)
        if owner not in allowed_owners:
            raise CollectorError("local evidence RPC row owner is invalid")
        normalized = normalize_audit(row) if owner == "audit_logs" else normalize_local(row)
        output.append({"owner": owner, **normalized})
    for owner, (_table, id_column) in TABLES.items():
        expected = list(dict.fromkeys(manifest["local_ids"][owner].values()))
        observed = [str(row.get(id_column) or "") for row in output if row["owner"] == owner]
        if len(observed) != len(set(observed)) or set(observed) != set(expected):
            raise CollectorError(f"{owner} RPC rows are missing, extra, or duplicated")
    operation_rows = [row for row in output if row["owner"] == "operations"]
    for row in operation_rows:
        if row.get("studio_id") != manifest["studio_id"] or row.get("stripe_connected_account_id") != manifest["stripe_account_id"] or row.get("connect_account_generation") != manifest["connect_account_generation"]:
            raise CollectorError("operation has the wrong studio, account, or generation")
    indexed_rows = {(row["owner"], row.get("id")): row for row in output}
    for role, step_id in manifest["local_ids"]["steps"].items():
        step = indexed_rows[("steps", step_id)]
        parent_id = manifest["local_ids"]["operations"][role]
        if step.get("operation_id") != parent_id or step.get("studio_id") != manifest["studio_id"] or step.get("stripe_connected_account_id") != manifest["stripe_account_id"] or step.get("connect_account_generation") != manifest["connect_account_generation"]:
            raise CollectorError(f"step {role} has the wrong parent or provider context")
    ambiguity_resource = indexed_rows[("resources", manifest["local_ids"]["resources"]["ambiguity_customer"])]
    if ambiguity_resource.get("operation_id") != manifest["local_ids"]["operations"]["ambiguity_parent"] or ambiguity_resource.get("studio_id") != manifest["studio_id"]:
        raise CollectorError("ambiguity resource has the wrong parent or studio")
    due_operation_id = manifest["local_ids"]["operations"]["period_end_due_release"]
    operation_actors = {str(row.get("actor_id") or "") for row in operation_rows if row.get("id") != due_operation_id}
    if not operation_actors or operation_actors != set(manifest["actor_bindings"]):
        raise CollectorError("operation actors do not match manifest actor bindings")
    for actor_id in sorted(operation_actors):
        memberships = [row for row in output if row["owner"] == "staff_roles" and row.get("user_id") == actor_id]
        if len(memberships) != 1:
            raise CollectorError(f"actor {actor_id} does not have one exact studio membership")
        membership = memberships[0]
        operation_times = [_parse_instant(str(row.get("created_at") or "")) for row in operation_rows if row.get("actor_id") == actor_id]
        membership_updated_at = _parse_instant(str(membership.get("updated_at") or ""))
        if any(value is None for value in operation_times):
            raise CollectorError(f"actor {actor_id} operation timestamp is invalid")
        earliest = min(value for value in operation_times if value is not None)
        if membership.get("role") != manifest["actor_bindings"][actor_id] or membership.get("archived_at") is not None or membership_updated_at is None or membership_updated_at > earliest:
            raise CollectorError(f"actor {actor_id} membership is wrong, late, or archived")
    external_payment_id = manifest["local_ids"]["payments"].get("payments.external")
    if not external_payment_id:
        raise CollectorError("payments inventory lacks payments.external role")
    payment = next((row for row in output if row["owner"] == "payments" and row.get("id") == external_payment_id), None)
    if payment is None:
        raise CollectorError("external payment row is missing")
    audit_id = manifest["external_payment_audit_ids"][0]
    audits = [row for row in output if row["owner"] == "audit_logs" and row.get("id") == audit_id]
    window_audits = [row for row in output if row["owner"] == "audit_logs" and row.get("studio_id") == manifest["studio_id"] and row.get("action") == "billing.external_payment_recorded" and row.get("entity_id") == external_payment_id and _at_or_after(str(row.get("created_at") or ""), manifest["rehearsal_started_at"])]
    if len(audits) != 1 or len(window_audits) != 1:
        raise CollectorError("external payment audit is missing, duplicated, or unlisted in the rehearsal window")
    audit = audits[0]
    metadata = audit.get("metadata") or {}
    if audit.get("studio_id") != manifest["studio_id"] or audit.get("actor_id") not in manifest["actor_bindings"] or audit.get("action") != "billing.external_payment_recorded" or audit.get("entity_type") != "billing" or audit.get("entity_id") != external_payment_id or not _at_or_after(str(audit.get("created_at") or ""), manifest["rehearsal_started_at"]) or metadata.get("amount_cents") != payment.get("amount_cents") or metadata.get("external_method") != payment.get("external_method"):
        raise CollectorError("external payment audit does not bind the exact payment source")
    return sorted(output, key=lambda row: (row["owner"], str(row.get("id") or row.get("stripe_event_id"))))


def _resolve_attr(root: Any, dotted: str) -> Any:
    value = root
    for part in dotted.split("."):
        value = getattr(value, part)
    return value


def collect_provider(stripe: Any, manifest: dict[str, Any], phase: str) -> list[dict[str, Any]]:
    output = []
    for role, spec in manifest["provider_objects"].items():
        if phase not in spec["phase"]:
            continue
        owner, method = PROVIDER_RETRIEVERS[spec["kind"]]
        retrieve = getattr(_resolve_attr(stripe, owner), method)
        kwargs = {"stripe_account": manifest["stripe_account_id"]} if spec["context"] == "connected" else {}
        value = retrieve(spec["id"], **kwargs)
        normalized = normalize_provider(value, kind=spec["kind"], context=spec["context"])
        if normalized["id"] != spec["id"]:
            raise CollectorError(f"provider role {role} returned the wrong ID")
        output.append({"role": role, **normalized})
    return sorted(output, key=lambda row: row["role"])


def capture_phase(manifest: dict[str, Any], phase: str, *, readiness: Mapping[str, Any], local_reader: Callable[[str], list[dict[str, Any]]], provider_reader: Callable[[str], list[dict[str, Any]]], now: Callable[[], str] = utc_now) -> dict[str, Any]:
    if phase not in PHASES:
        raise CollectorError("capture phase is not recognized")
    observed_at = now()
    local_rows = local_reader(observed_at)
    provider_rows = provider_reader(phase)
    local_ids = sorted(identifier for role_map in manifest["local_ids"].values() for identifier in role_map.values())
    provider_ids = sorted(spec["id"] for spec in manifest["provider_objects"].values() if phase in spec["phase"])
    observed_readiness = exact(dict(readiness), READINESS_KEYS, "observed readiness")
    if observed_readiness != {"status": "ready", "environment": "staging", "commit_sha": manifest["candidate_sha"], "configured_stripe_mode": "test"}:
        raise CollectorError("capture readiness does not bind the exact staging test candidate")
    return artifact({"artifact_schema_version": ARTIFACT_VERSION, "phase": phase, "candidate_sha": manifest["candidate_sha"], "studio_id": manifest["studio_id"], "stripe_account_id": manifest["stripe_account_id"], "connect_account_generation": manifest["connect_account_generation"], "observed_at": observed_at, "readiness": observed_readiness, "manifest_ids": {"local": local_ids, "provider": provider_ids}, "local_rows": local_rows, "provider_objects": provider_rows})


def validate_phase_chain(manifest: dict[str, Any], values: list[Any]) -> list[dict[str, Any]]:
    artifacts = [validate_artifact(value, manifest) for value in values]
    if [row["phase"] for row in artifacts] != list(PHASES):
        raise CollectorError("phase artifacts are missing or out of order")
    timestamps = [row["observed_at"] for row in artifacts]
    if timestamps != sorted(timestamps) or len(set(timestamps)) != len(timestamps):
        raise CollectorError("phase artifact timestamps are not strictly ordered")
    if any(row["readiness"] != artifacts[0]["readiness"] for row in artifacts[1:]):
        raise CollectorError("phase artifact readiness observations differ")
    if canonical(artifacts[2]["local_rows"]) != canonical(artifacts[4]["local_rows"]):
        raise CollectorError("final local reread changed")
    if canonical(artifacts[3]["provider_objects"]) != canonical(artifacts[5]["provider_objects"]):
        raise CollectorError("final provider reread changed")
    return artifacts


def _load_contract() -> tuple[Any, None]:
    """Load the committed schema-v4 validator without worksheet data."""
    validator_path = ROOT / "scripts" / "verify-stripe-provider-rehearsal.py"
    validator_spec = importlib.util.spec_from_file_location("rehearsal_validator", validator_path)
    if not validator_spec or not validator_spec.loader:
        raise CollectorError("committed schema-v4 contract could not be loaded")
    validator = importlib.util.module_from_spec(validator_spec)
    validator_spec.loader.exec_module(validator)
    return validator, None


def _source_index(manifest: dict[str, Any], rows: list[dict[str, Any]], objects: list[dict[str, Any]]) -> dict[str, Any]:
    index: dict[str, Any] = {}
    local_by_id: dict[str, list[tuple[str, str]]] = {}
    for owner, roles in manifest["local_ids"].items():
        for role, identifier in roles.items():
            local_by_id.setdefault(identifier, []).append((owner, role))
    seen_local: set[str] = set()
    for row in rows:
        if row.get("owner") in TABLES:
            identifier = str(row.get(TABLES[row["owner"]][1]) or "")
            if identifier not in local_by_id or identifier in seen_local:
                raise CollectorError("final local source inventory is missing, extra, or duplicated")
            aliases = local_by_id[identifier]
            if any(owner != row.get("owner") for owner, _ in aliases):
                raise CollectorError("final local source has the wrong owner")
            seen_local.add(identifier)
            for owner, role in aliases:
                index[f"local:{owner}:{role}"] = row
    if seen_local != set(local_by_id):
        raise CollectorError("final local source inventory is missing, extra, or duplicated")
    expected_provider = manifest["provider_objects"]
    seen_provider: set[str] = set()
    for row in objects:
        role = row.get("role")
        spec = expected_provider.get(role)
        if not spec or role in seen_provider or row.get("id") != spec["id"] or row.get("kind") != spec["kind"] or row.get("context") != spec["context"]:
            raise CollectorError("final provider source inventory is missing, extra, duplicated, or misclassified")
        seen_provider.add(role)
        index[f"provider:{role}"] = row
    final_roles = {role for role, spec in expected_provider.items() if "final_provider_2" in spec["phase"]}
    if seen_provider != final_roles:
        raise CollectorError("final provider source inventory is incomplete")
    return index


def _workbench_entry(manifest: dict[str, Any], operation: str) -> dict[str, Any]:
    inventory = manifest["workbench_bootstrap_request_logs"][operation]
    entries = [entry for page in inventory["pages"] for entry in page["entries"]]
    if len(entries) != 1:
        raise CollectorError(f"Workbench {operation} does not contain one exact source row")
    return entries[0]


def _project_group_one(manifest: dict[str, Any], index: dict[str, Any], readiness: Mapping[str, Any], validator: Any) -> dict[str, Any]:
    studio, account = manifest["studio_id"], manifest["stripe_account_id"]
    account_row = index["provider:account"]
    if account_row.get("id") != account or account_row.get("metadata", {}).get("studio_id") != studio or account_row.get("livemode") is not False:
        raise CollectorError("independent Account readback does not bind the Workbench bootstrap account")
    steps = []
    for name in validator.REQUIRED_STEP_ORDER:
        steps.append({"name": name})
    bootstrap = {
        "connect.account_create": _workbench_entry(manifest, "connect_account.create"),
        "connect.onboarding_link": _workbench_entry(manifest, "connect_onboarding_link.create"),
    }
    mutations = []
    for step_name, expected in validator.REQUIRED_MUTATIONS.items():
        workflow_id, operation, scope, expected_role, uses_account = expected
        if step_name in bootstrap:
            source = bootstrap[step_name]
            digest = source["caller_input_sha256"]
            actor_role = "admin"
            outcome = "succeeded"
        else:
            source_role = MUTATION_SOURCE_ROLES[step_name]
            source = index[f"local:operations:{source_role}"]
            expected_parent_type = PARENT_OPERATION_TYPES.get(workflow_id, workflow_id)
            if source.get("operation_type") != expected_parent_type or source.get("state") != "completed" or source.get("stripe_connected_account_id") != account or source.get("connect_account_generation") != manifest["connect_account_generation"] or not _digest(source.get("request_sha256")):
                raise CollectorError(f"mutation source {step_name} has the wrong workflow contract")
            step = None if step_name == "payer.customer_create" else index[f"local:steps:{source_role}"]
            if step is not None and (step.get("operation_id") != source.get("id") or step.get("provider_operation") != operation or step.get("state") != "provider_succeeded" or step.get("provider_request_attempt_count") != 1 or step.get("stripe_connected_account_id") != account or step.get("connect_account_generation") != manifest["connect_account_generation"]):
                raise CollectorError(f"mutation step {step_name} has the wrong provider state or parent")
            digest = (step or source).get("caller_request_key_sha256")
            actor_id = source.get("actor_id")
            if step_name == "period_end.due_release":
                due = index["local:transitions:due"]
                if due.get("provider_operation_id") != source.get("id") or due.get("transition_kind") != "execute_due" or due.get("initiated_by") != actor_id:
                    raise CollectorError("period-end due release lacks exact internal operation/intent linkage")
                actor_role = "internal"
            else:
                actor_role = manifest["actor_bindings"].get(actor_id)
                if actor_role != expected_role:
                    raise CollectorError(f"mutation source {step_name} lacks its timed active staff actor")
            if source.get("provider_request_attempt_count") != 1 or (step is not None and step.get("provider_request_attempt_count") != 1):
                raise CollectorError(f"mutation source {step_name} did not converge exactly once")
            if step_name == "payer.customer_create" and (source.get("recovery_outcome") != "provider_succeeded_reconcile_only" or source.get("provider_object_id") is None):
                raise CollectorError("payer customer ambiguity parent lacks exact recovery evidence")
            outcome = "reconciled" if step_name == "payer.customer_create" else "succeeded"
        if not _digest(digest):
            raise CollectorError(f"mutation source {step_name} lacks a caller-key digest")
        mutations.append({
            "step_name": step_name, "workflow_id": workflow_id, "operation": operation,
            "actor_role": actor_role, "studio_id": studio, "scope": scope,
            "stripe_account_id": account if uses_account else None,
            "automatic_retry_count": 0, "outcome": outcome,
            "caller_request_key_sha256": digest, "provider_mutation_count": 1,
        })
    return {
        "schema_version": validator.EVIDENCE_SCHEMA_VERSION,
        "candidate_sha": manifest["candidate_sha"], "health_commit_sha": readiness["commit_sha"],
        "health_ready_url": manifest["readiness_origin"].rstrip("/") + "/health/ready",
        "stripe_mode": readiness["configured_stripe_mode"], "livemode": False, "secrets_redacted": True,
        "financial_canary_performed": False, "studio_id": studio, "stripe_account_id": account,
        "connect_account_generation": manifest["connect_account_generation"],
        "steps": steps, "mutation_attempts": mutations,
        "role_capabilities": {"admin": validator.ADMIN_WORKFLOWS, "front_desk": validator.FRONT_DESK_WORKFLOWS, "instructor": []},
    }


def _proof_steps(packet: dict[str, Any], validator: Any) -> list[dict[str, Any]]:
    facts, supplemental = packet["workflow_facts"], packet["supplemental_evidence"]
    deliveries, terminal = packet["webhook_delivery_evidence"], packet["terminal_counts"]
    predicates = {
        "health_exact_candidate": packet["candidate_sha"] == packet["health_commit_sha"] and packet["stripe_mode"] == "test",
        "operation_bounded_role_capabilities": packet["role_capabilities"] == {"admin": validator.ADMIN_WORKFLOWS, "front_desk": validator.FRONT_DESK_WORKFLOWS, "instructor": []},
        "plan_product_price": bool(facts.get("product_id") and facts.get("price_id")),
        "payer_customer": bool(facts.get("payer_id") and facts.get("customer_id")),
        "payer_consent_duplicate_replay": supplemental["payer_setup_lifecycle"]["replacement"]["active"] is True and len(supplemental["payer_setup_lifecycle"]["duplicate_completion"]["provider_replay"]["attempts"]) == 2,
        "shared_subscription_quantity_two": facts.get("shared_provider_quantity") == facts.get("shared_local_active_count") == 2,
        "invoice_link_finalize_send": facts.get("invoice_link_finalized") is True and facts.get("invoice_link_sent") is True,
        "automatic_payment_fee_50bps": facts.get("automatic_amount_cents") == 10000 and facts.get("provider_application_fee_cents") == 50,
        "failed_payment_named_retry": supplemental["failed_payment_retry"]["failed_provider_readback"]["invoice_status"] == "open" and supplemental["failed_payment_retry"]["provider_readback"]["invoice_status"] == "paid",
        "period_end_schedule_revoke_due": (facts.get("period_schedule_state"), facts.get("period_revoke_state"), facts.get("period_due_state")) == ("scheduled", "revoked", "completed"),
        "refund_dispute_convergence": facts.get("refunded_cents") + facts.get("disputed_cents") + facts.get("net_collected_cents") == facts.get("gross_paid_cents") and supplemental["dispute_lifecycle"]["local_readback"]["status"] == "won",
        "ambiguous_same_key_readback_recovery": facts.get("ambiguous_recovery_outcome") == "reconciled" and supplemental["ambiguity_recovery"]["provider_mutation_count"] == 1,
        "platform_webhook_delivery_readback": deliveries["platform"]["local_processing_status"] == "processed" and supplemental["platform_fixture"]["local_readback"]["projected_status"] == "active",
        "connect_webhook_delivery_readback": deliveries["connect"]["local_processing_status"] == "processed" and deliveries["connect"]["stripe_account_id"] == packet["stripe_account_id"],
        "terminal_zero_counts": all(row["count"] == 0 for row in terminal["counts"].values()),
    }
    failed = [name for name in validator.REQUIRED_STEP_ORDER if predicates.get(name) is not True]
    if failed:
        raise CollectorError("proof step source predicate failed: " + ", ".join(failed))
    return [{"name": name, "status": "pass", **({"stripe_account_id": None} if name == "health_exact_candidate" else {"studio_id": packet["studio_id"], "stripe_account_id": None if name in validator.PLATFORM_SCOPED_STEPS else packet["stripe_account_id"]})} for name in validator.REQUIRED_STEP_ORDER]


def _need(row: Mapping[str, Any], field: str, label: str) -> Any:
    value = row.get(field)
    if value is None or value == "":
        raise CollectorError(f"{label} lacks {field}")
    return value


def _project_group_two(manifest: dict[str, Any], index: dict[str, Any], boundary: str, validator: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    local = lambda owner, role: index[f"local:{owner}:{role}"]
    provider = lambda role: index[f"provider:{role}"]
    account, generation = manifest["stripe_account_id"], manifest["connect_account_generation"]
    payer, plan = local("payers", "payer"), local("plans", "plan")
    customer, product, price = provider("payer_customer"), provider("product"), provider("price")
    if payer.get("stripe_customer_id") != customer["id"] or customer.get("metadata", {}).get("payer_id") != payer["id"]:
        raise CollectorError("payer and connected Customer do not cross-bind")
    if plan.get("stripe_product_id") != product["id"] or plan.get("stripe_price_id") != price["id"] or price.get("product") != product["id"]:
        raise CollectorError("plan, Product, and Price do not cross-bind")
    setup_rows: dict[str, dict[str, Any]] = {}
    for phase in ("initial", "replacement"):
        request, consent = local("setup_requests", phase), local("consents", phase)
        checkout, setup_intent = provider(f"{phase}_checkout"), provider(f"{phase}_setup_intent")
        payment_method = _need(setup_intent, "payment_method", f"{phase} SetupIntent")
        expected = (payer["id"], account, generation, request["id"], checkout["id"], consent["id"], setup_intent["id"])
        actual = (consent.get("payer_id"), consent.get("stripe_connected_account_id"), consent.get("connect_account_generation"), consent.get("setup_request_id"), consent.get("stripe_checkout_session_id"), consent.get("id"), consent.get("stripe_setup_intent_id"))
        if actual != expected or checkout.get("setup_intent") != setup_intent["id"] or checkout.get("status") != "complete" or setup_intent.get("status") != "succeeded":
            raise CollectorError(f"{phase} payer setup sources do not cross-bind")
        values = {key: _need(consent, key, f"{phase} consent") for key in ("terms_version", "accepted_at", "completed_at")}
        active = consent.get("completed_at") is not None and consent.get("revoked_at") is None and consent.get("superseded_at") is None
        if phase == "initial" and (not consent.get("superseded_at") or active is not False):
            raise CollectorError("initial consent lacks exact supersession")
        if phase == "replacement" and (consent.get("superseded_at") is not None or active is not True):
            raise CollectorError("replacement consent is not the sole active consent")
        checkout_readback = {"source": validator.SUPPLEMENTAL_SOURCES["payer_setup.checkout"], "checkout_session_id": checkout["id"], "setup_intent_id": setup_intent["id"], "status": checkout["status"], "stripe_account_id": account, "capture_boundary": boundary}
        intent_readback = {"source": validator.SUPPLEMENTAL_SOURCES["payer_setup.setup_intent"], "setup_intent_id": setup_intent["id"], "payment_method_id": payment_method, "status": setup_intent["status"], "stripe_account_id": account, "capture_boundary": boundary}
        local_readback = {"source": validator.SUPPLEMENTAL_SOURCES["payer_setup.local"], "payer_id": payer["id"], "stripe_account_id": account, "connect_account_generation": generation, "setup_request_id": request["id"], "checkout_session_id": checkout["id"], "consent_id": consent["id"], "setup_intent_id": setup_intent["id"], "terms_version": values["terms_version"], "accepted_at": values["accepted_at"], "completed_at": values["completed_at"], "superseded_at": consent.get("superseded_at"), "revoked_at": consent.get("revoked_at"), "active": active, "capture_boundary": boundary}
        setup_rows[phase] = {**{key: local_readback[key] for key in validator.CONSENT_LOCAL_KEYS if key not in {"source", "capture_boundary"}}, "payment_method_id": payment_method, "provider_checkout_readback": checkout_readback, "provider_setup_intent_readback": intent_readback, "local_readback": local_readback}
    enrollments = [local("subscriptions", role) for role in ("student_one", "student_two")]
    subscription, item = provider("shared_subscription"), provider("shared_subscription_item")
    if any(row.get("payer_id") != payer["id"] or row.get("status") != "active" or row.get("stripe_subscription_id") != subscription["id"] or row.get("stripe_subscription_item_id") != item["id"] for row in enrollments) or item.get("quantity") != 2:
        raise CollectorError("shared subscription sources do not converge at quantity two")
    invoice_link, automatic = local("invoices", "invoice_link"), local("invoices", "automatic")
    provider_link, provider_auto = provider("invoice_link"), provider("automatic_invoice")
    finalize_step, send_step = local("steps", "invoice_link_finalize"), local("steps", "invoice_link_send")
    if invoice_link.get("stripe_invoice_id") != provider_link["id"] or not invoice_link.get("finalized_at") or finalize_step.get("state") != "provider_succeeded" or send_step.get("state") != "provider_succeeded" or automatic.get("stripe_invoice_id") != provider_auto["id"]:
        raise CollectorError("invoice-link or automatic invoice sources do not cross-bind")
    facts = {
        "product_id": product["id"], "price_id": price["id"], "payer_id": payer["id"], "customer_id": customer["id"],
        "initial_consent_payer_id": payer["id"], "initial_setup_request_id": setup_rows["initial"]["setup_request_id"], "initial_consent_id": setup_rows["initial"]["consent_id"], "initial_checkout_session_id": setup_rows["initial"]["checkout_session_id"], "initial_setup_intent_id": setup_rows["initial"]["setup_intent_id"], "initial_payment_method_id": setup_rows["initial"]["payment_method_id"], "initial_terms_version": setup_rows["initial"]["terms_version"],
        "replacement_consent_payer_id": payer["id"], "replacement_setup_request_id": setup_rows["replacement"]["setup_request_id"], "replacement_consent_id": setup_rows["replacement"]["consent_id"], "replacement_checkout_session_id": setup_rows["replacement"]["checkout_session_id"], "replacement_setup_intent_id": setup_rows["replacement"]["setup_intent_id"], "replacement_payment_method_id": setup_rows["replacement"]["payment_method_id"], "replacement_terms_version": setup_rows["replacement"]["terms_version"], "duplicate_consent_completion_target_id": setup_rows["replacement"]["consent_id"],
        "student_ids": [_need(row, "student_id", "enrollment") for row in enrollments], "subscription_id": subscription["id"], "subscription_item_id": item["id"], "shared_provider_quantity": item["quantity"], "shared_local_active_count": len(enrollments),
        "invoice_link_id": invoice_link["id"], "invoice_link_stripe_id": provider_link["id"], "invoice_link_finalized": True, "invoice_link_sent": True,
        "automatic_invoice_id": automatic["id"], "automatic_invoice_stripe_id": provider_auto["id"],
    }
    return facts, setup_rows


def _artifact_index(manifest: dict[str, Any], phase: dict[str, Any]) -> dict[str, Any]:
    return _source_index(manifest, phase["local_rows"], phase["provider_objects"])


def _project_group_three(manifest: dict[str, Any], phases: list[dict[str, Any]], final: dict[str, Any], boundary: str, validator: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    failed, paid = _artifact_index(manifest, phases[0]), _artifact_index(manifest, phases[1])
    local = lambda owner, role: final[f"local:{owner}:{role}"]
    provider = lambda role: final[f"provider:{role}"]
    fl = lambda owner, role: failed[f"local:{owner}:{role}"]
    fp = lambda role: failed[f"provider:{role}"]
    pl = lambda owner, role: paid[f"local:{owner}:{role}"]
    pp = lambda role: paid[f"provider:{role}"]
    invoice_id = local("invoices", "automatic")["id"]
    payment_id = local("payments", "automatic")["id"]
    invoice_before, payment_before = fl("invoices", "automatic"), fl("payments", "automatic")
    invoice_after, payment_after = pl("invoices", "automatic"), pl("payments", "automatic")
    pinv_before, ppi_before = fp("automatic_invoice"), fp("automatic_payment_intent")
    pinv_after, ppi_after, charge_after = pp("automatic_invoice"), pp("automatic_payment_intent"), pp("automatic_charge")
    amount, fee = payment_after.get("amount_cents"), payment_after.get("application_fee_cents")
    retry_values = (pinv_before.get("status"), ppi_before.get("status"), ppi_before.get("last_payment_error_present"), invoice_before.get("status"), payment_before.get("status"), pinv_after.get("status"), ppi_after.get("status"), charge_after.get("status"), invoice_after.get("status"), payment_after.get("status"), amount, fee)
    if retry_values != ("open", "requires_payment_method", True, "open", "failed", "paid", "succeeded", "succeeded", "paid", "succeeded", 10000, 50):
        raise CollectorError("failed-before/paid-after retry sources do not have exact states or amounts")
    if any((invoice_before.get("stripe_invoice_id") != pinv_before["id"], invoice_after.get("stripe_invoice_id") != pinv_after["id"], payment_after.get("stripe_payment_intent_id") != ppi_after["id"], payment_after.get("stripe_charge_id") != charge_after["id"], ppi_after.get("payment_method") != provider("replacement_setup_intent").get("payment_method"))):
        raise CollectorError("failed-before/paid-after retry identities do not cross-bind")
    retry = {
        "workflow_id": "invoice.retry", "operation": "connected_invoice.pay", "invoice_id": invoice_id,
        "payment_method_id": ppi_after["payment_method"], "payment_intent_id": ppi_after["id"], "charge_id": charge_after["id"],
        "amount_cents": amount, "application_fee_cents": fee, "provider_mutation_count": 1,
        "failed_provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["failed_payment_retry.failed_provider"], "invoice_id": pinv_before["id"], "invoice_status": pinv_before["status"], "payment_intent_id": ppi_before["id"], "payment_intent_status": ppi_before["status"], "last_payment_error_present": True, "capture_boundary": phases[0]["observed_at"]},
        "failed_local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["failed_payment_retry.failed_local"], "invoice_id": invoice_id, "invoice_status": invoice_before["status"], "payment_id": payment_id, "payment_status": payment_before["status"], "stripe_invoice_id": pinv_before["id"], "payment_intent_id": ppi_before["id"], "capture_boundary": phases[0]["observed_at"]},
        "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["failed_payment_retry.provider"], "invoice_id": pinv_after["id"], "invoice_status": pinv_after["status"], "payment_intent_id": ppi_after["id"], "payment_intent_status": ppi_after["status"], "charge_id": charge_after["id"], "charge_status": charge_after["status"], "payment_method_id": ppi_after["payment_method"], "amount_cents": amount, "application_fee_cents": fee, "capture_boundary": phases[1]["observed_at"]},
        "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["failed_payment_retry.local"], "invoice_id": invoice_id, "invoice_status": invoice_after["status"], "payment_id": payment_id, "payment_status": payment_after["status"], "stripe_invoice_id": pinv_after["id"], "payment_intent_id": ppi_after["id"], "charge_id": charge_after["id"], "payment_method_id": ppi_after["payment_method"], "amount_cents": amount, "application_fee_cents": fee, "capture_boundary": phases[1]["observed_at"]},
    }
    for readback in ("failed_provider_readback", "failed_local_readback", "provider_readback", "local_readback"):
        retry[readback]["capture_boundary"] = boundary
    schedule, revoke, due = (local("transitions", role) for role in ("schedule", "revoke", "due"))
    revoke_schedule, due_schedule, item = provider("revoke_schedule"), provider("due_schedule"), provider("shared_subscription_item")
    revoke_owner, due_owner = local("operations", "period_end_revoke_schedule_create"), local("operations", "period_end_due_schedule_create")
    if (schedule.get("state"), revoke.get("state"), due.get("state"), schedule.get("mutation_strategy"), schedule.get("provider_quantity"), due.get("expected_quantity")) != ("scheduled", "revoked", "completed", "subscription_item_delete_at_period_end", 2, 1) or revoke_owner.get("provider_object_id") != revoke_schedule["id"] or due_owner.get("provider_object_id") != due_schedule["id"] or item.get("quantity") != 1:
        raise CollectorError("period schedule/revoke/due sources do not cross-bind")
    refund, dispute, payment = local("refunds", "refund"), local("disputes", "dispute"), local("payments", "automatic")
    prefund, pdispute = provider("refund"), provider("dispute")
    expected_accounting = (payment.get("gross_paid_cents"), payment.get("refunded_cents"), payment.get("disputed_cents"), payment.get("net_collected_cents"), payment.get("refundable_remaining_cents"))
    if expected_accounting != (10000, 1000, 0, 9000, 9000) or refund.get("stripe_refund_id") != prefund["id"] or refund.get("amount_cents") != prefund.get("amount") or refund.get("status") != prefund.get("status") or dispute.get("stripe_dispute_id") != pdispute["id"] or (dispute.get("status"), dispute.get("state_category"), pdispute.get("status")) != ("won", "won", "won") or any(row.get("reconciliation_required") is not False for row in (refund, dispute, payment)):
        raise CollectorError("refund/dispute/accounting sources do not converge")
    if any(row.get("payment_id") != payment["id"] for row in (refund, dispute)) or prefund.get("charge") != payment.get("stripe_charge_id") or pdispute.get("charge") != payment.get("stripe_charge_id"):
        raise CollectorError("refund/dispute sources do not bind the adjusted payment")
    invoice_before_adjustment, invoice_final = pl("invoices", "automatic"), local("invoices", "automatic")
    payer_before_adjustment, payer_final = pl("payers", "payer"), local("payers", "payer")
    invariants = (invoice_before_adjustment.get("amount_remaining_cents"), invoice_final.get("amount_remaining_cents"), payer_before_adjustment.get("billing_status"), payer_final.get("billing_status"))
    if any(value is None for value in invariants) or invariants[0] != invariants[1] or invariants[2] != invariants[3]:
        raise CollectorError("invoice and payer before/after invariants are missing or changed")
    created_event, closed_event = local("webhook_events", "dispute_created"), local("webhook_events", "dispute_closed")
    pcreated, pclosed = provider("dispute_created_event"), provider("dispute_closed_event")
    for label, local_event, provider_event, event_type in (("created", created_event, pcreated, "charge.dispute.created"), ("closed", closed_event, pclosed, "charge.dispute.closed")):
        if local_event.get("stripe_event_id") != provider_event["id"] or local_event.get("type") != event_type or provider_event.get("type") != event_type or local_event.get("processing_status") != "processed":
            raise CollectorError(f"dispute {label} event sources do not cross-bind")
    ambiguity, resource = local("operations", "ambiguity_parent"), local("resources", "ambiguity_customer")
    if ambiguity.get("state") != "completed" or ambiguity.get("operation_type") != "payer.sync" or ambiguity.get("recovery_outcome") != "provider_succeeded_reconcile_only" or ambiguity.get("provider_request_attempt_count") != 1 or ambiguity.get("provider_object_id") != provider("payer_customer")["id"] or not ambiguity.get("completed_at") or resource.get("operation_id") != ambiguity["id"] or resource.get("resource_type") != "payer" or resource.get("resource_id") != local("payers", "payer")["id"] or resource.get("revision") != 1:
        raise CollectorError("ambiguity operation/resource sources do not prove one readback recovery")
    schedule = {**schedule, "status": schedule["state"], "strategy": "subscription_schedule_shared_item_delete_at_period_end"}
    revoke = {**revoke, "status": revoke["state"]}
    due = {**due, "status": due["state"]}
    facts = {"automatic_payment_intent_id": ppi_after["id"], "automatic_charge_id": charge_after["id"], "automatic_amount_cents": amount, "application_fee_bps": 50, "provider_application_fee_cents": fee, "failed_payment_invoice_id": invoice_id, "failed_payment_retry_workflow": "invoice.retry", "failed_payment_retry_outcome": "succeeded", "failed_payment_retry_mutation_count": 1, "period_schedule_state": schedule["status"], "period_revoke_state": revoke["status"], "period_due_state": due["status"], "period_schedule_intent_id": schedule["id"], "period_revoke_intent_id": revoke["id"], "period_due_intent_id": due["id"], "period_revoke_schedule_id": revoke_schedule["id"], "period_due_schedule_id": due_schedule["id"], "period_strategy": schedule["strategy"], "period_quantity_before": 2, "period_quantity_after": 1, "adjusted_payment_id": payment["id"], "refund_id": prefund["id"], "dispute_id": pdispute["id"], "gross_paid_cents": 10000, "refunded_cents": 1000, "disputed_cents": 0, "net_collected_cents": 9000, "refundable_remaining_cents": 9000, "invoice_remaining_before_cents": payment.get("invoice_remaining_before_cents"), "invoice_remaining_after_cents": payment.get("invoice_remaining_after_cents"), "payer_status_before": payment.get("payer_status_before"), "payer_status_after": payment.get("payer_status_after"), "adjustment_reconciliation_required": False, "ambiguous_mutation_step_name": "payer.customer_create", "ambiguous_caller_key_sha256": ambiguity.get("caller_request_key_sha256"), "ambiguous_provider_mutation_count": ambiguity["provider_request_attempt_count"], "ambiguous_automatic_retry_count": 0, "ambiguous_provider_readback_count": 1, "ambiguous_recovery_outcome": "reconciled", "ambiguous_final_state": ambiguity["state"]}
    facts["ambiguous_caller_key_sha256"] = local("operations", "payer_customer_create")["caller_request_key_sha256"]
    facts.update(period_schedule_state=schedule["state"], period_revoke_state=revoke["state"], period_due_state=due["state"], period_strategy="subscription_schedule_shared_item_delete_at_period_end", period_quantity_before=schedule["provider_quantity"], period_quantity_after=due["expected_quantity"])
    facts.update(invoice_remaining_before_cents=invariants[0], invoice_remaining_after_cents=invariants[1], payer_status_before=invariants[2], payer_status_after=invariants[3])
    dispute_lifecycle = {
        "dispute_id": pdispute["id"], "charge_id": payment["stripe_charge_id"], "payment_id": payment["id"],
        "created_event": {"event_id": pcreated["id"], "event_type": pcreated["type"], "local_event_id": created_event["stripe_event_id"], "local_processing_status": created_event["processing_status"]},
        "closed_event": {"event_id": pclosed["id"], "event_type": pclosed["type"], "local_event_id": closed_event["stripe_event_id"], "local_processing_status": closed_event["processing_status"]},
        "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["dispute.provider"], "dispute_id": pdispute["id"], "charge_id": pdispute["charge"], "amount_cents": pdispute.get("amount"), "status": pdispute["status"], "capture_boundary": boundary},
        "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["dispute.local"], "dispute_id": dispute["stripe_dispute_id"], "charge_id": payment["stripe_charge_id"], "payment_id": payment["id"], "created_event_id": created_event["stripe_event_id"], "closed_event_id": closed_event["stripe_event_id"], "status": dispute["status"], "state_category": dispute["state_category"], "disputed_cents": payment["disputed_cents"], "reconciliation_required": dispute["reconciliation_required"], "capture_boundary": boundary},
    }
    refund_convergence = {
        "refund_id": prefund["id"], "charge_id": payment["stripe_charge_id"], "payment_intent_id": payment["stripe_payment_intent_id"], "payment_id": payment["id"], "stripe_account_id": manifest["stripe_account_id"], "connect_account_generation": manifest["connect_account_generation"], "amount_cents": prefund["amount"],
        "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["refund.provider"], "refund_id": prefund["id"], "charge_id": prefund["charge"], "payment_intent_id": payment["stripe_payment_intent_id"], "status": prefund["status"], "amount_cents": prefund["amount"], "capture_boundary": boundary},
        "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["refund.local"], "refund_id": refund["stripe_refund_id"], "charge_id": payment["stripe_charge_id"], "payment_intent_id": payment["stripe_payment_intent_id"], "payment_id": payment["id"], "stripe_account_id": refund.get("stripe_account_id"), "connect_account_generation": refund.get("connect_account_generation"), "status": refund["status"], "amount_cents": refund["amount_cents"], "gross_paid_cents": payment["gross_paid_cents"], "refunded_cents": payment["refunded_cents"], "disputed_cents": payment["disputed_cents"], "net_collected_cents": payment["net_collected_cents"], "refundable_remaining_cents": payment["refundable_remaining_cents"], "reconciliation_required": refund["reconciliation_required"], "capture_boundary": boundary},
    }
    if refund.get("stripe_account_id") != manifest["stripe_account_id"] or refund.get("connect_account_generation") != manifest["connect_account_generation"] or pdispute.get("amount") != 10000:
        raise CollectorError("refund/dispute account, generation, or amount context is wrong")
    return facts, {"failed_payment_retry": retry, "dispute_lifecycle": dispute_lifecycle, "refund_convergence": refund_convergence}


def _project_group_four_deliveries(manifest: dict[str, Any], final: dict[str, Any], boundary: str, validator: Any) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    local = lambda owner, role: final[f"local:{owner}:{role}"]
    provider = lambda role: final[f"provider:{role}"]
    origin, studio, account, generation = manifest["readiness_origin"].rstrip("/"), manifest["studio_id"], manifest["stripe_account_id"], manifest["connect_account_generation"]
    attempts = manifest["workbench_delivery_attempts"]
    connect_attempts, platform_attempt = attempts[:2], attempts[2]
    connect_local, platform_local = local("webhook_events", "connect_checkout"), local("webhook_events", "platform_subscription")
    connect_event, platform_event = provider("connect_checkout_event"), provider("platform_subscription_event")
    replacement_request, replacement_consent = local("setup_requests", "replacement"), local("consents", "replacement")
    replacement_operation = local("operations", "payer_replacement_setup_checkout")
    replacement_step = local("steps", "payer_replacement_setup_checkout")
    expected_connect_endpoint = origin + "/api/v1/webhooks/stripe/connect"
    if any(row["endpoint_url"] != expected_connect_endpoint or row["event_id"] != connect_event["id"] or row["event_type"] != "checkout.session.completed" or row["checkout_session_id"] != provider("replacement_checkout")["id"] for row in connect_attempts):
        raise CollectorError("Connect replay attempts do not bind the pinned endpoint and replacement Checkout")
    if connect_local.get("stripe_event_id") != connect_event["id"] or connect_local.get("type") != connect_event.get("type") or connect_local.get("processing_status") != "processed":
        raise CollectorError("Connect replay local event does not bind one processed durable event")
    replay = {
        "provider_replay": {"source": validator.SUPPLEMENTAL_SOURCES["payer_setup.replay_provider"], "event_id": connect_event["id"], "checkout_session_id": provider("replacement_checkout")["id"], "attempts": [{key: row[key] for key in validator.PROVIDER_REPLAY_ATTEMPT_KEYS} for row in connect_attempts], "capture_boundary": boundary},
        "local_replay": {"source": validator.SUPPLEMENTAL_SOURCES["payer_setup.replay_local"], "event_id": connect_event["id"], "checkout_session_id": provider("replacement_checkout")["id"], "processing_status": connect_local["processing_status"], "setup_request_id": replacement_request["id"], "setup_request_row_count": 1, "consent_id": replacement_consent["id"], "consent_row_count": 1, "setup_intent_id": provider("replacement_setup_intent")["id"], "provider_operation_id": replacement_operation["id"], "provider_operation": replacement_step["provider_operation"], "provider_operation_row_count": 1, "capture_boundary": boundary},
    }
    deliveries = {
        "connect": {"surface": "connect", "endpoint_url": expected_connect_endpoint, "connect": True, "event_id": connect_event["id"], "event_type": connect_event["type"], "studio_id": studio, "stripe_account_id": account, "connect_account_generation": generation, "provider_delivery_status": connect_attempts[-1]["delivery_status"], "provider_http_status": connect_attempts[-1]["http_status"], "local_event_id": connect_local["stripe_event_id"], "local_processing_status": connect_local["processing_status"]},
        "platform": {"surface": "platform", "endpoint_url": origin + "/api/v1/webhooks/stripe/platform", "connect": False, "event_id": platform_event["id"], "event_type": platform_event["type"], "studio_id": studio, "stripe_account_id": None, "connect_account_generation": None, "provider_delivery_status": platform_attempt["delivery_status"], "provider_http_status": platform_attempt["http_status"], "local_event_id": platform_local.get("stripe_event_id"), "local_processing_status": platform_local.get("processing_status")},
    }
    customer, subscription, core = provider("platform_customer"), provider("platform_subscription"), local("platform_core_rows", "platform_subscription")
    if platform_attempt["endpoint_url"] != deliveries["platform"]["endpoint_url"] or platform_attempt["event_id"] != platform_event["id"] or platform_event.get("type") != "customer.subscription.created" or platform_local.get("stripe_event_id") != platform_event["id"] or platform_local.get("processing_status") != "processed" or customer.get("metadata", {}).get("studio_id") != studio or subscription.get("metadata", {}).get("studio_id") != studio or subscription.get("customer") != customer["id"] or subscription.get("status") != "active" or not 0 < customer.get("created", 0) < subscription.get("created", 0) or core.get("stripe_customer_id") != customer["id"] or core.get("stripe_subscription_id") != subscription["id"] or core.get("status") != "active":
        raise CollectorError("owned platform fixture sources do not cross-bind")
    platform_fixture = {"method": "stripe.platform.subscription.create", "event_id": platform_event["id"], "event_type": platform_event["type"], "studio_id": studio, "stripe_account_id": None, "customer_id": customer["id"], "customer_preexisted": True, "subscription_id": subscription["id"], "provider_mutation_count": 1, "cleanup_required": True, "cleanup_timing": "after_evidence_validation", "customer_readback": {"source": validator.SUPPLEMENTAL_SOURCES["platform_fixture.customer"], "customer_id": customer["id"], "metadata_studio_id": studio, "livemode": customer["livemode"], "created_at": customer["created"], "capture_boundary": boundary}, "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["platform_fixture.provider"], "customer_id": customer["id"], "subscription_id": subscription["id"], "metadata_studio_id": studio, "status": subscription["status"], "livemode": subscription["livemode"], "created_at": subscription["created"], "capture_boundary": boundary}, "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["platform_fixture.local"], "event_id": platform_local["stripe_event_id"], "event_type": platform_local["type"], "stripe_account_id": None, "livemode": platform_local["livemode"], "processing_status": platform_local["processing_status"], "studio_id": studio, "customer_id": core["stripe_customer_id"], "subscription_id": core["stripe_subscription_id"], "projected_status": core["status"], "capture_boundary": boundary}}
    return replay, deliveries, platform_fixture


def _readback(source: str, status: str, boundary: str) -> dict[str, Any]:
    return {"source": source, "status": status, "capture_boundary": boundary}


def _project_group_four_local(manifest: dict[str, Any], final: dict[str, Any], final_rows: list[dict[str, Any]], boundary: str, validator: Any) -> dict[str, Any]:
    local = lambda owner, role: final[f"local:{owner}:{role}"]
    provider = lambda role: final[f"provider:{role}"]
    invoice, pinvoice, void_op = local("invoices", "invoice_link"), provider("invoice_link"), local("operations", "invoice_void")
    if invoice.get("status") != "void" or pinvoice.get("status") != "void" or invoice.get("stripe_invoice_id") != pinvoice["id"] or void_op.get("state") != "completed" or void_op.get("operation_type") != "invoice.void" or void_op.get("provider_object_id") != pinvoice["id"] or void_op.get("provider_request_attempt_count") != 1:
        raise CollectorError("invoice void operation and reused invoice do not cross-bind")
    void_binding = {"invoice_id": pinvoice["id"], "durable_operation_id": void_op["id"], "stripe_account_id": void_op["stripe_connected_account_id"], "connect_account_generation": void_op["connect_account_generation"]}
    invoice_void = {"workflow_id": "invoice.void", "operation": "connected_invoice.void", "actor_role": manifest["actor_bindings"].get(void_op.get("actor_id")), "provider_attempt_count": void_op.get("provider_request_attempt_count"), "provider_mutation_count": 1, "automatic_retry_count": 0, "caller_request_key_sha256": void_op.get("caller_request_key_sha256"), "durable_operation_id": void_op["id"], "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["invoice_void.provider"], **void_binding, "status": pinvoice["status"], "capture_boundary": boundary}, "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["invoice_void.local"], **void_binding, "status": invoice["status"], "capture_boundary": boundary}}
    enrollment, subscription = local("subscriptions", "student_two"), provider("shared_subscription")
    transition, immediate_op = local("transitions", "immediate"), local("operations", "immediate_cancellation")
    if enrollment.get("status") != "canceled" or subscription.get("status") != "canceled" or transition.get("state") != "completed" or transition.get("transition_kind") != "immediate_cancel" or transition.get("provider_operation_id") != immediate_op["id"] or transition.get("enrollment_id") != enrollment["id"] or immediate_op.get("state") != "completed" or immediate_op.get("operation_type") != "enrollment.cancel.immediate" or immediate_op.get("provider_object_id") != subscription["id"] or immediate_op.get("provider_request_attempt_count") != 1:
        raise CollectorError("immediate cancellation operation, transition, enrollment, and reused subscription do not cross-bind")
    immediate_binding = {"subscription_id": subscription["id"], "durable_operation_id": immediate_op["id"], "transition_intent_id": transition["id"], "stripe_account_id": immediate_op["stripe_connected_account_id"], "connect_account_generation": immediate_op["connect_account_generation"]}
    immediate = {"workflow_id": "enrollment.cancel.immediate", "strategy": "whole_subscription_cancel", "operation": "connected_subscription.cancel", "actor_role": manifest["actor_bindings"].get(immediate_op.get("actor_id")), "provider_attempt_count": immediate_op.get("provider_request_attempt_count"), "provider_mutation_count": 1, "automatic_retry_count": 0, "caller_request_key_sha256": immediate_op.get("caller_request_key_sha256"), "durable_operation_id": immediate_op["id"], "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["immediate_cancellation.provider"], **immediate_binding, "status": subscription["status"], "capture_boundary": boundary}, "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["immediate_cancellation.local"], **immediate_binding, "enrollment_id": enrollment["id"], "transition_state": transition["state"], "enrollment_status": enrollment["status"], "capture_boundary": boundary}}
    payment = local("payments", "payments.external")
    audits = [row for row in final_rows if row.get("owner") == "audit_logs" and row.get("id") == manifest["external_payment_audit_ids"][0]]
    if len(audits) != 1:
        raise CollectorError("external payment lacks one exact audit source")
    audit = audits[0]; metadata = audit.get("metadata") or {}
    matching_provider_operations = [row for row in final_rows if row.get("owner") == "operations" and (row.get("operation_type") == "payment.external.record" or payment["id"] in {row.get("provider_object_id"), row.get("provider_secondary_object_id")})]
    if payment.get("status") != "externally_recorded" or payment.get("currency") is None or payment.get("stripe_account_id") != manifest["stripe_account_id"] or payment.get("connect_account_generation") != manifest["connect_account_generation"] or audit.get("studio_id") != payment.get("studio_id") or audit.get("entity_id") != payment["id"] or audit.get("action") != "billing.external_payment_recorded" or audit.get("actor_id") not in manifest["actor_bindings"] or metadata.get("amount_cents") != payment.get("amount_cents") or metadata.get("external_method") != payment.get("external_method") or matching_provider_operations:
        raise CollectorError("external payment and audit amount/method do not cross-bind")
    scope = {"local_payment_id": payment["id"], "studio_id": payment["studio_id"], "stripe_account_id": payment["stripe_account_id"], "connect_account_generation": payment["connect_account_generation"], "caller_request_key_sha256": payment["caller_request_key_sha256"]}
    actor = {"actor_id": audit["actor_id"], "actor_role": manifest["actor_bindings"][audit["actor_id"]]}
    audit_identity = {"audit_id": audit["id"], "audit_action": audit["action"]}
    facts = {"amount_cents": payment["amount_cents"], "currency": payment["currency"], "external_method": payment["external_method"], "invoice_id": payment.get("invoice_id")}
    external = {"workflow_id": "payment.external.record", **scope, "local_status": payment["status"], "replay_payment_id": payment["id"], "replay_outcome": "same_row", "audit_count": 1, "provider_mutation_count": 0, **actor, **audit_identity, **facts, "provider_operation_inventory_readback": {"source": validator.SUPPLEMENTAL_SOURCES["external_payment.inventory"], **scope, "matching_provider_operation_count": len(matching_provider_operations), "status": "zero", "capture_boundary": boundary}, "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["external_payment.local"], **scope, "replay_payment_id": payment["id"], **audit_identity, "audit_entity_id": audit["entity_id"], **actor, "payment_status": payment["status"], "audit_count": 1, **facts, "capture_boundary": boundary}}
    unsupported = [{"subject": subject, "classification": "unsupported", "denial_reason_code": reason, "provider_mutation_count": 0, "denial_readback": _readback(validator.SUPPLEMENTAL_SOURCES["unsupported.denial"], "denied", boundary), "provider_operation_inventory_readback": _readback(validator.SUPPLEMENTAL_SOURCES["unsupported.inventory"], "zero", boundary)} for subject, reason in validator.UNSUPPORTED_CONTRACT.items()]
    return {"invoice_void": invoice_void, "immediate_cancellation": immediate, "external_payment": external, "unsupported_operations": unsupported}


def _terminal_counts(manifest: dict[str, Any], rows: list[dict[str, Any]], objects: list[dict[str, Any]], boundary: str, validator: Any) -> dict[str, Any]:
    operations = [row for row in rows if row.get("owner") == "operations"]
    steps = [row for row in rows if row.get("owner") == "steps"]
    events = [row for row in rows if row.get("owner") == "webhook_events"]
    transitions = [row for row in rows if row.get("owner") == "transitions"]
    provider_wrong = sum(row.get("livemode") is not False for row in objects if row.get("kind") != "test_clock")
    local_wrong = sum(row.get("livemode") is not False for row in events)
    connected_context = {
        "operations": "stripe_connected_account_id", "steps": "stripe_connected_account_id",
        "setup_requests": "stripe_connected_account_id", "consents": "stripe_connected_account_id",
        "transitions": "stripe_connected_account_id", "invoices": "stripe_account_id",
        "payments": "stripe_account_id", "refunds": "stripe_account_id", "disputes": "stripe_account_id",
    }
    wrong_generation = 0
    generation_owners = {"operations", "steps", "setup_requests", "consents", "transitions", "payments", "refunds", "disputes"}
    for row in rows:
        account_field = connected_context.get(row.get("owner"))
        wrong_account = account_field and row.get(account_field) != manifest["stripe_account_id"]
        wrong_generation_value = row.get("owner") in generation_owners and row.get("connect_account_generation") != manifest["connect_account_generation"]
        if wrong_account or wrong_generation_value:
            wrong_generation += 1
    reconciliations = {
        (row.get("owner"), row.get("id") or row.get("stripe_event_id"))
        for row in rows if row.get("state") == "reconciliation_required" or row.get("reconciliation_required") is True or row.get("adjustment_reconciliation_required") is True
    }
    event_roles = {identifier: role for role, identifier in manifest["local_ids"]["webhook_events"].items()}
    unmapped = 0
    for row in events:
        role = event_roles.get(row.get("stripe_event_id"))
        expected_account = None if role == "platform_subscription" else manifest["stripe_account_id"]
        if role is None or row.get("stripe_account_id") != expected_account or row.get("processing_status") == "failed" or row.get("error") is not None or row.get("error_reference") is not None or row.get("error_present") is True or row.get("error_reference_present") is True or row.get("processing_status") not in {"pending", "processing", "processed", "ignored"}:
            unmapped += 1
    raw = {
        "failed": sum(row.get("state") in {"definitive_failed", "definitive_rejected"} for row in operations + steps + transitions),
        "stuck": sum(row.get("state") in {"provider_request_in_flight", "recovery_authorized", "due_claimed"} and bool(row.get("lease_expires_at")) and str(row["lease_expires_at"]) <= boundary for row in operations + steps + transitions),
        "unmapped": unmapped,
        "wrong_mode": provider_wrong + local_wrong,
        "wrong_generation": wrong_generation,
        "pending_transition": sum(row.get("state") in {"due_claimed", "provider_request_in_flight", "provider_succeeded", "projected", "recovery_authorized"} for row in transitions),
        "reconciliation_required": len(reconciliations),
    }
    return {
        "capture_boundary": boundary,
        "counts": {name: {"count": raw[name], "source": validator.TERMINAL_SOURCES[name], "readback_boundary": boundary} for name in validator.TERMINAL_COUNT_KEYS},
        "wrong_mode_components": [
            {"surface": "provider", "count": provider_wrong, "source": validator.WRONG_MODE_SOURCES["provider"], "readback_boundary": boundary},
            {"surface": "local", "count": local_wrong, "source": validator.WRONG_MODE_SOURCES["local"], "readback_boundary": boundary},
        ],
    }


def assemble(manifest: dict[str, Any], values: list[Any]) -> dict[str, Any]:
    """Assemble immutable evidence from one validated six-artifact chain."""
    manifest = validate_manifest(manifest)
    phases = validate_phase_chain(manifest, values)
    validator, _ = _load_contract()
    final_local = phases[4]["local_rows"]
    final_provider = phases[5]["provider_objects"]
    index = _source_index(manifest, final_local, final_provider)
    boundary = phases[5]["observed_at"]
    terminal = _terminal_counts(manifest, final_local, final_provider, boundary, validator)
    nonzero = [name for name, row in terminal["counts"].items() if row["count"]]
    if nonzero:
        raise CollectorError("; ".join(f"terminal count {name} must be zero" for name in sorted(nonzero)))
    packet = _project_group_one(manifest, index, phases[0]["readiness"], validator)
    facts_two, setup = _project_group_two(manifest, _artifact_index(manifest, phases[1]), boundary, validator)
    facts_three, supplemental_three = _project_group_three(manifest, phases, index, boundary, validator)
    replay, deliveries, platform = _project_group_four_deliveries(manifest, index, boundary, validator)
    supplemental_local = _project_group_four_local(manifest, index, final_local, boundary, validator)
    setup["duplicate_completion"] = replay
    test_clock = index["provider:test_clock"]
    old_test_clock = _artifact_index(manifest, phases[0])["provider:test_clock"]
    old_frozen = old_test_clock.get("frozen_time")
    frozen = test_clock.get("frozen_time")
    if type(old_frozen) is not int or type(frozen) is not int or old_frozen <= 0 or frozen <= old_frozen:
        raise CollectorError("Test Clock readbacks lack one exact increasing frozen-time boundary")
    ambiguity = index["local:operations:ambiguity_parent"]
    ambiguity_resource = index["local:resources:ambiguity_customer"]
    payer = index["local:payers:payer"]
    customer = index["provider:payer_customer"]
    schedule = index["local:transitions:schedule"]
    revoke = index["local:transitions:revoke"]
    due = index["local:transitions:due"]
    period_context = {"studio_id": due["studio_id"], "stripe_account_id": due["stripe_connected_account_id"], "connect_account_generation": due["connect_account_generation"]}
    ambiguity_context = {"studio_id": ambiguity["studio_id"], "stripe_account_id": ambiguity["stripe_connected_account_id"], "connect_account_generation": ambiguity["connect_account_generation"]}
    if period_context != ambiguity_context or period_context != {"studio_id": payer["studio_id"], "stripe_account_id": manifest["stripe_account_id"], "connect_account_generation": manifest["connect_account_generation"]} or customer.get("metadata", {}).get("payer_id") != payer["id"] or payer.get("stripe_customer_id") != customer["id"]:
        raise CollectorError("period and ambiguity captured sources do not share the exact studio, account, generation, payer, and customer binding")
    supplemental = {
        "payer_setup_lifecycle": setup,
        **supplemental_local,
        **supplemental_three,
        "period_advancement": {"method": "stripe_test_clock.advance", "test_clock_id": test_clock["id"], "advances_to": frozen, "observed_provider_boundary": frozen, "direct_database_timestamp_edit": False, "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["period_advancement.provider"], **period_context, "test_clock_id": test_clock["id"], "old_frozen_time": old_frozen, "new_frozen_time": frozen, "status": "advanced", "capture_boundary": boundary}, "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["period_advancement.local"], **period_context, "test_clock_id": test_clock["id"], "schedule_intent_id": schedule["id"], "revoke_intent_id": revoke["id"], "due_intent_id": due["id"], "old_period_boundary": old_frozen, "new_period_boundary": frozen, "due_transition_state": due["state"], "capture_boundary": boundary}},
        "ambiguity_recovery": {"workflow_id": "payer.sync", "durable_operation_id": ambiguity["id"], "provider_mutation_count": ambiguity["provider_request_attempt_count"], "automatic_retry_count": 0, "caller_request_key_sha256": facts_three["ambiguous_caller_key_sha256"], "mutation_step_name": "payer.customer_create", "provider_readback": {"source": validator.SUPPLEMENTAL_SOURCES["ambiguity.provider"], **ambiguity_context, "customer_id": customer["id"], "payer_id": payer["id"], "retrieve_count": 1, "status": "found", "capture_boundary": boundary}, "local_readback": {"source": validator.SUPPLEMENTAL_SOURCES["ambiguity.local"], **ambiguity_context, "durable_operation_id": ambiguity["id"], "resource_claim_id": ambiguity_resource["id"], "resource_revision": ambiguity_resource["revision"], "payer_id": payer["id"], "customer_id": payer["stripe_customer_id"], "status": ambiguity["state"], "capture_boundary": boundary}},
        "platform_fixture": platform,
    }
    packet.update({"workflow_facts": {**facts_two, **facts_three}, "webhook_delivery_evidence": deliveries, "supplemental_evidence": supplemental, "terminal_counts": terminal})
    packet["steps"] = _proof_steps(packet, validator)
    errors = validator.validate_evidence(packet, manifest["candidate_sha"], manifest["readiness_origin"])
    if errors:
        raise CollectorError("assembled evidence failed schema-v4 validation: " + "; ".join(errors))
    # Round-trip through canonical JSON to detach output from every mutable input.
    return json.loads(canonical(packet))


def write_private_atomic(path: Path, rendered: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            descriptor = -1
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--capture-phase", choices=PHASES)
    parser.add_argument("--assemble", nargs="+", metavar="ARTIFACT")
    parser.add_argument("--collect-read-only", action="store_true")
    parser.add_argument("--output", default="-")
    args = parser.parse_args(argv)
    try:
        manifest = validate_manifest(json.loads(Path(args.manifest).read_text()))
        if bool(args.capture_phase) == bool(args.assemble):
            raise CollectorError("choose exactly one of --capture-phase or --assemble")
        if args.assemble:
            if len(args.assemble) != len(PHASES):
                raise CollectorError("--assemble requires the exact six ordered phase artifacts")
            packet = assemble(manifest, [json.loads(Path(path).read_text()) for path in args.assemble])
        else:
            key = validate_live_context(manifest, collect_read_only=args.collect_read_only)
            readiness = verify_readiness(manifest)
            sys.path.insert(0, str(ROOT / "backend"))
            from app.db.supabase import create_supabase_client
            stripe = importlib.import_module("stripe")
            stripe.api_key = key
            packet = capture_phase(manifest, args.capture_phase, readiness=readiness, local_reader=lambda boundary: collect_local(create_supabase_client(), manifest, event_window_ended_at=boundary), provider_reader=lambda phase: collect_provider(stripe, manifest, phase))
        rendered = canonical(packet).decode() + "\n"
        if args.output == "-":
            sys.stdout.write(rendered)
        else:
            path = Path(args.output).resolve()
            if path == ROOT or ROOT in path.parents:
                raise CollectorError("artifact output must stay outside the repository")
            write_private_atomic(path, rendered)
    except (CollectorError, OSError, ValueError) as exc:
        print(f"collector refused: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print("collector refused: sanitized adapter failure", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
