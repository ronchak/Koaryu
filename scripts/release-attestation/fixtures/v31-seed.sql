INSERT INTO auth.users(
  id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) VALUES
(
  '31000000-0000-4000-8000-000000000001','authenticated','authenticated',
  'v31-restore@example.invalid','{}','{}',now(),now()
),
(
  '32000000-0000-4000-8000-000000000001','authenticated','authenticated',
  'v31-demo-restore@example.invalid','{}','{}',now(),now()
),
(
  '33000000-0000-4000-8000-000000000001','authenticated','authenticated',
  'v31-connected-demo-restore@example.invalid','{}','{}',now(),now()
);
INSERT INTO public.studios(id,name,slug,owner_id) VALUES(
  '31000000-0000-4000-8000-000000000002','V31 restore normalization',
  'v31-restore-normalization','31000000-0000-4000-8000-000000000001'
);
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000001','admin'
);
INSERT INTO public.studios(id,name,slug,owner_id) VALUES(
  '32000000-0000-4000-8000-000000000002','V31 restore demo fixture',
  'v31-restore-demo-fixture','32000000-0000-4000-8000-000000000001'
);
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(
  '32000000-0000-4000-8000-000000000002',
  '32000000-0000-4000-8000-000000000001','admin'
);
INSERT INTO public.studios(id,name,slug,owner_id) VALUES(
  '33000000-0000-4000-8000-000000000002','V31 connected demo fixture',
  'v31-connected-demo-fixture','33000000-0000-4000-8000-000000000001'
);
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(
  '33000000-0000-4000-8000-000000000002',
  '33000000-0000-4000-8000-000000000001','admin'
);
INSERT INTO public.studio_payment_accounts(
  studio_id,stripe_connected_account_id,status,charges_enabled,metadata
) VALUES(
  '31000000-0000-4000-8000-000000000002','acct_v31restore',
  'charges_enabled',true,'{"connect_account_generation":1}'
);
INSERT INTO public.studio_payment_accounts(
  studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,metadata
) VALUES(
  '32000000-0000-4000-8000-000000000002',NULL,
  'not_connected',false,false,'{"connect_account_generation":1}'
);
INSERT INTO public.studio_payment_accounts(
  studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,metadata
) VALUES(
  '33000000-0000-4000-8000-000000000002','acct_v31connected',
  'charges_enabled',true,true,'{"connect_account_generation":3}'
);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,
  connect_account_generation,billing_status,balance_cents
) VALUES
  ('31000000-0000-4000-8000-000000000003',
   '31000000-0000-4000-8000-000000000002','Fully refunded legacy payer',
   'acct_v31restore','cus_v31restore_full',NULL,'past_due',1000),
  ('31000000-0000-4000-8000-000000000004',
   '31000000-0000-4000-8000-000000000002','Partially refunded legacy payer',
   'acct_v31restore','cus_v31restore_partial',1,'past_due',400),
  ('31000000-0000-4000-8000-000000000005',
   '31000000-0000-4000-8000-000000000002','Underpaid legacy payer',
   'acct_v31restore','cus_v31restore_underpaid',1,'current',0);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,
  connect_account_generation,billing_status,balance_cents,metadata
) VALUES(
  '32000000-0000-4000-8000-000000000003',
  '32000000-0000-4000-8000-000000000002','Canonical demo payer',
  'acct_demo_river_city','cus_demo_restore',NULL,'current',0,
  '{"demo":true}'::JSONB
);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,
  connect_account_generation,autopay_status,billing_status,balance_cents,
  default_payment_method_id,default_payment_method_brand,
  default_payment_method_last4,default_payment_method_exp_month,
  default_payment_method_exp_year,autopay_authorized_at,
  autopay_terms_accepted_at,metadata
) VALUES(
  '33000000-0000-4000-8000-000000000003',
  '33000000-0000-4000-8000-000000000002','Connected synthetic demo payer',
  NULL,'cus_demo_connected',NULL,'enabled','current',0,
  'pm_demo_connected','visa','4242',12,2035,now(),now(),
  '{"demo":true}'::JSONB
);
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,metadata
) VALUES(
  '32000000-0000-4000-8000-000000000004',
  '32000000-0000-4000-8000-000000000002',
  '32000000-0000-4000-8000-000000000003','acct_demo_river_city',
  'cus_demo_restore','sub_demo_restore','autopay','monthly','usd','active',
  '{"demo":true}'::JSONB
);
INSERT INTO public.billing_invoices(
  id,studio_id,payer_id,status,amount_due_cents,amount_paid_cents,
  amount_remaining_cents,currency,stripe_invoice_id,stripe_account_id,
  stripe_customer_id,stripe_subscription_id,collection_method,external,metadata
) VALUES(
  '32000000-0000-4000-8000-000000000005',
  '32000000-0000-4000-8000-000000000002',
  '32000000-0000-4000-8000-000000000003','paid',1000,1000,0,'usd',
  'in_demo_restore','acct_demo_river_city','cus_demo_restore','sub_demo_restore',
  'charge_automatically',false,'{"demo":true}'::JSONB
);
INSERT INTO public.billing_payments(
  id,studio_id,payer_id,invoice_id,stripe_customer_id,
  stripe_payment_intent_id,stripe_charge_id,stripe_account_id,
  connect_account_generation,status,amount_cents,currency,
  net_collected_amount_cents,refundable_amount_cents,processed_at,metadata
) VALUES(
  '32000000-0000-4000-8000-000000000006',
  '32000000-0000-4000-8000-000000000002',
  '32000000-0000-4000-8000-000000000003',
  '32000000-0000-4000-8000-000000000005','cus_demo_restore',
  'pi_demo_restore','ch_demo_restore','acct_demo_river_city',NULL,
  'succeeded',1000,'usd',1000,1000,now(),'{"demo":true}'::JSONB
);
INSERT INTO public.billing_plans(
  id,studio_id,name,amount_cents,currency,billing_interval,status,
  stripe_account_id,stripe_product_id,stripe_price_id,stripe_price_version
) VALUES
  ('31000000-0000-4000-8000-000000000020',
   '31000000-0000-4000-8000-000000000002','Exact legacy generation plan',
   12000,'usd','monthly','active','acct_v31restore',
   'prod_v31legacy_exact','price_v31legacy_exact',1),
  ('31000000-0000-4000-8000-000000000021',
   '31000000-0000-4000-8000-000000000002','Stale legacy generation plan',
   12000,'usd','monthly','active','acct_v31restore',
   'prod_v31legacy_current','price_v31legacy_current',1);
INSERT INTO public.billing_plan_prices(
  id,studio_id,billing_plan_id,stripe_account_id,stripe_product_id,
  stripe_price_id,amount_cents,currency,billing_interval,recurring,active,
  version,metadata
) VALUES
  ('31000000-0000-4000-8000-000000000022',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000020','acct_v31restore',
   'prod_v31legacy_exact','price_v31legacy_exact',12000,'usd','monthly',
   true,true,1,'{"legacy_marker":"keep"}'::jsonb),
  ('31000000-0000-4000-8000-000000000023',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000021','acct_v31restore',
   'prod_v31legacy_stale','price_v31legacy_stale',12000,'usd','monthly',
   true,true,1,'{"legacy_marker":"keep"}'::jsonb);
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,metadata
) VALUES
  ('31000000-0000-4000-8000-000000000024',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000004','acct_v31restore',
   'cus_v31restore_partial','sub_v31legacy_exact','invoice_link','monthly','usd',
   'active','{"legacy_marker":"keep"}'::jsonb),
  ('31000000-0000-4000-8000-000000000025',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005','acct_v31restore',
   'cus_v31restore_stale','sub_v31legacy_stale','invoice_link','monthly','usd',
   'active','{"legacy_marker":"keep"}'::jsonb),
  ('31000000-0000-4000-8000-000000000026',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000003','acct_v31restore',
   'cus_v31restore_full','sub_v31legacy_explicit','invoice_link','monthly','usd',
   'active','{"connect_account_generation":9}'::jsonb);
INSERT INTO public.billing_invoices(
  id,studio_id,payer_id,status,amount_due_cents,amount_paid_cents,
  amount_remaining_cents,currency,paid_at
) VALUES
  ('31000000-0000-4000-8000-000000000006',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000003','refunded',1000,0,1000,'usd',NULL),
  ('31000000-0000-4000-8000-000000000007',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000004','partially_refunded',1000,600,400,'usd',NULL),
  ('31000000-0000-4000-8000-000000000008',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005','partially_refunded',1000,300,700,'usd',NULL),
  ('31000000-0000-4000-8000-000000000009',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005','void',500,0,500,'usd',NULL);
INSERT INTO public.billing_invoices(
  id,studio_id,payer_id,status,amount_due_cents,amount_paid_cents,
  amount_remaining_cents,currency,stripe_invoice_id,stripe_account_id,
  stripe_customer_id,collection_method,external,metadata
) VALUES
(
  '31000000-0000-4000-8000-000000000013',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31overlap','acct_v31restore','cus_v31restore_partial','send_invoice',false,
  jsonb_build_object('connect_account_generation',1)
),
(
  '31000000-0000-4000-8000-000000000015',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_exact','acct_v31restore','cus_v31restore_partial','send_invoice',false,
  '{}'::jsonb
),
(
  '31000000-0000-4000-8000-000000000016',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_empty','acct_v31restore','cus_v31restore_partial','send_invoice',false,
  jsonb_build_object('connect_account_generation','')
),
(
  '31000000-0000-4000-8000-000000000017',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_customer','acct_v31restore','cus_v31restore_other','send_invoice',false,
  '{}'::jsonb
),
(
  '31000000-0000-4000-8000-000000000018',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_account','acct_v31stale','cus_v31restore_partial','send_invoice',false,
  '{}'::jsonb
),
(
  '31000000-0000-4000-8000-000000000019',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000004','draft',0,0,0,'usd',
  'in_v31legacy_external','acct_v31restore','cus_v31restore_partial','send_invoice',true,
  '{}'::jsonb
);
INSERT INTO public.billing_payments(
  id,studio_id,payer_id,invoice_id,stripe_customer_id,
  stripe_payment_intent_id,stripe_charge_id,stripe_account_id,
  connect_account_generation,status,amount_cents,currency,
  net_collected_amount_cents,refundable_amount_cents,processed_at,idempotency_key
) VALUES
  ('31000000-0000-4000-8000-00000000000a',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000003',
   '31000000-0000-4000-8000-000000000006','cus_v31restore_full',
   'pi_v31restore_full','ch_v31restore_full','acct_v31restore',1,
   'succeeded',1000,'usd',1000,1000,now(),NULL),
  ('31000000-0000-4000-8000-00000000000b',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000004',
   '31000000-0000-4000-8000-000000000007','cus_v31restore_partial',
   'pi_v31restore_partial','ch_v31restore_partial','acct_v31restore',1,
   'succeeded',1000,'usd',1000,1000,now(),NULL),
  ('31000000-0000-4000-8000-00000000000c',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005',
   '31000000-0000-4000-8000-000000000008',NULL,NULL,NULL,NULL,NULL,
   'externally_recorded',300,'usd',300,0,now(),'v31-restore-external-payment'),
  ('31000000-0000-4000-8000-00000000000d',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-000000000005',NULL,'cus_v31restore_dispute',
   'pi_v31restore_dispute','ch_v31restore_dispute','acct_v31restore',1,
   'succeeded',200,'usd',200,200,now(),NULL);
INSERT INTO public.billing_refunds(
  id,studio_id,payment_id,stripe_refund_id,stripe_charge_id,
  stripe_payment_intent_id,stripe_account_id,connect_account_generation,
  amount_cents,status
) VALUES
  ('31000000-0000-4000-8000-00000000000e',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-00000000000a','re_v31restore_full',
   'ch_v31restore_full','pi_v31restore_full','acct_v31restore',1,1000,'succeeded'),
  ('31000000-0000-4000-8000-00000000000f',
   '31000000-0000-4000-8000-000000000002',
   '31000000-0000-4000-8000-00000000000b','re_v31restore_partial',
   'ch_v31restore_partial','pi_v31restore_partial','acct_v31restore',1,400,'succeeded');
INSERT INTO public.billing_disputes(
  id,studio_id,payment_id,stripe_dispute_id,stripe_charge_id,
  stripe_payment_intent_id,stripe_account_id,connect_account_generation,
  amount_cents,status,state_category
) VALUES(
  '31000000-0000-4000-8000-000000000010',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-00000000000d','dp_v31restore',
  'ch_v31restore_dispute','pi_v31restore_dispute','acct_v31restore',1,
  100,'needs_response','active'
);
INSERT INTO public.billing_provider_operations(
  id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
  stripe_connected_account_id,connect_account_generation,state,
  lease_owner,lease_acquired_at,lease_expires_at
) VALUES(
  '31000000-0000-4000-8000-000000000011',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000001','payer.sync',
  'v31-restore-provider-evidence',repeat('a',64),'acct_v31restore',1,
  'started','31000000-0000-4000-8000-000000000012',now(),now()+interval '30 seconds'
);
