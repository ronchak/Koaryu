"""Owned, loopback-only native Auth/PostgREST stack for the MCP OAuth proof.

This is developer verification tooling, not an application or deployment entry.
It never accepts a database URL, account credential, or hosted target.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlencode
from uuid import uuid4

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request, Response
from local_postgres_verification import LocalPostgres, require

ROOT = Path(__file__).resolve().parents[1]
GATEWAY = "http://127.0.0.1:54321"
MODE = "owned-synthetic-mcp-oauth-v1"
CONTEXT_ENV = "KOARYU_NATIVE_MCP_CONTEXT"


def private_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def process_environment(extra: dict[str, str]) -> dict[str, str]:
    # Do not inherit provider credentials, proxy settings, or a developer dotenv.
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ["HOME"],
        "LC_ALL": "C",
        **extra,
    }


class NativeStack:
    def __init__(
        self, auth_binary: Path, postgrest_binary: Path, pg_bin: Path, evidence: Path
    ):
        self.auth_binary = auth_binary.resolve(strict=True)
        self.postgrest_binary = postgrest_binary.resolve(strict=True)
        self.pg_bin = pg_bin.resolve(strict=True)
        self.evidence = evidence.resolve()
        require(not self.evidence.exists(), "Evidence directory must be new")
        self.children: list[tuple[str, subprocess.Popen]] = []
        self.logs = []
        self.temporary: Path | None = None
        self.local: LocalPostgres | None = None
        self.context: dict = {}
        self.keys: dict = {}

    def _command(self, command: list, *, environment=None, timeout=180) -> str:
        result = subprocess.run(
            [str(value) for value in command],
            text=True,
            capture_output=True,
            env=environment or process_environment({}),
            timeout=timeout,
            check=False,
        )
        require(
            result.returncode == 0,
            "Native verification command failed: " + result.stderr[-2500:],
        )
        return result.stdout.strip()

    def _start(self, name, command, environment, *, cwd):
        log = (self.evidence / f"{name}.log").open("w")
        self.logs.append(log)
        process = subprocess.Popen(
            [str(value) for value in command],
            cwd=cwd,
            env=process_environment(environment),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        self.children.append((name, process))

    def __enter__(self):
        try:
            self._setup()
            return self
        except BaseException:
            self.close()
            raise

    def _setup(self):
        # The application's privileged-target guard deliberately accepts only
        # this canonical local Supabase URL. Refuse a developer's existing stack.
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", 54321))
            except OSError as exc:
                raise RuntimeError(
                    "Port 54321 is occupied; leave that stack alone"
                ) from exc
        self.evidence.mkdir(parents=True, mode=0o700)
        self.temporary = Path("/tmp/koaryu-pg." + secrets.token_hex(6))
        self.temporary.mkdir(mode=0o700)
        (self.temporary / "socket").mkdir(mode=0o700)
        self._command(
            [
                self.pg_bin / "initdb",
                "-D",
                self.temporary / "data",
                "--auth=trust",
                "--username=postgres",
                "--encoding=UTF8",
                "--no-locale",
            ]
        )
        with (self.temporary / "data/postgresql.conf").open("a") as config:
            config.write(
                "\nlisten_addresses=''\nunix_socket_directories='"
                + str(self.temporary / "socket")
                + "'\nport=5432\nmax_connections=50\n"
            )
        self._command(
            [
                self.pg_bin / "pg_ctl",
                "-D",
                self.temporary / "data",
                "-l",
                self.evidence / "postgres.log",
                "-w",
                "start",
            ]
        )
        self.local = LocalPostgres(
            str(self.pg_bin / "psql"),
            str(self.temporary / "socket"),
            "5432",
            str(self.temporary),
        )
        self.context = {
            "mode": MODE,
            "root": str(ROOT),
            "temporary": str(self.temporary),
            "socket": str(self.temporary / "socket"),
            "port": "5432",
            "psql": str(self.pg_bin / "psql"),
            "database": "postgres",
            "auth_port": free_port(),
            "postgrest_port": free_port(),
            "backend_port": free_port(),
            "frontend_port": free_port(),
            "callback_port": free_port(),
        }
        self.context["backend_url"] = f"http://127.0.0.1:{self.context['backend_port']}"
        self.context["resource"] = self.context["backend_url"] + "/mcp"
        self.context_path = self.evidence / "context.json"
        private_json(self.context_path, self.context)
        self.local.sql(
            "postgres",
            """
            CREATE ROLE supabase_auth_admin LOGIN NOINHERIT;
            ALTER ROLE supabase_auth_admin SET search_path TO auth;
            CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
        """,
        )
        verifier = (ROOT / "scripts/verify-supabase-contracts-local.sh").read_text()
        start = verifier.index('echo "[bootstrap] RUN Supabase compatibility shim"')
        start = verifier.index("<<'SQL'", start) + len("<<'SQL'")
        end = verifier.index("\nSQL\n", start)
        shim = verifier[start:end]
        start = shim.index("CREATE SCHEMA auth AUTHORIZATION")
        end = shim.index("CREATE SCHEMA storage AUTHORIZATION", start)
        # Auth's actual migrations own its schema and users, not the shim.
        self.local.sql("postgres", shim[:start] + shim[end:])
        self._keys()
        database_url = (
            "postgresql://supabase_auth_admin@localhost/postgres?"
            + urlencode(
                {
                    "host": str(self.temporary / "socket"),
                    "sslmode": "disable",
                }
            )
        )
        auth_environment = {
            "GOTRUE_DB_DRIVER": "postgres",
            "DB_NAMESPACE": "auth",
            "DATABASE_URL": database_url,
            "API_EXTERNAL_URL": GATEWAY + "/auth/v1",
            "GOTRUE_API_HOST": "127.0.0.1",
            "PORT": str(self.context["auth_port"]),
            "GOTRUE_SITE_URL": f"http://127.0.0.1:{self.context['frontend_port']}",
            "GOTRUE_JWT_SECRET": self.keys["secret"],
            "GOTRUE_JWT_KEYS": json.dumps([self.keys["jwt_private"]]),
            "GOTRUE_JWT_KEY_ID": self.keys["jwt_private"]["kid"],
            "GOTRUE_JWT_ISSUER": GATEWAY + "/auth/v1",
            "GOTRUE_JWT_AUD": "authenticated",
            "GOTRUE_JWT_EXP": "300",
            "GOTRUE_JWT_DEFAULT_GROUP_NAME": "authenticated",
            "GOTRUE_JWT_ADMIN_ROLES": "service_role,supabase_admin",
            "GOTRUE_LOG_LEVEL": "warn",
            "GOTRUE_MAILER_AUTOCONFIRM": "true",
            "GOTRUE_DISABLE_SIGNUP": "false",
            "GOTRUE_EXTERNAL_EMAIL_ENABLED": "true",
            "GOTRUE_EXTERNAL_PHONE_ENABLED": "false",
            "GOTRUE_DB_MAX_POOL_SIZE": "4",
            "GOTRUE_OAUTH_SERVER_ENABLED": "true",
            "GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION": "true",
            "GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH": "/connect/authorize",
            "GOTRUE_OAUTH_SERVER_DEFAULT_SCOPE": "offline_access",
            "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED": "false",
            "GOTRUE_RATE_LIMIT_TOKEN_REFRESH": "10000",
            "GOTRUE_RATE_LIMIT_VERIFY": "10000",
        }
        migration = subprocess.run(
            [str(self.auth_binary), "migrate"],
            cwd=self.evidence,
            env=process_environment(auth_environment),
            text=True,
            capture_output=True,
            timeout=180,
            check=False,
        )
        (self.evidence / "auth-migrations.log").write_text(
            migration.stdout + migration.stderr
        )
        require(
            migration.returncode == 0,
            "Native Auth migrations failed; inspect evidence log",
        )
        self.local.sql(
            "postgres",
            """
            GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
            GRANT EXECUTE ON FUNCTION auth.uid(),auth.role(),auth.email() TO anon,authenticated,service_role;
        """,
        )
        for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            version, name = path.stem.split("_", 1)
            self.local.run(
                [
                    self.local.psql,
                    *self.local.connection,
                    "--dbname=postgres",
                    "--no-psqlrc",
                    "--set=ON_ERROR_STOP=1",
                    "--quiet",
                    "--single-transaction",
                    f"--file={path}",
                    (
                        "--command=INSERT INTO supabase_migrations.schema_migrations(version,name) "
                        f"VALUES('{version}','{name}');"
                    ),
                ]
            )
        from runpy import run_path

        readiness = run_path(
            str(ROOT / "backend/app/services/generated_release_readiness.py")
        )
        row = json.loads(
            self.local.sql(
                "postgres",
                "SELECT row_to_json(p) FROM public."
                + readiness["RELEASE_PREFLIGHT_RPC"]
                + "() p;",
            )
        )
        require(
            row["ready"]
            and row["migration_count"] == readiness["EXPECTED_RELEASE_MIGRATION_COUNT"]
            and not row["security_failures"],
            "Actual native stack is not the current complete candidate",
        )
        private_json(self.evidence / "readiness.json", row)
        self.local.sql("postgres", "ALTER ROLE authenticator LOGIN;")
        auth_environment.update(
            {
                "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED": "true",
                "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI": "pg-functions://postgres/public/mcp_access_token_hook",
            }
        )
        self._start(
            "auth", [self.auth_binary, "serve"], auth_environment, cwd=self.evidence
        )
        rest_environment = {
            "PGRST_DB_URI": "postgresql://authenticator@localhost/postgres?"
            + urlencode(
                {
                    "host": str(self.temporary / "socket"),
                    "sslmode": "disable",
                }
            ),
            "PGRST_DB_SCHEMAS": "public",
            "PGRST_DB_ANON_ROLE": "anon",
            "PGRST_DB_EXTRA_SEARCH_PATH": "public,extensions",
            "PGRST_DB_POOL": "5",
            "PGRST_JWT_SECRET": json.dumps(self.keys["jwt_public"]),
            "PGRST_SERVER_HOST": "127.0.0.1",
            "PGRST_SERVER_PORT": str(self.context["postgrest_port"]),
            "PGRST_LOG_LEVEL": "warn",
        }
        if sys.platform == "darwin":
            # Official macOS binaries link Homebrew libpq; PostgreSQL17 also
            # provides that library when libpq is not separately installed.
            rest_environment["DYLD_FALLBACK_LIBRARY_PATH"] = str(
                self.pg_bin.parent / "lib/postgresql"
            )
        self._start(
            "postgrest", [self.postgrest_binary], rest_environment, cwd=self.evidence
        )
        python = Path(sys.executable)
        common = [
            python,
            "-m",
            "uvicorn",
            "--app-dir",
            ROOT / "scripts",
            "--factory",
            "--host",
            "127.0.0.1",
            "--no-access-log",
        ]
        context_environment = {CONTEXT_ENV: str(self.context_path)}
        self._start(
            "gateway",
            [*common, "mcp_oauth_native_stack:gateway", "--port", "54321"],
            context_environment,
            cwd=ROOT,
        )
        backend_environment = {
            **context_environment,
            "ENVIRONMENT": "test",
            "SUPABASE_URL": GATEWAY,
            "SUPABASE_SERVICE_ROLE_KEY": self.keys["service_role"],
            "SUPABASE_ALLOW_LEGACY_HS256": "false",
            "FRONTEND_URL": f"http://127.0.0.1:{self.context['frontend_port']}",
            "MCP_ENABLED": "true",
            "MCP_PUBLIC_URL": self.context["resource"],
            "STRIPE_SECRET_KEY": "",
            "STRIPE_MODE": "test",
            "LIVE_BILLING_ENABLED": "false",
            "CORE_SELF_CHECKOUT_ENABLED": "false",
            "BILLING_TRANSITION_SCHEDULER_ENABLED": "false",
            "AUTOMATION_WORKER_ENABLED": "false",
            "EMAIL_SEND_ENABLED": "false",
            "EMAIL_PROVIDER": "disabled",
            "OPERATIONAL_ALERTS_ENABLED": "false",
        }
        self._start(
            "backend",
            [
                *common,
                "mcp_oauth_native_stack:backend",
                "--port",
                str(self.context["backend_port"]),
            ],
            backend_environment,
            cwd=ROOT / "backend",
        )
        self._ready()

    def _keys(self):
        key = ec.generate_private_key(ec.SECP256R1())
        private = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key))
        private.update(
            kid=str(uuid4()), alg="ES256", use="sig", key_ops=["sign", "verify"]
        )
        public = {name: value for name, value in private.items() if name != "d"}
        public["key_ops"] = ["verify"]
        issued = int(time.time())
        claims = {
            "iss": GATEWAY + "/auth/v1",
            "aud": "authenticated",
            "iat": issued,
            "exp": issued + 7200,
        }
        self.keys = {
            "secret": secrets.token_hex(32),
            "jwt_private": private,
            "jwt_public": {"keys": [public]},
            **{
                role: jwt.encode(
                    {**claims, "role": role},
                    key,
                    algorithm="ES256",
                    headers={"kid": private["kid"]},
                )
                for role in ("service_role", "anon")
            },
        }
        private_json(self.evidence / "keys.json", self.keys)

    def _ready(self):
        deadline = time.monotonic() + 25
        with httpx.Client(trust_env=False, timeout=1) as client:
            while time.monotonic() < deadline:
                failed = [
                    name
                    for name, process in self.children
                    if process.poll() is not None
                ]
                require(
                    not failed,
                    "Native service exited during startup: " + ", ".join(failed),
                )
                try:
                    responses = [
                        client.get(GATEWAY + "/auth/v1/health"),
                        client.get(self.context["backend_url"] + "/health/live"),
                        client.get(
                            GATEWAY + "/rest/v1/studios?select=id",
                            headers={
                                "Authorization": "Bearer " + self.keys["service_role"],
                            },
                        ),
                    ]
                    if all(response.status_code == 200 for response in responses):
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(0.2)
        raise RuntimeError(
            "Native services did not become ready; inspect evidence logs"
        )

    def close(self):
        for _name, process in reversed(self.children):
            if process.poll() is None:
                process.terminate()
        for _name, process in reversed(self.children):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for log in self.logs:
            log.close()
        if (
            self.temporary is not None
            and (self.temporary / "data/postmaster.pid").exists()
        ):
            self._command(
                [
                    self.pg_bin / "pg_ctl",
                    "-D",
                    self.temporary / "data",
                    "-m",
                    "fast",
                    "-w",
                    "stop",
                ]
            )
        if self.temporary is not None:
            require(
                self.temporary.parent == Path("/tmp")
                and self.temporary.name.startswith("koaryu-pg.")
                and not self.temporary.is_symlink(),
                "Refusing unsafe owned-cluster cleanup",
            )
            shutil.rmtree(self.temporary)

    def __exit__(self, *_):
        self.close()


def owned_context():
    context = json.loads(Path(os.environ[CONTEXT_ENV]).read_text())
    require(
        context["mode"] == MODE and Path(context["root"]) == ROOT,
        "Expected owned synthetic native context",
    )
    LocalPostgres(
        context["psql"], context["socket"], context["port"], context["temporary"]
    )
    for key in (
        "auth_port",
        "postgrest_port",
        "backend_port",
        "frontend_port",
        "callback_port",
    ):
        require(
            type(context[key]) is int and 1024 <= context[key] <= 65535,
            "Unsafe native test port",
        )
    return context


def gateway():
    from contextlib import asynccontextmanager

    context = owned_context()
    hop = {
        "host",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "content-encoding",
    }

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(
            trust_env=False, follow_redirects=False, timeout=15
        ) as transport:
            app.state.transport = transport
            yield

    app = FastAPI(lifespan=lifespan)

    async def forward(request: Request, port: int, path: str):
        body = await request.body()
        if len(body) > 131072:
            return Response(status_code=413)
        response = await app.state.transport.request(
            request.method,
            f"http://127.0.0.1:{port}/{path}",
            params=request.query_params,
            content=body,
            headers={
                key: value
                for key, value in request.headers.items()
                if key.lower() not in hop
            },
        )
        return Response(
            response.content,
            status_code=response.status_code,
            headers={
                key: value
                for key, value in response.headers.items()
                if key.lower() not in hop
            },
        )

    @app.api_route(
        "/auth/v1/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    )
    async def auth_route(path: str, request: Request):
        return await forward(request, context["auth_port"], path)

    @app.api_route(
        "/rest/v1/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    )
    async def rest_route(path: str, request: Request):
        return await forward(request, context["postgrest_port"], path)

    return app


def backend():
    owned_context()
    sys.path.insert(0, str(ROOT / "backend"))
    from app.core.config import Settings

    Settings.model_config["env_file"] = None
    from app.main import app

    return app
