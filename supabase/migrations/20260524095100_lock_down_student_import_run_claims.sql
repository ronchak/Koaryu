-- ==========================================
-- Koaryu v1 - Student import run worker claim controls
-- ==========================================
--
-- Import-run processing_token and processing_started_at are worker claim fields.
-- They are mutated by the service-role backend and must not be writable through
-- browser-facing Supabase roles.

DROP POLICY IF EXISTS "student_import_runs_insert" ON public.student_import_runs;
DROP POLICY IF EXISTS "student_import_runs_update" ON public.student_import_runs;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.student_import_runs
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.student_import_runs
TO service_role;
