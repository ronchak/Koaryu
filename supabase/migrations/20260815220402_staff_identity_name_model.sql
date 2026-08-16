-- PR 1 staff legal-name source of truth and audit actor-name snapshot.

CREATE TABLE public.staff_profiles (
    user_id UUID PRIMARY KEY
        REFERENCES auth.users(id) ON DELETE CASCADE,
    legal_first_name TEXT NOT NULL,
    legal_last_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT staff_profiles_legal_first_name_normalized CHECK (
        legal_first_name <> ''
        AND legal_first_name = pg_catalog.btrim(
            pg_catalog.regexp_replace(
                legal_first_name,
                '[[:space:]]+',
                ' ',
                'g'
            )
        )
    ),
    CONSTRAINT staff_profiles_legal_last_name_normalized CHECK (
        legal_last_name <> ''
        AND legal_last_name = pg_catalog.btrim(
            pg_catalog.regexp_replace(
                legal_last_name,
                '[[:space:]]+',
                ' ',
                'g'
            )
        )
    )
);

ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;

-- Keep the cross-user membership lookup behind a private, authenticated-only
-- helper because staff_roles must retain its existing caller-self privacy.
-- PR 2 must exclude archived membership once that column exists.
CREATE OR REPLACE FUNCTION private.can_read_staff_profile(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        auth.uid() IS NOT NULL
        AND private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS caller_membership
            JOIN public.staff_roles AS target_membership
              ON target_membership.studio_id = caller_membership.studio_id
            WHERE caller_membership.user_id = auth.uid()
              AND target_membership.user_id = target_user_id
        );
$$;

REVOKE ALL ON FUNCTION private.can_read_staff_profile(UUID)
FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION private.can_read_staff_profile(UUID)
TO authenticated;

-- Profiles are global to an Auth identity, but readable only by an
-- authenticated user whose one unambiguous studio membership is shared by
-- the profile user. PR 2 must exclude archived membership once that column
-- exists.
CREATE POLICY staff_profiles_select_shared_studio
    ON public.staff_profiles
    FOR SELECT
    TO authenticated
    USING (
        (SELECT private.can_read_staff_profile(staff_profiles.user_id))
    );

-- Re-apply the database-wide ambiguous-membership guard to the new public
-- RLS table. Every other public RLS table already carries this policy from
-- the fail-closed tenant migration and its later table-specific additions.
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.staff_profiles
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE public.staff_profiles
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.staff_profiles
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_profiles
TO service_role;

ALTER TABLE public.audit_logs
    ADD COLUMN actor_legal_name TEXT;

CREATE OR REPLACE FUNCTION private.set_audit_actor_legal_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    NEW.actor_legal_name := (
        SELECT profile.legal_first_name || ' ' || profile.legal_last_name
        FROM public.staff_profiles AS profile
        WHERE profile.user_id = NEW.actor_id
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_audit_actor_legal_name()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER set_staff_profiles_updated_at
    BEFORE UPDATE ON public.staff_profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_audit_actor_legal_name
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION private.set_audit_actor_legal_name();

-- Normalize and split only names with a nonempty first token and a nonempty
-- remaining last-name portion. This leaves Auth metadata unchanged and does
-- not manufacture profiles for blank or single-token values.
WITH normalized_names AS (
    SELECT
        users.id AS user_id,
        pg_catalog.btrim(
            pg_catalog.regexp_replace(
                COALESCE(users.raw_user_meta_data ->> 'full_name', ''),
                '[[:space:]]+',
                ' ',
                'g'
            )
        ) AS full_name
    FROM auth.users AS users
), split_names AS (
    SELECT
        normalized_names.user_id,
        pg_catalog.substr(normalized_names.full_name, 1, pg_catalog.strpos(normalized_names.full_name, ' ') - 1)
            AS legal_first_name,
        pg_catalog.substr(normalized_names.full_name, pg_catalog.strpos(normalized_names.full_name, ' ') + 1)
            AS legal_last_name
    FROM normalized_names
    WHERE pg_catalog.strpos(normalized_names.full_name, ' ') > 0
)
INSERT INTO public.staff_profiles (
    user_id,
    legal_first_name,
    legal_last_name
)
SELECT
    split_names.user_id,
    split_names.legal_first_name,
    split_names.legal_last_name
FROM split_names
WHERE split_names.legal_first_name <> ''
  AND split_names.legal_last_name <> '';

-- Advance only the release-readiness definitions after the staff identity
-- schema, backfill, grants, RLS, and audit trigger work above. The V16 helper
-- remains the critical-surface owner; its runtime output changes because the
-- V2 compatibility function body below now attests the V17 release state.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v3()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT, pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
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

    IF v_count <> 110 OR v_head <> '20260815220402' THEN
        v_failures := array_append(v_failures, 'migration_history_v17');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v17');
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
    IF private.koaryu_release_critical_surface_manifest_v16()
       <> '0:0953df02aa7cb93c327f60059bd410e4db2af60b90f4f4e710f7baaa7d9204ad' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v16');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v17';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v3() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v3() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v3() TO service_role;

-- Preserve the deployed origin/main application's exact V7-shaped response
-- while requiring the new V3 contract to prove the complete V17 state. On a
-- mismatch, return the V3 failure array unchanged; only a NULL array receives
-- the compatibility fallback identifier.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT, pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_current RECORD;
BEGIN
    SELECT * INTO v_current
    FROM public.koaryu_release_schema_preflight_v3();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 110
       AND v_current.migration_head = '20260815220402'
       AND v_current.manifest_version = 'release-db-attestation-v17'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY SELECT
            TRUE,
            100,
            '20260801131844'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957','20260801060000',
                '20260801070000','20260801080000','20260801090000','20260801091000',
                '20260801092000','20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112','20260801131844'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v7'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        FALSE,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY['v17_compatibility_preflight']::TEXT[]),
        'release-db-attestation-v7'::TEXT;
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
