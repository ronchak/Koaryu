-- ==========================================
-- Koaryu v1 - Atomic student import row writer
-- ==========================================
--
-- CSV row execution needs the student, active memberships, optional guardian,
-- and guardian link to commit or fail together. Keep that orchestration in one
-- service-role RPC so Postgres owns the transaction boundary.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE OR REPLACE FUNCTION private.deterministic_import_uuid(
    p_namespace UUID,
    p_name TEXT
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_digest BYTEA;
    v_hex TEXT;
    v_variant TEXT;
BEGIN
    IF p_namespace IS NULL OR p_name IS NULL THEN
        RAISE EXCEPTION 'Namespace and name are required for deterministic import UUIDs.'
            USING ERRCODE = '22023';
    END IF;

    v_digest := digest(
        decode(replace(p_namespace::TEXT, '-', ''), 'hex') || convert_to(p_name, 'UTF8'),
        'sha1'
    );
    v_hex := encode(substring(v_digest FROM 1 FOR 16), 'hex');
    v_variant := substr('89ab', (get_byte(v_digest, 8) >> 6) + 1, 1);

    RETURN (
        substr(v_hex, 1, 8) || '-' ||
        substr(v_hex, 9, 4) || '-' ||
        '5' || substr(v_hex, 14, 3) || '-' ||
        v_variant || substr(v_hex, 18, 3) || '-' ||
        substr(v_hex, 21, 12)
    )::UUID;
END;
$$;

DROP FUNCTION IF EXISTS public.import_student_row_atomic(JSONB, UUID, UUID, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]);

CREATE OR REPLACE FUNCTION public.import_student_row_atomic(
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
    v_today DATE := CURRENT_DATE;
    v_guardian_name TEXT := NULLIF(btrim(COALESCE(p_guardian_name, '')), '');
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
    v_guardian_id UUID;
    v_guardian_link_id UUID;
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

    IF v_student.id IS NULL THEN
        RAISE EXCEPTION 'Student import payload is missing id.'
            USING ERRCODE = '22023';
    END IF;

    IF v_student.studio_id IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Student import payload studio does not match request studio.'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_student.legal_first_name IS NULL OR v_student.legal_last_name IS NULL THEN
        RAISE EXCEPTION 'Student import payload is missing required name fields.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM 1
      FROM public.student_import_runs
     WHERE id = p_import_run_id
       AND studio_id = p_studio_id
       AND operation = 'students_csv_execute'
       AND status = 'processing'
       AND processing_token = p_processing_token
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student import worker claim is no longer active.'
            USING ERRCODE = 'P0001';
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

    PERFORM pg_advisory_xact_lock(
        hashtextextended('student_import_row:' || p_import_run_id::TEXT || ':' || p_row_number::TEXT, 0)
    );

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
    )
    ON CONFLICT (id) DO UPDATE
       SET studio_id = EXCLUDED.studio_id,
           legal_first_name = EXCLUDED.legal_first_name,
           legal_last_name = EXCLUDED.legal_last_name,
           preferred_name = EXCLUDED.preferred_name,
           date_of_birth = EXCLUDED.date_of_birth,
           is_minor = EXCLUDED.is_minor,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           address_line1 = EXCLUDED.address_line1,
           address_city = EXCLUDED.address_city,
           address_state = EXCLUDED.address_state,
           address_zip = EXCLUDED.address_zip,
           emergency_contact_name = EXCLUDED.emergency_contact_name,
           emergency_contact_phone = EXCLUDED.emergency_contact_phone,
           emergency_contact_relation = EXCLUDED.emergency_contact_relation,
           status = EXCLUDED.status,
           membership_start_date = EXCLUDED.membership_start_date,
           program_id = EXCLUDED.program_id,
           current_belt_rank_id = EXCLUDED.current_belt_rank_id,
           notes = EXCLUDED.notes,
           tags = EXCLUDED.tags,
           hold_start_date = EXCLUDED.hold_start_date,
           hold_end_date = EXCLUDED.hold_end_date
    RETURNING id INTO v_student_id;

    UPDATE public.student_program_memberships AS membership
       SET status = 'ended',
           ended_at = v_today,
           current_belt_rank_id = NULL
     WHERE membership.student_id = v_student_id
       AND membership.studio_id = p_studio_id
       AND membership.ended_at IS NULL
       AND NOT (membership.program_id = ANY(v_program_ids));

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
        )
        ON CONFLICT (id) DO UPDATE
           SET studio_id = EXCLUDED.studio_id,
               first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name,
               email = EXCLUDED.email,
               phone = EXCLUDED.phone,
               relation = EXCLUDED.relation,
               is_primary_contact = EXCLUDED.is_primary_contact;

        INSERT INTO public.student_guardians (
            id,
            student_id,
            guardian_id
        )
        VALUES (
            v_guardian_link_id,
            v_student_id,
            v_guardian_id
        )
        ON CONFLICT (id) DO UPDATE
           SET student_id = EXCLUDED.student_id,
               guardian_id = EXCLUDED.guardian_id;

        guardian_imported := true;
    END IF;

    RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION private.deterministic_import_uuid(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.deterministic_import_uuid(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]) TO service_role;
