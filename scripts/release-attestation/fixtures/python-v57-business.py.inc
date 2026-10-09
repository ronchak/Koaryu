TABLES = ("auth.users", "public.studios", "public.staff_roles", "public.programs", "public.leads",
          "public.lead_activities", "public.lead_follow_up_operations", "public.students",
          "public.student_program_memberships", "public.guardians", "public.student_guardians", "public.audit_logs",
          "public.studio_subscriptions", "public.class_sessions", "public.attendance",
          "public.automation_rules", "public.automation_deliveries", "public.automation_suppressions",
          "private.automation_email_credentials")
# Hosted projects provisioned with Supabase's legacy default function privileges
# retain service_role EXECUTE on these trigger functions; V57 must converge them.
HOSTED_LEGACY_TRIGGER_FUNCTIONS = tuple(f"public.{name}()" for name in (
    "update_updated_at_column",
    "validate_attendance_program_integrity",
    "validate_billing_adjustment_refs",
    "validate_billing_dispute_refs",
    "validate_billing_invoice_item_refs",
    "validate_billing_invoice_refs",
    "validate_billing_payer_guardian",
    "validate_billing_payment_refs",
    "validate_billing_plan_program",
    "validate_billing_refund_refs",
    "validate_billing_subscription_refs",
    "validate_class_session_program_integrity",
    "validate_class_template_program_integrity",
    "validate_lead_program_integrity",
    "validate_student_billing_enrollment",
    "validate_student_guardian_tenant_integrity",
    "validate_student_profile_tenant_integrity",
))
HOSTED_LEGACY_GRANTS_SQL = ("SELECT count(*) FROM unnest(ARRAY[" + ",".join(
    f"'{signature}'" for signature in HOSTED_LEGACY_TRIGGER_FUNCTIONS)
    + "]) s(signature) WHERE has_function_privilege('service_role', s.signature, 'EXECUTE');")
SEED_SQL = """
BEGIN;
SET LOCAL TIME ZONE 'UTC';
DO $seed$
DECLARE actor UUID := gen_random_uuid(); studio UUID := gen_random_uuid(); lead UUID := gen_random_uuid();
    program UUID := gen_random_uuid(); adult UUID := gen_random_uuid(); minor UUID := gen_random_uuid();
    held UUID := gen_random_uuid(); guardian UUID := gen_random_uuid(); session_id UUID := gen_random_uuid();
    item JSONB; begun JSONB; attempts INTEGER:=0;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Converted lead restore',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.programs(id,studio_id,name) VALUES(program,studio,'Retained program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,program_id,is_minor,guardian_name)
    VALUES(lead,studio,'Converted','Lead','walk_in','offer_sent',program,TRUE,'Retained Guardian');
    PERFORM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
    PERFORM public.update_lead_atomic(studio,actor,lead,'{"stage":"offer_sent","follow_up_date":"2030-01-01"}');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',true);
    UPDATE public.studios SET timezone='UTC' WHERE id=studio;
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email,is_minor,hold_start_date,hold_end_date)
    VALUES(adult,studio,'RestoreAdult','Fixture','adult.restore@example.invalid',false,NULL,NULL),
          (minor,studio,'RestoreMinor','Fixture','minor.restore@example.invalid',true,NULL,NULL),
          (held,studio,'RestoreHeld','Fixture','held.restore@example.invalid',false,CURRENT_DATE-1,CURRENT_DATE+1);
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact)
    VALUES(guardian,studio,'Restore','Guardian','guardian.restore@example.invalid',true);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(minor,guardian);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time)
    VALUES(session_id,studio,'Restore retained class',CURRENT_DATE-20,'00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at)
    SELECT studio,session_id,id,'present',now()-INTERVAL '20 days' FROM public.students WHERE id IN (adult,minor,held);
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Retained V56 subject','Retained V56 body','reply.restore@example.invalid');
    PERFORM public.enqueue_missed_class_automations_v1(10);
    FOR item IN SELECT value FROM jsonb_array_elements(public.claim_missed_class_automations_v1(2)->'items') LOOP
        begun:=public.begin_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID);
        IF begun->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'V56 fixture did not begin'; END IF;
        attempts:=attempts+1;
        PERFORM public.settle_missed_class_automation_v1((item->>'id')::UUID,(item->>'claim_token')::UUID,
            CASE WHEN attempts=1 THEN 'accepted' ELSE 'unknown' END);
    END LOOP;
    IF attempts<>2 THEN RAISE EXCEPTION 'V56 fixture did not retain two attempted deliveries'; END IF;
    PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',0,'opaque-retained-v56-ciphertext');
END;
$seed$;
""" + "GRANT EXECUTE ON FUNCTION " + ",".join(HOSTED_LEGACY_TRIGGER_FUNCTIONS) + """ TO service_role;
SELECT 'seeded';
COMMIT;
"""
