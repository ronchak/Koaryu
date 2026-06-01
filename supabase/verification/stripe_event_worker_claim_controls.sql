BEGIN;

DO $$
DECLARE
    v_missing TEXT;
    v_role TEXT;
    v_relation TEXT := 'public.stripe_events';
BEGIN
    SELECT string_agg(expected.version, ', ' ORDER BY expected.version)
    INTO v_missing
    FROM (VALUES
        ('20260530160544')
    ) AS expected(version)
    WHERE NOT EXISTS (
        SELECT 1
        FROM supabase_migrations.schema_migrations migration
        WHERE migration.version = expected.version
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'Missing migration version(s): %', v_missing;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'stripe_events'
          AND relation.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Expected RLS to be enabled on public.stripe_events.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'stripe_events'
          AND column_name = 'processing_token'
    ) THEN
        RAISE EXCEPTION 'Missing public.stripe_events.processing_token worker claim column.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'stripe_events'
          AND column_name = 'processing_started_at'
    ) THEN
        RAISE EXCEPTION 'Missing public.stripe_events.processing_started_at worker claim column.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index index_relation
        JOIN pg_class index_class ON index_class.oid = index_relation.indexrelid
        JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
        WHERE namespace.nspname = 'public'
          AND index_class.relname = 'idx_stripe_events_processing_claim'
    ) THEN
        RAISE EXCEPTION 'Missing Stripe event processing-claim index.';
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        IF has_table_privilege(v_role, v_relation, 'SELECT')
           OR has_table_privilege(v_role, v_relation, 'INSERT')
           OR has_table_privilege(v_role, v_relation, 'UPDATE')
           OR has_table_privilege(v_role, v_relation, 'DELETE') THEN
            RAISE EXCEPTION '% still has direct privileges on public.stripe_events.', v_role;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM information_schema.table_privileges privilege
        WHERE privilege.table_schema = 'public'
          AND privilege.table_name = 'stripe_events'
          AND privilege.grantee = 'PUBLIC'
          AND privilege.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ) THEN
        RAISE EXCEPTION 'PUBLIC still has direct privileges on public.stripe_events.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_policies policy
        WHERE policy.schemaname = 'public'
          AND policy.tablename = 'stripe_events'
          AND policy.policyname = 'stripe_events_no_client_access'
          AND policy.permissive = 'RESTRICTIVE'
          AND policy.roles && ARRAY['anon'::name, 'authenticated'::name]
          AND policy.qual IN ('false', '(false)')
          AND policy.with_check IN ('false', '(false)')
    ) THEN
        RAISE EXCEPTION 'Expected restrictive no-client-access policy on public.stripe_events.';
    END IF;

    IF NOT has_table_privilege('service_role', v_relation, 'SELECT')
       OR NOT has_table_privilege('service_role', v_relation, 'INSERT')
       OR NOT has_table_privilege('service_role', v_relation, 'UPDATE')
       OR NOT has_table_privilege('service_role', v_relation, 'DELETE') THEN
        RAISE EXCEPTION 'service_role must retain CRUD privileges on public.stripe_events.';
    END IF;

    RAISE NOTICE 'Koaryu Stripe event worker claim controls verification passed.';
END $$;

ROLLBACK;
