-- Import-owned row/setup outcomes and final audit completion. No historical backfill.
-- Register this migration in the same transaction.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v25()')),'UTF8'),'sha256'),'hex')
        IS DISTINCT FROM 'a7592ad492ea37622de05e925545a2212c1de306da27f033db0781a829743011' THEN
        RAISE EXCEPTION 'V45 requires the reviewed full V44 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v25();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 139
       OR v.migration_head IS DISTINCT FROM '20260910135133'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v44'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 55
       OR v.pending_versions[55] IS DISTINCT FROM '20260910135133' THEN
        RAISE EXCEPTION 'V45 requires a fully verified V44 predecessor.';
    END IF;
END;
$predecessor$;

ALTER TABLE public.student_import_runs
    ADD COLUMN receipts_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE private.student_import_receipts (
    import_run_id UUID NOT NULL REFERENCES public.student_import_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('student', 'program', 'ladder', 'rank')),
    key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 512),
    result_json JSONB NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (import_run_id, kind, key)
);
ALTER TABLE private.student_import_receipts OWNER TO postgres;
REVOKE ALL ON TABLE private.student_import_receipts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE private.student_import_receipts TO service_role;

-- Only this narrow helper needs Auth-owner privileges. It returns no Auth row data.
CREATE FUNCTION private.lock_student_import_actor(p_actor_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM 1 FROM auth.users WHERE id = p_actor_id FOR KEY SHARE;
    RETURN FOUND;
END;
$$;
ALTER FUNCTION private.lock_student_import_actor(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_student_import_actor(UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.lock_student_import_actor(UUID) TO service_role;

CREATE FUNCTION private.lock_student_import_run(p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT)
RETURNS public.student_import_runs
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v_run public.student_import_runs%ROWTYPE; v_actor_id UUID;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('koaryu.local-plan-clear:' || p_studio_id::TEXT, 0));
    SELECT * INTO v_run FROM public.student_import_runs
    WHERE id = p_import_run_id AND studio_id = p_studio_id AND operation = 'students_csv_execute';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student import worker claim is no longer active.' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'student_import:' || v_run.studio_id::TEXT || ':' || v_run.operation || ':' || v_run.idempotency_key, 0));
    -- Re-read after the same advisory key used by claim, before taking parent/row locks.
    SELECT actor_id INTO v_actor_id FROM public.student_import_runs
    WHERE id = p_import_run_id AND studio_id = p_studio_id;
    IF NOT private.lock_student_import_actor(v_actor_id) THEN
        RAISE EXCEPTION 'Student import actor is unavailable.' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM public.studios WHERE id = p_studio_id FOR KEY SHARE;
    SELECT * INTO v_run FROM public.student_import_runs
    WHERE id = p_import_run_id AND studio_id = p_studio_id AND operation = 'students_csv_execute'
      AND status = 'processing' AND processing_token = p_processing_token AND actor_id = v_actor_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student import worker claim is no longer active.' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_run;
END;
$$;
ALTER FUNCTION private.lock_student_import_run(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.lock_student_import_run(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.lock_student_import_run(UUID, UUID, TEXT) TO service_role;

CREATE FUNCTION private.claim_student_import_run_owned(
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation TEXT,
    p_idempotency_key TEXT,
    p_request_hash TEXT,
    p_processing_token TEXT,
    p_receipts_enabled BOOLEAN,
    p_stale_after_seconds INTEGER DEFAULT 45
)
RETURNS TABLE(claim_status TEXT, run_row JSONB)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
    v_now TIMESTAMPTZ;
    v_cutoff TIMESTAMPTZ;
    v_actor_id UUID;
    v_actor_locked BOOLEAN;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_receipts_enabled IS NULL THEN
        RAISE EXCEPTION 'Student import identity is required.' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('koaryu.local-plan-clear:' || p_studio_id::TEXT, 0));
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'student_import:' || p_studio_id::TEXT || ':' || COALESCE(p_operation, '') || ':' || COALESCE(p_idempotency_key, ''),
            0
        )
    );

    -- The existing claim key also stabilizes the previous actor across reclaim.
    SELECT * INTO v_run FROM public.student_import_runs
    WHERE studio_id = p_studio_id AND operation = p_operation AND idempotency_key = p_idempotency_key;
    FOR v_actor_id IN
        SELECT DISTINCT actor_id FROM unnest(ARRAY[p_actor_id, v_run.actor_id]) AS actors(actor_id)
        WHERE actor_id IS NOT NULL ORDER BY actor_id
    LOOP
        v_actor_locked := private.lock_student_import_actor(v_actor_id);
        IF v_actor_id = p_actor_id AND NOT v_actor_locked THEN
            RAISE EXCEPTION 'Student import actor is unavailable.' USING ERRCODE = '23503';
        END IF;
    END LOOP;
    PERFORM 1 FROM public.studios WHERE id = p_studio_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student import studio is unavailable.' USING ERRCODE = '23503';
    END IF;
    SELECT * INTO v_run FROM public.student_import_runs
    WHERE studio_id = p_studio_id AND operation = p_operation AND idempotency_key = p_idempotency_key
    FOR UPDATE;
    v_now := clock_timestamp();
    v_cutoff := v_now - (GREATEST(COALESCE(p_stale_after_seconds, 1), 1) * INTERVAL '1 second');

    IF NOT FOUND THEN
        IF NOT p_receipts_enabled THEN
            RETURN QUERY SELECT 'unsupported_run'::TEXT, NULL::JSONB;
            RETURN;
        END IF;
        INSERT INTO public.student_import_runs (
            studio_id,
            actor_id,
            operation,
            idempotency_key,
            request_hash,
            status,
            receipts_enabled,
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
            p_receipts_enabled,
            v_now,
            NULL,
            NULL,
            p_processing_token,
            v_now
        )
        RETURNING * INTO v_run;

        RETURN QUERY SELECT 'claimed'::TEXT, to_jsonb(v_run) ||
            CASE WHEN p_receipts_enabled THEN jsonb_build_object('receipts', '[]'::JSONB) ELSE '{}'::JSONB END;
        RETURN;
    END IF;

    IF v_run.request_hash IS DISTINCT FROM p_request_hash THEN
        RETURN QUERY SELECT 'hash_mismatch'::TEXT, to_jsonb(v_run);
        RETURN;
    END IF;

    IF v_run.status = 'completed' AND v_run.result_json IS NOT NULL THEN
        RETURN QUERY SELECT 'completed'::TEXT, to_jsonb(v_run);
        RETURN;
    END IF;

    IF NOT v_run.receipts_enabled OR NOT p_receipts_enabled THEN
        RETURN QUERY SELECT 'unsupported_run'::TEXT, to_jsonb(v_run);
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

    RETURN QUERY SELECT 'claimed'::TEXT, to_jsonb(v_run) ||
        CASE WHEN p_receipts_enabled THEN jsonb_build_object('receipts', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('kind', receipt.kind, 'key', receipt.key, 'result', receipt.result_json)
                ORDER BY receipt.kind, receipt.key)
            FROM private.student_import_receipts AS receipt WHERE receipt.import_run_id = v_run.id
        ), '[]'::JSONB)) ELSE '{}'::JSONB END;
END;
$$;


ALTER FUNCTION private.claim_student_import_run_owned(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_student_import_run_owned(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.claim_student_import_run_owned(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_student_import_run(
    p_studio_id UUID, p_actor_id UUID, p_operation TEXT, p_idempotency_key TEXT,
    p_request_hash TEXT, p_processing_token TEXT, p_stale_after_seconds INTEGER DEFAULT 45
)
RETURNS TABLE(claim_status TEXT, run_row JSONB)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN QUERY SELECT * FROM private.claim_student_import_run_owned(p_studio_id, p_actor_id, p_operation,
        p_idempotency_key, p_request_hash, p_processing_token, FALSE, p_stale_after_seconds);
END;
$$;
ALTER FUNCTION public.claim_student_import_run(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_student_import_run(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_student_import_run(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_student_import_run_v2(
    p_studio_id UUID, p_actor_id UUID, p_operation TEXT, p_idempotency_key TEXT,
    p_request_hash TEXT, p_processing_token TEXT, p_stale_after_seconds INTEGER DEFAULT 45
)
RETURNS TABLE(claim_status TEXT, run_row JSONB)
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
    SELECT * FROM private.claim_student_import_run_owned(p_studio_id, p_actor_id, p_operation,
        p_idempotency_key, p_request_hash, p_processing_token, TRUE, p_stale_after_seconds);
$$;
ALTER FUNCTION public.claim_student_import_run_v2(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_student_import_run_v2(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_student_import_run_v2(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION private.import_student_row_atomic(
    p_student JSONB,
    p_studio_id UUID,
    p_import_run_id UUID,
    p_processing_token TEXT,
    p_row_number INTEGER,
    p_guardian_name TEXT DEFAULT NULL,
    p_guardian_email TEXT DEFAULT NULL,
    p_guardian_phone TEXT DEFAULT NULL,
    p_guardian_relation TEXT DEFAULT NULL,
    p_program_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(student_id UUID, guardian_imported BOOLEAN)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_student public.students%ROWTYPE;
    v_student_id UUID;
    v_program_ids UUID[];
    v_program_id UUID;
    v_current_belt_rank_id UUID;
    v_rank_program_id UUID;
    v_membership_id UUID;
    v_membership_started_at DATE;
    v_guardian_name TEXT := NULLIF(btrim(COALESCE(p_guardian_name, '')), '');
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
    v_guardian_id UUID;
    v_guardian_link_id UUID;
    v_run public.student_import_runs%ROWTYPE;
    v_receipt JSONB;
    v_outcome JSONB;
BEGIN
    IF p_student IS NULL OR jsonb_typeof(p_student) <> 'object' THEN
        RAISE EXCEPTION 'Student import payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    IF p_import_run_id IS NULL OR p_row_number IS NULL THEN
        RAISE EXCEPTION 'Student import run id and row number are required.'
            USING ERRCODE = '22023';
    END IF;

    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'Student import processing token is required.'
            USING ERRCODE = '22023';
    END IF;

    v_student.id := NULLIF(p_student->>'id', '')::UUID;
    v_student.studio_id := NULLIF(p_student->>'studio_id', '')::UUID;
    IF v_student.id IS NULL THEN
        RAISE EXCEPTION 'Student import payload is missing id.'
            USING ERRCODE = '22023';
    END IF;

    IF v_student.studio_id IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Student import payload studio does not match request studio.'
            USING ERRCODE = 'P0001';
    END IF;

    v_run := private.lock_student_import_run(p_studio_id, p_import_run_id, p_processing_token);
    IF NOT v_run.receipts_enabled THEN
        RAISE EXCEPTION 'This unfinished import has no safe retry receipts.' USING ERRCODE = '22023';
    END IF;
    SELECT receipt.result_json INTO v_receipt FROM private.student_import_receipts AS receipt
    WHERE receipt.import_run_id = p_import_run_id AND receipt.kind = 'student'
      AND receipt.key = p_row_number::TEXT;
    IF FOUND THEN
        IF v_receipt->>'student_id' IS NULL
           OR jsonb_typeof(v_receipt->'guardian_imported') IS DISTINCT FROM 'boolean'
           OR (v_receipt->>'student_id')::UUID IS DISTINCT FROM v_student.id THEN
            RAISE EXCEPTION 'Student import completion receipt does not match this row.' USING ERRCODE = 'P0001';
        END IF;
        student_id := (v_receipt->>'student_id')::UUID;
        guardian_imported := (v_receipt->>'guardian_imported')::BOOLEAN;
        RETURN NEXT;
        RETURN;
    END IF;
    -- Internal diagnostic facts are not student columns. Keep only the original
    -- successful-row outcome needed to rebuild the existing import response.
    v_outcome := p_student->'_import_outcome';
    IF p_row_number < 2 OR p_row_number > 10001
       OR jsonb_typeof(v_outcome) IS DISTINCT FROM 'object'
       OR (v_outcome->>'row_number')::INTEGER IS DISTINCT FROM p_row_number
       OR v_outcome->'is_valid' IS DISTINCT FROM 'true'::JSONB
       OR jsonb_typeof(v_outcome->'issues') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_outcome->'data') IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_outcome->'imported_without_belt') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'Student import completion facts are required.' USING ERRCODE = '22023';
    END IF;

    v_student.legal_first_name := NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '');
    v_student.legal_last_name := NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '');
    v_student.preferred_name := NULLIF(p_student->>'preferred_name', '');
    v_student.date_of_birth := NULLIF(p_student->>'date_of_birth', '')::DATE;
    v_student.is_minor := COALESCE((p_student->>'is_minor')::BOOLEAN, false);
    v_student.email := NULLIF(p_student->>'email', '');
    v_student.phone := NULLIF(p_student->>'phone', '');
    v_student.address_line1 := NULLIF(p_student->>'address_line1', '');
    v_student.address_city := NULLIF(p_student->>'address_city', '');
    v_student.address_state := NULLIF(p_student->>'address_state', '');
    v_student.address_zip := NULLIF(p_student->>'address_zip', '');
    v_student.emergency_contact_name := NULLIF(p_student->>'emergency_contact_name', '');
    v_student.emergency_contact_phone := NULLIF(p_student->>'emergency_contact_phone', '');
    v_student.emergency_contact_relation := NULLIF(p_student->>'emergency_contact_relation', '');
    v_student.status := COALESCE(NULLIF(p_student->>'status', ''), 'active');
    v_student.membership_start_date := NULLIF(p_student->>'membership_start_date', '')::DATE;
    v_student.current_belt_rank_id := NULLIF(p_student->>'current_belt_rank_id', '')::UUID;
    v_student.notes := NULLIF(p_student->>'notes', '');
    v_student.hold_start_date := NULLIF(p_student->>'hold_start_date', '')::DATE;
    v_student.hold_end_date := NULLIF(p_student->>'hold_end_date', '')::DATE;

    SELECT COALESCE(array_agg(tag.value), ARRAY[]::TEXT[])
      INTO v_student.tags
      FROM jsonb_array_elements_text(
          CASE
              WHEN jsonb_typeof(p_student->'tags') = 'array' THEN p_student->'tags'
              ELSE '[]'::JSONB
          END
      ) AS tag(value);

    IF v_student.legal_first_name IS NULL OR v_student.legal_last_name IS NULL THEN
        RAISE EXCEPTION 'Student import payload is missing required name fields.'
            USING ERRCODE = '22023';
    END IF;

    v_program_ids := COALESCE(p_program_ids, ARRAY[]::UUID[]);
    IF cardinality(v_program_ids) IS NULL OR cardinality(v_program_ids) = 0 THEN
        RAISE EXCEPTION 'Student import payload is missing program memberships.'
            USING ERRCODE = '22023';
    END IF;

    FOREACH v_program_id IN ARRAY v_program_ids LOOP
        IF v_program_id IS NULL THEN
            RAISE EXCEPTION 'Student import payload includes an empty program id.'
                USING ERRCODE = '22023';
        END IF;

        PERFORM 1
          FROM public.programs
         WHERE id = v_program_id
           AND studio_id = p_studio_id
           AND archived_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Import program does not belong to this studio or is archived.'
                USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    v_student.program_id := v_program_ids[1];
    v_current_belt_rank_id := v_student.current_belt_rank_id;
    v_membership_started_at := v_student.membership_start_date;

    IF v_current_belt_rank_id IS NOT NULL THEN
        SELECT ladder.program_id
          INTO v_rank_program_id
          FROM public.belt_ranks AS belt_rank
          JOIN public.belt_ladders AS ladder ON ladder.id = belt_rank.ladder_id
         WHERE belt_rank.id = v_current_belt_rank_id
           AND belt_rank.studio_id = p_studio_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Current belt rank does not belong to this studio.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        preferred_name,
        date_of_birth,
        is_minor,
        email,
        phone,
        address_line1,
        address_city,
        address_state,
        address_zip,
        emergency_contact_name,
        emergency_contact_phone,
        emergency_contact_relation,
        status,
        membership_start_date,
        program_id,
        current_belt_rank_id,
        notes,
        tags,
        hold_start_date,
        hold_end_date
    )
    VALUES (
        v_student.id,
        p_studio_id,
        v_student.legal_first_name,
        v_student.legal_last_name,
        v_student.preferred_name,
        v_student.date_of_birth,
        v_student.is_minor,
        v_student.email,
        v_student.phone,
        v_student.address_line1,
        v_student.address_city,
        v_student.address_state,
        v_student.address_zip,
        v_student.emergency_contact_name,
        v_student.emergency_contact_phone,
        v_student.emergency_contact_relation,
        v_student.status,
        v_student.membership_start_date,
        v_student.program_id,
        v_student.current_belt_rank_id,
        v_student.notes,
        v_student.tags,
        v_student.hold_start_date,
        v_student.hold_end_date
    );

    v_student_id := v_student.id;

    FOREACH v_program_id IN ARRAY v_program_ids LOOP
        SELECT membership.id
          INTO v_membership_id
          FROM public.student_program_memberships AS membership
         WHERE membership.student_id = v_student_id
           AND membership.studio_id = p_studio_id
           AND membership.program_id = v_program_id
           AND membership.ended_at IS NULL
         FOR UPDATE;

        IF FOUND THEN
            UPDATE public.student_program_memberships AS membership
               SET status = 'active',
                   ended_at = NULL,
                   started_at = COALESCE(v_membership_started_at, started_at),
                   current_belt_rank_id = CASE
                       WHEN v_current_belt_rank_id IS NOT NULL
                            AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                       THEN v_current_belt_rank_id
                       ELSE NULL
                   END
             WHERE membership.id = v_membership_id;
        ELSE
            INSERT INTO public.student_program_memberships (
                studio_id,
                student_id,
                program_id,
                status,
                started_at,
                current_belt_rank_id
            )
            VALUES (
                p_studio_id,
                v_student_id,
                v_program_id,
                'active',
                v_membership_started_at,
                CASE
                    WHEN v_current_belt_rank_id IS NOT NULL
                         AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                    THEN v_current_belt_rank_id
                    ELSE NULL
                END
            );
        END IF;
    END LOOP;

    UPDATE public.students
       SET program_id = v_program_ids[1],
           current_belt_rank_id = v_current_belt_rank_id
     WHERE id = v_student_id
       AND studio_id = p_studio_id;

    student_id := v_student_id;
    guardian_imported := false;
    IF v_guardian_name IS NOT NULL THEN
        v_guardian_first_name := split_part(v_guardian_name, ' ', 1);
        v_guardian_last_name := NULLIF(btrim(substr(v_guardian_name, length(v_guardian_first_name) + 1)), '');
        v_guardian_id := private.deterministic_import_uuid(
            p_import_run_id,
            'guardian-row:' || p_row_number::TEXT
        );
        v_guardian_link_id := private.deterministic_import_uuid(
            p_import_run_id,
            'student-guardian-link:' || v_student_id::TEXT || ':' || v_guardian_id::TEXT
        );

        INSERT INTO public.guardians (
            id,
            studio_id,
            first_name,
            last_name,
            email,
            phone,
            relation,
            is_primary_contact
        )
        VALUES (
            v_guardian_id,
            p_studio_id,
            v_guardian_first_name,
            COALESCE(v_guardian_last_name, ''),
            NULLIF(p_guardian_email, ''),
            NULLIF(p_guardian_phone, ''),
            NULLIF(p_guardian_relation, ''),
            true
        );

        INSERT INTO public.student_guardians (
            id,
            student_id,
            guardian_id
        )
        VALUES (
            v_guardian_link_id,
            v_student_id,
            v_guardian_id
        );

        guardian_imported := TRUE;
    END IF;

    UPDATE public.students student
    SET current_belt_rank_id = membership.current_belt_rank_id,
        updated_at = NOW()
    FROM public.student_program_memberships membership
    WHERE student.id = v_student_id
      AND student.studio_id = p_studio_id
      AND membership.student_id = student.id
      AND membership.studio_id = student.studio_id
      AND membership.program_id = student.program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

    INSERT INTO private.student_import_receipts(import_run_id, kind, key, result_json)
    VALUES (p_import_run_id, 'student', p_row_number::TEXT,
        jsonb_build_object('student_id', v_student_id, 'guardian_imported', guardian_imported,
            'outcome', v_outcome));

    UPDATE public.student_import_runs SET processing_started_at = clock_timestamp() WHERE id = p_import_run_id;
    RETURN NEXT;
END;
$$;

ALTER FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) TO service_role;

CREATE OR REPLACE FUNCTION public.import_student_row_atomic(
    p_student JSONB, p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT,
    p_row_number INTEGER, p_guardian_name TEXT DEFAULT NULL, p_guardian_email TEXT DEFAULT NULL,
    p_guardian_phone TEXT DEFAULT NULL, p_guardian_relation TEXT DEFAULT NULL, p_program_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(student_id UUID, guardian_imported BOOLEAN)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, private AS $$
BEGIN
    RETURN QUERY SELECT * FROM private.import_student_row_atomic(p_student, p_studio_id, p_import_run_id,
        p_processing_token, p_row_number, p_guardian_name, p_guardian_email, p_guardian_phone,
        p_guardian_relation, p_program_ids);
END;
$$;
ALTER FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) TO service_role;

CREATE FUNCTION public.prepare_student_import_program_v1(
    p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT,
    p_key TEXT, p_program_id UUID, p_name TEXT, p_ladder_id UUID,
    p_unassigned BOOLEAN DEFAULT FALSE, p_create_program BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
    v_program public.programs%ROWTYPE;
    v_result JSONB;
    v_created BOOLEAN := FALSE;
    v_ladder_id UUID;
    v_warning TEXT;
BEGIN
    v_run := private.lock_student_import_run(p_studio_id, p_import_run_id, p_processing_token);
    IF NOT v_run.receipts_enabled THEN
        RAISE EXCEPTION 'This import has no setup receipts.' USING ERRCODE = '22023';
    END IF;
    IF p_key IS NULL OR char_length(p_key) NOT BETWEEN 1 AND 512 THEN
        RAISE EXCEPTION 'An import program key is required.' USING ERRCODE = '22023';
    END IF;
    SELECT result_json INTO v_result FROM private.student_import_receipts
    WHERE import_run_id = p_import_run_id AND kind = 'program' AND key = p_key;
    IF FOUND THEN
        RETURN v_result;
    END IF;
    IF p_program_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' OR p_unassigned IS NULL OR p_create_program IS NULL
       OR (p_unassigned AND p_name <> 'Unassigned')
       OR (p_create_program AND NOT p_unassigned AND p_ladder_id IS NULL) THEN
        RAISE EXCEPTION 'Import program details are incomplete.' USING ERRCODE = '22023';
    END IF;

    IF NOT p_create_program THEN
        SELECT * INTO v_program FROM public.programs
        WHERE id = p_program_id AND studio_id = p_studio_id AND archived_at IS NULL
        FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'The selected import program is unavailable.' USING ERRCODE = '23503';
        END IF;
    ELSE
        -- Python owns CSV normalization. Creation may reuse an exact active-name
        -- conflict; an explicitly selected identity never falls back to a name.
        SELECT * INTO v_program FROM public.programs
        WHERE studio_id = p_studio_id AND lower(name) = lower(btrim(p_name)) AND archived_at IS NULL
        FOR SHARE;
    END IF;
    IF v_program.id IS NULL THEN
        INSERT INTO public.programs(id, studio_id, name, description, color_hex, sort_order, is_system)
        VALUES (p_program_id, p_studio_id, btrim(p_name),
            CASE WHEN p_unassigned THEN 'Students awaiting program assignment.' ELSE 'Program created from student import.' END,
            CASE WHEN p_unassigned THEN '#94A3B8' ELSE '#64748B' END,
            CASE WHEN p_unassigned THEN 9999 ELSE
                (SELECT count(*)::INTEGER * 10 FROM public.programs WHERE studio_id = p_studio_id) END,
            p_unassigned)
        ON CONFLICT (studio_id, lower(name)) WHERE archived_at IS NULL DO NOTHING
        RETURNING * INTO v_program;
        v_created := FOUND;
        IF NOT v_created THEN
            SELECT * INTO v_program FROM public.programs
            WHERE studio_id = p_studio_id AND lower(name) = lower(btrim(p_name)) AND archived_at IS NULL
            FOR SHARE;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'The import program changed during setup. Retry the same import.' USING ERRCODE = '40001';
            END IF;
        END IF;
    END IF;

    -- Only a program created by this transaction receives its default ladder.
    -- Existing programs and unrelated unscoped ladders are never repaired here.
    IF v_created AND NOT p_unassigned THEN
        INSERT INTO public.belt_ladders(id, studio_id, name, program_id, sub_rank_term)
        VALUES (p_ladder_id, p_studio_id, v_program.name, v_program.id, 'Stripe')
        RETURNING id INTO v_ladder_id;
        BEGIN
            INSERT INTO public.audit_logs(studio_id, actor_id, action, entity_type, entity_id, metadata)
            VALUES (p_studio_id, v_run.actor_id, 'programs.created_from_import', 'program', NULL,
                jsonb_build_object('names', jsonb_build_array(v_program.name)));
        EXCEPTION WHEN OTHERS THEN
            v_warning := 'Programs were created, but the import audit log could not be written.';
        END;
    END IF;
    v_result := jsonb_build_object('program_id', v_program.id, 'name', v_program.name,
        'created', v_created AND NOT p_unassigned, 'ladder_id', v_ladder_id, 'warning', v_warning);
    INSERT INTO private.student_import_receipts(import_run_id, kind, key, result_json)
    VALUES (p_import_run_id, 'program', p_key, v_result);
    UPDATE public.student_import_runs SET processing_started_at = clock_timestamp() WHERE id = p_import_run_id;
    RETURN v_result;
END;
$$;
ALTER FUNCTION public.prepare_student_import_program_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT, UUID, BOOLEAN, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_student_import_program_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT, UUID, BOOLEAN, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_student_import_program_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT, UUID, BOOLEAN, BOOLEAN)
    TO service_role;

CREATE FUNCTION public.prepare_student_import_belts_v1(
    p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT,
    p_program_id UUID, p_ladder_id UUID, p_ranks JSONB, p_create_ladder BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
    v_program public.programs%ROWTYPE;
    v_ladder public.belt_ladders%ROWTYPE;
    v_rank public.belt_ranks%ROWTYPE;
    v_request JSONB;
    v_receipt JSONB;
    v_ladder_receipt JSONB;
    v_results JSONB := '[]'::JSONB;
    v_existing_ladders UUID[];
    v_key TEXT;
    v_ladder_created BOOLEAN := FALSE;
    v_rank_created BOOLEAN;
    v_warning TEXT;
    v_next_order INTEGER;
BEGIN
    v_run := private.lock_student_import_run(p_studio_id, p_import_run_id, p_processing_token);
    IF NOT v_run.receipts_enabled THEN
        RAISE EXCEPTION 'This import has no setup receipts.' USING ERRCODE = '22023';
    END IF;
    IF p_program_id IS NULL OR p_ladder_id IS NULL
       OR p_create_ladder IS NULL
       OR jsonb_typeof(p_ranks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ranks) = 0 THEN
        RAISE EXCEPTION 'Import belt setup details are required.' USING ERRCODE = '22023';
    END IF;
    SELECT result_json INTO v_ladder_receipt FROM private.student_import_receipts
    WHERE import_run_id = p_import_run_id AND kind = 'ladder' AND key = p_program_id::TEXT;
    IF FOUND AND (v_ladder_receipt->>'ladder_id')::UUID IS DISTINCT FROM p_ladder_id THEN
        RAISE EXCEPTION 'This import already selected another ladder.' USING ERRCODE = '22023';
    END IF;
    -- Entirely confirmed requests are read-only even if staff later deleted the ladder.
    IF v_ladder_receipt IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_ranks) request
        WHERE NOT EXISTS (SELECT 1 FROM private.student_import_receipts receipt
            WHERE receipt.import_run_id = p_import_run_id AND receipt.kind = 'rank'
              AND receipt.key = p_ladder_id::TEXT || ':' || (request->>'key'))
    ) THEN
        SELECT jsonb_agg(receipt.result_json ORDER BY request.ordinality) INTO v_results
        FROM jsonb_array_elements(p_ranks) WITH ORDINALITY request(value, ordinality)
        JOIN private.student_import_receipts receipt ON receipt.import_run_id = p_import_run_id
            AND receipt.kind = 'rank' AND receipt.key = p_ladder_id::TEXT || ':' || (request.value->>'key');
        RETURN jsonb_build_object('ladder', v_ladder_receipt, 'ranks', v_results);
    END IF;

    -- Match the existing rank-plan writer and first-full-rank trigger: students
    -- before program/ladder/rank locks, with no broad studio UPDATE lock.
    PERFORM 1 FROM public.students student
    WHERE student.studio_id = p_studio_id AND EXISTS (
        SELECT 1 FROM public.student_program_memberships membership
        WHERE membership.studio_id = p_studio_id AND membership.student_id = student.id
          AND membership.program_id = p_program_id AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
    ) ORDER BY student.id FOR UPDATE;
    SELECT * INTO v_program FROM public.programs
    WHERE id = p_program_id AND studio_id = p_studio_id AND archived_at IS NULL
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The import program is unavailable.' USING ERRCODE = '23503';
    END IF;
    SELECT array_agg(id ORDER BY id) INTO v_existing_ladders FROM public.belt_ladders
    WHERE studio_id = p_studio_id AND program_id = p_program_id;
    IF cardinality(v_existing_ladders) > 1 THEN
        RAISE EXCEPTION 'The import program has multiple ladders.' USING ERRCODE = '22023';
    END IF;
    IF v_existing_ladders IS NULL THEN
        IF v_ladder_receipt IS NOT NULL OR NOT p_create_ladder THEN
            RAISE EXCEPTION 'The selected import ladder is unavailable.' USING ERRCODE = '23503';
        END IF;
        INSERT INTO public.belt_ladders(id, studio_id, name, program_id, sub_rank_term)
        VALUES (p_ladder_id, p_studio_id, v_program.name, p_program_id, 'Stripe') RETURNING * INTO v_ladder;
        v_ladder_created := TRUE;
    ELSE
        IF v_existing_ladders[1] IS DISTINCT FROM p_ladder_id THEN
            RAISE EXCEPTION 'The import ladder changed during setup. Retry the same import.' USING ERRCODE = '40001';
        END IF;
        SELECT * INTO v_ladder FROM public.belt_ladders
        WHERE id = p_ladder_id AND studio_id = p_studio_id AND program_id = p_program_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'The import ladder is unavailable.' USING ERRCODE = '23503';
        END IF;
    END IF;
    SELECT COALESCE(max(display_order) + 1, 0) INTO v_next_order FROM public.belt_ranks
    WHERE studio_id = p_studio_id AND ladder_id = p_ladder_id;
    FOR v_request IN SELECT value FROM jsonb_array_elements(p_ranks) LOOP
        IF jsonb_typeof(v_request) IS DISTINCT FROM 'object' OR NULLIF(v_request->>'key', '') IS NULL
           OR NULLIF(btrim(v_request->>'name'), '') IS NULL OR NULLIF(v_request->>'id', '') IS NULL THEN
            RAISE EXCEPTION 'Import rank details are incomplete.' USING ERRCODE = '22023';
        END IF;
        v_key := p_ladder_id::TEXT || ':' || (v_request->>'key');
        SELECT result_json INTO v_receipt FROM private.student_import_receipts
        WHERE import_run_id = p_import_run_id AND kind = 'rank' AND key = v_key;
        IF FOUND THEN
            CONTINUE;
        END IF;
        IF NULLIF(v_request->>'existing_id', '') IS NOT NULL THEN
            SELECT * INTO v_rank FROM public.belt_ranks
            WHERE id = (v_request->>'existing_id')::UUID AND studio_id = p_studio_id AND ladder_id = p_ladder_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'The selected import rank is unavailable.' USING ERRCODE = '23503';
            END IF;
        ELSE
            SELECT * INTO v_rank FROM public.belt_ranks
            WHERE studio_id = p_studio_id AND ladder_id = p_ladder_id
              AND lower(name) = lower(btrim(v_request->>'name')) ORDER BY display_order, id LIMIT 1;
        END IF;
        v_rank_created := NOT FOUND;
        v_warning := NULL;
        IF v_rank_created THEN
            INSERT INTO public.belt_ranks(id, studio_id, ladder_id, name, color_hex, display_order,
                min_classes, min_months, requires_approval, is_tip, tip_color_hex)
            VALUES ((v_request->>'id')::UUID, p_studio_id, p_ladder_id, btrim(v_request->>'name'),
                v_request->>'color_hex', v_next_order, 0, 0, TRUE, FALSE, NULL) RETURNING * INTO v_rank;
            v_next_order := v_next_order + 1;
            BEGIN
                INSERT INTO public.audit_logs(studio_id, actor_id, action, entity_type, entity_id, metadata)
                VALUES (p_studio_id, v_run.actor_id, 'belt_ranks.created_from_import', 'belt_rank', NULL,
                    jsonb_build_object('names', jsonb_build_array(v_rank.name || ' (' || v_ladder.name || ')')));
            EXCEPTION WHEN OTHERS THEN
                v_warning := 'Belt ranks were created, but the import audit log could not be written.';
            END;
        END IF;
        v_receipt := jsonb_build_object('rank_id', v_rank.id, 'name', v_rank.name,
            'ladder_id', p_ladder_id, 'ladder_name', v_ladder.name, 'created', v_rank_created, 'warning', v_warning);
        INSERT INTO private.student_import_receipts(import_run_id, kind, key, result_json)
        VALUES (p_import_run_id, 'rank', v_key, v_receipt);
    END LOOP;
    -- Setup diagnostics are frozen with the outcomes, including a failed audit.
    IF v_ladder_receipt IS NULL THEN
        v_warning := NULL;
        IF v_ladder_created THEN
            BEGIN
                INSERT INTO public.audit_logs(studio_id, actor_id, action, entity_type, entity_id, metadata)
                VALUES (p_studio_id, v_run.actor_id, 'belt_ladders.created_from_import', 'belt_ladder', NULL,
                    jsonb_build_object('names', jsonb_build_array(v_ladder.name)));
            EXCEPTION WHEN OTHERS THEN
                v_warning := 'Belt ladders were created, but the import audit log could not be written.';
            END;
        END IF;
        v_ladder_receipt := jsonb_build_object('ladder_id', p_ladder_id, 'name', v_ladder.name,
            'created', v_ladder_created, 'warning', v_warning);
        INSERT INTO private.student_import_receipts(import_run_id, kind, key, result_json)
        VALUES (p_import_run_id, 'ladder', p_program_id::TEXT, v_ladder_receipt);
    END IF;
    UPDATE public.student_import_runs SET processing_started_at = clock_timestamp() WHERE id = p_import_run_id;
    SELECT jsonb_agg(receipt.result_json ORDER BY request.ordinality) INTO v_results
    FROM jsonb_array_elements(p_ranks) WITH ORDINALITY request(value, ordinality)
    JOIN private.student_import_receipts receipt ON receipt.import_run_id = p_import_run_id
        AND receipt.kind = 'rank' AND receipt.key = p_ladder_id::TEXT || ':' || (request.value->>'key');
    RETURN jsonb_build_object('ladder', v_ladder_receipt, 'ranks', v_results);
END;
$$;
ALTER FUNCTION public.prepare_student_import_belts_v1(UUID, UUID, TEXT, UUID, UUID, JSONB, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_student_import_belts_v1(UUID, UUID, TEXT, UUID, UUID, JSONB, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_student_import_belts_v1(UUID, UUID, TEXT, UUID, UUID, JSONB, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_student_import_run(
    p_import_run_id UUID, p_processing_token TEXT, p_status TEXT,
    p_result_json JSONB DEFAULT NULL, p_error_message TEXT DEFAULT NULL
)
RETURNS TABLE(updated BOOLEAN, run_row JSONB)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
    v_run public.student_import_runs%ROWTYPE;
    v_result JSONB := p_result_json;
    v_warnings JSONB;
    v_imported INTEGER;
BEGIN
    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'processing token is required' USING ERRCODE = '22023';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
        RAISE EXCEPTION 'Invalid student import finish status: %', p_status;
    END IF;

    SELECT * INTO v_run FROM public.student_import_runs
    WHERE id = p_import_run_id AND processing_token = p_processing_token;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::JSONB;
        RETURN;
    END IF;
    IF p_status = 'completed' AND NOT v_run.receipts_enabled THEN
        RAISE EXCEPTION 'This unfinished import has no safe retry receipts.' USING ERRCODE = '22023';
    END IF;
    IF p_status = 'completed' THEN
        v_run := private.lock_student_import_run(v_run.studio_id, p_import_run_id, p_processing_token);
        IF jsonb_typeof(v_result) IS DISTINCT FROM 'object'
           OR jsonb_typeof(v_result->'non_critical_errors') IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION 'The import result is incomplete.' USING ERRCODE = '22023';
        END IF;
        SELECT count(*)::INTEGER INTO v_imported FROM private.student_import_receipts
        WHERE import_run_id = p_import_run_id AND kind = 'student';
        IF (v_result->>'imported_count')::INTEGER IS DISTINCT FROM v_imported THEN
            RAISE EXCEPTION 'The import result does not match its committed rows.' USING ERRCODE = '22023';
        END IF;
        v_warnings := v_result->'non_critical_errors';
        BEGIN
            INSERT INTO public.audit_logs(studio_id, actor_id, action, entity_type, entity_id, metadata)
            VALUES (v_run.studio_id, v_run.actor_id, 'students.imported', 'student', NULL,
                jsonb_build_object('imported', v_imported, 'total', v_result->'total_rows',
                    'created_programs', v_result->'created_programs',
                    'created_ladders', v_result->'created_ladders',
                    'created_belts', v_result->'created_belts',
                    'imported_without_belt', v_result->'imported_without_belt_count',
                    'idempotency_key', v_run.idempotency_key));
        EXCEPTION WHEN OTHERS THEN
            v_warnings := v_warnings || jsonb_build_array(
                'Students were imported, but the final import audit log could not be written. Contact support if you need the audit event reconciled.');
        END;
        v_result := v_result || jsonb_build_object('non_critical_errors', v_warnings,
            'idempotency_key', v_run.idempotency_key, 'reused_result', FALSE,
            'execution_status', CASE WHEN jsonb_array_length(v_warnings) > 0
                THEN 'completed_with_warnings' ELSE 'completed' END);
    END IF;

    UPDATE public.student_import_runs
       SET status = p_status,
           result_json = CASE WHEN p_status = 'completed' THEN v_result ELSE result_json END,
           error_message = CASE WHEN p_status = 'failed' THEN left(COALESCE(p_error_message, ''), 1000) ELSE NULL END,
           completed_at = CASE WHEN p_status = 'completed' THEN now() ELSE completed_at END,
           processing_token = NULL,
           processing_started_at = NULL
     WHERE id = p_import_run_id AND processing_token = p_processing_token
     RETURNING * INTO v_run;
    IF FOUND THEN
        RETURN QUERY SELECT TRUE, to_jsonb(v_run);
    ELSE
        RETURN QUERY SELECT FALSE, NULL::JSONB;
    END IF;
END;
$$;
ALTER FUNCTION public.finish_student_import_run(UUID, TEXT, TEXT, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_student_import_run(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_student_import_run(UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
WITH required_functions(signature, expected_result) AS (
    VALUES
        (
            'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        )
),
function_actual AS (
    SELECT
        format(
            '%I.%I(%s)',
            namespace.nspname,
            function.proname,
            oidvectortypes(function.proargtypes)
        ) AS signature,
        replace(pg_get_function_result(function.oid), 'public.', '') AS result_contract
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)',
          namespace.nspname,
          function.proname,
          oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.signature,
        required.expected_result,
        actual.result_contract
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
manifest_state AS (
    SELECT private.koaryu_release_student_rank_writer_manifest_v11() AS v11_manifest
),
invalid AS (
    SELECT
        count(*) FILTER (
            WHERE function.result_contract IS DISTINCT FROM function.expected_result
        ) +
        count(*) FILTER (
            WHERE manifest.v11_manifest IS DISTINCT FROM
              '0:e29841da46e9502abc6504261ac0182e21f8709e9c80ce31f376c0e0c7efe167'
        ) AS invalid_count
    FROM function_compared function
    CROSS JOIN manifest_state manifest
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            manifest.v11_manifest || '|' || COALESCE(string_agg(
                function.signature || ':' ||
                function.expected_result || ':' ||
                COALESCE(function.result_contract, ''),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN manifest_state manifest
CROSS JOIN invalid
GROUP BY invalid.invalid_count, manifest.v11_manifest;
$function$
;


DO $expectation$
DECLARE changed INTEGER;
BEGIN
    IF (SELECT count(*) FROM private.koaryu_release_v31_expectations) IS DISTINCT FROM 1
       OR (SELECT expected_sha256 FROM private.koaryu_release_v31_expectations WHERE expectation_key='operational_contract_v31')
          IS DISTINCT FROM '168cc61b730cae592edaecdd15ca126ad891d6ed70bd5d523362693c662e2888'
       OR private.koaryu_release_resource_ownership_manifest_v31()
          IS DISTINCT FROM '0:6fe8a2762952180fd877930242b10095484066158c3f37a132c7d75bbf685d01'
       OR private.koaryu_release_operational_contract_v31()
          IS DISTINCT FROM '0:9a317cbe7f22b280c63e2b52632b836fe526343460fc895b8115dffc38d5ed76' THEN
        RAISE EXCEPTION 'V45 requires the reviewed import contracts and original V31 expectation.';
    END IF;
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256='9a317cbe7f22b280c63e2b52632b836fe526343460fc895b8115dffc38d5ed76'
    WHERE expectation_key='operational_contract_v31'
      AND expected_sha256='168cc61b730cae592edaecdd15ca126ad891d6ed70bd5d523362693c662e2888';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed IS DISTINCT FROM 1 OR private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM '7d54757a9d0899bd1e54cb6f27a49e2a648c28f72a8d59cf30cd7938844abc75' THEN
        RAISE EXCEPTION 'V45 guarded expectation correction did not verify.';
    END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v26()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> 140 OR v_head <> '20260910185031' THEN
        v_failures := array_append(v_failures, 'migration_history_v45');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:6fe8a2762952180fd877930242b10095484066158c3f37a132c7d75bbf685d01' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_schedule_window_manifest_v1()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '8df0d054a33defc36a16f802283cd815a6e5cfd9b1633d7aef288daa4b8158f0' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1_function');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v31_expectations
    WHERE expectation_key = 'operational_contract_v31';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1
       OR private.koaryu_release_operational_contract_v31()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v31');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname='koaryu_release_v31_expectations'
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid='private.koaryu_release_v31_expectations'::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, 'operational_contract_v31_expectation_acl');
    END IF;
    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
                ('koaryu_release_v27_expectations'),
                ('koaryu_release_v28_expectations'),
                ('koaryu_release_v29_expectations'),
                ('koaryu_release_v30_expectations')
        ), expectation_table_state AS (
            SELECT
                required.table_name,
                relation.oid,
                relation.relkind,
                relation.relrowsecurity,
                owner.rolname AS owner_name,
                COALESCE((
                    SELECT count(DISTINCT privilege.privilege_type)
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee=relation.relowner
                      AND NOT privilege.is_grantable
                      AND privilege.privilege_type IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                      )
                ), 0) AS owner_privilege_count,
                EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee<>relation.relowner
                       OR privilege.is_grantable
                       OR privilege.privilege_type NOT IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                       )
                ) AS unexpected_privilege
            FROM required_expectation_tables AS required
            LEFT JOIN pg_class AS relation
              ON relation.relname=required.table_name
             AND relation.relnamespace='private'::REGNAMESPACE
            LEFT JOIN pg_roles AS owner ON owner.oid=relation.relowner
        )
        SELECT 1
        FROM expectation_table_state
        WHERE oid IS NULL
           OR relkind<>'r'
           OR owner_name<>'postgres'
           OR NOT relrowsecurity
           OR owner_privilege_count<>8
           OR unexpected_privilege
    ) THEN
        v_failures := array_append(
            v_failures,
            'inherited_operational_contract_expectation_acl'
        );
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8ce5a3a090a1fc1d29dab85c65fe8be07d6efa9639950732d13cf88e854f91f1' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v7_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '245040e7bfe42122a551d112ec9d411999b519866e59c8cd537de02c85f9889a' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v8_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '0f34947cbc4126a929b69db07690ca4bc73fe8b5b9982190ebb6fe2ebbb2d179' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v9_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '6b14a7594f511f258d6b94863c369a67f08e142dc721429adc7cdab4d4e64f86' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v10_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8270ab9a1a4ee091e700dc6fd2d33f2af5fa79dc1de34f3afd391c626e076843' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v11_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'a70b46c8b13a88f51d795be3ae4bc759bcc14495fda1cab9629e5c9c86e66228' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '79e338cb42307acf37e395647f29dbb88df57fa8d65443cc976a30c566cff6d2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11_function');
    END IF;
    IF private.koaryu_release_operational_manifest_v11()
       <> '2efb0b2cf73beabfb219dd3642a824714c1b0619c5498ecf195071f929e651f6' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:6389e87cdb8a5db79c540f38da4fdc71aa56ed10fa5d5533518f470bf52f7dfc' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6ee84c579e50be2b514ac00c975c1f60cf5f116e36adc27fe4296312e5188090' THEN
        v_failures:=array_append(v_failures,'resource_ownership_manifest_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6b54e02534f38bcd7bb6e6e811d9e01c9782958319514fee3f0a2f1d4ed167d4' THEN
        v_failures:=array_append(v_failures,'operational_contract_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'b16b633c6f78a2d5cf7d63f1d32679563ff2429197cc92a4d94e826b33a26035' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28_function');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
        v_failures := array_append(v_failures, 'operational_contract_v26');
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6500b8aaf8bb91cc91841f2bafaf3699b7ffa328ccaba4a0023721e3eb68f811' THEN
        v_failures := array_append(v_failures, 'operation_authorization_writer_function');
    END IF;
    IF has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, 'legacy_authorization_scope_execute');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND conname = 'studio_live_billing_authorizations_operation_set_exact'
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_constraint');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'text[]'
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'ARRAY[]::text[]'
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_column');
    END IF;
    IF private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.release',
                'connected_subscription_schedule.update'
            ]::TEXT[]
       ) IS DISTINCT FROM true
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.update',
                'connected_subscription_schedule.create'
            ]::TEXT[]
       ) IS DISTINCT FROM false
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.unknown'
            ]::TEXT[]
       ) IS DISTINCT FROM false THEN
        v_failures := array_append(
            v_failures,'operation_allowlist_schedule_semantics'
        );
    END IF;
    IF private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM '7d54757a9d0899bd1e54cb6f27a49e2a648c28f72a8d59cf30cd7938844abc75' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '57a017e4e7be92f023d31dc4a18e75b95c676765f42b54f9f5fb9f4b768ca3bd' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    IF private.koaryu_release_invoice_retry_preread_manifest_v32()
           <> '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
            v_failures := array_append(
                v_failures,'invoice_retry_preread_manifest_v32'
            );
        END IF;
        IF private.koaryu_release_invoice_retry_compatibility_manifest_v33()
       <> '0:8497daa806dcd7e33992fe8ca76f3207eb36b41e5a976be781e3bf33b22d4fdb' THEN
      v_failures:=array_append(v_failures,'invoice_retry_compatibility_manifest_v33');
    END IF;
    IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
       <> '0:d054ae0cf5ce43ce2c241ca628e0724b5239bd696c323ba9c817b8bd21ee0eec' THEN
      v_failures:=array_append(v_failures,'invoice_retry_closeout_manifest_v34');
    END IF;
    IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_manifest_v35');
    END IF;
    IF has_function_privilege('anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR has_function_privilege('authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR NOT has_function_privilege('service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE') THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_acl_v35');
    END IF;
    IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    IS DISTINCT FROM (SELECT recovery_manifest FROM private.koaryu_release_v36_expectations WHERE singleton) THEN
   v_failures:=array_append(v_failures,'payer_setup_recovery_manifest_v36');
 END IF;
 IF private.koaryu_release_adjustment_trigger_guard_manifest_v37()
      IS DISTINCT FROM (
        SELECT trigger_guard_manifest
        FROM private.koaryu_release_v37_expectations
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,'adjustment_trigger_guard_manifest_v37');
   END IF;
   
 IF EXISTS (
  SELECT 1 FROM (VALUES
  ('public.billing_payment_cohort(uuid,timestamptz,timestamptz)','5d6f683e3c56fe05db7e4101073d1a23792081192219cfa9eda4db8dcf734a1d'),
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','7adf5dc3a58e5f96aa87c3a4c1e4f509b081e97185a104e8d8239ad1fae2a222'),
  ('public.billing_webhook_health(text,boolean,timestamptz)','3bdcc77c7d768e5ede8750900c0b75ac98bdffbb14ada059c580185133a9fd52')
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,'billing_landing_reads_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.idx_billing_invoices_studio_history','public.billing_invoices','CREATE INDEX idx_billing_invoices_studio_history ON public.billing_invoices USING btree (studio_id, created_at DESC, id DESC)'),
   ('public.idx_billing_payments_studio_history','public.billing_payments','CREATE INDEX idx_billing_payments_studio_history ON public.billing_payments USING btree (studio_id, created_at DESC, id DESC)')
  ) expected(index_name,table_name,definition)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(expected.index_name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.oid IS NULL OR c.relkind<>'i' OR c.relowner<>'postgres'::regrole
   OR i.indrelid IS DISTINCT FROM to_regclass(expected.table_name)
   OR i.indisvalid IS DISTINCT FROM true OR i.indisready IS DISTINCT FROM true
   OR i.indislive IS DISTINCT FROM true OR i.indisunique IS DISTINCT FROM false
   OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM expected.definition
 ) THEN v_failures:=array_append(v_failures,'billing_history_indexes_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid='private.koaryu_release_critical_surface_manifest_v16()'::REGPROCEDURE
    AND (p.proowner <> 'postgres'::REGROLE OR p.prosecdef OR p.provolatile <> 's'
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
         IS DISTINCT FROM '7fb0ba103de76167982cc96f0698d7516418ababb0892dc70d5c85e1d83efc0f'
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee <> p.proowner))
 ) THEN v_failures:=array_append(v_failures,'rank_command_manifest_v40_definition'); END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='recompute_billing_payer_balance_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.recompute_billing_payer_balance_v1(uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '0eb78ae7d2c51c73bb17011e2cb0249f3fdb580e7a6293bc92f549771af646cd'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_balance_rpc_v41');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='record_external_payment_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '150aedb400108d00c3fe90ca3de7d4ccde6df24ad8dda4f045cd6256af1ad13d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'external_payment_rpc_v43');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='write_billing_plan_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ac577f4bec60aecc52b4950eda7d8a8a469d6ac035d05afeabb74e3a9c8fe789'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_rpc_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='clear_studio_operational_data_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.clear_studio_operational_data_atomic(uuid,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '9bc03bc31ae70310497bfa020088045b604e113550d79e1a9c6c754b58ec2876'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_clear_coordination_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='claim_student_import_run_owned') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '34c8fbfd2e843be56034d686c2d90911c6c3938ca5e71da1616ea092a6edcddc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_claim_student_import_run_owned_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '8a735334eb60047f7dfd06490949b9286cc693eb1fd7990900aa58d8d8c9b661'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_actor') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_actor(uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='boolean'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'd04e6d08b7fd24eca4a46eddf8fbcaaeeef80d65431e55de5562a198ac09c331'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_actor_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_run(uuid,uuid,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.student_import_runs'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '95ea7bdd011af07a17f77120ab7227dd540a1e612b79e03f305f9f5c591002af'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '187d0eb3385fc7958efc0dedc1e2a39a61224b59596f4611339b6eb7da1c159d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run_v2') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '91c5c8919bd1ddfc2b9bfa82ca9cced577a94974e7854a17fc3156540216add2'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v2_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='finish_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.finish_student_import_run(uuid,text,text,jsonb,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '8f40eed2f27ce892b08a673121247a34e8eaf342e0fb9953b6c873945e16b032'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_finish_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, private']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '6d9d129040e0f3cb831cbb883c56ee6c8bf4c4b18aff59eb55c0ccf862ae2bd9'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_belts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'c8b3740ccd70301f7eb96ac614805df3defd3d83ac4874f501c605acc564dd22'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_belts_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_program_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '25fadfe0298192b7d2bf6c6210ad199743e7dd01d9dd035e7c9f36ba7c17794e'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_program_v1_v45');
    END IF;
    IF (SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'no_policies',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('private.student_import_receipts')
          AND relation.relkind='r') IS DISTINCT FROM '{"owner":"postgres","rls":false,"force_rls":false,"columns":[["import_run_id","uuid",true,null,"","",true],["kind","text",true,null,"","",true],["key","text",true,null,"","",true],["result_json","jsonb",true,null,"","",true],["created_at","timestamp with time zone",true,"now()","","",true]],"acl":[["postgres","postgres","DELETE",false],["postgres","postgres","INSERT",false],["postgres","postgres","MAINTAIN",false],["postgres","postgres","REFERENCES",false],["postgres","postgres","SELECT",false],["postgres","postgres","TRIGGER",false],["postgres","postgres","TRUNCATE",false],["postgres","postgres","UPDATE",false],["service_role","postgres","INSERT",false],["service_role","postgres","SELECT",false]],"constraints":[["student_import_receipts_import_run_id_fkey","f",true,false,false,"FOREIGN KEY (import_run_id) REFERENCES public.student_import_runs(id) ON DELETE CASCADE"],["student_import_receipts_key_check","c",true,false,false,"CHECK (((char_length(key) >= 1) AND (char_length(key) <= 512)))"],["student_import_receipts_kind_check","c",true,false,false,"CHECK ((kind = ANY (ARRAY[''student''::text, ''program''::text, ''ladder''::text, ''rank''::text])))"],["student_import_receipts_pkey","p",true,false,false,"PRIMARY KEY (import_run_id, kind, key)"],["student_import_receipts_result_json_check","c",true,false,false,"CHECK ((jsonb_typeof(result_json) = ''object''::text))"]],"indexes":[["student_import_receipts_pkey",true,true,true,true,"CREATE UNIQUE INDEX student_import_receipts_pkey ON private.student_import_receipts USING btree (import_run_id, kind, key)"]],"no_policies":true,"no_user_triggers":true}'::JSONB
       OR (SELECT jsonb_build_array(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
                attribute.attnotnull,pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL)
            FROM pg_catalog.pg_attribute attribute LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=pg_catalog.to_regclass('public.student_import_runs')
              AND attribute.attname='receipts_enabled' AND NOT attribute.attisdropped)
          IS DISTINCT FROM '["boolean",true,"false","","",true]'::JSONB THEN
        v_failures:=array_append(v_failures,'import_receipts_v45');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       IS DISTINCT FROM '0:4653774cb7fcf2f85c70dcb9284ee01d25051ebf4552520a0fa95eb929cafb9f' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '7a1d1b52edfbda7d2ac942516bb0d2224af757a9d1278996d6225e8b94956578' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_definition_v45');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v45'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v25()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v26();
    IF v.ready IS TRUE AND v.migration_count = 140 AND v.migration_head = '20260910185031'
       AND v.manifest_version = 'release-db-attestation-v45'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 56
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260910185031' THEN
        RETURN QUERY SELECT TRUE, 139, '20260910135133'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v44'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v44'::TEXT;
END;
$function$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v26() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v26() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v26() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v25() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v25() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v25() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v26();
    IF v.migration_count IS DISTINCT FROM 139 OR v.migration_head IS DISTINCT FROM '20260910135133'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v45',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V45 installed contracts did not verify before history registration: %', row_to_json(v);
    END IF;
END;
$installed$;
