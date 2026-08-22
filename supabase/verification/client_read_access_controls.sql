-- Contract: the API roles hold no direct privileges on anything in `public`.
--
-- The existing write contracts (core_operational_client_write_controls.sql and
-- remaining_operational_client_write_controls.sql) assert only that anon and
-- authenticated lack INSERT, UPDATE, and DELETE, and they assert it for a named
-- handful of tables. That left SELECT unchecked across the whole schema, which
-- is how 35 tables ended up readable by anyone holding the public anon key.
--
-- This file is schema-wide and privilege-complete on purpose: a future table is
-- covered the day it is created, without anyone remembering to add it here.
--
-- NOTE: docs/operator-tooling.md records that the local ephemeral harness
-- cannot settle privilege assertions in either direction, because its ACL
-- profile matches no Supabase project exactly. Treat a local pass as a syntax
-- and logic check. The binding run is the Supabase CLI stack in CI, and the
-- read-only production inspection recorded in the rollout notes.

BEGIN;

DO $$
DECLARE
    v_role TEXT;
    v_offenders TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        -- MATERIALIZED keeps the privilege probe from being pushed down onto
        -- rows the relkind filter excludes; without it the planner can call it
        -- on a toast relation and error out.
        WITH candidates AS MATERIALIZED (
            SELECT c.oid, c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
             WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        )
        SELECT string_agg(format('%I.%I', 'public', relname), ', ' ORDER BY relname)
          INTO v_offenders
          FROM candidates
         WHERE has_table_privilege(
                 v_role,
                 oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               );

        IF v_offenders IS NOT NULL THEN
            RAISE EXCEPTION
                '% still holds direct privileges on public relations: %',
                v_role, v_offenders;
        END IF;
    END LOOP;
END;
$$;

DO $$
DECLARE
    v_role TEXT;
    v_offenders TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        WITH candidates AS MATERIALIZED (
            SELECT c.oid, c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
             WHERE c.relkind = 'S'
        )
        SELECT string_agg(relname, ', ' ORDER BY relname)
          INTO v_offenders
          FROM candidates
         WHERE has_sequence_privilege(v_role, oid, 'USAGE,SELECT,UPDATE');

        IF v_offenders IS NOT NULL THEN
            RAISE EXCEPTION
                '% still holds privileges on public sequences: %',
                v_role, v_offenders;
        END IF;
    END LOOP;
END;
$$;

-- The default ACL is what silently re-grants the API roles on every new table.
-- Assert it by creating a table and reading back what the roles received,
-- which tests the behaviour rather than the catalog representation of it.
DO $$
DECLARE
    v_role TEXT;
BEGIN
    CREATE TABLE public.koaryu_default_privilege_probe (id INTEGER PRIMARY KEY);

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        IF has_table_privilege(
             v_role,
             'public.koaryu_default_privilege_probe'::regclass,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ) THEN
            RAISE EXCEPTION
                'default privileges still grant % on newly created public tables',
                v_role;
        END IF;
    END LOOP;

    DROP TABLE public.koaryu_default_privilege_probe;
END;
$$;

-- Regression guard for the precedent this migration generalised: students was
-- hardened first, and must stay hardened.
DO $$
BEGIN
    IF has_table_privilege('anon', 'public.students'::regclass, 'SELECT') THEN
        RAISE EXCEPTION 'anon regained SELECT on public.students';
    END IF;
END;
$$;

-- service_role must keep working; the backend has no other way in.
DO $$
BEGIN
    IF NOT has_table_privilege('service_role', 'public.students'::regclass, 'SELECT') THEN
        RAISE EXCEPTION 'service_role lost SELECT on public.students';
    END IF;
    IF NOT has_table_privilege('service_role', 'public.studios'::regclass, 'SELECT') THEN
        RAISE EXCEPTION 'service_role lost SELECT on public.studios';
    END IF;
END;
$$;

ROLLBACK;
