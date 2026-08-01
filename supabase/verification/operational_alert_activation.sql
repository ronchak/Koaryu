BEGIN;

DO $$
DECLARE
    v_sha TEXT := repeat('b', 40);
    v_episode UUID;
    v_outbox UUID;
    v_attempt UUID;
    v_lifecycle TEXT;
    v_role TEXT;
    v_event TEXT;
    v_ok BOOLEAN;
    v_race_episode UUID;
    v_race_attempt UUID;
BEGIN
    IF to_regprocedure(
        'public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)'
    ) IS NULL
       OR to_regprocedure(
        'public.acknowledge_operational_alert(text,uuid,text,text)'
       ) IS NULL THEN
        RAISE EXCEPTION 'Operational alert activation RPCs are missing.';
    END IF;
    IF has_function_privilege(
        'anon',
        'public.acknowledge_operational_alert(text,uuid,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.acknowledge_operational_alert(text,uuid,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.acknowledge_operational_alert(text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Acknowledgement RPC privileges are not fail-closed.';
    END IF;

    SELECT episode_id, lifecycle_event, outbox_id
      INTO v_episode, v_lifecycle, v_outbox
      FROM public.evaluate_operational_alert(
          'activation-contract', 'stripe-live-webhook-failure', 1, 1, 10,
          'primary-owner', 'backup-owner', 15, 'critical', v_sha,
          'contract-evaluator'
      );
    IF v_episode IS NULL OR v_outbox IS NULL OR v_lifecycle <> 'opened'
       OR NOT EXISTS (
           SELECT 1 FROM public.operational_alert_outbox
            WHERE id = v_outbox AND event_kind = 'triggered'
              AND destination_role = 'primary' AND destination_id = 'primary-owner'
       ) THEN
        RAISE EXCEPTION 'Opening must enqueue the exact primary trigger.';
    END IF;

    SELECT attempt_id, event_kind, destination_role
      INTO v_attempt, v_event, v_role
      FROM public.claim_operational_alert_delivery(
          'activation-contract', 'primary-lease', gen_random_uuid(), 300
      );
    IF v_attempt IS NULL OR v_event <> 'triggered' OR v_role <> 'primary' THEN
        RAISE EXCEPTION 'Primary trigger claim did not preserve lifecycle identity.';
    END IF;
    SELECT public.complete_operational_alert_delivery(
        v_attempt, 'primary-lease', 'primary-receipt'
    ) INTO v_ok;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'Primary receipt was not durably completed.';
    END IF;

    UPDATE public.operational_alert_episodes
       SET opened_at = opened_at - INTERVAL '1 hour'
     WHERE id = v_episode;
    SELECT lifecycle_event, outbox_id
      INTO v_lifecycle, v_outbox
      FROM public.evaluate_operational_alert(
          'activation-contract', 'stripe-live-webhook-failure', 2, 1, 10,
          'primary-owner', 'backup-owner', 15, 'critical', v_sha,
          'contract-evaluator'
      );
    IF v_lifecycle <> 'escalated' OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_outbox
         WHERE id = v_outbox AND event_kind = 'escalated'
           AND destination_role = 'backup' AND destination_id = 'backup-owner'
    ) THEN
        RAISE EXCEPTION 'Unacknowledged overdue episode must enqueue backup escalation.';
    END IF;

    SELECT attempt_id, event_kind, destination_role
      INTO v_attempt, v_event, v_role
      FROM public.claim_operational_alert_delivery(
          'activation-contract', 'backup-lease', gen_random_uuid(), 300
      );
    IF v_event <> 'escalated' OR v_role <> 'backup' THEN
        RAISE EXCEPTION 'Backup escalation claim did not preserve lifecycle identity.';
    END IF;
    SELECT public.complete_operational_alert_delivery(
        v_attempt, 'backup-lease', 'backup-receipt'
    ) INTO v_ok;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'Backup receipt was not durably completed.';
    END IF;

    SELECT lifecycle_event, acknowledged_by_role
      INTO v_lifecycle, v_role
      FROM public.acknowledge_operational_alert(
          'activation-contract', v_episode, 'backup', 'backup-owner'
      );
    IF v_lifecycle <> 'acknowledged' OR v_role <> 'backup' THEN
        RAISE EXCEPTION 'Acknowledgement must bind to the secret-derived backup role.';
    END IF;
    SELECT lifecycle_event
      INTO v_lifecycle
      FROM public.acknowledge_operational_alert(
          'activation-contract', v_episode, 'primary', 'primary-owner'
      );
    IF v_lifecycle <> 'already_acknowledged' THEN
        RAISE EXCEPTION 'Acknowledgement must be durable and idempotent.';
    END IF;

    SELECT lifecycle_event
      INTO v_lifecycle
      FROM public.evaluate_operational_alert(
          'activation-contract', 'stripe-live-webhook-failure', 0, 1, 10,
          'primary-owner', 'backup-owner', 15, 'critical', v_sha,
          'contract-evaluator'
      );
    IF v_lifecycle <> 'cleared'
       OR (SELECT COUNT(*) FROM public.operational_alert_outbox
            WHERE episode_id = v_episode AND event_kind = 'resolved'
              AND status = 'pending') <> 2 THEN
        RAISE EXCEPTION 'Clear must queue resolution only for both receipt-confirmed roles.';
    END IF;
    IF (SELECT COUNT(*) FROM public.operational_alert_outbox
         WHERE episode_id = v_episode) <> 4 THEN
        RAISE EXCEPTION 'Environment+episode+event+role delivery dedupe is incomplete.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.operational_alert_audit_events
         WHERE episode_id = v_episode AND event_type = 'acknowledged'
    ) OR NOT EXISTS (
        SELECT 1 FROM public.operational_alert_audit_events
         WHERE episode_id = v_episode AND event_type = 'resolution_queued'
    ) THEN
        RAISE EXCEPTION 'Append-only acknowledgement/resolution audit is incomplete.';
    END IF;

    SELECT episode_id
      INTO v_race_episode
      FROM public.evaluate_operational_alert(
          'lease-race-contract', 'support-urgent-untriaged', 1, 1, 30,
          'primary-owner', 'backup-owner', 60, 'high', v_sha,
          'contract-evaluator'
      );
    SELECT attempt_id
      INTO v_race_attempt
      FROM public.claim_operational_alert_delivery(
          'lease-race-contract', 'race-lease', gen_random_uuid(), 300
      );
    IF v_race_episode IS NULL OR v_race_attempt IS NULL THEN
        RAISE EXCEPTION 'Clear-during-lease contract could not establish a leased trigger.';
    END IF;
    PERFORM * FROM public.evaluate_operational_alert(
        'lease-race-contract', 'support-urgent-untriaged', 0, 1, 30,
        'primary-owner', 'backup-owner', 60, 'high', v_sha,
        'contract-evaluator'
    );
    SELECT public.complete_operational_alert_delivery(
        v_race_attempt, 'race-lease', 'race-trigger-receipt'
    ) INTO v_ok;
    IF NOT v_ok OR (SELECT COUNT(*) FROM public.operational_alert_outbox
        WHERE episode_id = v_race_episode AND event_kind = 'resolved'
          AND destination_role = 'primary' AND status = 'pending') <> 1 THEN
        RAISE EXCEPTION 'A receipt after clear must atomically queue exactly one resolution.';
    END IF;
    SELECT public.complete_operational_alert_delivery(
        v_race_attempt, 'race-lease', 'race-trigger-receipt'
    ) INTO v_ok;
    IF NOT v_ok OR (SELECT COUNT(*) FROM public.operational_alert_outbox
        WHERE episode_id = v_race_episode AND event_kind = 'resolved'
          AND destination_role = 'primary') <> 1 THEN
        RAISE EXCEPTION 'Late completion retry must not duplicate resolution.';
    END IF;
END
$$;

ROLLBACK;
