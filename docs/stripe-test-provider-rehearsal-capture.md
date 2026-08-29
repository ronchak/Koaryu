# Stripe test-provider rehearsal capture worksheet (schema v4)

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

The core inventory is fixed at 15 proof steps and 24 mutation-attempt rows. Do not add a core row for supplemental proof. Record void, immediate cancellation, external payment, denied operations, retry, period advancement, dispute closure, and ambiguity recovery in `supplemental_evidence`.

Use one UTC RFC3339 capture boundary after the last readback. Every supplemental provider or local readback and every terminal-count query must name that boundary. Create the rehearsal customer, subscription, invoice, and dispute fixture on the same sanitized Stripe test-clock ID, then advance that clock to exercise the period boundary. Replace both `period_advancement.advances_to` and `period_advancement.observed_provider_boundary` sentinel values with the same positive Unix timestamp returned by the Stripe test clock. The template's zeroes are non-live sentinels and fail private evidence validation. Never edit a database timestamp. The rehearsal must finish with zero failed, stuck, unmapped, wrong-mode, wrong-generation, pending-transition, and reconciliation-required rows. Each zero needs its canonical query or provider/local component source. Stop if any count is nonzero, unsourced, or captured at another boundary.

Before payer sync, create the test clock through attended Stripe test tooling on the
rehearsal connected account. Send its exact ID only on the first customer-creating sync:

```http
POST /api/v1/billing/payers/{payer_id}/sync
Idempotency-Key: <caller-owned-key>
Content-Type: application/json

{"test_clock_id":"clock_..."}
```

The request body remains optional for ordinary sync. Test-clock binding is accepted only
for a new customer in exact staging test mode and is part of the durable request hash.
Prepare the two provider-backed enrollment rows next through either authenticated
enrollment-create route. That exact staging/test exception creates local pending rows
only; activate them through the existing idempotent activation workflow. Never bind a
directly created Stripe customer or repair the fixture with service-role SQL.

### Evidence-source map

The source labels below are exact contract values. Provider readbacks mean the named Stripe test-mode object retrieval. API/catalog readbacks mean the sanitized workflow or sink decision returned by the deployed candidate. Database readbacks mean the named local projection, operation, step, event, audit, transition, or count view at the shared boundary. The provider-operation inventory entries show no matching provider operation for local-only and denied cases.

| Evidence | Canonical readback |
| --- | --- |
| Invoice void | `stripe.invoice.retrieve` and `billing_invoices.status` |
| Immediate cancellation | `stripe.subscription.retrieve` and `billing_enrollment_transition_intents_and_enrollments` |
| External payment | `billing_payments_and_audit` plus `billing_provider_operation_inventory.payment_external_record` |
| Unsupported subjects | `billing_workflow_and_sink_catalog` plus `billing_provider_operation_inventory.unsupported_subject` |
| Failed-payment retry | The `failed_before_retry` provider/local pair, then the `after_retry` provider/local pair |
| Period advancement | `stripe.test_clock.retrieve` and `billing_enrollment_transition_intents` |
| Dispute lifecycle | Distinct processed created and closed event IDs, `stripe.dispute.retrieve`, and `billing_disputes.status_and_state_category` |
| Ambiguity recovery | `stripe.customer.retrieve` and `billing_provider_operations_and_steps` |
| Terminal counts | The seven exact `terminal_counts.counts` sources and the provider/local wrong-mode component sources in the template |

The offline checker and validator verify this sanitized evidence contract and its cross-field bindings. They do not independently query Stripe or the deployed database and do not establish provider truth by themselves. Do not add secrets, hosted URLs, raw provider payloads, card data, KYC data, or direct hosted-system SQL to the evidence file.

## Canonical schema-v4 template

Copy this block to a private evidence file and replace every angle-bracket placeholder. Keep the field set exact.

<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V4_TEMPLATE:START -->
```json
{
  "schema_version": 4,
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
    "admin": ["connect.onboarding", "enrollment.activate", "enrollment.cancel.immediate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "invoice.create", "invoice.finalize", "invoice.retry", "invoice.void", "payer.setup", "payer.sync", "payment.external.record", "payment.refund", "plan.sync"],
    "front_desk": ["enrollment.activate", "enrollment.cancel.period_end.revoke", "enrollment.cancel.period_end.schedule", "payer.setup", "payment.external.record"],
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
    "period_revoke_schedule_id": "<SUB_SCHED_REVOKE_ID>", "period_due_schedule_id": "<SUB_SCHED_DUE_ID>",
    "period_strategy": "subscription_schedule_shared_item_delete_at_period_end", "period_quantity_before": 2, "period_quantity_after": 1,
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
    {"step_name":"period_end.revoke_schedule_create","workflow_id":"enrollment.cancel.period_end.schedule","operation":"connected_subscription_schedule.create","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.revoke_schedule_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"period_end.revoke_schedule_update","workflow_id":"enrollment.cancel.period_end.schedule","operation":"connected_subscription_schedule.update","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.revoke_schedule_update>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"period_end.revoke_release","workflow_id":"enrollment.cancel.period_end.revoke","operation":"connected_subscription_schedule.release","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.revoke_release>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"period_end.due_schedule_create","workflow_id":"enrollment.cancel.period_end.schedule","operation":"connected_subscription_schedule.create","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.due_schedule_create>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"period_end.due_schedule_update","workflow_id":"enrollment.cancel.period_end.schedule","operation":"connected_subscription_schedule.update","actor_role":"front_desk","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.due_schedule_update>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"period_end.due_release","workflow_id":"enrollment.cancel.period_end.execute","operation":"connected_subscription_schedule.release","actor_role":"internal","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:period_end.due_release>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"},
    {"step_name":"payment.refund","workflow_id":"payment.refund","operation":"connected_refund.create","actor_role":"admin","studio_id":"<STUDIO_ID>","scope":"connect_payments","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:payment.refund>","provider_mutation_count":1,"automatic_retry_count":0,"outcome":"succeeded"}
  ],
  "webhook_delivery_evidence": {
    "platform": {"surface":"platform","endpoint_url":"<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/platform","connect":false,"event_id":"<PLATFORM_EVT_ID>","event_type":"invoice.paid","studio_id":"<STUDIO_ID>","stripe_account_id":null,"connect_account_generation":null,"provider_delivery_status":"delivered","provider_http_status":200,"local_event_id":"<PLATFORM_EVT_ID>","local_processing_status":"processed"},
    "connect": {"surface":"connect","endpoint_url":"<PINNED_STAGING_BACKEND_ORIGIN>/api/v1/webhooks/stripe/connect","connect":true,"event_id":"<CONNECT_EVT_ID>","event_type":"invoice.paid","studio_id":"<STUDIO_ID>","stripe_account_id":"<STRIPE_CONNECT_ACCOUNT_ID>","connect_account_generation":"<CONNECT_ACCOUNT_GENERATION>","provider_delivery_status":"delivered","provider_http_status":200,"local_event_id":"<CONNECT_EVT_ID>","local_processing_status":"processed"}
  },
  "supplemental_evidence": {
    "invoice_void": {"workflow_id":"invoice.void","operation":"connected_invoice.void","actor_role":"admin","provider_attempt_count":1,"provider_mutation_count":1,"automatic_retry_count":0,"caller_request_key_sha256":"<CALLER_KEY_SHA256:invoice.void>","durable_operation_id":"<INVOICE_VOID_OPERATION_ID>","provider_readback":{"source":"stripe.invoice.retrieve","status":"void","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_invoices.status","status":"void","capture_boundary":"<CAPTURE_BOUNDARY>"}},
    "immediate_cancellation": {"workflow_id":"enrollment.cancel.immediate","strategy":"whole_subscription_cancel","operation":"connected_subscription.cancel","actor_role":"admin","provider_attempt_count":1,"provider_mutation_count":1,"automatic_retry_count":0,"caller_request_key_sha256":"<CALLER_KEY_SHA256:enrollment.cancel.immediate>","durable_operation_id":"<IMMEDIATE_CANCEL_OPERATION_ID>","provider_readback":{"source":"stripe.subscription.retrieve","status":"canceled","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_enrollment_transition_intents_and_enrollments","status":"canceled","capture_boundary":"<CAPTURE_BOUNDARY>"}},
    "external_payment": {"workflow_id":"payment.external.record","local_payment_id":"<EXTERNAL_PAYMENT_LOCAL_ID>","local_status":"externally_recorded","replay_payment_id":"<EXTERNAL_PAYMENT_LOCAL_ID>","caller_request_key_sha256":"<CALLER_KEY_SHA256:payment.external.record>","replay_outcome":"same_row","audit_count":1,"invoice_id":null,"provider_mutation_count":0,"provider_operation_inventory_readback":{"source":"billing_provider_operation_inventory.payment_external_record","status":"zero","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_payments_and_audit","status":"externally_recorded","capture_boundary":"<CAPTURE_BOUNDARY>"}},
    "unsupported_operations": [
      {"subject":"enrollment.pause.generic","classification":"unsupported","denial_reason_code":"named_enrollment_pause_workflow_required","provider_mutation_count":0,"denial_readback":{"source":"billing_workflow_and_sink_catalog","status":"denied","capture_boundary":"<CAPTURE_BOUNDARY>"},"provider_operation_inventory_readback":{"source":"billing_provider_operation_inventory.unsupported_subject","status":"zero","capture_boundary":"<CAPTURE_BOUNDARY>"}},
      {"subject":"enrollment.resume.generic","classification":"unsupported","denial_reason_code":"named_enrollment_resume_workflow_required","provider_mutation_count":0,"denial_readback":{"source":"billing_workflow_and_sink_catalog","status":"denied","capture_boundary":"<CAPTURE_BOUNDARY>"},"provider_operation_inventory_readback":{"source":"billing_provider_operation_inventory.unsupported_subject","status":"zero","capture_boundary":"<CAPTURE_BOUNDARY>"}},
      {"subject":"enrollment.cancel.generic","classification":"unsupported","denial_reason_code":"named_enrollment_cancellation_workflow_required","provider_mutation_count":0,"denial_readback":{"source":"billing_workflow_and_sink_catalog","status":"denied","capture_boundary":"<CAPTURE_BOUNDARY>"},"provider_operation_inventory_readback":{"source":"billing_provider_operation_inventory.unsupported_subject","status":"zero","capture_boundary":"<CAPTURE_BOUNDARY>"}},
      {"subject":"connected_customer.default_payment_method.update","classification":"unsupported","denial_reason_code":"payer_setup_must_not_mutate_customer_default_payment_method","provider_mutation_count":0,"denial_readback":{"source":"billing_workflow_and_sink_catalog","status":"denied","capture_boundary":"<CAPTURE_BOUNDARY>"},"provider_operation_inventory_readback":{"source":"billing_provider_operation_inventory.unsupported_subject","status":"zero","capture_boundary":"<CAPTURE_BOUNDARY>"}}
    ],
    "failed_payment_retry": {"workflow_id":"invoice.retry","operation":"connected_invoice.pay","failed_provider_readback":{"source":"stripe.invoice.retrieve.failed_before_retry","status":"failed","capture_boundary":"<CAPTURE_BOUNDARY>"},"failed_local_readback":{"source":"billing_invoices_and_payments.failed_before_retry","status":"failed","capture_boundary":"<CAPTURE_BOUNDARY>"},"provider_readback":{"source":"stripe.invoice.retrieve.after_retry","status":"paid","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_invoices_and_payments.after_retry","status":"succeeded","capture_boundary":"<CAPTURE_BOUNDARY>"}},
    "period_advancement": {"method":"stripe_test_clock.advance","test_clock_id":"<TEST_CLOCK_ID>","advances_to":0,"observed_provider_boundary":0,"direct_database_timestamp_edit":false,"provider_readback":{"source":"stripe.test_clock.retrieve","status":"advanced","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_enrollment_transition_intents","status":"completed","capture_boundary":"<CAPTURE_BOUNDARY>"}},
    "dispute_lifecycle": {"dispute_id":"<DISPUTE_ID>","created_event":{"event_id":"<DISPUTE_CREATED_EVT_ID>","event_type":"charge.dispute.created","local_event_id":"<DISPUTE_CREATED_EVT_ID>","local_processing_status":"processed"},"closed_event":{"event_id":"<DISPUTE_CLOSED_EVT_ID>","event_type":"charge.dispute.closed","local_event_id":"<DISPUTE_CLOSED_EVT_ID>","local_processing_status":"processed"},"provider_readback":{"source":"stripe.dispute.retrieve","status":"won","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_disputes.status_and_state_category","status":"won","state_category":"won","capture_boundary":"<CAPTURE_BOUNDARY>"}},
    "ambiguity_recovery": {"workflow_id":"payer.sync","durable_operation_id":"<BILLING_PROVIDER_OPERATION_ID>","durable_step_id":"<BILLING_PROVIDER_OPERATION_STEP_ID>","provider_mutation_count":1,"automatic_retry_count":0,"caller_request_key_sha256":"<CALLER_KEY_SHA256:payer.customer_create>","mutation_step_name":"payer.customer_create","provider_readback":{"source":"stripe.customer.retrieve","status":"found","capture_boundary":"<CAPTURE_BOUNDARY>"},"local_readback":{"source":"billing_provider_operations_and_steps","status":"completed","capture_boundary":"<CAPTURE_BOUNDARY>"}}
  },
  "terminal_counts": {
    "capture_boundary": "<CAPTURE_BOUNDARY>",
    "counts": {
      "failed":{"count":0,"source":"billing_provider_operations.failed_terminal_count","readback_boundary":"<CAPTURE_BOUNDARY>"},
      "stuck":{"count":0,"source":"billing_provider_operations.stuck_lease_count","readback_boundary":"<CAPTURE_BOUNDARY>"},
      "unmapped":{"count":0,"source":"stripe_webhook_events.unmapped_count","readback_boundary":"<CAPTURE_BOUNDARY>"},
      "wrong_mode":{"count":0,"source":"provider_local_wrong_mode_component_sum","readback_boundary":"<CAPTURE_BOUNDARY>"},
      "wrong_generation":{"count":0,"source":"billing_connect_generation_mismatch_count","readback_boundary":"<CAPTURE_BOUNDARY>"},
      "pending_transition":{"count":0,"source":"billing_enrollment_transition_intents.pending_count","readback_boundary":"<CAPTURE_BOUNDARY>"},
      "reconciliation_required":{"count":0,"source":"billing_reconciliation_required_union_count","readback_boundary":"<CAPTURE_BOUNDARY>"}
    },
    "wrong_mode_components": [
      {"surface":"provider","count":0,"source":"stripe_test_mode_object_inventory.wrong_mode_count","readback_boundary":"<CAPTURE_BOUNDARY>"},
      {"surface":"local","count":0,"source":"stripe_webhook_events.wrong_mode_count","readback_boundary":"<CAPTURE_BOUNDARY>"}
    ]
  }
}
```
<!-- STRIPE_PROVIDER_REHEARSAL_SCHEMA_V4_TEMPLATE:END -->

Validate the worksheet and then the private evidence file offline:

```bash
python3 scripts/check-stripe-provider-rehearsal-worksheet.py
python3 scripts/verify-stripe-provider-rehearsal.py \
  --evidence <sanitized-evidence.json> \
  --expected-candidate-sha <40-character-candidate-sha> \
  --expected-backend-origin https://koaryu-staging.onrender.com
```

If either command fails, preserve the sanitized identifiers and stop. Do not contact production, retry a provider mutation, or weaken a terminal count.
