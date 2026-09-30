-- Restore already-converted lead enrollment after the frozen V54 checkpoint.
-- No backfill: only an explicit conversion or enrolled follow-up restores a lead.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(
        (SELECT p.prosrc FROM pg_catalog.pg_proc p
         WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v35()')),
        'UTF8'),'sha256'),'hex') IS DISTINCT FROM '69a374912298547b8b29899125b3ddc77b79bf61568b5ffae00dc01085db1e06' THEN
        RAISE EXCEPTION 'V55 requires the reviewed V54 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v35();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 149
       OR v.migration_head IS DISTINCT FROM '20260930024404'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v54'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 65
       OR v.pending_versions[65] IS DISTINCT FROM '20260930024404' THEN
        RAISE EXCEPTION 'V55 requires a fully verified V54 predecessor.';
    END IF;
END;
$predecessor$;

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
    SELECT *
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
      AND studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead not found for studio.';
    END IF;

    -- Conversion identity is permanent even when an ordinary edit moves the lead
    -- backwards. Re-enrollment restores only lead state, never student details,
    -- program membership or guardians. It needs no active/new program selection.
    IF v_lead.converted_student_id IS NOT NULL THEN
        IF v_lead.stage = 'enrolled' AND v_lead.follow_up_date IS NULL THEN
            RETURN v_lead;
        END IF;
        UPDATE public.leads
        SET stage = 'enrolled', follow_up_date = NULL
        WHERE id = p_lead_id AND studio_id = p_studio_id
        RETURNING * INTO v_updated;
        IF v_lead.stage IS DISTINCT FROM 'enrolled' THEN
            INSERT INTO public.lead_activities (
                studio_id, lead_id, activity_type, description, created_by
            ) VALUES (
                p_studio_id, p_lead_id, 'stage_change',
                'Stage changed from ' || v_lead.stage || ' to enrolled', p_actor_id
            );
        END IF;
        RETURN v_updated;
    END IF;

    IF p_program_id IS NULL THEN
        RAISE EXCEPTION 'Lead conversion requires a program id.';
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

CREATE OR REPLACE FUNCTION public.follow_up_lead_atomic(
    p_studio_id UUID, p_actor_id UUID, p_lead_id UUID, p_operation_id UUID, p_request JSONB
)
RETURNS public.leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
    v_lead public.leads;
    v_result public.leads;
    v_receipt public.lead_follow_up_operations;
    v_request JSONB;
    v_stage TEXT;
    v_program UUID;
    v_program_archived TIMESTAMPTZ;
    v_student UUID;
    v_guardian UUID;
    v_link UUID;
    v_digest BYTEA;
    v_timezone TEXT;
    v_start DATE;
BEGIN
    -- Use the existing narrow Auth-owner helper before locking memberships or
    -- leads. Account cleanup locks Auth first and then visits these FK children.
    IF NOT private.lock_student_import_actor(p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
          AND user_id=p_actor_id AND archived_at IS NULL
          AND role IN ('admin','front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    PERFORM 1 FROM public.staff_roles
    WHERE studio_id=p_studio_id AND user_id=p_actor_id
      AND archived_at IS NULL AND role IN ('admin','front_desk') FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    -- Use the same membership-before-studio order as staff administration.
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END;
    IF p_operation_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='A keyed follow-up request is required.';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) AS fields(name) WHERE name <> 'next_stage')
       OR (p_request ? 'next_stage' AND jsonb_typeof(p_request->'next_stage') NOT IN ('null','string')) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported follow-up request.';
    END IF;
    v_stage := p_request->>'next_stage';
    IF v_stage IS NOT NULL AND v_stage <> ALL(ARRAY['inquiry','trial_scheduled','trial_completed',
        'offer_sent','enrolled','closed_lost']) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported follow-up stage.';
    END IF;
    -- Keep conversion authorization explicit even while its roles match lead management.
    IF v_stage='enrolled' AND NOT EXISTS(SELECT 1 FROM public.staff_roles
        WHERE studio_id=p_studio_id AND user_id=p_actor_id AND archived_at IS NULL
        AND role IN ('admin','front_desk')) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead conversion permission required.';
    END IF;
    v_request := jsonb_build_object('next_stage',v_stage);
    -- A global operation identity also rejects reuse for another tenant or lead.
    -- This lock precedes the lead lock for every follow-up caller.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'lead-follow-up:' || p_operation_id::text,0));
    SELECT * INTO v_receipt FROM public.lead_follow_up_operations WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF v_receipt.studio_id IS DISTINCT FROM p_studio_id
           OR v_receipt.actor_id IS DISTINCT FROM p_actor_id
           OR v_receipt.lead_id IS DISTINCT FROM p_lead_id
           OR v_receipt.request IS DISTINCT FROM v_request THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Follow-up operation identity conflict.';
        END IF;
        RETURN jsonb_populate_record(NULL::public.leads,v_receipt.result);
    END IF;
    SELECT * INTO v_lead FROM public.leads
    WHERE id=p_lead_id AND studio_id=p_studio_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Lead not found for studio.';
    END IF;
    IF v_stage='enrolled' THEN
        IF v_lead.converted_student_id IS NOT NULL THEN
            -- Restoring the existing conversion must also work after the lead's
            -- original program was archived or its interest was cleared.
            SELECT * INTO v_result FROM public.convert_lead_to_student_atomic(
                p_studio_id,p_actor_id,p_lead_id,v_lead.converted_student_id,
                NULL,NULL,NULL,NULL,NULL);
        ELSE
            v_program := v_lead.program_id;
            IF v_program IS NULL THEN
                SELECT id INTO v_program FROM public.programs
                WHERE studio_id=p_studio_id AND name='Unassigned' LIMIT 1;
                IF v_program IS NULL THEN
                    INSERT INTO public.programs(studio_id,name,description,color_hex,sort_order,is_system)
                    VALUES(p_studio_id,'Unassigned','Students awaiting program assignment.','#94A3B8',9999,TRUE)
                    ON CONFLICT (studio_id,lower(name)) WHERE archived_at IS NULL DO NOTHING
                    RETURNING id INTO v_program;
                    IF v_program IS NULL THEN
                        SELECT id INTO v_program FROM public.programs
                        WHERE studio_id=p_studio_id AND name='Unassigned' AND archived_at IS NULL;
                    END IF;
                END IF;
            END IF;
            SELECT archived_at INTO v_program_archived FROM public.programs
            WHERE id=v_program AND studio_id=p_studio_id FOR SHARE;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Program not found for studio.';
            END IF;
            IF v_program_archived IS NOT NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='PROGRAM_INACTIVE', DETAIL=v_program::text;
            END IF;
            -- RFC 4122 UUIDv5, identical to LeadService's established namespace/names.
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(p_studio_id::text || ':' || p_lead_id::text || ':student','UTF8'),'sha1') FROM 1 FOR 16);
            v_student := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(p_studio_id::text || ':' || p_lead_id::text || ':guardian','UTF8'),'sha1') FROM 1 FOR 16);
            v_guardian := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(v_student::text || ':' || v_guardian::text || ':link','UTF8'),'sha1') FROM 1 FOR 16);
            v_link := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            SELECT COALESCE(NULLIF(timezone,''),'UTC') INTO v_timezone FROM public.studios WHERE id=p_studio_id;
            IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v_timezone) THEN
                v_timezone := 'UTC';
            END IF;
            v_start := (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::date;
            SELECT * INTO v_result FROM public.convert_lead_to_student_atomic(p_studio_id,p_actor_id,p_lead_id,
                v_student,v_program,'active',v_start,v_guardian,v_link);
        END IF;
    ELSE
        SELECT * INTO v_result FROM public.update_lead_atomic(p_studio_id,p_actor_id,p_lead_id,
            jsonb_build_object('follow_up_date',NULL) ||
            CASE WHEN v_stage IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stage',v_stage) END);
    END IF;
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
    VALUES(p_studio_id,p_lead_id,'follow_up',CASE WHEN v_stage IS NULL THEN 'Contacted lead'
        ELSE 'Contacted lead and moved to ' || v_stage END,p_actor_id);
    INSERT INTO public.lead_follow_up_operations(operation_id,studio_id,actor_id,lead_id,request,result)
    VALUES(p_operation_id,p_studio_id,p_actor_id,p_lead_id,v_request,to_jsonb(v_result));
    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.follow_up_lead_atomic(UUID,UUID,UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.follow_up_lead_atomic(UUID,UUID,UUID,UUID,JSONB) TO service_role;
