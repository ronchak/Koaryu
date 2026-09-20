TABLES = ("auth.users", "public.staff_profiles", "public.studios", "public.staff_roles",
          "public.studio_payment_accounts", "public.billing_payers", "public.billing_plans",
          "public.billing_subscriptions", "public.students", "public.student_billing_enrollments",
          "public.billing_provider_operations", "public.billing_provider_operation_resources",
          "public.billing_provider_operation_resource_aliases", "public.audit_logs")
F = {name: f"48000000-0000-4000-8000-{index:012d}" for index, name in enumerate(
    ["actor", "studio", "payer", "plan", "group", "student", "enrollment", "existing_student",
     "existing", "later_student", "later", "lease"], 1)}
INTENT = {"version": 1, "operation_type": "enrollment.activate.invoice", "studio_id": F["studio"],
    "enrollment_id": F["enrollment"], "student_id": F["student"], "payer_id": F["payer"],
    "plan_id": F["plan"], "account_id": "acct_ActivationRestore48", "generation": 1,
    "customer_id": "cus_activation48", "product_id": "prod_activation48", "price_id": "price_activation48",
    "group_id": F["group"], "branch": "update_quantity", "expected_subscription_id": "sub_activation48",
    "expected_item_id": "si_activation48", "expected_quantity": 2}
INTENT["desired_sha256"] = hashlib.sha256(json.dumps(INTENT, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
SEED_SQL = f"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('{F['actor']}','authenticated','authenticated','activation48-{F['actor']}@example.invalid','{{}}','{{}}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)VALUES('{F['studio']}','Activation proof','activation-{F['studio']}','{F['actor']}');
INSERT INTO public.staff_roles(studio_id,user_id,role)VALUES('{F['studio']}','{F['actor']}','admin');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,details_submitted,metadata)
VALUES('{F['studio']}','acct_ActivationRestore48','charges_enabled',true,true,true,'{{"connect_account_generation":1}}');
INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
VALUES('{F['payer']}','{F['studio']}','Activation payer','acct_ActivationRestore48','cus_activation48',1);
INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,currency,billing_interval,status,stripe_account_id,stripe_product_id,stripe_price_id)
VALUES('{F['plan']}','{F['studio']}','Activation plan',5000,'usd','monthly','active','acct_ActivationRestore48','prod_activation48','price_activation48');
INSERT INTO public.billing_subscriptions(id,studio_id,payer_id,stripe_account_id,stripe_customer_id,stripe_subscription_id,collection_mode,billing_interval,currency,status,metadata)
VALUES('{F['group']}','{F['studio']}','{F['payer']}','acct_ActivationRestore48','cus_activation48','sub_activation48','invoice_link','monthly','usd','active','{{"connect_account_generation":1}}');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)VALUES
('{F['student']}','{F['studio']}','Pending','Seat'),('{F['existing_student']}','{F['studio']}','Existing','Seat'),('{F['later_student']}','{F['studio']}','Later','Seat');
INSERT INTO public.student_billing_enrollments(id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,metadata)VALUES
('{F['enrollment']}','{F['studio']}','{F['student']}','{F['payer']}','{F['plan']}','invoice_link','pending','{json.dumps({'provider_activation_intent':INTENT})}'),
('{F['later']}','{F['studio']}','{F['later_student']}','{F['payer']}','{F['plan']}','invoice_link','pending','{{}}');
INSERT INTO public.student_billing_enrollments(id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,billing_subscription_id,stripe_subscription_id,stripe_subscription_item_id)
VALUES('{F['existing']}','{F['studio']}','{F['existing_student']}','{F['payer']}','{F['plan']}','invoice_link','active','{F['group']}','sub_activation48','si_activation48');
UPDATE public.student_billing_enrollments SET status='active',billing_subscription_id='{F['group']}',stripe_subscription_id='sub_activation48',stripe_subscription_item_id='si_activation48' WHERE id='{F['later']}';
DO $claim$ BEGIN PERFORM public.claim_billing_provider_operation_resource_v1('{F['studio']}','{F['actor']}','enrollment.activate.invoice','enrollment','{F['enrollment']}','{F['payer']}','activation-restore','{INTENT['desired_sha256']}','acct_ActivationRestore48',1,'{F['lease']}',5); END; $claim$;
SELECT 'seeded';
COMMIT;
"""
