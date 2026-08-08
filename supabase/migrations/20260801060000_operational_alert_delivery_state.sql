-- Durable, privacy-safe delivery state for the four Phase A operational rules.
-- Source inspection is reduced to counts inside PostgreSQL. The outbox records
-- logical destinations only. Every send is preceded by an immutable attempt.

CREATE TABLE public.operational_alert_episodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    environment TEXT NOT NULL CHECK (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
    rule_id TEXT NOT NULL CHECK (rule_id IN (
        'stripe-live-webhook-failure',
        'account-deletion-worker-overdue',
        'support-urgent-untriaged',
        'billing-reconciliation-stale'
    )),
    severity TEXT NOT NULL CHECK (severity IN ('high', 'critical')),
    commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
    observed_count BIGINT NOT NULL CHECK (observed_count >= 0),
    threshold INTEGER NOT NULL CHECK (threshold > 0),
    window_minutes INTEGER NOT NULL CHECK (window_minutes > 0),
    primary_destination_id TEXT NOT NULL CHECK (
        length(btrim(primary_destination_id)) BETWEEN 1 AND 80
        AND primary_destination_id ~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
    ),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    cleared_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (last_observed_at >= opened_at),
    CHECK (cleared_at IS NULL OR cleared_at >= opened_at)
);

CREATE UNIQUE INDEX operational_alert_episodes_one_unresolved
    ON public.operational_alert_episodes (environment, rule_id)
    WHERE cleared_at IS NULL;

CREATE INDEX operational_alert_episodes_recent
    ON public.operational_alert_episodes (environment, rule_id, opened_at DESC);

CREATE TABLE public.operational_alert_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    episode_id UUID NOT NULL REFERENCES public.operational_alert_episodes(id),
    destination_id TEXT NOT NULL CHECK (
        length(btrim(destination_id)) BETWEEN 1 AND 80
        AND destination_id ~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
    ),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'sent', 'canceled')),
    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    active_attempt_id UUID,
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    completed_attempt_id UUID,
    sent_at TIMESTAMPTZ,
    receipt TEXT CHECK (receipt IS NULL OR length(btrim(receipt)) BETWEEN 1 AND 500),
    last_error_code TEXT CHECK (
        last_error_code IS NULL
        OR (
            length(btrim(last_error_code)) BETWEEN 1 AND 120
            AND last_error_code ~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$'
        )
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (episode_id),
    CHECK (
        (status = 'leased' AND active_attempt_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'leased' AND active_attempt_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
        (status = 'sent' AND completed_attempt_id IS NOT NULL AND sent_at IS NOT NULL AND receipt IS NOT NULL)
        OR (status <> 'sent' AND completed_attempt_id IS NULL AND sent_at IS NULL AND receipt IS NULL)
    )
);

CREATE INDEX operational_alert_outbox_claim
    ON public.operational_alert_outbox (available_at, created_at, id)
    WHERE status IN ('pending', 'leased');

CREATE TABLE public.operational_alert_delivery_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id UUID NOT NULL REFERENCES public.operational_alert_outbox(id),
    environment TEXT NOT NULL CHECK (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
    rule_id TEXT NOT NULL CHECK (rule_id IN (
        'stripe-live-webhook-failure',
        'account-deletion-worker-overdue',
        'support-urgent-untriaged',
        'billing-reconciliation-stale'
    )),
    episode_id UUID NOT NULL REFERENCES public.operational_alert_episodes(id),
    attempt_key UUID NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    lease_token TEXT NOT NULL CHECK (length(btrim(lease_token)) BETWEEN 1 AND 200),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (delivery_id, attempt_number),
    UNIQUE (environment, rule_id, episode_id, attempt_key)
);

CREATE INDEX operational_alert_delivery_attempts_delivery
    ON public.operational_alert_delivery_attempts (delivery_id, attempt_number DESC);

ALTER TABLE public.operational_alert_outbox
    ADD CONSTRAINT operational_alert_outbox_active_attempt_fk
        FOREIGN KEY (active_attempt_id) REFERENCES public.operational_alert_delivery_attempts(id),
    ADD CONSTRAINT operational_alert_outbox_completed_attempt_fk
        FOREIGN KEY (completed_attempt_id) REFERENCES public.operational_alert_delivery_attempts(id);

CREATE TABLE public.operational_alert_delivery_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id UUID NOT NULL UNIQUE REFERENCES public.operational_alert_delivery_attempts(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
    receipt TEXT,
    error_code TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (outcome = 'sent'
         AND receipt IS NOT NULL
         AND length(btrim(receipt)) BETWEEN 1 AND 500
         AND error_code IS NULL)
        OR (outcome = 'failed'
            AND receipt IS NULL
            AND error_code IS NOT NULL
            AND error_code ~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$')
    )
);

CREATE TABLE public.operational_alert_audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    episode_id UUID REFERENCES public.operational_alert_episodes(id),
    environment TEXT NOT NULL CHECK (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
    rule_id TEXT CHECK (rule_id IS NULL OR rule_id IN (
        'stripe-live-webhook-failure',
        'account-deletion-worker-overdue',
        'support-urgent-untriaged',
        'billing-reconciliation-stale'
    )),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'opened', 'cleared', 'delivery_claimed', 'delivery_sent',
        'delivery_failed', 'delivery_canceled', 'heartbeat'
    )),
    actor_ref TEXT NOT NULL CHECK (
        length(btrim(actor_ref)) BETWEEN 1 AND 80
        AND actor_ref ~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
    ),
    delivery_id UUID REFERENCES public.operational_alert_outbox(id),
    attempt_id UUID REFERENCES public.operational_alert_delivery_attempts(id),
    destination_id TEXT CHECK (
        destination_id IS NULL
        OR (
            length(btrim(destination_id)) BETWEEN 1 AND 80
            AND destination_id ~ '^[a-z0-9][a-z0-9_.:/-]{0,79}$'
        )
    ),
    observed_count BIGINT CHECK (observed_count IS NULL OR observed_count >= 0),
    commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
    error_code TEXT CHECK (
        error_code IS NULL
        OR error_code ~ '^[a-z0-9][a-z0-9_.:/-]{0,119}$'
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX operational_alert_audit_events_episode
    ON public.operational_alert_audit_events (episode_id, created_at, id);

CREATE TABLE public.operational_alert_heartbeats (
    environment TEXT NOT NULL CHECK (environment ~ '^[a-z][a-z0-9_-]{0,31}$'),
    worker_id TEXT NOT NULL CHECK (worker_id IN ('evaluator', 'deletion-worker')),
    commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40}$'),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    sequence BIGINT NOT NULL DEFAULT 1 CHECK (sequence > 0),
    PRIMARY KEY (environment, worker_id)
);

CREATE FUNCTION public.prevent_operational_alert_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION 'operational alert history is append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER prevent_operational_alert_attempt_mutation
    BEFORE UPDATE OR DELETE ON public.operational_alert_delivery_attempts
    FOR EACH ROW EXECUTE FUNCTION public.prevent_operational_alert_append_only_mutation();

CREATE TRIGGER prevent_operational_alert_outcome_mutation
    BEFORE UPDATE OR DELETE ON public.operational_alert_delivery_outcomes
    FOR EACH ROW EXECUTE FUNCTION public.prevent_operational_alert_append_only_mutation();

CREATE TRIGGER prevent_operational_alert_audit_mutation
    BEFORE UPDATE OR DELETE ON public.operational_alert_audit_events
    FOR EACH ROW EXECUTE FUNCTION public.prevent_operational_alert_append_only_mutation();

CREATE FUNCTION public.enforce_operational_alert_sent_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF NEW.status = 'sent' AND NOT EXISTS (
        SELECT 1
          FROM public.operational_alert_delivery_attempts attempt
          JOIN public.operational_alert_delivery_outcomes outcome
            ON outcome.attempt_id = attempt.id
         WHERE attempt.id = NEW.completed_attempt_id
           AND attempt.delivery_id = NEW.id
           AND outcome.outcome = 'sent'
           AND outcome.receipt = NEW.receipt
    ) THEN
        RAISE EXCEPTION 'sent operational alert delivery requires a matching durable receipt'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_operational_alert_sent_receipt
    BEFORE INSERT OR UPDATE ON public.operational_alert_outbox
    FOR EACH ROW EXECUTE FUNCTION public.enforce_operational_alert_sent_receipt();

CREATE FUNCTION public.operational_alert_metric_counts()
RETURNS TABLE (rule_id TEXT, observed_count BIGINT, checked_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SET search_path = 'public', 'pg_temp'
AS $$
    WITH observation AS (SELECT now() AS checked_at)
    SELECT
        'stripe-live-webhook-failure'::TEXT,
        (SELECT COUNT(*)::BIGINT
           FROM public.stripe_events event
          WHERE event.livemode
            AND (
                (event.processing_status = 'failed'
                 AND event.created_at <= observation.checked_at - INTERVAL '10 minutes')
                OR (event.processing_status = 'processing'
                    AND COALESCE(event.processing_started_at, event.created_at)
                        <= observation.checked_at - INTERVAL '10 minutes')
            )),
        observation.checked_at
      FROM observation
    UNION ALL
    SELECT
        'account-deletion-worker-overdue'::TEXT,
        (SELECT COUNT(*)::BIGINT
           FROM public.account_deletion_requests request
          WHERE request.status = 'scheduled'
            AND request.scheduled_for <= observation.checked_at - INTERVAL '24 hours'),
        observation.checked_at
      FROM observation
    UNION ALL
    SELECT
        'support-urgent-untriaged'::TEXT,
        (SELECT COUNT(*)::BIGINT
           FROM public.support_tickets ticket
          WHERE ticket.status = 'open' AND ticket.severity = 'urgent'
            AND ticket.created_at <= observation.checked_at - INTERVAL '30 minutes'),
        observation.checked_at
      FROM observation
    UNION ALL
    SELECT
        'billing-reconciliation-stale'::TEXT,
        (SELECT COUNT(*)::BIGINT
           FROM public.billing_invoice_retry_operations operation
          WHERE operation.status = 'reconciliation_required'
            AND operation.updated_at <= observation.checked_at - INTERVAL '1 hour'),
        observation.checked_at
      FROM observation;
$$;

CREATE FUNCTION public.evaluate_operational_alert(
    p_environment TEXT,
    p_rule_id TEXT,
    p_observed_count BIGINT,
    p_threshold INTEGER,
    p_window_minutes INTEGER,
    p_primary_destination_id TEXT,
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
        IF NOT FOUND THEN
            INSERT INTO public.operational_alert_episodes (
                environment, rule_id, severity, commit_sha, observed_count,
                threshold, window_minutes, primary_destination_id,
                opened_at, last_observed_at, created_at, updated_at
            ) VALUES (
                p_environment, p_rule_id, p_severity, p_commit_sha,
                p_observed_count, p_threshold, p_window_minutes,
                p_primary_destination_id, v_now, v_now, v_now, v_now
            ) RETURNING * INTO v_episode;

            INSERT INTO public.operational_alert_outbox (
                episode_id, destination_id, available_at, created_at, updated_at
            ) VALUES (
                v_episode.id, p_primary_destination_id, v_now, v_now, v_now
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
        RETURN QUERY SELECT v_episode.id, 'deduped'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    IF NOT FOUND THEN
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
     WHERE outbox.episode_id = v_episode.id AND outbox.status = 'pending';

    INSERT INTO public.operational_alert_audit_events (
        episode_id, environment, rule_id, event_type, actor_ref,
        observed_count, commit_sha, created_at
    ) VALUES (
        v_episode.id, p_environment, p_rule_id, 'cleared', p_actor_ref,
        p_observed_count, p_commit_sha, v_now
    );
    RETURN QUERY SELECT v_episode.id, 'cleared'::TEXT, NULL::UUID;
END;
$$;

CREATE FUNCTION public.claim_operational_alert_delivery(
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

    -- A retried RPC call with the same caller-generated key returns the already
    -- persisted active attempt instead of creating a second send authorization.
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
            v_episode.rule_id, 'triggered'::TEXT, 'primary'::TEXT,
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
       AND episode.cleared_at IS NULL
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
        v_episode.rule_id, 'triggered'::TEXT, 'primary'::TEXT,
        v_outbox.destination_id, v_attempt.attempt_number,
        v_episode.observed_count, v_episode.threshold, v_episode.window_minutes,
        v_episode.severity, v_episode.commit_sha, v_episode.opened_at,
        v_episode.last_observed_at;
END;
$$;

CREATE FUNCTION public.complete_operational_alert_delivery(
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
    SELECT * INTO v_episode FROM public.operational_alert_episodes WHERE id = v_attempt.episode_id;

    -- Receipt is durable before the outbox can become sent (same transaction).
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
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    RETURN false;
END;
$$;

CREATE FUNCTION public.fail_operational_alert_delivery(
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

    v_next_status := CASE WHEN v_episode.cleared_at IS NULL THEN 'pending' ELSE 'canceled' END;
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

CREATE FUNCTION public.record_operational_alert_heartbeat(
    p_environment TEXT, p_worker_id TEXT, p_commit_sha TEXT DEFAULT NULL
)
RETURNS TABLE (worker_id TEXT, last_seen_at TIMESTAMPTZ, sequence BIGINT)
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
    v_heartbeat public.operational_alert_heartbeats%ROWTYPE;
BEGIN
    IF p_environment IS NULL OR p_environment !~ '^[a-z][a-z0-9_-]{0,31}$'
       OR p_worker_id IS NULL OR p_worker_id NOT IN ('evaluator', 'deletion-worker')
       OR (p_commit_sha IS NOT NULL AND p_commit_sha !~ '^[0-9a-f]{40}$') THEN
        RAISE EXCEPTION 'invalid operational alert heartbeat' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.operational_alert_heartbeats (
        environment, worker_id, commit_sha, last_seen_at, sequence
    ) VALUES (p_environment, p_worker_id, p_commit_sha, v_now, 1)
    ON CONFLICT ON CONSTRAINT operational_alert_heartbeats_pkey DO UPDATE
       SET commit_sha = EXCLUDED.commit_sha,
           last_seen_at = EXCLUDED.last_seen_at,
           sequence = public.operational_alert_heartbeats.sequence + 1
    RETURNING * INTO v_heartbeat;
    INSERT INTO public.operational_alert_audit_events (
        environment, event_type, actor_ref, commit_sha, created_at
    ) VALUES (p_environment, 'heartbeat', p_worker_id, p_commit_sha, v_now);
    RETURN QUERY SELECT v_heartbeat.worker_id, v_heartbeat.last_seen_at, v_heartbeat.sequence;
END;
$$;

CREATE FUNCTION public.operational_alert_heartbeats(p_environment TEXT)
RETURNS TABLE (worker_id TEXT, last_seen_at TIMESTAMPTZ, commit_sha TEXT, sequence BIGINT)
LANGUAGE plpgsql
STABLE
SET search_path = 'public', 'pg_temp'
AS $$
BEGIN
    IF p_environment IS NULL OR p_environment !~ '^[a-z][a-z0-9_-]{0,31}$' THEN
        RAISE EXCEPTION 'invalid operational alert environment' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    SELECT heartbeat.worker_id, heartbeat.last_seen_at,
           heartbeat.commit_sha, heartbeat.sequence
      FROM public.operational_alert_heartbeats heartbeat
     WHERE heartbeat.environment = p_environment
     ORDER BY heartbeat.worker_id;
END;
$$;

ALTER TABLE public.operational_alert_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_alert_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_alert_delivery_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_alert_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_alert_heartbeats ENABLE ROW LEVEL SECURITY;

-- Keep the repository-wide fail-closed invariant for every public RLS table.
-- These restrictive policies grant nothing; they only prevent an ambiguous
-- staff membership from becoming an alternate access path if grants evolve.
DO $$
DECLARE
    v_table_name TEXT;
BEGIN
    FOREACH v_table_name IN ARRAY ARRAY[
        'operational_alert_episodes',
        'operational_alert_outbox',
        'operational_alert_delivery_attempts',
        'operational_alert_delivery_outcomes',
        'operational_alert_audit_events',
        'operational_alert_heartbeats'
    ]
    LOOP
        EXECUTE format(
            'CREATE POLICY reject_ambiguous_staff_membership_access ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.has_unambiguous_studio_membership())) WITH CHECK ((SELECT private.has_unambiguous_studio_membership()))',
            v_table_name
        );
    END LOOP;
END;
$$;

REVOKE ALL ON TABLE public.operational_alert_episodes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.operational_alert_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.operational_alert_delivery_attempts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.operational_alert_delivery_outcomes FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.operational_alert_audit_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.operational_alert_heartbeats FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.operational_alert_episodes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operational_alert_outbox TO service_role;
GRANT SELECT, INSERT ON TABLE public.operational_alert_delivery_attempts TO service_role;
GRANT SELECT, INSERT ON TABLE public.operational_alert_delivery_outcomes TO service_role;
GRANT SELECT, INSERT ON TABLE public.operational_alert_audit_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.operational_alert_audit_events_id_seq TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.operational_alert_heartbeats TO service_role;

REVOKE ALL ON FUNCTION public.prevent_operational_alert_append_only_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_operational_alert_sent_receipt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operational_alert_metric_counts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evaluate_operational_alert(TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_operational_alert_delivery(TEXT, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_operational_alert_delivery(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_operational_alert_delivery(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_operational_alert_heartbeat(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operational_alert_heartbeats(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.operational_alert_metric_counts() TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_operational_alert(TEXT, TEXT, BIGINT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_operational_alert_delivery(TEXT, TEXT, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_operational_alert_delivery(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_operational_alert_delivery(UUID, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_operational_alert_heartbeat(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.operational_alert_heartbeats(TEXT) TO service_role;

COMMENT ON FUNCTION public.operational_alert_metric_counts() IS
    'Service-role-only counts for exactly four Phase A alert rules; returns no source rows.';
COMMENT ON TABLE public.operational_alert_delivery_attempts IS
    'Immutable pre-send records. attempt_key is the stable idempotency key for one authorized send attempt.';
COMMENT ON TABLE public.operational_alert_delivery_outcomes IS
    'Immutable post-send outcomes. A sent outcome requires a nonblank delivery receipt.';
COMMENT ON TABLE public.operational_alert_audit_events IS
    'Append-only, counts-only lifecycle audit; source rows and provider payloads are prohibited.';
