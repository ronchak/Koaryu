-- V61 guards acknowledged import identities, reuses guardians, and receipts skipped rows.
-- Legacy row callers keep their original behavior when acknowledgements are NULL.
-- Require the exact supported predecessor before changing any installed object.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v41();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 155
       OR v.migration_head IS DISTINCT FROM '20261021093000'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v60' THEN
        RAISE EXCEPTION 'V61 requires exact V60 readiness: %', row_to_json(v);
    END IF;
END;
$predecessor$;


ALTER TABLE public.students
    ADD COLUMN import_run_id UUID NULL REFERENCES public.student_import_runs(id) ON DELETE SET NULL,
    ADD COLUMN source_system TEXT NULL,
    ADD COLUMN source_id TEXT NULL,
    ADD CONSTRAINT students_source_pair_check CHECK ((source_system IS NULL) = (source_id IS NULL)),
    ADD CONSTRAINT students_source_system_length_check CHECK (source_system IS NULL OR char_length(btrim(source_system)) BETWEEN 1 AND 120),
    ADD CONSTRAINT students_source_id_length_check CHECK (source_id IS NULL OR char_length(btrim(source_id)) BETWEEN 1 AND 120);
CREATE UNIQUE INDEX students_studio_source_identity_unique
    ON public.students(studio_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX students_studio_normalized_legal_name_idx
    ON public.students(studio_id, lower(btrim(legal_last_name)), lower(btrim(legal_first_name)));
ALTER TABLE public.guardians
    ADD COLUMN import_run_id UUID NULL REFERENCES public.student_import_runs(id) ON DELETE SET NULL;
ALTER TABLE private.student_import_receipts DROP CONSTRAINT student_import_receipts_kind_check;
ALTER TABLE private.student_import_receipts ADD CONSTRAINT student_import_receipts_kind_check
    CHECK (kind IN ('student', 'program', 'ladder', 'rank', 'skipped'));

-- Drop both old signatures so named calls cannot resolve to an old overload.
DROP FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]);
DROP FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[]);

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
    p_program_ids UUID[] DEFAULT NULL,
    p_acknowledged_student_ids UUID[] DEFAULT NULL,
    p_guardian_id UUID DEFAULT NULL,
    p_source_system TEXT DEFAULT NULL,
    p_source_id TEXT DEFAULT NULL
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
    v_rank_scope UUID;
    v_constraint TEXT;
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

    -- Receipt replay above is deliberately first, even after roster/contact edits.
    IF EXISTS (SELECT 1 FROM private.student_import_receipts r
               WHERE r.import_run_id=p_import_run_id AND r.kind='skipped' AND r.key=p_row_number::TEXT) THEN
        RAISE EXCEPTION 'Student import row was already skipped.' USING ERRCODE='22023';
    END IF;
    IF p_acknowledged_student_ids IS NOT NULL THEN
        -- Dedicated two-int namespace. Other import/rank/workflow users use the
        -- disjoint bigint namespace; the two-int onboarding/alert namespaces differ.
        -- JSON array encoding keeps name boundaries unambiguous.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext('koaryu.student-import-identity.v61'),
            pg_catalog.hashtext(jsonb_build_array(p_studio_id,
                lower(btrim(v_student.legal_last_name)), lower(btrim(v_student.legal_first_name)))::TEXT));
        IF EXISTS (
            SELECT 1 FROM public.students existing
            WHERE existing.studio_id=p_studio_id
              AND lower(btrim(existing.legal_last_name))=lower(btrim(v_student.legal_last_name))
              AND lower(btrim(existing.legal_first_name))=lower(btrim(v_student.legal_first_name))
              AND ((existing.date_of_birth IS NOT NULL AND v_student.date_of_birth IS NOT NULL
                    AND existing.date_of_birth=v_student.date_of_birth)
                   OR ((existing.date_of_birth IS NULL OR v_student.date_of_birth IS NULL)
                       AND NULLIF(lower(btrim(existing.email)), '') IS NOT NULL
                       AND NULLIF(lower(btrim(existing.email)), '')=NULLIF(lower(btrim(v_student.email)), '')))
              AND NOT EXISTS (SELECT 1 FROM unnest(p_acknowledged_student_ids) acknowledged(id)
                              WHERE acknowledged.id=existing.id)
        ) THEN
            RAISE EXCEPTION 'student_import_duplicate_review_required' USING ERRCODE='P0409';
        END IF;
    END IF;
    IF p_guardian_id IS NOT NULL THEN
        PERFORM 1 FROM public.guardians WHERE id=p_guardian_id AND studio_id=p_studio_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'student_import_guardian_not_in_studio' USING ERRCODE='22023';
        END IF;
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

    v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,v_student.id,'import');

    BEGIN
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
            hold_end_date,
            import_run_id,
            source_system,
            source_id
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
            v_student.hold_end_date,
            p_import_run_id,
            p_source_system,
            p_source_id
        );
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint IS DISTINCT FROM 'students_studio_source_identity_unique' THEN RAISE; END IF;
        RAISE EXCEPTION 'student_import_duplicate_review_required' USING ERRCODE='P0409';
    END;

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
    v_guardian_id := p_guardian_id;
    IF v_guardian_id IS NULL AND v_guardian_name IS NOT NULL THEN
        v_guardian_first_name := split_part(v_guardian_name, ' ', 1);
        v_guardian_last_name := NULLIF(btrim(substr(v_guardian_name, length(v_guardian_first_name) + 1)), '');
        v_guardian_id := private.deterministic_import_uuid(
            p_import_run_id,
            'guardian-row:' || p_row_number::TEXT
        );


        INSERT INTO public.guardians (
            id,
            studio_id,
            first_name,
            last_name,
            email,
            phone,
            relation,
            is_primary_contact,
            import_run_id
        )
        VALUES (
            v_guardian_id,
            p_studio_id,
            v_guardian_first_name,
            COALESCE(v_guardian_last_name, ''),
            NULLIF(p_guardian_email, ''),
            NULLIF(p_guardian_phone, ''),
            NULLIF(p_guardian_relation, ''),
            true,
            p_import_run_id
        );

    END IF;
    IF v_guardian_id IS NOT NULL THEN
        v_guardian_link_id := private.deterministic_import_uuid(
            p_import_run_id,
            'student-guardian-link:' || v_student_id::TEXT || ':' || v_guardian_id::TEXT
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
    PERFORM private.workflow_rank_scope_finish_v1(v_rank_scope);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    RETURN NEXT;
END;
$$;
ALTER FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.import_student_row_atomic(
    p_student JSONB, p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT,
    p_row_number INTEGER, p_guardian_name TEXT DEFAULT NULL, p_guardian_email TEXT DEFAULT NULL,
    p_guardian_phone TEXT DEFAULT NULL, p_guardian_relation TEXT DEFAULT NULL, p_program_ids UUID[] DEFAULT NULL,
    p_acknowledged_student_ids UUID[] DEFAULT NULL, p_guardian_id UUID DEFAULT NULL,
    p_source_system TEXT DEFAULT NULL, p_source_id TEXT DEFAULT NULL
)
RETURNS TABLE(student_id UUID, guardian_imported BOOLEAN)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, private AS $$
BEGIN
    RETURN QUERY SELECT * FROM private.import_student_row_atomic(p_student, p_studio_id, p_import_run_id,
        p_processing_token, p_row_number, p_guardian_name, p_guardian_email, p_guardian_phone,
        p_guardian_relation, p_program_ids, p_acknowledged_student_ids, p_guardian_id,
        p_source_system, p_source_id);
END;
$$;
ALTER FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_student_row_atomic(JSONB, UUID, UUID, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, UUID[], UUID[], UUID, TEXT, TEXT) TO service_role;

CREATE FUNCTION private.record_student_import_skip_v1(
    p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT, p_row_number INTEGER, p_result JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_run public.student_import_runs%ROWTYPE; v_receipt JSONB;
BEGIN
    v_run := private.lock_student_import_run(p_studio_id,p_import_run_id,p_processing_token);
    IF NOT v_run.receipts_enabled THEN
        RAISE EXCEPTION 'This unfinished import has no safe retry receipts.' USING ERRCODE='22023';
    END IF;
    SELECT r.result_json INTO v_receipt FROM private.student_import_receipts r
    WHERE r.import_run_id=p_import_run_id AND r.kind='skipped' AND r.key=p_row_number::TEXT;
    IF FOUND THEN RETURN v_receipt; END IF;
    IF p_row_number IS NULL OR p_row_number NOT BETWEEN 2 AND 10001
       OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
       OR p_result->>'action' IS DISTINCT FROM 'skip'
       OR COALESCE(p_result->>'retained_kind','') NOT IN ('existing','row')
       OR jsonb_typeof(p_result->'outcome') IS DISTINCT FROM 'object'
       OR (p_result->'outcome'->>'row_number')::INTEGER IS DISTINCT FROM p_row_number
       OR p_result->'outcome'->'is_valid' IS DISTINCT FROM 'true'::JSONB
       OR jsonb_typeof(p_result->'outcome'->'issues') IS DISTINCT FROM 'array'
       OR jsonb_typeof(p_result->'outcome'->'data') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Student import skip facts are required.' USING ERRCODE='22023';
    END IF;
    IF p_result->>'retained_kind'='existing' THEN
        IF NULLIF(p_result->>'retained_id_or_row','')::UUID IS NULL THEN
            RAISE EXCEPTION 'Student import skip target is required.' USING ERRCODE='22023';
        END IF;
    ELSE
        IF COALESCE((p_result->>'retained_id_or_row')::INTEGER,0) NOT BETWEEN 2 AND p_row_number-1 THEN
            RAISE EXCEPTION 'Student import skip target must be an earlier row.' USING ERRCODE='22023';
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM private.student_import_receipts r
               WHERE r.import_run_id=p_import_run_id AND r.kind='student' AND r.key=p_row_number::TEXT) THEN
        RAISE EXCEPTION 'Student import row was already imported.' USING ERRCODE='22023';
    END IF;
    INSERT INTO private.student_import_receipts(import_run_id,kind,key,result_json)
    VALUES(p_import_run_id,'skipped',p_row_number::TEXT,p_result);
    UPDATE public.student_import_runs SET processing_started_at=clock_timestamp() WHERE id=p_import_run_id;
    RETURN p_result;
END;
$$;
ALTER FUNCTION private.record_student_import_skip_v1(UUID,UUID,TEXT,INTEGER,JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_student_import_skip_v1(UUID,UUID,TEXT,INTEGER,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.record_student_import_skip_v1(UUID,UUID,TEXT,INTEGER,JSONB) TO service_role;
CREATE FUNCTION public.record_student_import_skip_v1(
    p_studio_id UUID, p_import_run_id UUID, p_processing_token TEXT, p_row_number INTEGER, p_result JSONB
) RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
    SELECT private.record_student_import_skip_v1(p_studio_id,p_import_run_id,p_processing_token,p_row_number,p_result);
$$;
ALTER FUNCTION public.record_student_import_skip_v1(UUID,UUID,TEXT,INTEGER,JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_student_import_skip_v1(UUID,UUID,TEXT,INTEGER,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_student_import_skip_v1(UUID,UUID,TEXT,INTEGER,JSONB) TO service_role;

-- Keep the rank-writer security manifest bound to the replacement signatures.
CREATE OR REPLACE FUNCTION private.koaryu_release_student_rank_writer_manifest_v11()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
WITH required_functions(signature, expected_config) AS (
    VALUES
        (
            'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'search_path=pg_catalog, public, private'
        ),
        (
            'private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'search_path=public, pg_temp'
        ),
        (
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[], uuid[], uuid, text, text)',
            'search_path=pg_catalog, public, private'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[], uuid[], uuid, text, text)',
            'search_path=public, pg_temp'
        )
),
function_actual AS (
    SELECT
        format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) AS signature,
        owner.rolname AS owner_name,
        language.lanname AS language_name,
        function.prosecdef AS security_definer,
        COALESCE(array_to_string(function.proconfig, ','), '') AS config,
        EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
        ) AS public_execute,
        has_function_privilege('anon', function.oid, 'EXECUTE') AS anon_execute,
        has_function_privilege('authenticated', function.oid, 'EXECUTE') AS authenticated_execute,
        has_function_privilege('service_role', function.oid, 'EXECUTE') AS service_execute,
        encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') AS body_sha256,
        COALESCE((
            SELECT string_agg(
                COALESCE(grantor.rolname, 'PUBLIC') || '>' ||
                COALESCE(grantee.rolname, 'PUBLIC') || ':' ||
                acl.privilege_type || ':' || acl.is_grantable::TEXT,
                ',' ORDER BY
                    COALESCE(grantor.rolname, 'PUBLIC') COLLATE "C",
                    COALESCE(grantee.rolname, 'PUBLIC') COLLATE "C",
                    acl.privilege_type COLLATE "C",
                    acl.is_grantable
            )
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
        ), '') AS acl_state,
        EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee <> function.proowner
              AND NOT (
                  grantee.rolname = 'service_role'
                  AND NOT acl.is_grantable
              )
        ) AS unexpected_execute_grant
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
    JOIN pg_language language ON language.oid = function.prolang
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.*,
        actual.owner_name,
        actual.language_name,
        actual.security_definer,
        actual.config,
        actual.public_execute,
        actual.anon_execute,
        actual.authenticated_execute,
        actual.service_execute,
        actual.body_sha256,
        actual.acl_state,
        actual.unexpected_execute_grant
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
invalid AS (
    SELECT count(*) AS invalid_count
    FROM function_compared function
    WHERE function.owner_name IS DISTINCT FROM 'postgres'
       OR function.language_name IS DISTINCT FROM 'plpgsql'
       OR function.security_definer IS DISTINCT FROM FALSE
       OR function.config IS DISTINCT FROM function.expected_config
       OR function.public_execute IS DISTINCT FROM FALSE
       OR function.anon_execute IS DISTINCT FROM FALSE
       OR function.authenticated_execute IS DISTINCT FROM FALSE
       OR function.service_execute IS DISTINCT FROM TRUE
       OR function.unexpected_execute_grant IS DISTINCT FROM FALSE
       OR function.body_sha256 IS NULL
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            COALESCE(string_agg(
                function.signature || ':' || concat_ws('|',
                    function.owner_name,
                    function.language_name,
                    function.security_definer::TEXT,
                    function.config,
                    function.public_execute::TEXT,
                    function.anon_execute::TEXT,
                    function.authenticated_execute::TEXT,
                    function.service_execute::TEXT,
                    function.body_sha256,
                    function.acl_state,
                    function.unexpected_execute_grant::TEXT
                ),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN invalid
GROUP BY invalid.invalid_count;
$function$;

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
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[], uuid[], uuid, text, text)',
            'TABLE(student_id uuid, guardian_imported boolean)'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[], uuid[], uuid, text, text)',
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
              '0:853352745bfe609f4b959e3aba16cc6fbda240f90bf891244325b8c7a64c10d3'
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


-- Only the named inherited expectation changes; all business rows remain untouched.
DO $expectation$
DECLARE changed INTEGER;
BEGIN
    IF private.koaryu_release_operational_contract_v31() IS DISTINCT FROM '0:07b11682181bce027a3434161a54cd9426d45ee1ecd0a9f663d15601ad8b0880' THEN
        RAISE EXCEPTION 'V61 inherited operational contract did not match reviewed facts.';
    END IF;
    UPDATE private.koaryu_release_v31_expectations SET expected_sha256='07b11682181bce027a3434161a54cd9426d45ee1ecd0a9f663d15601ad8b0880'
    WHERE expectation_key='operational_contract_v31' AND expected_sha256='1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1 THEN
        RAISE EXCEPTION 'V61 requires the exact V60 expectation singleton.';
    END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v42()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET TimeZone TO 'UTC'
 SET DateStyle TO 'ISO, YMD'
 SET IntervalStyle TO 'postgres'
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
    IF v_count <> 156 OR v_head <> '20261022190000' THEN
        v_failures := array_append(v_failures, 'migration_history_v61');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435','20261005105341','20261013013243','20261014083106','20261021093000','20261022190000'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:a1cbe02ca722dd6903bbc1e47b03a171908e3d22525a024dfac682f6e64e9d2c' THEN
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
       <> '0:eaae3521154ebb1416b3efc95d49f69a2aa583d236a4710b03fda985dae691c0' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:9c6c6f80b94c0412170e2ae59a8d8f1243c3fd049852e50e551592c1d389de07' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:8ca312d765bde9dff26086e888638ee12eb49da8d028e33e6e01455c500e1fdd' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:ad66d5b59dcf033b05cc3a9c3eaece3943972b9e197cbcc55854e3f3aee8b99b' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:1c245a6142a2e9ca2d3249d8772530798cca4ab8a0d9fe9059277f1c37501a4e' THEN
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
       <> '6bd9219671f61de0ac124efaacc894af329b6d86e8c092aa4ff65f614eedffa7' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:9f285d9d386666f8b42a6ce9d2c04eac3a6f897f979bb4e8d47c81c318ab5c53' THEN
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
       <> '0:45cb113e37c4ded47a36179688cb2cb5159567b949ffd038e74a63ee9f35ea73' THEN
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
       IS DISTINCT FROM '3782ef46a8a7dfd9ff0486c0320271f2cc1e0fde207a044bcf02f8cf8624d646' THEN
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
              = 'fd4f3a1e65eef9f113ac8a648b72d45d84c5d9261e6436bd4aabe6c4643221fd'
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
        WHERE p.oid=pg_catalog.to_regprocedure('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '003a8a502feba36e59d83af4de6a18550eec3ea102509e34af6b33cab8208bbe'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_import_student_row_atomic_v61');
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
        WHERE p.oid=pg_catalog.to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, private']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '4f9abc433f09c62f38e50ae5b1eb53aea56fc72215c399e67827ed1b5ff881f0'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_import_student_row_atomic_v61');
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
          AND relation.relkind='r') IS DISTINCT FROM '{"acl":[["postgres","postgres","DELETE",false],["postgres","postgres","INSERT",false],["postgres","postgres","MAINTAIN",false],["postgres","postgres","REFERENCES",false],["postgres","postgres","SELECT",false],["postgres","postgres","TRIGGER",false],["postgres","postgres","TRUNCATE",false],["postgres","postgres","UPDATE",false],["service_role","postgres","INSERT",false],["service_role","postgres","SELECT",false]],"rls":false,"owner":"postgres","columns":[["import_run_id","uuid",true,null,"","",true],["kind","text",true,null,"","",true],["key","text",true,null,"","",true],["result_json","jsonb",true,null,"","",true],["created_at","timestamp with time zone",true,"now()","","",true]],"indexes":[["student_import_receipts_pkey",true,true,true,true,"CREATE UNIQUE INDEX student_import_receipts_pkey ON private.student_import_receipts USING btree (import_run_id, kind, key)"]],"force_rls":false,"constraints":[["student_import_receipts_import_run_id_fkey","f",true,false,false,"FOREIGN KEY (import_run_id) REFERENCES public.student_import_runs(id) ON DELETE CASCADE"],["student_import_receipts_key_check","c",true,false,false,"CHECK (((char_length(key) >= 1) AND (char_length(key) <= 512)))"],["student_import_receipts_kind_check","c",true,false,false,"CHECK ((kind = ANY (ARRAY[''student''::text, ''program''::text, ''ladder''::text, ''rank''::text, ''skipped''::text])))"],["student_import_receipts_pkey","p",true,false,false,"PRIMARY KEY (import_run_id, kind, key)"],["student_import_receipts_result_json_check","c",true,false,false,"CHECK ((jsonb_typeof(result_json) = ''object''::text))"]],"no_policies":true,"no_user_triggers":true}'::JSONB
       OR (SELECT jsonb_build_array(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
                attribute.attnotnull,pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL)
            FROM pg_catalog.pg_attribute attribute LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=pg_catalog.to_regclass('public.student_import_runs')
              AND attribute.attname='receipts_enabled' AND NOT attribute.attisdropped)
          IS DISTINCT FROM '["boolean",true,"false","","",true]'::JSONB THEN
        v_failures:=array_append(v_failures,'import_receipts_v61');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       IS DISTINCT FROM '0:e6878b6d40f5b4a83e0a61526b20c7c838f0d27ec5e1f9646d8495e0af17de74' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'e05b48659eabb9481dac3a805f5a31035fd6e91b426a4cdf2d8d52a47376a076' THEN
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
              = '087249d003c83cf7fed72445b36499e3b7e01d492ad9de479d4e7f320ad5661f'
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
              = '85d7ed82167d8306a22f3bebe0b4f16b08455eb8b6c01a8a3a3beef747900235'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'follow_up_lead_atomic_v55');
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
       <> 'dd58f2a2c3c37fe7f1bdf08b71d3090757c0af077b36f04fd13f52218bdd3a66' THEN
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
       IS DISTINCT FROM '5019c71d16f8154cd54d17ac21ff9931f04c1050f436cfc6fa78ffe7cc18ea2f' THEN
        v_failures:=array_append(v_failures,'student_profile_facts_v55');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='convert_lead_to_student_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ce9cd28c7191ca26f8a931a79c729bfbafb545527ed0e38a23ce045fe3b0adb8'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'convert_lead_to_student_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('public.automation_rules'),('public.automation_deliveries'),
    ('public.automation_suppressions'),('private.automation_email_credentials')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '2cac874e09752d14ad6ff1ca72bca38b278d9ffb05ad1b15c6e1b2c9c02afe53' THEN
        v_failures:=array_append(v_failures,'automation_tables_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES
    ('private.automation_delivery_immutable()'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)')
) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '3087ce899d3a4215d1876868e16148bdd0826d2dd6793271e0ef10835dd9e97c' THEN
        v_failures:=array_append(v_failures,'automation_functions_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('private.automation_command_operations'),
    ('private.automation_email_attempt_reservations'),
    ('private.automation_email_credentials'),
    ('private.automation_sender_gate'),
    ('private.automation_sender_preparations'),
    ('private.automation_test_email_payloads'),
    ('private.automation_test_email_scopes'),
    ('private.automation_unsubscribe_token_bindings'),
    ('private.automation_workflow_dispatch_cursor'),
    ('private.automation_workflow_email_attempts'),
    ('private.automation_workflow_events'),
    ('private.automation_workflow_follow_up_actions'),
    ('private.automation_workflow_run_steps'),
    ('private.billing_invoice_retry_hash_capture_control_v33'),
    ('private.billing_invoice_retry_hash_ledger_v33'),
    ('private.koaryu_release_v26_expectations'),
    ('private.koaryu_release_v27_expectations'),
    ('private.koaryu_release_v28_expectations'),
    ('private.koaryu_release_v29_expectations'),
    ('private.koaryu_release_v30_expectations'),
    ('private.koaryu_release_v31_expectations'),
    ('private.koaryu_release_v35_expectations'),
    ('private.koaryu_release_v36_expectations'),
    ('private.koaryu_release_v37_expectations'),
    ('private.stripe_connect_account_identity_guards'),
    ('private.student_import_receipts'),
    ('private.studio_creation_requests'),
    ('private.timezone_names'),
    ('private.workflow_email_attempt_payloads'),
    ('private.workflow_email_unsubscribe_pins'),
    ('private.workflow_invoice_collection_episodes'),
    ('private.workflow_invoice_episode_pending'),
    ('private.workflow_invoice_episode_state'),
    ('private.workflow_invoice_settlement_authority'),
    ('private.workflow_payment_capture_markers'),
    ('private.workflow_payment_settlement_observations'),
    ('private.workflow_rank_contexts'),
    ('private.workflow_rank_pending_contexts'),
    ('private.workflow_rank_pending_events'),
    ('private.workflow_rank_scopes'),
    ('private.workflow_timer_activations'),
    ('private.workflow_timer_dispatch_cursor'),
    ('public.account_deletion_requests'),
    ('public.attendance'),
    ('public.audit_logs'),
    ('public.automation_deliveries'),
    ('public.automation_rules'),
    ('public.automation_suppressions'),
    ('public.automation_workflow_activations'),
    ('public.automation_workflow_runs'),
    ('public.automation_workflow_versions'),
    ('public.automation_workflows'),
    ('public.belt_ladders'),
    ('public.belt_ranks'),
    ('public.belt_test_events'),
    ('public.belt_test_recipients'),
    ('public.billing_adjustments'),
    ('public.billing_disputes'),
    ('public.billing_enrollment_transition_aliases'),
    ('public.billing_enrollment_transition_intents'),
    ('public.billing_invoice_items'),
    ('public.billing_invoice_mutation_owners'),
    ('public.billing_invoice_retry_operation_aliases'),
    ('public.billing_invoice_retry_operations'),
    ('public.billing_invoices'),
    ('public.billing_payer_payment_consents'),
    ('public.billing_payer_setup_requests'),
    ('public.billing_payers'),
    ('public.billing_payments'),
    ('public.billing_plan_prices'),
    ('public.billing_plan_programs'),
    ('public.billing_plans'),
    ('public.billing_provider_operation_resource_aliases'),
    ('public.billing_provider_operation_resources'),
    ('public.billing_provider_operation_steps'),
    ('public.billing_provider_operations'),
    ('public.billing_refunds'),
    ('public.billing_subscriptions'),
    ('public.class_sessions'),
    ('public.class_templates'),
    ('public.email_usage_events'),
    ('public.export_jobs'),
    ('public.guardians'),
    ('public.lead_activities'),
    ('public.lead_follow_up_operations'),
    ('public.lead_trial_appointments'),
    ('public.leads'),
    ('public.operational_alert_audit_events'),
    ('public.operational_alert_delivery_attempts'),
    ('public.operational_alert_delivery_outcomes'),
    ('public.operational_alert_episodes'),
    ('public.operational_alert_heartbeats'),
    ('public.operational_alert_outbox'),
    ('public.programs'),
    ('public.promotions'),
    ('public.staff_profiles'),
    ('public.staff_roles'),
    ('public.stripe_connect_account_dispositions'),
    ('public.stripe_connect_onboarding_bootstraps'),
    ('public.stripe_events'),
    ('public.stripe_live_billing_reconciliation_account_evidence'),
    ('public.stripe_live_billing_reconciliation_checkpoints'),
    ('public.stripe_live_billing_reconciliation_checkpoints_v3'),
    ('public.student_billing_enrollments'),
    ('public.student_guardians'),
    ('public.student_import_runs'),
    ('public.student_program_memberships'),
    ('public.students'),
    ('public.studio_live_billing_authorizations'),
    ('public.studio_payment_accounts'),
    ('public.studio_subscriptions'),
    ('public.studios'),
    ('public.support_ticket_events'),
    ('public.support_tickets')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       NOT IN ('911ef82cb6caebfd422c6361d0983ca2274a9f3716947b51df4bfcc7926669ca','f97b54e8ed453182481472a38841e917031ddcdcd36421b775e17e6178a40ce7','bf4921349a0a58063aa95cd495fce9b3207ce09f8aacaa12dc812f7a84606c59','50d10eefddc4b7445c4105ba8ec49132e9b692be2f5cf3c7c4c393a206c8a0b6')
       OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C")
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p'))
          IS DISTINCT FROM ARRAY['private.automation_command_operations','private.automation_email_attempt_reservations','private.automation_email_credentials','private.automation_sender_gate','private.automation_sender_preparations','private.automation_test_email_payloads','private.automation_test_email_scopes','private.automation_unsubscribe_token_bindings','private.automation_workflow_dispatch_cursor','private.automation_workflow_email_attempts','private.automation_workflow_events','private.automation_workflow_follow_up_actions','private.automation_workflow_run_steps','private.billing_invoice_retry_hash_capture_control_v33','private.billing_invoice_retry_hash_ledger_v33','private.koaryu_release_v26_expectations','private.koaryu_release_v27_expectations','private.koaryu_release_v28_expectations','private.koaryu_release_v29_expectations','private.koaryu_release_v30_expectations','private.koaryu_release_v31_expectations','private.koaryu_release_v35_expectations','private.koaryu_release_v36_expectations','private.koaryu_release_v37_expectations','private.stripe_connect_account_identity_guards','private.student_import_receipts','private.studio_creation_requests','private.timezone_names','private.workflow_email_attempt_payloads','private.workflow_email_unsubscribe_pins','private.workflow_invoice_collection_episodes','private.workflow_invoice_episode_pending','private.workflow_invoice_episode_state','private.workflow_invoice_settlement_authority','private.workflow_payment_capture_markers','private.workflow_payment_settlement_observations','private.workflow_rank_contexts','private.workflow_rank_pending_contexts','private.workflow_rank_pending_events','private.workflow_rank_scopes','private.workflow_timer_activations','private.workflow_timer_dispatch_cursor','public.account_deletion_requests','public.attendance','public.audit_logs','public.automation_deliveries','public.automation_rules','public.automation_suppressions','public.automation_workflow_activations','public.automation_workflow_runs','public.automation_workflow_versions','public.automation_workflows','public.belt_ladders','public.belt_ranks','public.belt_test_events','public.belt_test_recipients','public.billing_adjustments','public.billing_disputes','public.billing_enrollment_transition_aliases','public.billing_enrollment_transition_intents','public.billing_invoice_items','public.billing_invoice_mutation_owners','public.billing_invoice_retry_operation_aliases','public.billing_invoice_retry_operations','public.billing_invoices','public.billing_payer_payment_consents','public.billing_payer_setup_requests','public.billing_payers','public.billing_payments','public.billing_plan_prices','public.billing_plan_programs','public.billing_plans','public.billing_provider_operation_resource_aliases','public.billing_provider_operation_resources','public.billing_provider_operation_steps','public.billing_provider_operations','public.billing_refunds','public.billing_subscriptions','public.class_sessions','public.class_templates','public.email_usage_events','public.export_jobs','public.guardians','public.lead_activities','public.lead_follow_up_operations','public.lead_trial_appointments','public.leads','public.operational_alert_audit_events','public.operational_alert_delivery_attempts','public.operational_alert_delivery_outcomes','public.operational_alert_episodes','public.operational_alert_heartbeats','public.operational_alert_outbox','public.programs','public.promotions','public.staff_profiles','public.staff_roles','public.stripe_connect_account_dispositions','public.stripe_connect_onboarding_bootstraps','public.stripe_events','public.stripe_live_billing_reconciliation_account_evidence','public.stripe_live_billing_reconciliation_checkpoints','public.stripe_live_billing_reconciliation_checkpoints_v3','public.student_billing_enrollments','public.student_guardians','public.student_import_runs','public.student_program_memberships','public.students','public.studio_live_billing_authorizations','public.studio_payment_accounts','public.studio_subscriptions','public.studios','public.support_ticket_events','public.support_tickets']::TEXT[] THEN
        v_failures:=array_append(v_failures,'student_import_tables_v61');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES ('private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)'),
    ('private.automation_bind_unsubscribe_token_v1(uuid,text,text)'),
    ('private.automation_clear_statement_fence_v1()'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_delivery_immutable()'),
    ('private.automation_delivery_result_v1(jsonb,bigint)'),
    ('private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)'),
    ('private.automation_email_attempt_expire_v1(uuid)'),
    ('private.automation_email_attempt_identity_v1()'),
    ('private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)'),
    ('private.automation_expire_orphaned_legacy_attempts_v1(integer)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.automation_instant_v1(jsonb)'),
    ('private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)'),
    ('private.automation_legacy_delivery_delete_v1()'),
    ('private.automation_legacy_delivery_result_v1(jsonb)'),
    ('private.automation_legacy_delivery_transition_v1()'),
    ('private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)'),
    ('private.automation_legacy_projection_valid_v1(jsonb)'),
    ('private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)'),
    ('private.automation_legacy_terminal_v1(jsonb,integer)'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_sender_claim_v1(uuid,text,text,uuid)'),
    ('private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)'),
    ('private.automation_sender_gate_identity_v1()'),
    ('private.automation_sender_gate_lock_v1()'),
    ('private.automation_sender_instant_v1(timestamp with time zone)'),
    ('private.automation_sender_preparation_identity_v1()'),
    ('private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)'),
    ('private.automation_sender_preparation_result_valid_v1(jsonb)'),
    ('private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_sender_release_orphan_probe_v1()'),
    ('private.automation_sender_release_probe_v1(uuid,uuid,uuid)'),
    ('private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)'),
    ('private.automation_test_actor_v1(uuid,uuid)'),
    ('private.automation_test_allowed_v1(text[])'),
    ('private.automation_test_clear_owned_v1(uuid)'),
    ('private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)'),
    ('private.automation_test_expire_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_fail_v1(private.automation_test_email_scopes,text)'),
    ('private.automation_test_invalidate_queued_v1(uuid)'),
    ('private.automation_test_original_v1(uuid,uuid,uuid)'),
    ('private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])'),
    ('private.automation_test_payload_delete_v1()'),
    ('private.automation_test_payload_identity_v1()'),
    ('private.automation_test_rendered_valid_v1(jsonb)'),
    ('private.automation_test_result_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_scope_identity_v1()'),
    ('private.automation_test_verified_email_v1(uuid)'),
    ('private.automation_timezone_v1(jsonb)'),
    ('private.automation_unsubscribe_binding_identity_v1()'),
    ('private.automation_utc_text_v1(timestamp with time zone)'),
    ('private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)'),
    ('private.belt_test_event_payload_v1(public.belt_test_events)'),
    ('private.belt_test_lock_recipient_runs_v1(uuid,uuid[])'),
    ('private.belt_test_name_v1(jsonb)'),
    ('private.belt_test_recipient_identity_v1()'),
    ('private.belt_test_recipient_payload_v1(public.belt_test_recipients)'),
    ('private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)'),
    ('private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)'),
    ('private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)'),
    ('private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)'),
    ('private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)'),
    ('private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)'),
    ('private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)'),
    ('private.billing_plan_resource_version_v31(public.billing_plans,text,integer)'),
    ('private.billing_provider_operation_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)'),
    ('private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)'),
    ('private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)'),
    ('private.bind_live_billing_authorization_checkpoint()'),
    ('private.can_read_staff_profile(uuid)'),
    ('private.capture_billing_invoice_retry_alias_v33()'),
    ('private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)'),
    ('private.capture_billing_invoice_retry_resource_v33()'),
    ('private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)'),
    ('private.clear_studio_operational_data_v2(uuid,boolean)'),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)'),
    ('private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)'),
    ('private.current_connect_account_generation(jsonb)'),
    ('private.deterministic_import_uuid(uuid,text)'),
    ('private.enforce_billing_payer_connect_identity_v1()'),
    ('private.enforce_billing_payment_refundable_amount_v31()'),
    ('private.enforce_billing_provider_step_parent_v1()'),
    ('private.enforce_live_billing_checkpoint_processed_events()'),
    ('private.enforce_single_studio_membership()'),
    ('private.handle_invoice_retry_consent_change_v33(uuid,uuid)'),
    ('private.has_unambiguous_studio_membership()'),
    ('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)'),
    ('private.is_admin_in_studio(uuid)'),
    ('private.is_admin_or_front_desk_in_studio(uuid)'),
    ('private.is_staff_in_studio(uuid)'),
    ('private.koaryu_release_adjustment_trigger_guard_manifest_v37()'),
    ('private.koaryu_release_critical_surface_manifest_v14()'),
    ('private.koaryu_release_critical_surface_manifest_v15()'),
    ('private.koaryu_release_critical_surface_manifest_v16()'),
    ('private.koaryu_release_critical_surface_manifest_v17()'),
    ('private.koaryu_release_critical_surface_manifest_v18()'),
    ('private.koaryu_release_enrollment_transition_manifest_v29()'),
    ('private.koaryu_release_invoice_retry_closeout_manifest_v34()'),
    ('private.koaryu_release_invoice_retry_compatibility_manifest_v33()'),
    ('private.koaryu_release_invoice_retry_preread_manifest_v32()'),
    ('private.koaryu_release_live_billing_v3_manifest_v25()'),
    ('private.koaryu_release_operational_contract_v25()'),
    ('private.koaryu_release_operational_contract_v26()'),
    ('private.koaryu_release_operational_contract_v27()'),
    ('private.koaryu_release_operational_contract_v28()'),
    ('private.koaryu_release_operational_contract_v29()'),
    ('private.koaryu_release_operational_contract_v30()'),
    ('private.koaryu_release_operational_contract_v31()'),
    ('private.koaryu_release_operational_manifest_v10()'),
    ('private.koaryu_release_operational_manifest_v11()'),
    ('private.koaryu_release_operational_manifest_v12()'),
    ('private.koaryu_release_operational_manifest_v2()'),
    ('private.koaryu_release_operational_manifest_v2_base()'),
    ('private.koaryu_release_operational_manifest_v4()'),
    ('private.koaryu_release_operational_manifest_v5()'),
    ('private.koaryu_release_operational_manifest_v6()'),
    ('private.koaryu_release_operational_manifest_v7()'),
    ('private.koaryu_release_operational_manifest_v8()'),
    ('private.koaryu_release_operational_manifest_v9()'),
    ('private.koaryu_release_payer_setup_recovery_manifest_v36()'),
    ('private.koaryu_release_payment_adjustment_manifest_v26()'),
    ('private.koaryu_release_payments_replay_repairs_manifest_v30()'),
    ('private.koaryu_release_provider_operation_steps_manifest_v28()'),
    ('private.koaryu_release_provider_operations_manifest_v27()'),
    ('private.koaryu_release_resource_ownership_manifest_v31()'),
    ('private.koaryu_release_schedule_window_manifest_v1()'),
    ('private.koaryu_release_schema_preflight_v14_snapshot_v34()'),
    ('private.koaryu_release_starting_belt_manifest_v9()'),
    ('private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()'),
    ('private.koaryu_release_student_rank_writer_manifest_v11()'),
    ('private.koaryu_release_student_rank_writer_manifest_v12()'),
    ('private.koaryu_release_student_rank_writer_manifest_v13()'),
    ('private.live_billing_event_is_in_scope(text,text)'),
    ('private.live_billing_ga_events_clear_v58()'),
    ('private.live_billing_ga_operations_v58(text)'),
    ('private.live_billing_operation_set_is_canonical_v1(text,text[])'),
    ('private.lock_student_import_actor(uuid)'),
    ('private.lock_student_import_run(uuid,uuid,text)'),
    ('private.maintain_billing_invoice_mutation_owner_v31()'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('private.preserve_billing_enrollment_transition_identity_v1()'),
    ('private.preserve_billing_invoice_mutation_owner_v31()'),
    ('private.preserve_billing_invoice_retry_hash_ledger_v33()'),
    ('private.preserve_billing_payer_payment_consent_v1()'),
    ('private.preserve_billing_payer_setup_request_v1()'),
    ('private.preserve_billing_provider_operation_identity_v1()'),
    ('private.preserve_billing_provider_operation_resource_alias_v1()'),
    ('private.preserve_billing_provider_operation_resource_v1()'),
    ('private.preserve_billing_provider_operation_step_v1()'),
    ('private.prevent_account_deletion_orphan()'),
    ('private.prevent_staff_admin_orphan()'),
    ('private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'),
    ('private.recompute_billing_payment_adjustment_totals(uuid)'),
    ('private.recompute_payment_after_adjustment_change()'),
    ('private.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)'),
    ('private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)'),
    ('private.reject_billing_enrollment_transition_alias_mutation_v1()'),
    ('private.reject_consent_change_during_invoice_retry_v31()'),
    ('private.reject_payer_change_during_invoice_retry_v31()'),
    ('private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)'),
    ('private.set_audit_actor_legal_name()'),
    ('private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)'),
    ('private.sync_connect_identity_exclusion_guard()'),
    ('private.sync_connect_identity_mapping_guard()'),
    ('private.timezone_name_known(text)'),
    ('private.timezone_name_or_utc(text)'),
    ('private.trial_appointment_payload_v1(public.lead_trial_appointments)'),
    ('private.trial_rebooking_marker_v1()'),
    ('private.validate_billing_adjustment_payment_identity()'),
    ('private.validate_billing_payment_identity_change()'),
    ('private.workflow_activation_immutable_v1()'),
    ('private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)'),
    ('private.workflow_blank_v1(jsonb)'),
    ('private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)'),
    ('private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])'),
    ('private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)'),
    ('private.workflow_capture_events_v1(uuid,jsonb,jsonb)'),
    ('private.workflow_capture_payment_failure_v1()'),
    ('private.workflow_catalog_v1()'),
    ('private.workflow_condition_result_v1(text,text,jsonb,jsonb)'),
    ('private.workflow_current_rank_authority_v1(uuid,uuid,uuid)'),
    ('private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])'),
    ('private.workflow_current_staff_recipient_v1(uuid,uuid)'),
    ('private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_delay_due_identity_v1()'),
    ('private.workflow_detail_v1(uuid,uuid)'),
    ('private.workflow_email_attempt_identity_v1()'),
    ('private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)'),
    ('private.workflow_email_fingerprint_v1(jsonb,jsonb)'),
    ('private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)'),
    ('private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('private.workflow_email_parameters_valid_v1(text,text[],text,text)'),
    ('private.workflow_email_payload_delete_v1()'),
    ('private.workflow_email_payload_identity_v1()'),
    ('private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)'),
    ('private.workflow_email_project_settlement_v1(uuid,boolean)'),
    ('private.workflow_email_rendered_valid_v1(jsonb)'),
    ('private.workflow_email_selected_values_v1(jsonb,jsonb)'),
    ('private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)'),
    ('private.workflow_expire_email_attempts_v1(integer)'),
    ('private.workflow_fact_text_v1(text)'),
    ('private.workflow_finalize_invoice_episode_deferred_v1()'),
    ('private.workflow_finalize_invoice_episodes_v1()'),
    ('private.workflow_finalize_rank_deferred_v1()'),
    ('private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)'),
    ('private.workflow_follow_up_receipt_identity_v1()'),
    ('private.workflow_graph_read_issues_v1(uuid,jsonb)'),
    ('private.workflow_hash_v1(jsonb)'),
    ('private.workflow_immutable_record_v1()'),
    ('private.workflow_integer_v1(jsonb,bigint,bigint)'),
    ('private.workflow_invoice_episode_context_valid_v1(jsonb)'),
    ('private.workflow_invoice_episode_identity_v1()'),
    ('private.workflow_invoice_episode_pending_identity_v1()'),
    ('private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)'),
    ('private.workflow_invoice_episode_state_identity_v1()'),
    ('private.workflow_invoice_episode_threshold_v1(date,text)'),
    ('private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_invoice_settlement_identity_v1()'),
    ('private.workflow_invoice_settlement_seed_v1()'),
    ('private.workflow_json_keys_v1(jsonb,text[],text[])'),
    ('private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])'),
    ('private.workflow_lock_lead_assignee_v1(uuid)'),
    ('private.workflow_lock_recipient_auth_v1(uuid)'),
    ('private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)'),
    ('private.workflow_lock_timed_sources_v1(jsonb)'),
    ('private.workflow_mark_invoice_episode_v1()'),
    ('private.workflow_mark_payer_episode_demo_v1()'),
    ('private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)'),
    ('private.workflow_observe_payment_settlement_v1(uuid,uuid)'),
    ('private.workflow_payment_evidence_v1(public.billing_payments)'),
    ('private.workflow_payment_evidence_valid_v1(jsonb)'),
    ('private.workflow_payment_settlement_valid_v1(uuid,uuid)'),
    ('private.workflow_prepare_capture_v1(uuid,uuid[],boolean)'),
    ('private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)'),
    ('private.workflow_rank_compare_pending_v1(uuid,uuid)'),
    ('private.workflow_rank_context_generation_v1(uuid,uuid,uuid)'),
    ('private.workflow_rank_context_identity_v1()'),
    ('private.workflow_rank_finalize_pending_v1(uuid)'),
    ('private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)'),
    ('private.workflow_rank_scope_enter_v1(uuid,uuid,text)'),
    ('private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)'),
    ('private.workflow_rank_tuple_v1(uuid,uuid,uuid)'),
    ('private.workflow_require_actor_v1(uuid,uuid,boolean)'),
    ('private.workflow_require_graph_tenant_v1(uuid,jsonb)'),
    ('private.workflow_run_detail_v1(uuid,uuid)'),
    ('private.workflow_run_identity_v1()'),
    ('private.workflow_run_position_v1(public.automation_workflow_runs)'),
    ('private.workflow_run_step_identity_v1()'),
    ('private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)'),
    ('private.workflow_run_subject_label_v1(private.automation_workflow_events)'),
    ('private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)'),
    ('private.workflow_semantic_graph_v1(jsonb)'),
    ('private.workflow_settlement_observation_identity_v1()'),
    ('private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)'),
    ('private.workflow_staff_auth_email_v1(uuid,uuid)'),
    ('private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)'),
    ('private.workflow_timed_candidates_v1(integer,timestamp with time zone)'),
    ('private.workflow_timer_activation_identity_v1()'),
    ('private.workflow_timer_activation_insert_v1()'),
    ('private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)'),
    ('private.workflow_trigger_event_type_v1(jsonb)'),
    ('private.workflow_typed_value_v1(jsonb,jsonb)'),
    ('private.workflow_validate_v1(jsonb,jsonb,boolean)'),
    ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)'),
    ('public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)'),
    ('public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)'),
    ('public.acknowledge_operational_alert(text,uuid,text,text)'),
    ('public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)'),
    ('public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.archive_students_bulk_atomic(uuid,uuid,uuid[])'),
    ('public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)'),
    ('public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)'),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)'),
    ('public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)'),
    ('public.backfill_starting_belt_after_rank_delete()'),
    ('public.backfill_starting_belt_for_program()'),
    ('public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)'),
    ('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)'),
    ('public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)'),
    ('public.billing_attention_count_v1(uuid,date)'),
    ('public.billing_invoice_collection_facts_v1(uuid,uuid,date)'),
    ('public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_payer_balance_facts_v1(uuid,uuid,date)'),
    ('public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_webhook_health(text,boolean,timestamp with time zone)'),
    ('public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)'),
    ('public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)'),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)'),
    ('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)'),
    ('public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)'),
    ('public.claim_automation_sender_preparation_v1(text,uuid,text)'),
    ('public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])'),
    ('public.claim_automation_workflow_runs_v1(integer)'),
    ('public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)'),
    ('public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)'),
    ('public.claim_due_account_deletion_requests(integer,text,integer)'),
    ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.claim_operational_alert_delivery(text,text,uuid,integer)'),
    ('public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)'),
    ('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)'),
    ('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)'),
    ('public.clear_studio_comp_for_billing_event(uuid,bigint)'),
    ('public.clear_studio_operational_data_atomic(uuid,boolean)'),
    ('public.clear_studio_operational_data_v2(uuid,boolean)'),
    ('public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)'),
    ('public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)'),
    ('public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)'),
    ('public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)'),
    ('public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)'),
    ('public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)'),
    ('public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)'),
    ('public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)'),
    ('public.complete_operational_alert_delivery(uuid,text,text)'),
    ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
    ('public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)'),
    ('public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)'),
    ('public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)'),
    ('public.create_studio_onboarding(uuid,text,text,text)'),
    ('public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)'),
    ('public.dashboard_summary_facts(uuid,text,text,date,text)'),
    ('public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.delete_recurring_class_series_atomic(uuid,uuid,uuid)'),
    ('public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)'),
    ('public.enforce_operational_alert_sent_receipt()'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)'),
    ('public.fail_operational_alert_delivery(uuid,text,text,integer)'),
    ('public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)'),
    ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)'),
    ('public.finish_account_deletion_request(uuid,text,text,text)'),
    ('public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)'),
    ('public.finish_billing_subscription_quantity_sync(uuid,uuid,text)'),
    ('public.finish_stripe_event_processing(uuid,text,text,text)'),
    ('public.finish_stripe_event_processing_v2(uuid,text,text,text,text)'),
    ('public.finish_student_import_run(uuid,text,text,jsonb,text)'),
    ('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.get_automation_operation_v1(uuid,uuid,uuid)'),
    ('public.get_automation_sender_status_v1(text)'),
    ('public.get_automation_test_email_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_run_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)'),
    ('public.get_automation_workflow_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_event_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('public.heartbeat_student_import_run(uuid,text)'),
    ('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)'),
    ('public.invalidate_core_checkout_on_comp_grant()'),
    ('public.koaryu_release_schema_preflight()'),
    ('public.koaryu_release_schema_preflight_v10()'),
    ('public.koaryu_release_schema_preflight_v11()'),
    ('public.koaryu_release_schema_preflight_v12()'),
    ('public.koaryu_release_schema_preflight_v13()'),
    ('public.koaryu_release_schema_preflight_v14()'),
    ('public.koaryu_release_schema_preflight_v15()'),
    ('public.koaryu_release_schema_preflight_v16()'),
    ('public.koaryu_release_schema_preflight_v17()'),
    ('public.koaryu_release_schema_preflight_v18()'),
    ('public.koaryu_release_schema_preflight_v19()'),
    ('public.koaryu_release_schema_preflight_v2()'),
    ('public.koaryu_release_schema_preflight_v20()'),
    ('public.koaryu_release_schema_preflight_v21()'),
    ('public.koaryu_release_schema_preflight_v22()'),
    ('public.koaryu_release_schema_preflight_v23()'),
    ('public.koaryu_release_schema_preflight_v24()'),
    ('public.koaryu_release_schema_preflight_v25()'),
    ('public.koaryu_release_schema_preflight_v26()'),
    ('public.koaryu_release_schema_preflight_v27()'),
    ('public.koaryu_release_schema_preflight_v28()'),
    ('public.koaryu_release_schema_preflight_v29()'),
    ('public.koaryu_release_schema_preflight_v3()'),
    ('public.koaryu_release_schema_preflight_v30()'),
    ('public.koaryu_release_schema_preflight_v31()'),
    ('public.koaryu_release_schema_preflight_v32()'),
    ('public.koaryu_release_schema_preflight_v33()'),
    ('public.koaryu_release_schema_preflight_v34()'),
    ('public.koaryu_release_schema_preflight_v35()'),
    ('public.koaryu_release_schema_preflight_v36()'),
    ('public.koaryu_release_schema_preflight_v37()'),
    ('public.koaryu_release_schema_preflight_v38()'),
    ('public.koaryu_release_schema_preflight_v39()'),
    ('public.koaryu_release_schema_preflight_v4()'),
    ('public.koaryu_release_schema_preflight_v40()'),
    ('public.koaryu_release_schema_preflight_v41()'),
    ('public.koaryu_release_schema_preflight_v5()'),
    ('public.koaryu_release_schema_preflight_v6()'),
    ('public.koaryu_release_schema_preflight_v7()'),
    ('public.koaryu_release_schema_preflight_v8()'),
    ('public.koaryu_release_schema_preflight_v9()'),
    ('public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])'),
    ('public.list_billing_payers_v1(uuid,uuid,date)'),
    ('public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)'),
    ('public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)'),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)'),
    ('public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)'),
    ('public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.materialize_recurring_class_sessions(uuid,date,date)'),
    ('public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)'),
    ('public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)'),
    ('public.operational_alert_heartbeats(text)'),
    ('public.operational_alert_metric_counts()'),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid,text)'),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid,text)'),
    ('public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)'),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)'),
    ('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)'),
    ('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)'),
    ('public.preserve_billing_invoice_retry_operation_created_at()'),
    ('public.preserve_studio_comp_provenance()'),
    ('public.prevent_operational_alert_append_only_mutation()'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.process_automation_workflow_occurrences_v1(integer)'),
    ('public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)'),
    ('public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)'),
    ('public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)'),
    ('public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)'),
    ('public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)'),
    ('public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)'),
    ('public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)'),
    ('public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])'),
    ('public.reassign_memberships_before_belt_rank_delete()'),
    ('public.recompute_billing_invoice_external_payment_totals(uuid,uuid)'),
    ('public.recompute_billing_payer_balance_v1(uuid,uuid)'),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)'),
    ('public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)'),
    ('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)'),
    ('public.record_operational_alert_heartbeat(text,text,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)'),
    ('public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)'),
    ('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)'),
    ('public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)'),
    ('public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)'),
    ('public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)'),
    ('public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)'),
    ('public.reserve_core_checkout_atomic(uuid)'),
    ('public.reserve_core_checkout_v2_atomic(uuid)'),
    ('public.reset_stripe_connect_account_atomic_v58(uuid,uuid,text,integer)'),
    ('public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)'),
    ('public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)'),
    ('public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)'),
    ('public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.schedule_window_read(uuid,date,date,text)'),
    ('public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)'),
    ('public.set_student_is_minor()'),
    ('public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'),
    ('public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)'),
    ('public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)'),
    ('public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)'),
    ('public.snapshot_promotion_rank_identity()'),
    ('public.soft_delete_student_atomic(uuid,uuid,uuid)'),
    ('public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)'),
    ('public.student_business_date(uuid)'),
    ('public.studio_live_billing_supported_operations_v58(uuid,text)'),
    ('public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.support_triage_digest(integer)'),
    ('public.support_triage_list_tickets(text[],text[],text[],integer)'),
    ('public.support_triage_update_ticket(uuid,text,text,jsonb)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)'),
    ('public.sync_primary_student_rank_from_membership()'),
    ('public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)'),
    ('public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)'),
    ('public.update_lead_atomic(uuid,uuid,uuid,jsonb)'),
    ('public.update_updated_at_column()'),
    ('public.validate_attendance_program_integrity()'),
    ('public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)'),
    ('public.validate_billing_adjustment_refs()'),
    ('public.validate_billing_dispute_refs()'),
    ('public.validate_billing_invoice_item_refs()'),
    ('public.validate_billing_invoice_refs()'),
    ('public.validate_billing_payer_guardian()'),
    ('public.validate_billing_payment_refs()'),
    ('public.validate_billing_plan_program()'),
    ('public.validate_billing_refund_refs()'),
    ('public.validate_billing_subscription_refs()'),
    ('public.validate_class_session_program_integrity()'),
    ('public.validate_class_template_program_integrity()'),
    ('public.validate_lead_program_integrity()'),
    ('public.validate_student_billing_enrollment()'),
    ('public.validate_student_birth_date()'),
    ('public.validate_student_guardian_tenant_integrity()'),
    ('public.validate_student_profile_tenant_integrity()'),
    ('public.validate_student_program_membership()'),
    ('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])'),
    ('public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '01c812d272398ae6e0189ea12f5f68b6c039d2fb3955f043cf6c7314adc7439b'
       OR (SELECT array_agg(p.oid::REGPROCEDURE::TEXT ORDER BY p.oid::REGPROCEDURE::TEXT COLLATE "C")
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname IN ('public','private') AND p.prokind='f'
             AND p.oid <> pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v42()'))
          IS DISTINCT FROM ARRAY['private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)','private.automation_bind_unsubscribe_token_v1(uuid,text,text)','private.automation_clear_statement_fence_v1()','private.automation_core_entitled(uuid)','private.automation_delivery_immutable()','private.automation_delivery_result_v1(jsonb,bigint)','private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)','private.automation_email_attempt_expire_v1(uuid)','private.automation_email_attempt_identity_v1()','private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)','private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)','private.automation_expire_orphaned_legacy_attempts_v1(integer)','private.automation_has_actionable_work(text[])','private.automation_instant_v1(jsonb)','private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)','private.automation_legacy_delivery_delete_v1()','private.automation_legacy_delivery_result_v1(jsonb)','private.automation_legacy_delivery_transition_v1()','private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)','private.automation_legacy_projection_valid_v1(jsonb)','private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)','private.automation_legacy_terminal_v1(jsonb,integer)','private.automation_normalize_email(text)','private.automation_require_admin(uuid,uuid)','private.automation_sender_claim_v1(uuid,text,text,uuid)','private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)','private.automation_sender_gate_identity_v1()','private.automation_sender_gate_lock_v1()','private.automation_sender_instant_v1(timestamp with time zone)','private.automation_sender_preparation_identity_v1()','private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)','private.automation_sender_preparation_result_valid_v1(jsonb)','private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)','private.automation_sender_release_orphan_probe_v1()','private.automation_sender_release_probe_v1(uuid,uuid,uuid)','private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)','private.automation_test_actor_v1(uuid,uuid)','private.automation_test_allowed_v1(text[])','private.automation_test_clear_owned_v1(uuid)','private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)','private.automation_test_expire_v1(private.automation_test_email_scopes)','private.automation_test_fail_v1(private.automation_test_email_scopes,text)','private.automation_test_invalidate_queued_v1(uuid)','private.automation_test_original_v1(uuid,uuid,uuid)','private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])','private.automation_test_payload_delete_v1()','private.automation_test_payload_identity_v1()','private.automation_test_rendered_valid_v1(jsonb)','private.automation_test_result_v1(private.automation_test_email_scopes)','private.automation_test_scope_identity_v1()','private.automation_test_verified_email_v1(uuid)','private.automation_timezone_v1(jsonb)','private.automation_unsubscribe_binding_identity_v1()','private.automation_utc_text_v1(timestamp with time zone)','private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)','private.belt_test_event_payload_v1(public.belt_test_events)','private.belt_test_lock_recipient_runs_v1(uuid,uuid[])','private.belt_test_name_v1(jsonb)','private.belt_test_recipient_identity_v1()','private.belt_test_recipient_payload_v1(public.belt_test_recipients)','private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)','private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)','private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)','private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)','private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)','private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)','private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)','private.billing_plan_resource_version_v31(public.billing_plans,text,integer)','private.billing_provider_operation_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)','private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)','private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)','private.bind_live_billing_authorization_checkpoint()','private.can_read_staff_profile(uuid)','private.capture_billing_invoice_retry_alias_v33()','private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)','private.capture_billing_invoice_retry_resource_v33()','private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)','private.clear_studio_operational_data_v2(uuid,boolean)','private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)','private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)','private.current_connect_account_generation(jsonb)','private.deterministic_import_uuid(uuid,text)','private.enforce_billing_payer_connect_identity_v1()','private.enforce_billing_payment_refundable_amount_v31()','private.enforce_billing_provider_step_parent_v1()','private.enforce_live_billing_checkpoint_processed_events()','private.enforce_single_studio_membership()','private.handle_invoice_retry_consent_change_v33(uuid,uuid)','private.has_unambiguous_studio_membership()','private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)','private.is_admin_in_studio(uuid)','private.is_admin_or_front_desk_in_studio(uuid)','private.is_staff_in_studio(uuid)','private.koaryu_release_adjustment_trigger_guard_manifest_v37()','private.koaryu_release_critical_surface_manifest_v14()','private.koaryu_release_critical_surface_manifest_v15()','private.koaryu_release_critical_surface_manifest_v16()','private.koaryu_release_critical_surface_manifest_v17()','private.koaryu_release_critical_surface_manifest_v18()','private.koaryu_release_enrollment_transition_manifest_v29()','private.koaryu_release_invoice_retry_closeout_manifest_v34()','private.koaryu_release_invoice_retry_compatibility_manifest_v33()','private.koaryu_release_invoice_retry_preread_manifest_v32()','private.koaryu_release_live_billing_v3_manifest_v25()','private.koaryu_release_operational_contract_v25()','private.koaryu_release_operational_contract_v26()','private.koaryu_release_operational_contract_v27()','private.koaryu_release_operational_contract_v28()','private.koaryu_release_operational_contract_v29()','private.koaryu_release_operational_contract_v30()','private.koaryu_release_operational_contract_v31()','private.koaryu_release_operational_manifest_v10()','private.koaryu_release_operational_manifest_v11()','private.koaryu_release_operational_manifest_v12()','private.koaryu_release_operational_manifest_v2()','private.koaryu_release_operational_manifest_v2_base()','private.koaryu_release_operational_manifest_v4()','private.koaryu_release_operational_manifest_v5()','private.koaryu_release_operational_manifest_v6()','private.koaryu_release_operational_manifest_v7()','private.koaryu_release_operational_manifest_v8()','private.koaryu_release_operational_manifest_v9()','private.koaryu_release_payer_setup_recovery_manifest_v36()','private.koaryu_release_payment_adjustment_manifest_v26()','private.koaryu_release_payments_replay_repairs_manifest_v30()','private.koaryu_release_provider_operation_steps_manifest_v28()','private.koaryu_release_provider_operations_manifest_v27()','private.koaryu_release_resource_ownership_manifest_v31()','private.koaryu_release_schedule_window_manifest_v1()','private.koaryu_release_schema_preflight_v14_snapshot_v34()','private.koaryu_release_starting_belt_manifest_v9()','private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()','private.koaryu_release_student_rank_writer_manifest_v11()','private.koaryu_release_student_rank_writer_manifest_v12()','private.koaryu_release_student_rank_writer_manifest_v13()','private.live_billing_event_is_in_scope(text,text)','private.live_billing_ga_events_clear_v58()','private.live_billing_ga_operations_v58(text)','private.live_billing_operation_set_is_canonical_v1(text,text[])','private.lock_student_import_actor(uuid)','private.lock_student_import_run(uuid,uuid,text)','private.maintain_billing_invoice_mutation_owner_v31()','private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)','private.preserve_billing_enrollment_transition_identity_v1()','private.preserve_billing_invoice_mutation_owner_v31()','private.preserve_billing_invoice_retry_hash_ledger_v33()','private.preserve_billing_payer_payment_consent_v1()','private.preserve_billing_payer_setup_request_v1()','private.preserve_billing_provider_operation_identity_v1()','private.preserve_billing_provider_operation_resource_alias_v1()','private.preserve_billing_provider_operation_resource_v1()','private.preserve_billing_provider_operation_step_v1()','private.prevent_account_deletion_orphan()','private.prevent_staff_admin_orphan()','private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','private.recompute_billing_payment_adjustment_totals(uuid)','private.recompute_payment_after_adjustment_change()','private.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)','private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)','private.reject_billing_enrollment_transition_alias_mutation_v1()','private.reject_consent_change_during_invoice_retry_v31()','private.reject_payer_change_during_invoice_retry_v31()','private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)','private.set_audit_actor_legal_name()','private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)','private.sync_connect_identity_exclusion_guard()','private.sync_connect_identity_mapping_guard()','private.timezone_name_known(text)','private.timezone_name_or_utc(text)','private.trial_appointment_payload_v1(public.lead_trial_appointments)','private.trial_rebooking_marker_v1()','private.validate_billing_adjustment_payment_identity()','private.validate_billing_payment_identity_change()','private.workflow_activation_immutable_v1()','private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)','private.workflow_blank_v1(jsonb)','private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)','private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])','private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)','private.workflow_capture_events_v1(uuid,jsonb,jsonb)','private.workflow_capture_payment_failure_v1()','private.workflow_catalog_v1()','private.workflow_condition_result_v1(text,text,jsonb,jsonb)','private.workflow_current_rank_authority_v1(uuid,uuid,uuid)','private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])','private.workflow_current_staff_recipient_v1(uuid,uuid)','private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_delay_due_identity_v1()','private.workflow_detail_v1(uuid,uuid)','private.workflow_email_attempt_identity_v1()','private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)','private.workflow_email_fingerprint_v1(jsonb,jsonb)','private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)','private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)','private.workflow_email_parameters_valid_v1(text,text[],text,text)','private.workflow_email_payload_delete_v1()','private.workflow_email_payload_identity_v1()','private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)','private.workflow_email_project_settlement_v1(uuid,boolean)','private.workflow_email_rendered_valid_v1(jsonb)','private.workflow_email_selected_values_v1(jsonb,jsonb)','private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)','private.workflow_expire_email_attempts_v1(integer)','private.workflow_fact_text_v1(text)','private.workflow_finalize_invoice_episode_deferred_v1()','private.workflow_finalize_invoice_episodes_v1()','private.workflow_finalize_rank_deferred_v1()','private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)','private.workflow_follow_up_receipt_identity_v1()','private.workflow_graph_read_issues_v1(uuid,jsonb)','private.workflow_hash_v1(jsonb)','private.workflow_immutable_record_v1()','private.workflow_integer_v1(jsonb,bigint,bigint)','private.workflow_invoice_episode_context_valid_v1(jsonb)','private.workflow_invoice_episode_identity_v1()','private.workflow_invoice_episode_pending_identity_v1()','private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)','private.workflow_invoice_episode_state_identity_v1()','private.workflow_invoice_episode_threshold_v1(date,text)','private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)','private.workflow_invoice_settlement_identity_v1()','private.workflow_invoice_settlement_seed_v1()','private.workflow_json_keys_v1(jsonb,text[],text[])','private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])','private.workflow_lock_lead_assignee_v1(uuid)','private.workflow_lock_recipient_auth_v1(uuid)','private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)','private.workflow_lock_timed_sources_v1(jsonb)','private.workflow_mark_invoice_episode_v1()','private.workflow_mark_payer_episode_demo_v1()','private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)','private.workflow_observe_payment_settlement_v1(uuid,uuid)','private.workflow_payment_evidence_v1(public.billing_payments)','private.workflow_payment_evidence_valid_v1(jsonb)','private.workflow_payment_settlement_valid_v1(uuid,uuid)','private.workflow_prepare_capture_v1(uuid,uuid[],boolean)','private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)','private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)','private.workflow_rank_compare_pending_v1(uuid,uuid)','private.workflow_rank_context_generation_v1(uuid,uuid,uuid)','private.workflow_rank_context_identity_v1()','private.workflow_rank_finalize_pending_v1(uuid)','private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)','private.workflow_rank_scope_enter_v1(uuid,uuid,text)','private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)','private.workflow_rank_tuple_v1(uuid,uuid,uuid)','private.workflow_require_actor_v1(uuid,uuid,boolean)','private.workflow_require_graph_tenant_v1(uuid,jsonb)','private.workflow_run_detail_v1(uuid,uuid)','private.workflow_run_identity_v1()','private.workflow_run_position_v1(public.automation_workflow_runs)','private.workflow_run_step_identity_v1()','private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)','private.workflow_run_subject_label_v1(private.automation_workflow_events)','private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)','private.workflow_semantic_graph_v1(jsonb)','private.workflow_settlement_observation_identity_v1()','private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)','private.workflow_staff_auth_email_v1(uuid,uuid)','private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)','private.workflow_timed_candidates_v1(integer,timestamp with time zone)','private.workflow_timer_activation_identity_v1()','private.workflow_timer_activation_insert_v1()','private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)','private.workflow_trigger_event_type_v1(jsonb)','private.workflow_typed_value_v1(jsonb,jsonb)','private.workflow_validate_v1(jsonb,jsonb,boolean)','private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)','public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)','public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)','public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)','public.acknowledge_operational_alert(text,uuid,text,text)','public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)','public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.archive_students_bulk_atomic(uuid,uuid,uuid[])','public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)','public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)','public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)','public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)','public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)','public.backfill_starting_belt_after_rank_delete()','public.backfill_starting_belt_for_program()','public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)','public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)','public.begin_missed_class_automation_v1(uuid,uuid,text[])','public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)','public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)','public.billing_attention_count_v1(uuid,date)','public.billing_invoice_collection_facts_v1(uuid,uuid,date)','public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)','public.billing_payer_balance_facts_v1(uuid,uuid,date)','public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)','public.billing_webhook_health(text,boolean,timestamp with time zone)','public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)','public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)','public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)','public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)','public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)','public.claim_automation_sender_preparation_v1(text,uuid,text)','public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])','public.claim_automation_workflow_runs_v1(integer)','public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)','public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)','public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)','public.claim_due_account_deletion_requests(integer,text,integer)','public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)','public.claim_missed_class_automations_v1(integer,text[])','public.claim_operational_alert_delivery(text,text,uuid,integer)','public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)','public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)','public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)','public.clear_studio_comp_for_billing_event(uuid,bigint)','public.clear_studio_operational_data_atomic(uuid,boolean)','public.clear_studio_operational_data_v2(uuid,boolean)','public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)','public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)','public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)','public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)','public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)','public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)','public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)','public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)','public.complete_operational_alert_delivery(uuid,text,text)','public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)','public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)','public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)','public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)','public.create_studio_onboarding(uuid,text,text,text)','public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)','public.dashboard_summary_facts(uuid,text,text,date,text)','public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)','public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])','public.delete_recurring_class_series_atomic(uuid,uuid,uuid)','public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)','public.enforce_operational_alert_sent_receipt()','public.enqueue_missed_class_automations_v1(integer,text[])','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)','public.fail_operational_alert_delivery(uuid,text,text,integer)','public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)','public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)','public.finish_account_deletion_request(uuid,text,text,text)','public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)','public.finish_billing_subscription_quantity_sync(uuid,uuid,text)','public.finish_stripe_event_processing(uuid,text,text,text)','public.finish_stripe_event_processing_v2(uuid,text,text,text,text)','public.finish_student_import_run(uuid,text,text,jsonb,text)','public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)','public.get_automation_email_credential_v1(text)','public.get_automation_operation_v1(uuid,uuid,uuid)','public.get_automation_sender_status_v1(text)','public.get_automation_test_email_v1(uuid,uuid,uuid)','public.get_automation_workflow_run_v1(uuid,uuid,uuid)','public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)','public.get_automation_workflow_v1(uuid,uuid,uuid)','public.get_belt_test_event_v1(uuid,uuid,uuid)','public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)','public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)','public.get_missed_class_automation_activity_v1(uuid,uuid,integer)','public.get_missed_class_automation_rule_v1(uuid,uuid)','public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)','public.heartbeat_student_import_run(uuid,text)','public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[],uuid[],uuid,text,text)','public.invalidate_core_checkout_on_comp_grant()','public.koaryu_release_schema_preflight()','public.koaryu_release_schema_preflight_v10()','public.koaryu_release_schema_preflight_v11()','public.koaryu_release_schema_preflight_v12()','public.koaryu_release_schema_preflight_v13()','public.koaryu_release_schema_preflight_v14()','public.koaryu_release_schema_preflight_v15()','public.koaryu_release_schema_preflight_v16()','public.koaryu_release_schema_preflight_v17()','public.koaryu_release_schema_preflight_v18()','public.koaryu_release_schema_preflight_v19()','public.koaryu_release_schema_preflight_v2()','public.koaryu_release_schema_preflight_v20()','public.koaryu_release_schema_preflight_v21()','public.koaryu_release_schema_preflight_v22()','public.koaryu_release_schema_preflight_v23()','public.koaryu_release_schema_preflight_v24()','public.koaryu_release_schema_preflight_v25()','public.koaryu_release_schema_preflight_v26()','public.koaryu_release_schema_preflight_v27()','public.koaryu_release_schema_preflight_v28()','public.koaryu_release_schema_preflight_v29()','public.koaryu_release_schema_preflight_v3()','public.koaryu_release_schema_preflight_v30()','public.koaryu_release_schema_preflight_v31()','public.koaryu_release_schema_preflight_v32()','public.koaryu_release_schema_preflight_v33()','public.koaryu_release_schema_preflight_v34()','public.koaryu_release_schema_preflight_v35()','public.koaryu_release_schema_preflight_v36()','public.koaryu_release_schema_preflight_v37()','public.koaryu_release_schema_preflight_v38()','public.koaryu_release_schema_preflight_v39()','public.koaryu_release_schema_preflight_v4()','public.koaryu_release_schema_preflight_v40()','public.koaryu_release_schema_preflight_v41()','public.koaryu_release_schema_preflight_v5()','public.koaryu_release_schema_preflight_v6()','public.koaryu_release_schema_preflight_v7()','public.koaryu_release_schema_preflight_v8()','public.koaryu_release_schema_preflight_v9()','public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)','public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)','public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])','public.list_billing_payers_v1(uuid,uuid,date)','public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)','public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)','public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)','public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)','public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)','public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.materialize_recurring_class_sessions(uuid,date,date)','public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)','public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)','public.operational_alert_heartbeats(text)','public.operational_alert_metric_counts()','public.preflight_connect_onboarding_bootstrap_begin(uuid,text)','public.preflight_connect_onboarding_bootstrap_resume(uuid,text)','public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)','public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)','public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)','public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)','public.preserve_billing_invoice_retry_operation_created_at()','public.preserve_studio_comp_provenance()','public.prevent_operational_alert_append_only_mutation()','public.preview_missed_class_automation_v1(uuid,uuid,integer)','public.process_automation_workflow_occurrences_v1(integer)','public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)','public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)','public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)','public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)','public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)','public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)','public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)','public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)','public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])','public.reassign_memberships_before_belt_rank_delete()','public.recompute_billing_invoice_external_payment_totals(uuid,uuid)','public.recompute_billing_payer_balance_v1(uuid,uuid)','public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)','public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)','public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)','public.record_operational_alert_heartbeat(text,text,text)','public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)','public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)','public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)','public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)','public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)','public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)','public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)','public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)','public.reserve_core_checkout_atomic(uuid)','public.reserve_core_checkout_v2_atomic(uuid)','public.reset_stripe_connect_account_atomic_v58(uuid,uuid,text,integer)','public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)','public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)','public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)','public.save_automation_email_credential_v1(text,bigint,text)','public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)','public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)','public.schedule_window_read(uuid,date,date,text)','public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)','public.set_student_is_minor()','public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)','public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)','public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)','public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)','public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)','public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)','public.snapshot_promotion_rank_identity()','public.soft_delete_student_atomic(uuid,uuid,uuid)','public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)','public.student_business_date(uuid)','public.studio_live_billing_supported_operations_v58(uuid,text)','public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)','public.support_triage_digest(integer)','public.support_triage_list_tickets(text[],text[],text[],integer)','public.support_triage_update_ticket(uuid,text,text,jsonb)','public.suppress_missed_class_automation_v1(text)','public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)','public.sync_primary_student_rank_from_membership()','public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)','public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)','public.update_lead_atomic(uuid,uuid,uuid,jsonb)','public.update_updated_at_column()','public.validate_attendance_program_integrity()','public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)','public.validate_billing_adjustment_refs()','public.validate_billing_dispute_refs()','public.validate_billing_invoice_item_refs()','public.validate_billing_invoice_refs()','public.validate_billing_payer_guardian()','public.validate_billing_payment_refs()','public.validate_billing_plan_program()','public.validate_billing_refund_refs()','public.validate_billing_subscription_refs()','public.validate_class_session_program_integrity()','public.validate_class_template_program_integrity()','public.validate_lead_program_integrity()','public.validate_student_billing_enrollment()','public.validate_student_birth_date()','public.validate_student_guardian_tenant_integrity()','public.validate_student_profile_tenant_integrity()','public.validate_student_program_membership()','public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])','public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)']::TEXT[] THEN
        v_failures:=array_append(v_failures,'student_import_functions_v61');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='koaryu_release_schema_preflight_v42') <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v42()')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='s'
          AND p.proretset AND p.proconfig=ARRAY['search_path=pg_catalog','TimeZone=UTC','DateStyle=ISO, YMD','IntervalStyle=postgres']::TEXT[]
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                    a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
             = '[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::JSONB) THEN
        v_failures:=array_append(v_failures,'preflight_security_v61');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='record_student_import_skip_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '54cb7738387c63653bdd25e4086382c0f57dfbb7520aa229cc2338d0e2e5b821'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_record_student_import_skip_v61');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='record_student_import_skip_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.record_student_import_skip_v1(uuid,uuid,text,integer,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '225d9a1cf85d88881124fae5b03937912b08e7c901c34e95075314a48a7afdcc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_record_student_import_skip_v61');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v61'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v41()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v42();
    IF v.ready IS TRUE AND v.migration_count = 156 AND v.migration_head = '20261022190000'
       AND v.manifest_version = 'release-db-attestation-v61'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 72
       AND v.pending_versions[cardinality(v.pending_versions)] = '20261022190000' THEN
        RETURN QUERY SELECT TRUE, 155, '20261021093000'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v60'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v60'::TEXT;
END;
$function$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v42() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v42() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v42() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v41() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v41() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v41() TO service_role;


DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v42();
    IF v.migration_count IS DISTINCT FROM 155 OR v.migration_head IS DISTINCT FROM '20261021093000'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v61',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V61 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
