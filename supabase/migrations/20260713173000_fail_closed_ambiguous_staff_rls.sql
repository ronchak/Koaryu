-- Fail closed for historical Auth identities linked to more than one studio.
--
-- The write trigger added by the Friendly Pilot candidate prevents new
-- cross-studio memberships. Existing rows are intentionally preserved, so the
-- Data API also needs a read-time guard that applies before every table's
-- existing tenant and role policy.

CREATE OR REPLACE FUNCTION private.has_unambiguous_studio_membership()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        auth.uid() IS NOT NULL
        AND (
            SELECT COUNT(DISTINCT sr.studio_id) <= 1
            FROM public.staff_roles AS sr
            WHERE sr.user_id = auth.uid()
        );
$$;

REVOKE ALL ON FUNCTION private.has_unambiguous_studio_membership()
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.has_unambiguous_studio_membership()
TO authenticated, service_role;

-- These security-definer helpers bypass staff_roles RLS by design. Include the
-- same ambiguity guard so billing and support policies cannot authorize a
-- historical cross-studio identity through the helper path.
CREATE OR REPLACE FUNCTION private.is_staff_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS sr
            WHERE sr.studio_id = target_studio_id
              AND sr.user_id = auth.uid()
        );
$$;

CREATE OR REPLACE FUNCTION private.is_admin_or_front_desk_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS sr
            WHERE sr.studio_id = target_studio_id
              AND sr.user_id = auth.uid()
              AND sr.role IN ('admin', 'front_desk')
        );
$$;

CREATE OR REPLACE FUNCTION private.is_admin_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS sr
            WHERE sr.studio_id = target_studio_id
              AND sr.user_id = auth.uid()
              AND sr.role = 'admin'
        );
$$;

-- CREATE OR REPLACE preserves the existing ACL, but restate it here so this
-- migration remains least-privilege even if an environment has ACL drift.
REVOKE EXECUTE ON FUNCTION private.is_staff_in_studio(UUID)
FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.is_admin_or_front_desk_in_studio(UUID)
FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION private.is_admin_in_studio(UUID)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION private.is_staff_in_studio(UUID)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_or_front_desk_in_studio(UUID)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_in_studio(UUID)
TO authenticated, service_role;

-- A restrictive SELECT policy composes with, rather than replaces, each
-- table's existing permissive authorization policy: it cannot grant a table
-- privilege or make a row visible on its own. Centralizing this invariant also
-- avoids duplicating a subtle historical-data check across dozens of tenant,
-- owner, self, support, and billing policies. Cover every current public RLS
-- table so owner/self policies cannot become an alternate read path. Non-RLS
-- relations are intentionally unchanged; the verification contract makes any
-- future public RLS table fail until it receives this guard as well.
DO $$
DECLARE
    target_table RECORD;
BEGIN
    FOR target_table IN
        SELECT namespace.nspname AS schema_name, relation.relname AS table_name
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relrowsecurity
    LOOP
        EXECUTE pg_catalog.format(
            'DROP POLICY IF EXISTS %I ON %I.%I',
            'reject_ambiguous_staff_membership_select',
            target_table.schema_name,
            target_table.table_name
        );

        EXECUTE pg_catalog.format(
            'CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR SELECT TO authenticated USING ((SELECT private.has_unambiguous_studio_membership()))',
            'reject_ambiguous_staff_membership_select',
            target_table.schema_name,
            target_table.table_name
        );
    END LOOP;
END
$$;
