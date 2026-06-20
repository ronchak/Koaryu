-- ==========================================
-- Koaryu v1 - Atomic manual student writes
-- ==========================================
--
-- Manual student create/update used to write the student, memberships,
-- guardians, and audit rows from separate backend calls. Keep validation in the
-- service layer, but make the state change itself transactional.

CREATE OR REPLACE FUNCTION public.write_student_profile_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_student JSONB,
    p_program_ids UUID[] DEFAULT NULL,
    p_guardians JSONB DEFAULT '[]'::JSONB,
    p_replace_programs BOOLEAN DEFAULT FALSE,
    p_audit_action TEXT DEFAULT 'student.updated'
)
RETURNS public.students
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.students%ROWTYPE;
    v_updated public.students%ROWTYPE;
    v_program_ids UUID[] := COALESCE(p_program_ids, ARRAY[]::UUID[]);
    v_program_id UUID;
    v_rank_program_id UUID;
    v_membership_id UUID;
    v_current_belt_rank_id UUID;
    v_membership_started_at DATE;
    v_today DATE := CURRENT_DATE;
    v_tags TEXT[];
    v_guardian JSONB;
    v_guardian_row public.guardians%ROWTYPE;
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
BEGIN
    IF p_student IS NULL OR jsonb_typeof(p_student) <> 'object' THEN
        RAISE EXCEPTION 'Student write payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    IF p_student_id IS NULL THEN
        RAISE EXCEPTION 'Student write requires a student id.'
            USING ERRCODE = '22023';
    END IF;

    IF p_student ? 'studio_id' AND NULLIF(p_student->>'studio_id', '')::UUID IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Student write payload studio does not match request studio.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_replace_programs THEN
        IF cardinality(v_program_ids) IS NULL OR cardinality(v_program_ids) = 0 THEN
            RAISE EXCEPTION 'Student write requires program memberships.'
                USING ERRCODE = '22023';
        END IF;

        FOREACH v_program_id IN ARRAY v_program_ids LOOP
            IF v_program_id IS NULL THEN
                RAISE EXCEPTION 'Student write includes an empty program id.'
                    USING ERRCODE = '22023';
            END IF;

            PERFORM 1
              FROM public.programs
             WHERE id = v_program_id
               AND studio_id = p_studio_id
               AND archived_at IS NULL;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Student write program does not belong to this studio or is archived.'
                    USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
    END IF;

    IF p_student ? 'tags' THEN
        SELECT COALESCE(array_agg(tag.value), ARRAY[]::TEXT[])
          INTO v_tags
          FROM jsonb_array_elements_text(
              CASE
                  WHEN jsonb_typeof(p_student->'tags') = 'array' THEN p_student->'tags'
                  ELSE '[]'::JSONB
              END
          ) AS tag(value);
    END IF;

    SELECT *
      INTO v_existing
      FROM public.students
     WHERE id = p_student_id
     FOR UPDATE;

    IF FOUND AND v_existing.studio_id <> p_studio_id THEN
        RAISE EXCEPTION 'Student id already belongs to another studio.'
            USING ERRCODE = 'P0001';
    END IF;

    IF NOT FOUND THEN
        IF p_audit_action <> 'student.created' THEN
            RAISE EXCEPTION 'Student not found for update.'
                USING ERRCODE = 'P0001';
        END IF;

        IF NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '') IS NULL
           OR NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Student create payload is missing required name fields.'
                USING ERRCODE = '22023';
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
            p_student_id,
            p_studio_id,
            NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), ''),
            NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), ''),
            NULLIF(p_student->>'preferred_name', ''),
            NULLIF(p_student->>'date_of_birth', '')::DATE,
            COALESCE((p_student->>'is_minor')::BOOLEAN, false),
            NULLIF(p_student->>'email', ''),
            NULLIF(p_student->>'phone', ''),
            NULLIF(p_student->>'address_line1', ''),
            NULLIF(p_student->>'address_city', ''),
            NULLIF(p_student->>'address_state', ''),
            NULLIF(p_student->>'address_zip', ''),
            NULLIF(p_student->>'emergency_contact_name', ''),
            NULLIF(p_student->>'emergency_contact_phone', ''),
            NULLIF(p_student->>'emergency_contact_relation', ''),
            COALESCE(NULLIF(p_student->>'status', ''), 'active'),
            NULLIF(p_student->>'membership_start_date', '')::DATE,
            CASE WHEN p_replace_programs THEN v_program_ids[1] ELSE NULLIF(p_student->>'program_id', '')::UUID END,
            NULLIF(p_student->>'current_belt_rank_id', '')::UUID,
            NULLIF(p_student->>'notes', ''),
            COALESCE(v_tags, ARRAY[]::TEXT[]),
            NULLIF(p_student->>'hold_start_date', '')::DATE,
            NULLIF(p_student->>'hold_end_date', '')::DATE
        )
        RETURNING * INTO v_updated;
    ELSE
        UPDATE public.students
           SET legal_first_name = CASE WHEN p_student ? 'legal_first_name' THEN NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '') ELSE legal_first_name END,
               legal_last_name = CASE WHEN p_student ? 'legal_last_name' THEN NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '') ELSE legal_last_name END,
               preferred_name = CASE WHEN p_student ? 'preferred_name' THEN NULLIF(p_student->>'preferred_name', '') ELSE preferred_name END,
               date_of_birth = CASE WHEN p_student ? 'date_of_birth' THEN NULLIF(p_student->>'date_of_birth', '')::DATE ELSE date_of_birth END,
               is_minor = CASE WHEN p_student ? 'is_minor' THEN COALESCE((p_student->>'is_minor')::BOOLEAN, false) ELSE is_minor END,
               email = CASE WHEN p_student ? 'email' THEN NULLIF(p_student->>'email', '') ELSE email END,
               phone = CASE WHEN p_student ? 'phone' THEN NULLIF(p_student->>'phone', '') ELSE phone END,
               address_line1 = CASE WHEN p_student ? 'address_line1' THEN NULLIF(p_student->>'address_line1', '') ELSE address_line1 END,
               address_city = CASE WHEN p_student ? 'address_city' THEN NULLIF(p_student->>'address_city', '') ELSE address_city END,
               address_state = CASE WHEN p_student ? 'address_state' THEN NULLIF(p_student->>'address_state', '') ELSE address_state END,
               address_zip = CASE WHEN p_student ? 'address_zip' THEN NULLIF(p_student->>'address_zip', '') ELSE address_zip END,
               emergency_contact_name = CASE WHEN p_student ? 'emergency_contact_name' THEN NULLIF(p_student->>'emergency_contact_name', '') ELSE emergency_contact_name END,
               emergency_contact_phone = CASE WHEN p_student ? 'emergency_contact_phone' THEN NULLIF(p_student->>'emergency_contact_phone', '') ELSE emergency_contact_phone END,
               emergency_contact_relation = CASE WHEN p_student ? 'emergency_contact_relation' THEN NULLIF(p_student->>'emergency_contact_relation', '') ELSE emergency_contact_relation END,
               status = CASE WHEN p_student ? 'status' THEN COALESCE(NULLIF(p_student->>'status', ''), status) ELSE status END,
               membership_start_date = CASE WHEN p_student ? 'membership_start_date' THEN NULLIF(p_student->>'membership_start_date', '')::DATE ELSE membership_start_date END,
               program_id = CASE WHEN p_replace_programs THEN v_program_ids[1] WHEN p_student ? 'program_id' THEN NULLIF(p_student->>'program_id', '')::UUID ELSE program_id END,
               current_belt_rank_id = CASE WHEN p_student ? 'current_belt_rank_id' THEN NULLIF(p_student->>'current_belt_rank_id', '')::UUID ELSE current_belt_rank_id END,
               notes = CASE WHEN p_student ? 'notes' THEN NULLIF(p_student->>'notes', '') ELSE notes END,
               tags = CASE WHEN p_student ? 'tags' THEN COALESCE(v_tags, ARRAY[]::TEXT[]) ELSE tags END,
               hold_start_date = CASE WHEN p_student ? 'hold_start_date' THEN NULLIF(p_student->>'hold_start_date', '')::DATE ELSE hold_start_date END,
               hold_end_date = CASE WHEN p_student ? 'hold_end_date' THEN NULLIF(p_student->>'hold_end_date', '')::DATE ELSE hold_end_date END
         WHERE id = p_student_id
           AND studio_id = p_studio_id
         RETURNING * INTO v_updated;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student not found for update.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_replace_programs THEN
        v_current_belt_rank_id := v_updated.current_belt_rank_id;
        v_membership_started_at := v_updated.membership_start_date;

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

        UPDATE public.student_program_memberships AS membership
           SET status = 'ended',
               ended_at = v_today,
               current_belt_rank_id = NULL
         WHERE membership.student_id = p_student_id
           AND membership.studio_id = p_studio_id
           AND membership.ended_at IS NULL
           AND NOT (membership.program_id = ANY(v_program_ids));

        FOREACH v_program_id IN ARRAY v_program_ids LOOP
            SELECT membership.id
              INTO v_membership_id
              FROM public.student_program_memberships AS membership
             WHERE membership.student_id = p_student_id
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
                 WHERE membership.id = v_membership_id
                   AND membership.studio_id = p_studio_id;
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
                    p_student_id,
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
    END IF;

    IF jsonb_typeof(p_guardians) = 'array' THEN
        FOR v_guardian IN SELECT value FROM jsonb_array_elements(p_guardians)
        LOOP
            v_guardian_first_name := NULLIF(btrim(COALESCE(v_guardian->>'first_name', '')), '');
            v_guardian_last_name := NULLIF(btrim(COALESCE(v_guardian->>'last_name', '')), '');
            IF v_guardian_first_name IS NULL OR v_guardian_last_name IS NULL THEN
                RAISE EXCEPTION 'Guardian create payload is missing required name fields.'
                    USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.guardians (
                studio_id,
                first_name,
                last_name,
                email,
                phone,
                relation,
                is_primary_contact
            )
            VALUES (
                p_studio_id,
                v_guardian_first_name,
                v_guardian_last_name,
                NULLIF(v_guardian->>'email', ''),
                NULLIF(v_guardian->>'phone', ''),
                NULLIF(v_guardian->>'relation', ''),
                COALESCE((v_guardian->>'is_primary_contact')::BOOLEAN, false)
            )
            RETURNING * INTO v_guardian_row;

            INSERT INTO public.student_guardians (
                student_id,
                guardian_id
            )
            VALUES (
                p_student_id,
                v_guardian_row.id
            );
        END LOOP;
    ELSIF p_guardians IS NOT NULL THEN
        RAISE EXCEPTION 'Student guardians payload must be an array.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        p_studio_id,
        p_actor_id,
        p_audit_action,
        'student',
        p_student_id,
        CASE
            WHEN p_audit_action = 'student.created' THEN
                jsonb_build_object('name', concat_ws(' ', v_updated.legal_first_name, v_updated.legal_last_name))
            ELSE
                p_student
        END
    );

    RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) TO service_role;
