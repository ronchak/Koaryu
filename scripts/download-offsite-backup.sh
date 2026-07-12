#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_SCRIPT="$ROOT_DIR/scripts/verify-backup-set.py"
PROVIDER_RUNNER="$ROOT_DIR/scripts/run-approved-provider-download.py"
DEFAULT_POLICY="$ROOT_DIR/config/recovery/production-data-classification-policy.json"

provider_command=""
provider_profile=""
provider_locator=""
destination=""
known_local_source=""
expected_manifest_sha256=""
classification_policy="$DEFAULT_POLICY"
passphrase_fd=""
download_complete=false

usage() {
  echo "Usage: scripts/download-offsite-backup.sh --provider-profile REVIEWED_ID --provider-command /absolute/adapter --provider-locator provider://container/object-set --destination /new/locked/path --known-local-source /original/path --expected-manifest-sha256 sha256:... --passphrase-fd N [--classification-policy FILE]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider-command)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      provider_command="$2"
      shift 2
      ;;
    --provider-profile)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      provider_profile="$2"
      shift 2
      ;;
    --provider-locator)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      provider_locator="$2"
      shift 2
      ;;
    --destination)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      destination="$2"
      shift 2
      ;;
    --known-local-source)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      known_local_source="$2"
      shift 2
      ;;
    --expected-manifest-sha256)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      expected_manifest_sha256="$2"
      shift 2
      ;;
    --passphrase-fd)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      passphrase_fd="$2"
      shift 2
      ;;
    --classification-policy)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      classification_policy="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ "$provider_command" = /* && -x "$provider_command" && ! -L "$provider_command" ]] || {
  echo "Refusing: provider command must be an absolute non-symlink executable adapter path." >&2
  exit 2
}
[[ "$provider_profile" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$ ]] || {
  echo "Refusing: provider profile id is malformed." >&2
  exit 2
}
[[ -n "$provider_locator" && "$provider_locator" != /* ]] || {
  echo "Refusing: provider locator must be a non-local provider object-set identifier." >&2
  exit 2
}
case "$provider_locator" in
  [Ff][Ii][Ll][Ee]:*|[Hh][Tt][Tt][Pp]:*|[Hh][Tt][Tt][Pp][Ss]:*|*\?*|*\#*|*@*|*$'\n'*|*$'\r'*)
    echo "Refusing: provider locator is local, credential-bearing, or malformed." >&2
    exit 2
    ;;
esac
[[ "$provider_locator" =~ ^[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._:-]+(/[A-Za-z0-9._~:+-]+)*$ ]] || {
  echo "Refusing: provider locator must use a bounded credential-free provider URI." >&2
  exit 2
}
locator_path="${provider_locator#*://}"
case "/$locator_path/" in
  */../*|*/./*)
    echo "Refusing: provider locator contains a relative path segment." >&2
    exit 2
    ;;
esac
[[ "$destination" = /* && ! -e "$destination" && ! -L "$destination" ]] || {
  echo "Refusing: destination must be a new absolute path." >&2
  exit 2
}
[[ "$known_local_source" = /* && -d "$known_local_source" && ! -L "$known_local_source" ]] || {
  echo "Refusing: known local source must be an existing absolute non-symlink directory." >&2
  exit 2
}
destination_parent="$(dirname "$destination")"
destination_name="$(basename "$destination")"
[[ -d "$destination_parent" && ! -L "$destination_parent" && "$destination_name" != "." && "$destination_name" != ".." ]] || {
  echo "Refusing: destination parent must be an existing non-symlink directory." >&2
  exit 2
}
destination="$(cd "$destination_parent" && pwd -P)/$destination_name"
known_local_source="$(cd "$known_local_source" && pwd -P)"
case "$destination/" in
  "$known_local_source/"*)
    echo "Refusing: destination must not be the known local source or one of its descendants." >&2
    exit 2
    ;;
esac
[[ "$expected_manifest_sha256" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "Refusing: expected manifest digest must be a prefixed SHA-256 value." >&2
  exit 2
}
[[ "$passphrase_fd" =~ ^[0-9]+$ && -r "/dev/fd/$passphrase_fd" ]] || {
  echo "Refusing: passphrase file descriptor is not readable." >&2
  exit 2
}
[[ -f "$classification_policy" && ! -L "$classification_policy" ]] || {
  echo "Refusing: classification policy is unavailable." >&2
  exit 2
}

cleanup() {
  if [[ "$download_complete" != true && -n "$destination" && -d "$destination" ]]; then
    rm -rf -- "$destination"
  fi
}
trap cleanup EXIT HUP INT TERM

receipt="$destination/provider-download-receipt.json"

# The Python boundary pins the reviewed adapter digest, passes only an explicit
# environment allow-list, inherits no unrelated descriptors (including the
# recovery-key descriptor), kills same-process-group leftovers, and publishes a
# held-file snapshot only after an exact inventory check.
if ! python3 "$PROVIDER_RUNNER" \
  --profile "$provider_profile" \
  --provider-command "$provider_command" \
  --locator "$provider_locator" \
  --destination "$destination" \
  >/dev/null 2>&1; then
  echo "Provider download refused or failed; the reviewed runner suppressed adapter output." >&2
  exit 1
fi

[[ -d "$destination" && ! -L "$destination" && -f "$receipt" && ! -L "$receipt" ]] || {
  echo "Provider adapter did not produce the required receipt." >&2
  exit 1
}
chmod 700 "$destination"
find "$destination" -type f -exec chmod 600 {} +

python3 "$VERIFY_SCRIPT" \
  --backup-dir "$destination" \
  --provider-receipt "$receipt" \
  --known-local-source "$known_local_source" \
  --expected-manifest-sha256 "$expected_manifest_sha256" \
  --classification-policy "$classification_policy" \
  --passphrase-fd "$passphrase_fd"

download_complete=true
trap - EXIT HUP INT TERM
echo "Downloaded bytes and generic receipt verified; provider origin remains unproven until a provider-specific independent control is implemented."
