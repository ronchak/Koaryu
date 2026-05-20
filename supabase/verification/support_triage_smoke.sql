BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_ticket_normal UUID := gen_random_uuid();
    v_ticket_urgent UUID := gen_random_uuid();
    v_ticket_student UUID := gen_random_uuid();
    v_listed_ids UUID[];
    v_updated public.support_tickets%ROWTYPE;
    v_event_count INTEGER;
    v_digest JSONB;
    v_student_digest_found BOOLEAN;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'koaryu-support-smoke-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (v_studio, 'Koaryu Support Smoke', 'koaryu-support-smoke-' || replace(v_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.support_tickets (
        id,
        studio_id,
        created_by,
        requester_email,
        topic,
        severity,
        subject,
        details,
        status,
        created_at,
        updated_at
    )
    VALUES
        (
            v_ticket_normal,
            v_studio,
            v_owner,
            'normal@example.invalid',
            'billing',
            'normal',
            'Normal billing ticket',
            'This is enough detail.',
            'open',
            now() - interval '1 hour',
            now() - interval '1 hour'
        ),
        (
            v_ticket_urgent,
            v_studio,
            v_owner,
            'urgent@example.invalid',
            'bug_report',
            'urgent',
            'Urgent bug ticket',
            'This is enough urgent detail.',
            'open',
            now(),
            now()
        ),
        (
            v_ticket_student,
            v_studio,
            v_owner,
            'student@example.invalid',
            'student_records',
            'high',
            'Sensitive student subject',
            'Sensitive student detail that must not appear in automation digests.',
            'open',
            now() - interval '30 minutes',
            now() - interval '30 minutes'
        );

    SELECT array_agg(id ORDER BY ordinality)
    INTO v_listed_ids
    FROM public.support_triage_list_tickets(NULL, NULL, NULL, 2) WITH ORDINALITY AS listed(
        id,
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
        status,
        created_at,
        updated_at,
        resolved_at,
        ordinality
    )
    WHERE listed.id IN (v_ticket_normal, v_ticket_urgent);

    IF v_listed_ids[1] <> v_ticket_urgent THEN
        RAISE EXCEPTION 'Urgent ticket was not ordered before normal ticket.';
    END IF;

    SELECT public.support_triage_digest(10)
    INTO v_digest;

    IF v_digest->>'ok' <> 'true' THEN
        RAISE EXCEPTION 'Support triage digest did not return an ok payload.';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_digest->'tickets') AS ticket
        WHERE ticket->>'id' = v_ticket_student::TEXT
          AND ticket->>'subject' = 'details withheld'
          AND ticket->>'summary_seed' = 'details withheld'
          AND ticket->>'requester' = 's***@example.invalid'
    )
    INTO v_student_digest_found;

    IF NOT v_student_digest_found THEN
        RAISE EXCEPTION 'Support triage digest did not withhold student-record details.';
    END IF;

    IF v_digest::TEXT ILIKE '%Sensitive student%'
       OR v_digest::TEXT ILIKE '%student@example.invalid%' THEN
        RAISE EXCEPTION 'Support triage digest leaked raw student-record details or full requester email.';
    END IF;

    SELECT *
    INTO v_updated
    FROM public.support_triage_update_ticket(
        v_ticket_urgent,
        'resolved',
        'Resolved during smoke test.',
        '{"source":"smoke"}'::jsonb
    );

    IF v_updated.status <> 'resolved' OR v_updated.resolved_at IS NULL THEN
        RAISE EXCEPTION 'Triage update did not set resolved status and timestamp.';
    END IF;

    SELECT COUNT(*)
    INTO v_event_count
    FROM public.support_ticket_events
    WHERE ticket_id = v_ticket_urgent
      AND event_type = 'ticket.triaged'
      AND metadata->>'previous_status' = 'open'
      AND metadata->>'next_status' = 'resolved';

    IF v_event_count <> 1 THEN
        RAISE EXCEPTION 'Triage event was not inserted atomically.';
    END IF;
END $$;

ROLLBACK;
