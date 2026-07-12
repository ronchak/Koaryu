-- Pin the one remaining mutable trigger search path and remove PostgreSQL's
-- default PUBLIC execute privilege from every application-owned function.
-- Koaryu's browser never calls public RPCs directly; service-role RPC grants
-- and the three private authenticated RLS helpers remain explicit.

DO $$
BEGIN
    IF to_regprocedure('public.set_student_is_minor()') IS NOT NULL THEN
        ALTER FUNCTION public.set_student_is_minor()
            SET search_path = pg_catalog;
    END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;

DO $$
DECLARE
    v_function RECORD;
BEGIN
    FOR v_function IN
        SELECT
            n.nspname AS schema_name,
            p.proname AS function_name,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.prokind = 'f'
    LOOP
        EXECUTE format(
            'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated',
            v_function.schema_name,
            v_function.function_name,
            v_function.identity_arguments
        );
    END LOOP;

    FOR v_function IN
        SELECT
            n.nspname AS schema_name,
            p.proname AS function_name,
            p.proargtypes,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'private'
          AND p.prokind = 'f'
    LOOP
        EXECUTE format(
            'REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon',
            v_function.schema_name,
            v_function.function_name,
            v_function.identity_arguments
        );

        IF NOT (
            v_function.function_name IN (
                'is_staff_in_studio',
                'is_admin_or_front_desk_in_studio',
                'is_admin_in_studio'
            )
            AND pg_catalog.oidvectortypes(v_function.proargtypes) = 'uuid'
        ) THEN
            EXECUTE format(
                'REVOKE ALL ON FUNCTION %I.%I(%s) FROM authenticated',
                v_function.schema_name,
                v_function.function_name,
                v_function.identity_arguments
            );
        END IF;
    END LOOP;
END
$$;

-- Function EXECUTE is granted to PUBLIC by PostgreSQL's global defaults.
-- A schema-local default cannot subtract that global grant, so revoke it at
-- the migration owner's global default and keep every intended grant explicit.
ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Supabase also seeds additive per-schema defaults for its API roles. A
-- global PUBLIC revoke cannot subtract those grants, so remove each one from
-- both application schemas and require future functions to grant explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA private
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role;
