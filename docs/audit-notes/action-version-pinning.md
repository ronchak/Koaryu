# GitHub Action version-pinning investigation brief

> Planning-only draft. This note does not change the workflow. It records a supply-chain and reproducibility observation from `main` at `0dbf7c0`. The future agent should balance immutability, maintainability, and update automation rather than treating full SHA pinning as an unquestionable rule.

## Executive summary

Koaryu’s release workflow pins some third-party actions to exact commit SHAs, including Supabase setup and Gitleaks, while common GitHub actions such as checkout, setup-node, setup-python, and CodeQL use floating major tags.

The finding is that the exact-candidate workflow is not fully immutable at the action dependency layer. The same repository commit can execute different action code later if a major tag moves. This is a comparatively small risk, but it conflicts with the repository’s otherwise strict emphasis on exact artifacts and reproducible release evidence.

## What the gap is

Representative references in `.github/workflows/release-candidate.yml` include major tags such as:

- `actions/checkout@v7`
- `actions/setup-node@v6`
- `actions/setup-python@v6`
- `github/codeql-action/*@v4`

Other actions are already pinned by full SHA with a human-readable version comment. The repository therefore has two dependency policies in the same critical workflow.

## Why this matters

Floating major tags are normal in many repositories and are maintained by trusted publishers. They still permit upstream code changes without a Koaryu commit. Exact pins improve:

- reproducibility of historical candidate runs
- supply-chain reviewability
- incident investigation when a workflow changes unexpectedly
- confidence that the same repository SHA runs the same action source

The tradeoff is maintenance. Exact pins need a dependable update process so security fixes are not missed.

## Current impact

No malicious or broken upstream action update was identified. The current impact is theoretical supply-chain exposure and imperfect reproducibility. This is not a release blocker by itself, especially because permissions are already constrained and many sensitive actions are pinned.

## Root cause hypothesis

The workflow evolved incrementally. Higher-risk third-party actions were pinned explicitly, while official GitHub-maintained actions retained conventional major tags for easier updates. No repository-wide action dependency policy appears to have been documented.

## Suggested reproducibility and verification

Inventory every `uses:` reference across all workflows and classify it by publisher, current tag, underlying commit, permissions, and access to secrets or write scopes. Confirm whether Dependabot or another updater is configured for GitHub Actions.

Resolve each floating tag to its current commit in a reviewable way. Verify that pinning does not alter inputs, Node runtime compatibility, permissions, or CodeQL behavior. Run the deliberate fail/pass release-gate probes after any workflow change.

## Suggested plan of action

This is a suggested direction, not a mandatory implementation.

Define a simple policy for critical workflows. One reasonable option is full commit pinning for every action, with version comments and automated update PRs. Another is exact pinning only for actions with elevated permissions, secret access, or third-party publishers. The policy should be explicit and consistently enforced.

If full pins are adopted, configure a safe update mechanism and require normal exact-head CI for updates. Consider a small repository test that rejects unapproved floating references rather than relying on review memory.

## Scope guard

Do not change workflow semantics, permissions, tool versions, or release gates unless necessary for compatibility. Do not bundle dependency upgrades with the pinning conversion unless separately explained.

## Evidence expected before merge

The eventual PR should provide an action inventory, explain the chosen policy, show the resolved versions, preserve the release workflow’s deliberate fail/pass behavior, and document the update path.

## Future-work note

This branch contains only the investigation note. No workflow reference has been changed.