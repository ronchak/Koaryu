BEGIN;

DO $$
DECLARE
    v_table TEXT;
    v_role TEXT;
    v_relation TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'students',
        'programs',
        'student_program_memberships'
    ]
    LOOP
        v_relation := format('public.%I', v_table);

        IF NOT EXISTS (
            SELECT 1
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname = v_table
              AND relation.relrowsecurity
        ) THEN
            RAISE EXCEPTION 'Expected RLS to be enabled on %.%', 'public', v_table;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_policies policy
            WHERE policy.schemaname = 'public'
              AND policy.tablename = v_table
              AND policy.cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
              AND policy.roles && ARRAY['public'::name, 'anon'::name, 'authenticated'::name]
        ) THEN
            RAISE EXCEPTION 'Browser-facing write policy still exists on %.%', 'public', v_table;
        END IF;

        FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
        LOOP
            IF has_table_privilege(v_role, v_relation, 'INSERT')
               OR has_table_privilege(v_role, v_relation, 'UPDATE')
               OR has_table_privilege(v_role, v_relation, 'DELETE') THEN
                RAISE EXCEPTION '% still has direct write privileges on %.%', v_role, 'public', v_table;
            END IF;
        END LOOP;

        IF NOT has_table_privilege('service_role', v_relation, 'SELECT')
           OR NOT has_table_privilege('service_role', v_relation, 'INSERT')
           OR NOT has_table_privilege('service_role', v_relation, 'UPDATE')
           OR NOT has_table_privilege('service_role', v_relation, 'DELETE') THEN
            RAISE EXCEPTION 'service_role must retain CRUD privileges on %.%', 'public', v_table;
        END IF;
    END LOOP;

    RAISE NOTICE 'Koaryu core operational direct-client write controls verification passed.';
END $$;

ROLLBACK;
