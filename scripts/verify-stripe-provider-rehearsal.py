#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import urlsplit


SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
EVENT_ID_PATTERN = re.compile(r"^evt_[A-Za-z0-9]+$")
ACCOUNT_ID_PATTERN = re.compile(r"^acct_[A-Za-z0-9]+$")
EVIDENCE_SCHEMA_VERSION = 3
REQUIRED_STEPS = {
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
}
PLATFORM_SCOPED_STEPS = {"platform_webhook_delivery_readback"}
ACCOUNT_SCOPED_STEPS = REQUIRED_STEPS - {"health_exact_candidate"} - PLATFORM_SCOPED_STEPS
REQUIRED_MUTATIONS = {
    "connect.account_create": ("connect.onboarding", "connect_account.create", "connect_onboarding", "admin", False),
    "connect.onboarding_link": ("connect.onboarding", "connect_onboarding_link.create", "connect_onboarding", "admin", True),
    "payer.customer_create": ("payer.sync", "connected_customer.create", "connect_payments", "admin", True),
    "payer.setup_checkout": ("payer.setup", "connected_setup_checkout_session.create", "connect_payments", "front_desk", True),
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
    "automatic.pay": ("invoice.retry", "connected_invoice.pay", "connect_payments", "admin", True),
    "invoice_retry.pay": ("invoice.retry", "connected_invoice.pay", "connect_payments", "admin", True),
    "period_end.due_quantity_update": ("enrollment.cancel.period_end.execute", "connected_subscription_item.update", "connect_payments", "internal", True),
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
ADMIN_WORKFLOWS = ["connect.onboarding", "enrollment.activate", "enrollment.cancel.immediate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "invoice.create", "invoice.finalize", "invoice.retry", "payer.setup", "payer.sync", "payment.refund", "plan.sync"]
FRONT_DESK_WORKFLOWS = ["enrollment.activate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "payer.setup"]
ROLE_CAPABILITY_KEYS = {"admin", "front_desk", "instructor"}
TERMINAL_COUNT_KEYS = {"failed", "stuck", "unmapped", "wrong_mode", "wrong_generation", "pending_transition", "reconciliation_required"}
WORKFLOW_FACT_KEYS = {
    "product_id", "price_id", "payer_id", "customer_id", "consent_accepted",
    "consent_payer_id", "setup_request_id", "consent_id", "setup_intent_id",
    "payment_method_id", "terms_version", "consent_completed",
    "duplicate_consent_completion_outcome", "student_ids",
    "subscription_id", "subscription_item_id", "shared_provider_quantity",
    "shared_local_active_count", "invoice_link_id", "invoice_link_stripe_id",
    "invoice_link_finalized", "invoice_link_sent", "automatic_invoice_id",
    "automatic_payment_intent_id", "automatic_charge_id", "automatic_amount_cents",
    "application_fee_bps", "provider_application_fee_cents", "failed_payment_invoice_id",
    "failed_payment_retry_workflow", "failed_payment_retry_outcome",
    "failed_payment_retry_mutation_count", "period_schedule_state", "period_revoke_state",
    "period_due_state", "period_schedule_intent_id", "period_revoke_intent_id",
    "period_due_intent_id", "period_strategy", "period_quantity_before",
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
        errors.append("rehearsal evidence must use schema_version 3")
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
        errors.append("workflow facts must contain only exact schema-v3 fields")
        facts = {}
    if facts.get("consent_payer_id") != facts.get("payer_id") or not all(isinstance(facts.get(field), str) and facts.get(field) for field in ("setup_request_id", "consent_id", "terms_version")):
        errors.append("consent evidence does not bind the exact payer, request, consent, and terms")
    for field, prefix in (("product_id", "prod_"), ("price_id", "price_"), ("customer_id", "cus_"), ("setup_intent_id", "seti_"), ("payment_method_id", "pm_"), ("subscription_id", "sub_"), ("subscription_item_id", "si_"), ("invoice_link_stripe_id", "in_"), ("automatic_payment_intent_id", "pi_"), ("automatic_charge_id", "ch_"), ("refund_id", "re_"), ("dispute_id", "dp_")):
        if not isinstance(facts.get(field), str) or not facts[field].startswith(prefix):
            errors.append(f"workflow facts lack sanitized {field}")
    if facts.get("consent_accepted") is not True or facts.get("consent_completed") is not True or facts.get("duplicate_consent_completion_outcome") != "replay":
        errors.append("payer-owned consent and duplicate completion replay did not converge")
    students = facts.get("student_ids")
    if not isinstance(students, list) or len(students) != 2 or len(set(students)) != 2:
        errors.append("shared subscription must bind two distinct students")
    if facts.get("shared_provider_quantity") != 2 or facts.get("shared_local_active_count") != 2:
        errors.append("shared subscription item must converge at quantity two")
    if facts.get("invoice_link_finalized") is not True or facts.get("invoice_link_sent") is not True:
        errors.append("invoice-link workflow must finalize and send")
    if not all(isinstance(facts.get(field), str) and facts.get(field) for field in ("invoice_link_id", "automatic_invoice_id", "failed_payment_invoice_id")):
        errors.append("invoice workflows lack exact sanitized local invoice identities")
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
    if facts.get("period_strategy") != "subscription_item_delete_at_period_end" or (facts.get("period_quantity_before"), facts.get("period_quantity_after")) != (2, 1):
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

    terminal = evidence.get("terminal_counts")
    if not isinstance(terminal, dict) or set(terminal) != TERMINAL_COUNT_KEYS or any(terminal.get(key) != 0 for key in TERMINAL_COUNT_KEYS):
        errors.append("terminal counts must be exact zero for every unresolved state")

    steps = evidence.get("steps") or []
    by_name = {row.get("name"): row for row in steps if isinstance(row, dict)}
    if len(by_name) != len(steps):
        errors.append("rehearsal step names must be present and unique")
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
        errors.append("mutation step names do not match the exact schema-v3 workflow plan")
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
