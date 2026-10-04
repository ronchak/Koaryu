"""Offline operator proofs. All keys, tokens, files, clients, and responses are synthetic."""

import hashlib
import importlib.util
import io
import json
import os
import py_compile
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from cryptography.fernet import Fernet

from app.core.config import Settings
from app.services.automation_email_credentials import CredentialCodec, CredentialState
from scripts import bootstrap_automation_email as bootstrap

SHA = "a" * 40
SOURCE_REFRESH = "synthetic-refresh-token-for-bootstrap"
SOURCE_ACCESS = "synthetic-access-token-for-bootstrap"
APP_SECRET = "synthetic-mail-app-secret"


class Terminal(io.StringIO):
    terminal = True

    def isatty(self):
        return self.terminal


class Database:
    def __init__(self, release):
        self.release = release
        self.row = {
            "provider_key": bootstrap.PROVIDER_KEY,
            "revision": 0,
            "encrypted_credentials": None,
        }
        self.calls = []
        self.preflight = None
        self.on_call = None

    def rpc(self, name, params):
        def execute():
            self.calls.append((name, params))
            if self.on_call:
                overridden = self.on_call(name, params)
                if overridden is not None:
                    return SimpleNamespace(data=overridden)
            if name == self.release["rpc"]:
                return SimpleNamespace(
                    data=self.preflight
                    or {
                        "ready": True,
                        "migration_count": self.release["migration_count"],
                        "migration_head": self.release["migration_head"],
                        "manifest_version": self.release["manifest_version"],
                        "pending_versions": self.release["pending_versions"],
                        "security_failures": [],
                    }
                )
            if name == "save_automation_email_credential_v1":
                assert params["p_expected_revision"] == 0
                self.row = {
                    "provider_key": bootstrap.PROVIDER_KEY,
                    "revision": 1,
                    "encrypted_credentials": params["p_encrypted_credentials"],
                }
            else:
                assert name == "get_automation_email_credential_v1"
            return SimpleNamespace(data=self.row.copy())

        return SimpleNamespace(execute=execute)

    @property
    def writes(self):
        return [call for call in self.calls if call[0] == "save_automation_email_credential_v1"]


@pytest.fixture
def setup(tmp_path, monkeypatch):
    # Never use an environment file, cached settings, SDK network, or actual private paths.
    tmp_path = tmp_path.resolve()
    runtime = bootstrap.Runtime()
    source_key = Fernet.generate_key().decode()
    target_key = Fernet.generate_key().decode()
    settings = Settings(
        _env_file=None,
        ENVIRONMENT="staging",
        SUPABASE_URL=f"https://{bootstrap.TARGETS['staging'][0]}.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="synthetic.header.signature",
        EMAIL_GRAPH_CLIENT_ID=bootstrap.CLIENT_ID,
        EMAIL_GRAPH_CLIENT_SECRET=APP_SECRET,
        EMAIL_TOKEN_ENCRYPTION_KEY=target_key,
    )
    runtime.settings = lambda: settings
    state = CredentialState(
        bootstrap.CLIENT_ID, bootstrap.MAILBOX, SOURCE_REFRESH, SOURCE_ACCESS, 2000000000
    )
    ciphertext = CredentialCodec(source_key, bootstrap.CLIENT_ID, bootstrap.MAILBOX).encrypt(state)
    source = tmp_path / "rotated.json"
    source.write_text(
        json.dumps(
            {
                "provider_key": bootstrap.PROVIDER_KEY,
                "revision": 2,
                "encrypted_credentials": ciphertext,
            }
        )
    )
    key_path = tmp_path / "source.key"
    key_path.write_text(source_key + "\n")
    source.chmod(0o600)
    key_path.chmod(0o600)
    args = bootstrap.build_parser().parse_args(
        [
            "--environment",
            "staging",
            "--candidate-sha",
            SHA,
            "--source-state",
            str(source),
            "--source-key-file",
            str(key_path),
        ]
    )
    database = Database(runtime.release)
    runtime.client = lambda setting: database
    closed = []
    runtime.close = closed.append
    probes = []
    runtime.readiness = lambda environment, candidate: probes.append((environment, candidate))
    monkeypatch.setattr(httpx.Client, "send", lambda *a, **k: pytest.fail("Network is forbidden"))
    return SimpleNamespace(
        runtime=runtime,
        settings=settings,
        state=state,
        source=source,
        key_path=key_path,
        source_key=source_key,
        ciphertext=ciphertext,
        args=args,
        database=database,
        probes=probes,
        closed=closed,
        roots=(tmp_path / "repo",),
    )


def invoke(setup, *, execute=False, mutate=None, terminal=True, phrase=None, checkout=None):
    output, errors = Terminal(), Terminal()

    class Confirm(Terminal):
        def readline(self, limit=-1):
            plan = next(
                row["plan"]
                for row in map(json.loads, output.getvalue().splitlines())
                if "plan" in row
            )
            if mutate:
                mutate()
            return (phrase if phrase is not None else plan["confirmation"]) + "\n"

    terminal_input = Confirm()
    terminal_input.terminal = output.terminal = errors.terminal = terminal
    setup.args.execute = execute
    code = bootstrap.run(
        setup.args,
        runtime=setup.runtime,
        checkout=checkout or (lambda _: setup.roots),
        stdin=terminal_input,
        stdout=output,
        stderr=errors,
    )
    text = output.getvalue() + errors.getvalue()
    for secret in (
        SOURCE_REFRESH,
        SOURCE_ACCESS,
        APP_SECRET,
        setup.source_key,
        setup.ciphertext,
        setup.settings.EMAIL_TOKEN_ENCRYPTION_KEY,
    ):
        assert secret not in text
    return code, [json.loads(line) for line in output.getvalue().splitlines()], errors.getvalue()


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_inspect_is_deterministic_and_never_writes(setup, environment):
    setup.args.environment = setup.settings.ENVIRONMENT = environment
    setup.settings.SUPABASE_URL = f"https://{bootstrap.TARGETS[environment][0]}.supabase.co"
    setup.settings.STRIPE_MODE = bootstrap.TARGETS[environment][2]
    before = (setup.source.read_bytes(), setup.key_path.read_bytes())
    code, rows, _ = invoke(setup)
    assert code == 0
    plan = next(row["plan"] for row in rows if "plan" in row)
    assert plan["expected_revision"] == 0 and plan["messages_sent"] == 0
    assert plan["release"] == setup.runtime.release
    assert plan["source"]["revision"] == 2
    second = invoke(setup)[1]
    assert next(row["plan"] for row in second if "plan" in row) == plan
    assert not setup.database.writes
    assert before == (setup.source.read_bytes(), setup.key_path.read_bytes())
    assert setup.closed == [setup.database, setup.database]
    assert bool([row for row in rows if "notice" in row]) == (environment == "production")


def test_exact_confirmation_imports_once_reencrypts_and_reads_back(setup):
    code, rows, _ = invoke(setup, execute=True)
    assert code == 0 and rows[-1]["outcome"] == "imported"
    assert rows[-1]["messages_sent"] == 0
    assert len(setup.database.writes) == 1
    assert setup.database.row["encrypted_credentials"] != setup.ciphertext
    codec = CredentialCodec(
        setup.settings.EMAIL_TOKEN_ENCRYPTION_KEY, bootstrap.CLIENT_ID, bootstrap.MAILBOX
    )
    assert codec.decrypt(setup.database.row["encrypted_credentials"]) == setup.state
    assert len(setup.probes) == 2 and len(setup.closed) == 2
    assert [call[0] for call in setup.database.calls].count(setup.runtime.release["rpc"]) == 2
    assert setup.database.calls[-1][0] == "get_automation_email_credential_v1"


@pytest.mark.parametrize(
    "name,value",
    [
        ("ENVIRONMENT", "production"),
        ("SUPABASE_URL", "https://elsewhere.example"),
        ("STRIPE_MODE", "live"),
        ("EMAIL_SEND_ENABLED", True),
        ("AUTOMATION_WORKER_ENABLED", True),
        ("EMAIL_ALLOWED_RECIPIENTS", ""),
        ("EMAIL_FROM_ADDRESS", "other@outlook.com"),
        ("EMAIL_GRAPH_CLIENT_ID", "00000000-0000-0000-0000-000000000000"),
        ("EMAIL_GRAPH_TENANT", "common"),
        ("EMAIL_GRAPH_CLIENT_SECRET", ""),
        ("EMAIL_TOKEN_ENCRYPTION_KEY", "bad-key"),
        ("EMAIL_PROVIDER", "unsupported"),
    ],
)
def test_bad_settings_refuse_before_private_file_or_network(setup, monkeypatch, name, value):
    setattr(setup.settings, name, value)
    monkeypatch.setattr(bootstrap, "read_private_file", lambda *a: pytest.fail("private read"))
    code, rows, _ = invoke(setup)
    assert code == 1 and rows[-1]["error"] == "target_configuration_invalid"
    assert not setup.database.calls and not setup.probes


def test_fresh_settings_explicitly_disable_dotenv(setup):
    seen = []
    runtime = bootstrap.Runtime()
    runtime.settings_factory = lambda **kw: seen.append(kw) or setup.settings
    assert runtime.settings() is setup.settings
    assert seen == [{"_env_file": None}]


@pytest.mark.parametrize(
    "field,value",
    [
        ("provider_key", "other"),
        ("revision", 1),
        ("revision", True),
        ("revision", "2"),
        ("encrypted_credentials", ""),
        ("encrypted_credentials", "broken"),
        ("extra", "not-allowed"),
    ],
)
def test_source_envelope_invalid(setup, field, value):
    source = json.loads(setup.source.read_text())
    source[field] = value
    setup.source.write_text(json.dumps(source))
    code, rows, _ = invoke(setup)
    assert code == 1 and rows[-1]["error"] == "source_credentials_invalid"
    assert not setup.database.calls and not setup.probes


@pytest.mark.parametrize("revision", [3, 400])
def test_accepts_latest_rotated_revision_not_only_two(setup, revision):
    source = json.loads(setup.source.read_text())
    source["revision"] = revision
    setup.source.write_text(json.dumps(source))
    assert invoke(setup)[0] == 0


@pytest.mark.parametrize(
    "change", [{"client_id": "different-app"}, {"mailbox": "different@outlook.com"}]
)
def test_source_identity_binding_mismatch(setup, change):
    state = replace(setup.state, **change)
    ciphertext = CredentialCodec(setup.source_key, state.client_id, state.mailbox).encrypt(state)
    setup.source.write_text(
        json.dumps(
            {
                "provider_key": bootstrap.PROVIDER_KEY,
                "revision": 2,
                "encrypted_credentials": ciphertext,
            }
        )
    )
    assert invoke(setup)[0] == 1 and not setup.database.calls


def test_wrong_source_key_and_duplicate_json_keys_refuse(setup):
    setup.key_path.write_text(Fernet.generate_key().decode())
    assert invoke(setup)[0] == 1
    setup.source.write_text('{"revision":2,"revision":3}')
    assert invoke(setup)[0] == 1


@pytest.mark.parametrize("mode", [0o644, 0o400, 0o700])
def test_permissions_must_be_exact_0600(setup, mode):
    setup.source.chmod(mode)
    assert invoke(setup)[0] == 1 and not setup.database.calls


def test_foreign_owner_refused(setup, monkeypatch):
    monkeypatch.setattr(bootstrap.os, "getuid", lambda: os.stat(setup.source).st_uid + 1)
    assert invoke(setup)[0] == 1 and not setup.database.calls


def test_symlink_leaf_and_component_refused(setup):
    link = setup.source.with_name("alias.json")
    link.symlink_to(setup.source)
    setup.args.source_state = str(link)
    assert invoke(setup)[0] == 1
    link.unlink()
    link.symlink_to(setup.source.parent, target_is_directory=True)
    setup.args.source_state = str(link / setup.source.name)
    assert invoke(setup)[0] == 1


def test_private_files_in_any_worktree_or_git_directory_refuse(setup):
    setup.roots = (setup.source.parent,)
    assert invoke(setup)[0] == 1
    setup.roots = ()
    (setup.source.parent / ".git").write_text("gitdir: synthetic")
    assert invoke(setup)[0] == 1


def test_source_and_key_alias_relative_paths_and_oversize_refuse(setup):
    setup.args.source_key_file = str(setup.source)
    assert invoke(setup)[0] == 1
    setup.args.source_key_file = str(setup.key_path)
    setup.args.source_state = "relative.json"
    assert invoke(setup)[0] == 1
    setup.args.source_state = str(setup.source)
    setup.source.write_bytes(b"x" * (bootstrap.MAX_SOURCE_BYTES + 1))
    assert invoke(setup)[0] == 1


def test_file_changed_while_reading_refuses(setup, monkeypatch):
    original = bootstrap.os.read
    changed = False

    def read(fd, size):
        nonlocal changed
        value = original(fd, size)
        if not changed:
            changed = True
            setup.source.write_text("changed")
        return value

    monkeypatch.setattr(bootstrap.os, "read", read)
    assert invoke(setup)[0] == 1 and not setup.probes


@pytest.mark.parametrize(
    "field,value",
    [
        ("status", "starting"),
        ("service", "other"),
        ("environment", "production"),
        ("commit_sha", "b" * 40),
        ("configured_stripe_mode", "live"),
    ],
)
def test_served_identity_requires_exact_current_contract(field, value):
    row = {
        "status": "ready",
        "service": "koaryu-api",
        "environment": "staging",
        "commit_sha": SHA,
        "configured_stripe_mode": "test",
    }
    bootstrap.validate_readiness(row, "staging", SHA)
    row[field] = value
    with pytest.raises(bootstrap.BootstrapError, match="served_readiness_unverified"):
        bootstrap.validate_readiness(row, "staging", SHA)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(302, headers={"location": "https://example.com"}),
        httpx.Response(200, content=b"x" * 33000),
        httpx.Response(200, json={"status": "ready"}),
    ],
)
def test_readiness_uses_fixed_credential_free_bounded_no_redirect_client(monkeypatch, response):
    original = httpx.Client
    created = []
    requests = []

    def factory(**kwargs):
        created.append(kwargs)

        def handle(request):
            requests.append(request)
            return response

        return original(**kwargs, transport=httpx.MockTransport(handle))

    monkeypatch.setattr(httpx, "Client", factory)
    with pytest.raises(bootstrap.BootstrapError):
        bootstrap.Runtime().readiness("staging", SHA)
    assert created == [
        {"timeout": bootstrap.TIMEOUT, "trust_env": False, "follow_redirects": False}
    ]
    assert len(requests) == 1 and str(requests[0].url) == bootstrap.TARGETS["staging"][1]
    assert "authorization" not in requests[0].headers


@pytest.mark.parametrize(
    "row",
    [
        {"provider_key": bootstrap.PROVIDER_KEY, "revision": 1, "encrypted_credentials": "broken"},
        {"provider_key": bootstrap.PROVIDER_KEY, "revision": 0, "encrypted_credentials": "broken"},
        {"provider_key": bootstrap.PROVIDER_KEY, "revision": True, "encrypted_credentials": None},
        {"provider_key": bootstrap.PROVIDER_KEY, "revision": 0},
    ],
)
def test_nonempty_or_malformed_target_refuses(setup, row):
    setup.database.row = row
    assert invoke(setup)[0] == 1 and not setup.database.writes


def test_generated_database_readiness_failure_is_sanitized(setup):
    setup.database.preflight = {"ready": False, "migration_head": SOURCE_REFRESH}
    code, rows, _ = invoke(setup)
    assert code == 1 and rows[-1]["error"] == "database_readiness_unverified"
    assert not setup.database.writes


@pytest.mark.parametrize(
    "terminal,phrase", [(False, None), (True, "wrong"), (True, "import staging")]
)
def test_terminal_and_exact_confirmation_required(setup, terminal, phrase):
    assert invoke(setup, execute=True, terminal=terminal, phrase=phrase)[0] == 1
    assert not setup.database.writes


@pytest.mark.parametrize("change", ["source", "key", "settings", "target", "readiness", "checkout"])
def test_state_changes_after_confirmation_never_write(setup, change):
    calls = []

    def checkout(candidate):
        calls.append(candidate)
        if change == "checkout" and len(calls) == 2:
            raise bootstrap.BootstrapError("candidate_mismatch")
        return setup.roots

    def mutate():
        if change == "source":
            setup.source.write_text(setup.source.read_text() + "\n")
        elif change == "key":
            setup.settings.EMAIL_TOKEN_ENCRYPTION_KEY = Fernet.generate_key().decode()
        elif change == "settings":
            setup.settings.EMAIL_SEND_ENABLED = True
        elif change == "target":
            setup.database.row["revision"] = 1
            setup.database.row["encrypted_credentials"] = setup.ciphertext
        elif change == "readiness":

            def fail(*args):
                raise bootstrap.BootstrapError("served_readiness_unverified")

            setup.runtime.readiness = fail

    assert invoke(setup, execute=True, mutate=mutate, checkout=checkout)[0] == 1
    assert not setup.database.writes


@pytest.mark.parametrize("error", ["conflict", "timeout", "response", "readback"])
def test_single_write_attempt_no_retry_or_false_success(setup, error):
    class Conflict(Exception):
        code = "P0001"
        message = "AUTOMATION_EMAIL_CREDENTIAL_CONFLICT"

    def on_call(name, params):
        if name == "save_automation_email_credential_v1":
            if error == "conflict":
                raise Conflict(SOURCE_REFRESH)
            if error == "timeout":
                raise TimeoutError(SOURCE_REFRESH)
            if error == "response":
                return {"leak": SOURCE_REFRESH}
        if (
            name == "get_automation_email_credential_v1"
            and setup.database.writes
            and error == "readback"
        ):
            return {
                "provider_key": bootstrap.PROVIDER_KEY,
                "revision": 0,
                "encrypted_credentials": None,
            }

    setup.database.on_call = on_call
    code, rows, _ = invoke(setup, execute=True)
    assert code == 1 and rows[-1]["outcome"] != "imported"
    assert rows[-1]["outcome"] == ("refused" if error == "conflict" else "write_state_unverified")
    assert len(setup.database.writes) == 1


def test_checkout_guard_runs_before_dependency_imports_or_private_access(setup, monkeypatch):
    def refuse(candidate):
        raise bootstrap.BootstrapError("candidate_mismatch")

    monkeypatch.setattr(bootstrap, "Runtime", lambda: pytest.fail("premature app import"))
    monkeypatch.setattr(bootstrap, "read_private_file", lambda *a: pytest.fail("private read"))
    assert invoke(setup, checkout=refuse)[0] == 1


@pytest.fixture
def checkout_tree(tmp_path, monkeypatch):
    root = tmp_path.resolve() / "repo"
    script = root / bootstrap.SCRIPT
    script.parent.mkdir(parents=True)
    script.write_text("# reviewed script\n")
    app = root / "backend/app/config.py"
    app.parent.mkdir()
    app.write_text("# reviewed app\n")
    state = {"sha": SHA, "status": b""}

    def record(path):
        value = path.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(value)).encode() + b"\0" + value).hexdigest()
        return (
            b"100644 blob "
            + digest.encode()
            + b"\t"
            + path.relative_to(root).as_posix().encode()
            + b"\0"
        )

    tree = record(script) + record(app)

    def git(path, *args):
        assert path == root
        if args[:2] == ("rev-parse", "HEAD"):
            return state["sha"].encode()
        if args[0] == "status":
            return state["status"]
        if args[0] == "ls-tree":
            return tree
        if args[0] == "worktree":
            return (
                b"worktree "
                + str(root).encode()
                + b"\0worktree "
                + str(root.parent / "other").encode()
                + b"\0"
            )
        if args == ("rev-parse", "--git-common-dir"):
            return b".git\n"
        pytest.fail(str(args))

    monkeypatch.setattr(bootstrap, "CANONICAL_ROOT", root)
    monkeypatch.setattr(bootstrap, "__file__", str(script))
    monkeypatch.setattr(bootstrap, "_git", git)
    monkeypatch.chdir(root)
    return root, app, state


def test_checkout_allows_unrelated_dojo_and_venv_and_records_all_worktrees(checkout_tree):
    root, _, _ = checkout_tree
    (root / "scripts").mkdir()
    (root / "scripts/dojo.mjs").write_text("unrelated")
    (root / "backend/venv").mkdir()
    (root / "backend/venv/library.py").write_text("installed")
    roots = bootstrap.validate_checkout(SHA)
    assert root.parent / "other" in roots and root / ".git" in roots


@pytest.mark.parametrize("fault", ["cwd", "sha", "dirty", "bytes", "uppercase", "wrong_script"])
def test_checkout_refuses_wrong_or_dirty_candidate(checkout_tree, monkeypatch, fault):
    root, app, state = checkout_tree
    candidate = SHA
    if fault == "cwd":
        monkeypatch.chdir(root.parent)
    elif fault == "sha":
        state["sha"] = "b" * 40
    elif fault == "dirty":
        state["status"] = b" M docs/readme.md"
    elif fault == "bytes":
        app.write_text("# changed app\n")
    elif fault == "uppercase":
        candidate = SHA.upper()
    elif fault == "wrong_script":
        monkeypatch.setattr(bootstrap, "__file__", str(app))
    with pytest.raises(bootstrap.BootstrapError):
        bootstrap.validate_checkout(candidate)


@pytest.mark.parametrize(
    "name", ["app/extra.py", "scripts/extra.pyc", "other/__init__.py", "site.pth", "app/extra.so"]
)
def test_checkout_rejects_untracked_import_code_even_ignored(checkout_tree, name):
    root, _, _ = checkout_tree
    path = root / "backend" / name
    path.parent.mkdir(exist_ok=True)
    path.write_text("unreviewed")
    with pytest.raises(bootstrap.BootstrapError, match="untracked_import_code"):
        bootstrap.validate_checkout(SHA)


def test_normal_cache_is_bypassed_without_deletion(checkout_tree):
    _root, app, _ = checkout_tree
    app.write_text("value = 'source'\n")
    info = app.stat()
    app.write_text("value = 'poison'\n")
    cache = Path(py_compile.compile(str(app), doraise=True))
    app.write_text("value = 'source'\n")
    os.utime(app, ns=(info.st_atime_ns, info.st_mtime_ns))
    before = cache.read_bytes()
    previous = sys.pycache_prefix, sys.dont_write_bytecode
    with bootstrap.isolated_bytecode():
        spec = importlib.util.spec_from_file_location("synthetic_source", app)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert module.value == "source"
        assert not list(Path(sys.pycache_prefix).rglob("*.pyc"))
    assert previous == (sys.pycache_prefix, sys.dont_write_bytecode)
    assert cache.read_bytes() == before


def test_sdk_uses_owned_no_redirect_no_proxy_transport_and_closes(monkeypatch):
    runtime = bootstrap.Runtime()
    settings = Settings(
        _env_file=None,
        SUPABASE_URL="https://nxgsektqsgrtyfhawxbc.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY="synthetic.header.signature",
    )
    # Client construction and cleanup are local SDK actions; all actual requests fail.
    monkeypatch.setattr(httpx.Client, "send", lambda *a, **k: pytest.fail("unexpected request"))
    client = runtime.client(settings)
    session = client.postgrest.session
    assert session.follow_redirects is False
    assert session._trust_env is False
    assert str(session.base_url) == settings.SUPABASE_URL + "/rest/v1/"
    assert session.timeout.read == bootstrap.TIMEOUT
    assert client.options.auto_refresh_token is False
    runtime.close(client)
    assert session.is_closed


def test_help_and_parse_errors_need_no_guards_or_echo(monkeypatch, capsys):
    monkeypatch.setattr(bootstrap, "validate_checkout", lambda *a: pytest.fail("guard on help"))
    with pytest.raises(SystemExit) as result:
        bootstrap.main(["--help"])
    assert result.value.code == 0
    with pytest.raises(SystemExit):
        bootstrap.main(["--wrong", SOURCE_REFRESH])
    captured = capsys.readouterr()
    assert SOURCE_REFRESH not in captured.out + captured.err


def test_checkout_accepts_wrapper_backend_cwd(checkout_tree, monkeypatch):
    root, _, _ = checkout_tree
    monkeypatch.chdir(root / "backend")
    assert root in bootstrap.validate_checkout(SHA)


@pytest.mark.parametrize("name", ["httpx", "app/foreign", "app/venv"])
def test_checkout_rejects_untracked_symlink_import_directories(checkout_tree, name):
    root, _, _ = checkout_tree
    foreign = root.parent / "foreign"
    foreign.mkdir()
    (foreign / "__init__.py").write_text("unreviewed")
    (root / "backend" / name).symlink_to(foreign, target_is_directory=True)
    with pytest.raises(bootstrap.BootstrapError, match="untracked_import_directory"):
        bootstrap.validate_checkout(SHA)


def test_checkout_ignores_normal_cache_files(checkout_tree):
    root, _, _ = checkout_tree
    directory = root / "backend/app/__pycache__"
    directory.mkdir()
    (directory / "config.cpython-311.pyc").write_bytes(b"untrusted-bytecode")
    assert root in bootstrap.validate_checkout(SHA)


def test_stdlib_shadow_cannot_execute_before_checkout_guard(tmp_path):
    import subprocess

    directory = tmp_path.resolve() / "shadowed-scripts"
    directory.mkdir()
    script = directory / "bootstrap.py"
    script.write_text(Path(bootstrap.__file__).read_text())
    marker = directory / "SHADOW-EXECUTED"
    for module in ("json", "argparse", "__future__"):
        (directory / f"{module}.py").write_text(f"open({str(marker)!r}, 'w').write('bad')\n")
    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--environment",
            "staging",
            "--candidate-sha",
            SHA,
            "--source-state",
            str(directory / "absent-private-source"),
            "--source-key-file",
            str(directory / "absent-private-key"),
        ],
        cwd=directory,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
        env={key: value for key, value in os.environ.items() if not key.startswith("PYTHON")},
    )
    assert result.returncode == 1
    assert "canonical_candidate_required" in result.stdout
    assert not marker.exists() and not result.stderr


def test_cached_settings_never_used_and_no_dotenv_values(tmp_path, monkeypatch):
    import app.core.config

    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("EMAIL_GRAPH_CLIENT_SECRET=do-not-load-this-value\n")
    monkeypatch.setattr(
        app.core.config, "get_settings", lambda: pytest.fail("cached settings used")
    )
    runtime = bootstrap.Runtime()
    assert runtime.settings().EMAIL_GRAPH_CLIENT_SECRET == ""


def test_matching_existing_credentials_still_refuse_import(setup):
    codec = CredentialCodec(
        setup.settings.EMAIL_TOKEN_ENCRYPTION_KEY, bootstrap.CLIENT_ID, bootstrap.MAILBOX
    )
    setup.database.row = {
        "provider_key": bootstrap.PROVIDER_KEY,
        "revision": 1,
        "encrypted_credentials": codec.encrypt(setup.state),
    }
    code, rows, _ = invoke(setup, execute=True)
    assert code == 1 and rows[-1]["error"] == "target_not_empty"
    assert not setup.database.writes


def test_readback_different_plaintext_never_claims_success(setup):
    codec = CredentialCodec(
        setup.settings.EMAIL_TOKEN_ENCRYPTION_KEY, bootstrap.CLIENT_ID, bootstrap.MAILBOX
    )

    def on_call(name, params):
        if name == "get_automation_email_credential_v1" and setup.database.writes:
            return {
                "provider_key": bootstrap.PROVIDER_KEY,
                "revision": 1,
                "encrypted_credentials": codec.encrypt(
                    replace(setup.state, refresh_token="other-synthetic-refresh")
                ),
            }

    setup.database.on_call = on_call
    code, rows, _ = invoke(setup, execute=True)
    assert code == 1 and rows[-1]["outcome"] == "write_state_unverified"
    assert len(setup.database.writes) == 1


def test_opaque_provider_errors_have_no_secret_exception_text(setup):
    def unavailable(settings):
        raise RuntimeError(SOURCE_REFRESH + APP_SECRET)

    setup.runtime.client = unavailable
    code, rows, _ = invoke(setup)
    assert code == 1 and rows[-1]["error"] == "operation_failed"


def test_temporary_cleanup_failure_is_sanitized_after_result(setup, monkeypatch):
    original = bootstrap.tempfile.TemporaryDirectory

    class FailedCleanup(original):
        def __exit__(self, *args):
            super().__exit__(*args)
            raise RuntimeError(SOURCE_REFRESH)

    monkeypatch.setattr(bootstrap.tempfile, "TemporaryDirectory", FailedCleanup)
    code, rows, errors = invoke(setup)
    assert code == 0 and rows[-1]["outcome"] == "inspected"
    assert json.loads(errors)["warning"] == "temporary_cache_cleanup_failed"


def test_importing_helper_does_not_mutate_sys_path():
    before = sys.path.copy()
    spec = importlib.util.spec_from_file_location("synthetic_bootstrap", bootstrap.__file__)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert sys.path == before
