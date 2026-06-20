-- Verify async export job browser-facing reads are admin-only.

DO $$
DECLARE
    manager_policy_count integer;
    admin_policy_count integer;
BEGIN
    SELECT count(*)
      INTO manager_policy_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'export_jobs'
       AND cmd = 'SELECT'
       AND policyname = 'export_jobs_manager_select';

    IF manager_policy_count <> 0 THEN
        RAISE EXCEPTION 'export_jobs_manager_select policy must not exist';
    END IF;

    SELECT count(*)
      INTO admin_policy_count
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'export_jobs'
       AND cmd = 'SELECT'
       AND roles = '{authenticated}'
       AND policyname = 'export_jobs_admin_select'
       AND qual = 'private.is_admin_in_studio(studio_id)';

    IF admin_policy_count <> 1 THEN
        RAISE EXCEPTION 'export_jobs_admin_select policy must use private.is_admin_in_studio(studio_id)';
    END IF;
END $$;
