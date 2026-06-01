-- ==========================================
-- Koaryu v1 - Service-owned worker claim RPCs
-- ==========================================
--
-- Worker claim state belongs in the database so concurrent backend workers do
-- not have to coordinate by hand-rolled read/update sequences.

CREATE OR REPLACE FUNCTION public.claim_stripe_event_for_processing(
    p_stripe_event_id TEXT,
    p_stripe_account_id TEXT,
    p_livemode BOOLEAN,
    p_type TEXT,
    p_payload JSONB,
    p_processing_token TEXT,
    p_stale_after_seconds INTEGER DEFAULT 600
)
RETURNS TABLE(claim_status TEXT, event_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event public.stripe_events%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_cutoff TIMESTAMPTZ := now() - (GREATEST(COALESCE(p_stale_after_seconds, 1), 1) * INTERVAL '1 second');
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    IF p_stripe_event_id IS NULL OR btrim(p_stripe_event_id) = '' THEN
        RETURN QUERY SELECT 'ignored'::TEXT, NULL::JSONB;
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'stripe_event:' || p_stripe_event_id || ':' || COALESCE(p_stripe_account_id, 'platform'),
            0
        )
    );

    SELECT *
      INTO v_event
      FROM public.stripe_events
     WHERE stripe_event_id = p_stripe_event_id
       AND stripe_account_id IS NOT DISTINCT FROM p_stripe_account_id
     FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.stripe_events (
            stripe_event_id,
            stripe_account_id,
            livemode,
            type,
            payload,
            processing_status,
            processing_token,
            processing_started_at
        )
        VALUES (
            p_stripe_event_id,
            p_stripe_account_id,
            COALESCE(p_livemode, false),
            COALESCE(NULLIF(p_type, ''), 'unknown'),
            COALESCE(p_payload, '{}'::JSONB),
            'processing',
            p_processing_token,
            v_now
        )
        RETURNING * INTO v_event;

        RETURN QUERY SELECT 'claimed'::TEXT, to_jsonb(v_event);
        RETURN;
    END IF;

    IF v_event.processing_status = 'processed' THEN
        RETURN QUERY SELECT 'already_processed'::TEXT, to_jsonb(v_event);
        RETURN;
    END IF;

    IF v_event.processing_status = 'processing'
       AND COALESCE(v_event.processing_started_at, v_event.created_at) > v_cutoff THEN
        RETURN QUERY SELECT 'already_processing'::TEXT, to_jsonb(v_event);
        RETURN;
    END IF;

    IF v_event.processing_status NOT IN ('pending', 'processing', 'failed') THEN
        RETURN QUERY SELECT 'already_processing'::TEXT, to_jsonb(v_event);
        RETURN;
    END IF;

    UPDATE public.stripe_events
       SET processing_status = 'processing',
           processing_token = p_processing_token,
           processing_started_at = v_now,
           error = NULL,
           livemode = COALESCE(p_livemode, livemode),
           type = COALESCE(NULLIF(p_type, ''), type),
           payload = COALESCE(p_payload, payload)
     WHERE id = v_event.id
     RETURNING * INTO v_event;

    RETURN QUERY SELECT 'claimed'::TEXT, to_jsonb(v_event);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_stripe_event_processing(
    p_event_id UUID,
    p_processing_token TEXT,
    p_status TEXT,
    p_error TEXT DEFAULT NULL
)
RETURNS TABLE(updated BOOLEAN, event_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event public.stripe_events%ROWTYPE;
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    IF p_status NOT IN ('processed', 'failed', 'ignored') THEN
        RAISE EXCEPTION 'Invalid Stripe event finish status: %', p_status;
    END IF;

    UPDATE public.stripe_events
       SET processing_status = p_status,
           processed_at = CASE WHEN p_status = 'processed' THEN now() ELSE processed_at END,
           error = CASE WHEN p_status = 'failed' THEN p_error ELSE NULL END,
           processing_token = NULL,
           processing_started_at = NULL
     WHERE id = p_event_id
       AND processing_token = p_processing_token
     RETURNING * INTO v_event;

    IF FOUND THEN
        RETURN QUERY SELECT true, to_jsonb(v_event);
    ELSE
        RETURN QUERY SELECT false, NULL::JSONB;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_due_account_deletion_requests(
    p_limit INTEGER,
    p_processing_token TEXT,
    p_stale_after_seconds INTEGER DEFAULT 1800
)
RETURNS SETOF public.account_deletion_requests
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT id
          FROM public.account_deletion_requests
         WHERE status = 'scheduled'
           AND scheduled_for <= now()
           AND (
                processing_token IS NULL
                OR processing_started_at <= now() - (GREATEST(COALESCE(p_stale_after_seconds, 1), 1) * INTERVAL '1 second')
           )
         ORDER BY scheduled_for ASC, requested_at ASC, id ASC
         LIMIT GREATEST(COALESCE(p_limit, 0), 0)
         FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
        UPDATE public.account_deletion_requests request
           SET processing_token = p_processing_token,
               processing_started_at = now()
          FROM candidates
         WHERE request.id = candidates.id
         RETURNING request.*
    )
    SELECT * FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_account_deletion_request(
    p_request_id UUID,
    p_processing_token TEXT,
    p_status TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS TABLE(updated BOOLEAN, request_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_request public.account_deletion_requests%ROWTYPE;
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    IF p_status NOT IN ('completed', 'canceled') THEN
        RAISE EXCEPTION 'Invalid account deletion finish status: %', p_status;
    END IF;

    UPDATE public.account_deletion_requests
       SET status = p_status,
           completed_at = CASE WHEN p_status = 'completed' THEN now() ELSE completed_at END,
           canceled_at = CASE WHEN p_status = 'canceled' THEN now() ELSE canceled_at END,
           reason = CASE WHEN p_status = 'canceled' THEN left(COALESCE(p_reason, ''), 500) ELSE reason END,
           processing_token = NULL,
           processing_started_at = NULL
     WHERE id = p_request_id
       AND processing_token = p_processing_token
     RETURNING * INTO v_request;

    IF FOUND THEN
        RETURN QUERY SELECT true, to_jsonb(v_request);
    ELSE
        RETURN QUERY SELECT false, NULL::JSONB;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_student_import_run(
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation TEXT,
    p_idempotency_key TEXT,
    p_request_hash TEXT,
    p_processing_token TEXT,
    p_stale_after_seconds INTEGER DEFAULT 45
)
RETURNS TABLE(claim_status TEXT, run_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_cutoff TIMESTAMPTZ := now() - (GREATEST(COALESCE(p_stale_after_seconds, 1), 1) * INTERVAL '1 second');
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'student_import:' || p_studio_id::TEXT || ':' || COALESCE(p_operation, '') || ':' || COALESCE(p_idempotency_key, ''),
            0
        )
    );

    SELECT *
      INTO v_run
      FROM public.student_import_runs
     WHERE studio_id = p_studio_id
       AND operation = p_operation
       AND idempotency_key = p_idempotency_key
     FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.student_import_runs (
            studio_id,
            actor_id,
            operation,
            idempotency_key,
            request_hash,
            status,
            started_at,
            completed_at,
            error_message,
            processing_token,
            processing_started_at
        )
        VALUES (
            p_studio_id,
            p_actor_id,
            p_operation,
            p_idempotency_key,
            p_request_hash,
            'processing',
            v_now,
            NULL,
            NULL,
            p_processing_token,
            v_now
        )
        RETURNING * INTO v_run;

        RETURN QUERY SELECT 'claimed'::TEXT, to_jsonb(v_run);
        RETURN;
    END IF;

    IF v_run.request_hash <> p_request_hash THEN
        RETURN QUERY SELECT 'hash_mismatch'::TEXT, to_jsonb(v_run);
        RETURN;
    END IF;

    IF v_run.status = 'completed' AND v_run.result_json IS NOT NULL THEN
        RETURN QUERY SELECT 'completed'::TEXT, to_jsonb(v_run);
        RETURN;
    END IF;

    IF v_run.status = 'processing'
       AND COALESCE(v_run.processing_started_at, v_run.updated_at, v_run.created_at) > v_cutoff THEN
        RETURN QUERY SELECT 'already_processing'::TEXT, to_jsonb(v_run);
        RETURN;
    END IF;

    UPDATE public.student_import_runs
       SET actor_id = p_actor_id,
           status = 'processing',
           error_message = NULL,
           started_at = v_now,
           completed_at = NULL,
           processing_token = p_processing_token,
           processing_started_at = v_now
     WHERE id = v_run.id
     RETURNING * INTO v_run;

    RETURN QUERY SELECT 'claimed'::TEXT, to_jsonb(v_run);
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_student_import_run(
    p_import_run_id UUID,
    p_processing_token TEXT
)
RETURNS TABLE(updated BOOLEAN, run_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    UPDATE public.student_import_runs
       SET processing_started_at = now()
     WHERE id = p_import_run_id
       AND status = 'processing'
       AND processing_token = p_processing_token
     RETURNING * INTO v_run;

    IF FOUND THEN
        RETURN QUERY SELECT true, to_jsonb(v_run);
    ELSE
        RETURN QUERY SELECT false, NULL::JSONB;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_student_import_run(
    p_import_run_id UUID,
    p_processing_token TEXT,
    p_status TEXT,
    p_result_json JSONB DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS TABLE(updated BOOLEAN, run_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    IF p_status NOT IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'Invalid student import finish status: %', p_status;
    END IF;

    UPDATE public.student_import_runs
       SET status = p_status,
           result_json = CASE WHEN p_status = 'completed' THEN p_result_json ELSE result_json END,
           error_message = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_error_message, ''), 1000) ELSE NULL END,
           completed_at = CASE WHEN p_status = 'completed' THEN now() ELSE completed_at END,
           processing_token = NULL,
           processing_started_at = NULL
     WHERE id = p_import_run_id
       AND processing_token = p_processing_token
     RETURNING * INTO v_run;

    IF FOUND THEN
        RETURN QUERY SELECT true, to_jsonb(v_run);
    ELSE
        RETURN QUERY SELECT false, NULL::JSONB;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_stripe_event_for_processing(TEXT, TEXT, BOOLEAN, TEXT, JSONB, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_stripe_event_processing(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_account_deletion_requests(INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_account_deletion_request(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_student_import_run(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_student_import_run(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_student_import_run(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_stripe_event_for_processing(TEXT, TEXT, BOOLEAN, TEXT, JSONB, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_stripe_event_processing(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_account_deletion_requests(INTEGER, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_account_deletion_request(UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_student_import_run(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_student_import_run(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_student_import_run(UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;
