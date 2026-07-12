#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/merge-release-pr.sh <pr-number> <expected-head-sha> <expected-base-sha>" >&2
  exit 2
fi

pr_number="$1"
expected_head_sha="$2"
expected_base_sha="$3"
repository="ronchak/Koaryu"
pr_fields="baseRefName,baseRefOid,headRefOid,isDraft,mergeStateStatus,statusCheckRollup"
render_service_id="srv-d7mogk1kh4rs73aq6hqg"
render_api_key="${RENDER_API_KEY:-}"

if [[ ! "$pr_number" =~ ^[1-9][0-9]*$ ]]; then
  echo "PR number must be a positive integer." >&2
  exit 2
fi

if [[ ! "$expected_head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected head SHA must be a full lowercase 40-character hexadecimal commit SHA." >&2
  exit 2
fi

if [[ ! "$expected_base_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected base SHA must be a full lowercase 40-character hexadecimal commit SHA." >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "GitHub CLI, jq, and curl are required for guarded release merges." >&2
  exit 127
fi

if [[ -z "$render_api_key" ]]; then
  echo "Refusing merge: RENDER_API_KEY is required for authenticated production auto-deploy readback." >&2
  exit 1
fi

validate_render_provider_control() {
  local response
  local service
  local service_id
  local service_name
  local service_branch
  local service_repo
  local service_root_dir
  local service_type
  local service_url
  local health_check_path
  local has_control
  local control_is_off

  if ! response="$(curl --silent --show-error --fail --max-time 20 \
    --header "Authorization: Bearer $render_api_key" \
    --header "Accept: application/json" \
    "https://api.render.com/v1/services/$render_service_id")"; then
    echo "Refusing merge: authenticated Render service readback failed." >&2
    exit 1
  fi

  if ! service="$(jq -ce '.service // .' <<<"$response")"; then
    echo "Refusing merge: Render returned an invalid service response." >&2
    exit 1
  fi

  service_id="$(jq -r '.id // ""' <<<"$service")"
  service_name="$(jq -r '.name // ""' <<<"$service")"
  service_branch="$(jq -r '.branch // ""' <<<"$service")"
  service_repo="$(jq -r '.repo // ""' <<<"$service")"
  service_repo="${service_repo%.git}"
  service_repo="${service_repo%/}"
  service_root_dir="$(jq -r '.rootDir // ""' <<<"$service")"
  service_type="$(jq -r '.type // ""' <<<"$service")"
  service_url="$(jq -r '.serviceDetails.url // ""' <<<"$service")"
  service_url="${service_url%/}"
  health_check_path="$(jq -r '.serviceDetails.healthCheckPath // ""' <<<"$service")"
  has_control="$(jq -r 'has("autoDeploy")' <<<"$service")"
  control_is_off="$(jq -r '
    .autoDeploy == "no"
    and (if has("autoDeployTrigger") then .autoDeployTrigger == "off" else true end)
  ' <<<"$service")"

  if [[ "$service_id" != "$render_service_id" || "$service_name" != "Koaryu" ]]; then
    echo "Refusing merge: Render readback does not identify the pinned koaryu production service." >&2
    exit 1
  fi
  if [[ "$service_branch" != "main" ]]; then
    echo "Refusing merge: Render production service branch is $service_branch, not main." >&2
    exit 1
  fi
  if [[ "$service_repo" != "https://github.com/ronchak/Koaryu" \
    || "$service_root_dir" != "backend" \
    || "$service_type" != "web_service" \
    || "$service_url" != "https://koaryu.onrender.com" \
    || "$health_check_path" != "/health" ]]; then
    echo "Refusing merge: Render readback does not match the canonical production repository, service, URL, and bootstrap health path." >&2
    exit 1
  fi
  if [[ "$has_control" != "true" || "$control_is_off" != "true" ]]; then
    echo "Refusing merge: Render production auto-deploy is not disabled." >&2
    exit 1
  fi

  jq -cn \
    --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg service_id "$service_id" \
    --arg service_name "$service_name" \
    --arg branch "$service_branch" \
    --arg repo "$service_repo" \
    --arg root_dir "$service_root_dir" \
    --arg service_type "$service_type" \
    --arg url "$service_url" \
    --arg health_check_path "$health_check_path" \
    '{provider:"render",authenticated_readback:true,checked_at:$checked_at,service_id:$service_id,service_name:$service_name,branch:$branch,repo:$repo,root_dir:$root_dir,service_type:$service_type,url:$url,health_check_path:$health_check_path,auto_deploy:"off"}'
}

fetch_pr_snapshot() {
  gh pr view "$pr_number" --repo "$repository" --json "$pr_fields"
}

validate_pr_snapshot() {
  local pr_json="$1"
  local actual_base_name
  local actual_head_sha
  local actual_base_sha
  local is_draft
  local merge_state

  actual_base_name="$(jq -r '.baseRefName' <<<"$pr_json")"
  actual_head_sha="$(jq -r '.headRefOid' <<<"$pr_json")"
  actual_base_sha="$(jq -r '.baseRefOid' <<<"$pr_json")"
  is_draft="$(jq -r '.isDraft' <<<"$pr_json")"
  merge_state="$(jq -r '.mergeStateStatus' <<<"$pr_json")"

  if [[ "$actual_base_name" != "main" ]]; then
    echo "Refusing merge: PR base branch is $actual_base_name, not main." >&2
    exit 1
  fi

  if [[ "$actual_head_sha" != "$expected_head_sha" ]]; then
    echo "Refusing merge: PR head moved from $expected_head_sha to $actual_head_sha." >&2
    exit 1
  fi

  if [[ "$actual_base_sha" != "$expected_base_sha" ]]; then
    echo "Refusing merge: PR base moved from $expected_base_sha to $actual_base_sha." >&2
    exit 1
  fi

  if [[ "$is_draft" != "false" ]]; then
    echo "Refusing merge: PR is still a draft." >&2
    exit 1
  fi

  if [[ "$merge_state" != "CLEAN" ]]; then
    echo "Refusing merge: GitHub merge state is $merge_state, not CLEAN." >&2
    exit 1
  fi

  if ! jq -e '
    [.statusCheckRollup[]
      | select(
          .__typename == "CheckRun"
          and .name == "Release candidate gate"
          and .workflowName == "Release candidate"
        )
      | .conclusion] == ["SUCCESS"]
  ' <<<"$pr_json" >/dev/null; then
    echo "Refusing merge: the exact head lacks one successful GitHub Actions Release candidate gate." >&2
    exit 1
  fi

  if ! jq -e '
    all(.statusCheckRollup[];
      if .__typename == "CheckRun" then
        .status == "COMPLETED"
        and (.conclusion == "SUCCESS" or .conclusion == "NEUTRAL" or .conclusion == "SKIPPED")
      elif .__typename == "StatusContext" then
        .state == "SUCCESS"
      else
        false
      end)
  ' <<<"$pr_json" >/dev/null; then
    echo "Refusing merge: at least one check is missing, pending, or failing." >&2
    exit 1
  fi
}

validate_render_provider_control
validate_pr_snapshot "$(fetch_pr_snapshot)"

# GitHub has no atomic expected-base precondition. Re-read every guarded field as
# late as possible; --match-head-commit then protects the head during the merge.
validate_render_provider_control
validate_pr_snapshot "$(fetch_pr_snapshot)"

gh pr merge "$pr_number" --repo "$repository" --merge --match-head-commit "$expected_head_sha"
