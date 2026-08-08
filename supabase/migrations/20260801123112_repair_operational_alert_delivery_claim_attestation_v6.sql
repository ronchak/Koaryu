-- Repair the alert-delivery lease-expiry path without rewriting migration 90.
-- The prior column-name conflict target is ambiguous with the RETURNS TABLE
-- output variable. The named UNIQUE constraint preserves attempt-idempotency.

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
        ON CONFLICT ON CONSTRAINT operational_alert_delivery_outcomes_attempt_id_key DO NOTHING;
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

ALTER FUNCTION public.claim_operational_alert_delivery(TEXT, TEXT, UUID, INTEGER)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_operational_alert_delivery(TEXT, TEXT, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_operational_alert_delivery(TEXT, TEXT, UUID, INTEGER)
    TO service_role;

-- V6 carries the entire V5/V4/V3 surface and independently records the exact
-- repaired function state and the UNIQUE constraint used by its conflict path.
-- Its own body remains externally attested by the raw-catalog release authority.
CREATE FUNCTION private.koaryu_release_operational_manifest_v6()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
WITH repaired_function_state AS (
    SELECT coalesce(
             owner.rolname || ':' || language.lanname || ':' ||
             function.prosecdef::TEXT || ':' ||
             coalesce(array_to_string(function.proconfig, ','), '') || ':' ||
             encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') || ':' ||
             coalesce((
               SELECT string_agg(
                        coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                        coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                        acl.privilege_type || ':' || acl.is_grantable::TEXT,
                        ',' ORDER BY coalesce(grantor.rolname, 'PUBLIC'),
                                     coalesce(grantee.rolname, 'PUBLIC'),
                                     acl.privilege_type, acl.is_grantable
                      )
                 FROM aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
                 LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
                 LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
             ), ''),
             'MISSING'
           ) AS state
      FROM pg_proc function
      JOIN pg_roles owner ON owner.oid = function.proowner
      JOIN pg_language language ON language.oid = function.prolang
     WHERE function.oid = 'public.claim_operational_alert_delivery(text,text,uuid,integer)'::REGPROCEDURE
), conflict_constraint_state AS (
    SELECT coalesce(
             constraint_state.conname || ':' || constraint_state.contype::TEXT || ':' ||
             constraint_state.convalidated::TEXT || ':' ||
             encode(
               extensions.digest(
                 convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'),
                 'sha256'
               ),
               'hex'
             ),
             'MISSING'
           ) AS state
      FROM pg_constraint constraint_state
     WHERE constraint_state.conrelid = 'public.operational_alert_delivery_outcomes'::REGCLASS
       AND constraint_state.conname = 'operational_alert_delivery_outcomes_attempt_id_key'
), manifest_rows(identity, state) AS (
    SELECT 'prior_v5_surface', private.koaryu_release_operational_manifest_v5()
    UNION ALL
    SELECT 'repaired_claim_function', coalesce((SELECT state FROM repaired_function_state), 'MISSING')
    UNION ALL
    SELECT 'attempt_id_conflict_constraint', coalesce((SELECT state FROM conflict_constraint_state), 'MISSING')
)
SELECT encode(
         extensions.digest(
           convert_to(string_agg(identity || '=' || state, '|' ORDER BY identity), 'UTF8'),
           'sha256'
         ),
         'hex'
       )
  FROM manifest_rows
$$;

REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v6()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_legacy RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_legacy
      FROM public.koaryu_release_schema_preflight();

    -- V6 preserves every independent V1 check except the stale history and
    -- pre-V3 function manifest signals superseded by the exact manifests.
    v_failures := array_remove(
        array_remove(v_legacy.security_failures, 'migration_history'),
        'billing_alert_function_manifest'
    );

    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version) FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version)
                 FILTER (WHERE version < '20260727100000'))
      INTO v_count, v_head, v_pending, v_baseline
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 99
       OR v_head <> '20260801123112'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000',
           '20260801091000',
           '20260801092000',
           '20260801093000',
           '20260801094000',
           '20260801105313',
           '20260801112153',
           '20260801115044',
           '20260801123112'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v6');
    END IF;

    IF private.koaryu_release_operational_manifest_v6()
       <> '22aacba34bb9608d0926fa4749e74a3ccd994b075d8d5bff4fc7aa05e6cfaa8d' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v6');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v6';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V6 drift signal for the alert-delivery lint repair while preserving V5 column ACL coverage. Release authority remains the repository-pinned operator raw-catalog verifier; hosted exposed-schema and schema ACL readback are separate operator gates.';
