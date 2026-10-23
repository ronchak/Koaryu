"""Real native OAuth and MCP scenarios on NativeStack's disposable fixture."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
from datetime import datetime
from urllib.parse import parse_qs, urlparse
from uuid import UUID, uuid4

import httpx
import httpx2
import jwt
from local_postgres_verification import quoted_identity, require
from mcp import ClientSession
from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientMetadata
from mcp_oauth_native_stack import GATEWAY, NativeStack, private_json


class MemoryStorage:
    def __init__(self):
        self.tokens = None
        self.client_info = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens

    async def get_client_info(self):
        return self.client_info

    async def set_client_info(self, client_info):
        self.client_info = client_info


class Scenarios:
    def __init__(self, stack: NativeStack):
        self.stack = stack
        self.local = stack.local
        self.auth = GATEWAY + "/auth/v1"
        self.backend = stack.context["backend_url"]
        self.resource = stack.context["resource"]
        self.callback = f"http://127.0.0.1:{stack.context['callback_port']}/callback"
        self.client = httpx.Client(trust_env=False, follow_redirects=False, timeout=20)
        self.cases = []
        self.owners = []
        self.owner_headers = {}

    def close(self):
        self.client.close()

    def expect(self, response, statuses, case):
        if response.status_code not in statuses:
            (self.stack.evidence / "failure.txt").write_text(
                case + "\n" + str(response.status_code) + "\n" + response.text
            )
            raise RuntimeError(
                f"{case}: HTTP {response.status_code}; inspect private failure evidence"
            )
        self.cases.append({"case": case, "status": response.status_code})
        print(f"PASS {case} ({response.status_code})", flush=True)
        return response

    @staticmethod
    def claims(token):
        # Inspection only. The actual MCP connection independently verifies the
        # native issuer's signature using its real JWKS endpoint.
        return jwt.decode(token, options={"verify_signature": False})

    def new_owner(self, suffix):
        email = f"native-mcp-{suffix}@example.invalid"
        password = "Synthetic-only-" + secrets.token_hex(12) + "!"
        response = self.expect(
            self.client.post(
                self.auth + "/admin/users",
                headers={
                    "Authorization": "Bearer " + self.stack.keys["service_role"],
                },
                json={
                    "email": email,
                    "password": password,
                    "email_confirm": True,
                    "user_metadata": {"private_sentinel": "not-for-connector"},
                },
            ),
            {200},
            "create synthetic native owner " + suffix,
        )
        return {
            "email": email,
            "password": password,
            "user_id": str(UUID(response.json()["id"])),
            "studio_id": str(uuid4()),
        }

    def login(self, owner):
        response = self.expect(
            self.client.post(
                self.auth + "/token?grant_type=password",
                headers={"apikey": self.stack.keys["anon"]},
                json={"email": owner["email"], "password": owner["password"]},
            ),
            {200},
            "ordinary password login with native hook",
        )
        tokens = response.json()
        claims = self.claims(tokens["access_token"])
        require(
            claims["sub"] == owner["user_id"]
            and claims["aud"] in ("authenticated", ["authenticated"])
            and claims["user_metadata"]["private_sentinel"] == "not-for-connector",
            "Native hook changed ordinary owner identity",
        )
        return tokens

    def seed(self):
        self.owners = [self.new_owner("a"), self.new_owner("b")]
        for index, owner in enumerate(self.owners):
            actor, studio = owner["user_id"], owner["studio_id"]
            self.local.sql(
                "postgres",
                f"""
                INSERT INTO public.studios(id,name,slug,owner_id,timezone)
                VALUES('{studio}','Native MCP studio {index}','native-mcp-{index}','{actor}','America/Los_Angeles');
                INSERT INTO public.staff_roles(user_id,studio_id,role)
                VALUES('{actor}','{studio}','admin') ON CONFLICT DO NOTHING;
                INSERT INTO public.studio_subscriptions(studio_id,status,comped)
                VALUES('{studio}','active',true)
                ON CONFLICT(studio_id) DO UPDATE SET comped=true,status='active';
            """,
            )
            for student in range(3 if index == 0 else 1):
                self.local.sql(
                    "postgres",
                    f"""
                    INSERT INTO public.students(studio_id,legal_first_name,legal_last_name,status,email,notes)
                    VALUES('{studio}','Native {index}-{student}','Synthetic','active',
                           'student-{index}-{student}@example.invalid','Private notes withheld');
                """,
                )
        private_json(self.stack.evidence / "synthetic-owners.json", self.owners)
        ordinary = self.login(self.owners[0])
        self.owner_headers = {"Authorization": "Bearer " + ordinary["access_token"]}
        self.expect(
            self.client.get(self.auth + "/user", headers=self.owner_headers),
            {200},
            "ordinary account endpoint remains usable",
        )
        refreshed = self.expect(
            self.client.post(
                self.auth + "/token?grant_type=refresh_token",
                headers={"apikey": self.stack.keys["anon"]},
                json={"refresh_token": ordinary["refresh_token"]},
            ),
            {200},
            "ordinary native refresh with hook",
        ).json()
        self.owner_headers = {"Authorization": "Bearer " + refreshed["access_token"]}

    def register(self):
        return self.expect(
            self.client.post(
                self.auth + "/oauth/clients/register",
                json={
                    "client_name": "Koaryu native OAuth verification",
                    "redirect_uris": [self.callback],
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                    "client_type": "public",
                },
            ),
            {200, 201},
            "native dynamic client registration",
        ).json()

    def begin(self, client_id, scope="offline_access"):
        verifier = secrets.token_urlsafe(48)
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .decode()
            .rstrip("=")
        )
        state = secrets.token_urlsafe(24)
        response = self.expect(
            self.client.get(
                self.auth + "/oauth/authorize",
                params={
                    "client_id": client_id,
                    "redirect_uri": self.callback,
                    "response_type": "code",
                    "scope": scope,
                    "state": state,
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "resource": self.resource,
                },
            ),
            {302, 303},
            "native PKCE authorization redirect",
        )
        request_id = parse_qs(urlparse(response.headers["location"]).query)[
            "authorization_id"
        ][0]
        return {
            "id": request_id,
            "client_id": client_id,
            "state": state,
            "verifier": verifier,
        }

    def approve(self, flow, permissions):
        url = self.backend + "/api/v1/mcp/authorizations/" + flow["id"]
        details = self.expect(
            self.client.get(url, headers=self.owner_headers),
            {200},
            "Koaryu reads native opaque authorization request",
        ).json()
        require(
            details.get("identity_scope") == "offline_access",
            "Expected explicit native consent",
        )
        other = self.login(self.owners[1])
        self.expect(
            self.client.get(
                url, headers={"Authorization": "Bearer " + other["access_token"]}
            ),
            {400, 403, 404},
            "another owner cannot adopt a bound request",
        )
        consent = self.expect(
            self.client.post(
                url + "/approve",
                headers=self.owner_headers,
                json={"permissions": permissions, "expires_days": 7},
            ),
            {200},
            "Koaryu saves scoped consent before native approval",
        ).json()
        result = parse_qs(urlparse(consent["redirect_url"]).query)
        require(
            result.get("state") == [flow["state"]], "Native callback state mismatch"
        )
        return result["code"][0]

    def exchange(self, flow, code, *, verifier=None):
        return self.client.post(
            self.auth + "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": flow["client_id"],
                "redirect_uri": self.callback,
                "code_verifier": verifier or flow["verifier"],
                "resource": self.resource,
            },
        )

    def refresh(self, client_id, refresh_token):
        return self.client.post(
            self.auth + "/oauth/token",
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": refresh_token,
                "resource": self.resource,
            },
        )

    def denied_mcp(self, token, case):
        self.expect(
            self.client.post(
                self.resource,
                headers={
                    "Authorization": "Bearer " + token,
                    "Accept": "application/json,text/event-stream",
                },
                json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
            ),
            {401},
            case,
        )

    def business_snapshot(self):
        tables = json.loads(
            self.local.sql(
                "postgres",
                """
            SELECT jsonb_agg(n.nspname || '.' || c.relname ORDER BY n.nspname,c.relname)
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p')
              AND NOT (n.nspname='public' AND c.relname='mcp_connections');
        """,
            )
        )
        snapshot = {}
        for name in tables:
            snapshot[name] = self.local.sql(
                "postgres",
                "SELECT encode(extensions.digest(convert_to("
                "coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text COLLATE \"C\"),''),"
                "'UTF8'),'sha256'),'hex') FROM " + quoted_identity(name) + " t;",
            )
        return snapshot

    async def read(self, token, *, contacts=False):
        before = self.business_snapshot()
        async with (
            httpx2.AsyncClient(
                trust_env=False,
                headers={
                    "Authorization": "Bearer " + token,
                    "X-Studio-Id": self.owners[1]["studio_id"],
                },
            ) as client,
            streamable_http_client(self.resource, http_client=client) as streams,
            ClientSession(*streams) as session,
        ):
            await session.initialize()
            tools = await session.list_tools()
            require(
                len(tools.tools) == 4
                and all(t.annotations.read_only_hint for t in tools.tools),
                "Expected the complete read-only v1 tool contract",
            )
            context = await session.call_tool("get_context")
            require(
                not context.is_error
                and context.structured_content["studio"]["id"]
                == self.owners[0]["studio_id"],
                "Context did not identify the authorized studio",
            )
            schema = await session.call_tool("describe_data", {"dataset": "students"})
            require(
                not schema.is_error and bool(schema.structured_content["datasets"]),
                "Dataset discovery failed",
            )
            count = await session.call_tool(
                "query_data",
                {
                    "query": {
                        "dataset": "students",
                        "aggregates": [{"op": "count", "alias": "students"}],
                    }
                },
            )
            require(
                not count.is_error
                and count.structured_content["rows"] == [{"students": 3}],
                "Actual PostgREST query leaked another studio or returned wrong count",
            )
            contact = await session.call_tool(
                "query_data", {"query": {"dataset": "students", "select": ["email"]}}
            )
            require(
                contact.is_error != contacts,
                "Sensitive field permission does not match explicit consent",
            )
            page = await session.call_tool(
                "query_data",
                {"query": {"dataset": "students", "select": ["id"], "limit": 1}},
            )
            require(
                not page.is_error and len(page.structured_content["rows"]) == 1,
                "Record lookup fixture is missing",
            )
            record = await session.call_tool(
                "get_record",
                {
                    "dataset": "students",
                    "record_id": page.structured_content["rows"][0]["id"],
                    "select": ["legal_first_name"],
                },
            )
            require(
                not record.is_error and len(record.structured_content["rows"]) == 1,
                "Actual record lookup failed",
            )
        require(
            self.business_snapshot() == before,
            "MCP read tools changed business records",
        )
        print(
            "PASS real MCP SDK, actual PostgREST, tenant isolation and contact permission",
            flush=True,
        )

    def native_account_boundary(self, token):
        headers = {
            "Authorization": "Bearer " + token,
            "apikey": self.stack.keys["anon"],
        }
        for path in ("/user", "/factors", "/user/oauth/grants", "/oauth/userinfo"):
            self.expect(
                self.client.get(self.auth + path, headers=headers),
                {400, 401, 403},
                "connector refused by native " + path,
            )
        self.expect(
            self.client.put(
                self.auth + "/user", headers=headers, json={"data": {"forbidden": True}}
            ),
            {400, 401, 403},
            "connector cannot mutate native account",
        )
        self.expect(
            self.client.post(self.auth + "/logout", headers=headers),
            {400, 401, 403},
            "connector cannot invoke native logout",
        )
        self.expect(
            self.client.get(self.backend + "/api/v1/mcp/connections", headers=headers),
            {401},
            "connector refused by ordinary Koaryu API",
        )
        self.expect(
            self.client.get(GATEWAY + "/rest/v1/students?select=id", headers=headers),
            {400, 401, 403},
            "connector refused by direct database API",
        )

        connection = str(UUID(self.claims(token)["koaryu_connection_id"]))
        self.expect(
            self.client.post(
                self.backend + "/api/v1/mcp/connections/" + connection + "/access",
                headers=headers,
                json={
                    "permissions": ["students", "contacts"],
                    "expires_days": 90,
                    "expected_authorized_at": "2000-01-01T00:00:00Z",
                },
            ),
            {401},
            "connector cannot widen or renew its own consent",
        )

    def owner_access_changes(self, current):
        connection = str(
            UUID(self.claims(current["access_token"])["koaryu_connection_id"])
        )
        data = self.expect(
            self.client.get(
                self.backend + "/api/v1/mcp/connections", headers=self.owner_headers
            ),
            {200},
            "owner lists connection control metadata",
        ).json()
        original = next(row for row in data["connections"] if row["id"] == connection)
        require(
            original["session_ready"] and "session_id" not in original,
            "Connection metadata leaked native session",
        )
        url = self.backend + "/api/v1/mcp/connections/" + connection + "/access"
        updated = self.expect(
            self.client.post(
                url,
                headers=self.owner_headers,
                json={
                    "permissions": ["students", "schedule", "contacts"],
                    "expected_authorized_at": original["authorized_at"],
                },
            ),
            {200},
            "owner changes permissions without silently extending expiry",
        ).json()
        require(
            datetime.fromisoformat(updated["expires_at"])
            == datetime.fromisoformat(original["expires_at"]),
            "Permission edit silently extended connection lifetime",
        )
        asyncio.run(self.read(current["access_token"], contacts=True))
        self.expect(
            self.client.post(
                url,
                headers=self.owner_headers,
                json={
                    "permissions": ["students"],
                    "expected_authorized_at": original["authorized_at"],
                },
            ),
            {409},
            "stale owner consent cannot overwrite a concurrent edit",
        )
        other = self.login(self.owners[1])
        self.expect(
            self.client.post(
                url,
                headers={"Authorization": "Bearer " + other["access_token"]},
                json={
                    "permissions": ["students"],
                    "expected_authorized_at": updated["authorized_at"],
                },
            ),
            {404},
            "another owner cannot change connection consent",
        )
        self.expect(
            self.client.post(
                url,
                headers=self.owner_headers,
                json={
                    "permissions": ["students", "schedule"],
                    "expected_authorized_at": updated["authorized_at"],
                },
            ),
            {200},
            "owner removes sensitive field access immediately",
        )
        asyncio.run(self.read(current["access_token"]))

    def openid_bypass(self, client_id, current):
        flow = self.begin(client_id, "openid offline_access")
        self.expect(
            self.client.get(
                self.backend + "/api/v1/mcp/authorizations/" + flow["id"],
                headers=self.owner_headers,
            ),
            {400},
            "Koaryu refuses identity scopes",
        )
        native = self.expect(
            self.client.post(
                self.auth + "/oauth/authorizations/" + flow["id"] + "/consent",
                headers=self.owner_headers,
                json={"action": "approve"},
            ),
            {200},
            "native-only consent cannot bypass Koaryu hook",
        )
        code = parse_qs(urlparse(native.json()["redirect_url"]).query)["code"][0]
        refused = self.expect(
            self.exchange(flow, code),
            {400, 401, 403, 500},
            "native hook prevents owner ID token issuance",
        )
        require(
            "id_token" not in refused.json() and "access_token" not in refused.json(),
            "Identity scope produced usable owner credentials",
        )
        # A native hook refusal must not merely reflect a broken Auth service.
        valid = self.expect(
            self.refresh(client_id, current["refresh_token"]),
            {200},
            "valid offline refresh remains usable after refused OpenID bypass",
        ).json()
        return valid

    def lifecycle(self, registered, current):
        client_id = registered["client_id"]
        claims = self.claims(current["access_token"])
        connection = str(UUID(claims["koaryu_connection_id"]))
        before = json.loads(
            self.local.sql(
                "postgres",
                f"SELECT row_to_json(c) FROM public.mcp_connections c WHERE id='{connection}';",
            )
        )
        try:
            self.local.sql(
                "postgres",
                f"""
                UPDATE public.mcp_connections SET authorized_at=now()-interval '1 day',
                    expires_at=now()-interval '1 second' WHERE id='{connection}';
            """,
            )
            self.denied_mcp(
                current["access_token"],
                "expired connection cannot use a still-signed token",
            )
            self.expect(
                self.refresh(client_id, current["refresh_token"]),
                {400, 401, 403, 500},
                "expired connection cannot refresh native tokens",
            )
            expired = json.loads(
                self.local.sql(
                    "postgres",
                    f"SELECT row_to_json(c) FROM public.mcp_connections c WHERE id='{connection}';",
                )
            )
            url = self.backend + "/api/v1/mcp/connections/" + connection + "/access"
            self.expect(
                self.client.post(
                    url,
                    headers=self.owner_headers,
                    json={
                        "permissions": ["students", "schedule"],
                        "expected_authorized_at": expired["authorized_at"],
                    },
                ),
                {409},
                "expired access cannot renew implicitly through a permission edit",
            )
            self.expect(
                self.client.post(
                    url,
                    headers=self.owner_headers,
                    json={
                        "permissions": ["students", "schedule"],
                        "expected_authorized_at": expired["authorized_at"],
                        "expires_days": 7,
                    },
                ),
                {200},
                "owner explicitly renews an expired connection",
            )
            asyncio.run(self.read(current["access_token"]))
        finally:
            self.local.sql(
                "postgres",
                f"""
                UPDATE public.mcp_connections SET authorized_at='{before["authorized_at"]}',
                    expires_at='{before["expires_at"]}' WHERE id='{connection}';
            """,
            )
        self.expect(
            self.client.delete(
                self.backend + "/api/v1/mcp/connections/" + connection,
                headers=self.owner_headers,
            ),
            {200},
            "owner disconnects native consent and Koaryu access",
        )
        revoked = json.loads(
            self.local.sql(
                "postgres",
                f"SELECT row_to_json(c) FROM public.mcp_connections c WHERE id='{connection}';",
            )
        )
        self.expect(
            self.client.post(
                self.backend + "/api/v1/mcp/connections/" + connection + "/access",
                headers=self.owner_headers,
                json={
                    "permissions": ["students"],
                    "expires_days": 90,
                    "expected_authorized_at": revoked["authorized_at"],
                },
            ),
            {409},
            "owner edit cannot revive a disconnected connection",
        )
        self.denied_mcp(
            current["access_token"],
            "disconnected connection cannot use its old access token",
        )
        self.expect(
            self.refresh(client_id, current["refresh_token"]),
            {400, 401, 403, 500},
            "disconnected native session cannot refresh",
        )
        flow = self.begin(client_id)
        code = self.approve(flow, ["students", "schedule", "contacts"])
        reconnected = self.expect(
            self.exchange(flow, code),
            {200},
            "owner reconnects with changed field consent",
        ).json()
        replacement = self.claims(reconnected["access_token"])
        require(
            replacement["koaryu_connection_id"] != connection
            and replacement["session_id"] != claims["session_id"],
            "Reconnect reused old grant or native session",
        )
        self.denied_mcp(
            current["access_token"], "reconnect does not revive an old grant"
        )
        self.expect(
            self.refresh(client_id, current["refresh_token"]),
            {400, 401, 403, 500},
            "old refresh cannot adopt replacement grant",
        )
        asyncio.run(self.read(reconnected["access_token"], contacts=True))

    async def sdk_oauth(self):
        storage = MemoryStorage()
        returned = None
        async with httpx2.AsyncClient(
            trust_env=False, follow_redirects=False, timeout=20
        ) as browser:

            async def redirect(url):
                nonlocal returned
                response = await browser.get(url)
                require(
                    response.status_code in (302, 303), "SDK authorize did not redirect"
                )
                request_id = parse_qs(urlparse(response.headers["location"]).query)[
                    "authorization_id"
                ][0]
                response = await browser.get(
                    self.backend + "/api/v1/mcp/authorizations/" + request_id,
                    headers=self.owner_headers,
                )
                response.raise_for_status()
                response = await browser.post(
                    self.backend
                    + "/api/v1/mcp/authorizations/"
                    + request_id
                    + "/approve",
                    headers=self.owner_headers,
                    json={"permissions": ["students", "schedule"], "expires_days": 7},
                )
                response.raise_for_status()
                query = parse_qs(urlparse(response.json()["redirect_url"]).query)
                returned = AuthorizationCodeResult(
                    code=query["code"][0],
                    state=query.get("state", [None])[0],
                    iss=query.get("iss", [None])[0],
                )

            async def callback():
                require(returned is not None, "SDK callback was not prepared")
                return returned

            provider = OAuthClientProvider(
                self.resource,
                OAuthClientMetadata(
                    redirect_uris=[self.callback],
                    client_name="Koaryu native MCP OAuth SDK proof",
                    token_endpoint_auth_method="none",
                ),
                storage,
                redirect_handler=redirect,
                callback_handler=callback,
            )
            async with (
                httpx2.AsyncClient(
                    auth=provider, trust_env=False, timeout=30
                ) as client,
                streamable_http_client(self.resource, http_client=client) as streams,
                ClientSession(*streams) as session,
            ):
                await session.initialize()
                context = await session.call_tool("get_context")
                require(
                    not context.is_error
                    and context.structured_content["studio"]["id"]
                    == self.owners[0]["studio_id"],
                    "SDK OAuth connected another studio",
                )
        require(
            storage.tokens is not None and storage.client_info is not None,
            "SDK did not store native OAuth result",
        )
        self.cases.append(
            {
                "case": "official SDK discovery DCR PKCE consent token and MCP read",
                "status": "passed",
            }
        )
        print(
            "PASS official MCP OAuth client completes native discovery, DCR, PKCE, consent and studio read",
            flush=True,
        )

    def run(self, *, large_fixture=False):
        try:
            self.seed()
            ordinary = self.login(self.owners[0])
            self.denied_mcp(
                ordinary["access_token"],
                "ordinary owner token cannot impersonate a connector",
            )
            registered = self.register()
            flow = self.begin(registered["client_id"])
            code = self.approve(flow, ["students", "schedule"])
            self.expect(
                self.exchange(flow, code, verifier=secrets.token_urlsafe(48)),
                {400, 401},
                "native PKCE rejects wrong verifier",
            )
            issued = self.expect(
                self.exchange(flow, code),
                {200},
                "native PKCE exchange through real hook",
            ).json()
            require(
                "id_token" not in issued and "user" not in issued,
                "Native OAuth response leaked owner identity",
            )
            claims = self.claims(issued["access_token"])
            require(
                claims["sub"] == "urn:koaryu:mcp:" + claims["koaryu_connection_id"]
                and claims["aud"] == self.resource
                and claims["scope"] == "offline_access"
                and claims["email"] == ""
                and claims["phone"] == ""
                and "user_metadata" not in claims
                and "app_metadata" not in claims,
                "Native hook did not isolate connector identity and resource",
            )
            self.native_account_boundary(issued["access_token"])
            asyncio.run(self.read(issued["access_token"]))
            self.owner_access_changes(issued)
            current = self.expect(
                self.refresh(registered["client_id"], issued["refresh_token"]),
                {200},
                "native OAuth refresh through real hook",
            ).json()
            require(
                self.claims(current["access_token"])["session_id"]
                == claims["session_id"],
                "Native refresh changed the bound session",
            )
            self.expect(
                self.client.post(
                    self.auth + "/token?grant_type=refresh_token",
                    json={"refresh_token": current["refresh_token"]},
                ),
                {400, 401, 403},
                "plain native refresh cannot adopt an OAuth session",
            )
            current = self.openid_bypass(registered["client_id"], current)
            self.lifecycle(registered, current)
            asyncio.run(self.sdk_oauth())
            load_result = None
            if large_fixture:
                from mcp_oauth_native_load import run_large_fixture

                load_result = run_large_fixture(self)
            private_json(
                self.stack.evidence / "result.json",
                {
                    "mode": "real-native-stack",
                    "cases": self.cases,
                    "ordinary_login_refresh": True,
                    "tenant_isolation": True,
                    "connector_business_writes": False,
                    **({"large_fixture": load_result} if load_result else {}),
                },
            )
            return len(self.cases)
        finally:
            self.close()
