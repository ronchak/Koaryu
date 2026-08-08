# Stripe test-provider rehearsal capture worksheet (schema v2)

Use this worksheet once, in order, for the director-approved hosted Stripe **test-mode** rehearsal of one exact staging candidate. It is a capture worksheet, not evidence: replace every angle-bracket placeholder only in a private sanitized evidence file. Do not put secrets, provider payloads, hosted URLs, business/KYC details, payment details, or live financial data in that file. `secrets_redacted` is therefore `true`; `financial_canary_performed` is always `false`.

This is staging only. Do not use production and do not use this flow to authorize live money movement.

## 0. Preflight before opening the browser

Run this exact command **before opening the browser**. Stop on any failure; do not proceed or substitute production.

```bash
npm run verify:deployed-release -- \
  --environment staging \
  --expected-sha <40-character-candidate-sha> \
  --frontend-origin https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app \
  --backend-api https://koaryu-staging.onrender.com/api/v1 \
  --expected-stripe-mode test
```

Record the exact lowercase candidate SHA in `candidate_sha` and the readiness SHA in `health_commit_sha`; both must be the same candidate. Record test mode as `stripe_mode: "test"` and `livemode: false`. The preflight verifies the pinned frontend plus both backend readiness routes; each backend route must explicitly report Stripe mode `test`.

## Capture rules that apply throughout

- Establish one sanitized `studio_id` before any scoped action. It is reused by every mutation, non-health step, and both delivery records.
- Capture one sanitized `stripe_account_id` and its positive `connect_account_generation` immediately after Connect account creation/readback. They are reused everywhere Connect-scoped.
- Store the deterministic `idempotency_key` immediately for **every** mutation, including the initial `connect_onboarding_link.create`. Set each mutation's `automatic_retry_count` to `0`.
- If a response is ambiguous, retain the stored key and reconcile by provider object/event and local readback. Do not issue a second mutation. Record `outcome: "reconciled"` only after that readback converges; otherwise stop for review.
- Platform and Connect are separate surfaces: capture different `evt_...` IDs. Each delivery record's `local_event_id` equals that record's own `event_id`, and `local_processing_status` is `processed`.
- There is no global event-ID field in schema v2. Do not add `webhook_event_ids`, any legacy list, provider payload, secret-shaped field, or any other extra field. The only event IDs are inside the two delivery records.

## Operator sequence and field mapping

1. **Exact candidate and mode.** Complete the preflight above before browser use. Fill top-level `candidate_sha`, `health_commit_sha`, `health_ready_url`, `stripe_mode`, `livemode`, `secrets_redacted`, and `financial_canary_performed`; mark `steps[].name: "health_exact_candidate"` `pass` with `stripe_account_id: null`. This health step has no `studio_id`.
2. **Studio context.** Capture the single sanitized studio identifier before mutation. Fill top-level `studio_id`; repeat it in every later step, mutation, and delivery record.
3. **Create and read back the Connect account/generation.** Immediately save the deterministic key for `mutation_attempts[].operation: "connect_account.create"`; its exact `scope` is `connect_onboarding` and `stripe_account_id` is `null`. On creation/readback capture the sanitized account ID and positive generation into top-level `stripe_account_id` and `connect_account_generation`, then mark `steps[].name: "connect_account_readback"` `pass` with that studio/account context.
4. **Initial hosted Account Link, hosted onboarding, and readiness readback.** Immediately save the key for `connect_onboarding_link.create`, scope `connect_onboarding`, with the rehearsal account ID. Open only the hosted onboarding route after the link is safely delivered, and capture no hosted URL or provider payload. After return, read back the account/readiness state. Mark `hosted_onboarding_link` and `account_readiness_readback` `pass`, each with the studio and rehearsal account context.
5. **Connected customer.** Immediately save the key for `connected_customer.create`, scope `connect_payments`, and the rehearsal account. Capture the sanitized readback outcome and mark `connected_customer` `pass` with studio/account context.
6. **Setup payment method.** Immediately save the key for `connected_setup_checkout_session.create`, scope `connect_payments`, and the rehearsal account. Complete the hosted setup flow without recording its URL, payload, or payment data; after readback mark `setup_payment_method` `pass` with studio/account context.
7. **Product and price.** Immediately save one key each for `connected_product.create` and `connected_price.create`; both use scope `connect_payments` and the rehearsal account. Record their sanitized successful/readback outcomes and mark `plan_product_price` `pass` with studio/account context.
8. **Invoice creation and payment.** Immediately save one key each for `connected_invoice.create` and `connected_invoice.pay`; both use `connect_payments` and the rehearsal account. After invoice/payment readbacks converge, mark `invoice_payment` `pass` with studio/account context.
9. **Refund convergence.** Immediately save the key for `connected_refund.create`, scope `connect_payments`, and the rehearsal account. Wait for provider and local refund readbacks to converge, then mark `refund_convergence` `pass` with studio/account context.
10. **Dispute convergence.** This is a required readback step, not an additional schema-v2 mutation operation. Capture only the sanitized convergence result and mark `dispute_convergence` `pass` with studio/account context. Do not invent an operation row the validator does not require.
11. **Platform webhook delivery and local readback.** Capture a platform `evt_...` identifier, a platform-contract event type, provider delivery status and 2xx status, and the local processed readback. Mark `platform_webhook_delivery_readback` `pass` with the studio and explicit `stripe_account_id: null`. In `webhook_delivery_evidence.platform`, both `stripe_account_id` and `connect_account_generation` are explicitly `null`.
12. **Connect webhook delivery and local readback.** Capture a different Connect `evt_...` identifier, a Connect-contract event type, provider delivery status and 2xx status, and the local processed readback. Mark `connect_webhook_delivery_readback` `pass` with the studio and rehearsal account. In `webhook_delivery_evidence.connect`, the account and positive generation exactly match the top-level rehearsal context.
13. **Assemble and validate offline.** Copy the canonical template below into a private `<sanitized-evidence.json>`, replace only its placeholders, retain only its exact fields, and validate it offline.

Every mutation row has exactly these fields: `operation`, `studio_id`, `scope`, `stripe_account_id`, `automatic_retry_count`, `outcome`, and `idempotency_key`. Its `outcome` is `succeeded` or `reconciled`; all listed mutations have retry count zero. The exact required operations/scopes are captured in the template and map to `connect_onboarding` for the account and initial link, then `connect_payments` for connected customer, setup session, product, price, invoice create/pay, and refund.

## Canonical copy-and-fill schema-v2 template

This marked block is deliberately invalid until its angle-bracket placeholders are replaced in a private file. It is the only canonical template in this worksheet and is checked against the validator source.

<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V2_TEMPLATE:START -->
```json
{
  "schema_version": 2,
  "candidate_sha": "<40-CHARACTER-CANDIDATE-SHA>",
  "health_commit_sha": "<40-CHARACTER-CANDIDATE-SHA>",
  "health_ready_url": "<PINNED_STAGING_BACKEND_ORIGIN>/health/ready",
  "stripe_mode": "test",
  "livemode": false,
  "secrets_redacted": true,
  "financial_canary_performed": false,
  "studio_id": "<STUDIO_ID>",
  "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>",
  "connect_account_generation": "<CONNECT_ACCOUNT_GENERATION>",
  "steps": [
    {"name": "health_exact_candidate", "status": "pass", "stripe_account_id": null},
    {"name": "connect_account_readback", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "hosted_onboarding_link", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "account_readiness_readback", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "connected_customer", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "setup_payment_method", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "plan_product_price", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "invoice_payment", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "refund_convergence", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "dispute_convergence", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "platform_webhook_delivery_readback", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": null},
    {"name": "connect_webhook_delivery_readback", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"}
  ],
  "mutation_attempts": [
    {"operation": "connect_account.create", "studio_id": "<STUDIO_ID>", "scope": "connect_onboarding", "stripe_account_id": null, "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connect_account.create>"},
    {"operation": "connect_onboarding_link.create", "studio_id": "<STUDIO_ID>", "scope": "connect_onboarding", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connect_onboarding_link.create>"},
    {"operation": "connected_customer.create", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_customer.create>"},
    {"operation": "connected_setup_checkout_session.create", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_setup_checkout_session.create>"},
    {"operation": "connected_product.create", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_product.create>"},
    {"operation": "connected_price.create", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_price.create>"},
    {"operation": "connected_invoice.create", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_invoice.create>"},
    {"operation": "connected_invoice.pay", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_invoice.pay>"},
    {"operation": "connected_refund.create", "studio_id": "<STUDIO_ID>", "scope": "connect_payments", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>", "automatic_retry_count": 0, "outcome": "succeeded", "idempotency_key": "<IDEMPOTENCY_KEY:connected_refund.create>"}
  ],
  "webhook_delivery_evidence": {
    "platform": {
      "surface": "platform",
      "endpoint_url": "<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/platform",
      "connect": false,
      "event_id": "<PLATFORM_EVT_ID>",
      "event_type": "invoice.paid",
      "studio_id": "<STUDIO_ID>",
      "stripe_account_id": null,
      "connect_account_generation": null,
      "provider_delivery_status": "delivered",
      "provider_http_status": 200,
      "local_event_id": "<PLATFORM_EVT_ID>",
      "local_processing_status": "processed"
    },
    "connect": {
      "surface": "connect",
      "endpoint_url": "<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/connect",
      "connect": true,
      "event_id": "<CONNECT_EVT_ID>",
      "event_type": "invoice.paid",
      "studio_id": "<STUDIO_ID>",
      "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>",
      "connect_account_generation": "<CONNECT_ACCOUNT_GENERATION>",
      "provider_delivery_status": "delivered",
      "provider_http_status": 200,
      "local_event_id": "<CONNECT_EVT_ID>",
      "local_processing_status": "processed"
    }
  }
}
```
<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V2_TEMPLATE:END -->

## Final offline validation

Run the worksheet drift check while reviewing the documentation:

```bash
python3 scripts/check-stripe-provider-rehearsal-worksheet.py
```

Then validate the private completed evidence. The backend argument is the exact pinned staging **origin only** (no `/api/v1`):

```bash
python3 scripts/verify-stripe-provider-rehearsal.py \
  --evidence <sanitized-evidence.json> \
  --expected-candidate-sha <40-character-candidate-sha> \
  --expected-backend-origin https://koaryu-staging.onrender.com
```

Stop and preserve the captured identifiers if either check fails. Do not add fields, retry mutations automatically, or use production to resolve a failed rehearsal.
