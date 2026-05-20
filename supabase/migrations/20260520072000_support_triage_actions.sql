-- ==========================================
-- Koaryu v1 — Support triage actions
-- ==========================================
--
-- Internal support triage runs through service-role backend endpoints. These
-- RPCs keep operational ordering and ticket/event mutation atomic while direct
-- browser-facing roles remain unable to execute them.

CREATE OR REPLACE FUNCTION public.support_triage_list_tickets(
    p_statuses TEXT[] DEFAULT NULL,
    p_severities TEXT[] DEFAULT NULL,
    p_topics TEXT[] DEFAULT NULL,
    p_limit INTEGER DEFAULT 50
)
RETURNS SETOF public.support_tickets
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT ticket.*
    FROM public.support_tickets ticket
    WHERE ((
            COALESCE(array_length(p_statuses, 1), 0) = 0
            AND ticket.status IN ('open', 'triaging', 'waiting_on_customer')
        )
        OR ticket.status = ANY(p_statuses))
      AND (
            COALESCE(array_length(p_severities, 1), 0) = 0
            OR ticket.severity = ANY(p_severities)
      )
      AND (
            COALESCE(array_length(p_topics, 1), 0) = 0
            OR ticket.topic = ANY(p_topics)
      )
    ORDER BY
        CASE ticket.severity
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            ELSE 3
        END,
        ticket.created_at ASC,
        ticket.id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
$$;

CREATE OR REPLACE FUNCTION public.support_triage_update_ticket(
    p_ticket_id UUID,
    p_status TEXT DEFAULT NULL,
    p_note TEXT DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS public.support_tickets
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_existing public.support_tickets%ROWTYPE;
    v_updated public.support_tickets%ROWTYPE;
    v_event_type TEXT;
    v_note TEXT := NULLIF(BTRIM(COALESCE(p_note, '')), '');
    v_metadata JSONB := COALESCE(p_metadata, '{}'::jsonb);
BEGIN
    IF p_status IS NOT NULL AND p_status NOT IN ('open', 'triaging', 'waiting_on_customer', 'resolved', 'closed') THEN
        RAISE EXCEPTION 'Invalid support ticket status: %', p_status
            USING ERRCODE = '22023';
    END IF;

    IF v_note IS NOT NULL AND char_length(v_note) > 2000 THEN
        RAISE EXCEPTION 'Support triage note is too long.'
            USING ERRCODE = '22023';
    END IF;

    IF octet_length(v_metadata::TEXT) > 4000 THEN
        RAISE EXCEPTION 'Support triage metadata is too large.'
            USING ERRCODE = '22023';
    END IF;

    IF p_status IS NULL AND v_note IS NULL THEN
        RAISE EXCEPTION 'A status change or note is required.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_existing
    FROM public.support_tickets
    WHERE id = p_ticket_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Support ticket not found.'
            USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.support_tickets
    SET status = COALESCE(p_status, status),
        resolved_at = CASE
            WHEN p_status IN ('resolved', 'closed') THEN COALESCE(resolved_at, now())
            WHEN p_status IN ('open', 'triaging', 'waiting_on_customer') THEN NULL
            ELSE resolved_at
        END,
        updated_at = now()
    WHERE id = p_ticket_id
    RETURNING * INTO v_updated;

    v_event_type := CASE
        WHEN p_status IS NOT NULL AND v_note IS NOT NULL THEN 'ticket.triaged'
        WHEN p_status IS NOT NULL THEN 'ticket.status_changed'
        ELSE 'ticket.note_added'
    END;

    INSERT INTO public.support_ticket_events (
        ticket_id,
        studio_id,
        actor_id,
        event_type,
        message,
        metadata
    )
    VALUES (
        v_updated.id,
        v_updated.studio_id,
        NULL,
        v_event_type,
        v_note,
        v_metadata || jsonb_build_object(
            'actor', 'internal_support_triage',
            'previous_status', v_existing.status,
            'next_status', v_updated.status
        )
    );

    RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.support_triage_list_tickets(TEXT[], TEXT[], TEXT[], INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_triage_list_tickets(TEXT[], TEXT[], TEXT[], INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.support_triage_list_tickets(TEXT[], TEXT[], TEXT[], INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.support_triage_list_tickets(TEXT[], TEXT[], TEXT[], INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.support_triage_update_ticket(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_triage_update_ticket(UUID, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.support_triage_update_ticket(UUID, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.support_triage_update_ticket(UUID, TEXT, TEXT, JSONB) TO service_role;
