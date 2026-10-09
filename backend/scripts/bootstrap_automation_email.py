"""Prepare or confirm one initial, encrypted automation-mail credential import.

No application imports, environment files, provider access, or private-file reads
occur until validate_checkout has accepted the canonical reviewed candidate.
"""

import os

# Python places the script directory ahead of the standard library. Remove local
# import roots before importing even argparse/json, which could be shadowed there.
# sys is built in and os is frozen in the supported Python 3.11 runtime.
import sys

if __name__ == "__main__":
    _SCRIPT_DIRECTORY = os.path.dirname(os.path.abspath(__file__))
    _CURRENT_DIRECTORY = os.path.abspath(os.getcwd())
    sys.path[:] = [
        entry
        for entry in sys.path
        if entry and os.path.abspath(entry) not in {_SCRIPT_DIRECTORY, _CURRENT_DIRECTORY}
    ]

import argparse
import hashlib
import json
import re
import stat
import subprocess
import tempfile
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CANONICAL_ROOT = Path("/Users/openclaw/Projects/Koaryu-Repo")
SCRIPT = "backend/scripts/bootstrap_automation_email.py"
CLIENT_ID = "5b4f5762-7807-4aaf-932a-2a458dc88636"
MAILBOX = "koaryu@outlook.com"
PROVIDER_KEY = "microsoft_graph:primary"
TARGETS = {
    "production": ("mimguepumzsgmcaycdsh", "https://koaryu.onrender.com/health/ready", "live"),
    "staging": ("nxgsektqsgrtyfhawxbc", "https://koaryu-staging.onrender.com/health/ready", "test"),
}
TIMEOUT = 15
MAX_SOURCE_BYTES = 140000
MAX_READINESS_BYTES = 32768
IMPORT_SUFFIXES = {".py", ".pyc", ".so", ".pth"}


class BootstrapError(RuntimeError):
    """Only fixed, non-secret error codes cross the operator boundary."""


def _git(root: Path, *args: str) -> bytes:
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    environment["GIT_CONFIG_GLOBAL"] = os.devnull
    try:
        return subprocess.run(
            ["/usr/bin/git", "--no-optional-locks", "-c", "core.fsmonitor=false", *args],
            cwd=root,
            env=environment,
            check=True,
            capture_output=True,
            timeout=TIMEOUT,
        ).stdout
    except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
        raise BootstrapError("checkout_unverified") from None


def validate_checkout(candidate: str) -> tuple[Path, ...]:
    """No CLI root override. Compare importable source bytes, including ignored files."""
    root = CANONICAL_ROOT
    if (
        not re.fullmatch(r"[0-9a-f]{40}", candidate)
        or Path(__file__).resolve() != root / SCRIPT
        or Path.cwd().resolve() not in {root, root / "backend"}
        or root.resolve() != root
    ):
        raise BootstrapError("canonical_candidate_required")
    if _git(root, "rev-parse", "HEAD").decode().strip() != candidate:
        raise BootstrapError("candidate_mismatch")
    if _git(root, "status", "--porcelain=v1", "--untracked-files=no"):
        raise BootstrapError("tracked_checkout_dirty")
    tree = _git(root, "ls-tree", "-rz", candidate, "--", "backend")
    tracked = {}
    for item in tree.split(b"\0"):
        if item:
            header, name = item.split(b"\t", 1)
            mode, kind, digest = header.split()
            tracked[os.fsdecode(name)] = (mode, kind, digest)
    paths = []
    for directory, child_dirs, files in os.walk(root / "backend", followlinks=False):
        child_dirs[:] = [
            name for name in child_dirs if Path(directory) / name != root / "backend/venv"
        ]
        if any((Path(directory) / name).is_symlink() for name in child_dirs):
            raise BootstrapError("untracked_import_directory")
        paths.extend(Path(directory) / name for name in files)
    paths.extend(root / name for name in tracked if Path(name).suffix in IMPORT_SUFFIXES)
    for path in paths:
        if path.suffix not in IMPORT_SUFFIXES or (
            path.suffix == ".pyc" and "__pycache__" in path.parts
        ):
            continue
        name = path.relative_to(root).as_posix()
        entry = tracked.get(name)
        if entry is None:
            raise BootstrapError("untracked_import_code")
        if (
            path.resolve() != path
            or not path.is_file()
            or entry[0] not in (b"100644", b"100755")
            or entry[1] != b"blob"
        ):
            raise BootstrapError("import_code_unverified")
        content = path.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
        if digest.encode() != entry[2]:
            raise BootstrapError("import_code_mismatch")
    if SCRIPT not in tracked:
        raise BootstrapError("script_not_in_candidate")
    roots = [root]
    for item in _git(root, "worktree", "list", "--porcelain", "-z").split(b"\0"):
        if item.startswith(b"worktree "):
            roots.append(Path(os.fsdecode(item[len(b"worktree ") :])).resolve())
    common = Path(os.fsdecode(_git(root, "rev-parse", "--git-common-dir")).strip())
    roots.append((root / common).resolve())
    return tuple(roots)


def _identity(info: os.stat_result) -> dict[str, int]:
    return {
        "device": info.st_dev,
        "inode": info.st_ino,
        "size": info.st_size,
        "mtime_ns": info.st_mtime_ns,
        "ctime_ns": info.st_ctime_ns,
        "uid": info.st_uid,
        "mode": stat.S_IMODE(info.st_mode),
    }


def _outside_repositories(path: Path, roots: tuple[Path, ...]) -> None:
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise BootstrapError("private_path_symlink")
    resolved = path.resolve(strict=True)
    if any(resolved.is_relative_to(root) for root in roots):
        raise BootstrapError("private_file_inside_repository")
    if any(os.path.lexists(parent / ".git") for parent in resolved.parents):
        raise BootstrapError("private_file_inside_repository")


def read_private_file(
    name: str, roots: tuple[Path, ...], maximum: int
) -> tuple[bytes, dict[str, int]]:
    """Open every component without following symlinks; check the open descriptor."""
    path = Path(name)
    if not path.is_absolute() or ".." in path.parts:
        raise BootstrapError("private_path_invalid")
    try:
        _outside_repositories(path, roots)
        directory = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in path.parts[1:-1]:
                child = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
                )
                os.close(directory)
                directory = child
            descriptor = os.open(
                path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            try:
                before = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(before.st_mode)
                    or before.st_uid != os.getuid()
                    or stat.S_IMODE(before.st_mode) != 0o600
                    or not 1 <= before.st_size <= maximum
                ):
                    raise BootstrapError("private_file_unsafe")
                chunks = bytearray()
                while len(chunks) <= maximum:
                    chunk = os.read(descriptor, min(8192, maximum + 1 - len(chunks)))
                    if not chunk:
                        break
                    chunks.extend(chunk)
                after = os.fstat(descriptor)
                current = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
                if (
                    _identity(before) != _identity(after)
                    or _identity(before) != _identity(current)
                    or len(chunks) != before.st_size
                ):
                    raise BootstrapError("private_file_changed")
                _outside_repositories(path, roots)
                if _identity(path.lstat()) != _identity(before):
                    raise BootstrapError("private_file_changed")
                return bytes(chunks), _identity(before)
            finally:
                os.close(descriptor)
        finally:
            os.close(directory)
    except BootstrapError:
        raise
    except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
        raise BootstrapError("private_file_unavailable") from None


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BootstrapError("source_envelope_invalid")
        result[key] = value
    return result


@contextmanager
def isolated_bytecode():
    """Ignore normal repository caches without deleting them or creating new ones."""
    previous_prefix, previous_write = sys.pycache_prefix, sys.dont_write_bytecode
    with tempfile.TemporaryDirectory(prefix="koaryu-bootstrap-cache-") as directory:
        try:
            sys.pycache_prefix = directory
            sys.dont_write_bytecode = True
            yield
        finally:
            sys.pycache_prefix = previous_prefix
            sys.dont_write_bytecode = previous_write


class Runtime:
    """Deferred application dependencies; tests use synthetic files and owned fake clients."""

    def __init__(self):
        backend = str(CANONICAL_ROOT / "backend")
        if backend not in sys.path:
            sys.path.insert(0, backend)
        from app.core.config import Settings, is_placeholder_value
        from app.db.supabase import close_supabase_client
        from app.services import generated_release_readiness as release
        from app.services.automation_email_credentials import CredentialCodec, CredentialRepository
        from app.services.release_schema_readiness import validate_release_schema_preflight

        self.settings_factory = Settings
        self.is_placeholder = is_placeholder_value
        self.codec = CredentialCodec
        self.repository = CredentialRepository
        self.close = close_supabase_client
        self.validate_preflight = validate_release_schema_preflight
        self.release = {
            "rpc": release.RELEASE_PREFLIGHT_RPC,
            "manifest_version": release.EXPECTED_RELEASE_MANIFEST_VERSION,
            "migration_count": release.EXPECTED_RELEASE_MIGRATION_COUNT,
            "migration_head": release.EXPECTED_RELEASE_MIGRATION_HEAD,
            "pending_versions": release.EXPECTED_RELEASE_PENDING_VERSIONS,
        }

    def settings(self):
        return self.settings_factory(_env_file=None)

    def client(self, settings):
        from postgrest.utils import SyncClient
        from supabase import create_client
        from supabase.lib.client_options import ClientOptions

        client = create_client(
            settings.SUPABASE_URL,
            settings.SUPABASE_SERVICE_ROLE_KEY,
            options=ClientOptions(
                postgrest_client_timeout=TIMEOUT,
                auto_refresh_token=False,
                persist_session=False,
            ),
        )
        try:
            # The pinned SDK does not expose a transport injection option. Replace
            # this owned session only, before any request; never patch global defaults.
            postgrest = client.postgrest
            original = postgrest.session
            headers = original.headers.copy()
            original.aclose()
            postgrest.session = SyncClient(
                base_url=settings.SUPABASE_URL + "/rest/v1",
                headers=headers,
                timeout=TIMEOUT,
                trust_env=False,
                follow_redirects=False,
            )
            return client
        except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
            self.close(client)
            raise BootstrapError("target_client_unavailable") from None

    def readiness(self, environment: str, candidate: str):
        import httpx

        url = TARGETS[environment][1]
        try:
            with httpx.Client(timeout=TIMEOUT, trust_env=False, follow_redirects=False) as client:  # noqa: SIM117
                with client.stream("GET", url) as response:
                    if response.status_code != 200:
                        raise BootstrapError("served_readiness_unverified")
                    content = bytearray()
                    for chunk in response.iter_bytes(chunk_size=8192):
                        content.extend(chunk)
                        if len(content) > MAX_READINESS_BYTES:
                            raise BootstrapError("served_readiness_unverified")
            row = json.loads(content)
            validate_readiness(row, environment, candidate)
        except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
            raise BootstrapError("served_readiness_unverified") from None


def validate_readiness(row: Any, environment: str, candidate: str) -> None:
    expected = {
        "status": "ready",
        "service": "koaryu-api",
        "environment": environment,
        "commit_sha": candidate,
        "configured_stripe_mode": TARGETS[environment][2],
    }
    if not isinstance(row, dict) or any(row.get(key) != value for key, value in expected.items()):
        raise BootstrapError("served_readiness_unverified")


def checked_settings(runtime, environment):
    try:
        settings = runtime.settings()
        settings.validate_supabase_service_role_configuration()
        settings.validate_automation_email_configuration()
        if (
            settings.ENVIRONMENT != environment
            or settings.SUPABASE_URL != f"https://{TARGETS[environment][0]}.supabase.co"
            or settings.STRIPE_MODE != TARGETS[environment][2]
            or settings.EMAIL_SEND_ENABLED is not False
            or settings.AUTOMATION_WORKER_ENABLED is not False
            or settings.EMAIL_ALLOWED_RECIPIENTS != MAILBOX
            or settings.EMAIL_PROVIDER not in {"disabled", "microsoft_graph"}
            or settings.EMAIL_GRAPH_CLIENT_ID != CLIENT_ID
            or settings.EMAIL_FROM_ADDRESS != MAILBOX
            or settings.EMAIL_GRAPH_TENANT != "consumers"
            or runtime.is_placeholder(settings.EMAIL_GRAPH_CLIENT_SECRET)
            or not 16 <= len(settings.EMAIL_GRAPH_CLIENT_SECRET) <= 4096
        ):
            raise BootstrapError("target_configuration_invalid")
        runtime.codec(settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, MAILBOX)
        return settings
    except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
        raise BootstrapError("target_configuration_invalid") from None


def read_source(args, runtime, roots):
    raw, identity = read_private_file(args.source_state, roots, MAX_SOURCE_BYTES)
    key_raw, key_identity = read_private_file(args.source_key_file, roots, 128)
    if (identity["device"], identity["inode"]) == (key_identity["device"], key_identity["inode"]):
        raise BootstrapError("source_key_alias")
    try:
        envelope = json.loads(raw, object_pairs_hook=_unique_object)
        if (
            not isinstance(envelope, dict)
            or set(envelope) != {"provider_key", "revision", "encrypted_credentials"}
            or envelope["provider_key"] != PROVIDER_KEY
            or type(envelope["revision"]) is not int
            or envelope["revision"] < 2
            or not isinstance(envelope["encrypted_credentials"], str)
            or not 1 <= len(envelope["encrypted_credentials"]) <= 131072
        ):
            raise BootstrapError("source_envelope_invalid")
        key = key_raw.decode("ascii").removesuffix("\n")
        # Fernet accepts some malformed base64 padding; require the canonical key shape.
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}=", key):
            raise BootstrapError("source_key_invalid")
        state = runtime.codec(key, CLIENT_ID, MAILBOX).decrypt(envelope["encrypted_credentials"])
        metadata = {
            "ciphertext_sha256": _sha(envelope["encrypted_credentials"].encode("ascii")),
            "envelope_sha256": _sha(raw),
            "revision": envelope["revision"],
            "file_identity": identity,
            "key_file_identity": key_identity,
            "key_sha256": _sha(key.encode("ascii")),
        }
        return state, metadata
    except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
        raise BootstrapError("source_credentials_invalid") from None


@contextmanager
def prepared(args, runtime, roots):
    settings = checked_settings(runtime, args.environment)
    state, source_metadata = read_source(args, runtime, roots)
    runtime.readiness(args.environment, args.candidate_sha)
    client = None
    try:
        client = runtime.client(settings)
        try:
            row = client.rpc(runtime.release["rpc"], {}).execute().data
            if isinstance(row, list) and len(row) == 1:
                row = row[0]
            runtime.validate_preflight(row)
        except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
            raise BootstrapError("database_readiness_unverified") from None
        repository = runtime.repository(
            client, runtime.codec(settings.EMAIL_TOKEN_ENCRYPTION_KEY, CLIENT_ID, MAILBOX)
        )
        try:
            current = repository.load()
            if current.revision != 0 or current.state is not None:
                raise BootstrapError("target_not_empty")
        except BootstrapError:
            raise
        except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
            raise BootstrapError("target_empty_state_unverified") from None
        plan = {
            "action": "initial_automation_email_credential_import",
            "environment": args.environment,
            "project": TARGETS[args.environment][0],
            "candidate_sha": args.candidate_sha,
            "provider_key": PROVIDER_KEY,
            "sender": MAILBOX,
            "client_id": CLIENT_ID,
            "tenant": "consumers",
            "source": source_metadata,
            "release": runtime.release,
            "target_key_sha256": _sha(settings.EMAIL_TOKEN_ENCRYPTION_KEY.encode("ascii")),
            "target_secret_sha256": _sha(settings.EMAIL_GRAPH_CLIENT_SECRET.encode("ascii")),
            "provider": settings.EMAIL_PROVIDER,
            "expected_revision": 0,
            "messages_sent": 0,
        }
        fingerprint = _sha(_json(plan).encode())
        plan["fingerprint"] = fingerprint
        plan["confirmation"] = (
            f"IMPORT {args.environment} {TARGETS[args.environment][0]} {fingerprint}"
        )
        yield plan, state, repository
    finally:
        if client is not None:
            try:
                runtime.close(client)
            except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
                raise BootstrapError("client_cleanup_failed") from None


def build_parser():
    class SafeParser(argparse.ArgumentParser):
        def error(self, message):
            self.exit(2, "Invalid bootstrap arguments. Use --help.\n")

    parser = SafeParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--environment", choices=tuple(TARGETS), required=True)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--source-state", required=True)
    parser.add_argument("--source-key-file", required=True)
    parser.add_argument("--execute", action="store_true")
    return parser


def run(args, *, runtime=None, checkout=None, stdin=None, stdout=None, stderr=None):
    """Dependencies are injectable for offline tests, never through CLI flags."""
    stdin, stdout, stderr = stdin or sys.stdin, stdout or sys.stdout, stderr or sys.stderr
    checkout = checkout or validate_checkout
    plan = None
    attempted = False
    verified = False
    imports = ExitStack()

    def emit(outcome, *, error=None):
        record = {
            "action": "initial_automation_email_credential_import",
            "outcome": outcome,
            "time_utc": datetime.now(UTC).isoformat(),
            "candidate_sha": args.candidate_sha
            if re.fullmatch(r"[0-9a-f]{40}", args.candidate_sha)
            else None,
            "project": TARGETS[args.environment][0],
            "fingerprint": plan["fingerprint"] if plan else None,
            "messages_sent": 0,
        }
        if error:
            record["error"] = error
        print(_json(record), file=stdout)

    try:
        roots = checkout(args.candidate_sha)
        imports.enter_context(isolated_bytecode())
        runtime = runtime or Runtime()
        if args.execute and not all(stream.isatty() for stream in (stdin, stdout, stderr)):
            raise BootstrapError("terminal_required")
        if args.environment == "production":
            print(
                _json(
                    {
                        "notice": "Production execution requires explicit new owner authorization for this initial bootstrap; migration approval does not authorize it."
                    }
                ),
                file=stdout,
            )
        with prepared(args, runtime, roots) as (plan, _state, _repository):
            print(_json({"outcome": "inspect", "plan": plan}), file=stdout)
        if not args.execute:
            emit("inspected")
            return 0
        print("Type the exact confirmation phrase:", file=stderr, flush=True)
        phrase = stdin.readline(512)
        if phrase.removesuffix("\n") != plan["confirmation"]:
            raise BootstrapError("confirmation_mismatch")
        roots = checkout(args.candidate_sha)
        with prepared(args, runtime, roots) as (fresh, state, repository):
            if fresh != plan:
                raise BootstrapError("confirmed_state_changed")
            attempted = True
            try:
                repository.save(state, expected_revision=0)
            except Exception as exc:  # noqa: BLE001 - Provider errors can include credentials.
                from app.services.automation_email_credentials import CredentialConflict

                if isinstance(exc, CredentialConflict):
                    attempted = False
                    raise BootstrapError("credential_conflict") from None
                raise BootstrapError("write_state_unverified") from None
            try:
                observed = repository.load()
                if observed.revision != 1 or observed.state != state:
                    raise BootstrapError("readback_mismatch")
            except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
                raise BootstrapError("write_state_unverified") from None
            verified = True
        emit("imported")
        return 0
    except (Exception, KeyboardInterrupt) as exc:  # noqa: BLE001 - Safe operator boundary.
        outcome = "write_state_unverified" if attempted else "refused"
        if verified:
            outcome = "import_verified_cleanup_failed"
        error = str(exc) if isinstance(exc, BootstrapError) else "operation_failed"
        emit(outcome, error=error)
        return 1
    finally:
        try:
            imports.close()
        except Exception:  # noqa: BLE001 - Never expose provider or private-file exceptions.
            # Temporary cache cleanup must not leak a filesystem exception after
            # a completed operation. No credential data is stored in that directory.
            print(_json({"warning": "temporary_cache_cleanup_failed"}), file=stderr)


def main(argv=None):
    # --help exits before checkout or dependency loading. Parse errors intentionally
    # omit argv values so accidentally supplied private material is not echoed.
    parser = build_parser()
    args = parser.parse_args(argv)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
