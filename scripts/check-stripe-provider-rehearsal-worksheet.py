#!/usr/bin/env python3
"""Check that the Stripe provider rehearsal worksheet matches its validator."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "scripts" / "verify-stripe-provider-rehearsal.py"
DEFAULT_WORKSHEET = ROOT / "docs" / "stripe-test-provider-rehearsal-capture.md"
TEMPLATE_START = "<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V3_TEMPLATE:START -->"
TEMPLATE_END = "<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V3_TEMPLATE:END -->"
STUDIO = "<STUDIO_ID>"
ACCOUNT = "<STRIPE_CONNECT_ACCOUNT_ID>"
GENERATION = "<CONNECT_ACCOUNT_GENERATION>"
PLATFORM_EVENT = "<PLATFORM_EVT_ID>"
CONNECT_EVENT = "<CONNECT_EVT_ID>"


def _load_validator():
    spec = importlib.util.spec_from_file_location("stripe_provider_rehearsal_validator", VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load validator source: {VALIDATOR_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


VALIDATOR = _load_validator()


def load_template(worksheet: Path) -> dict[str, Any]:
    text = worksheet.read_text()
    pattern = re.escape(TEMPLATE_START) + r"\s*```json\s*(\{.*?\})\s*```\s*" + re.escape(TEMPLATE_END)
    matches = re.findall(pattern, text, flags=re.DOTALL)
    if len(matches) != 1:
        raise ValueError("worksheet must contain exactly one marked JSON schema-v3 template")
    try:
        template = json.loads(matches[0])
    except json.JSONDecodeError as exc:
        raise ValueError(f"worksheet schema-v3 template is not valid JSON: {exc}") from exc
    if not isinstance(template, dict):
        raise ValueError("worksheet schema-v3 template must be a JSON object")
    return template


def _exact_keys(errors: list[str], label: str, value: Any, expected: set[str]) -> bool:
    if not isinstance(value, dict) or set(value) != expected:
        errors.append(f"{label} keys do not match the validator")
        return False
    return True


def validate_template(template: dict[str, Any]) -> list[str]:
    """Return drift errors using expectations derived only from validator constants."""
    errors: list[str] = []
    _exact_keys(errors, "top-level template", template, VALIDATOR.TOP_LEVEL_KEYS)

    expected_top_values = {
        "schema_version": VALIDATOR.EVIDENCE_SCHEMA_VERSION,
        "candidate_sha": "<40-CHARACTER-CANDIDATE-SHA>",
        "health_commit_sha": "<40-CHARACTER-CANDIDATE-SHA>",
        "health_ready_url": "<PINNED_STAGING_BACKEND_ORIGIN>/health/ready",
        "stripe_mode": "test",
        "livemode": False,
        "secrets_redacted": True,
        "financial_canary_performed": False,
        "studio_id": STUDIO,
        "stripe_account_id": ACCOUNT,
        "connect_account_generation": GENERATION,
    }
    for field, expected in expected_top_values.items():
        if template.get(field) != expected:
            errors.append(f"top-level field {field} does not use the canonical worksheet value")

    capabilities = template.get("role_capabilities")
    if not _exact_keys(errors, "role capabilities", capabilities, VALIDATOR.ROLE_CAPABILITY_KEYS):
        capabilities = {}
    if capabilities.get("admin") != VALIDATOR.ADMIN_WORKFLOWS:
        errors.append("Admin worksheet capabilities do not match the validator")
    if capabilities.get("front_desk") != VALIDATOR.FRONT_DESK_WORKFLOWS:
        errors.append("Front Desk worksheet capabilities do not match the validator")
    if capabilities.get("instructor") != []:
        errors.append("Instructor worksheet capabilities must be empty")
    _exact_keys(errors, "workflow facts", template.get("workflow_facts"), VALIDATOR.WORKFLOW_FACT_KEYS)
    terminal = template.get("terminal_counts")
    if _exact_keys(errors, "terminal counts", terminal, VALIDATOR.TERMINAL_COUNT_KEYS):
        if any(terminal.get(key) != 0 for key in VALIDATOR.TERMINAL_COUNT_KEYS):
            errors.append("terminal count worksheet values must all be zero")

    steps = template.get("steps")
    if not isinstance(steps, list):
        errors.append("steps must be a list")
    else:
        by_name = {step.get("name"): step for step in steps if isinstance(step, dict)}
        if len(by_name) != len(steps) or set(by_name) != VALIDATOR.REQUIRED_STEPS:
            errors.append("step names do not match the validator required steps")
        for name in VALIDATOR.REQUIRED_STEPS:
            step = by_name.get(name)
            expected_keys = {"name", "status", "stripe_account_id"}
            if name != "health_exact_candidate":
                expected_keys.add("studio_id")
            if not _exact_keys(errors, f"step {name}", step, expected_keys):
                continue
            if step["name"] != name or step["status"] != "pass":
                errors.append(f"step {name} does not use canonical name/status")
            if name == "health_exact_candidate":
                if step["stripe_account_id"] is not None:
                    errors.append("health_exact_candidate must use null connected-account context")
                continue
            if step["studio_id"] != STUDIO:
                errors.append(f"step {name} does not use the canonical studio context")
            expected_account = None if name in VALIDATOR.PLATFORM_SCOPED_STEPS else ACCOUNT
            if step["stripe_account_id"] != expected_account:
                errors.append(f"step {name} does not use the validator account context")

    mutations = template.get("mutation_attempts")
    if not isinstance(mutations, list):
        errors.append("mutation_attempts must be a list")
    else:
        by_step = {
            mutation.get("step_name"): mutation for mutation in mutations if isinstance(mutation, dict)
        }
        if len(by_step) != len(mutations) or set(by_step) != set(VALIDATOR.REQUIRED_MUTATIONS):
            errors.append("mutation steps do not match the validator workflow plan")
        for step_name, expected_mutation in VALIDATOR.REQUIRED_MUTATIONS.items():
            mutation = by_step.get(step_name)
            if not _exact_keys(errors, f"mutation {step_name}", mutation, VALIDATOR.MUTATION_KEYS):
                continue
            workflow_id, operation, scope, actor_role, uses_account = expected_mutation
            if (mutation["workflow_id"], mutation["operation"], mutation["scope"], mutation["actor_role"]) != (workflow_id, operation, scope, actor_role):
                errors.append(f"mutation {step_name} does not use its canonical workflow contract")
            if mutation["studio_id"] != STUDIO:
                errors.append(f"mutation {step_name} does not use the canonical studio context")
            expected_account = ACCOUNT if uses_account else None
            if mutation["stripe_account_id"] != expected_account:
                errors.append(f"mutation {step_name} does not use the validator account context")
            if mutation["provider_mutation_count"] != 1 or mutation["automatic_retry_count"] != 0:
                errors.append(f"mutation {step_name} does not document one mutation and zero retries")
            expected_outcome = "reconciled" if step_name == "payer.customer_create" else "succeeded"
            if mutation["outcome"] != expected_outcome:
                errors.append(f"mutation {step_name} does not use the canonical outcome")
            if mutation["caller_request_key_sha256"] != f"<CALLER_KEY_SHA256:{step_name}>":
                errors.append(f"mutation {step_name} does not use its canonical key-digest placeholder")

    deliveries = template.get("webhook_delivery_evidence")
    if not isinstance(deliveries, dict) or set(deliveries) != {"platform", "connect"}:
        errors.append("webhook delivery surfaces must be exactly platform and connect")
    else:
        expected_events = {"platform": PLATFORM_EVENT, "connect": CONNECT_EVENT}
        for surface in ("platform", "connect"):
            delivery = deliveries[surface]
            if not _exact_keys(errors, f"{surface} delivery", delivery, VALIDATOR.DELIVERY_KEYS):
                continue
            is_connect = surface == "connect"
            expected_account = ACCOUNT if is_connect else None
            expected_generation = GENERATION if is_connect else None
            expected = {
                "surface": surface,
                "endpoint_url": f"<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/{surface}",
                "connect": is_connect,
                "event_id": expected_events[surface],
                "studio_id": STUDIO,
                "stripe_account_id": expected_account,
                "connect_account_generation": expected_generation,
                "provider_delivery_status": "delivered",
                "provider_http_status": 200,
                "local_event_id": expected_events[surface],
                "local_processing_status": "processed",
            }
            for field, value in expected.items():
                if delivery[field] != value:
                    errors.append(f"{surface} delivery field {field} does not use canonical context")
            allowed_events = VALIDATOR.CONNECT_EVENTS if is_connect else VALIDATOR.PLATFORM_EVENTS
            if delivery["event_type"] not in allowed_events:
                errors.append(f"{surface} delivery event type is not in the validator endpoint contract")
        if deliveries["platform"].get("event_id") == deliveries["connect"].get("event_id"):
            errors.append("platform and connect delivery event placeholders must be distinct")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check Stripe rehearsal worksheet schema-v3 drift.")
    parser.add_argument("--worksheet", type=Path, default=DEFAULT_WORKSHEET)
    args = parser.parse_args(argv)
    try:
        errors = validate_template(load_template(args.worksheet))
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Worksheet check failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("Worksheet check failed:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print("Stripe provider rehearsal worksheet matches validator schema v3.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
