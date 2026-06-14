-- ==========================================
-- Koaryu v1 - Atomic support ticket creation
-- ==========================================
--
-- Keep user-facing ticket creation and the initial event trail entry in one
-- database transaction. The backend calls this with the service role.

CREATE OR REPLACE FUNCTION public.create_support_ticket(
    p_studio_id UUID,
    p_created_by UUID,
    p_requester_email TEXT,
    p_requester_name TEXT,
    p_topic TEXT,
    p_severity TEXT,
    p_subject TEXT,
    p_details TEXT,
    p_page_url TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_browser_context JSONB DEFAULT '{}'::JSONB
)
RETURNS public.support_tickets
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ticket public.support_tickets%ROWTYPE;
BEGIN
    INSERT INTO public.support_tickets (
        studio_id,
        created_by,
        requester_email,
        requester_name,
        topic,
        severity,
        subject,
        details,
        page_url,
        user_agent,
        browser_context,
        status
    )
    VALUES (
        p_studio_id,
        p_created_by,
        COALESCE(p_requester_email, ''),
        NULLIF(btrim(COALESCE(p_requester_name, '')), ''),
        p_topic,
        p_severity,
        p_subject,
        p_details,
        NULLIF(p_page_url, ''),
        NULLIF(p_user_agent, ''),
        COALESCE(p_browser_context, '{}'::JSONB),
        'open'
    )
    RETURNING * INTO v_ticket;

    INSERT INTO public.support_ticket_events (
        ticket_id,
        studio_id,
        actor_id,
        event_type,
        message,
        metadata
    )
    VALUES (
        v_ticket.id,
        p_studio_id,
        p_created_by,
        'ticket.created',
        'Support ticket created.',
        jsonb_build_object(
            'topic', p_topic,
            'severity', p_severity
        )
    );

    RETURN v_ticket;
END;
$$;

REVOKE ALL ON FUNCTION public.create_support_ticket(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO service_role;
