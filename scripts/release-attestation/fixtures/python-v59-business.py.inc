SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000005901','authenticated','authenticated',
       'v59-restore@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000005902','V59 retained timezone','v59-retained-timezone',
       '00000000-0000-4000-8000-000000005901','America/Los_Angeles');
COMMIT;
SELECT 'seeded';
"""


def require_v59_snapshot(before, after):
    expected = json.loads(json.dumps(before))
    rows = expected['private.koaryu_release_v31_expectations']
    require(len(rows) == 1 and rows[0]['expectation_key'] == 'operational_contract_v31'
            and rows[0]['expected_sha256'] == 'af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb',
            'V59 requires the exact V58 singleton')
    rows[0]['expected_sha256'] = V59_EXPECTATION
    return after == expected

V59_EXPECTATION = '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3'

V59_BACKUP_SEED_SQL = r"""
BEGIN;
INSERT INTO public.programs(id,studio_id,name) VALUES('00000000-0000-4000-8000-000000005903','00000000-0000-4000-8000-000000005902','Restore program');
INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES('00000000-0000-4000-8000-000000005904','00000000-0000-4000-8000-000000005902','Restore','Lead','00000000-0000-4000-8000-000000005903');
INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES('00000000-0000-4000-8000-000000005905','00000000-0000-4000-8000-000000005902','Restore ladder','00000000-0000-4000-8000-000000005903');
INSERT INTO public.lead_trial_appointments(studio_id,lead_id,program_id,starts_at,ends_at,timezone)
VALUES('00000000-0000-4000-8000-000000005902','00000000-0000-4000-8000-000000005904','00000000-0000-4000-8000-000000005903','2060-01-01 12:00+00','2060-01-01 13:00+00','America/Los_Angeles');
INSERT INTO public.belt_test_events(studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone)
VALUES('00000000-0000-4000-8000-000000005902','Restore belt event','00000000-0000-4000-8000-000000005905','00000000-0000-4000-8000-000000005903','2060-01-01 12:00+00','2060-01-01 13:00+00','Europe/Paris');
COMMIT;
"""
V59_REFERENCE_SNAPSHOT_SQL = """
SELECT jsonb_build_object('names',(SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM private.timezone_names),
 'owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'policies',(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid),
 'acl',(SELECT jsonb_agg(jsonb_build_array(a.grantee::regrole::text,a.grantor::regrole::text,a.privilege_type,a.is_grantable)
     ORDER BY a.grantee::regrole::text COLLATE "C",a.grantor::regrole::text COLLATE "C",a.privilege_type,a.is_grantable)
     FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a))
FROM pg_class c WHERE c.oid='private.timezone_names'::regclass;
"""
V59_SERVICE_LOOKUPS_SQL = """
SET ROLE service_role;
SELECT jsonb_build_array(private.timezone_name_known('America/Los_Angeles'),private.timezone_name_known('Invalid/Surplus'),
 private.timezone_name_known(NULL),private.timezone_name_or_utc('Europe/Paris'),private.timezone_name_or_utc('Invalid/Surplus'),private.timezone_name_or_utc(NULL));
"""


def verify_v59_backup(local, source, snapshot, pinned, pg_dump, pg_restore, createdb, temporary, root, pairs):
    """Own a populated V59 copy and its real logical restore, never the parent."""
    populated = f"koaryu_v59_backup_source_{os.getpid()}"
    restored = f"koaryu_v59_backup_restore_{os.getpid()}"
    dump = temporary / f"populated-v59-{os.getpid()}.dump"
    require(not dump.exists(), 'V59 backup path already exists')
    owned = []
    parent = snapshot(source)
    try:
        for database, template in [(populated, source), (restored, 'template0')]:
            local.run([createdb, *local.connection, '--owner=postgres', f'--template={template}', database])
            owned.append(database)
            local.sql(database, f'ALTER DATABASE {database} SET search_path TO "$user",public,extensions;')
        local.sql(populated, V59_BACKUP_SEED_SQL)
        rows = snapshot(populated)
        require(len(rows['public.lead_trial_appointments']) == 1 and len(rows['public.belt_test_events']) == 1,
                'V59 backup must contain both timezone CHECK-dependent business tables')
        reference = json.loads(local.sql(populated, V59_REFERENCE_SNAPSHOT_SQL))
        require(reference['owner'] == 'postgres' and reference['rls'] is True and reference['force_rls'] is False
                and reference['policies'] == 0 and reference['names'], 'V59 reference security or rows differ')
        expected_lookups = [True, False, False, 'Europe/Paris', 'UTC', 'UTC']
        require(json.loads(local.sql(populated, V59_SERVICE_LOOKUPS_SQL)) == expected_lookups, 'Source service-role lookups differ')
        constraints, acls = json.loads(local.sql(populated, CONSTRAINT_SQL)), json.loads(local.sql(populated, ACL_SQL))
        local.run([pg_dump, *local.connection, f'--dbname={populated}', '--format=custom', f'--file={dump}'])
        # Restore without bypassing CHECKs, changing TOC order or repairing data.
        local.run([pg_restore, *local.connection, f'--dbname={restored}', '--exit-on-error', str(dump)])
        statements, expected = normalization_plan(constraints, json.loads(local.sql(restored, CONSTRAINT_SQL)),
            acls, json.loads(local.sql(restored, ACL_SQL)), pairs)
        local.sql(restored, 'BEGIN;\n' + '\n'.join(statements) + '\nCOMMIT;')
        require(json.loads(local.sql(restored, CONSTRAINT_SQL)) == expected, 'V59 backup CHECK normalization differs')
        require(json.loads(local.sql(restored, ACL_SQL)) == acls, 'V59 backup ACL normalization differs')
        require(snapshot(restored) == rows, 'Populated V59 backup changed business rows')
        require(json.loads(local.sql(restored, V59_REFERENCE_SNAPSHOT_SQL)) == reference,
                'V59 backup changed timezone names, ownership, ACLs or RLS')
        require(json.loads(local.sql(restored, V59_SERVICE_LOOKUPS_SQL)) == expected_lookups,
                'Restored service-role lookups differ')
        require(local.sql(restored, pinned['V59_OPERATIONAL_READINESS_SQL']) == pinned['EXPECTED_V59_OPERATIONAL_READINESS'],
                'Restored V59 readiness differs')
        require(local.sql(restored, pinned['V58_OPERATIONAL_READINESS_SQL']) == pinned['EXPECTED_V58_OPERATIONAL_READINESS'],
                'Restored V39 compatibility does not return exact V58 success rows')
        checker = [str(root / 'backend/venv/bin/python'), str(root / 'scripts/check-timezone-names-parity.py'),
                   local.psql, str(local.socket), '5432', restored]
        local.run(checker)
        # Metadata readiness deliberately does not reconcile names. Release inspection must.
        for mutation, repair, missing, surplus in [
            ("DELETE FROM private.timezone_names WHERE name='UTC';", "INSERT INTO private.timezone_names VALUES('UTC');", '["UTC"]', '[]'),
            ("INSERT INTO private.timezone_names VALUES('Invalid/Surplus');", "DELETE FROM private.timezone_names WHERE name='Invalid/Surplus';", '[]', '["Invalid/Surplus"]'),
        ]:
            local.sql(restored, mutation)
            try:
                local.run(checker)
            except RuntimeError as exc:
                require(f'TIMEZONE_NAMES_DRIFT missing={missing} surplus={surplus}' in str(exc),
                        'Parity refused for an unrelated reason: ' + str(exc))
            else:
                raise RuntimeError('Timezone snapshot drift was accepted')
            finally:
                local.sql(restored, repair)
        local.run(checker)
        require(json.loads(local.sql(restored, V59_REFERENCE_SNAPSHOT_SQL)) == reference, 'Parity probes changed reference rows or security')
        require(snapshot(source) == parent, 'V59 backup proof changed its parent')
        print('[V59 backup] PASS populated V59 round trip, timezone rows/owner/ACL/RLS, service-role lookups and missing/surplus parity refusal', flush=True)
        return {'timezone_names': len(reference['names']), 'trial_rows': 1, 'belt_event_rows': 1, 'service_role_lookups': 6, 'parity_cases': 3}
    finally:
        errors = []
        for database in reversed(owned):
            try:
                local.sql('postgres', f'DROP DATABASE {database} WITH (FORCE);')
            except Exception as error:
                errors.append(str(error))
        dump.unlink(missing_ok=True)
        if errors:
            raise RuntimeError('V59 backup cleanup failed: ' + '; '.join(errors))
