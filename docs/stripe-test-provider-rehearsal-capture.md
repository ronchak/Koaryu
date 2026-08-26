# Stripe test-provider rehearsal capture worksheet (schema v3)

Use this worksheet for one approved staging rehearsal of one exact candidate. It is an offline evidence contract, not a provider client. Never paste secrets, hosted URLs, payment details, KYC data, request or response payloads, or live financial data into the evidence file.

Before opening Stripe, verify the exact staging frontend and backend SHA and require Stripe test mode:

```bash
npm run verify:deployed-release -- \
  --environment staging \
  --expected-sha <40-character-candidate-sha> \
  --frontend-origin https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app \
  --backend-api https://koaryu-staging.onrender.com/api/v1 \
  --expected-stripe-mode test
```

Run the named workflows once, in template order. Preserve the original caller key for ambiguous responses, but record only its SHA-256 digest. Reconcile by exact provider readback and local projection. Never issue an automatic retry. Platform and Connect webhook evidence must come from separate delivered events and matching local `processed` rows.

The rehearsal must finish with zero failed, stuck, unmapped, wrong-mode, wrong-generation, pending-transition, and reconciliation-required rows. Stop if any count is nonzero.

## Canonical schema-v3 template

Copy this block to a private evidence file and replace every angle-bracket placeholder. Keep the field set exact.

<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V3_TEMPLATE:START -->
```json
{
  "schema_version": 3,
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
  "role_capabilities": {
    "admin": ["connect.onboarding", "enrollment.activate", "enrollment.cancel.immediate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "invoice.create", "invoice.finalize", "invoice.retry", "payer.setup", "payer.sync", "payment.refund", "plan.sync"],
    "front_desk": ["enrollment.activate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "payer.setup"],
    "instructor": []
  },
  "workflow_facts": {
    "product_id": "<PROD_ID>", "price_id": "<PRICE_ID>", "payer_id": "<PAYER_ID>", "customer_id": "<CUS_ID>",
    "consent_payer_id": "<PAYER_ID>", "setup_request_id": "<SETUP_REQUEST_ID>", "consent_id": "<CONSENT_ID>",
    "setup_intent_id": "<SETI_ID>", "payment_method_id": "<PM_ID>", "terms_version": "<TERMS_VERSION>",
    "consent_accepted": true, "consent_completed": true, "duplicate_consent_completion_outcome": "replay",
    "student_ids": ["<STUDENT_1_ID>", "<STUDENT_2_ID>"], "subscription_id": "<SUB_ID>", "subscription_item_id": "<SI_ID>",
    "shared_provider_quantity": 2, "shared_local_active_count": 2,
    "invoice_link_id": "<INVOICE_LINK_LOCAL_ID>", "invoice_link_stripe_id": "<INVOICE_LINK_STRIPE_ID>",
    "invoice_link_finalized": true, "invoice_link_sent": true,
    "automatic_invoice_id": "<AUTOMATIC_INVOICE_LOCAL_ID>", "automatic_payment_intent_id": "<PI_ID>", "automatic_charge_id": "<CH_ID>",
    "automatic_amount_cents": 10000, "application_fee_bps": 50, "provider_application_fee_cents": 50,
    "failed_payment_invoice_id": "<FAILED_INVOICE_LOCAL_ID>",
    "failed_payment_retry_workflow": "invoice.retry", "failed_payment_retry_outcome": "succeeded", "failed_payment_retry_mutation_count": 1,
    "period_schedule_state": "scheduled", "period_revoke_state": "revoked", "period_due_state": "completed",
    "period_schedule_intent_id": "<SCHEDULE_INTENT_ID>", "period_revoke_intent_id": "<REVOKE_INTENT_ID>", "period_due_intent_id": "<DUE_INTENT_ID>",
    "period_strategy": "subscription_item_delete_at_period_end", "period_quantity_before": 2, "period_quantity_after": 1,
    "adjusted_payment_id": "<PAYMENT_LOCAL_ID>", "refund_id": "<REFUND_ID>", "dispute_id": "<DISPUTE_ID>",
    "gross_paid_cents": 10000, "refunded_cents": 1000, "disputed_cents": 0, "net_collected_cents": 9000,
    "refundable_remaining_cents": 9000, "invoice_remaining_before_cents": 0, "invoice_remaining_after_cents": 0,
    "payer_status_before": "current", "payer_status_after": "current", "adjustment_reconciliation_required": false,
    "ambiguous_mutation_step_name": "payer.customer_create", "ambiguous_caller_key_sha256": "<CALLER_KEY_SHA256:payer.customer_create>",
    "ambiguous_provider_mutation_count": 1, "ambiguous_automatic_retry_count": 0, "ambiguous_provider_readback_count": 1,
    "ambiguous_recovery_outcome": "reconciled", "ambiguous_final_state": "completed"
  },
  "steps": [
    {"name": "health_exact_candidate", "status": "pass", "stripe_account_id": null},
    {"name": "operation_bounded_role_capabilities", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "plan_product_price", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "payer_customer", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "payer_consent_duplicate_replay", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "shared_subscription_quantity_two", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "invoice_link_finalize_send", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "automatic_payment_fee_50bps", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "failed_payment_named_retry", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "period_end_schedule_revoke_due", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "refund_dispute_convergence", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "ambiguous_same_key_readback_recovery", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "platform_webhook_delivery_readback", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": null},
    {"name": "connect_webhook_delivery_readback", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"},
    {"name": "terminal_zero_counts", "status": "pass", "studio_id": "<STUDIO_ID>", "stripe_account_id": "<STRIPE_CONNECT_ACCOUNT_ID>"}
  ],
  "mutation_attempts": [
    {"step_name":"connect.account_create","workflow_id":"connect.onboarding","operation":"connect_account.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_onboarding","stripe_account_id":null,"caller_request_key_sha256":"<CALLER_KEY_SHA256:connect.account_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"connect.onboarding_link","workflow_id":"connect.onboarding","operation":"connect_onboarding_link.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_onboarding","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:connect.onboarding_link>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"payer.customer_create","workflow_id":"payer.sync","operation":"connected_customer.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:payer.customer_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"reconciled"},
    {"step_name":"payer.setup_checkout","workflow_id":"payer.setup","operation":"connected_setup_checkout_session.create","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:payer.setup_checkout>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"plan.product_create","workflow_id":"plan.sync","operation":"connected_product.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:plan.product_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"plan.price_create","workflow_id":"plan.sync","operation":"connected_price.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:plan.price_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"enrollment.subscription_create","workflow_id":"enrollment.activate","operation":"connected_subscription.create","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:enrollment.subscription_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"enrollment.shared_quantity_update","workflow_id":"enrollment.activate","operation":"connected_subscription_item.update","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:enrollment.shared_quantity_update>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"invoice_link.invoice_create","workflow_id":"invoice.create","operation":"connected_invoice.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:invoice_link.invoice_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"invoice_link.item_create","workflow_id":"invoice.create","operation":"connected_invoice_item.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:invoice_link.item_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"invoice_link.finalize","workflow_id":"invoice.finalize","operation":"connected_invoice.finalize","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:invoice_link.finalize>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"invoice_link.send","workflow_id":"invoice.finalize","operation":"connected_invoice.send","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:invoice_link.send>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"automatic.invoice_create","workflow_id":"invoice.create","operation":"connected_invoice.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:automatic.invoice_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"automatic.item_create","workflow_id":"invoice.create","operation":"connected_invoice_item.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:automatic.item_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"automatic.finalize","workflow_id":"invoice.finalize","operation":"connected_invoice.finalize","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:automatic.finalize>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"automatic.pay","workflow_id":"invoice.retry","operation":"connected_invoice.pay","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:automatic.pay>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"invoice_retry.pay","workflow_id":"invoice.retry","operation":"connected_invoice.pay","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:invoice_retry.pay>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"period_end.due_quantity_update","workflow_id":"enrollment.cancel.period_end.execute","operation":"connected_subscription_item.update","actor_role":"internal","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.due_quantity_update>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"payment.refund","workflow_id":"payment.refund","operation":"connected_refund.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:payment.refund>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"}
  ],
  "webhook_delivery_evidence": {
    "platform": {"surface":"platform","endpoint_url":"<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/platform","connect":false,"event_id":"<PLATFORM_EVT_ID>","event_type":"invoice.paid","studio_id":"<STUDIO_ID>","stripe_account_id":null,"connect_account_generation":null,"provider_delivery_status":"delivered","provider_http_status":200,"local_event_id":"<PLATFORM_EVT_ID>","local_processing_status":"processed"},
    "connect": {"surface":"connect","endpoint_url":"<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/connect","connect":true,"event_id":"<CONNECT_EVT_ID>","event_type":"invoice.paid","studio_id":"<STUDIO_ID>","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","connect_account_generation":"<CONNECT_ACCOUNT_GENERATION>","provider_delivery_status":"delivered","provider_http_status":200,"local_event_id":"<CONNECT_EVT_ID>","local_processing_status":"processed"}
  },
  "terminal_counts": {"failed":0,"stuck":0,"unmapped":0,"wrong_mode":0,"wrong_generation":0,"pending_transition":0,"reconciliation_required":0}
}
```
<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V3_TEMPLATE:END -->

Validate the worksheet and then the private evidence file offline:

```bash
python3 scripts/check-stripe-provider-rehearsal-worksheet.py
python3 scripts/verify-stripe-provider-rehearsal.py \
  --evidence <sanitized-evidence.json> \
  --expected-candidate-sha <40-character-candidate-sha> \
  --expected-backend-origin https://koaryu-staging.onrender.com
```

If either command fails, preserve the sanitized identifiers and stop. Do not contact production, retry a provider mutation, or weaken a terminal count.
