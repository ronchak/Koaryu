-- Allow staff invite flows to reserve the Koaryu membership row before
-- sending the Supabase Auth invite. The row is linked to auth.users once the
-- invite call returns the invited user id.

ALTER TABLE public.staff_roles
    ALTER COLUMN user_id DROP NOT NULL;

UPDATE public.staff_roles
SET invited_email = lower(invited_email)
WHERE user_id IS NULL
  AND invited_email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_pending_invited_email_unique
    ON public.staff_roles (studio_id, lower(invited_email))
    WHERE user_id IS NULL
      AND invited_email IS NOT NULL;

CREATE OR REPLACE FUNCTION private.prevent_staff_admin_orphan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_studio UUID;
    departing_user UUID;
    survivor_count INTEGER;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.role <> 'admin' OR NEW.role = 'admin' OR OLD.user_id IS NULL THEN
            RETURN NEW;
        END IF;
        affected_studio := OLD.studio_id;
        departing_user := OLD.user_id;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.role <> 'admin' OR OLD.user_id IS NULL THEN
            RETURN OLD;
        END IF;
        affected_studio := OLD.studio_id;
        departing_user := OLD.user_id;
    ELSE
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM public.studios s
    WHERE s.id = affected_studio
    FOR UPDATE;

    SELECT COUNT(*) INTO survivor_count
    FROM public.staff_roles sr
    JOIN auth.users au ON au.id = sr.user_id
    WHERE sr.studio_id = affected_studio
      AND sr.role = 'admin'
      AND sr.user_id IS NOT NULL
      AND sr.user_id <> departing_user
      AND (au.email_confirmed_at IS NOT NULL OR au.last_sign_in_at IS NOT NULL)
      AND NOT EXISTS (
          SELECT 1
          FROM public.account_deletion_requests adr
          WHERE adr.user_id = sr.user_id
            AND adr.status = 'scheduled'
      );

    IF survivor_count < 1 THEN
        RAISE EXCEPTION 'At least one active admin not scheduled for deletion must remain in the studio.'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.prevent_staff_admin_orphan() FROM PUBLIC;
