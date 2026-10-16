            upgraded = snapshot(database)
            result = local.sql(database, (root / 'supabase/verification/timezone_names_reference_contract.sql').read_text())
            require(snapshot(database) == upgraded, 'Timezone continuation changed retained rows')
            outcomes[('restored_' if is_restored else 'canonical_') + 'timezone_continuation'] = result
            check(database, 'V58_OPERATIONAL_READINESS_SQL', 'EXPECTED_V58_OPERATIONAL_READINESS')
            refused = local.sql(database, """
BEGIN;
GRANT EXECUTE ON FUNCTION private.timezone_name_known(TEXT) TO anon;
DO $compatibility$
DECLARE old RECORD; current RECORD;
BEGIN
    SELECT * INTO old FROM public.koaryu_release_schema_preflight_v39();
    SELECT * INTO current FROM public.koaryu_release_schema_preflight_v40();
    IF old.ready IS DISTINCT FROM FALSE OR current.ready IS DISTINCT FROM FALSE
       OR old.security_failures IS DISTINCT FROM ARRAY['timezone_functions_v59']::TEXT[]
       OR old.security_failures IS DISTINCT FROM current.security_failures
       OR old.migration_count IS DISTINCT FROM 154 OR old.migration_head IS DISTINCT FROM '20261014083106'
       OR old.pending_versions IS DISTINCT FROM current.pending_versions
       OR old.manifest_version IS DISTINCT FROM 'release-db-attestation-v58' THEN
        RAISE EXCEPTION 'V39 compatibility did not refuse V59 drift: %',row_to_json(old);
    END IF;
END;
$compatibility$;
ROLLBACK;
SELECT 'compatibility drift refused';
""")
            require(refused == 'compatibility drift refused', 'V39 drift-refusal proof failed')
            check(database, 'V58_OPERATIONAL_READINESS_SQL', 'EXPECTED_V58_OPERATIONAL_READINESS')
            print('[V59 compatibility] PASS exact V58 success rows and V39 drift refusal on ' + ('restored' if is_restored else 'canonical'), flush=True)
            if not is_restored:
                outcomes['populated_v59_backup'] = verify_v59_backup(local, database, snapshot, pinned, pg_dump, pg_restore, createdb, temporary, root, pairs)
