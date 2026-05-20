-- ==========================================
-- Koaryu v1 — Account support controls
-- ==========================================

CREATE TABLE IF NOT EXISTS support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    requester_email TEXT NOT NULL DEFAULT '',
    requester_name TEXT,
    topic TEXT NOT NULL CHECK (topic IN (
        'billing',
        'account_access',
        'student_records',
        'bug_report',
        'product_question',
        'other'
    )),
    severity TEXT NOT NULL DEFAULT 'normal' CHECK (severity IN ('low', 'normal', 'high', 'urgent')),
    subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 160),
    details TEXT NOT NULL CHECK (char_length(details) BETWEEN 10 AND 5000),
    page_url TEXT CHECK (page_url IS NULL OR char_length(page_url) <= 1000),
    user_agent TEXT CHECK (user_agent IS NULL OR char_length(user_agent) <= 1000),
    browser_context JSONB NOT NULL DEFAULT '{}' CHECK (octet_length(browser_context::TEXT) <= 4000),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaging', 'waiting_on_customer', 'resolved', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS support_ticket_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    studio_id UUID REFERENCES studios(id) ON DELETE SET NULL,
    requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    requester_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'canceled', 'completed')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    scheduled_for TIMESTAMPTZ NOT NULL,
    canceled_at TIMESTAMPTZ,
    canceled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}',
    CHECK (scheduled_for >= requested_at)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_studio_created
    ON support_tickets(studio_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_created_by_created
    ON support_tickets(created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
    ON support_tickets(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket_created
    ON support_ticket_events(ticket_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletion_requests_one_scheduled
    ON account_deletion_requests(user_id)
    WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_scheduled
    ON account_deletion_requests(status, scheduled_for);

DROP TRIGGER IF EXISTS set_support_tickets_updated_at ON support_tickets;
CREATE TRIGGER set_support_tickets_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_tickets_staff_select" ON support_tickets;
CREATE POLICY "support_tickets_staff_select" ON support_tickets
    FOR SELECT TO authenticated
    USING (
        private.is_admin_in_studio(studio_id)
        OR (
            created_by = auth.uid()
            AND private.is_staff_in_studio(studio_id)
        )
    );

DROP POLICY IF EXISTS "support_ticket_events_staff_select" ON support_ticket_events;
CREATE POLICY "support_ticket_events_staff_select" ON support_ticket_events
    FOR SELECT TO authenticated
    USING (
        private.is_admin_in_studio(studio_id)
        OR EXISTS (
            SELECT 1
            FROM support_tickets st
            WHERE st.id = ticket_id
              AND st.created_by = auth.uid()
              AND private.is_staff_in_studio(st.studio_id)
        )
    );

DROP POLICY IF EXISTS "account_deletion_requests_self_select" ON account_deletion_requests;
CREATE POLICY "account_deletion_requests_self_select" ON account_deletion_requests
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Writes are intentionally performed by the service-role backend after
-- explicit authenticated user and studio-scope checks.

CREATE OR REPLACE FUNCTION private.prevent_account_deletion_orphan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_studio UUID;
    survivor_count INTEGER;
BEGIN
    IF NEW.status <> 'scheduled' OR NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.studios s
        WHERE s.owner_id = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'Transfer studio ownership before deleting this account.'
            USING ERRCODE = '23514';
    END IF;

    FOR affected_studio IN
        SELECT DISTINCT sr.studio_id
        FROM public.staff_roles sr
        WHERE sr.user_id = NEW.user_id
          AND sr.role = 'admin'
    LOOP
        PERFORM 1
        FROM public.studios s
        WHERE s.id = affected_studio
        FOR UPDATE;

        SELECT COUNT(*) INTO survivor_count
        FROM public.staff_roles sr
        JOIN auth.users au ON au.id = sr.user_id
        WHERE sr.studio_id = affected_studio
          AND sr.role = 'admin'
          AND sr.user_id <> NEW.user_id
          AND (au.email_confirmed_at IS NOT NULL OR au.last_sign_in_at IS NOT NULL)
          AND NOT EXISTS (
              SELECT 1
              FROM public.account_deletion_requests adr
              WHERE adr.user_id = sr.user_id
                AND adr.status = 'scheduled'
                AND adr.id <> NEW.id
          );

        IF survivor_count < 1 THEN
            RAISE EXCEPTION 'Add another active admin before deleting this account.'
                USING ERRCODE = '23514';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

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
        IF OLD.role <> 'admin' OR NEW.role = 'admin' THEN
            RETURN NEW;
        END IF;
        affected_studio := OLD.studio_id;
        departing_user := OLD.user_id;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.role <> 'admin' THEN
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

REVOKE EXECUTE ON FUNCTION private.prevent_account_deletion_orphan() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION private.prevent_staff_admin_orphan() FROM PUBLIC;

DROP TRIGGER IF EXISTS prevent_account_deletion_orphan_trigger ON account_deletion_requests;
CREATE TRIGGER prevent_account_deletion_orphan_trigger
    BEFORE INSERT OR UPDATE OF status, user_id ON account_deletion_requests
    FOR EACH ROW
    EXECUTE FUNCTION private.prevent_account_deletion_orphan();

DROP TRIGGER IF EXISTS prevent_staff_admin_orphan_update_trigger ON staff_roles;
CREATE TRIGGER prevent_staff_admin_orphan_update_trigger
    BEFORE UPDATE OF role ON staff_roles
    FOR EACH ROW
    EXECUTE FUNCTION private.prevent_staff_admin_orphan();

DROP TRIGGER IF EXISTS prevent_staff_admin_orphan_delete_trigger ON staff_roles;
CREATE TRIGGER prevent_staff_admin_orphan_delete_trigger
    BEFORE DELETE ON staff_roles
    FOR EACH ROW
    EXECUTE FUNCTION private.prevent_staff_admin_orphan();
