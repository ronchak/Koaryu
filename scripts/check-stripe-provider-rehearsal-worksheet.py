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
TEMPLATE_START = "<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V4_TEMPLATE:START -->"
TEMPLATE_END = "<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V4_TEMPLATE:END -->"
STUDIO = "<STUDIO_ID>"
ACCOUNT = "<STRIPE_CONNECT_ACCOUNT_ID>"
GENERATION = "<CONNECT_ACCOUNT_GENERATION>"
PLATFORM_EVENT = "<PLATFORM_EVT_ID>"
CONNECT_EVENT = "<CONNECT_EVT_ID>"
BOUNDARY = "<CAPTURE_BOUNDARY>"
PERIOD_SENTINEL_INSTRUCTION = (
    "Replace both `period_advancement.advances_to` and "
    "`period_advancement.observed_provider_boundary` sentinel values with the same "
    "positive Unix timestamp returned by the Stripe test clock."
)
PLATFORM_TIME_INSTRUCTION = (
    "Replace both platform fixture `created_at` zero sentinels with the exact positive "
    "Unix timestamps returned by Stripe; the customer timestamp must be earlier."
)


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
        raise ValueError("worksheet must contain exactly one marked JSON schema-v4 template")
    try:
        template = json.loads(matches[0])
    except json.JSONDecodeError as exc:
        raise ValueError(f"worksheet schema-v4 template is not valid JSON: {exc}") from exc
    if not isinstance(template, dict):
        raise ValueError("worksheet schema-v4 template must be a JSON object")
    return template


def validate_instructions(text: str) -> list[str]:
    errors = []
    if PERIOD_SENTINEL_INSTRUCTION not in text:
        errors.append("worksheet must instruct operators to replace both period-advance sentinels")
    if PLATFORM_TIME_INSTRUCTION not in text:
        errors.append("worksheet must instruct operators to replace both platform timestamp sentinels")
    return errors


def validate_worksheet(worksheet: Path) -> list[str]:
    text = worksheet.read_text()
    return validate_template(load_template(worksheet)) + validate_instructions(text)


def _exact_keys(errors: list[str], label: str, value: Any, expected: set[str]) -> bool:
    if not isinstance(value, dict) or set(value) != expected:
        errors.append(f"{label} keys do not match the validator")
        return False
    return True


def _canonical_readback(errors: list[str], value: Any, *, label: str, source: str, status: str, keys: set[str] | None = None, status_field: str = "status") -> None:
    if not _exact_keys(errors, label, value, keys or VALIDATOR.READBACK_KEYS):
        return
    if value.get("source") != source or value.get(status_field) != status or value.get("capture_boundary") != BOUNDARY:
        errors.append(f"{label} does not use its canonical source, status, and boundary")


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
    supplemental = template.get("supplemental_evidence")
    if _exact_keys(errors, "supplemental evidence", supplemental, VALIDATOR.SUPPLEMENTAL_KEYS):
        expected_shapes = {
            "payer_setup_lifecycle": VALIDATOR.PAYER_SETUP_KEYS,
            "invoice_void": VALIDATOR.INVOICE_VOID_KEYS,
            "immediate_cancellation": VALIDATOR.IMMEDIATE_CANCELLATION_KEYS,
            "external_payment": VALIDATOR.EXTERNAL_PAYMENT_KEYS,
            "failed_payment_retry": VALIDATOR.FAILED_RETRY_KEYS,
            "period_advancement": VALIDATOR.PERIOD_ADVANCEMENT_KEYS,
            "dispute_lifecycle": VALIDATOR.DISPUTE_LIFECYCLE_KEYS,
            "refund_convergence": VALIDATOR.REFUND_KEYS,
            "ambiguity_recovery": VALIDATOR.AMBIGUITY_KEYS,
            "platform_fixture": VALIDATOR.PLATFORM_FIXTURE_KEYS,
        }
        for name, keys in expected_shapes.items():
            _exact_keys(errors, name.replace("_", " "), supplemental.get(name), keys)
        unsupported = supplemental.get("unsupported_operations")
        if not isinstance(unsupported, list) or len(unsupported) != 4:
            errors.append("worksheet must contain four unsupported operation rows")
        else:
            by_subject = {row.get("subject"): row for row in unsupported if isinstance(row, dict)}
            if set(by_subject) != set(VALIDATOR.UNSUPPORTED_CONTRACT):
                errors.append("worksheet unsupported subjects do not match the validator")
            for subject, reason in VALIDATOR.UNSUPPORTED_CONTRACT.items():
                row = by_subject.get(subject)
                if _exact_keys(errors, f"unsupported operation {subject}", row, VALIDATOR.UNSUPPORTED_ROW_KEYS):
                    if row.get("classification") != "unsupported" or row.get("denial_reason_code") != reason or row.get("provider_mutation_count") != 0:
                        errors.append(f"unsupported operation {subject} does not use its canonical denial contract")
        if supplemental.get("invoice_void", {}).get("operation") != "connected_invoice.void":
            errors.append("invoice void worksheet operation is not canonical")
        immediate = supplemental.get("immediate_cancellation", {})
        if immediate.get("strategy") not in VALIDATOR.IMMEDIATE_STRATEGIES or immediate.get("operation") != VALIDATOR.IMMEDIATE_STRATEGIES.get(immediate.get("strategy")):
            errors.append("immediate cancellation worksheet strategy and operation do not match")
        if supplemental.get("external_payment", {}).get("provider_mutation_count") != 0:
            errors.append("external payment worksheet must document zero provider mutations")
        period = supplemental.get("period_advancement", {})
        if period.get("direct_database_timestamp_edit") is not False:
            errors.append("period advancement worksheet must prohibit direct database timestamp edits")
        if period.get("advances_to") != 0 or period.get("observed_provider_boundary") != 0:
            errors.append("period advancement worksheet must use zero non-live timestamp sentinels")
        readbacks = (
            (supplemental.get("invoice_void", {}).get("provider_readback"), "invoice void provider readback", "invoice_void.provider", "void", VALIDATOR.INVOICE_VOID_PROVIDER_KEYS, "status"),
            (supplemental.get("invoice_void", {}).get("local_readback"), "invoice void local readback", "invoice_void.local", "void", VALIDATOR.INVOICE_VOID_LOCAL_KEYS, "status"),
            (immediate.get("provider_readback"), "immediate cancellation provider readback", "immediate_cancellation.provider", "canceled", VALIDATOR.IMMEDIATE_PROVIDER_KEYS, "status"),
            (immediate.get("local_readback"), "immediate cancellation local readback", "immediate_cancellation.local", "canceled", VALIDATOR.IMMEDIATE_LOCAL_KEYS, "enrollment_status"),
            (supplemental.get("external_payment", {}).get("provider_operation_inventory_readback"), "external payment inventory readback", "external_payment.inventory", "zero", None, "status"),
            (supplemental.get("external_payment", {}).get("local_readback"), "external payment local readback", "external_payment.local", "externally_recorded", None, "status"),
            (supplemental.get("period_advancement", {}).get("provider_readback"), "period provider readback", "period_advancement.provider", "advanced", VALIDATOR.PERIOD_PROVIDER_KEYS, "status"),
            (supplemental.get("period_advancement", {}).get("local_readback"), "period local readback", "period_advancement.local", "completed", VALIDATOR.PERIOD_LOCAL_KEYS, "due_transition_state"),
            (supplemental.get("ambiguity_recovery", {}).get("provider_readback"), "ambiguity provider readback", "ambiguity.provider", "found", VALIDATOR.AMBIGUITY_PROVIDER_KEYS, "status"),
            (supplemental.get("ambiguity_recovery", {}).get("local_readback"), "ambiguity local readback", "ambiguity.local", "completed", VALIDATOR.AMBIGUITY_LOCAL_KEYS, "status"),
        )
        for value, label, source_key, status, keys, status_field in readbacks:
            _canonical_readback(errors, value, label=label, source=VALIDATOR.SUPPLEMENTAL_SOURCES[source_key], status=status, keys=keys, status_field=status_field)
        for row in unsupported if isinstance(unsupported, list) else []:
            _canonical_readback(errors, row.get("denial_readback"), label=f"{row.get('subject')} denial readback", source=VALIDATOR.SUPPLEMENTAL_SOURCES["unsupported.denial"], status="denied")
            _canonical_readback(errors, row.get("provider_operation_inventory_readback"), label=f"{row.get('subject')} inventory readback", source=VALIDATOR.SUPPLEMENTAL_SOURCES["unsupported.inventory"], status="zero")
        dispute = supplemental.get("dispute_lifecycle", {})
        local_dispute = dispute.get("local_readback")
        _exact_keys(errors, "dispute provider readback", dispute.get("provider_readback"), VALIDATOR.DISPUTE_PROVIDER_KEYS)
        _exact_keys(errors, "dispute local readback", local_dispute, VALIDATOR.DISPUTE_LOCAL_KEYS)
        created, closed = dispute.get("created_event"), dispute.get("closed_event")
        for label, event, event_type in (("created", created, "charge.dispute.created"), ("closed", closed, "charge.dispute.closed")):
            if _exact_keys(errors, f"dispute {label} event", event, VALIDATOR.DISPUTE_EVENT_KEYS):
                if event.get("event_type") != event_type or event.get("local_event_id") != event.get("event_id") or event.get("local_processing_status") != "processed":
                    errors.append(f"dispute {label} event does not use canonical processed evidence")
        if isinstance(created, dict) and isinstance(closed, dict) and created.get("event_id") == closed.get("event_id"):
            errors.append("dispute event placeholders must be distinct")
        retry = supplemental.get("failed_payment_retry", {})
        for label, key, shape in (
            ("failed retry provider before", "failed_provider_readback", VALIDATOR.FAILED_PROVIDER_BEFORE_KEYS),
            ("failed retry local before", "failed_local_readback", VALIDATOR.FAILED_LOCAL_BEFORE_KEYS),
            ("failed retry provider after", "provider_readback", VALIDATOR.RETRY_PROVIDER_AFTER_KEYS),
            ("failed retry local after", "local_readback", VALIDATOR.RETRY_LOCAL_AFTER_KEYS),
        ):
            _exact_keys(errors, label, retry.get(key), shape)
        setup = supplemental.get("payer_setup_lifecycle", {})
        for phase in ("initial", "replacement"):
            row = setup.get(phase)
            if _exact_keys(errors, f"{phase} setup lifecycle", row, VALIDATOR.CONSENT_LIFECYCLE_KEYS):
                _exact_keys(errors, f"{phase} Checkout readback", row.get("provider_checkout_readback"), VALIDATOR.CHECKOUT_READBACK_KEYS)
                _exact_keys(errors, f"{phase} SetupIntent readback", row.get("provider_setup_intent_readback"), VALIDATOR.SETUP_INTENT_READBACK_KEYS)
                _exact_keys(errors, f"{phase} local setup readback", row.get("local_readback"), VALIDATOR.CONSENT_LOCAL_KEYS)
        duplicate = setup.get("duplicate_completion")
        if _exact_keys(errors, "duplicate completion", duplicate, VALIDATOR.DUPLICATE_COMPLETION_KEYS):
            provider_replay = duplicate.get("provider_replay")
            local_replay = duplicate.get("local_replay")
            if _exact_keys(errors, "duplicate provider replay", provider_replay, VALIDATOR.PROVIDER_REPLAY_KEYS):
                attempts = provider_replay.get("attempts")
                if not isinstance(attempts, list) or len(attempts) != 2:
                    errors.append("duplicate provider replay must contain two attempts")
                else:
                    for attempt in attempts:
                        _exact_keys(errors, "duplicate provider attempt", attempt, VALIDATOR.PROVIDER_REPLAY_ATTEMPT_KEYS)
            _exact_keys(errors, "duplicate local replay", local_replay, VALIDATOR.LOCAL_REPLAY_KEYS)
        refund = supplemental.get("refund_convergence", {})
        _exact_keys(errors, "refund provider readback", refund.get("provider_readback"), VALIDATOR.REFUND_PROVIDER_KEYS)
        _exact_keys(errors, "refund local readback", refund.get("local_readback"), VALIDATOR.REFUND_LOCAL_KEYS)
        platform = supplemental.get("platform_fixture", {})
        _exact_keys(errors, "platform customer readback", platform.get("customer_readback"), VALIDATOR.PLATFORM_CUSTOMER_KEYS)
        _exact_keys(errors, "platform provider readback", platform.get("provider_readback"), VALIDATOR.PLATFORM_PROVIDER_KEYS)
        _exact_keys(errors, "platform local readback", platform.get("local_readback"), VALIDATOR.PLATFORM_LOCAL_KEYS)
        if platform.get("customer_preexisted") is not True or platform.get("provider_mutation_count") != 1 or platform.get("cleanup_required") is not True or platform.get("cleanup_timing") != "after_evidence_validation":
            errors.append("platform worksheet must require one subscription mutation from a pre-existing customer and post-validation cleanup")
        if (platform.get("customer_readback") or {}).get("created_at") != 0 or (platform.get("provider_readback") or {}).get("created_at") != 0:
            errors.append("platform worksheet must use two zero non-live timestamp sentinels")

    terminal = template.get("terminal_counts")
    if _exact_keys(errors, "terminal counts", terminal, VALIDATOR.TERMINAL_KEYS):
        if terminal.get("capture_boundary") != BOUNDARY:
            errors.append("terminal counts must use the canonical shared capture boundary")
        counts = terminal.get("counts")
        if _exact_keys(errors, "terminal count rows", counts, VALIDATOR.TERMINAL_COUNT_KEYS):
            for name, row in counts.items():
                if _exact_keys(errors, f"terminal count {name}", row, VALIDATOR.TERMINAL_ROW_KEYS):
                    if row.get("count") != 0 or row.get("readback_boundary") != BOUNDARY or row.get("source") != VALIDATOR.TERMINAL_SOURCES[name]:
                        errors.append(f"terminal count {name} must be sourced zero at the shared boundary")
        components = terminal.get("wrong_mode_components")
        if not isinstance(components, list) or len(components) != 2:
            errors.append("wrong-mode components must be exact provider and local rows")
        else:
            by_surface = {row.get("surface"): row for row in components if isinstance(row, dict)}
            if set(by_surface) != {"provider", "local"}:
                errors.append("wrong-mode components must be exact provider and local rows")
            for surface in ("provider", "local"):
                row = by_surface.get(surface)
                if _exact_keys(errors, f"wrong-mode {surface} component", row, VALIDATOR.WRONG_MODE_COMPONENT_KEYS):
                    if row.get("count") != 0 or row.get("readback_boundary") != BOUNDARY or row.get("source") != VALIDATOR.WRONG_MODE_SOURCES[surface]:
                        errors.append(f"wrong-mode {surface} component must be a sourced zero at the shared boundary")

    steps = template.get("steps")
    if not isinstance(steps, list):
        errors.append("steps must be a list")
    else:
        by_name = {step.get("name"): step for step in steps if isinstance(step, dict)}
        if len(by_name) != len(steps) or set(by_name) != VALIDATOR.REQUIRED_STEPS:
            errors.append("step names do not match the validator required steps")
        if [step.get("name") for step in steps if isinstance(step, dict)] != list(VALIDATOR.REQUIRED_STEP_ORDER):
            errors.append("steps do not match the canonical validator order")
        if len(steps) != 15:
            errors.append("worksheet must contain exactly 15 core proof steps")
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
        if [row.get("step_name") for row in mutations if isinstance(row, dict)] != list(VALIDATOR.REQUIRED_MUTATIONS):
            errors.append("mutation rows do not match the canonical validator order")
        if len(mutations) != 24:
            errors.append("worksheet must contain exactly 24 core mutation rows")
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
    parser = argparse.ArgumentParser(description="Check Stripe rehearsal worksheet schema-v4 drift.")
    parser.add_argument("--worksheet", type=Path, default=DEFAULT_WORKSHEET)
    args = parser.parse_args(argv)
    try:
        errors = validate_worksheet(args.worksheet)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Worksheet check failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("Worksheet check failed:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print("Stripe provider rehearsal worksheet matches validator schema v4.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
