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

if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "GitHub CLI and jq are required for guarded release merges." >&2
  exit 127
fi

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

validate_pr_snapshot "$(fetch_pr_snapshot)"

# GitHub has no atomic expected-base precondition. Re-read every guarded field as
# late as possible; --match-head-commit then protects the head during the merge.
validate_pr_snapshot "$(fetch_pr_snapshot)"

gh pr merge "$pr_number" --repo "$repository" --merge --match-head-commit "$expected_head_sha"
