BEGIN;

DO $$
DECLARE
    v_missing TEXT;
    v_signature TEXT;
    v_function REGPROCEDURE;
    v_config TEXT[];
    v_is_definer BOOLEAN;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM supabase_migrations.schema_migrations
         WHERE version = '20260801060000'
    ) THEN
        RAISE EXCEPTION 'Operational alert delivery migration is missing.';
    END IF;

    SELECT string_agg(expected.table_name, ', ' ORDER BY expected.table_name)
      INTO v_missing
      FROM (VALUES
          ('operational_alert_episodes'),
          ('operational_alert_outbox'),
          ('operational_alert_delivery_attempts'),
          ('operational_alert_delivery_outcomes'),
          ('operational_alert_audit_events'),
          ('operational_alert_heartbeats')
      ) expected(table_name)
     WHERE NOT EXISTS (
         SELECT 1
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = expected.table_name
            AND relation.relkind = 'r'
            AND relation.relrowsecurity
     );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing or non-RLS operational alert tables: %', v_missing;
    END IF;

    FOREACH v_signature IN ARRAY ARRAY[
        'public.operational_alert_metric_counts()',
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)',
        'public.claim_operational_alert_delivery(text,text,uuid,integer)',
        'public.complete_operational_alert_delivery(uuid,text,text)',
        'public.fail_operational_alert_delivery(uuid,text,text,integer)',
        'public.record_operational_alert_heartbeat(text,text,text)',
        'public.operational_alert_heartbeats(text)'
    ]
    LOOP
        v_function := to_regprocedure(v_signature);
        IF v_function IS NULL THEN
            RAISE EXCEPTION 'Missing operational alert RPC %.', v_signature;
        END IF;
        SELECT proc.proconfig, proc.prosecdef
          INTO v_config, v_is_definer
          FROM pg_proc proc
         WHERE proc.oid = v_function::OID;
        IF v_is_definer THEN
            RAISE EXCEPTION 'Operational alert RPC % must be SECURITY INVOKER.', v_signature;
        END IF;
        IF NOT COALESCE('search_path=public, pg_temp' = ANY(v_config), false) THEN
            RAISE EXCEPTION 'Operational alert RPC % must pin search_path.', v_signature;
        END IF;
        IF has_function_privilege('anon', v_function, 'EXECUTE')
           OR has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
            RAISE EXCEPTION 'Client role still has EXECUTE on %.', v_signature;
        END IF;
        IF v_signature <> 'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)'
           AND NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
            RAISE EXCEPTION 'service_role requires EXECUTE on %.', v_signature;
        END IF;
    END LOOP;
    IF has_function_privilege(
        'service_role',
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Legacy evaluator overload must not remain service-role executable.';
    END IF;

    SELECT string_agg(format('%s:%s', expected.table_name, expected.grantee), ', ')
      INTO v_missing
      FROM (VALUES
          ('operational_alert_episodes', 'anon'),
          ('operational_alert_episodes', 'authenticated'),
          ('operational_alert_outbox', 'anon'),
          ('operational_alert_outbox', 'authenticated'),
          ('operational_alert_delivery_attempts', 'anon'),
          ('operational_alert_delivery_attempts', 'authenticated'),
          ('operational_alert_delivery_outcomes', 'anon'),
          ('operational_alert_delivery_outcomes', 'authenticated'),
          ('operational_alert_audit_events', 'anon'),
          ('operational_alert_audit_events', 'authenticated'),
          ('operational_alert_heartbeats', 'anon'),
          ('operational_alert_heartbeats', 'authenticated')
      ) expected(table_name, grantee)
     WHERE has_table_privilege(expected.grantee, 'public.' || expected.table_name, 'SELECT')
        OR has_table_privilege(expected.grantee, 'public.' || expected.table_name, 'INSERT')
        OR has_table_privilege(expected.grantee, 'public.' || expected.table_name, 'UPDATE')
        OR has_table_privilege(expected.grantee, 'public.' || expected.table_name, 'DELETE');
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Operational alert client table privilege leak: %', v_missing;
    END IF;

    IF has_table_privilege('service_role', 'public.operational_alert_delivery_attempts', 'UPDATE')
       OR has_table_privilege('service_role', 'public.operational_alert_delivery_attempts', 'DELETE')
       OR has_table_privilege('service_role', 'public.operational_alert_delivery_outcomes', 'UPDATE')
       OR has_table_privilege('service_role', 'public.operational_alert_delivery_outcomes', 'DELETE')
       OR has_table_privilege('service_role', 'public.operational_alert_audit_events', 'UPDATE')
       OR has_table_privilege('service_role', 'public.operational_alert_audit_events', 'DELETE') THEN
        RAISE EXCEPTION 'Attempt, outcome, and audit history must be append-only for service_role.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'operational_alert_episodes'
           AND indexname = 'operational_alert_episodes_one_unresolved'
           AND indexdef LIKE '%UNIQUE%'
           AND indexdef LIKE '%cleared_at IS NULL%'
    ) THEN
        RAISE EXCEPTION 'One-unresolved-episode index is missing.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.operational_alert_delivery_attempts'::regclass
           AND contype = 'u'
           AND pg_get_constraintdef(oid) = 'UNIQUE (environment, rule_id, episode_id, attempt_key)'
    ) THEN
        RAISE EXCEPTION 'Stable attempt-key uniqueness contract is missing.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.operational_alert_outbox'::regclass
           AND tgname = 'enforce_operational_alert_sent_receipt'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'Outbox receipt-gating trigger is missing.';
    END IF;
END
$$;

DO $$
DECLARE
    v_count_rows INTEGER;
    v_count_rules INTEGER;
    v_checked_times INTEGER;
BEGIN
    SELECT COUNT(*), COUNT(DISTINCT rule_id), COUNT(DISTINCT checked_at)
      INTO v_count_rows, v_count_rules, v_checked_times
      FROM public.operational_alert_metric_counts();
    IF v_count_rows <> 4 OR v_count_rules <> 4 OR v_checked_times <> 1 THEN
        RAISE EXCEPTION 'Counts RPC must return exactly four rules from one DB-clock observation.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.operational_alert_metric_counts()
         WHERE observed_count < 0 OR checked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Counts RPC returned invalid count metadata.';
    END IF;
END
$$;

DO $$
DECLARE
    v_sha TEXT := repeat('a', 40);
    v_episode_id UUID;
    v_second_episode_id UUID;
    v_outbox_id UUID;
    v_lifecycle TEXT;
    v_attempt_id UUID;
    v_attempt_id_again UUID;
    v_attempt_key UUID := gen_random_uuid();
    v_second_attempt_id UUID;
    v_second_attempt_key UUID := gen_random_uuid();
    v_ok BOOLEAN;
    v_audit_count INTEGER;
    v_sequence BIGINT;
BEGIN
    SELECT episode_id, lifecycle_event, outbox_id
      INTO v_episode_id, v_lifecycle, v_outbox_id
      FROM public.evaluate_operational_alert(
          'contract', 'stripe-live-webhook-failure', 2, 1, 10,
          'recording-primary', 'critical', v_sha, 'contract-evaluator'
      );
    IF v_episode_id IS NULL OR v_outbox_id IS NULL OR v_lifecycle <> 'opened' THEN
        RAISE EXCEPTION 'First firing evaluation must open an episode and enqueue one delivery.';
    END IF;

    SELECT episode_id, lifecycle_event
      INTO v_second_episode_id, v_lifecycle
      FROM public.evaluate_operational_alert(
          'contract', 'stripe-live-webhook-failure', 3, 1, 10,
          'recording-primary', 'critical', v_sha, 'contract-evaluator'
      );
    IF v_second_episode_id IS DISTINCT FROM v_episode_id OR v_lifecycle <> 'deduped' THEN
        RAISE EXCEPTION 'Repeated firing evaluation must dedupe onto the unresolved episode.';
    END IF;
    IF (SELECT COUNT(*) FROM public.operational_alert_outbox WHERE episode_id = v_episode_id) <> 1 THEN
        RAISE EXCEPTION 'Deduped evaluation must not enqueue another delivery.';
    END IF;

    SELECT attempt_id
      INTO v_attempt_id
      FROM public.claim_operational_alert_delivery(
          'contract', 'lease-one', v_attempt_key, 300
      );
    IF v_attempt_id IS NULL THEN
        RAISE EXCEPTION 'Pending delivery must be claimable.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.operational_alert_delivery_attempts
         WHERE id = v_attempt_id AND attempt_key = v_attempt_key
    ) OR EXISTS (
        SELECT 1 FROM public.operational_alert_delivery_outcomes
         WHERE attempt_id = v_attempt_id
    ) THEN
        RAISE EXCEPTION 'Claim must prewrite an immutable attempt before any outcome exists.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.operational_alert_outbox
         WHERE id = v_outbox_id AND status = 'sent'
    ) THEN
        RAISE EXCEPTION 'Claiming must not mark the outbox sent.';
    END IF;

    SELECT attempt_id
      INTO v_attempt_id_again
      FROM public.claim_operational_alert_delivery(
          'contract', 'lease-one', v_attempt_key, 300
      );
    IF v_attempt_id_again IS DISTINCT FROM v_attempt_id
       OR (SELECT COUNT(*) FROM public.operational_alert_delivery_attempts
            WHERE environment = 'contract' AND rule_id = 'stripe-live-webhook-failure'
              AND episode_id = v_episode_id AND attempt_key = v_attempt_key) <> 1 THEN
        RAISE EXCEPTION 'Retrying a claim key must return exactly one prewritten attempt.';
    END IF;

    BEGIN
        PERFORM public.complete_operational_alert_delivery(v_attempt_id, 'lease-one', '');
        RAISE EXCEPTION 'Blank receipt must be rejected.';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;
    IF EXISTS (
        SELECT 1 FROM public.operational_alert_outbox
         WHERE id = v_outbox_id AND status = 'sent'
    ) THEN
        RAISE EXCEPTION 'Outbox must remain unsent when no receipt is recorded.';
    END IF;

    SELECT public.fail_operational_alert_delivery(
        v_attempt_id, 'lease-one', 'synthetic_failure', 1
    ) INTO v_ok;
    IF NOT v_ok OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_delivery_outcomes
         WHERE attempt_id = v_attempt_id AND outcome = 'failed'
           AND error_code = 'synthetic_failure'
    ) OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_outbox
         WHERE id = v_outbox_id AND status = 'pending'
           AND active_attempt_id IS NULL
    ) THEN
        RAISE EXCEPTION 'Failed delivery must append an outcome and requeue the outbox.';
    END IF;

    BEGIN
        UPDATE public.operational_alert_outbox
           SET status = 'sent',
               completed_attempt_id = v_attempt_id,
               sent_at = clock_timestamp(),
               receipt = 'not-a-success-receipt'
         WHERE id = v_outbox_id;
        RAISE EXCEPTION 'Direct sent transition without a success receipt should fail.';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    UPDATE public.operational_alert_outbox
       SET available_at = '-infinity'::TIMESTAMPTZ
     WHERE id = v_outbox_id;
    SELECT attempt_id
      INTO v_second_attempt_id
      FROM public.claim_operational_alert_delivery(
          'contract', 'lease-two', v_second_attempt_key, 300
      );
    IF v_second_attempt_id IS NULL OR v_second_attempt_id = v_attempt_id
       OR (SELECT attempt_number FROM public.operational_alert_delivery_attempts
            WHERE id = v_second_attempt_id) <> 2 THEN
        RAISE EXCEPTION 'Requeued delivery must prewrite a distinct second attempt.';
    END IF;

    SELECT public.complete_operational_alert_delivery(
        v_second_attempt_id, 'lease-two', 'recording-receipt-2'
    ) INTO v_ok;
    IF NOT v_ok OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_delivery_outcomes
         WHERE attempt_id = v_second_attempt_id AND outcome = 'sent'
           AND receipt = 'recording-receipt-2'
    ) OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_outbox
         WHERE id = v_outbox_id AND status = 'sent'
           AND completed_attempt_id = v_second_attempt_id
           AND receipt = 'recording-receipt-2'
    ) THEN
        RAISE EXCEPTION 'Receipt must be durable before the outbox is marked sent.';
    END IF;
    SELECT public.complete_operational_alert_delivery(
        v_second_attempt_id, 'lease-two', 'recording-receipt-2'
    ) INTO v_ok;
    IF NOT v_ok OR (SELECT COUNT(*) FROM public.operational_alert_delivery_outcomes
                 WHERE attempt_id = v_second_attempt_id) <> 1 THEN
        RAISE EXCEPTION 'Completion retry must be idempotently successful and outcome-unique.';
    END IF;

    SELECT lifecycle_event
      INTO v_lifecycle
      FROM public.evaluate_operational_alert(
          'contract', 'stripe-live-webhook-failure', 0, 1, 10,
          'recording-primary', 'critical', v_sha, 'contract-evaluator'
      );
    IF v_lifecycle <> 'cleared' OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_episodes
         WHERE id = v_episode_id AND cleared_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Clear observation must close the episode boundary.';
    END IF;

    SELECT episode_id, lifecycle_event
      INTO v_second_episode_id, v_lifecycle
      FROM public.evaluate_operational_alert(
          'contract', 'stripe-live-webhook-failure', 1, 1, 10,
          'recording-primary', 'critical', v_sha, 'contract-evaluator'
      );
    IF v_lifecycle <> 'opened' OR v_second_episode_id = v_episode_id THEN
        RAISE EXCEPTION 'A new firing after clear must open a new episode.';
    END IF;

    PERFORM * FROM public.record_operational_alert_heartbeat('contract', 'evaluator', v_sha);
    SELECT sequence INTO v_sequence
      FROM public.record_operational_alert_heartbeat('contract', 'evaluator', v_sha);
    IF v_sequence <> 2 OR (SELECT COUNT(*) FROM public.operational_alert_heartbeats('contract')) <> 1 THEN
        RAISE EXCEPTION 'Heartbeat must upsert by environment+worker and increment sequence.';
    END IF;

    BEGIN
        UPDATE public.operational_alert_delivery_attempts
           SET started_at = clock_timestamp()
         WHERE id = v_attempt_id;
        RAISE EXCEPTION 'Attempt history mutation should fail.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
    BEGIN
        UPDATE public.operational_alert_delivery_outcomes
           SET recorded_at = clock_timestamp()
         WHERE attempt_id = v_attempt_id;
        RAISE EXCEPTION 'Outcome history mutation should fail.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
    SELECT COUNT(*) INTO v_audit_count
      FROM public.operational_alert_audit_events
     WHERE episode_id = v_episode_id;
    IF v_audit_count < 6 THEN
        RAISE EXCEPTION 'Expected durable lifecycle audit events, found %.', v_audit_count;
    END IF;
    BEGIN
        DELETE FROM public.operational_alert_audit_events
         WHERE episode_id = v_episode_id;
        RAISE EXCEPTION 'Audit history deletion should fail.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
    END;
END
$$;

ROLLBACK;
