-- ==========================================
-- Koaryu v1 — Harden account deletion auth-user references
-- ==========================================
--
-- Delayed account deletion ultimately removes the auth.users row. Historical
-- studio records should remain useful after that happens, while membership rows
-- should disappear so the deleted account no longer has access.

ALTER TABLE public.class_templates
    DROP CONSTRAINT IF EXISTS class_templates_instructor_id_fkey;

ALTER TABLE public.class_templates
    ADD CONSTRAINT class_templates_instructor_id_fkey
    FOREIGN KEY (instructor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.class_sessions
    DROP CONSTRAINT IF EXISTS class_sessions_instructor_id_fkey;

ALTER TABLE public.class_sessions
    ADD CONSTRAINT class_sessions_instructor_id_fkey
    FOREIGN KEY (instructor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.attendance
    DROP CONSTRAINT IF EXISTS attendance_checked_in_by_fkey;

ALTER TABLE public.attendance
    ADD CONSTRAINT attendance_checked_in_by_fkey
    FOREIGN KEY (checked_in_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.promotions
    ALTER COLUMN promoted_by DROP NOT NULL;

ALTER TABLE public.promotions
    DROP CONSTRAINT IF EXISTS promotions_promoted_by_fkey;

ALTER TABLE public.promotions
    ADD CONSTRAINT promotions_promoted_by_fkey
    FOREIGN KEY (promoted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.leads
    DROP CONSTRAINT IF EXISTS leads_assigned_staff_id_fkey;

ALTER TABLE public.leads
    ADD CONSTRAINT leads_assigned_staff_id_fkey
    FOREIGN KEY (assigned_staff_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.lead_activities
    DROP CONSTRAINT IF EXISTS lead_activities_created_by_fkey;

ALTER TABLE public.lead_activities
    ADD CONSTRAINT lead_activities_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.staff_roles
    DROP CONSTRAINT IF EXISTS staff_roles_invited_by_fkey;

ALTER TABLE public.staff_roles
    ADD CONSTRAINT staff_roles_invited_by_fkey
    FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.staff_roles
    DROP CONSTRAINT IF EXISTS staff_roles_user_id_fkey;

ALTER TABLE public.staff_roles
    ADD CONSTRAINT staff_roles_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

GRANT SELECT ON TABLE
    public.support_tickets,
    public.support_ticket_events,
    public.account_deletion_requests
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.support_tickets,
    public.support_ticket_events,
    public.account_deletion_requests
TO service_role;
