#!/usr/bin/env python3
"""Run one pinned provider adapter without forwarding unrelated environment or FDs."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from recovery_tooling import (
    BACKUP_MANIFEST_NAME,
    PROVIDER_RECEIPT_NAME,
    REQUIRED_ENCRYPTED_ARTIFACTS,
    RecoveryToolingError,
    load_json,
    validate_provider_receipt,
)


ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_TRUST_POLICY = ROOT_DIR / "config/recovery/approved-provider-adapters.json"
PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$")
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
EXPECTED_DOWNLOAD_NAMES = set(REQUIRED_ENCRYPTED_ARTIFACTS) | {
    BACKUP_MANIFEST_NAME,
    PROVIDER_RECEIPT_NAME,
}
ADAPTER_TIMEOUT_SECONDS = 30 * 60
RESERVED_ENVIRONMENT_VARIABLES = {
    "CDPATH",
    "CLASSPATH",
    "ENV",
    "IFS",
    "KSH_ENV",
    "LANG",
    "LC_ALL",
    "PATH",
    "PHPRC",
    "PROMPT_COMMAND",
    "PS4",
    "SHELLOPTS",
    "TCLLIBPATH",
    "ZDOTDIR",
}
RESERVED_ENVIRONMENT_PREFIXES = (
    "BASH_",
    "BUNDLE_",
    "CARGO_",
    "DOTNET_",
    "DYLD_",
    "GEM_",
    "GIT_",
    "GPG_",
    "JAVA_",
    "JDK_",
    "LD_",
    "LUA_",
    "NODE_",
    "NPM_",
    "PERL",
    "PHP_",
    "PYTHON",
    "RUBY",
    "RUST",
    "SSH_",
    "YARN_",
)


def _is_reserved_environment_variable(name: str) -> bool:
    return name in RESERVED_ENVIRONMENT_VARIABLES or name.startswith(
        RESERVED_ENVIRONMENT_PREFIXES
    )


def _validate_policy(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"schema_version", "adapters"}:
        raise RecoveryToolingError("Approved provider-adapter policy is malformed")
    if value["schema_version"] != 1 or not isinstance(value["adapters"], list):
        raise RecoveryToolingError("Approved provider-adapter policy version is unsupported")
    profiles: dict[str, dict] = {}
    required = {
        "profile_id",
        "provider",
        "locator_scheme",
        "adapter_sha256",
        "allowed_environment_variables",
    }
    for raw in value["adapters"]:
        if not isinstance(raw, dict) or set(raw) != required:
            raise RecoveryToolingError("Approved provider-adapter profile is malformed")
        profile_id = raw["profile_id"]
        if not isinstance(profile_id, str) or not PROFILE_ID_RE.fullmatch(profile_id) or profile_id in profiles:
            raise RecoveryToolingError("Approved provider-adapter profile ids must be unique")
        if (
            not isinstance(raw["provider"], str)
            or not PROFILE_ID_RE.fullmatch(raw["provider"])
            or raw["provider"].lower() in {"file", "filesystem", "local", "local-copy", "synced-folder"}
        ):
            raise RecoveryToolingError("Approved provider id is unsafe")
        if (
            not isinstance(raw["locator_scheme"], str)
            or not re.fullmatch(r"[a-z][a-z0-9+.-]{1,31}", raw["locator_scheme"])
            or raw["locator_scheme"] in {"file", "http", "https"}
        ):
            raise RecoveryToolingError("Approved provider locator scheme is unsafe")
        if not isinstance(raw["adapter_sha256"], str) or not SHA256_RE.fullmatch(raw["adapter_sha256"]):
            raise RecoveryToolingError("Approved provider adapter digest is malformed")
        allowed = raw["allowed_environment_variables"]
        if (
            not isinstance(allowed, list)
            or len(allowed) != len(set(allowed))
            or not all(isinstance(name, str) and ENV_NAME_RE.fullmatch(name) for name in allowed)
            or any(_is_reserved_environment_variable(name) for name in allowed)
        ):
            raise RecoveryToolingError("Approved provider environment allow-list is malformed")
        profiles[profile_id] = raw
    return profiles


def _open_pinned_adapter(path: Path, expected_sha256: str) -> int:
    if not path.is_absolute():
        raise RecoveryToolingError("Provider adapter path must be absolute")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        details = os.fstat(descriptor)
    except OSError as exc:
        raise RecoveryToolingError("Approved provider adapter could not be opened") from exc
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_nlink != 1
        or stat.S_IMODE(details.st_mode) & 0o022
        or not stat.S_IMODE(details.st_mode) & 0o100
    ):
        os.close(descriptor)
        raise RecoveryToolingError(
            "Approved provider adapter must be a singly linked owner-executable that is not group- or world-writable"
        )
    digest = hashlib.sha256()
    with os.fdopen(os.dup(descriptor), "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if f"sha256:{digest.hexdigest()}" != expected_sha256:
        os.close(descriptor)
        raise RecoveryToolingError("Provider adapter bytes do not match the reviewed digest")
    return descriptor


def _materialize_held_adapter(
    descriptor: int,
    parent: Path,
    expected_sha256: str,
) -> tuple[Path, Path]:
    """Copy reviewed bytes into a private executable snapshot for platforms without fexecve."""
    before = os.fstat(descriptor)
    directory = Path(tempfile.mkdtemp(prefix=".koaryu-provider-exec-", dir=parent))
    os.chmod(directory, 0o700)
    executable = directory / "adapter"
    completed = False
    try:
        output_fd = os.open(
            executable,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o500,
        )
        digest = hashlib.sha256()
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    count = os.write(output_fd, view)
                    view = view[count:]
            os.fsync(output_fd)
        finally:
            os.close(output_fd)
        after = os.fstat(descriptor)
        if (
            (before.st_dev, before.st_ino, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            != (after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        ):
            raise RecoveryToolingError("Reviewed provider adapter changed while it was snapshotted")
        if f"sha256:{digest.hexdigest()}" != expected_sha256:
            raise RecoveryToolingError("Snapshotted provider adapter bytes do not match the reviewed digest")
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        completed = True
        return executable, directory
    finally:
        if not completed:
            shutil.rmtree(directory, ignore_errors=True)


def _parse_locator(locator: str, profile: dict) -> tuple[str, str]:
    if not isinstance(locator, str) or len(locator) > 1024 or locator != locator.strip():
        raise RecoveryToolingError("Provider locator is malformed")
    parsed = urlsplit(locator)
    if (
        parsed.scheme.lower() != parsed.scheme
        or parsed.scheme != profile["locator_scheme"]
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise RecoveryToolingError("Provider locator does not match the reviewed profile")
    container_id = parsed.netloc
    object_set_id = parsed.path.removeprefix("/")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", container_id)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}", object_set_id)
        or any(part in {"", ".", ".."} for part in object_set_id.split("/"))
    ):
        raise RecoveryToolingError("Provider locator identifiers are malformed")
    return container_id, object_set_id


def _exact_private_inventory(path: Path) -> None:
    try:
        entries = list(path.iterdir())
    except OSError as exc:
        raise RecoveryToolingError("Provider adapter output could not be inventoried") from exc
    if {entry.name for entry in entries} != EXPECTED_DOWNLOAD_NAMES:
        raise RecoveryToolingError("Provider adapter output is not the exact canonical download set")
    for entry in entries:
        try:
            details = entry.lstat()
        except OSError as exc:
            raise RecoveryToolingError("Provider adapter output could not be inspected") from exc
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_nlink != 1
            or details.st_size < 1
            or stat.S_IMODE(details.st_mode) & 0o077
        ):
            raise RecoveryToolingError("Provider adapter output must be private singly linked regular files")


def _copy_locked_snapshot(source: Path, destination: Path) -> None:
    parent_fd: int | None = None
    source_fd: int | None = None
    destination_fd: int | None = None
    held: dict[str, tuple[int, os.stat_result]] = {}
    published = False
    completed = False
    try:
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        parent_fd = os.open(destination.parent, directory_flags)
        os.mkdir(destination.name, 0o700, dir_fd=parent_fd)
        published = True
        destination_fd = os.open(destination.name, directory_flags, dir_fd=parent_fd)
        destination_before = os.fstat(destination_fd)
        source_fd = os.open(source, directory_flags)
        if set(os.listdir(source_fd)) != EXPECTED_DOWNLOAD_NAMES:
            raise RecoveryToolingError("Provider output changed before snapshotting")
        for name in sorted(EXPECTED_DOWNLOAD_NAMES):
            input_fd = os.open(
                name,
                os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=source_fd,
            )
            before = os.fstat(input_fd)
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_size < 1
                or stat.S_IMODE(before.st_mode) & 0o077
            ):
                os.close(input_fd)
                raise RecoveryToolingError("Provider output changed during snapshotting")
            held[name] = (input_fd, before)

        for name in sorted(EXPECTED_DOWNLOAD_NAMES):
            input_fd, before = held[name]
            os.lseek(input_fd, 0, os.SEEK_SET)
            output_fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
                0o600,
                dir_fd=destination_fd,
            )
            try:
                while True:
                    chunk = os.read(input_fd, 1024 * 1024)
                    if not chunk:
                        break
                    view = memoryview(chunk)
                    while view:
                        count = os.write(output_fd, view)
                        view = view[count:]
                os.fsync(output_fd)
            finally:
                os.close(output_fd)
            after = os.fstat(input_fd)
            if (
                (before.st_dev, before.st_ino, before.st_nlink, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_dev, after.st_ino, after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            ):
                raise RecoveryToolingError("Provider output changed during snapshotting")

        if set(os.listdir(source_fd)) != EXPECTED_DOWNLOAD_NAMES:
            raise RecoveryToolingError("Provider output inventory changed during snapshotting")
        for name, (input_fd, before) in held.items():
            current = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
                raise RecoveryToolingError("Provider output identity changed during snapshotting")
        if set(os.listdir(destination_fd)) != EXPECTED_DOWNLOAD_NAMES:
            raise RecoveryToolingError("Published provider snapshot inventory is incomplete")
        current_destination = os.stat(destination.name, dir_fd=parent_fd, follow_symlinks=False)
        if (current_destination.st_dev, current_destination.st_ino) != (
            destination_before.st_dev,
            destination_before.st_ino,
        ):
            raise RecoveryToolingError("Provider snapshot destination identity changed")
        os.fsync(destination_fd)
        os.fsync(parent_fd)
        completed = True
    except OSError as exc:
        raise RecoveryToolingError("Provider output could not be copied safely") from exc
    finally:
        for input_fd, _ in held.values():
            os.close(input_fd)
        if source_fd is not None:
            os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
        if parent_fd is not None:
            os.close(parent_fd)
        if published and not completed and destination.exists() and not destination.is_symlink():
            shutil.rmtree(destination, ignore_errors=True)


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    for termination_signal in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, termination_signal)
        except ProcessLookupError:
            return


def run_download(
    args: argparse.Namespace,
    *,
    trust_policy: Path = DEFAULT_TRUST_POLICY,
) -> None:
    policy = load_json(trust_policy)
    profiles = _validate_policy(policy)
    profile = profiles.get(args.profile)
    if profile is None:
        raise RecoveryToolingError(
            "No reviewed provider adapter profile is approved; add one in a reviewed repository change"
        )
    container_id, object_set_id = _parse_locator(args.locator, profile)
    if args.destination.exists() or args.destination.is_symlink() or not args.destination.is_absolute():
        raise RecoveryToolingError("Provider download destination must be a new absolute path")
    if not args.destination.parent.is_dir() or args.destination.parent.is_symlink():
        raise RecoveryToolingError("Provider download destination parent is unsafe")
    try:
        canonical_destination = args.destination.parent.resolve(strict=True) / args.destination.name
    except OSError as exc:
        raise RecoveryToolingError("Provider download destination parent is unsafe") from exc
    args.destination = canonical_destination
    adapter_fd = _open_pinned_adapter(args.provider_command, profile["adapter_sha256"])
    adapter_snapshot_dir: Path | None = None
    stage: Path | None = None
    process: subprocess.Popen[bytes] | None = None
    destination_published = False
    download_succeeded = False
    try:
        adapter_executable, adapter_snapshot_dir = _materialize_held_adapter(
            adapter_fd,
            args.destination.parent,
            profile["adapter_sha256"],
        )
        stage = Path(tempfile.mkdtemp(prefix=f".{args.destination.name}.provider-", dir=args.destination.parent))
        os.chmod(stage, 0o700)
        receipt_path = stage / PROVIDER_RECEIPT_NAME
        environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "LANG": "C"}
        for name in profile["allowed_environment_variables"]:
            if name not in os.environ:
                raise RecoveryToolingError("An approved provider adapter environment value is missing")
            environment[name] = os.environ[name]
        process = subprocess.Popen(
            [
                str(adapter_executable),
                "download",
                "--locator", args.locator,
                "--destination", str(stage),
                "--receipt", str(receipt_path),
            ],
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            cwd=adapter_snapshot_dir,
            umask=0o077,
            start_new_session=True,
        )
        try:
            return_code = process.wait(timeout=ADAPTER_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as exc:
            _terminate_process_group(process)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise RecoveryToolingError("Approved provider adapter exceeded its runtime limit") from exc
        _terminate_process_group(process)
        if return_code != 0:
            raise RecoveryToolingError("Approved provider adapter failed; output was suppressed")
        for entry in stage.iterdir():
            if entry.is_file() and not entry.is_symlink():
                os.chmod(entry, 0o600)
        _exact_private_inventory(stage)
        receipt = validate_provider_receipt(load_json(receipt_path, require_private=True))
        if (
            receipt["provider"] != profile["provider"]
            or receipt["container_id"] != container_id
            or receipt["object_set_id"] != object_set_id
        ):
            raise RecoveryToolingError("Provider receipt is not bound to the reviewed locator profile")
        _copy_locked_snapshot(stage, args.destination)
        destination_published = True
        published_receipt = validate_provider_receipt(
            load_json(args.destination / PROVIDER_RECEIPT_NAME, require_private=True)
        )
        if published_receipt != receipt:
            raise RecoveryToolingError("Published provider receipt changed during snapshotting")
        download_succeeded = True
    except OSError as exc:
        raise RecoveryToolingError("Approved provider adapter could not be executed safely") from exc
    finally:
        if process is not None:
            _terminate_process_group(process)
        os.close(adapter_fd)
        if adapter_snapshot_dir is not None:
            shutil.rmtree(adapter_snapshot_dir, ignore_errors=True)
        if stage is not None:
            shutil.rmtree(stage, ignore_errors=True)
        if (
            destination_published
            and not download_succeeded
            and args.destination.exists()
            and not args.destination.is_symlink()
        ):
            shutil.rmtree(args.destination, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--provider-command", type=Path, required=True)
    parser.add_argument("--locator", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    try:
        run_download(parse_args())
        print("Approved provider adapter completed a locked candidate download; origin remains unproven.")
        return 0
    except RecoveryToolingError as exc:
        print(f"Provider download refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
