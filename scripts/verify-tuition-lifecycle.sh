#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PYTHON="${KOARYU_BACKEND_PYTHON:-$ROOT_DIR/backend/venv/bin/python}"

if [[ ! -x "$BACKEND_PYTHON" ]]; then
  echo "Backend Python not found at $BACKEND_PYTHON." >&2
  echo "Create backend/venv or set KOARYU_BACKEND_PYTHON to a Python 3.11 environment with backend dev dependencies." >&2
  exit 1
fi

backend_tests=(
  "tests/test_billing_autopay_lifecycle.py"
  "tests/test_billing_endpoint_permissions.py"
  "tests/test_billing_invoice_lifecycle.py"
  "tests/test_billing_invoice_projection.py"
  "tests/test_billing_payment_intent_lifecycle.py"
  "tests/test_billing_payments.py"
  "tests/test_billing_schemas.py"
  "tests/test_billing_subscription_projection_lifecycle.py"
  "tests/test_billing_webhook_endpoint_contracts.py"
  "tests/test_billing_webhook_ordering_lifecycle.py"
  "tests/test_stripe_mutation_policy.py"
  "tests/test_webhook_service.py"
)

frontend_tests=(
  "tests/billing-invoice-action-model.test.mjs"
  "tests/billing-page-model.test.mjs"
  "tests/billing-policy.test.mjs"
  "tests/billing-route-access.test.mjs"
)

echo "Running isolated backend tuition lifecycle tests with provider fakes"
(
  cd "$ROOT_DIR/backend"
  "$BACKEND_PYTHON" -m pytest "${backend_tests[@]}"
)

echo "Running isolated frontend tuition lifecycle tests"
(
  cd "$ROOT_DIR/frontend"
  node --test "${frontend_tests[@]}"
)
