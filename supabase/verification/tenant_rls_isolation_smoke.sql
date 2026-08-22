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
    v_zero_onboarding_studio UUID := gen_random_uuid();
    v_ambiguous_insert_studio UUID := gen_random_uuid();
    v_service_write_studio UUID := gen_random_uuid();
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
    v_ambiguous_insert_denied BOOLEAN := false;
    v_ambiguous_update_count INTEGER := 0;
    v_ambiguous_delete_count INTEGER := 0;
    v_zero_update_count INTEGER := 0;
    v_zero_delete_count INTEGER := 0;
    v_service_update_count INTEGER := 0;
    v_service_delete_count INTEGER := 0;
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
                AND policy.polname = 'reject_ambiguous_staff_membership_access'
                AND NOT policy.polpermissive
                AND policy.polcmd = '*'
                AND policy_role.rolname = 'authenticated'
                AND pg_catalog.regexp_replace(
                    pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                    '[[:space:]]+',
                    '',
                    'g'
                ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
                AND pg_catalog.regexp_replace(
                    pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
                    '[[:space:]]+',
                    '',
                    'g'
                ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
          )
    ) THEN
        RAISE EXCEPTION 'A public RLS table is missing the all-command ambiguous-membership guard.';
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

    -- Exercise the restrictive guard against a permissive owner-write path.
    -- These DDL changes are visible only inside this rollback-only transaction.
    -- SELECT is granted here too. Migration 20260822193000 revoked the API
    -- roles' standing read access, so without this the role is refused before
    -- RLS is ever consulted and the isolation assertions below would pass
    -- vacuously. RLS remains the defence-in-depth layer under that revoke, and
    -- this contract is what proves it still isolates tenants.
    EXECUTE 'GRANT SELECT ON TABLE public.account_deletion_requests, public.billing_plans, '
            || 'public.guardians, public.leads, public.programs, public.staff_roles, '
            || 'public.students, public.support_tickets TO authenticated';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.studios TO authenticated';
    EXECUTE 'CREATE POLICY tenant_rls_verification_owner_write ON public.studios FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())';

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

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_zero_onboarding_studio,
        'Koaryu RLS Zero-Membership Onboarding',
        'koaryu-rls-zero-onboarding-' || replace(v_zero_onboarding_studio::TEXT, '-', ''),
        v_zero_membership_user
    );

    UPDATE public.studios
    SET name = 'Koaryu RLS Zero-Membership Onboarding Updated'
    WHERE id = v_zero_onboarding_studio;
    GET DIAGNOSTICS v_zero_update_count = ROW_COUNT;

    DELETE FROM public.studios
    WHERE id = v_zero_onboarding_studio;
    GET DIAGNOSTICS v_zero_delete_count = ROW_COUNT;

    IF v_zero_update_count <> 1 OR v_zero_delete_count <> 1 THEN
        RAISE EXCEPTION 'Zero-membership onboarding write path changed: update %, delete %.',
            v_zero_update_count,
            v_zero_delete_count;
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

    BEGIN
        INSERT INTO public.studios (id, name, slug, owner_id)
        VALUES (
            v_ambiguous_insert_studio,
            'Koaryu RLS Rejected Ambiguous Insert',
            'koaryu-rls-rejected-insert-' || replace(v_ambiguous_insert_studio::TEXT, '-', ''),
            v_ambiguous_owner
        );
    EXCEPTION
        WHEN insufficient_privilege THEN
            v_ambiguous_insert_denied := true;
    END;

    UPDATE public.studios
    SET name = 'Koaryu RLS Rejected Ambiguous Update'
    WHERE id = v_ambiguous_studio_a;
    GET DIAGNOSTICS v_ambiguous_update_count = ROW_COUNT;

    DELETE FROM public.studios
    WHERE id = v_ambiguous_studio_b;
    GET DIAGNOSTICS v_ambiguous_delete_count = ROW_COUNT;

    IF NOT v_ambiguous_insert_denied
       OR v_ambiguous_update_count <> 0
       OR v_ambiguous_delete_count <> 0 THEN
        RAISE EXCEPTION 'Ambiguous identity write guard failed: insert %, update %, delete %.',
            v_ambiguous_insert_denied,
            v_ambiguous_update_count,
            v_ambiguous_delete_count;
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

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_service_write_studio,
        'Koaryu RLS Service Write',
        'koaryu-rls-service-write-' || replace(v_service_write_studio::TEXT, '-', ''),
        v_zero_membership_user
    );

    UPDATE public.studios
    SET name = 'Koaryu RLS Service Write Updated'
    WHERE id = v_service_write_studio;
    GET DIAGNOSTICS v_service_update_count = ROW_COUNT;

    DELETE FROM public.studios
    WHERE id = v_service_write_studio;
    GET DIAGNOSTICS v_service_delete_count = ROW_COUNT;

    IF v_service_update_count <> 1 OR v_service_delete_count <> 1 THEN
        RAISE EXCEPTION 'Service-role write behavior changed: update %, delete %.',
            v_service_update_count,
            v_service_delete_count;
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

DO $$
DECLARE
    v_viewer UUID := gen_random_uuid();
    v_same_studio_staff UUID := gen_random_uuid();
    v_cross_studio_staff UUID := gen_random_uuid();
    v_audit_actor UUID := gen_random_uuid();
    v_backfill_good UUID := gen_random_uuid();
    v_backfill_single_token UUID := gen_random_uuid();
    v_backfill_blank UUID := gen_random_uuid();
    v_backfill_trailing_token UUID := gen_random_uuid();
    v_direct_insert_user UUID := gen_random_uuid();
    v_studio_a UUID := gen_random_uuid();
    v_studio_b UUID := gen_random_uuid();
    v_audit_id UUID;
    v_after_delete_audit_id UUID;
    v_count INTEGER;
    v_denied BOOLEAN;
    v_actor_legal_name TEXT;
    v_auth_full_name TEXT;
    v_helper_definition TEXT;
BEGIN
    IF to_regclass('public.staff_profiles') IS NULL THEN
        RAISE EXCEPTION 'Missing public.staff_profiles table.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE relation.oid = 'public.staff_profiles'::REGCLASS
          AND namespace.nspname = 'public'
          AND relation.relkind = 'r'
          AND relation.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'staff_profiles must be a public table with RLS enabled.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_policy AS policy
        WHERE policy.polrelid = 'public.staff_roles'::REGCLASS
          AND policy.polname = 'staff_roles_select_same_studio'
    ) THEN
        RAISE EXCEPTION 'The staff_roles same-studio policy must not exist.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc AS function_row
        JOIN pg_namespace AS function_schema
          ON function_schema.oid = function_row.pronamespace
        WHERE function_row.oid = 'private.can_read_staff_profile(uuid)'::REGPROCEDURE
          AND function_schema.nspname = 'private'
          AND function_row.provolatile = 's'
          AND function_row.prosecdef
          AND 'search_path=""' = ANY(COALESCE(function_row.proconfig, ARRAY[]::TEXT[]))
    ) THEN
        RAISE EXCEPTION 'Private staff-profile helper must be STABLE SECURITY DEFINER with an empty search_path.';
    END IF;

    SELECT pg_get_functiondef(function_row.oid)
    INTO v_helper_definition
    FROM pg_proc AS function_row
    WHERE function_row.oid = 'private.can_read_staff_profile(uuid)'::REGPROCEDURE;

    IF v_helper_definition NOT ILIKE '%auth.uid() IS NOT NULL%'
       OR v_helper_definition NOT ILIKE '%private.has_unambiguous_studio_membership()%'
       OR v_helper_definition NOT ILIKE '%public.staff_roles%' THEN
        RAISE EXCEPTION 'Private staff-profile helper does not enforce the required membership invariants.';
    END IF;

    IF NOT has_function_privilege(
        'authenticated',
        'private.can_read_staff_profile(uuid)',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'private.can_read_staff_profile(uuid)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'private.can_read_staff_profile(uuid)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Private staff-profile helper EXECUTE privileges are incorrect.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function_row
        CROSS JOIN LATERAL aclexplode(
            COALESCE(function_row.proacl, acldefault('f', function_row.proowner))
        ) AS privilege
        LEFT JOIN pg_roles AS grantee
          ON grantee.oid = privilege.grantee
        WHERE function_row.oid = 'private.can_read_staff_profile(uuid)'::REGPROCEDURE
          AND (
              privilege.grantee = 0
              OR grantee.rolname IN ('anon', 'service_role')
          )
    ) THEN
        RAISE EXCEPTION 'Private staff-profile helper is exposed to PUBLIC, anon, or service_role.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function_row
        JOIN pg_namespace AS function_schema
          ON function_schema.oid = function_row.pronamespace
        WHERE function_row.proname = 'can_read_staff_profile'
          AND function_schema.nspname <> 'private'
    ) THEN
        RAISE EXCEPTION 'Staff-profile helper escaped the private schema.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.staff_profiles'::REGCLASS
          AND constraint_row.conname = 'staff_profiles_pkey'
          AND constraint_row.contype = 'p'
          AND constraint_row.convalidated
    ) THEN
        RAISE EXCEPTION 'staff_profiles.user_id primary key is missing or invalid.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.staff_profiles'::REGCLASS
          AND constraint_row.conname = 'staff_profiles_user_id_fkey'
          AND constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'auth.users'::REGCLASS
          AND constraint_row.confdeltype = 'c'
          AND constraint_row.convalidated
    ) THEN
        RAISE EXCEPTION 'staff_profiles.user_id must cascade on auth.users deletion.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.staff_profiles'::REGCLASS
          AND constraint_row.conname IN (
              'staff_profiles_legal_first_name_normalized',
              'staff_profiles_legal_last_name_normalized'
          )
          AND constraint_row.contype = 'c'
          AND constraint_row.convalidated
        GROUP BY constraint_row.conrelid
        HAVING COUNT(*) = 2
    ) THEN
        RAISE EXCEPTION 'Normalized legal-name constraints are missing or invalid.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns AS column_row
        WHERE column_row.table_schema = 'public'
          AND column_row.table_name = 'staff_profiles'
          AND column_row.column_name IN (
              'user_id',
              'legal_first_name',
              'legal_last_name',
              'created_at',
              'updated_at'
          )
          AND column_row.is_nullable <> 'NO'
    ) OR EXISTS (
        SELECT 1
        FROM information_schema.columns AS column_row
        WHERE column_row.table_schema = 'public'
          AND column_row.table_name = 'audit_logs'
          AND column_row.column_name = 'actor_legal_name'
          AND column_row.is_nullable <> 'YES'
    ) THEN
        RAISE EXCEPTION 'Staff-profile or audit actor-name nullability is incorrect.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.staff_profiles'::REGCLASS
          AND trigger_row.tgname = 'set_staff_profiles_updated_at'
          AND trigger_row.tgenabled <> 'D'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = 'public.update_updated_at_column()'::REGPROCEDURE
          AND pg_get_triggerdef(trigger_row.oid) ILIKE '%BEFORE UPDATE%'
    ) THEN
        RAISE EXCEPTION 'staff_profiles updated_at trigger is missing or disabled.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.audit_logs'::REGCLASS
          AND trigger_row.tgname = 'set_audit_actor_legal_name'
          AND trigger_row.tgenabled <> 'D'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = 'private.set_audit_actor_legal_name()'::REGPROCEDURE
          AND pg_get_triggerdef(trigger_row.oid) ILIKE '%BEFORE INSERT%'
    ) THEN
        RAISE EXCEPTION 'Audit actor legal-name trigger is missing or disabled.';
    END IF;

    IF (
        SELECT COUNT(*)
        FROM pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.audit_logs'::REGCLASS
          AND trigger_row.tgname = 'set_audit_actor_legal_name'
          AND NOT trigger_row.tgisinternal
    ) <> 1 THEN
        RAISE EXCEPTION 'Expected exactly one audit actor legal-name trigger.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc AS function_row
        WHERE function_row.oid = 'private.set_audit_actor_legal_name()'::REGPROCEDURE
          AND NOT function_row.prosecdef
          AND 'search_path=""' = ANY(COALESCE(function_row.proconfig, ARRAY[]::TEXT[]))
    ) THEN
        RAISE EXCEPTION 'Audit trigger function must be invoker-safe with an empty search_path.';
    END IF;

    IF has_function_privilege('anon', 'private.set_audit_actor_legal_name()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.set_audit_actor_legal_name()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.set_audit_actor_legal_name()', 'EXECUTE') THEN
        RAISE EXCEPTION 'Audit trigger function is over-privileged.';
    END IF;

    IF has_table_privilege('anon', 'public.staff_profiles', 'SELECT')
       OR has_table_privilege('anon', 'public.staff_profiles', 'INSERT')
       OR has_table_privilege('anon', 'public.staff_profiles', 'UPDATE')
       OR has_table_privilege('anon', 'public.staff_profiles', 'DELETE')
       OR has_table_privilege('authenticated', 'public.staff_profiles', 'INSERT')
       OR has_table_privilege('authenticated', 'public.staff_profiles', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.staff_profiles', 'DELETE')
       -- Migration 20260822193000 revoked the standing read. Staff profiles
       -- reach the browser through the backend, which connects as service_role.
       OR has_table_privilege('authenticated', 'public.staff_profiles', 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.staff_profiles', 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.staff_profiles', 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.staff_profiles', 'UPDATE')
       OR NOT has_table_privilege('service_role', 'public.staff_profiles', 'DELETE') THEN
        RAISE EXCEPTION 'staff_profiles table grants are incorrect.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class AS relation
        CROSS JOIN LATERAL aclexplode(
            COALESCE(relation.relacl, acldefault('r', relation.relowner))
        ) AS privilege
        WHERE relation.oid = 'public.staff_profiles'::REGCLASS
          AND privilege.grantee = 0
    ) THEN
        RAISE EXCEPTION 'PUBLIC still has direct staff_profiles privileges.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policy AS policy
        JOIN pg_roles AS policy_role
          ON policy_role.oid = ANY(policy.polroles)
        WHERE policy.polrelid = 'public.staff_profiles'::REGCLASS
          AND policy.polname = 'staff_profiles_select_shared_studio'
          AND policy.polpermissive
          AND policy.polcmd = 'r'
          AND policy_role.rolname = 'authenticated'
          AND pg_get_expr(policy.polqual, policy.polrelid) ILIKE '%private.can_read_staff_profile%'
    ) THEN
        RAISE EXCEPTION 'Shared-studio staff_profiles SELECT policy is missing.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_policy AS policy
        JOIN pg_roles AS policy_role
          ON policy_role.oid = ANY(policy.polroles)
        WHERE policy.polrelid = 'public.staff_profiles'::REGCLASS
          AND policy.polpermissive
          AND policy.polcmd IN ('a', 'w', 'd')
          AND policy_role.rolname = 'authenticated'
    ) THEN
        RAISE EXCEPTION 'staff_profiles has a permissive authenticated write policy.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policy AS policy
        JOIN pg_roles AS policy_role
          ON policy_role.oid = ANY(policy.polroles)
        WHERE policy.polrelid = 'public.staff_profiles'::REGCLASS
          AND policy.polname = 'reject_ambiguous_staff_membership_access'
          AND NOT policy.polpermissive
          AND policy.polcmd = '*'
          AND policy_role.rolname = 'authenticated'
          AND pg_catalog.regexp_replace(
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
              '[[:space:]]+',
              '',
              'g'
          ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
          AND pg_catalog.regexp_replace(
              pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
              '[[:space:]]+',
              '',
              'g'
          ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
    ) THEN
        RAISE EXCEPTION 'staff_profiles is missing the required restrictive membership guard.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns AS column_row
        WHERE column_row.table_schema = 'public'
          AND column_row.table_name = 'audit_logs'
          AND column_row.column_name = 'actor_legal_name'
    ) THEN
        RAISE EXCEPTION 'audit_logs actor legal-name column is missing.';
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
        (v_viewer, 'authenticated', 'authenticated', 'staff-name-viewer-' || v_viewer || '@example.invalid', '{}', '{}', now(), now()),
        (v_same_studio_staff, 'authenticated', 'authenticated', 'staff-name-same-' || v_same_studio_staff || '@example.invalid', '{}', '{}', now(), now()),
        (v_cross_studio_staff, 'authenticated', 'authenticated', 'staff-name-cross-' || v_cross_studio_staff || '@example.invalid', '{}', '{}', now(), now()),
        (v_audit_actor, 'authenticated', 'authenticated', 'staff-name-audit-' || v_audit_actor || '@example.invalid', '{}', '{}', now(), now()),
        (v_backfill_good, 'authenticated', 'authenticated', 'staff-name-backfill-good-' || v_backfill_good || '@example.invalid', '{}', jsonb_build_object('full_name', E'  Ada\t  Lovelace  '), now(), now()),
        (v_backfill_single_token, 'authenticated', 'authenticated', 'staff-name-backfill-single-' || v_backfill_single_token || '@example.invalid', '{}', jsonb_build_object('full_name', 'Plato'), now(), now()),
        (v_backfill_blank, 'authenticated', 'authenticated', 'staff-name-backfill-blank-' || v_backfill_blank || '@example.invalid', '{}', jsonb_build_object('full_name', E' \t\n '), now(), now()),
        (v_backfill_trailing_token, 'authenticated', 'authenticated', 'staff-name-backfill-trailing-' || v_backfill_trailing_token || '@example.invalid', '{}', jsonb_build_object('full_name', 'Cher   '), now(), now()),
        (v_direct_insert_user, 'authenticated', 'authenticated', 'staff-name-direct-' || v_direct_insert_user || '@example.invalid', '{}', '{}', now(), now());

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio_a, 'Staff Identity Studio A', 'staff-identity-a-' || replace(v_studio_a::TEXT, '-', ''), v_viewer),
        (v_studio_b, 'Staff Identity Studio B', 'staff-identity-b-' || replace(v_studio_b::TEXT, '-', ''), v_cross_studio_staff);

    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES
        (v_studio_a, v_viewer, 'admin'),
        (v_studio_a, v_same_studio_staff, 'instructor'),
        (v_studio_a, v_audit_actor, 'front_desk'),
        (v_studio_b, v_cross_studio_staff, 'admin');

    INSERT INTO public.staff_profiles (
        user_id,
        legal_first_name,
        legal_last_name
    )
    VALUES
        (v_viewer, 'Alice', 'Viewer'),
        (v_same_studio_staff, 'Same', 'Studio'),
        (v_cross_studio_staff, 'Cross', 'Studio'),
        (v_audit_actor, 'Audit', 'Actor');

    -- Replay the migration's exact normalization and first-whitespace split
    -- against users seeded after migration application.
    WITH normalized_names AS (
        SELECT
            users.id AS user_id,
            pg_catalog.btrim(
                pg_catalog.regexp_replace(
                    COALESCE(users.raw_user_meta_data ->> 'full_name', ''),
                    '[[:space:]]+',
                    ' ',
                    'g'
                )
            ) AS full_name
        FROM auth.users AS users
    ), split_names AS (
        SELECT
            normalized_names.user_id,
            pg_catalog.substr(normalized_names.full_name, 1, pg_catalog.strpos(normalized_names.full_name, ' ') - 1)
                AS legal_first_name,
            pg_catalog.substr(normalized_names.full_name, pg_catalog.strpos(normalized_names.full_name, ' ') + 1)
                AS legal_last_name
        FROM normalized_names
        WHERE pg_catalog.strpos(normalized_names.full_name, ' ') > 0
    )
    INSERT INTO public.staff_profiles (
        user_id,
        legal_first_name,
        legal_last_name
    )
    SELECT
        split_names.user_id,
        split_names.legal_first_name,
        split_names.legal_last_name
    FROM split_names
    WHERE split_names.legal_first_name <> ''
      AND split_names.legal_last_name <> '';

    SELECT COUNT(*)
    INTO v_count
    FROM public.staff_profiles
    WHERE user_id = v_backfill_good
      AND legal_first_name = 'Ada'
      AND legal_last_name = 'Lovelace';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Splittable full_name did not backfill to Ada Lovelace.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.staff_profiles
        WHERE user_id IN (
            v_backfill_single_token,
            v_backfill_blank,
            v_backfill_trailing_token
        )
    ) THEN
        RAISE EXCEPTION 'Blank or unsplittable full_name created a staff profile.';
    END IF;

    SELECT raw_user_meta_data ->> 'full_name'
    INTO v_auth_full_name
    FROM auth.users
    WHERE id = v_backfill_good;

    IF v_auth_full_name <> E'  Ada\t  Lovelace  ' THEN
        RAISE EXCEPTION 'Auth full_name metadata was modified during backfill.';
    END IF;

    v_denied := false;
    BEGIN
        INSERT INTO public.staff_profiles (user_id, legal_first_name, legal_last_name)
        VALUES (v_direct_insert_user, E'Bad  Name', 'Constraint');
    EXCEPTION WHEN check_violation THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Unnormalized legal name bypassed its database constraint.';
    END IF;

    -- Migration 20260822193000 revoked the API roles' standing read access, so
    -- grant it back for the length of this rollback-only transaction. Without
    -- it the role is refused before RLS is consulted and the self-visibility
    -- assertions below would pass without exercising anything.
    EXECUTE 'GRANT SELECT ON TABLE public.staff_profiles TO authenticated';
    PERFORM set_config('request.jwt.claim.sub', v_viewer::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    SELECT COUNT(*)
    INTO v_count
    FROM public.staff_profiles
    WHERE user_id IN (v_viewer, v_same_studio_staff);

    IF v_count <> 2 THEN
        RAISE EXCEPTION 'Same-studio authenticated profile reads returned % rows instead of 2.', v_count;
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.staff_profiles
    WHERE user_id = v_cross_studio_staff;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'Cross-studio authenticated profile read returned % row(s).', v_count;
    END IF;

    v_denied := false;
    BEGIN
        INSERT INTO public.staff_profiles (user_id, legal_first_name, legal_last_name)
        VALUES (v_direct_insert_user, 'Blocked', 'Insert');
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '42501' THEN
            RAISE;
        END IF;
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Authenticated direct INSERT was accepted after session role switch.';
    END IF;

    v_denied := false;
    BEGIN
        UPDATE public.staff_profiles
        SET legal_first_name = 'Spoofed'
        WHERE user_id = v_viewer;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '42501' THEN
            RAISE;
        END IF;
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Authenticated existing-row self-update was accepted.';
    END IF;

    v_denied := false;
    BEGIN
        DELETE FROM public.staff_profiles
        WHERE user_id = v_viewer;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> '42501' THEN
            RAISE;
        END IF;
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Authenticated direct DELETE was accepted.';
    END IF;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    IF NOT EXISTS (
        SELECT 1
        FROM public.staff_profiles
        WHERE user_id = v_viewer
          AND legal_first_name = 'Alice'
          AND legal_last_name = 'Viewer'
    ) THEN
        RAISE EXCEPTION 'Authenticated self-update changed an existing legal name.';
    END IF;

    EXECUTE $function$
        CREATE FUNCTION pg_temp.insert_staff_identity_audit(
            p_studio_id UUID,
            p_actor_id UUID,
            p_actor_legal_name TEXT
        )
        RETURNS UUID
        LANGUAGE SQL
        SET search_path = ''
        AS $body$
            INSERT INTO public.audit_logs (
                studio_id,
                actor_id,
                actor_legal_name,
                action,
                entity_type,
                metadata
            )
            VALUES (
                p_studio_id,
                p_actor_id,
                p_actor_legal_name,
                'staff.identity.contract',
                'staff_profile',
                '{}'::JSONB
            )
            RETURNING id
        $body$;
    $function$;

    SELECT pg_temp.insert_staff_identity_audit(
        v_studio_a,
        v_audit_actor,
        'Spoofed Caller Name'
    )
    INTO v_audit_id;

    SELECT actor_legal_name
    INTO v_actor_legal_name
    FROM public.audit_logs
    WHERE id = v_audit_id;

    IF v_actor_legal_name <> 'Audit Actor' THEN
        RAISE EXCEPTION 'Audit trigger trusted a spoofed actor_legal_name: %.', v_actor_legal_name;
    END IF;

    DELETE FROM auth.users
    WHERE id = v_audit_actor;

    IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_audit_actor)
       OR EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id = v_audit_actor) THEN
        RAISE EXCEPTION 'Deleting an Auth user did not remove its staff profile.';
    END IF;

    SELECT actor_legal_name
    INTO v_actor_legal_name
    FROM public.audit_logs
    WHERE id = v_audit_id;

    IF v_actor_legal_name <> 'Audit Actor' THEN
        RAISE EXCEPTION 'Stored audit actor legal name changed after identity deletion.';
    END IF;

    SELECT pg_temp.insert_staff_identity_audit(
        v_studio_a,
        v_audit_actor,
        'After Delete Spoof'
    )
    INTO v_after_delete_audit_id;

    SELECT actor_legal_name
    INTO v_actor_legal_name
    FROM public.audit_logs
    WHERE id = v_after_delete_audit_id;

    IF v_actor_legal_name IS NOT NULL THEN
        RAISE EXCEPTION 'Audit trigger did not clear actor_legal_name for a missing profile.';
    END IF;

    RAISE NOTICE 'Staff identity name model verification passed.';
END
$$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_owner_surviving_admin UUID := gen_random_uuid();
    v_active_staff UUID := gen_random_uuid();
    v_archived_caller UUID := gen_random_uuid();
    v_archived_target UUID := gen_random_uuid();
    v_last_admin_owner UUID := gen_random_uuid();
    v_last_admin UUID := gen_random_uuid();
    v_owner_replacement_user UUID := gen_random_uuid();
    v_identity_owner UUID := gen_random_uuid();
    v_identity_departing_admin UUID := gen_random_uuid();
    v_identity_surviving_admin UUID := gen_random_uuid();
    v_identity_replacement_user UUID := gen_random_uuid();
    v_pending_user UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_last_admin_studio UUID := gen_random_uuid();
    v_identity_studio UUID := gen_random_uuid();
    v_program UUID := gen_random_uuid();
    v_archived_role_count INTEGER;
    v_archived_program_count INTEGER;
    v_archived_profile_count INTEGER;
    v_active_program_count INTEGER;
    v_active_role_count INTEGER;
    v_active_profile_count INTEGER;
    v_service_role_count INTEGER;
    v_service_profile_count INTEGER;
    v_service_program_count INTEGER;
    v_denied BOOLEAN := false;
    v_owner_archive_denied BOOLEAN := false;
    v_last_admin_archive_denied BOOLEAN := false;
    v_owner_identity_denied BOOLEAN := false;
    v_owner_clear_denied BOOLEAN := false;
    v_owner_demote_denied BOOLEAN := false;
    v_owner_archive_error TEXT;
    v_owner_identity_error TEXT;
    v_owner_clear_error TEXT;
    v_owner_demote_error TEXT;
    v_owner_survivor_predicate_count INTEGER;
    v_last_admin_identity_denied BOOLEAN := false;
    v_last_admin_clear_denied BOOLEAN := false;
    v_reservation_denied BOOLEAN := false;
    v_identity_change_count INTEGER;
    v_pending_link_count INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'staff_roles'
          AND column_name = 'archived_at'
          AND data_type = 'timestamp with time zone'
          AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'staff_roles.archived_at is missing or not nullable timestamptz.';
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
                AND policy.polname = 'reject_ambiguous_staff_membership_access'
                AND NOT policy.polpermissive
                AND policy.polcmd = '*'
                AND policy_role.rolname = 'authenticated'
                AND pg_catalog.regexp_replace(
                    pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
                    '[[:space:]]+', '', 'g'
                ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
                AND pg_catalog.regexp_replace(
                    pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid),
                    '[[:space:]]+', '', 'g'
                ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
          )
    ) THEN
        RAISE EXCEPTION 'A public RLS table is missing the archive-era restrictive membership guard.';
    END IF;

    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    )
    VALUES
        (v_owner, 'authenticated', 'authenticated', 'archive-owner-' || v_owner || '@example.invalid', '{}', '{}', now(), now()),
        (v_owner_surviving_admin, 'authenticated', 'authenticated', 'archive-owner-survivor-' || v_owner_surviving_admin || '@example.invalid', '{}', '{}', now(), now()),
        (v_active_staff, 'authenticated', 'authenticated', 'archive-active-' || v_active_staff || '@example.invalid', '{}', '{}', now(), now()),
        (v_archived_caller, 'authenticated', 'authenticated', 'archive-caller-' || v_archived_caller || '@example.invalid', '{}', '{}', now(), now()),
        (v_archived_target, 'authenticated', 'authenticated', 'archive-target-' || v_archived_target || '@example.invalid', '{}', '{}', now(), now()),
        (v_last_admin_owner, 'authenticated', 'authenticated', 'archive-last-owner-' || v_last_admin_owner || '@example.invalid', '{}', '{}', now(), now()),
        (v_last_admin, 'authenticated', 'authenticated', 'archive-last-admin-' || v_last_admin || '@example.invalid', '{}', '{}', now(), now()),
        (v_owner_replacement_user, 'authenticated', 'authenticated', 'archive-owner-replacement-' || v_owner_replacement_user || '@example.invalid', '{}', '{}', now(), now()),
        (v_identity_owner, 'authenticated', 'authenticated', 'archive-identity-owner-' || v_identity_owner || '@example.invalid', '{}', '{}', now(), now()),
        (v_identity_departing_admin, 'authenticated', 'authenticated', 'archive-identity-departing-' || v_identity_departing_admin || '@example.invalid', '{}', '{}', now(), now()),
        (v_identity_surviving_admin, 'authenticated', 'authenticated', 'archive-identity-survivor-' || v_identity_surviving_admin || '@example.invalid', '{}', '{}', now(), now()),
        (v_identity_replacement_user, 'authenticated', 'authenticated', 'archive-identity-replacement-' || v_identity_replacement_user || '@example.invalid', '{}', '{}', now(), now()),
        (v_pending_user, 'authenticated', 'authenticated', 'archive-pending-link-' || v_pending_user || '@example.invalid', '{}', '{}', now(), now());

    UPDATE auth.users
    SET email_confirmed_at = clock_timestamp()
    WHERE id IN (v_owner_surviving_admin, v_identity_surviving_admin);

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Archive Authorization Studio', 'archive-authorization-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_last_admin_studio, 'Last Active Admin Studio', 'archive-last-admin-' || replace(v_last_admin_studio::TEXT, '-', ''), v_last_admin_owner),
        (v_identity_studio, 'Admin Identity Guard Studio', 'archive-identity-guard-' || replace(v_identity_studio::TEXT, '-', ''), v_identity_owner);

    INSERT INTO public.staff_roles (studio_id, user_id, role)
    VALUES
        (v_studio, v_owner, 'admin'),
        (v_studio, v_owner_surviving_admin, 'admin'),
        (v_studio, v_active_staff, 'instructor'),
        (v_studio, v_archived_caller, 'instructor'),
        (v_studio, v_archived_target, 'instructor'),
        (v_last_admin_studio, v_last_admin, 'admin'),
        (v_identity_studio, v_identity_departing_admin, 'admin'),
        (v_identity_studio, v_identity_surviving_admin, 'admin');

    INSERT INTO public.staff_profiles (user_id, legal_first_name, legal_last_name)
    VALUES
        (v_owner, 'Archive', 'Owner'),
        (v_active_staff, 'Active', 'Staff'),
        (v_archived_caller, 'Archived', 'Caller'),
        (v_archived_target, 'Archived', 'Target');

    INSERT INTO public.programs (id, studio_id, name)
    VALUES (v_program, v_studio, 'Archive Authorization Program');

    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);
    EXECUTE 'SET LOCAL ROLE service_role';

    UPDATE public.staff_roles
    SET archived_at = clock_timestamp()
    WHERE user_id IN (v_archived_caller, v_archived_target);

    SELECT COUNT(*) INTO v_service_role_count
    FROM public.staff_roles
    WHERE user_id IN (v_archived_caller, v_archived_target)
      AND archived_at IS NOT NULL;
    SELECT COUNT(*) INTO v_service_profile_count
    FROM public.staff_profiles
    WHERE user_id IN (v_archived_caller, v_archived_target);
    SELECT COUNT(*) INTO v_service_program_count
    FROM public.programs
    WHERE id = v_program;

    IF v_service_role_count <> 2 OR v_service_profile_count <> 2 OR v_service_program_count <> 1 THEN
        RAISE EXCEPTION 'Service role lost operational visibility: roles %, profiles %, programs %.',
            v_service_role_count, v_service_profile_count, v_service_program_count;
    END IF;

    EXECUTE 'RESET ROLE';
    -- Migration 20260822193000 revoked the API roles' standing read access, so
    -- grant it back for the length of this rollback-only transaction. Without
    -- it the role is refused before RLS is consulted and the archived-staff
    -- visibility assertions below would pass without exercising anything.
    EXECUTE 'GRANT SELECT ON TABLE public.account_deletion_requests, public.programs, '
            || 'public.staff_profiles, public.staff_roles TO authenticated';
    PERFORM set_config('request.jwt.claim.sub', v_archived_caller::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    IF private.has_unambiguous_studio_membership()
       OR private.is_staff_in_studio(v_studio)
       OR private.is_admin_or_front_desk_in_studio(v_studio)
       OR private.is_admin_in_studio(v_studio)
       OR private.can_read_staff_profile(v_archived_target) THEN
        RAISE EXCEPTION 'An archived caller reached a central or private authorization helper.';
    END IF;

    SELECT COUNT(*) INTO v_archived_role_count
    FROM public.staff_roles
    WHERE user_id = v_archived_caller;
    SELECT COUNT(*) INTO v_archived_program_count
    FROM public.programs
    WHERE id = v_program;
    SELECT COUNT(*) INTO v_archived_profile_count
    FROM public.staff_profiles
    WHERE user_id = v_archived_target;

    IF v_archived_role_count <> 0
       OR v_archived_program_count <> 0
       OR v_archived_profile_count <> 0 THEN
        RAISE EXCEPTION 'Archived caller retained direct/helper-path visibility: roles %, programs %, profiles %.',
            v_archived_role_count, v_archived_program_count, v_archived_profile_count;
    END IF;

    IF has_table_privilege('authenticated', 'public.staff_roles', 'UPDATE') THEN
        RAISE EXCEPTION 'Authenticated clients retain staff_roles UPDATE privilege.';
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET archived_at = NULL
        WHERE user_id = v_archived_target;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'Authenticated clients can archive or unarchive staff_roles directly.';
    END IF;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', v_owner::TEXT, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    IF NOT private.has_unambiguous_studio_membership()
       OR NOT private.is_staff_in_studio(v_studio)
       OR NOT private.is_admin_or_front_desk_in_studio(v_studio)
       OR NOT private.is_admin_in_studio(v_studio)
       OR NOT private.can_read_staff_profile(v_active_staff) THEN
        RAISE EXCEPTION 'Active same-studio authorization was lost.';
    END IF;

    SELECT COUNT(*) INTO v_active_role_count
    FROM public.staff_roles
    WHERE user_id = v_owner;
    SELECT COUNT(*) INTO v_active_program_count
    FROM public.programs
    WHERE id = v_program;
    SELECT COUNT(*) INTO v_active_profile_count
    FROM public.staff_profiles
    WHERE user_id = v_active_staff;

    IF v_active_role_count <> 1
       OR v_active_program_count <> 1
       OR v_active_profile_count <> 1
       OR EXISTS (
           SELECT 1 FROM public.staff_profiles WHERE user_id = v_archived_target
       ) THEN
        RAISE EXCEPTION 'Active same-studio or archived-target profile policy behavior changed.';
    END IF;

    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', '', true);

    -- The PostgreSQL test owner proves auth confirmation and deletion status;
    -- service_role intentionally cannot read auth.users directly.
    SELECT COUNT(*) INTO v_owner_survivor_predicate_count
    FROM public.staff_roles AS membership
    JOIN auth.users AS auth_user
      ON auth_user.id = membership.user_id
    WHERE membership.studio_id = v_studio
      AND membership.user_id = v_owner_surviving_admin
      AND membership.role = 'admin'
      AND membership.archived_at IS NULL
      AND (auth_user.email_confirmed_at IS NOT NULL OR auth_user.last_sign_in_at IS NOT NULL)
      AND NOT EXISTS (
          SELECT 1
          FROM public.account_deletion_requests AS deletion_request
          WHERE deletion_request.user_id = membership.user_id
            AND deletion_request.status = 'scheduled'
      );
    IF v_owner_survivor_predicate_count <> 1 THEN
        RAISE EXCEPTION 'Owner guard survivor fixture is not a confirmed active unscheduled admin.';
    END IF;

    SELECT COUNT(*) INTO v_identity_change_count
    FROM public.staff_roles AS membership
    JOIN auth.users AS auth_user
      ON auth_user.id = membership.user_id
    WHERE membership.studio_id = v_identity_studio
      AND membership.user_id = v_identity_surviving_admin
      AND membership.role = 'admin'
      AND membership.archived_at IS NULL
      AND (auth_user.email_confirmed_at IS NOT NULL OR auth_user.last_sign_in_at IS NOT NULL)
      AND NOT EXISTS (
          SELECT 1
          FROM public.account_deletion_requests AS deletion_request
          WHERE deletion_request.user_id = membership.user_id
            AND deletion_request.status = 'scheduled'
      );
    IF v_identity_change_count <> 1 THEN
        RAISE EXCEPTION 'Identity-change survivor fixture is not an active unscheduled admin.';
    END IF;

    EXECUTE 'SET LOCAL ROLE service_role';

    BEGIN
        UPDATE public.staff_roles
        SET user_id = v_owner_replacement_user
        WHERE studio_id = v_studio
          AND user_id = v_owner;
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_owner_identity_error = MESSAGE_TEXT;
        v_owner_identity_denied := true;
    END;
    IF NOT v_owner_identity_denied
       OR v_owner_identity_error <> 'Transfer studio ownership before replacing or clearing this staff member identity.' THEN
        RAISE EXCEPTION 'Studio owner identity replacement was not refused by the owner guard: %',
            COALESCE(v_owner_identity_error, '<no check violation>');
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET user_id = NULL
        WHERE studio_id = v_studio
          AND user_id = v_owner;
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_owner_clear_error = MESSAGE_TEXT;
        v_owner_clear_denied := true;
    END;
    IF NOT v_owner_clear_denied
       OR v_owner_clear_error <> 'Transfer studio ownership before replacing or clearing this staff member identity.' THEN
        RAISE EXCEPTION 'Studio owner identity clearing was not refused by the owner guard: %',
            COALESCE(v_owner_clear_error, '<no check violation>');
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET role = 'instructor'
        WHERE studio_id = v_studio
          AND user_id = v_owner;
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_owner_demote_error = MESSAGE_TEXT;
        v_owner_demote_denied := true;
    END;
    IF NOT v_owner_demote_denied
       OR v_owner_demote_error <> 'Transfer studio ownership before deleting or demoting this staff member.' THEN
        RAISE EXCEPTION 'Studio owner demotion was not refused by the owner guard: %',
            COALESCE(v_owner_demote_error, '<no check violation>');
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET user_id = v_identity_replacement_user
        WHERE studio_id = v_last_admin_studio
          AND user_id = v_last_admin;
    EXCEPTION WHEN check_violation THEN
        v_last_admin_identity_denied := true;
    END;
    IF NOT v_last_admin_identity_denied THEN
        RAISE EXCEPTION 'Replacing the last active admin identity was accepted.';
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET user_id = NULL
        WHERE studio_id = v_last_admin_studio
          AND user_id = v_last_admin;
    EXCEPTION WHEN check_violation THEN
        v_last_admin_clear_denied := true;
    END;
    IF NOT v_last_admin_clear_denied THEN
        RAISE EXCEPTION 'Clearing the last active admin identity was accepted.';
    END IF;

    UPDATE public.staff_roles
    SET user_id = v_identity_replacement_user
    WHERE studio_id = v_identity_studio
      AND user_id = v_identity_departing_admin;
    GET DIAGNOSTICS v_identity_change_count = ROW_COUNT;

    IF v_identity_change_count <> 1
       OR NOT EXISTS (
           SELECT 1
           FROM public.staff_roles
           WHERE studio_id = v_identity_studio
             AND user_id = v_identity_replacement_user
             AND role = 'admin'
             AND archived_at IS NULL
       )
       OR EXISTS (
           SELECT 1
           FROM public.staff_roles
           WHERE studio_id = v_identity_studio
             AND user_id = v_identity_departing_admin
       ) THEN
        RAISE EXCEPTION 'Protected admin identity change did not preserve the survivor guard contract.';
    END IF;

    INSERT INTO public.staff_roles (studio_id, user_id, role, invited_email)
    VALUES (
        v_identity_studio,
        NULL,
        'instructor',
        'archive-pending-' || replace(v_pending_user::TEXT, '-', '') || '@example.invalid'
    );

    UPDATE public.staff_roles
    SET user_id = v_pending_user
    WHERE studio_id = v_identity_studio
      AND user_id IS NULL
      AND invited_email = 'archive-pending-' || replace(v_pending_user::TEXT, '-', '') || '@example.invalid';
    GET DIAGNOSTICS v_pending_link_count = ROW_COUNT;

    IF v_pending_link_count <> 1
       OR NOT EXISTS (
           SELECT 1
           FROM public.staff_roles
           WHERE studio_id = v_identity_studio
             AND user_id = v_pending_user
             AND role = 'instructor'
       ) THEN
        RAISE EXCEPTION 'A nullable pending staff reservation could not link to its invited identity.';
    END IF;

    BEGIN
        INSERT INTO public.staff_roles (studio_id, user_id, role)
        VALUES (v_last_admin_studio, v_archived_caller, 'instructor');
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> 'P0001' THEN
            RAISE;
        END IF;
        v_reservation_denied := true;
    END;
    IF NOT v_reservation_denied THEN
        RAISE EXCEPTION 'An archived membership no longer reserves its original single-studio identity.';
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET archived_at = clock_timestamp()
        WHERE studio_id = v_studio
          AND user_id = v_owner;
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_owner_archive_error = MESSAGE_TEXT;
        v_owner_archive_denied := true;
    END;
    IF NOT v_owner_archive_denied
       OR v_owner_archive_error <> 'Transfer studio ownership before archiving this staff member.' THEN
        RAISE EXCEPTION 'Studio owner archive was not refused by the owner guard: %',
            COALESCE(v_owner_archive_error, '<no check violation>');
    END IF;

    BEGIN
        UPDATE public.staff_roles
        SET archived_at = clock_timestamp()
        WHERE studio_id = v_last_admin_studio
          AND user_id = v_last_admin;
    EXCEPTION WHEN check_violation THEN
        v_last_admin_archive_denied := true;
    END;
    IF NOT v_last_admin_archive_denied THEN
        RAISE EXCEPTION 'Last active-admin archive was accepted.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.staff_roles
        WHERE (studio_id = v_studio AND user_id = v_owner AND archived_at IS NOT NULL)
           OR (studio_id = v_last_admin_studio AND user_id = v_last_admin AND archived_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'A refused owner or last-admin archive changed persisted state.';
    END IF;

    RAISE NOTICE 'Archive authorization, RLS, reservation, and admin identity-guard verification passed.';
END $$;

ROLLBACK;
