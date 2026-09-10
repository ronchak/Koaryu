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
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
    SELECT * FROM private.claim_student_import_run_owned(p_studio_id, p_actor_id, p_operation,
        p_idempotency_key, p_request_hash, p_processing_token, FALSE, p_stale_after_seconds);
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
SET search_path = pg_catalog
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
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
    SELECT * FROM private.import_student_row_atomic(p_student, p_studio_id, p_import_run_id,
        p_processing_token, p_row_number, p_guardian_name, p_guardian_email, p_guardian_phone,
        p_guardian_relation, p_program_ids);
$$;
ALTER FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) TO service_role;

CREATE FUNCTION public.prepare_student_import_program_v1(
    p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT,
    p_key TEXT, p_program_id UUID, p_name TEXT, p_ladder_id UUID,
    p_unassigned BOOLEAN DEFAULT FALSE
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
    IF p_program_id IS NULL OR p_name IS NULL OR btrim(p_name) = '' OR p_unassigned IS NULL
       OR (p_unassigned AND p_name <> 'Unassigned')
       OR (NOT p_unassigned AND p_ladder_id IS NULL) THEN
        RAISE EXCEPTION 'Import program details are incomplete.' USING ERRCODE = '22023';
    END IF;

    -- Python owns CSV name normalization. Recheck the database's exact active-name
    -- uniqueness here to tolerate a concurrent creator without overwriting it.
    SELECT * INTO v_program FROM public.programs
    WHERE studio_id = p_studio_id AND lower(name) = lower(btrim(p_name)) AND archived_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
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
ALTER FUNCTION public.prepare_student_import_program_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT, UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_student_import_program_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_student_import_program_v1(UUID, UUID, TEXT, TEXT, UUID, TEXT, UUID, BOOLEAN)
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
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog AS $$
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

-- Draft guard, removed only when the generated attestation is assembled and verified.
DO $unattested$
BEGIN
    RAISE EXCEPTION 'V45 attestation and restore verification are not yet complete.';
END;
$unattested$;
