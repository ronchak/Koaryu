DO $$
BEGIN
    IF to_regclass('public.billing_invoice_retry_operations') IS NULL THEN
        RAISE EXCEPTION 'billing_invoice_retry_operations table is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'billing_invoice_retry_operations'
          AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'billing_invoice_retry_operations must have RLS enabled';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'billing_invoice_retry_operation_aliases'
          AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'billing invoice retry aliases must have RLS enabled';
    END IF;

    IF has_table_privilege('anon', 'public.billing_invoice_retry_operations', 'SELECT')
       OR has_table_privilege('anon', 'public.billing_invoice_retry_operations', 'INSERT')
       OR has_table_privilege('anon', 'public.billing_invoice_retry_operations', 'UPDATE')
       OR has_table_privilege('anon', 'public.billing_invoice_retry_operations', 'DELETE')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operations', 'SELECT')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operations', 'INSERT')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operations', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operations', 'DELETE') THEN
        RAISE EXCEPTION 'billing_invoice_retry_operations must deny all client DML';
    END IF;

    IF NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operations', 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operations', 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operations', 'UPDATE')
       OR NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operations', 'DELETE') THEN
        RAISE EXCEPTION 'service_role requires full billing_invoice_retry_operations access';
    END IF;

    IF has_table_privilege('anon', 'public.billing_invoice_retry_operation_aliases', 'SELECT')
       OR has_table_privilege('anon', 'public.billing_invoice_retry_operation_aliases', 'INSERT')
       OR has_table_privilege('anon', 'public.billing_invoice_retry_operation_aliases', 'UPDATE')
       OR has_table_privilege('anon', 'public.billing_invoice_retry_operation_aliases', 'DELETE')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operation_aliases', 'SELECT')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operation_aliases', 'INSERT')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operation_aliases', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.billing_invoice_retry_operation_aliases', 'DELETE') THEN
        RAISE EXCEPTION 'billing invoice retry aliases must deny all client DML';
    END IF;

    IF NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operation_aliases', 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operation_aliases', 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operation_aliases', 'UPDATE')
       OR NOT has_table_privilege('service_role', 'public.billing_invoice_retry_operation_aliases', 'DELETE') THEN
        RAISE EXCEPTION 'service_role requires full billing invoice retry alias access';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'preserve_billing_invoice_retry_operation_created_at'
          AND tgrelid = 'public.billing_invoice_retry_operations'::regclass
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'billing invoice retry created_at must be immutable';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'billing_invoice_retry_operations'
          AND indexname = 'idx_billing_invoice_retry_operations_one_active_invoice'
          AND indexdef LIKE '%UNIQUE%'
          AND indexdef LIKE '%reconciliation_required%'
    ) THEN
        RAISE EXCEPTION 'billing invoice retries require one active operation per invoice';
    END IF;
END
$$;
