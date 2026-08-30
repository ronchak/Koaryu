#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import urlsplit


SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
EVENT_ID_PATTERN = re.compile(r"^evt_[A-Za-z0-9]+$")
ACCOUNT_ID_PATTERN = re.compile(r"^acct_[A-Za-z0-9]+$")
EVIDENCE_SCHEMA_VERSION = 4
REQUIRED_STEP_ORDER = (
    "health_exact_candidate",
    "operation_bounded_role_capabilities",
    "plan_product_price",
    "payer_customer",
    "payer_consent_duplicate_replay",
    "shared_subscription_quantity_two",
    "invoice_link_finalize_send",
    "automatic_payment_fee_50bps",
    "failed_payment_named_retry",
    "period_end_schedule_revoke_due",
    "refund_dispute_convergence",
    "ambiguous_same_key_readback_recovery",
    "platform_webhook_delivery_readback",
    "connect_webhook_delivery_readback",
    "terminal_zero_counts",
)
REQUIRED_STEPS = set(REQUIRED_STEP_ORDER)
PLATFORM_SCOPED_STEPS = {"platform_webhook_delivery_readback"}
ACCOUNT_SCOPED_STEPS = REQUIRED_STEPS - {"health_exact_candidate"} - PLATFORM_SCOPED_STEPS
REQUIRED_MUTATIONS = {
    "connect.account_create": ("connect.onboarding", "connect_account.create", "connect_onboarding", "admin", False),
    "connect.onboarding_link": ("connect.onboarding", "connect_onboarding_link.create", "connect_onboarding", "admin", True),
    "payer.customer_create": ("payer.sync", "connected_customer.create", "connect_payments", "admin", True),
    "payer.initial_setup_checkout": ("payer.setup", "connected_setup_checkout_session.create", "connect_payments", "front_desk", True),
    "payer.replacement_setup_checkout": ("payer.setup", "connected_setup_checkout_session.create", "connect_payments", "front_desk", True),
    "plan.product_create": ("plan.sync", "connected_product.create", "connect_payments", "admin", True),
    "plan.price_create": ("plan.sync", "connected_price.create", "connect_payments", "admin", True),
    "enrollment.subscription_create": ("enrollment.activate", "connected_subscription.create", "connect_payments", "front_desk", True),
    "enrollment.shared_quantity_update": ("enrollment.activate", "connected_subscription_item.update", "connect_payments", "front_desk", True),
    "invoice_link.invoice_create": ("invoice.create", "connected_invoice.create", "connect_payments", "admin", True),
    "invoice_link.item_create": ("invoice.create", "connected_invoice_item.create", "connect_payments", "admin", True),
    "invoice_link.finalize": ("invoice.finalize", "connected_invoice.finalize", "connect_payments", "admin", True),
    "invoice_link.send": ("invoice.finalize", "connected_invoice.send", "connect_payments", "admin", True),
    "automatic.invoice_create": ("invoice.create", "connected_invoice.create", "connect_payments", "admin", True),
    "automatic.item_create": ("invoice.create", "connected_invoice_item.create", "connect_payments", "admin", True),
    "automatic.finalize": ("invoice.finalize", "connected_invoice.finalize", "connect_payments", "admin", True),
    "invoice_retry.pay": ("invoice.retry", "connected_invoice.pay", "connect_payments", "admin", True),
    "period_end.revoke_schedule_create": ("enrollment.cancel.period_end.schedule", "connected_subscription_schedule.create", "connect_payments", "front_desk", True),
    "period_end.revoke_schedule_update": ("enrollment.cancel.period_end.schedule", "connected_subscription_schedule.update", "connect_payments", "front_desk", True),
    "period_end.revoke_release": ("enrollment.cancel.period_end.revoke", "connected_subscription_schedule.release", "connect_payments", "front_desk", True),
    "period_end.due_schedule_create": ("enrollment.cancel.period_end.schedule", "connected_subscription_schedule.create", "connect_payments", "front_desk", True),
    "period_end.due_schedule_update": ("enrollment.cancel.period_end.schedule", "connected_subscription_schedule.update", "connect_payments", "front_desk", True),
    "period_end.due_release": ("enrollment.cancel.period_end.execute", "connected_subscription_schedule.release", "connect_payments", "internal", True),
    "payment.refund": ("payment.refund", "connected_refund.create", "connect_payments", "admin", True),
}
PLATFORM_EVENTS = {
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
}
CONNECT_EVENTS = {
    "account.updated",
    "account.application.deauthorized",
    "checkout.session.completed",
    "invoice.created",
    "invoice.finalized",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.voided",
    "invoice.marked_uncollectible",
    "payment_intent.processing",
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.refunded",
    "charge.refund.updated",
    "refund.created",
    "refund.failed",
    "refund.updated",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
}
DELIVERY_KEYS = {
    "surface",
    "endpoint_url",
    "connect",
    "event_id",
    "event_type",
    "studio_id",
    "stripe_account_id",
    "connect_account_generation",
    "provider_delivery_status",
    "provider_http_status",
    "local_event_id",
    "local_processing_status",
}
TOP_LEVEL_KEYS = {
    "schema_version",
    "candidate_sha",
    "health_commit_sha",
    "health_ready_url",
    "stripe_mode",
    "livemode",
    "secrets_redacted",
    "financial_canary_performed",
    "studio_id",
    "stripe_account_id",
    "connect_account_generation",
    "steps",
    "mutation_attempts",
    "webhook_delivery_evidence",
    "role_capabilities",
    "workflow_facts",
    "supplemental_evidence",
    "terminal_counts",
}
MUTATION_KEYS = {
    "step_name",
    "workflow_id",
    "operation",
    "actor_role",
    "studio_id",
    "scope",
    "stripe_account_id",
    "automatic_retry_count",
    "outcome",
    "caller_request_key_sha256",
    "provider_mutation_count",
}
ADMIN_WORKFLOWS = ["connect.onboarding", "enrollment.activate", "enrollment.cancel.immediate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "invoice.create", "invoice.finalize", "invoice.retry", "invoice.void", "payer.setup", "payer.sync", "payment.external.record", "payment.refund", "plan.sync"]
FRONT_DESK_WORKFLOWS = ["enrollment.activate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "payer.setup", "payment.external.record"]
ROLE_CAPABILITY_KEYS = {"admin", "front_desk", "instructor"}
TERMINAL_COUNT_KEYS = {"failed", "stuck", "unmapped", "wrong_mode", "wrong_generation", "pending_transition", "reconciliation_required"}
TERMINAL_KEYS = {"capture_boundary", "counts", "wrong_mode_components"}
TERMINAL_ROW_KEYS = {"count", "source", "readback_boundary"}
WRONG_MODE_COMPONENT_KEYS = {"surface", "count", "source", "readback_boundary"}
SUPPLEMENTAL_KEYS = {
    "invoice_void", "immediate_cancellation", "external_payment",
    "unsupported_operations", "failed_payment_retry", "period_advancement",
    "payer_setup_lifecycle", "dispute_lifecycle", "refund_convergence",
    "ambiguity_recovery", "platform_fixture",
}
READBACK_KEYS = {"source", "status", "capture_boundary"}
INVOICE_VOID_PROVIDER_KEYS = {"source", "invoice_id", "durable_operation_id", "stripe_account_id", "connect_account_generation", "status", "capture_boundary"}
INVOICE_VOID_LOCAL_KEYS = INVOICE_VOID_PROVIDER_KEYS
INVOICE_VOID_KEYS = {
    "workflow_id", "operation", "actor_role", "provider_attempt_count", "provider_mutation_count",
    "automatic_retry_count", "caller_request_key_sha256", "durable_operation_id",
    "provider_readback", "local_readback",
}
IMMEDIATE_CANCELLATION_KEYS = INVOICE_VOID_KEYS | {"strategy"}
IMMEDIATE_PROVIDER_KEYS = {"source", "subscription_id", "durable_operation_id", "transition_intent_id", "stripe_account_id", "connect_account_generation", "status", "capture_boundary"}
IMMEDIATE_LOCAL_KEYS = {"source", "subscription_id", "enrollment_id", "durable_operation_id", "transition_intent_id", "stripe_account_id", "connect_account_generation", "transition_state", "enrollment_status", "capture_boundary"}
EXTERNAL_PAYMENT_KEYS = {
    "workflow_id", "local_payment_id", "local_status", "replay_payment_id",
    "caller_request_key_sha256", "replay_outcome", "audit_count", "invoice_id",
    "provider_mutation_count", "studio_id", "stripe_account_id", "connect_account_generation",
    "actor_id", "actor_role", "audit_id", "audit_action", "amount_cents", "currency",
    "external_method", "provider_operation_inventory_readback", "local_readback",
}
EXTERNAL_INVENTORY_KEYS = {"source", "local_payment_id", "studio_id", "stripe_account_id", "connect_account_generation", "caller_request_key_sha256", "matching_provider_operation_count", "status", "capture_boundary"}
EXTERNAL_LOCAL_KEYS = {"source", "local_payment_id", "replay_payment_id", "audit_id", "audit_action", "audit_entity_id", "studio_id", "stripe_account_id", "connect_account_generation", "actor_id", "actor_role", "caller_request_key_sha256", "payment_status", "audit_count", "amount_cents", "currency", "external_method", "invoice_id", "capture_boundary"}
UNSUPPORTED_ROW_KEYS = {
    "subject", "classification", "denial_reason_code", "provider_mutation_count",
    "denial_readback", "provider_operation_inventory_readback",
}
FAILED_RETRY_KEYS = {
    "workflow_id", "operation", "invoice_id", "payment_method_id", "payment_intent_id",
    "charge_id", "amount_cents", "application_fee_cents", "provider_mutation_count",
    "failed_provider_readback", "failed_local_readback", "provider_readback", "local_readback",
}
FAILED_PROVIDER_BEFORE_KEYS = {"source", "invoice_id", "invoice_status", "payment_intent_id", "payment_intent_status", "last_payment_error_present", "capture_boundary"}
FAILED_LOCAL_BEFORE_KEYS = {"source", "invoice_id", "invoice_status", "payment_id", "payment_status", "stripe_invoice_id", "payment_intent_id", "capture_boundary"}
RETRY_PROVIDER_AFTER_KEYS = {"source", "invoice_id", "invoice_status", "payment_intent_id", "payment_intent_status", "charge_id", "charge_status", "payment_method_id", "amount_cents", "application_fee_cents", "capture_boundary"}
RETRY_LOCAL_AFTER_KEYS = {"source", "invoice_id", "invoice_status", "payment_id", "payment_status", "stripe_invoice_id", "payment_intent_id", "charge_id", "payment_method_id", "amount_cents", "application_fee_cents", "capture_boundary"}
PERIOD_ADVANCEMENT_KEYS = {
    "method", "test_clock_id", "advances_to", "observed_provider_boundary",
    "direct_database_timestamp_edit", "provider_readback", "local_readback",
}
PERIOD_PROVIDER_KEYS = {"source", "studio_id", "stripe_account_id", "connect_account_generation", "test_clock_id", "old_frozen_time", "new_frozen_time", "status", "capture_boundary"}
PERIOD_LOCAL_KEYS = {"source", "studio_id", "stripe_account_id", "connect_account_generation", "test_clock_id", "schedule_intent_id", "revoke_intent_id", "due_intent_id", "old_period_boundary", "new_period_boundary", "due_transition_state", "capture_boundary"}
DISPUTE_LIFECYCLE_KEYS = {"dispute_id", "charge_id", "payment_id", "created_event", "closed_event", "provider_readback", "local_readback"}
DISPUTE_EVENT_KEYS = {"event_id", "event_type", "local_event_id", "local_processing_status"}
DISPUTE_LOCAL_READBACK_KEYS = {"source", "status", "state_category", "capture_boundary"}
DISPUTE_PROVIDER_KEYS = {"source", "dispute_id", "charge_id", "amount_cents", "status", "capture_boundary"}
DISPUTE_LOCAL_KEYS = {"source", "dispute_id", "charge_id", "payment_id", "created_event_id", "closed_event_id", "status", "state_category", "disputed_cents", "reconciliation_required", "capture_boundary"}
REFUND_KEYS = {"refund_id", "charge_id", "payment_intent_id", "payment_id", "stripe_account_id", "connect_account_generation", "amount_cents", "provider_readback", "local_readback"}
REFUND_PROVIDER_KEYS = {"source", "refund_id", "charge_id", "payment_intent_id", "status", "amount_cents", "capture_boundary"}
REFUND_LOCAL_KEYS = {"source", "refund_id", "charge_id", "payment_intent_id", "payment_id", "stripe_account_id", "connect_account_generation", "status", "amount_cents", "gross_paid_cents", "refunded_cents", "disputed_cents", "net_collected_cents", "refundable_remaining_cents", "reconciliation_required", "capture_boundary"}
AMBIGUITY_KEYS = {
    "workflow_id", "durable_operation_id", "provider_mutation_count",
    "automatic_retry_count", "caller_request_key_sha256", "mutation_step_name",
    "provider_readback", "local_readback",
}
AMBIGUITY_PROVIDER_KEYS = {"source", "customer_id", "payer_id", "studio_id", "stripe_account_id", "connect_account_generation", "retrieve_count", "status", "capture_boundary"}
AMBIGUITY_LOCAL_KEYS = {"source", "durable_operation_id", "resource_claim_id", "resource_revision", "payer_id", "customer_id", "studio_id", "stripe_account_id", "connect_account_generation", "status", "capture_boundary"}
PLATFORM_FIXTURE_KEYS = {
    "method", "event_id", "event_type", "studio_id", "stripe_account_id",
    "customer_id", "customer_preexisted", "subscription_id", "provider_mutation_count", "cleanup_required", "cleanup_timing",
    "customer_readback", "provider_readback", "local_readback",
}
PLATFORM_CUSTOMER_KEYS = {"source", "customer_id", "metadata_studio_id", "livemode", "created_at", "capture_boundary"}
PLATFORM_PROVIDER_KEYS = {"source", "customer_id", "subscription_id", "metadata_studio_id", "status", "livemode", "created_at", "capture_boundary"}
PLATFORM_LOCAL_KEYS = {"source", "event_id", "event_type", "stripe_account_id", "livemode", "processing_status", "studio_id", "customer_id", "subscription_id", "projected_status", "capture_boundary"}
PAYER_SETUP_KEYS = {"initial", "replacement", "duplicate_completion"}
CONSENT_LIFECYCLE_KEYS = {"payer_id", "stripe_account_id", "connect_account_generation", "setup_request_id", "checkout_session_id", "consent_id", "setup_intent_id", "payment_method_id", "terms_version", "accepted_at", "completed_at", "superseded_at", "revoked_at", "active", "provider_checkout_readback", "provider_setup_intent_readback", "local_readback"}
CHECKOUT_READBACK_KEYS = {"source", "checkout_session_id", "setup_intent_id", "status", "stripe_account_id", "capture_boundary"}
SETUP_INTENT_READBACK_KEYS = {"source", "setup_intent_id", "payment_method_id", "status", "stripe_account_id", "capture_boundary"}
CONSENT_LOCAL_KEYS = {"source", "payer_id", "stripe_account_id", "connect_account_generation", "setup_request_id", "checkout_session_id", "consent_id", "setup_intent_id", "terms_version", "accepted_at", "completed_at", "superseded_at", "revoked_at", "active", "capture_boundary"}
DUPLICATE_COMPLETION_KEYS = {"provider_replay", "local_replay"}
PROVIDER_REPLAY_KEYS = {"source", "event_id", "checkout_session_id", "attempts", "capture_boundary"}
PROVIDER_REPLAY_ATTEMPT_KEYS = {"attempt_id", "role", "endpoint_url", "delivery_status", "http_status", "delivered_at"}
LOCAL_REPLAY_KEYS = {"source", "event_id", "checkout_session_id", "processing_status", "setup_request_id", "setup_request_row_count", "consent_id", "consent_row_count", "setup_intent_id", "provider_operation_id", "provider_operation", "provider_operation_row_count", "capture_boundary"}
UNSUPPORTED_CONTRACT = {
    "enrollment.pause.generic": "named_enrollment_pause_workflow_required",
    "enrollment.resume.generic": "named_enrollment_resume_workflow_required",
    "enrollment.cancel.generic": "named_enrollment_cancellation_workflow_required",
    "connected_customer.default_payment_method.update": "payer_setup_must_not_mutate_customer_default_payment_method",
}
IMMEDIATE_STRATEGIES = {
    "whole_subscription_cancel": "connected_subscription.cancel",
    "shared_item_delete": "connected_subscription_item.delete",
    "shared_item_quantity_decrement": "connected_subscription_item.update",
}
SUPPLEMENTAL_SOURCES = {
    "invoice_void.provider": "stripe.invoice.retrieve",
    "invoice_void.local": "billing_invoices.status",
    "immediate_cancellation.provider": "stripe.subscription.retrieve",
    "immediate_cancellation.local": "billing_enrollment_transition_intents_and_enrollments",
    "external_payment.local": "billing_payments_and_audit",
    "external_payment.inventory": "billing_provider_operation_inventory.payment_external_record",
    "unsupported.denial": "billing_workflow_and_sink_catalog",
    "unsupported.inventory": "billing_provider_operation_inventory.unsupported_subject",
    "failed_payment_retry.failed_provider": "stripe.invoice_and_payment_intent.retrieve.before_retry",
    "failed_payment_retry.failed_local": "public.billing_invoices_and_public.billing_payments.before_retry",
    "failed_payment_retry.provider": "stripe.invoice_payment_intent_and_charge.retrieve.after_retry",
    "failed_payment_retry.local": "public.billing_invoices_and_public.billing_payments.after_retry",
    "period_advancement.provider": "stripe.test_clock.retrieve",
    "period_advancement.local": "billing_enrollment_transition_intents",
    "dispute.provider": "stripe.dispute.retrieve",
    "dispute.local": "public.billing_disputes_and_public.billing_payments",
    "refund.provider": "stripe.refund_and_charge.retrieve",
    "refund.local": "public.billing_refunds_and_public.billing_payments",
    "ambiguity.provider": "stripe.customer.retrieve",
    "ambiguity.local": "billing_provider_operations_and_resources",
    "platform_fixture.provider": "stripe.platform.subscription.retrieve",
    "platform_fixture.customer": "stripe.platform.customer.retrieve",
    "platform_fixture.local": "public.stripe_events_and_public.studio_subscriptions",
    "payer_setup.checkout": "stripe.checkout_session.retrieve",
    "payer_setup.setup_intent": "stripe.setup_intent.retrieve",
    "payer_setup.local": "public.billing_payer_setup_requests_and_public.billing_payer_payment_consents",
    "payer_setup.replay_provider": "stripe.workbench.event_delivery_history",
    "payer_setup.replay_local": "public.stripe_events_public.billing_payer_setup_requests_public.billing_payer_payment_consents_and_public.billing_provider_operations",
}
TERMINAL_SOURCES = {
    "failed": "billing_provider_operations.failed_terminal_count",
    "stuck": "billing_provider_operations.stuck_lease_count",
    "unmapped": "stripe_webhook_events.unmapped_count",
    "wrong_mode": "provider_local_wrong_mode_component_sum",
    "wrong_generation": "billing_connect_generation_mismatch_count",
    "pending_transition": "billing_enrollment_transition_intents.pending_count",
    "reconciliation_required": "billing_reconciliation_required_union_count",
}
WRONG_MODE_SOURCES = {
    "provider": "stripe_test_mode_object_inventory.wrong_mode_count",
    "local": "stripe_webhook_events.wrong_mode_count",
}
WORKFLOW_FACT_KEYS = {
    "product_id", "price_id", "payer_id", "customer_id",
    "initial_consent_payer_id", "initial_setup_request_id", "initial_consent_id",
    "initial_setup_intent_id", "initial_payment_method_id", "initial_terms_version",
    "initial_checkout_session_id",
    "replacement_consent_payer_id", "replacement_setup_request_id", "replacement_consent_id",
    "replacement_setup_intent_id", "replacement_payment_method_id", "replacement_terms_version",
    "replacement_checkout_session_id", "duplicate_consent_completion_target_id", "student_ids",
    "subscription_id", "subscription_item_id", "shared_provider_quantity",
    "shared_local_active_count", "invoice_link_id", "invoice_link_stripe_id",
    "invoice_link_finalized", "invoice_link_sent", "automatic_invoice_id", "automatic_invoice_stripe_id",
    "automatic_payment_intent_id", "automatic_charge_id", "automatic_amount_cents",
    "application_fee_bps", "provider_application_fee_cents", "failed_payment_invoice_id",
    "failed_payment_retry_workflow", "failed_payment_retry_outcome",
    "failed_payment_retry_mutation_count", "period_schedule_state", "period_revoke_state",
    "period_due_state", "period_schedule_intent_id", "period_revoke_intent_id",
    "period_due_intent_id", "period_revoke_schedule_id", "period_due_schedule_id",
    "period_strategy", "period_quantity_before",
    "period_quantity_after", "adjusted_payment_id", "refund_id", "dispute_id",
    "gross_paid_cents", "refunded_cents", "disputed_cents", "net_collected_cents",
    "refundable_remaining_cents", "invoice_remaining_before_cents",
    "invoice_remaining_after_cents", "payer_status_before", "payer_status_after",
    "adjustment_reconciliation_required", "ambiguous_mutation_step_name",
    "ambiguous_caller_key_sha256", "ambiguous_provider_mutation_count",
    "ambiguous_automatic_retry_count", "ambiguous_provider_readback_count",
    "ambiguous_recovery_outcome", "ambiguous_final_state",
}


def _strict_https_origin(value: str) -> str | None:
    if not isinstance(value, str) or value != value.strip() or any(ord(char) < 32 for char in value):
        return None
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        return None
    origin = f"https://{parsed.netloc}"
    return origin if value.rstrip("/") == origin else None


def _exact_object(value: Any, keys: set[str], label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        errors.append(f"{label} must contain only its exact schema-v4 fields")
        return {}
    return value


def _validate_readback(value: Any, *, label: str, boundary: str, expected_source: str, expected_status: str, errors: list[str]) -> None:
    row = _exact_object(value, READBACK_KEYS, label, errors)
    if not row:
        return
    if row.get("source") != expected_source:
        errors.append(f"{label} does not use its canonical source")
    if row.get("status") != expected_status:
        errors.append(f"{label} has the wrong status")
    if row.get("capture_boundary") != boundary:
        errors.append(f"{label} does not match the shared capture boundary")


def _timestamp(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value) is not None


def _utc_timestamp_value(value: Any) -> datetime | None:
    if not _timestamp(value):
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return parsed


def _validate_supplemental(value: Any, *, boundary: str, studio_id: str, account_id: str, account_generation: int, workflow_facts: dict[str, Any], errors: list[str]) -> None:
    supplemental = _exact_object(value, SUPPLEMENTAL_KEYS, "supplemental evidence", errors)
    if not supplemental:
        return
    serialized = json.dumps(supplemental, sort_keys=True)
    string_values: list[str] = []
    pending: list[Any] = [supplemental]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, str):
            string_values.append(item)
    has_card_value = any(
        13 <= len(re.sub(r"[ -]", "", item)) <= 19
        and re.fullmatch(r"[0-9 -]+", item) is not None
        for item in string_values
    )
    raw_urls = [item for item in string_values if re.search(r"https?://", item, re.IGNORECASE)]
    allowed_replay_urls = all(
        re.fullmatch(r"https://[^/?#]+/api/v1/webhooks/stripe/connect", item) is not None
        for item in raw_urls
    )
    if (raw_urls and not allowed_replay_urls) or re.search(r"\b(?:sk|pk)_(?:test|live)_|client_secret", serialized, re.IGNORECASE) or has_card_value:
        errors.append("supplemental evidence contains a raw URL, secret, or payment-card value")

    void = _exact_object(supplemental.get("invoice_void"), INVOICE_VOID_KEYS, "invoice void evidence", errors)
    if void and ((void.get("workflow_id"), void.get("operation"), void.get("actor_role"), void.get("provider_attempt_count"), void.get("provider_mutation_count"), void.get("automatic_retry_count")) != ("invoice.void", "connected_invoice.void", "admin", 1, 1, 0) or not re.fullmatch(r"[0-9a-f]{64}", str(void.get("caller_request_key_sha256") or "")) or not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", str(void.get("durable_operation_id") or ""))):
        errors.append("invoice void evidence must prove one exact Admin connected_invoice.void mutation")
    void_provider = _exact_object(void.get("provider_readback"), INVOICE_VOID_PROVIDER_KEYS, "invoice void provider readback", errors)
    void_local = _exact_object(void.get("local_readback"), INVOICE_VOID_LOCAL_KEYS, "invoice void local readback", errors)
    void_binding = tuple(void_provider.get(key) for key in ("invoice_id", "durable_operation_id", "stripe_account_id", "connect_account_generation"))
    if void_provider and (void_provider.get("source") != SUPPLEMENTAL_SOURCES["invoice_void.provider"] or void_provider.get("status") != "void" or void_provider.get("durable_operation_id") != void.get("durable_operation_id") or void_provider.get("capture_boundary") != boundary): errors.append("invoice void provider readback must use its canonical source and bind the exact voided invoice and durable operation")
    if void_local and (void_local.get("source") != SUPPLEMENTAL_SOURCES["invoice_void.local"] or void_local.get("status") != "void" or tuple(void_local.get(key) for key in ("invoice_id", "durable_operation_id", "stripe_account_id", "connect_account_generation")) != void_binding or void_local.get("capture_boundary") != boundary): errors.append("invoice void local readback must bind the exact terminal invoice and durable operation")

    immediate = _exact_object(supplemental.get("immediate_cancellation"), IMMEDIATE_CANCELLATION_KEYS, "immediate cancellation evidence", errors)
    strategy = immediate.get("strategy")
    if immediate and (strategy not in IMMEDIATE_STRATEGIES or immediate.get("operation") != IMMEDIATE_STRATEGIES.get(strategy) or immediate.get("workflow_id") != "enrollment.cancel.immediate" or immediate.get("actor_role") != "admin" or immediate.get("provider_attempt_count") != 1 or immediate.get("provider_mutation_count") != 1 or immediate.get("automatic_retry_count") != 0 or not re.fullmatch(r"[0-9a-f]{64}", str(immediate.get("caller_request_key_sha256") or "")) or not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", str(immediate.get("durable_operation_id") or ""))):
        errors.append("immediate cancellation evidence has the wrong strategy or operation")
    immediate_provider = _exact_object(immediate.get("provider_readback"), IMMEDIATE_PROVIDER_KEYS, "immediate cancellation provider readback", errors)
    immediate_local = _exact_object(immediate.get("local_readback"), IMMEDIATE_LOCAL_KEYS, "immediate cancellation local readback", errors)
    immediate_binding = tuple(immediate_provider.get(key) for key in ("subscription_id", "durable_operation_id", "transition_intent_id", "stripe_account_id", "connect_account_generation"))
    if immediate_provider and (immediate_provider.get("source") != SUPPLEMENTAL_SOURCES["immediate_cancellation.provider"] or immediate_provider.get("status") != "canceled" or immediate_provider.get("durable_operation_id") != immediate.get("durable_operation_id") or immediate_provider.get("capture_boundary") != boundary): errors.append("immediate cancellation provider readback must bind the exact canceled subscription, intent, and operation")
    if immediate_local and (immediate_local.get("source") != SUPPLEMENTAL_SOURCES["immediate_cancellation.local"] or immediate_local.get("transition_state") != "completed" or immediate_local.get("enrollment_status") != "canceled" or tuple(immediate_local.get(key) for key in ("subscription_id", "durable_operation_id", "transition_intent_id", "stripe_account_id", "connect_account_generation")) != immediate_binding or not immediate_local.get("enrollment_id") or immediate_local.get("capture_boundary") != boundary): errors.append("immediate cancellation local readback must bind the exact canceled enrollment, intent, and operation")

    external = _exact_object(supplemental.get("external_payment"), EXTERNAL_PAYMENT_KEYS, "external payment evidence", errors)
    external_scope = (external.get("local_payment_id"), external.get("studio_id"), external.get("stripe_account_id"), external.get("connect_account_generation"), external.get("caller_request_key_sha256"))
    if external and (external.get("workflow_id") != "payment.external.record" or external.get("local_status") != "externally_recorded" or not external.get("local_payment_id") or external.get("replay_payment_id") != external.get("local_payment_id") or not re.fullmatch(r"[0-9a-f]{64}", str(external.get("caller_request_key_sha256") or "")) or external.get("replay_outcome") != "same_row" or external.get("audit_count") != 1 or external.get("invoice_id") is not None or external.get("provider_mutation_count") != 0 or external.get("studio_id") != studio_id or external.get("stripe_account_id") != account_id or external.get("connect_account_generation") != account_generation or external.get("actor_role") not in {"admin", "front_desk"} or not external.get("actor_id") or not external.get("audit_id") or external.get("audit_action") != "billing.external_payment_recorded" or type(external.get("amount_cents")) is not int or external.get("amount_cents") <= 0 or not external.get("currency") or not external.get("external_method")):
        errors.append("external payment must replay to one local externally_recorded row and one audit with no invoice or provider mutation")
    external_inventory = _exact_object(external.get("provider_operation_inventory_readback"), EXTERNAL_INVENTORY_KEYS, "external payment provider-operation inventory readback", errors)
    external_local = _exact_object(external.get("local_readback"), EXTERNAL_LOCAL_KEYS, "external payment local readback", errors)
    if external_inventory and (external_inventory.get("source") != SUPPLEMENTAL_SOURCES["external_payment.inventory"] or tuple(external_inventory.get(key) for key in ("local_payment_id", "studio_id", "stripe_account_id", "connect_account_generation", "caller_request_key_sha256")) != external_scope or external_inventory.get("matching_provider_operation_count") != 0 or external_inventory.get("status") != "zero" or external_inventory.get("capture_boundary") != boundary): errors.append("external payment inventory must prove zero provider operations for the exact payment scope")
    if external_local and (external_local.get("source") != SUPPLEMENTAL_SOURCES["external_payment.local"] or tuple(external_local.get(key) for key in ("local_payment_id", "studio_id", "stripe_account_id", "connect_account_generation", "caller_request_key_sha256")) != external_scope or external_local.get("replay_payment_id") != external.get("replay_payment_id") or (external_local.get("audit_id"), external_local.get("audit_action"), external_local.get("audit_entity_id")) != (external.get("audit_id"), external.get("audit_action"), external.get("local_payment_id")) or (external_local.get("actor_id"), external_local.get("actor_role")) != (external.get("actor_id"), external.get("actor_role")) or external_local.get("payment_status") != "externally_recorded" or external_local.get("audit_count") != 1 or tuple(external_local.get(key) for key in ("amount_cents", "currency", "external_method", "invoice_id")) != tuple(external.get(key) for key in ("amount_cents", "currency", "external_method", "invoice_id")) or external_local.get("capture_boundary") != boundary): errors.append("external payment local readback must bind the exact payment, audit, actor, and scope")

    unsupported = supplemental.get("unsupported_operations")
    if not isinstance(unsupported, list) or len(unsupported) != len(UNSUPPORTED_CONTRACT):
        errors.append("unsupported operation evidence must contain the exact four denied subjects")
    else:
        by_subject = {row.get("subject"): row for row in unsupported if isinstance(row, dict)}
        if len(by_subject) != len(unsupported) or set(by_subject) != set(UNSUPPORTED_CONTRACT):
            errors.append("unsupported operation evidence must contain the exact four denied subjects")
        for subject, reason in UNSUPPORTED_CONTRACT.items():
            row = _exact_object(by_subject.get(subject), UNSUPPORTED_ROW_KEYS, f"unsupported operation {subject}", errors)
            if row and (row.get("classification"), row.get("denial_reason_code"), row.get("provider_mutation_count")) != ("unsupported", reason, 0):
                errors.append(f"unsupported operation {subject} has the wrong denial contract or provider activity")
            _validate_readback(row.get("denial_readback"), label=f"unsupported operation {subject} denial readback", boundary=boundary, expected_source=SUPPLEMENTAL_SOURCES["unsupported.denial"], expected_status="denied", errors=errors)
            _validate_readback(row.get("provider_operation_inventory_readback"), label=f"unsupported operation {subject} provider-operation inventory readback", boundary=boundary, expected_source=SUPPLEMENTAL_SOURCES["unsupported.inventory"], expected_status="zero", errors=errors)

    setup = _exact_object(supplemental.get("payer_setup_lifecycle"), PAYER_SETUP_KEYS, "payer setup lifecycle evidence", errors)
    for phase in ("initial", "replacement"):
        lifecycle = _exact_object(setup.get(phase), CONSENT_LIFECYCLE_KEYS, f"{phase} payer setup lifecycle", errors)
        checkout = _exact_object(lifecycle.get("provider_checkout_readback"), CHECKOUT_READBACK_KEYS, f"{phase} Checkout readback", errors)
        intent = _exact_object(lifecycle.get("provider_setup_intent_readback"), SETUP_INTENT_READBACK_KEYS, f"{phase} SetupIntent readback", errors)
        local = _exact_object(lifecycle.get("local_readback"), CONSENT_LOCAL_KEYS, f"{phase} setup/consent local readback", errors)
        common = (lifecycle.get("payer_id"), lifecycle.get("stripe_account_id"), lifecycle.get("connect_account_generation"), lifecycle.get("setup_request_id"), lifecycle.get("checkout_session_id"), lifecycle.get("consent_id"), lifecycle.get("setup_intent_id"), lifecycle.get("payment_method_id"), lifecycle.get("terms_version"), lifecycle.get("accepted_at"), lifecycle.get("completed_at"), lifecycle.get("superseded_at"), lifecycle.get("revoked_at"), lifecycle.get("active"))
        local_common = tuple(local.get(key) for key in ("payer_id", "stripe_account_id", "connect_account_generation", "setup_request_id", "checkout_session_id", "consent_id", "setup_intent_id", "terms_version", "accepted_at", "completed_at", "superseded_at", "revoked_at", "active"))
        durable_common = tuple(lifecycle.get(key) for key in ("payer_id", "stripe_account_id", "connect_account_generation", "setup_request_id", "checkout_session_id", "consent_id", "setup_intent_id", "terms_version", "accepted_at", "completed_at", "superseded_at", "revoked_at", "active"))
        if durable_common != local_common or not _timestamp(lifecycle.get("accepted_at")) or not _timestamp(lifecycle.get("completed_at")):
            errors.append(f"{phase} setup lifecycle must match its exact local setup and consent row")
        if checkout and (checkout.get("source") != SUPPLEMENTAL_SOURCES["payer_setup.checkout"] or checkout.get("checkout_session_id") != lifecycle.get("checkout_session_id") or checkout.get("setup_intent_id") != lifecycle.get("setup_intent_id") or checkout.get("status") != "complete" or checkout.get("stripe_account_id") != lifecycle.get("stripe_account_id") or checkout.get("capture_boundary") != boundary):
            errors.append(f"{phase} Checkout readback does not bind the lifecycle")
        if intent and (intent.get("source") != SUPPLEMENTAL_SOURCES["payer_setup.setup_intent"] or intent.get("setup_intent_id") != lifecycle.get("setup_intent_id") or intent.get("payment_method_id") != lifecycle.get("payment_method_id") or intent.get("status") != "succeeded" or intent.get("stripe_account_id") != lifecycle.get("stripe_account_id") or intent.get("capture_boundary") != boundary):
            errors.append(f"{phase} SetupIntent readback does not bind the lifecycle")
        if local and (local.get("source") != SUPPLEMENTAL_SOURCES["payer_setup.local"] or local.get("capture_boundary") != boundary):
            errors.append(f"{phase} local setup/consent readback has the wrong source or boundary")
    initial, replacement = setup.get("initial", {}), setup.get("replacement", {})
    if initial and (not _timestamp(initial.get("superseded_at")) or initial.get("revoked_at") is not None or initial.get("active") is not False):
        errors.append("initial consent must be superseded and inactive")
    if replacement and (replacement.get("superseded_at") is not None or replacement.get("revoked_at") is not None or replacement.get("active") is not True):
        errors.append("replacement consent must remain active and unsuperseded")
    duplicate = _exact_object(setup.get("duplicate_completion"), DUPLICATE_COMPLETION_KEYS, "duplicate setup completion", errors)
    provider_replay = _exact_object(duplicate.get("provider_replay"), PROVIDER_REPLAY_KEYS, "duplicate provider replay", errors)
    attempts = provider_replay.get("attempts")
    if not isinstance(attempts, list) or len(attempts) != 2:
        errors.append("duplicate provider replay must contain exactly two delivery attempts")
    else:
        attempt_ids = set()
        for index, attempt in enumerate(attempts):
            row = _exact_object(attempt, PROVIDER_REPLAY_ATTEMPT_KEYS, "duplicate provider delivery attempt", errors)
            attempt_ids.add(row.get("attempt_id"))
            expected_role = ("original", "manual_resend")[index]
            if row and (not row.get("attempt_id") or row.get("role") != expected_role or row.get("delivery_status") != "delivered" or type(row.get("http_status")) is not int or not 200 <= row.get("http_status") <= 299 or _utc_timestamp_value(row.get("delivered_at")) is None):
                errors.append("duplicate provider delivery attempt must use ordered original/manual_resend roles, UTC delivery timestamps, and distinct delivered 2xx attempts")
        if len(attempt_ids) != 2:
            errors.append("duplicate provider delivery attempt IDs must be distinct")
        original_at = _utc_timestamp_value(attempts[0].get("delivered_at"))
        resend_at = _utc_timestamp_value(attempts[1].get("delivered_at"))
        if original_at is not None and resend_at is not None and original_at >= resend_at:
            errors.append("original provider delivery timestamp must precede the manual resend timestamp")
    if provider_replay and (provider_replay.get("source") != SUPPLEMENTAL_SOURCES["payer_setup.replay_provider"] or not EVENT_ID_PATTERN.fullmatch(str(provider_replay.get("event_id") or "")) or provider_replay.get("capture_boundary") != boundary):
        errors.append("duplicate provider replay must use Stripe delivery history at the shared boundary")
    local_replay = _exact_object(duplicate.get("local_replay"), LOCAL_REPLAY_KEYS, "duplicate local replay", errors)
    if local_replay and (local_replay.get("source") != SUPPLEMENTAL_SOURCES["payer_setup.replay_local"] or local_replay.get("processing_status") != "processed" or local_replay.get("setup_request_row_count") != 1 or local_replay.get("consent_row_count") != 1 or local_replay.get("provider_operation_row_count") != 1 or local_replay.get("provider_operation") != "connected_setup_checkout_session.create" or not local_replay.get("provider_operation_id") or local_replay.get("capture_boundary") != boundary):
        errors.append("duplicate local replay must prove one processed event and one replacement setup, consent, and provider operation row")

    retry = _exact_object(supplemental.get("failed_payment_retry"), FAILED_RETRY_KEYS, "failed-payment retry evidence", errors)
    if retry and ((retry.get("workflow_id"), retry.get("operation")) != ("invoice.retry", "connected_invoice.pay") or retry.get("provider_mutation_count") != 1):
        errors.append("failed-payment retry evidence must prove the sole successful connected_invoice.pay mutation")
    before_provider = _exact_object(retry.get("failed_provider_readback"), FAILED_PROVIDER_BEFORE_KEYS, "failed-payment pre-retry provider readback", errors)
    before_local = _exact_object(retry.get("failed_local_readback"), FAILED_LOCAL_BEFORE_KEYS, "failed-payment pre-retry local readback", errors)
    after_provider = _exact_object(retry.get("provider_readback"), RETRY_PROVIDER_AFTER_KEYS, "failed-payment retry provider readback", errors)
    after_local = _exact_object(retry.get("local_readback"), RETRY_LOCAL_AFTER_KEYS, "failed-payment retry local readback", errors)
    if before_provider and (before_provider.get("source") != SUPPLEMENTAL_SOURCES["failed_payment_retry.failed_provider"] or before_provider.get("invoice_status") != "open" or before_provider.get("payment_intent_status") != "requires_payment_method" or before_provider.get("last_payment_error_present") is not True or before_provider.get("capture_boundary") != boundary): errors.append("pre-retry provider state must be open Invoice plus PaymentIntent requires_payment_method with an error")
    if before_local and (before_local.get("source") != SUPPLEMENTAL_SOURCES["failed_payment_retry.failed_local"] or before_local.get("invoice_status") != "open" or before_local.get("payment_status") != "failed" or before_local.get("capture_boundary") != boundary): errors.append("pre-retry local state must be open invoice plus failed payment")
    if after_provider and (after_provider.get("source") != SUPPLEMENTAL_SOURCES["failed_payment_retry.provider"] or (after_provider.get("invoice_status"), after_provider.get("payment_intent_status"), after_provider.get("charge_status")) != ("paid", "succeeded", "succeeded") or after_provider.get("capture_boundary") != boundary): errors.append("post-retry provider state must prove paid Invoice, succeeded PaymentIntent, and succeeded Charge")
    if after_local and (after_local.get("source") != SUPPLEMENTAL_SOURCES["failed_payment_retry.local"] or (after_local.get("invoice_status"), after_local.get("payment_status")) != ("paid", "succeeded") or after_local.get("capture_boundary") != boundary): errors.append("post-retry local state must prove paid invoice and succeeded payment")

    period = _exact_object(supplemental.get("period_advancement"), PERIOD_ADVANCEMENT_KEYS, "period advancement evidence", errors)
    if period and (period.get("method") != "stripe_test_clock.advance" or not str(period.get("test_clock_id", "")).startswith("clock_") or type(period.get("advances_to")) is not int or period.get("advances_to") <= 0 or period.get("observed_provider_boundary") != period.get("advances_to") or period.get("direct_database_timestamp_edit") is not False):
        errors.append("period advancement must use Stripe test-clock advancement without direct database timestamp editing")
    period_provider = _exact_object(period.get("provider_readback"), PERIOD_PROVIDER_KEYS, "period advancement provider readback", errors)
    period_local = _exact_object(period.get("local_readback"), PERIOD_LOCAL_KEYS, "period advancement local readback", errors)
    period_context = tuple(period_provider.get(key) for key in ("studio_id", "stripe_account_id", "connect_account_generation", "test_clock_id"))
    if period_provider and (period_provider.get("source") != SUPPLEMENTAL_SOURCES["period_advancement.provider"] or period_context != (studio_id, account_id, account_generation, period.get("test_clock_id")) or period_provider.get("status") != "advanced" or period_provider.get("new_frozen_time") != period.get("advances_to") or type(period_provider.get("old_frozen_time")) is not int or period_provider.get("old_frozen_time") >= period_provider.get("new_frozen_time") or period_provider.get("capture_boundary") != boundary): errors.append("period provider readback must bind the exact Test Clock advancement boundary")
    if period_local and (period_local.get("source") != SUPPLEMENTAL_SOURCES["period_advancement.local"] or tuple(period_local.get(key) for key in ("studio_id", "stripe_account_id", "connect_account_generation", "test_clock_id")) != period_context or tuple(period_local.get(key) for key in ("schedule_intent_id", "revoke_intent_id", "due_intent_id")) != tuple(workflow_facts.get(key) for key in ("period_schedule_intent_id", "period_revoke_intent_id", "period_due_intent_id")) or period_local.get("old_period_boundary") != period_provider.get("old_frozen_time") or period_local.get("new_period_boundary") != period_provider.get("new_frozen_time") or period_local.get("due_transition_state") != "completed" or period_local.get("capture_boundary") != boundary): errors.append("period local readback must bind the exact intents and completed due transition")

    dispute = _exact_object(supplemental.get("dispute_lifecycle"), DISPUTE_LIFECYCLE_KEYS, "dispute lifecycle evidence", errors)
    created = _exact_object(dispute.get("created_event"), DISPUTE_EVENT_KEYS, "dispute created event", errors)
    closed = _exact_object(dispute.get("closed_event"), DISPUTE_EVENT_KEYS, "dispute closed event", errors)
    event_contract_ok = True
    for row, event_type in ((created, "charge.dispute.created"), (closed, "charge.dispute.closed")):
        if not EVENT_ID_PATTERN.fullmatch(str(row.get("event_id") or "")) or row.get("event_type") != event_type or row.get("local_event_id") != row.get("event_id") or row.get("local_processing_status") != "processed":
            event_contract_ok = False
    if created.get("event_id") == closed.get("event_id"):
        event_contract_ok = False
    if dispute and (not str(dispute.get("dispute_id", "")).startswith("dp_") or not event_contract_ok):
        errors.append("dispute evidence must prove one created-to-closed lifecycle")
    provider_dispute = _exact_object(dispute.get("provider_readback"), DISPUTE_PROVIDER_KEYS, "dispute provider readback", errors)
    local_dispute = _exact_object(dispute.get("local_readback"), DISPUTE_LOCAL_KEYS, "dispute local readback", errors)
    if provider_dispute and (provider_dispute.get("source") != SUPPLEMENTAL_SOURCES["dispute.provider"] or provider_dispute.get("status") != "won" or provider_dispute.get("capture_boundary") != boundary):
        errors.append("dispute provider readback must prove the exact won dispute")
    if local_dispute and (local_dispute.get("source") != SUPPLEMENTAL_SOURCES["dispute.local"] or local_dispute.get("status") != "won" or local_dispute.get("state_category") != "won" or local_dispute.get("disputed_cents") != 0 or local_dispute.get("reconciliation_required") is not False or local_dispute.get("capture_boundary") != boundary):
        errors.append("dispute local readback must prove won, zero disputed cents, and no reconciliation")

    refund = _exact_object(supplemental.get("refund_convergence"), REFUND_KEYS, "refund convergence evidence", errors)
    provider_refund = _exact_object(refund.get("provider_readback"), REFUND_PROVIDER_KEYS, "refund provider readback", errors)
    local_refund = _exact_object(refund.get("local_readback"), REFUND_LOCAL_KEYS, "refund local readback", errors)
    if provider_refund and (provider_refund.get("source") != SUPPLEMENTAL_SOURCES["refund.provider"] or provider_refund.get("status") != "succeeded" or provider_refund.get("amount_cents") != 1000 or provider_refund.get("capture_boundary") != boundary): errors.append("refund provider readback must prove the exact succeeded 1000-cent refund")
    if local_refund and (local_refund.get("source") != SUPPLEMENTAL_SOURCES["refund.local"] or local_refund.get("status") != "succeeded" or tuple(local_refund.get(k) for k in ("amount_cents", "gross_paid_cents", "refunded_cents", "disputed_cents", "net_collected_cents", "refundable_remaining_cents")) != (1000, 10000, 1000, 0, 9000, 9000) or local_refund.get("reconciliation_required") is not False or local_refund.get("capture_boundary") != boundary): errors.append("refund local readback must prove exact succeeded accounting without reconciliation")

    ambiguity = _exact_object(supplemental.get("ambiguity_recovery"), AMBIGUITY_KEYS, "ambiguity recovery evidence", errors)
    if ambiguity and (ambiguity.get("workflow_id") != "payer.sync" or not ambiguity.get("durable_operation_id") or ambiguity.get("provider_mutation_count") != 1 or ambiguity.get("automatic_retry_count") != 0):
        errors.append("ambiguity recovery must bind one durable parent operation with one mutation and zero retries")
    ambiguity_provider = _exact_object(ambiguity.get("provider_readback"), AMBIGUITY_PROVIDER_KEYS, "ambiguity provider readback", errors)
    ambiguity_local = _exact_object(ambiguity.get("local_readback"), AMBIGUITY_LOCAL_KEYS, "ambiguity local readback", errors)
    ambiguity_binding = tuple(ambiguity_provider.get(key) for key in ("payer_id", "customer_id", "studio_id", "stripe_account_id", "connect_account_generation"))
    if ambiguity_provider and (ambiguity_provider.get("source") != SUPPLEMENTAL_SOURCES["ambiguity.provider"] or ambiguity_binding != (workflow_facts.get("payer_id"), workflow_facts.get("customer_id"), studio_id, account_id, account_generation) or ambiguity_provider.get("status") != "found" or ambiguity_provider.get("retrieve_count") != 1 or ambiguity_provider.get("capture_boundary") != boundary): errors.append("ambiguity provider readback must bind one exact hosted customer retrieve")
    if ambiguity_local and (ambiguity_local.get("source") != SUPPLEMENTAL_SOURCES["ambiguity.local"] or ambiguity_local.get("durable_operation_id") != ambiguity.get("durable_operation_id") or ambiguity_local.get("resource_revision") != 1 or not ambiguity_local.get("resource_claim_id") or tuple(ambiguity_local.get(key) for key in ("payer_id", "customer_id", "studio_id", "stripe_account_id", "connect_account_generation")) != ambiguity_binding or ambiguity_local.get("status") != "completed" or ambiguity_local.get("capture_boundary") != boundary): errors.append("ambiguity local readback must bind the parent operation, resource claim, payer, and customer")

    platform = _exact_object(supplemental.get("platform_fixture"), PLATFORM_FIXTURE_KEYS, "platform fixture evidence", errors)
    if platform and (
        platform.get("method") != "stripe.platform.subscription.create"
        or platform.get("event_type") != "customer.subscription.created"
        or platform.get("stripe_account_id") is not None
        or platform.get("customer_preexisted") is not True
        or platform.get("provider_mutation_count") != 1
        or platform.get("cleanup_required") is not True
        or platform.get("cleanup_timing") != "after_evidence_validation"
        or not EVENT_ID_PATTERN.fullmatch(str(platform.get("event_id") or ""))
        or not str(platform.get("customer_id", "")).startswith("cus_")
        or not str(platform.get("subscription_id", "")).startswith("sub_")
    ):
        errors.append("platform fixture must prove one owned TEST platform subscription create and required cleanup")
    platform_customer = _exact_object(platform.get("customer_readback"), PLATFORM_CUSTOMER_KEYS, "platform fixture customer readback", errors)
    platform_provider = _exact_object(platform.get("provider_readback"), PLATFORM_PROVIDER_KEYS, "platform fixture provider readback", errors)
    platform_local = _exact_object(platform.get("local_readback"), PLATFORM_LOCAL_KEYS, "platform fixture local readback", errors)
    if platform_customer and (platform_customer.get("source") != SUPPLEMENTAL_SOURCES["platform_fixture.customer"] or platform_customer.get("customer_id") != platform.get("customer_id") or platform_customer.get("metadata_studio_id") != platform.get("studio_id") or platform_customer.get("livemode") is not False or type(platform_customer.get("created_at")) is not int or platform_customer.get("created_at") <= 0 or platform_customer.get("capture_boundary") != boundary): errors.append("platform customer readback must prove the pre-existing owned TEST customer")
    if platform_provider and (platform_provider.get("source") != SUPPLEMENTAL_SOURCES["platform_fixture.provider"] or platform_provider.get("customer_id") != platform.get("customer_id") or platform_provider.get("subscription_id") != platform.get("subscription_id") or platform_provider.get("metadata_studio_id") != platform.get("studio_id") or platform_provider.get("status") != "active" or platform_provider.get("livemode") is not False or type(platform_provider.get("created_at")) is not int or platform_provider.get("created_at") <= 0 or platform_provider.get("capture_boundary") != boundary): errors.append("platform provider readback must prove the owned TEST subscription")
    if platform_customer and platform_provider and platform_customer.get("created_at") >= platform_provider.get("created_at"):
        errors.append("platform customer must predate the fixture subscription")
    if platform_local and (platform_local.get("source") != SUPPLEMENTAL_SOURCES["platform_fixture.local"] or platform_local.get("event_id") != platform.get("event_id") or platform_local.get("event_type") != platform.get("event_type") or platform_local.get("stripe_account_id") is not None or platform_local.get("livemode") is not False or platform_local.get("processing_status") != "processed" or platform_local.get("studio_id") != platform.get("studio_id") or platform_local.get("customer_id") != platform.get("customer_id") or platform_local.get("subscription_id") != platform.get("subscription_id") or platform_local.get("projected_status") != "active" or platform_local.get("capture_boundary") != boundary): errors.append("platform local readback must bind public.stripe_events to public.studio_subscriptions")


def _validate_delivery(
    delivery: Any,
    *,
    surface: str,
    endpoint_url: str,
    studio_id: str,
    account_id: str,
    account_generation: int,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(delivery, dict) or set(delivery) != DELIVERY_KEYS:
        return [f"{surface} webhook evidence must contain the exact sanitized delivery/readback fields"]
    if delivery.get("surface") != surface:
        errors.append(f"{surface} webhook evidence has the wrong surface")
    if delivery.get("endpoint_url") != endpoint_url:
        errors.append(f"{surface} webhook evidence does not match the pinned endpoint URL")
    expected_connect = surface == "connect"
    if delivery.get("connect") is not expected_connect:
        errors.append(f"{surface} webhook evidence has the wrong Connect delivery flag")
    event_id = delivery.get("event_id")
    if not isinstance(event_id, str) or not EVENT_ID_PATTERN.fullmatch(event_id):
        errors.append(f"{surface} webhook evidence lacks a sanitized provider event ID")
    expected_events = CONNECT_EVENTS if expected_connect else PLATFORM_EVENTS
    if delivery.get("event_type") not in expected_events:
        errors.append(f"{surface} webhook evidence uses an event outside the documented endpoint contract")
    if delivery.get("studio_id") != studio_id:
        errors.append(f"{surface} webhook evidence does not match the rehearsal studio")
    if expected_connect:
        if delivery.get("stripe_account_id") != account_id:
            errors.append("Connect webhook evidence does not match the rehearsal account")
        if delivery.get("connect_account_generation") != account_generation:
            errors.append("Connect webhook evidence does not match the rehearsal account generation")
    else:
        if "stripe_account_id" not in delivery or delivery.get("stripe_account_id") is not None:
            errors.append("platform webhook evidence must explicitly use platform account context")
        if "connect_account_generation" not in delivery or delivery.get("connect_account_generation") is not None:
            errors.append("platform webhook evidence must not claim a Connect account generation")
    if delivery.get("provider_delivery_status") != "delivered":
        errors.append(f"{surface} webhook evidence lacks provider delivery success")
    http_status = delivery.get("provider_http_status")
    if type(http_status) is not int or not 200 <= http_status <= 299:
        errors.append(f"{surface} webhook evidence lacks a provider-observed 2xx response")
    if delivery.get("local_event_id") != event_id:
        errors.append(f"{surface} webhook local readback does not match the provider event ID")
    if delivery.get("local_processing_status") != "processed":
        errors.append(f"{surface} webhook local readback is not fully processed")
    return errors


def validate_evidence(
    evidence: dict[str, Any],
    expected_sha: str,
    expected_backend_origin: str,
) -> list[str]:
    errors: list[str] = []
    origin = _strict_https_origin(expected_backend_origin)
    if not SHA_PATTERN.fullmatch(expected_sha):
        return ["expected candidate SHA must be exact lowercase 40-character hex"]
    if origin is None:
        return ["expected backend origin must be one exact HTTPS origin"]
    if set(evidence) != TOP_LEVEL_KEYS:
        errors.append("rehearsal evidence must contain only the exact sanitized schema fields")
    if evidence.get("schema_version") != EVIDENCE_SCHEMA_VERSION:
        errors.append("rehearsal evidence must use schema_version 4")
    if evidence.get("candidate_sha") != expected_sha or evidence.get("health_commit_sha") != expected_sha:
        errors.append("evidence and backend health must match the exact candidate SHA")
    if evidence.get("health_ready_url") != f"{origin}/health/ready":
        errors.append("backend health evidence does not match the pinned readiness URL")
    if evidence.get("stripe_mode") != "test" or evidence.get("livemode") is not False:
        errors.append("provider rehearsal must be Stripe test mode")
    if evidence.get("secrets_redacted") is not True:
        errors.append("evidence must attest that secrets and provider payloads were redacted")
    if evidence.get("financial_canary_performed") is not False:
        errors.append("test rehearsal evidence cannot claim a live financial canary")

    studio_id = evidence.get("studio_id")
    account_id = evidence.get("stripe_account_id")
    account_generation = evidence.get("connect_account_generation")
    if not isinstance(studio_id, str) or not studio_id:
        errors.append("rehearsal evidence lacks one exact studio")
    if not isinstance(account_id, str) or not ACCOUNT_ID_PATTERN.fullmatch(account_id):
        errors.append("rehearsal evidence lacks one sanitized connected account")
    if type(account_generation) is not int or account_generation <= 0:
        errors.append("rehearsal evidence lacks one positive connected-account generation")

    capabilities = evidence.get("role_capabilities")
    if not isinstance(capabilities, dict) or set(capabilities) != ROLE_CAPABILITY_KEYS:
        errors.append("role capabilities must contain exact Admin, Front Desk, and Instructor fields")
    else:
        if capabilities.get("admin") != ADMIN_WORKFLOWS:
            errors.append("Admin capabilities do not match the operation-bounded workflow catalog")
        if capabilities.get("front_desk") != FRONT_DESK_WORKFLOWS:
            errors.append("Front Desk capabilities do not match the operation-bounded workflow catalog")
        if capabilities.get("instructor") != []:
            errors.append("Instructor capabilities must be empty")

    facts = evidence.get("workflow_facts")
    if not isinstance(facts, dict) or set(facts) != WORKFLOW_FACT_KEYS:
        errors.append("workflow facts must contain only exact schema-v4 fields")
        facts = {}
    consent_ids = (facts.get("initial_consent_id"), facts.get("replacement_consent_id"))
    setup_requests = (facts.get("initial_setup_request_id"), facts.get("replacement_setup_request_id"))
    if (
        facts.get("initial_consent_payer_id") != facts.get("payer_id")
        or facts.get("replacement_consent_payer_id") != facts.get("payer_id")
        or not all(isinstance(value, str) and value for value in (*consent_ids, *setup_requests, facts.get("initial_terms_version"), facts.get("replacement_terms_version")))
        or len(set(consent_ids)) != 2
        or len(set(setup_requests)) != 2
        or facts.get("duplicate_consent_completion_target_id") != facts.get("replacement_consent_id")
    ):
        errors.append("initial and replacement consent must bind distinct setups, exact supersession, and one replay target")
    for field, prefix in (("product_id", "prod_"), ("price_id", "price_"), ("customer_id", "cus_"), ("initial_checkout_session_id", "cs_"), ("initial_setup_intent_id", "seti_"), ("initial_payment_method_id", "pm_"), ("replacement_checkout_session_id", "cs_"), ("replacement_setup_intent_id", "seti_"), ("replacement_payment_method_id", "pm_"), ("subscription_id", "sub_"), ("subscription_item_id", "si_"), ("invoice_link_stripe_id", "in_"), ("automatic_payment_intent_id", "pi_"), ("automatic_charge_id", "ch_"), ("refund_id", "re_"), ("dispute_id", "dp_")):
        if not isinstance(facts.get(field), str) or not facts[field].startswith(prefix):
            errors.append(f"workflow facts lack sanitized {field}")
    if facts.get("initial_setup_intent_id") == facts.get("replacement_setup_intent_id") or facts.get("initial_payment_method_id") == facts.get("replacement_payment_method_id"):
        errors.append("initial failure setup and replacement dispute setup must use distinct provider objects")
    students = facts.get("student_ids")
    if not isinstance(students, list) or len(students) != 2 or len(set(students)) != 2:
        errors.append("shared subscription must bind two distinct students")
    if facts.get("shared_provider_quantity") != 2 or facts.get("shared_local_active_count") != 2:
        errors.append("shared subscription item must converge at quantity two")
    if facts.get("invoice_link_finalized") is not True or facts.get("invoice_link_sent") is not True:
        errors.append("invoice-link workflow must finalize and send")
    if not all(isinstance(facts.get(field), str) and facts.get(field) for field in ("invoice_link_id", "automatic_invoice_id", "failed_payment_invoice_id")) or not str(facts.get("automatic_invoice_stripe_id", "")).startswith("in_"):
        errors.append("invoice workflows lack exact sanitized local invoice identities")
    if facts.get("failed_payment_invoice_id") != facts.get("automatic_invoice_id"):
        errors.append("failed payment invoice must be the exact automatic invoice")
    amount = facts.get("automatic_amount_cents")
    expected_fee = amount * 50 // 10_000 if type(amount) is int else None
    if type(amount) is not int or amount <= 0 or facts.get("application_fee_bps") != 50 or facts.get("provider_application_fee_cents") != expected_fee:
        errors.append("automatic payment must prove exact 50 bps fee arithmetic")
    if facts.get("failed_payment_retry_workflow") != "invoice.retry" or facts.get("failed_payment_retry_outcome") != "succeeded" or facts.get("failed_payment_retry_mutation_count") != 1:
        errors.append("failed payment must converge through one named invoice.retry mutation")
    if (facts.get("period_schedule_state"), facts.get("period_revoke_state"), facts.get("period_due_state")) != ("scheduled", "revoked", "completed"):
        errors.append("period-end schedule, revoke, and due states did not converge")
    if not all(isinstance(facts.get(field), str) and facts.get(field) for field in ("period_schedule_intent_id", "period_revoke_intent_id", "period_due_intent_id")):
        errors.append("period-end evidence lacks exact schedule, revoke, and due intent identities")
    schedule_ids = (facts.get("period_revoke_schedule_id"), facts.get("period_due_schedule_id"))
    if not all(isinstance(value, str) and value.startswith("sub_sched_") for value in schedule_ids) or len(set(schedule_ids)) != 2:
        errors.append("period-end evidence lacks distinct sanitized revoke and due Subscription Schedule identities")
    if facts.get("period_strategy") != "subscription_schedule_shared_item_delete_at_period_end" or (facts.get("period_quantity_before"), facts.get("period_quantity_after")) != (2, 1):
        errors.append("shared-family period-end due transition did not converge from two to one")
    gross, refunded, disputed, net = (facts.get(key) for key in ("gross_paid_cents", "refunded_cents", "disputed_cents", "net_collected_cents"))
    if not all(type(value) is int and value >= 0 for value in (gross, refunded, disputed, net)) or refunded + disputed + net != gross or facts.get("refundable_remaining_cents") != net:
        errors.append("refund/dispute accounting does not satisfy the exact gross and refundable identities")
    if facts.get("invoice_remaining_before_cents") != facts.get("invoice_remaining_after_cents") or facts.get("payer_status_before") != facts.get("payer_status_after"):
        errors.append("refund/dispute convergence changed invoice receivable or payer status")
    if facts.get("adjustment_reconciliation_required") is not False:
        errors.append("refund/dispute convergence remains reconciliation-required")
    if not isinstance(facts.get("adjusted_payment_id"), str) or not facts.get("adjusted_payment_id"):
        errors.append("refund/dispute evidence lacks the exact local payment identity")
    if facts.get("ambiguous_provider_mutation_count") != 1 or facts.get("ambiguous_automatic_retry_count") != 0 or facts.get("ambiguous_provider_readback_count") != 1 or facts.get("ambiguous_recovery_outcome") != "reconciled" or facts.get("ambiguous_final_state") != "completed":
        errors.append("ambiguous same-key readback recovery did not converge with one mutation and zero retries")
    if not re.fullmatch(r"[0-9a-f]{64}", str(facts.get("ambiguous_caller_key_sha256") or "")):
        errors.append("ambiguous recovery lacks a sanitized caller-key digest")

    terminal = _exact_object(evidence.get("terminal_counts"), TERMINAL_KEYS, "terminal count evidence", errors)
    boundary = terminal.get("capture_boundary")
    if not isinstance(boundary, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", boundary):
        errors.append("terminal counts lack one exact UTC RFC3339 capture boundary")
        boundary = ""
    counts = terminal.get("counts")
    if not isinstance(counts, dict) or set(counts) != TERMINAL_COUNT_KEYS:
        errors.append("terminal counts must contain the exact seven unresolved states")
    else:
        for name in TERMINAL_COUNT_KEYS:
            row = _exact_object(counts.get(name), TERMINAL_ROW_KEYS, f"terminal count {name}", errors)
            if row and (row.get("count") != 0 or row.get("source") != TERMINAL_SOURCES[name] or row.get("readback_boundary") != boundary):
                errors.append(f"terminal count {name} must be zero with a named source at the shared capture boundary")
    components = terminal.get("wrong_mode_components")
    if not isinstance(components, list) or len(components) != 2:
        errors.append("wrong-mode zero must contain exact provider and local source components")
    else:
        by_surface = {row.get("surface"): row for row in components if isinstance(row, dict)}
        if set(by_surface) != {"provider", "local"}:
            errors.append("wrong-mode zero must contain exact provider and local source components")
        for surface in ("provider", "local"):
            row = _exact_object(by_surface.get(surface), WRONG_MODE_COMPONENT_KEYS, f"wrong-mode {surface} component", errors)
            if row and (row.get("count") != 0 or row.get("source") != WRONG_MODE_SOURCES[surface] or row.get("readback_boundary") != boundary):
                errors.append(f"wrong-mode {surface} component must be a sourced zero at the shared capture boundary")

    _validate_supplemental(evidence.get("supplemental_evidence"), boundary=boundary, studio_id=evidence.get("studio_id"), account_id=evidence.get("stripe_account_id"), account_generation=evidence.get("connect_account_generation"), workflow_facts=facts, errors=errors)
    supplemental = evidence.get("supplemental_evidence") or {}
    setup = supplemental.get("payer_setup_lifecycle") or {}
    for phase in ("initial", "replacement"):
        row = setup.get(phase) or {}
        expected = tuple(facts.get(f"{phase}_{suffix}") for suffix in ("setup_request_id", "checkout_session_id", "consent_id", "setup_intent_id", "payment_method_id", "terms_version"))
        actual = tuple(row.get(key) for key in ("setup_request_id", "checkout_session_id", "consent_id", "setup_intent_id", "payment_method_id", "terms_version"))
        if actual != expected or row.get("payer_id") != facts.get("payer_id") or row.get("stripe_account_id") != account_id or row.get("connect_account_generation") != account_generation:
            errors.append(f"{phase} setup lifecycle must bind workflow facts, payer, account, and generation")
    duplicate = setup.get("duplicate_completion") or {}
    replacement = setup.get("replacement") or {}
    connect_delivery = (evidence.get("webhook_delivery_evidence") or {}).get("connect", {})
    provider_replay = duplicate.get("provider_replay") or {}
    local_replay = duplicate.get("local_replay") or {}
    replacement_session_id = replacement.get("checkout_session_id")
    attempt_endpoints = [attempt.get("endpoint_url") for attempt in provider_replay.get("attempts", []) if isinstance(attempt, dict)]
    if (
        provider_replay.get("event_id") != connect_delivery.get("event_id")
        or local_replay.get("event_id") != connect_delivery.get("event_id")
        or provider_replay.get("checkout_session_id") != replacement_session_id
        or local_replay.get("checkout_session_id") != replacement_session_id
        or attempt_endpoints != [connect_delivery.get("endpoint_url"), connect_delivery.get("endpoint_url")]
        or connect_delivery.get("event_type") != "checkout.session.completed"
        or tuple(local_replay.get(k) for k in ("setup_request_id", "consent_id", "setup_intent_id")) != tuple(replacement.get(k) for k in ("setup_request_id", "consent_id", "setup_intent_id"))
    ):
        errors.append("duplicate completion replay must bind the pinned Connect endpoint, replacement event, session, setup, consent, and SetupIntent")
    retry = supplemental.get("failed_payment_retry") or {}
    expected_retry = (
        facts.get("automatic_invoice_id"), facts.get("replacement_payment_method_id"),
        facts.get("automatic_payment_intent_id"), facts.get("automatic_charge_id"),
        facts.get("automatic_amount_cents"), facts.get("provider_application_fee_cents"), 1,
    )
    actual_retry = tuple(retry.get(key) for key in ("invoice_id", "payment_method_id", "payment_intent_id", "charge_id", "amount_cents", "application_fee_cents", "provider_mutation_count"))
    if actual_retry != expected_retry:
        errors.append("successful retry must own the automatic invoice, replacement method, payment intent, charge, amount, and fee")
    expected_payment_id = facts.get("adjusted_payment_id")
    before_provider, before_local = retry.get("failed_provider_readback") or {}, retry.get("failed_local_readback") or {}
    after_provider, after_local = retry.get("provider_readback") or {}, retry.get("local_readback") or {}
    if (
        (before_provider.get("invoice_id"), before_provider.get("payment_intent_id")) != (facts.get("automatic_invoice_stripe_id"), facts.get("automatic_payment_intent_id"))
        or tuple(before_local.get(k) for k in ("invoice_id", "payment_id", "stripe_invoice_id", "payment_intent_id")) != (facts.get("automatic_invoice_id"), expected_payment_id, facts.get("automatic_invoice_stripe_id"), facts.get("automatic_payment_intent_id"))
        or tuple(after_provider.get(k) for k in ("invoice_id", "payment_intent_id", "charge_id", "payment_method_id", "amount_cents", "application_fee_cents")) != (facts.get("automatic_invoice_stripe_id"), facts.get("automatic_payment_intent_id"), facts.get("automatic_charge_id"), facts.get("replacement_payment_method_id"), 10000, 50)
        or tuple(after_local.get(k) for k in ("invoice_id", "payment_id", "stripe_invoice_id", "payment_intent_id", "charge_id", "payment_method_id", "amount_cents", "application_fee_cents")) != (facts.get("automatic_invoice_id"), expected_payment_id, facts.get("automatic_invoice_stripe_id"), facts.get("automatic_payment_intent_id"), facts.get("automatic_charge_id"), facts.get("replacement_payment_method_id"), 10000, 50)
    ):
        errors.append("typed retry readbacks do not cross-bind the exact provider and local invoice/payment identities")
    dispute = supplemental.get("dispute_lifecycle") or {}
    if dispute.get("dispute_id") != facts.get("dispute_id") or dispute.get("charge_id") != facts.get("automatic_charge_id") or dispute.get("payment_id") != expected_payment_id:
        errors.append("dispute must bind the exact automatic charge and final zero disputed amount")
    created, closed = dispute.get("created_event") or {}, dispute.get("closed_event") or {}
    provider_dispute, local_dispute = dispute.get("provider_readback") or {}, dispute.get("local_readback") or {}
    if (provider_dispute.get("dispute_id"), provider_dispute.get("charge_id"), provider_dispute.get("amount_cents")) != (facts.get("dispute_id"), facts.get("automatic_charge_id"), 10000) or tuple(local_dispute.get(k) for k in ("dispute_id", "charge_id", "payment_id", "created_event_id", "closed_event_id", "disputed_cents", "reconciliation_required")) != (facts.get("dispute_id"), facts.get("automatic_charge_id"), expected_payment_id, created.get("event_id"), closed.get("event_id"), 0, False):
        errors.append("typed dispute readbacks do not bind the exact payment, events, amount, and terminal accounting")
    refund = supplemental.get("refund_convergence") or {}
    provider_refund, local_refund = refund.get("provider_readback") or {}, refund.get("local_readback") or {}
    refund_owner = (facts.get("refund_id"), facts.get("automatic_charge_id"), facts.get("automatic_payment_intent_id"), expected_payment_id, account_id, account_generation, 1000)
    if tuple(refund.get(k) for k in ("refund_id", "charge_id", "payment_intent_id", "payment_id", "stripe_account_id", "connect_account_generation", "amount_cents")) != refund_owner or tuple(provider_refund.get(k) for k in ("refund_id", "charge_id", "payment_intent_id", "amount_cents")) != refund_owner[:3] + (1000,) or tuple(local_refund.get(k) for k in ("refund_id", "charge_id", "payment_intent_id", "payment_id", "stripe_account_id", "connect_account_generation", "amount_cents")) != refund_owner:
        errors.append("refund convergence does not bind the exact provider/local payment owner")

    steps = evidence.get("steps") or []
    by_name = {row.get("name"): row for row in steps if isinstance(row, dict)}
    if len(by_name) != len(steps):
        errors.append("rehearsal step names must be present and unique")
    if [row.get("name") for row in steps if isinstance(row, dict)] != list(REQUIRED_STEP_ORDER):
        errors.append("rehearsal steps do not match the canonical schema-v4 order")
    if len(steps) != 15:
        errors.append("rehearsal evidence must contain exactly 15 core proof steps")
    missing = sorted(REQUIRED_STEPS - set(by_name))
    if missing:
        errors.append(f"missing required rehearsal steps: {', '.join(missing)}")
    for name in sorted(REQUIRED_STEPS & set(by_name)):
        step = by_name[name]
        expected_step_keys = {"name", "status", "stripe_account_id"}
        if name != "health_exact_candidate":
            expected_step_keys.add("studio_id")
        if set(step) != expected_step_keys:
            errors.append(f"step {name} must contain only exact sanitized fields")
        if step.get("status") != "pass":
            errors.append(f"step {name} did not pass")
        if name == "health_exact_candidate":
            if step.get("stripe_account_id") is not None:
                errors.append("health step must not claim connected-account scope")
            continue
        if step.get("studio_id") != studio_id:
            errors.append(f"step {name} does not match the rehearsal studio")
        if name in PLATFORM_SCOPED_STEPS:
            if "stripe_account_id" not in step or step.get("stripe_account_id") is not None:
                errors.append(f"step {name} must explicitly use platform account context")
        elif step.get("stripe_account_id") != account_id:
            errors.append(f"step {name} does not match the rehearsal connected account")

    mutations = evidence.get("mutation_attempts") or []
    by_step = {mutation.get("step_name"): mutation for mutation in mutations if isinstance(mutation, dict)}
    if len(by_step) != len(mutations) or set(by_step) != set(REQUIRED_MUTATIONS):
        errors.append("mutation step names do not match the exact schema-v4 workflow plan")
    if [row.get("step_name") for row in mutations if isinstance(row, dict)] != list(REQUIRED_MUTATIONS):
        errors.append("mutation attempts do not match the canonical schema-v4 order")
    if len(mutations) != 24:
        errors.append("rehearsal evidence must contain exactly 24 core mutation attempts")
    for mutation in mutations:
        if not isinstance(mutation, dict):
            errors.append("mutation evidence entries must be objects")
            continue
        if set(mutation) != MUTATION_KEYS:
            errors.append("mutation evidence must contain only exact sanitized fields")
        step_name = mutation.get("step_name")
        expected = REQUIRED_MUTATIONS.get(step_name)
        if expected is None:
            continue
        workflow_id, operation, scope, actor_role, uses_account = expected
        if (mutation.get("workflow_id"), mutation.get("operation"), mutation.get("scope"), mutation.get("actor_role")) != (workflow_id, operation, scope, actor_role):
            errors.append(f"mutation {step_name} does not match its exact workflow contract")
        if mutation.get("studio_id") != studio_id:
            errors.append("every mutation attempt must match the rehearsal studio")
        expected_account = account_id if uses_account else None
        if mutation.get("stripe_account_id") != expected_account:
            errors.append(f"mutation {operation} has the wrong connected-account context")
        if mutation.get("provider_mutation_count") != 1 or mutation.get("automatic_retry_count") != 0:
            errors.append("provider mutation was retried instead of reconciled by readback")
        if mutation.get("outcome") not in {"succeeded", "reconciled"}:
            errors.append("provider mutation lacks a successful idempotency/event readback outcome")
        if not re.fullmatch(r"[0-9a-f]{64}", str(mutation.get("caller_request_key_sha256") or "")):
            errors.append(f"provider mutation {operation} lacks a sanitized caller-key digest")

    ambiguous_step = facts.get("ambiguous_mutation_step_name")
    ambiguous = by_step.get(ambiguous_step)
    if not ambiguous or ambiguous.get("caller_request_key_sha256") != facts.get("ambiguous_caller_key_sha256") or ambiguous.get("outcome") != "reconciled":
        errors.append("ambiguous recovery does not bind one exact reconciled mutation row")
    supplemental_ambiguity = (evidence.get("supplemental_evidence") or {}).get("ambiguity_recovery")
    if not isinstance(supplemental_ambiguity, dict) or supplemental_ambiguity.get("caller_request_key_sha256") != facts.get("ambiguous_caller_key_sha256") or supplemental_ambiguity.get("mutation_step_name") != ambiguous_step or supplemental_ambiguity.get("caller_request_key_sha256") != (ambiguous or {}).get("caller_request_key_sha256"):
        errors.append("supplemental ambiguity recovery does not bind workflow facts and payer.customer_create")

    deliveries = evidence.get("webhook_delivery_evidence")
    if not isinstance(deliveries, dict) or set(deliveries) != {"platform", "connect"}:
        errors.append("webhook evidence must contain distinct platform and Connect delivery/readback proof")
    else:
        errors.extend(_validate_delivery(
            deliveries["platform"],
            surface="platform",
            endpoint_url=f"{origin}/api/v1/webhooks/stripe/platform",
            studio_id=studio_id,
            account_id=account_id,
            account_generation=account_generation,
        ))
        errors.extend(_validate_delivery(
            deliveries["connect"],
            surface="connect",
            endpoint_url=f"{origin}/api/v1/webhooks/stripe/connect",
            studio_id=studio_id,
            account_id=account_id,
            account_generation=account_generation,
        ))
        event_ids = [
            delivery.get("event_id")
            for delivery in deliveries.values()
            if isinstance(delivery, dict)
        ]
        if len(event_ids) != len(set(event_ids)):
            errors.append("platform and Connect webhook event IDs must be unique")
        platform = supplemental.get("platform_fixture") or {}
        platform_delivery = deliveries["platform"]
        if (
            platform.get("studio_id") != studio_id
            or platform.get("event_id") != platform_delivery.get("event_id")
            or platform.get("event_type") != platform_delivery.get("event_type")
            or platform_delivery.get("event_type") != "customer.subscription.created"
        ):
            errors.append("platform fixture must bind its owned subscription event to the platform delivery and rehearsal studio")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate sanitized exact-candidate Stripe test rehearsal evidence.")
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--expected-candidate-sha", required=True)
    parser.add_argument("--expected-backend-origin", required=True)
    args = parser.parse_args(argv)
    try:
        evidence = json.loads(args.evidence.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read rehearsal evidence: {exc}", file=sys.stderr)
        return 1
    errors = validate_evidence(
        evidence,
        args.expected_candidate_sha,
        args.expected_backend_origin,
    )
    print(json.dumps({"valid": not errors, "errors": errors}, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
