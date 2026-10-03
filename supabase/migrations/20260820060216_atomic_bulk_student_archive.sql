-- Atomically archive a bounded roster selection. Validation intentionally
-- happens before any update so an unknown or cross-tenant id aborts the whole
-- transaction without a partial archive or audit trail.
CREATE OR REPLACE FUNCTION public.archive_students_bulk_atomic(
    p_studio_id UUID,
    p_actor_id UUID,
    p_student_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $archive_students_bulk_atomic$
DECLARE
    v_student_ids UUID[];
    v_requested_count INTEGER;
    v_missing_id UUID;
    v_locked_count INTEGER;
    v_updated INTEGER;
BEGIN
    IF p_student_ids IS NULL OR cardinality(p_student_ids) < 1 THEN
        RAISE EXCEPTION 'Select between one and 200 students.' USING ERRCODE = '22023';
    END IF;

    SELECT count(*)::INTEGER
    INTO v_requested_count
    FROM unnest(p_student_ids) AS requested(id);
    IF v_requested_count > 200 THEN
        RAISE EXCEPTION 'Select between one and 200 students.' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(p_student_ids) AS requested(id)
        WHERE requested.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Student ids must be valid UUIDs.' USING ERRCODE = '22023';
    END IF;

    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'Bulk student archive requires a roster manager role.'
            USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.staff_roles AS staff
    WHERE staff.user_id = p_actor_id
      AND staff.studio_id = p_studio_id
      AND staff.archived_at IS NULL
      AND staff.role IN ('admin', 'front_desk')
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bulk student archive requires a roster manager role.'
            USING ERRCODE = '42501';
    END IF;

    SELECT array_agg(requested.id ORDER BY requested.id)
    INTO v_student_ids
    FROM (
        SELECT DISTINCT requested.id
        FROM unnest(p_student_ids) AS requested(id)
    ) AS requested;

    -- Deleted rows are valid retry targets, but every distinct id must belong
    -- to the requested studio before any row lock or write is taken.
    SELECT requested.id
    INTO v_missing_id
    FROM unnest(v_student_ids) AS requested(id)
    LEFT JOIN public.students AS student
      ON student.id = requested.id
     AND student.studio_id = p_studio_id
    WHERE student.id IS NULL
    ORDER BY requested.id
    LIMIT 1;

    IF v_missing_id IS NOT NULL THEN
        RAISE EXCEPTION 'One or more students were not found.'
            USING ERRCODE = 'P0002';
    END IF;

    -- Acquire every target lock in UUID order. This makes concurrent retries
    -- converge even when callers submit the same ids in opposite orders.
    PERFORM student.id
    FROM public.students AS student
    WHERE student.id = ANY(v_student_ids)
      AND student.studio_id = p_studio_id
    ORDER BY student.id
    FOR UPDATE;

    SELECT count(*)::INTEGER
    INTO v_locked_count
    FROM public.students AS student
    WHERE student.id = ANY(v_student_ids)
      AND student.studio_id = p_studio_id;
    IF v_locked_count <> cardinality(v_student_ids) THEN
        RAISE EXCEPTION 'One or more students were not found.'
            USING ERRCODE = 'P0002';
    END IF;

    WITH changed AS (
        UPDATE public.students AS student
        SET deleted_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE student.id = ANY(v_student_ids)
          AND student.studio_id = p_studio_id
          AND student.deleted_at IS NULL
        RETURNING student.id
    ), audit_rows AS (
        INSERT INTO public.audit_logs (
            studio_id, actor_id, action, entity_type, entity_id, metadata
        )
        SELECT p_studio_id, p_actor_id, 'student.deleted', 'student', changed.id, '{}'::JSONB
        FROM changed
        RETURNING id
    )
    SELECT count(*)::INTEGER
    INTO v_updated
    FROM audit_rows;

    RETURN v_updated;
END;
$archive_students_bulk_atomic$;

ALTER FUNCTION public.archive_students_bulk_atomic(UUID, UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.archive_students_bulk_atomic(UUID, UUID, UUID[])
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_students_bulk_atomic(UUID, UUID, UUID[])
TO service_role;

-- Keep the release preflight pointed at this additive exact head. The
-- function is intentionally replaced in the new migration rather than
-- rewriting the historical readiness migration.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v4()
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
AS $schema_preflight_v4_archive$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 114 OR v_head <> '20260820060216' THEN
        v_failures := array_append(v_failures, 'migration_history_v21');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v21');
    END IF;
    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v21';
END;
$schema_preflight_v4_archive$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4() TO service_role;
