#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any


SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
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
    "webhook_event_id_idempotency",
}
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
MUTATIONS_WITHOUT_IDEMPOTENCY_KEY = {"connect_onboarding_link.create"}


def validate_evidence(evidence: dict[str, Any], expected_sha: str) -> list[str]:
    errors: list[str] = []
    if not SHA_PATTERN.fullmatch(expected_sha):
        return ["expected candidate SHA must be exact lowercase 40-character hex"]
    if evidence.get("candidate_sha") != expected_sha or evidence.get("health_commit_sha") != expected_sha:
        errors.append("evidence and backend health must match the exact candidate SHA")
    if evidence.get("stripe_mode") != "test" or evidence.get("livemode") is not False:
        errors.append("provider rehearsal must be Stripe test mode")
    if evidence.get("secrets_redacted") is not True:
        errors.append("evidence must attest that secrets and provider payloads were redacted")
    if evidence.get("financial_canary_performed") is not False:
        errors.append("test rehearsal evidence cannot claim a live financial canary")

    steps = evidence.get("steps") or []
    by_name = {row.get("name"): row for row in steps if isinstance(row, dict)}
    if len(by_name) != len(steps):
        errors.append("rehearsal step names must be present and unique")
    missing = sorted(REQUIRED_STEPS - set(by_name))
    if missing:
        errors.append(f"missing required rehearsal steps: {', '.join(missing)}")
    for name in sorted(REQUIRED_STEPS & set(by_name)):
        step = by_name[name]
        if step.get("status") != "pass":
            errors.append(f"step {name} did not pass")
        if not step.get("studio_id"):
            errors.append(f"step {name} lacks explicit studio scope")
        if name != "health_exact_candidate" and not step.get("stripe_account_id"):
            errors.append(f"step {name} lacks explicit connected-account scope")

    mutations = evidence.get("mutation_attempts") or []
    mutation_operations = {
        mutation.get("operation") for mutation in mutations if isinstance(mutation, dict)
    }
    missing_operations = sorted(REQUIRED_MUTATION_OPERATIONS - mutation_operations)
    if missing_operations:
        errors.append(f"missing required mutation evidence: {', '.join(missing_operations)}")
    for mutation in mutations:
        if not isinstance(mutation, dict):
            errors.append("mutation evidence entries must be objects")
            continue
        if not mutation.get("studio_id") or not mutation.get("scope"):
            errors.append("every mutation attempt must record explicit studio and authorization scope")
        if str(mutation.get("scope") or "").startswith("connect_") and mutation.get("operation") != "connect_account.create" and not mutation.get("stripe_account_id"):
            errors.append("Connect mutation attempt lacks explicit connected account")
        if mutation.get("automatic_retry_count") != 0:
            errors.append("provider mutation was retried instead of reconciled by readback")
        if mutation.get("outcome") not in {"succeeded", "reconciled"}:
            errors.append("provider mutation lacks a successful idempotency/event readback outcome")
        if (
            mutation.get("operation") not in MUTATIONS_WITHOUT_IDEMPOTENCY_KEY
            and not mutation.get("idempotency_key")
        ):
            errors.append("provider mutation lacks a deterministic idempotency key")

    event_ids = evidence.get("webhook_event_ids") or []
    if not event_ids or len(event_ids) != len(set(event_ids)):
        errors.append("webhook event IDs must be present and unique")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate sanitized exact-candidate Stripe test rehearsal evidence.")
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--expected-candidate-sha", required=True)
    args = parser.parse_args(argv)
    try:
        evidence = json.loads(args.evidence.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read rehearsal evidence: {exc}", file=sys.stderr)
        return 1
    errors = validate_evidence(evidence, args.expected_candidate_sha)
    print(json.dumps({"valid": not errors, "errors": errors}, indent=2, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
