BEGIN;

DO $$
DECLARE
    v_owner_a UUID := gen_random_uuid();
    v_owner_b UUID := gen_random_uuid();
    v_studio_a UUID := gen_random_uuid();
    v_studio_b UUID := gen_random_uuid();
    v_program_a UUID := gen_random_uuid();
    v_program_b UUID := gen_random_uuid();
    v_student_a UUID := gen_random_uuid();
    v_student_b UUID := gen_random_uuid();
    v_guardian_a UUID := gen_random_uuid();
    v_guardian_b UUID := gen_random_uuid();
    v_lead_a UUID := gen_random_uuid();
    v_lead_b UUID := gen_random_uuid();
    v_support_ticket_a UUID := gen_random_uuid();
    v_support_ticket_b UUID := gen_random_uuid();
    v_own_tenant_count INTEGER;
    v_cross_tenant_count INTEGER;
    v_cross_tenant_updates INTEGER := 0;
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
    VALUES
        (
            v_owner_a,
            'authenticated',
            'authenticated',
            'koaryu-rls-a-' || replace(v_owner_a::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        ),
        (
            v_owner_b,
            'authenticated',
            'authenticated',
            'koaryu-rls-b-' || replace(v_owner_b::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio_a, 'Koaryu RLS Studio A', 'koaryu-rls-a-' || replace(v_studio_a::TEXT, '-', ''), v_owner_a),
        (v_studio_b, 'Koaryu RLS Studio B', 'koaryu-rls-b-' || replace(v_studio_b::TEXT, '-', ''), v_owner_b);

    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES
        (v_studio_a, v_owner_a, 'admin'),
        (v_studio_b, v_owner_b, 'admin');

    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_program_a, v_studio_a, 'RLS Program A'),
        (v_program_b, v_studio_b, 'RLS Program B');

    INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, program_id)
    VALUES
        (v_student_a, v_studio_a, 'Readable', 'Student A', v_program_a),
        (v_student_b, v_studio_b, 'Hidden', 'Student B', v_program_b);

    INSERT INTO public.guardians (id, studio_id, first_name, last_name)
    VALUES
        (v_guardian_a, v_studio_a, 'Readable', 'Guardian A'),
        (v_guardian_b, v_studio_b, 'Hidden', 'Guardian B');

    INSERT INTO public.leads (id, studio_id, first_name, last_name, email)
    VALUES
        (v_lead_a, v_studio_a, 'Readable', 'Lead A', 'lead-a@example.invalid'),
        (v_lead_b, v_studio_b, 'Hidden', 'Lead B', 'lead-b@example.invalid');

    INSERT INTO public.support_tickets (
        id,
        studio_id,
        created_by,
        requester_email,
        topic,
        severity,
        subject,
        details,
        status
    )
    VALUES
        (
            v_support_ticket_a,
            v_studio_a,
            v_owner_a,
            'ticket-a@example.invalid',
            'product_question',
            'normal',
            'Readable support ticket',
            'RLS isolation ticket A',
            'open'
        ),
        (
            v_support_ticket_b,
            v_studio_b,
            v_owner_b,
            'ticket-b@example.invalid',
            'product_question',
            'normal',
            'Hidden support ticket',
            'RLS isolation ticket B',
            'open'
        );

    PERFORM set_config('request.jwt.claim.sub', v_owner_a::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    SELECT COUNT(*) INTO v_own_tenant_count
    FROM (
        SELECT id FROM public.studios WHERE id = v_studio_a
        UNION ALL
        SELECT id FROM public.staff_roles WHERE studio_id = v_studio_a
        UNION ALL
        SELECT id FROM public.programs WHERE id = v_program_a
        UNION ALL
        SELECT id FROM public.students WHERE id = v_student_a
        UNION ALL
        SELECT id FROM public.guardians WHERE id = v_guardian_a
        UNION ALL
        SELECT id FROM public.leads WHERE id = v_lead_a
        UNION ALL
        SELECT id FROM public.support_tickets WHERE id = v_support_ticket_a
    ) AS visible_rows;

    IF v_own_tenant_count <> 7 THEN
        RAISE EXCEPTION 'Authenticated owner A can read only % of 7 own-tenant private rows.', v_own_tenant_count;
    END IF;

    SELECT COUNT(*) INTO v_cross_tenant_count
    FROM (
        SELECT id FROM public.studios WHERE id = v_studio_b
        UNION ALL
        SELECT id FROM public.staff_roles WHERE studio_id = v_studio_b
        UNION ALL
        SELECT id FROM public.programs WHERE id = v_program_b
        UNION ALL
        SELECT id FROM public.students WHERE id = v_student_b
        UNION ALL
        SELECT id FROM public.guardians WHERE id = v_guardian_b
        UNION ALL
        SELECT id FROM public.leads WHERE id = v_lead_b
        UNION ALL
        SELECT id FROM public.support_tickets WHERE id = v_support_ticket_b
    ) AS leaked_rows;

    IF v_cross_tenant_count <> 0 THEN
        RAISE EXCEPTION 'Authenticated owner A can read % cross-tenant private row(s).', v_cross_tenant_count;
    END IF;

    BEGIN
        UPDATE public.students
        SET legal_first_name = 'Cross Tenant Mutation'
        WHERE id = v_student_b;
        GET DIAGNOSTICS v_cross_tenant_updates = ROW_COUNT;
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_cross_tenant_updates := 0;
    END;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF v_cross_tenant_updates <> 0 THEN
        RAISE EXCEPTION 'Authenticated owner A updated % cross-tenant student row(s).', v_cross_tenant_updates;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.students
        WHERE id = v_student_b
          AND legal_first_name = 'Cross Tenant Mutation'
    ) THEN
        RAISE EXCEPTION 'Authenticated owner A mutated a cross-tenant student row.';
    END IF;

    RAISE NOTICE 'Koaryu tenant RLS isolation smoke verification passed.';
END $$;

ROLLBACK;
