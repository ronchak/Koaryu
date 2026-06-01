-- Nullable staff invite rows must not let the last active admin be converted
-- into an unclaimed/pending invite by keeping role = 'admin' and clearing or
-- replacing user_id.

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
        IF OLD.role <> 'admin' OR OLD.user_id IS NULL THEN
            RETURN NEW;
        END IF;
        IF NEW.role = 'admin' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
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

DROP TRIGGER IF EXISTS prevent_staff_admin_orphan_update_trigger ON public.staff_roles;
CREATE TRIGGER prevent_staff_admin_orphan_update_trigger
    BEFORE UPDATE OF role, user_id ON public.staff_roles
    FOR EACH ROW
    EXECUTE FUNCTION private.prevent_staff_admin_orphan();
