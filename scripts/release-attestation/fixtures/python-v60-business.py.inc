SEED_SQL = r"""
BEGIN;
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at)
VALUES('00000000-0000-4000-8000-000000006101','authenticated','authenticated','mcp-retained@example.invalid','{}','{}',now(),now(),now());
INSERT INTO public.studios(id,name,slug,owner_id,timezone)
VALUES('00000000-0000-4000-8000-000000006102','MCP retained studio','mcp-retained-studio','00000000-0000-4000-8000-000000006101','America/Los_Angeles');
INSERT INTO public.staff_roles(user_id,studio_id,role)
VALUES('00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-000000006102','admin') ON CONFLICT DO NOTHING;
COMMIT;
SELECT 'seeded';
"""


def require_v60_snapshot(before, after):
    expected = json.loads(json.dumps(before))
    rows = expected['private.koaryu_release_v31_expectations']
    require(len(rows) == 1 and rows[0]['expectation_key'] == 'operational_contract_v31'
            and rows[0]['expected_sha256'] == '1513ff10defced0c619f85c7927259165f6c9eb7ef1400be076f567fd39c85b3',
            'V60 requires the exact V59 expectation singleton')
    rows[0]['expected_sha256'] = '5ffe9cc634eadd091b227bdb2e291bc3be209a4cd6de9f4448e29c8ba701f50c'
    return after == expected


MCP_GRANT_SEED = r"""
SELECT public.authorize_mcp_connection(
 '00000000-0000-4000-8000-000000006101','00000000-0000-4000-8000-000000006102',
 '00000000-0000-4000-8000-000000006105','Restore assistant','00000000-0000-4000-8000-000000006106',
 ARRAY['schedule','students'],'https://mcp.example.invalid/mcp',now()+interval '1 day');
SET ROLE supabase_auth_admin;
SELECT public.mcp_access_token_hook('{"user_id":"00000000-0000-4000-8000-000000006101","authentication_method":"oauth_provider/authorization_code","claims":{"sub":"00000000-0000-4000-8000-000000006101","aud":"authenticated","role":"authenticated","client_id":"00000000-0000-4000-8000-000000006105","session_id":"00000000-0000-4000-8000-000000006107"}}');
RESET ROLE;
"""


def verify_populated_mcp_restore(local, database, pg_dump, pg_restore, createdb, temporary):
    source = f'koaryu_mcp_backup_source_{os.getpid()}'
    restored = f'koaryu_mcp_backup_restored_{os.getpid()}'
    dump = temporary / f'mcp-populated-{os.getpid()}.dump'
    owned = []
    try:
        local.run([createdb, *local.connection, '--template='+database, source]); owned.append(source)
        local.sql(source, MCP_GRANT_SEED)
        before = local.sql(source, 'SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.mcp_connections c;')
        local.run([pg_dump, *local.connection, '--dbname='+source, '--format=custom', '--file='+str(dump)])
        local.run([createdb, *local.connection, restored]); owned.append(restored)
        local.run([pg_restore, *local.connection, '--dbname='+restored, '--exit-on-error', str(dump)])
        require(local.sql(restored, 'SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM public.mcp_connections c;') == before,
                'Logical restore changed a connection, grant, expiry or session binding')
        refreshed = local.sql(restored, MCP_GRANT_SEED[MCP_GRANT_SEED.index('SET ROLE'):].replace('oauth_provider/authorization_code', 'token_refresh'))
        require('https://mcp.example.invalid/mcp' in refreshed and 'koaryu_connection_id' in refreshed,
                'Restored native Auth hook cannot refresh the retained connection')
        print('[V60 populated restore] PASS connection and session preservation', flush=True)
    finally:
        for name in reversed(owned):
            local.sql('postgres', f'DROP DATABASE {name} WITH (FORCE);')
        dump.unlink(missing_ok=True)
