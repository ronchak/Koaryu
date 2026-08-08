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
EVIDENCE_SCHEMA_VERSION = 2
REQUIRED_STEPS = {
    "health_exact_candidate",
    "connect_account_readback",
    "hosted_onboarding_link",
    "account_readiness_readback",
    "connected_customer",
    "setup_payment_method",
    "plan_product_price",
    "invoice_payment",
    "refund_convergence",
    "dispute_convergence",
    "platform_webhook_delivery_readback",
    "connect_webhook_delivery_readback",
}
PLATFORM_SCOPED_STEPS = {"platform_webhook_delivery_readback"}
ACCOUNT_SCOPED_STEPS = REQUIRED_STEPS - {"health_exact_candidate"} - PLATFORM_SCOPED_STEPS
REQUIRED_MUTATION_OPERATIONS = {
    "connect_account.create",
    "connect_onboarding_link.create",
    "connected_customer.create",
    "connected_setup_checkout_session.create",
    "connected_product.create",
    "connected_price.create",
    "connected_invoice.create",
    "connected_invoice.pay",
    "connected_refund.create",
}
MUTATION_SCOPES = {
    "connect_account.create": "connect_onboarding",
    "connect_onboarding_link.create": "connect_onboarding",
    "connected_customer.create": "connect_payments",
    "connected_setup_checkout_session.create": "connect_payments",
    "connected_product.create": "connect_payments",
    "connected_price.create": "connect_payments",
    "connected_invoice.create": "connect_payments",
    "connected_invoice.pay": "connect_payments",
    "connected_refund.create": "connect_payments",
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
}
MUTATION_KEYS = {
    "operation",
    "studio_id",
    "scope",
    "stripe_account_id",
    "automatic_retry_count",
    "outcome",
    "idempotency_key",
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
        errors.append("rehearsal evidence must use schema_version 2")
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
    mutation_operations = [
        mutation.get("operation") for mutation in mutations if isinstance(mutation, dict)
    ]
    if len(mutation_operations) != len(set(mutation_operations)):
        errors.append("mutation operations must be present and unique")
    missing_operations = sorted(REQUIRED_MUTATION_OPERATIONS - set(mutation_operations))
    if missing_operations:
        errors.append(f"missing required mutation evidence: {', '.join(missing_operations)}")
    for mutation in mutations:
        if not isinstance(mutation, dict):
            errors.append("mutation evidence entries must be objects")
            continue
        if set(mutation) != MUTATION_KEYS:
            errors.append("mutation evidence must contain only exact sanitized fields")
        operation = mutation.get("operation")
        if mutation.get("studio_id") != studio_id:
            errors.append("every mutation attempt must match the rehearsal studio")
        if mutation.get("scope") != MUTATION_SCOPES.get(operation):
            errors.append(f"mutation {operation} has the wrong authorization scope")
        expected_account = None if operation == "connect_account.create" else account_id
        if mutation.get("stripe_account_id") != expected_account:
            errors.append(f"mutation {operation} has the wrong connected-account context")
        if mutation.get("automatic_retry_count") != 0:
            errors.append("provider mutation was retried instead of reconciled by readback")
        if mutation.get("outcome") not in {"succeeded", "reconciled"}:
            errors.append("provider mutation lacks a successful idempotency/event readback outcome")
        if not mutation.get("idempotency_key"):
            errors.append(f"provider mutation {operation} lacks a deterministic idempotency key")

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
