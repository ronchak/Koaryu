-- Async export jobs can contain sensitive billing/bulk-data artifacts such as
-- download URLs and completion metadata. Keep browser-facing reads admin-only.

DROP POLICY IF EXISTS "export_jobs_manager_select" ON public.export_jobs;
DROP POLICY IF EXISTS "export_jobs_admin_select" ON public.export_jobs;

CREATE POLICY "export_jobs_admin_select" ON public.export_jobs
    FOR SELECT TO authenticated
    USING (private.is_admin_in_studio(studio_id));

NOTIFY pgrst, 'reload schema';
