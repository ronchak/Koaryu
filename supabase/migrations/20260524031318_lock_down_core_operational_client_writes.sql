-- ==========================================
-- Koaryu v1 - Lock down direct client writes for core operational tables
-- ==========================================
--
-- Operational writes for students, programs, and memberships go through the
-- backend service role so request schemas, tenant checks, audit trails, and
-- repair logic stay centralized. Browser-facing roles may keep read access
-- through RLS, but they should not be able to mutate these tables directly via
-- the Supabase Data API.

DROP POLICY IF EXISTS "students_insert" ON public.students;
DROP POLICY IF EXISTS "students_update" ON public.students;
DROP POLICY IF EXISTS "programs_insert" ON public.programs;
DROP POLICY IF EXISTS "programs_update" ON public.programs;
DROP POLICY IF EXISTS "student_program_memberships_insert" ON public.student_program_memberships;
DROP POLICY IF EXISTS "student_program_memberships_update" ON public.student_program_memberships;
DROP POLICY IF EXISTS "student_program_memberships_delete" ON public.student_program_memberships;

REVOKE INSERT, UPDATE, DELETE ON TABLE
    public.students,
    public.programs,
    public.student_program_memberships
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.students,
    public.programs,
    public.student_program_memberships
TO service_role;
