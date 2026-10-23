-- Synthetic local-only proof. Connection management may write this control
-- table; connector tools have no business-write authority.
BEGIN;
DO $contract$
DECLARE
    actor uuid := '00000000-0000-4000-8000-000000006001';
    studio uuid := '00000000-0000-4000-8000-000000006002';
    other_actor uuid := '00000000-0000-4000-8000-000000006003';
    other_studio uuid := '00000000-0000-4000-8000-000000006004';
    client_id uuid := '00000000-0000-4000-8000-000000006005';
    consent_id uuid := '00000000-0000-4000-8000-000000006006';
    session_id uuid := '00000000-0000-4000-8000-000000006007';
    connection jsonb; replay jsonb; event jsonb; minted jsonb;
    denied boolean;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated','mcp-a@example.invalid','{}','{}',now(),now()),
          (other_actor,'authenticated','authenticated','mcp-b@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id)
    VALUES(studio,'MCP A','mcp-contract-a',actor),(other_studio,'MCP B','mcp-contract-b',other_actor);
    INSERT INTO public.staff_roles(user_id,studio_id,role) VALUES(actor,studio,'admin'),(other_actor,other_studio,'admin') ON CONFLICT DO NOTHING;

    IF has_table_privilege('anon','public.mcp_connections','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('authenticated','public.mcp_connections','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_function_privilege('authenticated','public.authorize_mcp_connection(uuid,uuid,uuid,text,uuid,text[],text,timestamptz)','EXECUTE')
       OR has_function_privilege('service_role','public.mcp_access_token_hook(jsonb)','EXECUTE') THEN
        RAISE EXCEPTION 'Connection controls are exposed to an unauthorized role';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy
        WHERE polrelid='public.mcp_connections'::regclass
          AND polname='reject_ambiguous_staff_membership_access'
          AND NOT polpermissive AND polcmd='*'
          AND (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated')=ANY(polroles)
    ) THEN RAISE EXCEPTION 'MCP controls lack the standard restrictive tenant guard'; END IF;
    IF has_any_column_privilege('anon','public.mcp_connections','SELECT,INSERT,UPDATE,REFERENCES')
       OR has_any_column_privilege('authenticated','public.mcp_connections','SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'Connection controls expose a client column privilege';
    END IF;

    SET LOCAL ROLE service_role;
    connection := public.authorize_mcp_connection(actor,studio,client_id,'Test assistant',consent_id,ARRAY['schedule','students'],'https://mcp.example.invalid/mcp',now()+interval '1 day');
    replay := public.authorize_mcp_connection(actor,studio,client_id,'Test assistant',consent_id,ARRAY['schedule','students'],'https://mcp.example.invalid/mcp',now()+interval '2 days');
    IF replay->>'id' IS DISTINCT FROM connection->>'id' OR replay->>'expires_at' IS DISTINCT FROM connection->>'expires_at' THEN
        RAISE EXCEPTION 'Consent replay changed the grant';
    END IF;
    denied := false;
    BEGIN
        PERFORM public.authorize_mcp_connection(actor,other_studio,client_id,'Test',gen_random_uuid(),ARRAY['students'],'https://mcp.example.invalid/mcp',now()+interval '1 day');
    EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'Cross-studio consent was allowed'; END IF;
    RESET ROLE;

    event := jsonb_build_object('user_id',actor,'authentication_method','oauth_provider/authorization_code',
        'claims',jsonb_build_object('sub',actor,'aud','authenticated','role','authenticated','scope','offline_access','email','owner@example.invalid','phone','1234','user_metadata',jsonb_build_object('private','value'),'app_metadata',jsonb_build_object('private','value'),'client_id',client_id,'session_id',session_id));
    SET LOCAL ROLE supabase_auth_admin;
    minted := public.mcp_access_token_hook(event);
    IF minted#>>'{claims,aud}' IS DISTINCT FROM 'https://mcp.example.invalid/mcp'
       OR minted#>>'{claims,koaryu_connection_id}' IS DISTINCT FROM connection->>'id'
       OR minted#>>'{claims,sub}' IS DISTINCT FROM 'urn:koaryu:mcp:' || (connection->>'id')
       OR minted#>>'{claims,email}' IS DISTINCT FROM '' OR minted#>>'{claims,phone}' IS DISTINCT FROM ''
       OR (minted->'claims') ? 'user_metadata' OR (minted->'claims') ? 'app_metadata'
       OR minted#>>'{claims,session_id}' IS DISTINCT FROM session_id::text THEN
        RAISE EXCEPTION 'Token hook failed to bind resource, grant and session';
    END IF;
    denied := false;
    BEGIN
        PERFORM public.mcp_access_token_hook(jsonb_set(event,'{claims,scope}','"openid offline_access"'));
    EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'OpenID scope could mint an owner identity token'; END IF;
    denied := false;
    BEGIN
        PERFORM (minted#>>'{claims,sub}')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'Connector subject can resolve as an Auth user UUID'; END IF;
    event := jsonb_set(event,'{authentication_method}','"token_refresh"');
    minted := public.mcp_access_token_hook(event);
    IF minted#>>'{claims,koaryu_connection_id}' IS DISTINCT FROM connection->>'id' THEN RAISE EXCEPTION 'Valid refresh lost its grant'; END IF;
    denied := false;
    BEGIN
        PERFORM public.mcp_access_token_hook(jsonb_set(event,'{claims,session_id}',to_jsonb(gen_random_uuid())));
    EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'Foreign session refresh was accepted'; END IF;
    -- Ordinary login is unchanged, including other user metadata.
    minted := event #- '{claims,client_id}';
    IF public.mcp_access_token_hook(minted) IS DISTINCT FROM minted THEN RAISE EXCEPTION 'Hook changed ordinary login'; END IF;
    RESET ROLE;

    UPDATE public.mcp_connections SET revoked_at=now() WHERE id=(connection->>'id')::uuid;
    SET LOCAL ROLE supabase_auth_admin;
    denied := false;
    BEGIN PERFORM public.mcp_access_token_hook(event);
    EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'Revoked grant refreshed'; END IF;
    RESET ROLE;

    SET LOCAL ROLE service_role;
    replay := public.authorize_mcp_connection(actor,studio,client_id,'Test assistant',gen_random_uuid(),ARRAY['students'],'https://mcp.example.invalid/mcp',now()+interval '1 day');
    IF replay->>'id' = connection->>'id' THEN RAISE EXCEPTION 'Reconnect reused revoked token identity'; END IF;
    SET LOCAL ROLE supabase_auth_admin;
    denied := false;
    BEGIN PERFORM public.mcp_access_token_hook(event);
    EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'Old refresh adopted replacement grant'; END IF;
    RESET ROLE;

    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES('00000000-0000-4000-8000-000000006009','authenticated','authenticated','mcp-successor@example.invalid','{}','{}',now(),now());
    INSERT INTO public.staff_roles(user_id,studio_id,role)
    VALUES('00000000-0000-4000-8000-000000006009',studio,'admin');
    UPDATE auth.users SET email_confirmed_at=now() WHERE id IN(actor,other_actor,'00000000-0000-4000-8000-000000006009');
    UPDATE public.studios SET owner_id='00000000-0000-4000-8000-000000006009' WHERE id=studio;
    UPDATE public.staff_roles SET role='instructor' WHERE user_id=actor;
    SET LOCAL ROLE service_role;
    denied := false;
    BEGIN PERFORM public.authorize_mcp_connection(actor,studio,client_id,'Test',gen_random_uuid(),ARRAY['students'],'https://mcp.example.invalid/mcp',now()+interval '1 day');
    EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
    IF denied IS DISTINCT FROM true THEN RAISE EXCEPTION 'Downgraded owner could create grants'; END IF;
    RESET ROLE;

    -- Match account deletion's FK cleanup: connection references never strand
    -- or prevent deleting an identity.
    DELETE FROM public.staff_roles WHERE user_id=actor;
    DELETE FROM auth.users WHERE id=actor;
    IF EXISTS(SELECT 1 FROM public.mcp_connections WHERE user_id=actor) THEN RAISE EXCEPTION 'Deleted account retained a grant'; END IF;
END;
$contract$;
ROLLBACK;
SELECT 'MCP connection ownership, audience, sessions, revocation and deletion passed';
