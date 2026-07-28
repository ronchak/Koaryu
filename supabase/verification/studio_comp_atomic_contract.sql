BEGIN;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.clear_studio_comp_for_billing_event(uuid, bigint)'::REGPROCEDURE;
BEGIN
    IF to_regprocedure('public.clear_studio_comp_for_billing_event(uuid, bigint)') IS NULL THEN
        RAISE EXCEPTION 'Missing billing-event comp ordering RPC.';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute the billing-event comp ordering RPC.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not clear comps from billing events.';
    END IF;
END $$;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)'::REGPROCEDURE;
BEGIN
    IF to_regprocedure('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)') IS NULL THEN
        RAISE EXCEPTION 'Missing repaired public.set_studio_comp_atomic RPC.';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.set_studio_comp_atomic.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.set_studio_comp_atomic.';
    END IF;
END $$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    -- Keep a fractional database timestamp so the contract proves that a Stripe
    -- timestamp at the start of the same second still wins the overlap.
    v_granted_at TIMESTAMPTZ := date_trunc('second', now()) + interval '0.9 seconds';
    v_cleared BOOLEAN;
    v_row public.studio_subscriptions%ROWTYPE;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'comp-event-order-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Comp Event Ordering Smoke',
        'comp-event-order-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        metadata
    )
    VALUES (
        v_studio,
        'incomplete',
        true,
        jsonb_build_object(
            'comp',
            jsonb_build_object('state', 'granted', 'at', v_granted_at)
        )
    );

    SELECT public.clear_studio_comp_for_billing_event(
        v_studio,
        floor(extract(epoch FROM v_granted_at))::BIGINT - 1
    )
      INTO v_cleared;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_cleared OR NOT v_row.comped THEN
        RAISE EXCEPTION 'An event strictly older than the grant cleared the comp.';
    END IF;

    SELECT public.clear_studio_comp_for_billing_event(
        v_studio,
        floor(extract(epoch FROM v_granted_at))::BIGINT
    )
      INTO v_cleared;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF NOT v_cleared OR v_row.comped THEN
        RAISE EXCEPTION 'A same-second event did not clear the comp.';
    END IF;

    UPDATE public.studio_subscriptions
       SET comped = true
     WHERE studio_id = v_studio;

    SELECT public.clear_studio_comp_for_billing_event(
        v_studio,
        floor(extract(epoch FROM v_granted_at))::BIGINT + 1
    )
      INTO v_cleared;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF NOT v_cleared OR v_row.comped THEN
        RAISE EXCEPTION 'An event newer than the grant did not clear the comp.';
    END IF;

    UPDATE public.studio_subscriptions
       SET comped = true
     WHERE studio_id = v_studio;

    SELECT public.clear_studio_comp_for_billing_event(
        v_studio,
        9223372036854775807
    )
      INTO v_cleared;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_cleared OR NOT v_row.comped THEN
        RAISE EXCEPTION 'An out-of-range event timestamp did not preserve the comp.';
    END IF;
END $$;

-- Exercise provenance shapes against PostgreSQL itself. These timestamp casts
-- and JSON operators have diverged from the backend fake before, so a Python
-- test alone is not an adequate contract for this boundary.
DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID;
    v_case RECORD;
    v_cleared BOOLEAN;
    v_row public.studio_subscriptions%ROWTYPE;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'comp-invalid-provenance-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    FOR v_case IN
        SELECT *
          FROM (
              VALUES
                  (
                      'absent-at',
                      '{"comp":{"state":"granted"}}'::JSONB,
                      false
                  ),
                  (
                      'unparseable-at',
                      '{"comp":{"state":"granted","at":"not-a-timestamp"}}'::JSONB,
                      false
                  ),
                  (
                      'infinite-at',
                      '{"comp":{"state":"granted","at":"infinity"}}'::JSONB,
                      false
                  ),
                  (
                      'negative-infinite-at',
                      '{"comp":{"state":"granted","at":"-infinity"}}'::JSONB,
                      false
                  ),
                  (
                      'timezone-overflow-at',
                      '{"comp":{"state":"granted","at":"2026-07-27T00:00:00+25:00"}}'::JSONB,
                      false
                  ),
                  (
                      'postgres-timezone-boundary-overflow-at',
                      '{"comp":{"state":"granted","at":"2026-07-27T00:00:00+16:00"}}'::JSONB,
                      false
                  ),
                  (
                      'non-object-comp',
                      '{"comp":["legacy"]}'::JSONB,
                      true
                  )
          ) AS provenance_cases(case_name, metadata, should_clear)
    LOOP
        v_studio := gen_random_uuid();

        INSERT INTO public.studios (id, name, slug, owner_id)
        VALUES (
            v_studio,
            'Comp Invalid Provenance ' || v_case.case_name,
            'comp-invalid-' || v_case.case_name || '-'
                || replace(v_studio::TEXT, '-', ''),
            v_owner
        );

        INSERT INTO public.studio_subscriptions (
            studio_id,
            status,
            comped,
            metadata
        )
        VALUES (
            v_studio,
            'incomplete',
            true,
            v_case.metadata
        );

        SELECT public.clear_studio_comp_for_billing_event(
            v_studio,
            1785153600
        )
          INTO v_cleared;

        SELECT *
          INTO v_row
          FROM public.studio_subscriptions
         WHERE studio_id = v_studio;

        IF v_cleared IS DISTINCT FROM v_case.should_clear
           OR v_row.comped IS DISTINCT FROM NOT v_case.should_clear THEN
            RAISE EXCEPTION
                'Unexpected comp clear result for provenance case %.',
                v_case.case_name;
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_row public.studio_subscriptions%ROWTYPE;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'comp-metadata-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Comp Metadata Smoke',
        'comp-metadata-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        metadata
    )
    VALUES (
        v_studio,
        'incomplete',
        false,
        '{
            "core_subscription_event_created": 123,
            "comp": {"state": "revoked", "source": "comp_studio_cli"}
        }'::JSONB
    );

    PERFORM public.set_studio_comp_atomic(
        v_studio,
        true,
        'Metadata verification',
        v_owner,
        'owner@example.invalid',
        false
    );

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_row.metadata->>'core_subscription_event_created' <> '123'
       OR v_row.metadata->'comp'->>'state' <> 'granted' THEN
        RAISE EXCEPTION 'Comp mutation did not preserve existing billing metadata.';
    END IF;

    UPDATE public.studio_subscriptions
       SET metadata = '{
           "core_subscription_event_created": 456,
           "comp": {"state": "revoked", "source": "comp_studio_cli"}
       }'::JSONB
     WHERE studio_id = v_studio;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_row.metadata->>'core_subscription_event_created' <> '456'
       OR v_row.metadata->'comp'->>'state' <> 'granted' THEN
        RAISE EXCEPTION 'Stale billing metadata replacement erased comp provenance.';
    END IF;
END $$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_flag_false_studio UUID := gen_random_uuid();
    v_blank_id_studio UUID := gen_random_uuid();
    v_provider_studio UUID := gen_random_uuid();
    v_live_studio UUID := gen_random_uuid();
    v_canceled_studio UUID := gen_random_uuid();
    v_result RECORD;
    v_row public.studio_subscriptions%ROWTYPE;
    v_refused BOOLEAN := false;
    v_audit_count INTEGER;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'comp-revoke-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (
            v_flag_false_studio,
            'Comp Flag False Revoke Smoke',
            'comp-flag-false-' || replace(v_flag_false_studio::TEXT, '-', ''),
            v_owner
        ),
        (
            v_blank_id_studio,
            'Comp Blank Id Revoke Smoke',
            'comp-blank-id-' || replace(v_blank_id_studio::TEXT, '-', ''),
            v_owner
        ),
        (
            v_provider_studio,
            'Comp Provider Revoke Smoke',
            'comp-provider-' || replace(v_provider_studio::TEXT, '-', ''),
            v_owner
        ),
        (
            v_live_studio,
            'Comp Live Grant Smoke',
            'comp-live-' || replace(v_live_studio::TEXT, '-', ''),
            v_owner
        ),
        (
            v_canceled_studio,
            'Comp Canceled Grant Smoke',
            'comp-canceled-' || replace(v_canceled_studio::TEXT, '-', ''),
            v_owner
        );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        stripe_subscription_id,
        metadata
    )
    VALUES
        (v_flag_false_studio, 'comped', false, NULL, '{"case":"flag_false"}'::JSONB),
        (v_blank_id_studio, 'comped', true, '   ', '{"case":"blank_id"}'::JSONB),
        (v_provider_studio, 'comped', true, 'sub_legacy', '{"case":"provider"}'::JSONB),
        (v_live_studio, 'active', false, 'sub_live', '{"case":"live"}'::JSONB),
        (v_canceled_studio, 'canceled', false, 'sub_canceled', '{"case":"canceled"}'::JSONB);

    SELECT *
      INTO v_result
      FROM public.set_studio_comp_atomic(
          v_flag_false_studio,
          false,
          'Normalize already-cleared flag',
          v_owner,
          'owner@example.invalid',
          false
      );

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_flag_false_studio;

    IF v_result.outcome <> 'applied'
       OR NOT v_result.status_normalized
       OR v_row.comped
       OR v_row.status <> 'incomplete'
       OR v_row.metadata->'comp'->>'state' <> 'revoked' THEN
        RAISE EXCEPTION 'Revoke did not normalize status when comped was already false.';
    END IF;

    SELECT COUNT(*)
      INTO v_audit_count
      FROM public.audit_logs
     WHERE studio_id = v_flag_false_studio
       AND action = 'platform_comp.revoked';

    IF v_audit_count <> 1 THEN
        RAISE EXCEPTION 'Status-only legacy normalization did not write one revoke audit.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.set_studio_comp_atomic(
          v_blank_id_studio,
          false,
          'Normalize blank provider id',
          v_owner,
          'owner@example.invalid',
          false
      );

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_blank_id_studio;

    IF v_result.outcome <> 'applied'
       OR NOT v_result.status_normalized
       OR v_result.provider_status_preserved
       OR v_row.comped
       OR v_row.status <> 'incomplete' THEN
        RAISE EXCEPTION 'Whitespace-only subscription id was not treated as absent.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.set_studio_comp_atomic(
          v_provider_studio,
          false,
          'Preserve provider-owned status',
          v_owner,
          'owner@example.invalid',
          false
      );

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_provider_studio;

    IF v_result.outcome <> 'applied'
       OR v_result.status_normalized
       OR NOT v_result.provider_status_preserved
       OR v_row.comped
       OR v_row.status <> 'comped' THEN
        RAISE EXCEPTION 'Provider-linked legacy revoke did not preserve provider status.';
    END IF;

    BEGIN
        PERFORM public.set_studio_comp_atomic(
            v_live_studio,
            true,
            'Must refuse live billing',
            v_owner,
            'owner@example.invalid',
            false
        );
    EXCEPTION
        WHEN SQLSTATE 'P0C01' THEN
            v_refused := true;
    END;

    IF NOT v_refused THEN
        RAISE EXCEPTION 'Locked RPC did not refuse a live subscription without override.';
    END IF;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_live_studio;

    SELECT COUNT(*)
      INTO v_audit_count
      FROM public.audit_logs
     WHERE studio_id = v_live_studio
       AND action = 'platform_comp.granted';

    IF v_row.comped OR v_audit_count <> 0 THEN
        RAISE EXCEPTION 'Refused live-subscription grant changed state or wrote an audit.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.set_studio_comp_atomic(
          v_live_studio,
          true,
          'Explicitly allow live billing',
          v_owner,
          'owner@example.invalid',
          true
      );

    IF v_result.outcome <> 'applied' OR NOT v_result.comped THEN
        RAISE EXCEPTION 'Explicit live-subscription override did not allow the grant.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.set_studio_comp_atomic(
          v_canceled_studio,
          true,
          'Canceled subscription id is not live',
          v_owner,
          'owner@example.invalid',
          false
      );

    IF v_result.outcome <> 'applied' OR NOT v_result.comped THEN
        RAISE EXCEPTION 'Canceled subscription id was incorrectly treated as live billing.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.reject_comp_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.action IN ('platform_comp.granted', 'platform_comp.revoked') THEN
        RAISE EXCEPTION 'forced comp audit failure';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reject_comp_audit_for_rollback_check
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION pg_temp.reject_comp_audit();

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_failed BOOLEAN := false;
    v_row public.studio_subscriptions%ROWTYPE;
    v_audit_count INTEGER;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'comp-rollback-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Comp Rollback Smoke',
        'comp-rollback-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        metadata
    )
    VALUES (
        v_studio,
        'incomplete',
        false,
        '{"core_subscription_event_created":123}'::JSONB
    );

    BEGIN
        PERFORM public.set_studio_comp_atomic(
            v_studio,
            true,
            'Rollback verification',
            v_owner,
            'owner@example.invalid',
            false
        );
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM <> 'forced comp audit failure' THEN
                RAISE;
            END IF;
            v_failed := true;
    END;

    IF NOT v_failed THEN
        RAISE EXCEPTION 'The forced audit failure did not abort comp mutation.';
    END IF;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_row.comped
       OR v_row.status <> 'incomplete'
       OR v_row.metadata <> '{"core_subscription_event_created":123}'::JSONB THEN
        RAISE EXCEPTION 'Failed audit insert did not roll back the subscription update.';
    END IF;

    SELECT COUNT(*)
      INTO v_audit_count
      FROM public.audit_logs
     WHERE studio_id = v_studio
       AND action IN ('platform_comp.granted', 'platform_comp.revoked');

    IF v_audit_count <> 0 THEN
        RAISE EXCEPTION 'Failed atomic comp mutation left an audit row.';
    END IF;
END $$;

-- Disarm the forced-failure trigger. It is installed only for the rollback
-- check above, and anything appended after this point would otherwise have
-- its audit insert rejected too.
DROP TRIGGER reject_comp_audit_for_rollback_check ON public.audit_logs;

-- `metadata` is JSONB NOT NULL, but the JSON scalar `null` satisfies NOT NULL
-- and is not SQL NULL. COALESCE therefore does not catch it, and an unguarded
-- jsonb_set raises 'cannot set path in scalar', aborting the comp entirely for
-- that studio. Only a real database can show this; the Python fake coerces
-- falsey metadata to an object and cannot reproduce it.
DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_row public.studio_subscriptions%ROWTYPE;
BEGIN
    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    )
    VALUES (
        v_owner, 'authenticated', 'authenticated',
        'comp-jsonnull-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB, '{}'::JSONB, now(), now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (v_studio, 'Comp JSON Null', 'comp-json-null-' || replace(v_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.studio_subscriptions (studio_id, status, comped, metadata)
    VALUES (v_studio, 'incomplete', false, 'null'::JSONB);

    PERFORM public.set_studio_comp_atomic(
        v_studio, true, 'json null metadata', v_owner, NULL
    );

    SELECT * INTO v_row FROM public.studio_subscriptions WHERE studio_id = v_studio;

    IF NOT v_row.comped THEN
        RAISE EXCEPTION 'A comp on JSON-null metadata did not apply.';
    END IF;

    IF v_row.metadata->'comp'->>'state' IS DISTINCT FROM 'granted' THEN
        RAISE EXCEPTION 'A comp on JSON-null metadata recorded no provenance, so drift could not detect it later.';
    END IF;
END $$;

ROLLBACK;
