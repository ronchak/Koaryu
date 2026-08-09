-- Operational activation lifecycle for the four counts-only alert rules.
-- Delivery endpoints and credentials remain outside PostgreSQL; the database
-- stores only logical destinations, immutable attempts/outcomes, and audit state.

ALTER TABLE public.operational_alert_episodes
    ADD COLUMN backup_destination_id TEXT NOT NULL DEFAULT 'backup-owner' CHECK (
        length(btrim(backup_destination_id)) BETWEEN 1 AND 80
        AND backup_destination_id ~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
    ),
    ADD COLUMN escalation_after_minutes INTEGER NOT NULL DEFAULT 30 CHECK (
        escalation_after_minutes BETWEEN 1 AND 1440
    ),
    ADD COLUMN acknowledged_at TIMESTAMPTZ,
    ADD COLUMN acknowledged_by_role TEXT CHECK (
        acknowledged_by_role IS NULL OR acknowledged_by_role IN ('primary', 'backup')
    ),
    ADD COLUMN acknowledged_actor_ref TEXT CHECK (
        acknowledged_actor_ref IS NULL
        OR acknowledged_actor_ref ~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
    ),
    ADD CONSTRAINT operational_alert_episode_ack_complete CHECK (
        (acknowledged_at IS NULL AND acknowledged_by_role IS NULL AND acknowledged_actor_ref IS NULL)
        OR (acknowledged_at IS NOT NULL AND acknowledged_by_role IS NOT NULL AND acknowledged_actor_ref IS NOT NULL)
    );

ALTER TABLE public.operational_alert_outbox
    DROP CONSTRAINT operational_alert_outbox_episode_id_key,
    ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'triggered' CHECK (
        event_kind IN ('triggered', 'escalated', 'resolved')
    ),
    ADD COLUMN destination_role TEXT NOT NULL DEFAULT 'primary' CHECK (
        destination_role IN ('primary', 'backup')
    ),
    ADD CONSTRAINT operational_alert_outbox_episode_event_role_key
        UNIQUE (episode_id, event_kind, destination_role);

ALTER TABLE public.operational_alert_audit_events
    DROP CONSTRAINT operational_alert_audit_events_event_type_check,
    ADD CONSTRAINT operational_alert_audit_events_event_type_check CHECK (
        event_type IN (
            'opened', 'cleared', 'acknowledged', 'escalated', 'resolution_queued',
            'delivery_claimed', 'delivery_sent', 'delivery_failed',
            'delivery_canceled', 'heartbeat'
        )
    );

CREATE FUNCTION public.evaluate_operational_alert(
    p_environment TEXT,
    p_rule_id TEXT,
    p_observed_count BIGINT,
    p_threshold INTEGER,
    p_window_minutes INTEGER,
    p_primary_destination_id TEXT,
    p_backup_destination_id TEXT,
    p_escalation_after_minutes INTEGER,
    p_severity TEXT,
    p_commit_sha TEXT DEFAULT NULL,
    p_actor_ref TEXT DEFAULT 'evaluator'
)
RETURNS TABLE (episode_id UUID, lifecycle_event TEXT, outbox_id UUID)
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_episode public.operational_alert_episodes%ROWTYPE;
    v_outbox_id UUID;
    v_rows INTEGER;
BEGIN
    IF p_environment IS NULL OR p_environment !~ '^[a-z][a-z0-9_-]{0,31}$'
       OR p_rule_id IS NULL OR p_rule_id NOT IN (
           'stripe-live-webhook-failure', 'account-deletion-worker-overdue',
           'support-urgent-untriaged', 'billing-reconciliation-stale'
       )
       OR p_observed_count IS NULL OR p_observed_count < 0
       OR p_threshold IS NULL OR p_threshold < 1
       OR p_window_minutes IS NULL OR p_window_minutes < 1
       OR p_primary_destination_id IS NULL
       OR p_primary_destination_id !~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
       OR p_backup_destination_id IS NULL
       OR p_backup_destination_id !~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
       OR p_primary_destination_id = p_backup_destination_id
       OR p_escalation_after_minutes IS NULL
       OR p_escalation_after_minutes NOT BETWEEN 1 AND 1440
       OR p_severity IS NULL OR p_severity NOT IN ('high', 'critical')
       OR (p_commit_sha IS NOT NULL AND p_commit_sha !~ '^[0-9a-f]{40}$')
       OR p_actor_ref IS NULL OR p_actor_ref !~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$' THEN
        RAISE EXCEPTION 'invalid operational alert evaluation' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(p_environment), hashtext(p_rule_id));
    SELECT * INTO v_episode
      FROM public.operational_alert_episodes episode
     WHERE episode.environment = p_environment
       AND episode.rule_id = p_rule_id
       AND episode.cleared_at IS NULL
     FOR UPDATE;

    IF p_observed_count >= p_threshold THEN
        IF v_episode.id IS NULL THEN
            INSERT INTO public.operational_alert_episodes (
                environment, rule_id, severity, commit_sha, observed_count,
                threshold, window_minutes, primary_destination_id,
                backup_destination_id, escalation_after_minutes,
                opened_at, last_observed_at, created_at, updated_at
            ) VALUES (
                p_environment, p_rule_id, p_severity, p_commit_sha,
                p_observed_count, p_threshold, p_window_minutes,
                p_primary_destination_id, p_backup_destination_id,
                p_escalation_after_minutes, v_now, v_now, v_now, v_now
            ) RETURNING * INTO v_episode;

            INSERT INTO public.operational_alert_outbox (
                episode_id, destination_id, event_kind, destination_role,
                available_at, created_at, updated_at
            ) VALUES (
                v_episode.id, p_primary_destination_id, 'triggered', 'primary',
                v_now, v_now, v_now
            ) RETURNING id INTO v_outbox_id;

            INSERT INTO public.operational_alert_audit_events (
                episode_id, environment, rule_id, event_type, actor_ref,
                delivery_id, destination_id, observed_count, commit_sha, created_at
            ) VALUES (
                v_episode.id, p_environment, p_rule_id, 'opened', p_actor_ref,
                v_outbox_id, p_primary_destination_id, p_observed_count,
                p_commit_sha, v_now
            );
            RETURN QUERY SELECT v_episode.id, 'opened'::TEXT, v_outbox_id;
            RETURN;
        END IF;

        UPDATE public.operational_alert_episodes
           SET observed_count = p_observed_count,
               last_observed_at = v_now,
               commit_sha = p_commit_sha,
               updated_at = v_now
         WHERE id = v_episode.id;

        IF v_episode.acknowledged_at IS NULL
           AND v_now >= v_episode.opened_at
                        + make_interval(mins => v_episode.escalation_after_minutes) THEN
            INSERT INTO public.operational_alert_outbox (
                episode_id, destination_id, event_kind, destination_role,
                available_at, created_at, updated_at
            ) VALUES (
                v_episode.id, v_episode.backup_destination_id, 'escalated', 'backup',
                v_now, v_now, v_now
            ) ON CONFLICT ON CONSTRAINT operational_alert_outbox_episode_event_role_key DO NOTHING
            RETURNING id INTO v_outbox_id;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows = 1 THEN
                INSERT INTO public.operational_alert_audit_events (
                    episode_id, environment, rule_id, event_type, actor_ref,
                    delivery_id, destination_id, observed_count, commit_sha, created_at
                ) VALUES (
                    v_episode.id, p_environment, p_rule_id, 'escalated', p_actor_ref,
                    v_outbox_id, v_episode.backup_destination_id, p_observed_count,
                    p_commit_sha, v_now
                );
                RETURN QUERY SELECT v_episode.id, 'escalated'::TEXT, v_outbox_id;
                RETURN;
            END IF;
        END IF;

        RETURN QUERY SELECT v_episode.id, 'deduped'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    IF v_episode.id IS NULL THEN
        RETURN QUERY SELECT NULL::UUID, 'clear'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    UPDATE public.operational_alert_episodes
       SET observed_count = p_observed_count,
           last_observed_at = v_now,
           commit_sha = p_commit_sha,
           cleared_at = v_now,
           updated_at = v_now
     WHERE id = v_episode.id;

    UPDATE public.operational_alert_outbox outbox
       SET status = 'canceled',
           last_error_code = 'episode_cleared_before_delivery',
           updated_at = v_now
     WHERE outbox.episode_id = v_episode.id
       AND outbox.status = 'pending'
       AND outbox.event_kind IN ('triggered', 'escalated');

    INSERT INTO public.operational_alert_outbox (
        episode_id, destination_id, event_kind, destination_role,
        available_at, created_at, updated_at
    )
    SELECT DISTINCT
        v_episode.id, delivered.destination_id, 'resolved',
        delivered.destination_role, v_now, v_now, v_now
      FROM public.operational_alert_outbox delivered
     WHERE delivered.episode_id = v_episode.id
       AND delivered.status = 'sent'
       AND delivered.event_kind IN ('triggered', 'escalated')
    ON CONFLICT ON CONSTRAINT operational_alert_outbox_episode_event_role_key DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    INSERT INTO public.operational_alert_audit_events (
        episode_id, environment, rule_id, event_type, actor_ref,
        observed_count, commit_sha, created_at
    ) VALUES (
        v_episode.id, p_environment, p_rule_id, 'cleared', p_actor_ref,
        p_observed_count, p_commit_sha, v_now
    );
    IF v_rows > 0 THEN
        INSERT INTO public.operational_alert_audit_events (
            episode_id, environment, rule_id, event_type, actor_ref,
            observed_count, commit_sha, created_at
        ) VALUES (
            v_episode.id, p_environment, p_rule_id, 'resolution_queued', p_actor_ref,
            p_observed_count, p_commit_sha, v_now
        );
    END IF;
    RETURN QUERY SELECT v_episode.id, 'cleared'::TEXT, NULL::UUID;
END;
$$;

CREATE FUNCTION public.acknowledge_operational_alert(
    p_environment TEXT,
    p_episode_id UUID,
    p_actor_role TEXT,
    p_actor_ref TEXT
)
RETURNS TABLE (
    episode_id UUID,
    lifecycle_event TEXT,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by_role TEXT
)
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_episode public.operational_alert_episodes%ROWTYPE;
BEGIN
    IF p_environment IS NULL OR p_environment !~ '^[a-z][a-z0-9_-]{0,31}$'
       OR p_episode_id IS NULL
       OR p_actor_role IS NULL OR p_actor_role NOT IN ('primary', 'backup')
       OR p_actor_ref IS NULL OR p_actor_ref !~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$' THEN
        RAISE EXCEPTION 'invalid operational alert acknowledgement' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_episode
      FROM public.operational_alert_episodes episode
     WHERE episode.id = p_episode_id
       AND episode.environment = p_environment
     FOR UPDATE;
    IF v_episode.id IS NULL THEN
        RETURN;
    END IF;
    IF v_episode.cleared_at IS NOT NULL THEN
        RETURN QUERY SELECT v_episode.id, 'closed'::TEXT,
            v_episode.acknowledged_at, v_episode.acknowledged_by_role;
        RETURN;
    END IF;
    IF v_episode.acknowledged_at IS NOT NULL THEN
        RETURN QUERY SELECT v_episode.id, 'already_acknowledged'::TEXT,
            v_episode.acknowledged_at, v_episode.acknowledged_by_role;
        RETURN;
    END IF;

    UPDATE public.operational_alert_episodes
       SET acknowledged_at = v_now,
           acknowledged_by_role = p_actor_role,
           acknowledged_actor_ref = p_actor_ref,
           updated_at = v_now
     WHERE id = v_episode.id
     RETURNING * INTO v_episode;

    INSERT INTO public.operational_alert_audit_events (
        episode_id, environment, rule_id, event_type, actor_ref,
        observed_count, commit_sha, created_at
    ) VALUES (
        v_episode.id, v_episode.environment, v_episode.rule_id,
        'acknowledged', p_actor_ref, v_episode.observed_count,
        v_episode.commit_sha, v_now
    );

    RETURN QUERY SELECT v_episode.id, 'acknowledged'::TEXT,
        v_episode.acknowledged_at, v_episode.acknowledged_by_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_operational_alert_delivery(
    p_environment TEXT,
    p_lease_token TEXT,
    p_attempt_key UUID,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
    delivery_id UUID, attempt_id UUID, attempt_key UUID, episode_id UUID,
    rule_id TEXT, event_kind TEXT, destination_role TEXT,
    destination_id TEXT, attempt_number INTEGER,
    observed_count BIGINT, threshold INTEGER, window_minutes INTEGER,
    severity TEXT, commit_sha TEXT, opened_at TIMESTAMPTZ,
    observed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_outbox public.operational_alert_outbox%ROWTYPE;
    v_episode public.operational_alert_episodes%ROWTYPE;
    v_attempt public.operational_alert_delivery_attempts%ROWTYPE;
BEGIN
    IF p_environment IS NULL OR p_environment !~ '^[a-z][a-z0-9_-]{0,31}$'
       OR p_lease_token IS NULL OR length(btrim(p_lease_token)) NOT BETWEEN 1 AND 200
       OR p_attempt_key IS NULL
       OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
        RAISE EXCEPTION 'invalid operational alert delivery claim' USING ERRCODE = '22023';
    END IF;

    SELECT attempt.* INTO v_attempt
      FROM public.operational_alert_delivery_attempts attempt
      JOIN public.operational_alert_outbox outbox ON outbox.id = attempt.delivery_id
     WHERE attempt.environment = p_environment
       AND attempt.attempt_key = p_attempt_key
       AND attempt.lease_token = p_lease_token
       AND outbox.status = 'leased'
       AND outbox.active_attempt_id = attempt.id
       AND outbox.lease_expires_at > v_now;

    IF FOUND THEN
        SELECT * INTO v_outbox FROM public.operational_alert_outbox WHERE id = v_attempt.delivery_id;
        SELECT * INTO v_episode FROM public.operational_alert_episodes WHERE id = v_attempt.episode_id;
        RETURN QUERY SELECT
            v_outbox.id, v_attempt.id, v_attempt.attempt_key, v_episode.id,
            v_episode.rule_id, v_outbox.event_kind, v_outbox.destination_role,
            v_outbox.destination_id, v_attempt.attempt_number,
            v_episode.observed_count, v_episode.threshold, v_episode.window_minutes,
            v_episode.severity, v_episode.commit_sha, v_episode.opened_at,
            v_episode.last_observed_at;
        RETURN;
    END IF;

    SELECT outbox.* INTO v_outbox
      FROM public.operational_alert_outbox outbox
      JOIN public.operational_alert_episodes episode ON episode.id = outbox.episode_id
     WHERE episode.environment = p_environment
       AND (episode.cleared_at IS NULL OR outbox.event_kind = 'resolved')
       AND (outbox.status = 'pending'
            OR (outbox.status = 'leased' AND outbox.lease_expires_at <= v_now))
       AND outbox.available_at <= v_now
     ORDER BY outbox.available_at, outbox.created_at, outbox.id
     FOR UPDATE OF outbox SKIP LOCKED
     LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_episode FROM public.operational_alert_episodes WHERE id = v_outbox.episode_id;
    IF v_outbox.status = 'leased' THEN
        INSERT INTO public.operational_alert_delivery_outcomes (attempt_id, outcome, error_code, recorded_at)
        VALUES (v_outbox.active_attempt_id, 'failed', 'lease_expired', v_now)
        ON CONFLICT (attempt_id) DO NOTHING;
        INSERT INTO public.operational_alert_audit_events (
            episode_id, environment, rule_id, event_type, actor_ref,
            delivery_id, attempt_id, destination_id, observed_count,
            commit_sha, error_code, created_at
        ) VALUES (
            v_episode.id, v_episode.environment, v_episode.rule_id,
            'delivery_failed', 'delivery-worker', v_outbox.id,
            v_outbox.active_attempt_id, v_outbox.destination_id,
            v_episode.observed_count, v_episode.commit_sha, 'lease_expired', v_now
        );
    END IF;

    INSERT INTO public.operational_alert_delivery_attempts (
        delivery_id, environment, rule_id, episode_id, attempt_key,
        attempt_number, lease_token, started_at
    ) VALUES (
        v_outbox.id, v_episode.environment, v_episode.rule_id, v_episode.id,
        p_attempt_key, v_outbox.attempt_count + 1, p_lease_token, v_now
    ) RETURNING * INTO v_attempt;

    UPDATE public.operational_alert_outbox
       SET status = 'leased', attempt_count = v_attempt.attempt_number,
           active_attempt_id = v_attempt.id, lease_token = p_lease_token,
           lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
           last_error_code = NULL, updated_at = v_now
     WHERE id = v_outbox.id
     RETURNING * INTO v_outbox;

    INSERT INTO public.operational_alert_audit_events (
        episode_id, environment, rule_id, event_type, actor_ref,
        delivery_id, attempt_id, destination_id, observed_count,
        commit_sha, created_at
    ) VALUES (
        v_episode.id, v_episode.environment, v_episode.rule_id,
        'delivery_claimed', 'delivery-worker', v_outbox.id, v_attempt.id,
        v_outbox.destination_id, v_episode.observed_count,
        v_episode.commit_sha, v_now
    );

    RETURN QUERY SELECT
        v_outbox.id, v_attempt.id, v_attempt.attempt_key, v_episode.id,
        v_episode.rule_id, v_outbox.event_kind, v_outbox.destination_role,
        v_outbox.destination_id, v_attempt.attempt_number,
        v_episode.observed_count, v_episode.threshold, v_episode.window_minutes,
        v_episode.severity, v_episode.commit_sha, v_episode.opened_at,
        v_episode.last_observed_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_operational_alert_delivery(
    p_attempt_id UUID, p_lease_token TEXT, p_receipt TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_attempt public.operational_alert_delivery_attempts%ROWTYPE;
    v_outbox public.operational_alert_outbox%ROWTYPE;
    v_episode public.operational_alert_episodes%ROWTYPE;
    v_resolution_id UUID;
    v_rows INTEGER;
BEGIN
    IF p_attempt_id IS NULL
       OR p_lease_token IS NULL OR length(btrim(p_lease_token)) NOT BETWEEN 1 AND 200
       OR p_receipt IS NULL OR length(btrim(p_receipt)) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'valid attempt, lease token, and receipt are required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_attempt FROM public.operational_alert_delivery_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO v_outbox
      FROM public.operational_alert_outbox
     WHERE id = v_attempt.delivery_id
     FOR UPDATE;
    IF v_outbox.status = 'sent'
       AND v_outbox.completed_attempt_id = p_attempt_id
       AND v_outbox.receipt = p_receipt
       AND EXISTS (
           SELECT 1 FROM public.operational_alert_delivery_outcomes outcome
            WHERE outcome.attempt_id = p_attempt_id
              AND outcome.outcome = 'sent'
              AND outcome.receipt = p_receipt
       ) THEN
        RETURN true;
    END IF;
    IF v_outbox.status <> 'leased'
       OR v_outbox.active_attempt_id IS DISTINCT FROM p_attempt_id
       OR v_outbox.lease_token IS DISTINCT FROM p_lease_token
       OR v_outbox.lease_expires_at <= v_now THEN
        RETURN false;
    END IF;
    -- Serialize completion with the evaluator's clear path. Without this row
    -- lock, clear can observe the delivery as leased while completion observes
    -- a stale uncleared episode, leaving a receipt-confirmed notification with
    -- no matching resolution.
    SELECT * INTO v_episode
      FROM public.operational_alert_episodes
     WHERE id = v_attempt.episode_id
     FOR UPDATE;

    INSERT INTO public.operational_alert_delivery_outcomes (
        attempt_id, outcome, receipt, recorded_at
    ) VALUES (p_attempt_id, 'sent', p_receipt, v_now);

    UPDATE public.operational_alert_outbox
       SET status = 'sent', active_attempt_id = NULL, lease_token = NULL,
           lease_expires_at = NULL, completed_attempt_id = p_attempt_id,
           sent_at = v_now, receipt = p_receipt, last_error_code = NULL,
           updated_at = v_now
     WHERE id = v_outbox.id;

    INSERT INTO public.operational_alert_audit_events (
        episode_id, environment, rule_id, event_type, actor_ref,
        delivery_id, attempt_id, destination_id, observed_count,
        commit_sha, created_at
    ) VALUES (
        v_episode.id, v_episode.environment, v_episode.rule_id,
        'delivery_sent', 'delivery-worker', v_outbox.id, p_attempt_id,
        v_outbox.destination_id, v_episode.observed_count,
        v_episode.commit_sha, v_now
    );

    -- A trigger/escalation already in flight when the episode clears may still
    -- return a valid provider receipt. Queue its matching resolution in this
    -- same transaction so the late send cannot become an unresolved notice.
    IF v_episode.cleared_at IS NOT NULL
       AND v_outbox.event_kind IN ('triggered', 'escalated') THEN
        INSERT INTO public.operational_alert_outbox (
            episode_id, destination_id, event_kind, destination_role,
            available_at, created_at, updated_at
        ) VALUES (
            v_episode.id, v_outbox.destination_id, 'resolved',
            v_outbox.destination_role, v_now, v_now, v_now
        ) ON CONFLICT ON CONSTRAINT operational_alert_outbox_episode_event_role_key DO NOTHING
        RETURNING id INTO v_resolution_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 1 THEN
            INSERT INTO public.operational_alert_audit_events (
                episode_id, environment, rule_id, event_type, actor_ref,
                delivery_id, destination_id, observed_count, commit_sha, created_at
            ) VALUES (
                v_episode.id, v_episode.environment, v_episode.rule_id,
                'resolution_queued', 'delivery-worker', v_resolution_id,
                v_outbox.destination_id, v_episode.observed_count,
                v_episode.commit_sha, v_now
            );
        END IF;
    END IF;
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_operational_alert_delivery(
    p_attempt_id UUID,
    p_lease_token TEXT,
    p_error_code TEXT,
    p_retry_after_seconds INTEGER DEFAULT 60
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_attempt public.operational_alert_delivery_attempts%ROWTYPE;
    v_outbox public.operational_alert_outbox%ROWTYPE;
    v_episode public.operational_alert_episodes%ROWTYPE;
    v_next_status TEXT;
BEGIN
    IF p_attempt_id IS NULL
       OR p_lease_token IS NULL OR length(btrim(p_lease_token)) NOT BETWEEN 1 AND 200
       OR p_error_code IS NULL OR p_error_code !~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$'
       OR p_retry_after_seconds IS NULL OR p_retry_after_seconds NOT BETWEEN 1 AND 86400 THEN
        RAISE EXCEPTION 'invalid operational alert delivery failure' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_attempt FROM public.operational_alert_delivery_attempts WHERE id = p_attempt_id;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO v_outbox
      FROM public.operational_alert_outbox
     WHERE id = v_attempt.delivery_id
     FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM public.operational_alert_delivery_outcomes outcome
         WHERE outcome.attempt_id = p_attempt_id
           AND outcome.outcome = 'failed'
           AND outcome.error_code = p_error_code
    ) THEN
        RETURN true;
    END IF;
    IF v_outbox.status <> 'leased'
       OR v_outbox.active_attempt_id IS DISTINCT FROM p_attempt_id
       OR v_outbox.lease_token IS DISTINCT FROM p_lease_token THEN
        RETURN false;
    END IF;
    SELECT * INTO v_episode FROM public.operational_alert_episodes WHERE id = v_attempt.episode_id;

    INSERT INTO public.operational_alert_delivery_outcomes (
        attempt_id, outcome, error_code, recorded_at
    ) VALUES (p_attempt_id, 'failed', p_error_code, v_now);

    v_next_status := CASE
        WHEN v_episode.cleared_at IS NULL OR v_outbox.event_kind = 'resolved' THEN 'pending'
        ELSE 'canceled'
    END;
    UPDATE public.operational_alert_outbox
       SET status = v_next_status, active_attempt_id = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           available_at = v_now + make_interval(secs => p_retry_after_seconds),
           last_error_code = p_error_code, updated_at = v_now
     WHERE id = v_outbox.id;

    INSERT INTO public.operational_alert_audit_events (
        episode_id, environment, rule_id, event_type, actor_ref,
        delivery_id, attempt_id, destination_id, observed_count,
        commit_sha, error_code, created_at
    ) VALUES (
        v_episode.id, v_episode.environment, v_episode.rule_id,
        CASE WHEN v_next_status = 'pending' THEN 'delivery_failed' ELSE 'delivery_canceled' END,
        'delivery-worker', v_outbox.id, p_attempt_id, v_outbox.destination_id,
        v_episode.observed_count, v_episode.commit_sha, p_error_code, v_now
    );
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_operational_alert(
    TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evaluate_operational_alert(
    TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT
) FROM service_role;
REVOKE ALL ON FUNCTION public.acknowledge_operational_alert(TEXT, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_operational_alert(
    TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_operational_alert(TEXT, UUID, TEXT, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.acknowledge_operational_alert(TEXT, UUID, TEXT, TEXT) IS
    'Service-role-only acknowledgement. Actor role/ref are derived from a dedicated internal secret.';
COMMENT ON COLUMN public.operational_alert_outbox.event_kind IS
    'Counts-only lifecycle event delivered to an exact logical destination.';
