-- ==========================================
-- Koaryu v1 — Migration 027
-- Optimize RLS auth.uid() calls
-- ==========================================

-- Supabase recommends wrapping auth helper calls in SELECT inside RLS policies
-- so Postgres can evaluate them once per statement instead of once per row.
DO $$
DECLARE
    policy_record RECORD;
    alter_sql TEXT;
    using_expr TEXT;
    check_expr TEXT;
BEGIN
    FOR policy_record IN
        SELECT
            n.nspname AS schema_name,
            c.relname AS table_name,
            p.polname AS policy_name,
            pg_get_expr(p.polqual, p.polrelid) AS using_expression,
            pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND (
              pg_get_expr(p.polqual, p.polrelid) LIKE '%auth.uid()%'
              OR pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%auth.uid()%'
          )
    LOOP
        alter_sql := format(
            'ALTER POLICY %I ON %I.%I',
            policy_record.policy_name,
            policy_record.schema_name,
            policy_record.table_name
        );

        IF policy_record.using_expression IS NOT NULL THEN
            using_expr := replace(
                policy_record.using_expression,
                'auth.uid()',
                '(SELECT auth.uid())'
            );
            alter_sql := alter_sql || format(' USING (%s)', using_expr);
        END IF;

        IF policy_record.check_expression IS NOT NULL THEN
            check_expr := replace(
                policy_record.check_expression,
                'auth.uid()',
                '(SELECT auth.uid())'
            );
            alter_sql := alter_sql || format(' WITH CHECK (%s)', check_expr);
        END IF;

        EXECUTE alter_sql;
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
