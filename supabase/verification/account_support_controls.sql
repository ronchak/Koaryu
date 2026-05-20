DO $$
DECLARE
    missing TEXT;
BEGIN
    SELECT string_agg(expected.version, ', ' ORDER BY expected.version)
    INTO missing
    FROM (VALUES
        ('20260520025149'),
        ('20260520041120'),
        ('20260520065000'),
        ('20260520070500'),
        ('20260520072000')
    ) AS expected(version)
    WHERE NOT EXISTS (
        SELECT 1
        FROM supabase_migrations.schema_migrations migration
        WHERE migration.version = expected.version
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing migration version(s): %', missing;
    END IF;

    SELECT string_agg(expected.table_name, ', ' ORDER BY expected.table_name)
    INTO missing
    FROM (VALUES
        ('account_deletion_requests'),
        ('support_ticket_events'),
        ('support_tickets')
    ) AS expected(table_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind = 'r'
          AND relation.relname = expected.table_name
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing public table(s): %', missing;
    END IF;

    SELECT string_agg(expected.table_name, ', ' ORDER BY expected.table_name)
    INTO missing
    FROM (VALUES
        ('account_deletion_requests'),
        ('support_ticket_events'),
        ('support_tickets')
    ) AS expected(table_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = expected.table_name
          AND relation.relrowsecurity
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'RLS is not enabled for public table(s): %', missing;
    END IF;

    SELECT string_agg(format('%s.%s', expected.table_name, expected.policy_name), ', ' ORDER BY expected.table_name, expected.policy_name)
    INTO missing
    FROM (VALUES
        ('account_deletion_requests', 'account_deletion_requests_self_select', 'SELECT'),
        ('support_ticket_events', 'support_ticket_events_staff_select', 'SELECT'),
        ('support_tickets', 'support_tickets_staff_select', 'SELECT')
    ) AS expected(table_name, policy_name, command)
    WHERE NOT EXISTS (
        SELECT 1
        FROM pg_policies policy
        WHERE policy.schemaname = 'public'
          AND policy.tablename = expected.table_name
          AND policy.policyname = expected.policy_name
          AND policy.cmd = expected.command
          AND policy.roles = ARRAY['authenticated']::name[]
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing or changed RLS policy/policies: %', missing;
    END IF;

    SELECT string_agg(format('%s.%s', expected.table_name, expected.trigger_name), ', ' ORDER BY expected.table_name, expected.trigger_name)
    INTO missing
    FROM (VALUES
        ('account_deletion_requests', 'prevent_account_deletion_orphan_trigger'),
        ('staff_roles', 'prevent_staff_admin_orphan_delete_trigger'),
        ('staff_roles', 'prevent_staff_admin_orphan_update_trigger')
    ) AS expected(table_name, trigger_name)
    WHERE NOT EXISTS (
        SELECT 1
        FROM pg_trigger trig
        JOIN pg_class relation ON relation.oid = trig.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = expected.table_name
          AND trig.tgname = expected.trigger_name
          AND NOT trig.tgisinternal
          AND trig.tgenabled IN ('O', 'A')
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing or disabled trigger(s): %', missing;
    END IF;

    SELECT string_agg(format('%s.%s expected ON DELETE %s', expected.table_name, expected.column_name, expected.delete_rule), ', ' ORDER BY expected.table_name, expected.column_name)
    INTO missing
    FROM (VALUES
        ('account_deletion_requests', 'canceled_by', 'SET NULL'),
        ('account_deletion_requests', 'requested_by', 'SET NULL'),
        ('account_deletion_requests', 'user_id', 'SET NULL'),
        ('attendance', 'checked_in_by', 'SET NULL'),
        ('class_sessions', 'instructor_id', 'SET NULL'),
        ('class_templates', 'instructor_id', 'SET NULL'),
        ('lead_activities', 'created_by', 'SET NULL'),
        ('leads', 'assigned_staff_id', 'SET NULL'),
        ('promotions', 'promoted_by', 'SET NULL'),
        ('staff_roles', 'invited_by', 'SET NULL'),
        ('staff_roles', 'user_id', 'CASCADE'),
        ('support_ticket_events', 'actor_id', 'SET NULL'),
        ('support_tickets', 'created_by', 'SET NULL')
    ) AS expected(table_name, column_name, delete_rule)
    WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.referential_constraints constraints
        JOIN information_schema.key_column_usage columns
          ON columns.constraint_schema = constraints.constraint_schema
         AND columns.constraint_name = constraints.constraint_name
        WHERE columns.table_schema = 'public'
          AND columns.table_name = expected.table_name
          AND columns.column_name = expected.column_name
          AND constraints.delete_rule = expected.delete_rule
    );

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Foreign key delete rule mismatch: %', missing;
    END IF;

    SELECT string_agg(format('%s for %s', expected.privilege, expected.grantee), ', ' ORDER BY expected.table_name, expected.grantee, expected.privilege)
    INTO missing
    FROM (
        SELECT table_name, grantee, privilege
        FROM (VALUES
            ('account_deletion_requests'),
            ('support_ticket_events'),
            ('support_tickets')
        ) AS tables(table_name)
        CROSS JOIN (VALUES
            ('authenticated', 'SELECT'),
            ('service_role', 'DELETE'),
            ('service_role', 'INSERT'),
            ('service_role', 'SELECT'),
            ('service_role', 'UPDATE')
        ) AS grants(grantee, privilege)
    ) AS expected(table_name, grantee, privilege)
    WHERE NOT has_table_privilege(expected.grantee, format('public.%I', expected.table_name), expected.privilege);

    IF missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing table privilege(s): %', missing;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'promotions'
          AND column_name = 'promoted_by'
          AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'promotions.promoted_by must be nullable so deleted staff accounts preserve promotion history.';
    END IF;

    IF to_regprocedure('public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb).';
    END IF;

    IF NOT has_function_privilege('service_role', 'public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must be able to execute public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb).';
    END IF;

    IF has_function_privilege('anon', 'public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb) must not be directly executable by anon/authenticated.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc proc
        JOIN pg_namespace namespace ON namespace.oid = proc.pronamespace
        WHERE namespace.nspname = 'public'
          AND proc.proname = 'sync_belt_ladder_ranks'
          AND pg_get_functiondef(proc.oid) ILIKE '%tmp_sync_belt_ranks%'
    ) THEN
        RAISE EXCEPTION 'sync_belt_ladder_ranks still references tmp_sync_belt_ranks; linked db lint will fail.';
    END IF;

    IF to_regprocedure('public.support_triage_list_tickets(text[], text[], text[], integer)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.support_triage_list_tickets(text[], text[], text[], integer).';
    END IF;

    IF to_regprocedure('public.support_triage_update_ticket(uuid, text, text, jsonb)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.support_triage_update_ticket(uuid, text, text, jsonb).';
    END IF;

    IF NOT has_function_privilege('service_role', 'public.support_triage_list_tickets(text[], text[], text[], integer)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.support_triage_update_ticket(uuid, text, text, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must be able to execute support triage RPCs.';
    END IF;

    IF has_function_privilege('anon', 'public.support_triage_list_tickets(text[], text[], text[], integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.support_triage_list_tickets(text[], text[], text[], integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.support_triage_update_ticket(uuid, text, text, jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.support_triage_update_ticket(uuid, text, text, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Support triage RPCs must not be directly executable by anon/authenticated.';
    END IF;

    RAISE NOTICE 'Koaryu account/support database controls verification passed.';
END $$;
