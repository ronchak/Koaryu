BEGIN;

DO $$
DECLARE
    v_owner_a UUID := gen_random_uuid();
    v_owner_b UUID := gen_random_uuid();
    v_zero_membership_user UUID := gen_random_uuid();
    v_ambiguous_owner UUID := gen_random_uuid();
    v_studio_a UUID := gen_random_uuid();
    v_studio_b UUID := gen_random_uuid();
    v_ambiguous_studio_a UUID := gen_random_uuid();
    v_ambiguous_studio_b UUID := gen_random_uuid();
    v_program_a UUID := gen_random_uuid();
    v_program_b UUID := gen_random_uuid();
    v_ambiguous_program UUID := gen_random_uuid();
    v_ambiguous_billing_plan UUID := gen_random_uuid();
    v_student_a UUID := gen_random_uuid();
    v_student_b UUID := gen_random_uuid();
    v_guardian_a UUID := gen_random_uuid();
    v_guardian_b UUID := gen_random_uuid();
    v_lead_a UUID := gen_random_uuid();
    v_lead_b UUID := gen_random_uuid();
    v_support_ticket_a UUID := gen_random_uuid();
    v_support_ticket_b UUID := gen_random_uuid();
    v_ambiguous_support_ticket UUID := gen_random_uuid();
    v_ambiguous_deletion_request UUID := gen_random_uuid();
    v_own_tenant_count INTEGER;
    v_cross_tenant_count INTEGER;
    v_zero_membership_visible_count INTEGER;
    v_ambiguous_visible_count INTEGER;
    v_service_visible_count INTEGER;
    v_cross_tenant_updates INTEGER := 0;
BEGIN
    IF to_regprocedure('private.has_unambiguous_studio_membership()') IS NULL THEN
        RAISE EXCEPTION 'Missing private.has_unambiguous_studio_membership().';
    END IF;

    IF has_function_privilege(
        'anon',
        'private.has_unambiguous_studio_membership()',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'authenticated',
        'private.has_unambiguous_studio_membership()',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Ambiguous-membership helper privileges are incorrect.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relrowsecurity
          AND NOT EXISTS (
              SELECT 1
              FROM pg_catalog.pg_policy AS policy
              JOIN pg_catalog.pg_roles AS policy_role
                ON policy_role.oid = ANY(policy.polroles)
              WHERE policy.polrelid = relation.oid
                AND policy.polname = 'reject_ambiguous_staff_membership_select'
                AND NOT policy.polpermissive
                AND policy.polcmd = 'r'
                AND policy_role.rolname = 'authenticated'
                AND pg_catalog.regexp_replace(
                    pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                    '[[:space:]]+',
                    '',
                    'g'
                ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
          )
    ) THEN
        RAISE EXCEPTION 'A public RLS table is missing the ambiguous-membership read guard.';
    END IF;

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
        ),
        (
            v_zero_membership_user,
            'authenticated',
            'authenticated',
            'koaryu-rls-zero-membership-' || replace(v_zero_membership_user::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        ),
        (
            v_ambiguous_owner,
            'authenticated',
            'authenticated',
            'koaryu-rls-ambiguous-' || replace(v_ambiguous_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::jsonb,
            '{}'::jsonb,
            now(),
            now()
        );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio_a, 'Koaryu RLS Studio A', 'koaryu-rls-a-' || replace(v_studio_a::TEXT, '-', ''), v_owner_a),
        (v_studio_b, 'Koaryu RLS Studio B', 'koaryu-rls-b-' || replace(v_studio_b::TEXT, '-', ''), v_owner_b),
        (
            v_ambiguous_studio_a,
            'Koaryu RLS Ambiguous Studio A',
            'koaryu-rls-ambiguous-a-' || replace(v_ambiguous_studio_a::TEXT, '-', ''),
            v_ambiguous_owner
        ),
        (
            v_ambiguous_studio_b,
            'Koaryu RLS Ambiguous Studio B',
            'koaryu-rls-ambiguous-b-' || replace(v_ambiguous_studio_b::TEXT, '-', ''),
            v_ambiguous_owner
        );

    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES
        (v_studio_a, v_owner_a, 'admin'),
        (v_studio_b, v_owner_b, 'admin'),
        (v_ambiguous_studio_a, v_ambiguous_owner, 'admin');

    -- Simulate a historical duplicate that predates the write-time guard. The
    -- replica setting is local to this rollback-only verification transaction,
    -- so the production trigger is never disabled for another session.
    EXECUTE 'SET LOCAL session_replication_role = replica';
    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES (v_ambiguous_studio_b, v_ambiguous_owner, 'admin');
    EXECUTE 'SET LOCAL session_replication_role = origin';

    INSERT INTO public.programs (id, studio_id, name)
    VALUES
        (v_program_a, v_studio_a, 'RLS Program A'),
        (v_program_b, v_studio_b, 'RLS Program B'),
        (v_ambiguous_program, v_ambiguous_studio_a, 'RLS Ambiguous Program');

    INSERT INTO public.billing_plans (
        id,
        studio_id,
        name,
        amount_cents
    )
    VALUES (
        v_ambiguous_billing_plan,
        v_ambiguous_studio_a,
        'RLS Ambiguous Billing Plan',
        1000
    );

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
        ),
        (
            v_ambiguous_support_ticket,
            v_ambiguous_studio_a,
            v_ambiguous_owner,
            'ticket-ambiguous@example.invalid',
            'product_question',
            'normal',
            'Hidden ambiguous support ticket',
            'RLS ambiguous-membership ticket',
            'open'
        );

    INSERT INTO public.account_deletion_requests (
        id,
        user_id,
        studio_id,
        requested_by,
        requester_email,
        status,
        requested_at,
        scheduled_for,
        canceled_at,
        canceled_by
    )
    VALUES (
        v_ambiguous_deletion_request,
        v_ambiguous_owner,
        v_ambiguous_studio_a,
        v_ambiguous_owner,
        'deletion-ambiguous@example.invalid',
        'canceled',
        now(),
        now() + INTERVAL '1 day',
        now(),
        v_ambiguous_owner
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
        SELECT id FROM public.guardians WHERE id = v_guardian_a
        UNION ALL
        SELECT id FROM public.leads WHERE id = v_lead_a
        UNION ALL
        SELECT id FROM public.support_tickets WHERE id = v_support_ticket_a
    ) AS visible_rows;

    IF v_own_tenant_count <> 6 THEN
        RAISE EXCEPTION 'Authenticated owner A can read only % of 6 own-tenant private rows.', v_own_tenant_count;
    END IF;

    SELECT COUNT(*) INTO v_cross_tenant_count
    FROM (
        SELECT id FROM public.studios WHERE id = v_studio_b
        UNION ALL
        SELECT id FROM public.staff_roles WHERE studio_id = v_studio_b
        UNION ALL
        SELECT id FROM public.programs WHERE id = v_program_b
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

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', v_zero_membership_user::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    IF NOT private.has_unambiguous_studio_membership() THEN
        RAISE EXCEPTION 'A zero-membership identity was treated as ambiguous.';
    END IF;

    SELECT COUNT(*) INTO v_zero_membership_visible_count
    FROM (
        SELECT id FROM public.studios
        UNION ALL
        SELECT id FROM public.staff_roles
        UNION ALL
        SELECT id FROM public.programs
    ) AS visible_rows;

    IF v_zero_membership_visible_count <> 0 THEN
        RAISE EXCEPTION 'The restrictive guard granted % row(s) to a zero-membership identity.', v_zero_membership_visible_count;
    END IF;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', v_ambiguous_owner::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    SELECT COUNT(*) INTO v_ambiguous_visible_count
    FROM (
        -- Owner/self policies, direct staff_roles subqueries, and private role
        -- helpers must all fail closed for the same ambiguous identity.
        SELECT id FROM public.studios
        WHERE id IN (v_ambiguous_studio_a, v_ambiguous_studio_b)
        UNION ALL
        SELECT id FROM public.staff_roles
        WHERE user_id = v_ambiguous_owner
        UNION ALL
        SELECT id FROM public.programs
        WHERE id = v_ambiguous_program
        UNION ALL
        SELECT id FROM public.support_tickets
        WHERE id = v_ambiguous_support_ticket
        UNION ALL
        SELECT id FROM public.account_deletion_requests
        WHERE id = v_ambiguous_deletion_request
        UNION ALL
        SELECT id FROM public.billing_plans
        WHERE id = v_ambiguous_billing_plan
    ) AS visible_rows;

    IF v_ambiguous_visible_count <> 0 THEN
        RAISE EXCEPTION 'Ambiguous staff identity can read % protected Data API row(s).', v_ambiguous_visible_count;
    END IF;

    IF private.is_staff_in_studio(v_ambiguous_studio_a)
       OR private.is_admin_or_front_desk_in_studio(v_ambiguous_studio_a)
       OR private.is_admin_in_studio(v_ambiguous_studio_a) THEN
        RAISE EXCEPTION 'A private role helper authorized an ambiguous staff identity.';
    END IF;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    EXECUTE 'SET LOCAL ROLE service_role';

    SELECT COUNT(*) INTO v_service_visible_count
    FROM (
        SELECT id FROM public.studios
        WHERE id IN (v_ambiguous_studio_a, v_ambiguous_studio_b)
        UNION ALL
        SELECT id FROM public.staff_roles
        WHERE user_id = v_ambiguous_owner
        UNION ALL
        SELECT id FROM public.programs
        WHERE id = v_ambiguous_program
        UNION ALL
        SELECT id FROM public.support_tickets
        WHERE id = v_ambiguous_support_ticket
        UNION ALL
        SELECT id FROM public.account_deletion_requests
        WHERE id = v_ambiguous_deletion_request
        UNION ALL
        SELECT id FROM public.billing_plans
        WHERE id = v_ambiguous_billing_plan
    ) AS visible_rows;

    IF v_service_visible_count <> 8 THEN
        RAISE EXCEPTION 'Service role can read only % of 8 preserved historical rows.', v_service_visible_count;
    END IF;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', v_owner_a::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

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
