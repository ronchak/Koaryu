-- V54 candidate: preserve explicit minor knowledge, allow guardian corrections,
-- and reject future birth dates. Existing valid DOBs remain authoritative.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(
        (SELECT p.prosrc FROM pg_catalog.pg_proc p
         WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v34()')),
        'UTF8'),'sha256'),'hex') IS DISTINCT FROM '13b061b832106be87293bfb7f39378b78c52ef8e4ec3e21dd8c22a29d868d54e'
       OR encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('private.koaryu_release_student_rank_writer_manifest_v13()')),
        'UTF8'),'sha256'),'hex') IS DISTINCT FROM '7a1d1b52edfbda7d2ac942516bb0d2224af757a9d1278996d6225e8b94956578'
       OR pg_catalog.to_regprocedure('public.student_business_date(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.validate_student_birth_date()') IS NOT NULL THEN
        RAISE EXCEPTION 'V54 requires the reviewed V53 readiness and student writer definitions.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v34();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 148
       OR v.migration_head IS DISTINCT FROM '20260929152445'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v53'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 64
       OR v.pending_versions[64] IS DISTINCT FROM '20260929152445' THEN
        RAISE EXCEPTION 'V54 requires a fully verified V53 predecessor.';
    END IF;
END;
$predecessor$;

-- Date-only student validation shares the studio clock with API and UI reads.
-- No backfill: legacy dates remain available for explicit owner correction.
CREATE FUNCTION public.student_business_date(p_studio_id UUID)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_timezone TEXT;
BEGIN
    SELECT COALESCE(NULLIF(studio.timezone, ''), 'UTC') INTO v_timezone
    FROM public.studios AS studio WHERE studio.id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student studio not found.' USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_timezone) THEN
        v_timezone := 'UTC';
    END IF;
    RETURN (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::DATE;
END;
$$;

CREATE FUNCTION public.validate_student_birth_date()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_utc_date DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::DATE;
    v_future BOOLEAN;
BEGIN
    IF NEW.date_of_birth IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.date_of_birth IS NOT DISTINCT FROM OLD.date_of_birth
           AND NEW.studio_id IS NOT DISTINCT FROM OLD.studio_id THEN
            RETURN NEW;
        END IF;
    END IF;
    IF NOT pg_catalog.isfinite(NEW.date_of_birth) THEN
        v_future := TRUE;
    ELSE
        -- Preserve the helper's missing-studio error even outside the window.
        PERFORM 1 FROM public.studios WHERE id = NEW.studio_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student studio not found.' USING ERRCODE = '23503';
        END IF;
        -- Current timezone offsets fit within UTC +/-1 day. Two days leave
        -- a conservative margin; only the ambiguous dates need the catalog.
        IF NEW.date_of_birth <= v_utc_date - 2 THEN
            v_future := FALSE;
        ELSIF NEW.date_of_birth > v_utc_date + 2 THEN
            v_future := TRUE;
        ELSE
            v_future := NEW.date_of_birth > public.student_business_date(NEW.studio_id);
        END IF;
    END IF;
    IF v_future THEN
        RAISE EXCEPTION 'Date of birth cannot be in the future.'
            USING ERRCODE = '23514', CONSTRAINT = 'students_birth_date_not_future';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.student_business_date(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_student_birth_date() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.student_business_date(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_student_birth_date() TO service_role;

CREATE TRIGGER validate_students_birth_date
BEFORE INSERT OR UPDATE OF date_of_birth, studio_id ON public.students
FOR EACH ROW EXECUTE FUNCTION public.validate_student_birth_date();

-- Keep explicit minor knowledge when a student has no birth date. A known
-- birth date remains authoritative; guardian presence never supplies age.
CREATE OR REPLACE FUNCTION public.set_student_is_minor()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
    v_today DATE;
    v_utc_date DATE := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::DATE;
    v_dob DATE;
BEGIN
    IF NEW.date_of_birth IS NOT NULL THEN
        v_dob := NEW.date_of_birth;
    ELSIF TG_OP = 'UPDATE' AND OLD.date_of_birth IS NOT NULL THEN
        -- Removing a DOB retains its current known classification, not a
        -- possibly stale stored flag from before the eighteenth birthday.
        v_dob := OLD.date_of_birth;
    ELSE
        NEW.is_minor := COALESCE(NEW.is_minor, false);
        RETURN NEW;
    END IF;
    PERFORM 1 FROM public.studios WHERE id = NEW.studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student studio not found.' USING ERRCODE = '23503';
    END IF;
    -- The eighteenth-birthday cutoff is monotonic, including leap days.
    -- Compare both ends of the conservative UTC date window before looking
    -- up the studio timezone. Retained future/non-finite DOBs stay nonminor.
    IF NOT pg_catalog.isfinite(v_dob)
       OR v_dob > v_utc_date + 2
       OR v_dob <= (((v_utc_date - 2) - INTERVAL '18 years')::DATE) THEN
        NEW.is_minor := FALSE;
    ELSIF v_dob <= v_utc_date - 2
          AND v_dob > (((v_utc_date + 2) - INTERVAL '18 years')::DATE) THEN
        NEW.is_minor := TRUE;
    ELSE
        v_today := public.student_business_date(NEW.studio_id);
        NEW.is_minor := v_dob <= v_today
            AND v_dob > ((v_today - INTERVAL '18 years')::DATE);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_student_is_minor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_student_is_minor() TO service_role;

-- Repair only explicit source-lead knowledge for the same converted student and
-- studio. Students with a known DOB keep their age-derived status.
UPDATE public.students AS student
SET is_minor = TRUE
WHERE student.date_of_birth IS NULL
  AND student.is_minor IS DISTINCT FROM TRUE
  AND EXISTS (
      SELECT 1 FROM public.leads AS lead
      WHERE lead.converted_student_id = student.id
        AND lead.studio_id = student.studio_id
        AND lead.is_minor IS TRUE
  );

CREATE OR REPLACE FUNCTION public.convert_lead_to_student_atomic(
    p_studio_id UUID,
    p_actor_id UUID,
    p_lead_id UUID,
    p_student_id UUID,
    p_program_id UUID,
    p_status TEXT,
    p_membership_start_date DATE,
    p_guardian_id UUID DEFAULT NULL,
    p_student_guardian_id UUID DEFAULT NULL
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lead public.leads%ROWTYPE;
    v_student public.students%ROWTYPE;
    v_existing_studio UUID;
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
    v_updated public.leads%ROWTYPE;
BEGIN
    IF p_program_id IS NULL THEN
        RAISE EXCEPTION 'Lead conversion requires a program id.';
    END IF;

    SELECT *
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
      AND studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead not found for studio.';
    END IF;

    IF v_lead.converted_student_id IS NOT NULL THEN
        RETURN v_lead;
    END IF;

    SELECT studio_id
    INTO v_existing_studio
    FROM public.students
    WHERE id = p_student_id;

    IF v_existing_studio IS NOT NULL AND v_existing_studio <> p_studio_id THEN
        RAISE EXCEPTION 'Student id already belongs to another studio.';
    END IF;

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        is_minor,
        email,
        phone,
        status,
        membership_start_date,
        program_id,
        notes,
        tags
    )
    VALUES (
        p_student_id,
        p_studio_id,
        v_lead.first_name,
        v_lead.last_name,
        COALESCE(v_lead.is_minor, false),
        v_lead.email,
        v_lead.phone,
        p_status,
        p_membership_start_date,
        p_program_id,
        v_lead.notes,
        ARRAY['converted-lead']::TEXT[]
    )
    ON CONFLICT (id) DO NOTHING;

    SELECT *
    INTO v_student
    FROM public.students
    WHERE id = p_student_id
      AND studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Converted student was not available after insert.';
    END IF;

    UPDATE public.student_program_memberships
    SET status = 'active',
        started_at = p_membership_start_date,
        ended_at = NULL
    WHERE studio_id = p_studio_id
      AND student_id = p_student_id
      AND program_id = p_program_id
      AND ended_at IS NULL;

    IF NOT FOUND THEN
        INSERT INTO public.student_program_memberships (
            studio_id,
            student_id,
            program_id,
            status,
            started_at
        )
        VALUES (
            p_studio_id,
            p_student_id,
            p_program_id,
            'active',
            p_membership_start_date
        )
        ON CONFLICT (student_id, program_id) WHERE ended_at IS NULL
        DO UPDATE SET
            status = 'active',
            started_at = EXCLUDED.started_at,
            ended_at = NULL
        WHERE student_program_memberships.studio_id = p_studio_id
        ;

        IF NOT EXISTS (
            SELECT 1
            FROM public.student_program_memberships
            WHERE studio_id = p_studio_id
              AND student_id = p_student_id
              AND program_id = p_program_id
              AND ended_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Converted student membership could not be activated for this studio.';
        END IF;
    END IF;

    IF v_lead.is_minor AND NULLIF(btrim(COALESCE(v_lead.guardian_name, '')), '') IS NOT NULL THEN
        IF p_guardian_id IS NULL OR p_student_guardian_id IS NULL THEN
            RAISE EXCEPTION 'Minor lead conversion requires guardian ids.';
        END IF;

        SELECT studio_id
        INTO v_existing_studio
        FROM public.guardians
        WHERE id = p_guardian_id;

        IF v_existing_studio IS NOT NULL AND v_existing_studio <> p_studio_id THEN
            RAISE EXCEPTION 'Guardian id already belongs to another studio.';
        END IF;

        v_guardian_first_name := split_part(btrim(v_lead.guardian_name), ' ', 1);
        v_guardian_last_name := NULLIF(btrim(substr(btrim(v_lead.guardian_name), length(v_guardian_first_name) + 1)), '');

        INSERT INTO public.guardians (
            id,
            studio_id,
            first_name,
            last_name,
            email,
            phone,
            is_primary_contact
        )
        VALUES (
            p_guardian_id,
            p_studio_id,
            v_guardian_first_name,
            COALESCE(v_guardian_last_name, ''),
            v_lead.guardian_email,
            v_lead.guardian_phone,
            TRUE
        )
        ON CONFLICT (id) DO NOTHING;

        SELECT student.studio_id
        INTO v_existing_studio
        FROM public.student_guardians AS link
        JOIN public.students AS student ON student.id = link.student_id
        WHERE link.id = p_student_guardian_id;

        IF v_existing_studio IS NOT NULL AND v_existing_studio <> p_studio_id THEN
            RAISE EXCEPTION 'Student guardian link id already belongs to another studio.';
        END IF;

        INSERT INTO public.student_guardians (
            id,
            student_id,
            guardian_id
        )
        VALUES (
            p_student_guardian_id,
            p_student_id,
            p_guardian_id
        )
        ON CONFLICT (id) DO NOTHING;

        IF NOT EXISTS (
            SELECT 1
            FROM public.student_guardians
            WHERE id = p_student_guardian_id
              AND student_id = p_student_id
              AND guardian_id = p_guardian_id
        ) THEN
            RAISE EXCEPTION 'Student guardian link id already points at a different relationship.';
        END IF;
    END IF;

    UPDATE public.leads
    SET stage = 'enrolled',
        converted_student_id = p_student_id,
        follow_up_date = NULL
    WHERE id = p_lead_id
      AND studio_id = p_studio_id
    RETURNING * INTO v_updated;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead was not updated during conversion.';
    END IF;

    INSERT INTO public.lead_activities (
        studio_id,
        lead_id,
        activity_type,
        description,
        created_by
    )
    VALUES (
        p_studio_id,
        p_lead_id,
        'stage_change',
        'Converted to student (ID: ' || p_student_id::TEXT || ')',
        p_actor_id
    );

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
        'lead.converted',
        'lead',
        p_lead_id,
        jsonb_build_object('student_id', p_student_id)
    );

    RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.convert_lead_to_student_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_student_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, UUID, UUID) TO service_role;

-- Allow add/patch of linked guardians in the existing atomic student write.
-- Existing contact identities and all student/family links are retained.
CREATE OR REPLACE FUNCTION private.write_student_profile_atomic(
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
    v_guardian_id UUID;
    v_guardian_key TEXT;
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
                   SET status = CASE WHEN membership.status = 'paused' THEN 'paused' ELSE 'active' END,
                       ended_at = NULL,
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

    -- An empty array preserves every guardian and link. Supplied entries add a
    -- contact or patch an already-linked contact; removal is never implicit.
    IF p_guardians IS NULL OR jsonb_typeof(p_guardians) <> 'array' THEN
        RAISE EXCEPTION 'Student guardians payload must be an array.'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT (entry->>'id')::UUID
          FROM jsonb_array_elements(p_guardians) entry
         WHERE jsonb_typeof(entry) = 'object' AND entry ? 'id'
         GROUP BY (entry->>'id')::UUID HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate guardian id in student write.' USING ERRCODE = '22023';
    END IF;

    -- Shared family contacts can be edited from different students. Lock the
    -- guardian rows in UUID order after the existing student/membership locks.
    PERFORM guardian.id
      FROM public.guardians guardian
     WHERE guardian.studio_id = p_studio_id
       AND guardian.id IN (
           SELECT (entry->>'id')::UUID
             FROM jsonb_array_elements(p_guardians) entry
            WHERE jsonb_typeof(entry) = 'object' AND entry ? 'id'
       )
     ORDER BY guardian.id
     FOR UPDATE;

    FOR v_guardian IN SELECT value FROM jsonb_array_elements(p_guardians)
    LOOP
        IF jsonb_typeof(v_guardian) <> 'object' THEN
            RAISE EXCEPTION 'Guardian payload must be a JSON object.' USING ERRCODE = '22023';
        END IF;
        FOR v_guardian_key IN SELECT jsonb_object_keys(v_guardian)
        LOOP
            IF v_guardian_key NOT IN ('id', 'first_name', 'last_name', 'email', 'phone', 'relation', 'is_primary_contact') THEN
                RAISE EXCEPTION 'Unknown guardian field.' USING ERRCODE = '22023';
            END IF;
            IF v_guardian_key = 'is_primary_contact' THEN
                IF jsonb_typeof(v_guardian->v_guardian_key) <> 'boolean' THEN
                    RAISE EXCEPTION 'Guardian primary contact flag must be a boolean.' USING ERRCODE = '22023';
                END IF;
            ELSIF jsonb_typeof(v_guardian->v_guardian_key) <> 'string'
                  AND NOT (v_guardian_key IN ('email', 'phone', 'relation') AND v_guardian->v_guardian_key = 'null'::JSONB) THEN
                RAISE EXCEPTION 'Guardian field must be a string.' USING ERRCODE = '22023';
            END IF;
        END LOOP;

        v_guardian_first_name := NULLIF(btrim(COALESCE(v_guardian->>'first_name', '')), '');
        v_guardian_last_name := NULLIF(btrim(COALESCE(v_guardian->>'last_name', '')), '');
        IF (NOT (v_guardian ? 'id') OR v_guardian ? 'first_name') AND v_guardian_first_name IS NULL
           OR NOT (v_guardian ? 'id') AND NOT (v_guardian ? 'last_name') THEN
            RAISE EXCEPTION 'Guardian first name is required; last name must be a string.' USING ERRCODE = '22023';
        END IF;

        IF v_guardian ? 'id' THEN
            v_guardian_id := (v_guardian->>'id')::UUID;
            IF v_guardian_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.student_guardians link
                JOIN public.guardians guardian ON guardian.id = link.guardian_id
                WHERE link.student_id = p_student_id
                  AND guardian.id = v_guardian_id
                  AND guardian.studio_id = p_studio_id
            ) THEN
                RAISE EXCEPTION 'Guardian is not linked to this student in this studio.' USING ERRCODE = '22023';
            END IF;
            IF v_guardian = jsonb_build_object('id', v_guardian_id) THEN
                RAISE EXCEPTION 'Provide guardian fields to update.' USING ERRCODE = '22023';
            END IF;
            UPDATE public.guardians
               SET first_name = CASE WHEN v_guardian ? 'first_name' THEN v_guardian_first_name ELSE first_name END,
                   last_name = CASE WHEN v_guardian ? 'last_name' THEN btrim(v_guardian->>'last_name') ELSE last_name END,
                   email = CASE WHEN v_guardian ? 'email' THEN NULLIF(btrim(v_guardian->>'email'), '') ELSE email END,
                   phone = CASE WHEN v_guardian ? 'phone' THEN NULLIF(btrim(v_guardian->>'phone'), '') ELSE phone END,
                   relation = CASE WHEN v_guardian ? 'relation' THEN NULLIF(btrim(v_guardian->>'relation'), '') ELSE relation END,
                   is_primary_contact = CASE WHEN v_guardian ? 'is_primary_contact' THEN (v_guardian->>'is_primary_contact')::BOOLEAN ELSE is_primary_contact END
             WHERE id = v_guardian_id AND studio_id = p_studio_id;
        ELSE
            INSERT INTO public.guardians (
                studio_id, first_name, last_name, email, phone, relation, is_primary_contact
            ) VALUES (
                p_studio_id, v_guardian_first_name, btrim(v_guardian->>'last_name'),
                NULLIF(btrim(v_guardian->>'email'), ''), NULLIF(btrim(v_guardian->>'phone'), ''),
                NULLIF(btrim(v_guardian->>'relation'), ''),
                COALESCE((v_guardian->>'is_primary_contact')::BOOLEAN, false)
            ) RETURNING * INTO v_guardian_row;
            INSERT INTO public.student_guardians (student_id, guardian_id)
            VALUES (p_student_id, v_guardian_row.id);
        END IF;
    END LOOP;

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
                p_student || CASE WHEN jsonb_array_length(p_guardians) > 0 THEN jsonb_build_object('guardians', p_guardians) ELSE '{}'::JSONB END
        END
    );

    RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION private.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) TO service_role;


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
              '0:d1f6f4860761c34c91500447eb7efa014b1d35c87a338e2bdcd188805edcb1b8'
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

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() FROM PUBLIC, anon, authenticated, service_role;

-- The private profile writer and minor/conversion behavior intentionally change
-- this resource contract. The correction accepts only its reviewed V53 value.
DO $expectation$
BEGIN
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256 = 'd4d730c0911b63e8fe9cd13ed5f42b156430062f6f9aa547cabafaf3e3aed94d'
    WHERE expectation_key = 'operational_contract_v31'
      AND expected_sha256 = 'd0fa5043cb92f8f2f8be7e7be1ab2487f12492a1ddcb5d8d76412bf093c05a00';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'V54 operational expectation does not match its reviewed predecessor.';
    END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v35()
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
    IF v_count <> 149 OR v_head <> '20260930024404' THEN
        v_failures := array_append(v_failures, 'migration_history_v54');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:cc83187a494c1f05ac0abb2bdb77ad9bf63764f4e2962c15f32004b8ae01fc91' THEN
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
       <> '0:80b98274fd3e19fc0f578d7f6a79a5279275687fc92c373226d495152bdcd67d' THEN
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
       <> 'ca52395c369ff3e9846f242de058d62e915cdb25e8908ca5b392740b18dd4e68' THEN
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
       IS DISTINCT FROM '7a59a108e5aa8e9ef9311956bbec7de7784e718d246557ce3909221f91f0956e' THEN
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
       <> '0:70e87b852a84f9fcad61413ea8660fdf9d5adcb028ec03427f30d815e42526b6' THEN
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
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','9af84c3c261a4ddb8aad9bc1c9cc332260fb1e31b1e7f51816b402339e2ad576'),
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
              = '78890d7907bb56bfdb337df262b17cc5144f8bd87d169df26a10fc048072670f'
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
        WHERE n.nspname='public' AND p.proname='bind_student_import_rank_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'e428fbeb91f8457bf717917bd93685531188d49d25b003eb2bd6ab7f184f2e68'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_bind_student_import_rank_v1_v45');
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
              = '7b61469ec2de918d7f79effa3a52c590b3eef9416c2ba716f1b6d9cfc91669bb'
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
       IS DISTINCT FROM '0:dc6043dd0992042b9e27d0fb73a49f4abe0acd06a6b9bfb500d68e7e85ab5daf' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'feed7c0421cbeb5bcb2555837dd1c244367f180c8a884380f2f281ef919c82ee' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_definition_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='begin_billing_enrollment_activation_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'a104d7696ec9a711358697783ca065c9d78233ffa4c63d77633c8fcf42ff5e59'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_begin_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='reject_billing_autopay_activation_without_provider_v31') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'b2bee4e53471d0a949ff4533f7ab14938c4fc919e8c97ce8d767f854bc876b44'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_rejection_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.billing_subscriptions'::REGCLASS
          AND a.attname IN ('currency','billing_interval') AND NOT a.attisdropped
          AND a.atttypid='text'::REGTYPE AND NOT a.attnotnull AND d.oid IS NULL
          AND a.attidentity='' AND a.attgenerated='') IS DISTINCT FROM 2 THEN
        v_failures:=array_append(v_failures,'subscription_terms_v49');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_invoice_collection_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_invoice_collection_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '40d16d06464c028c1bd4a27089163181865cd65a8ce963b1738ee0abe3c5eacc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'invoice_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_payer_balance_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_payer_balance_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'f81f1d839e26e5fe0abe9bf84af7bcb58c654f88cea4107f4e97b1cf993492b4'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='list_billing_payers_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.list_billing_payers_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='jsonb'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ca4a6d2d6657cf82900a315b492af687a42be2fd1a6a3cad296119f6be72ff8d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_read_projection_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_attention_count_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_attention_count_v1(uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='integer'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '4e57973f97038e57ec411c502960453b07d5f59374ab0e2bc856a42ecbb7e036'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'billing_attention_count_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='update_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.update_lead_atomic(uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '141eff02dc1b430336270aee0aa48e281f42b8e1a82b2656bfd4e31b58b615cb'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'update_lead_atomic_v52');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='follow_up_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '128596070e145066d03b1289ef37ef791c8ad46cf3176ba4241448bcae4dc348'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'follow_up_lead_atomic_v52');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
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
            'policies',(SELECT jsonb_agg(jsonb_build_array(policy.polname,policy.polcmd,policy.polpermissive,
                (SELECT jsonb_agg(pg_catalog.pg_get_userbyid(role_oid)::TEXT ORDER BY pg_catalog.pg_get_userbyid(role_oid)::TEXT COLLATE "C") FROM unnest(policy.polroles) role_oid),
                pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid)) ORDER BY policy.polname COLLATE "C")
                FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('public.lead_follow_up_operations')
          AND relation.relkind='r')::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '796b4c0fe4d033966248b78138776b6695dfbc80bdab7e0e9026b6c9745318cb' THEN
        v_failures:=array_append(v_failures,'lead_follow_up_operations_v52');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '350a7ffbea0fab5fe570d6243a5b22fa0ed6d528053bebf5ccfb2f6e7433cec6' THEN
        v_failures := array_append(v_failures, 'dashboard_summary_facts_v53');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(jsonb_build_object(
        'signature',required.signature,'exists',function.oid IS NOT NULL,
        'definition',pg_catalog.pg_get_functiondef(function.oid),'body',function.prosrc,
        'owner',pg_catalog.pg_get_userbyid(function.proowner),'language',language.lanname,
        'volatility',function.provolatile,'security_definer',function.prosecdef,
        'strict',function.proisstrict,'parallel',function.proparallel,
        'config',function.proconfig,'result',pg_catalog.pg_get_function_result(function.oid),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
            ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT COLLATE "C",acl.privilege_type,acl.is_grantable)
            FROM pg_catalog.aclexplode(COALESCE(function.proacl,pg_catalog.acldefault('f',function.proowner))) acl)
        ) ORDER BY required.signature COLLATE "C")
        FROM (VALUES
            ('public.student_business_date(uuid)'),
            ('public.validate_student_birth_date()'),
            ('public.set_student_is_minor()'),
            ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
            ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')
        ) required(signature)
        LEFT JOIN pg_catalog.pg_proc function ON function.oid=pg_catalog.to_regprocedure(required.signature)
        LEFT JOIN pg_catalog.pg_language language ON language.oid=function.prolang),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',required.name,'expected_function',required.signature,
        'exists',trigger_row.oid IS NOT NULL,
        'binding_matches',trigger_row.tgfoid=pg_catalog.to_regprocedure(required.signature),
        'definition',pg_catalog.pg_get_triggerdef(trigger_row.oid),
        'enabled',trigger_row.tgenabled,'type',trigger_row.tgtype,
        'arguments',encode(trigger_row.tgargs,'hex'),
        'internal',trigger_row.tgisinternal,'constraint',trigger_row.tgconstraint<>0,
        'deferrable',trigger_row.tgdeferrable,'initially_deferred',trigger_row.tginitdeferred
        ) ORDER BY required.name COLLATE "C")
        FROM (VALUES ('set_students_is_minor','public.set_student_is_minor()'),
            ('validate_students_birth_date','public.validate_student_birth_date()')) required(name,signature)
        LEFT JOIN pg_catalog.pg_trigger trigger_row
          ON trigger_row.tgrelid=pg_catalog.to_regclass('public.students') AND trigger_row.tgname=required.name)
    ))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '9c677c2dc39dd42bda08c1da53826d94dd876d687dbaf920a2597be8a8e8b586' THEN
        v_failures:=array_append(v_failures,'student_profile_facts_v54');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v54'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v34()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v35();
    IF v.ready IS TRUE AND v.migration_count = 149 AND v.migration_head = '20260930024404'
       AND v.manifest_version = 'release-db-attestation-v54'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 65
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260930024404' THEN
        RETURN QUERY SELECT TRUE, 148, '20260929152445'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v53'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v53'::TEXT;
END;
$function$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v35() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v35() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v35() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v34() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v34() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v34() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v35();
    IF v.migration_count IS DISTINCT FROM 148 OR v.migration_head IS DISTINCT FROM '20260929152445'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v54',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V54 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
