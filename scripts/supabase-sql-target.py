"""Resolve local ports or launch contract SQL against the pinned staging database."""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit


STAGING_REF = "nxgsektqsgrtyfhawxbc"
SESSION_POOLER_HOST = re.compile(r"aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com")


class TargetError(ValueError):
    pass


@dataclass(frozen=True)
class Connection:
    host: str
    port: int
    user: str
    password: str = field(repr=False)
    sslmode: str
    connect_timeout: str


def decode(value: str) -> str:
    decoded = unquote(value, errors="strict")
    if re.search(r"[\x00-\x1f\x7f]", decoded):
        raise TargetError("Database connection fields must not contain control characters.")
    return decoded


def parse_connection(value: str) -> Connection:
    if not isinstance(value, str) or not value or re.search(r"[\x00-\x20\x7f]", value):
        raise TargetError("A database URI without whitespace or control characters is required.")
    if re.search(r"%(?![0-9a-fA-F]{2})", value) or "#" in value:
        raise TargetError("Malformed database URI escaping or fragment.")
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if parsed.scheme not in {"postgres", "postgresql"} or parsed.netloc.count("@") != 1:
            raise TargetError("Use a postgres URI with an explicit database user.")
        if not host or port is None or not 1 <= port <= 65535 or decode(parsed.path) != "/postgres":
            raise TargetError("Use the postgres database with an explicit valid port.")
        user = decode(parsed.username or "")
        password = decode(parsed.password or "")
        options = {}
        query_options = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, errors="strict") if parsed.query else []
        for key, option in query_options:
            if key not in {"sslmode", "connect_timeout"} or key in options:
                raise TargetError("Only one sslmode and connect_timeout option are supported; routing overrides are forbidden.")
            if re.search(r"[\x00-\x1f\x7f]", option):
                raise TargetError("Database options must not contain control characters.")
            options[key] = option
    except TargetError:
        raise
    except ValueError:
        raise TargetError("Malformed database URI.") from None
    sslmode = options.get("sslmode", "require")
    if sslmode not in {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}:
        raise TargetError("Unsupported database SSL mode.")
    timeout = options.get("connect_timeout", "10")
    if not re.fullmatch(r"[0-9]{1,2}", timeout) or not 1 <= int(timeout) <= 60:
        raise TargetError("connect_timeout must be between 1 and 60 seconds.")
    return Connection(host, port, user, password, sslmode, str(int(timeout)))


def local_port() -> None:
    try:
        payload = json.load(sys.stdin)
        connection = parse_connection(payload["DB_URL"])
    except (KeyError, TypeError, ValueError):
        raise TargetError("Unable to resolve the local Supabase database connection.") from None
    if connection.host not in {"127.0.0.1", "localhost", "::1"}:
        raise TargetError("Local Supabase status must identify a loopback database.")
    print(connection.port)


def run_linked(sql_file: str) -> None:
    connection = parse_connection(os.environ.get("SUPABASE_DB_URL", ""))
    direct = connection.host == f"db.{STAGING_REF}.supabase.co" and connection.user == "postgres"
    pooled = SESSION_POOLER_HOST.fullmatch(connection.host) and connection.user == f"postgres.{STAGING_REF}"
    if connection.port != 5432 or not (direct or pooled):
        raise TargetError("Linked contract SQL is restricted to the pinned Koaryu staging project on session port 5432.")
    if connection.sslmode not in {"require", "verify-ca", "verify-full"}:
        raise TargetError("Linked SQL requires TLS: sslmode must be require, verify-ca or verify-full.")
    if not Path(sql_file).is_file():
        raise TargetError("SQL file does not exist.")
    # Never let libpq service/hostaddr/options override the checked destination.
    # The password stays in the child environment, not in its process arguments.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("PG") and key != "SUPABASE_DB_URL"}
    environment.update(PGPASSWORD=connection.password, PGSSLMODE=connection.sslmode, PGCONNECT_TIMEOUT=connection.connect_timeout)
    os.execvpe("psql", [
        "psql", "-h", connection.host, "-p", str(connection.port), "-U", connection.user,
        "-d", "postgres", "--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1",
        "--file", sql_file,
    ], environment)


def main() -> int:
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "local-port":
            local_port()
        elif len(sys.argv) == 3 and sys.argv[1] == "linked":
            run_linked(sys.argv[2])
        else:
            raise TargetError("Use this helper through scripts/run-supabase-sql.sh.")
    except TargetError as error:
        print(str(error), file=sys.stderr)
        return 2
    except OSError:
        print("Unable to launch PostgreSQL psql.", file=sys.stderr)
        return 127
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
