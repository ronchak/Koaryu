# Release versioning investigation brief

> Planning-only draft. This note does not change any version number or release designation. It records a current consistency issue observed on `main` at `0dbf7c0`. The future implementing agent should first determine which identifiers Koaryu actually intends to make authoritative.

## Executive summary

Koaryu currently exposes several different product versions:

- the backend application and health response report `1.0.0`
- the frontend package reports `0.1.0`
- the changelog’s latest release is `0.1.2`
- deployment evidence primarily relies on the Git commit SHA

The suspected defect is the absence of one explicit source of truth. This does not break core product behavior, but it weakens release traceability and can mislead operators, support, clients, and future agents about what is deployed.

## What the bug is

The values are hardcoded or maintained independently in different files. A release can update the changelog without changing package metadata or backend output. The health response can therefore claim a semantic version that does not correspond to the repository’s release notes.

The commit SHA remains the strongest immutable deployment identifier, but it does not explain the user-facing release line or compatibility expectations by itself.

## Why this matters

Consistent version identity supports:

- incident correlation across frontend and backend
- support conversations about reported behavior
- rollback and release-ledger accuracy
- API compatibility decisions
- automated verification that both providers run the intended release
- human understanding of whether `1.0.0` is a product milestone, API schema version, or placeholder

Version drift also makes future migrations harder because an agent may “correct” one value without knowing the intended policy.

## Current impact

The mismatch is current and directly reproducible. No customer-facing failure was identified. The present impact is ambiguous operational and release metadata. Existing SHA-based provider checks reduce the practical severity, which is why this should remain a small, focused PR.

## Root cause hypothesis

Different version values were introduced for different purposes. FastAPI’s application metadata used a conventional `1.0.0`, the frontend package retained its initial scaffold version, and the changelog evolved independently as releases shipped. No build or release step was assigned ownership of synchronizing them.

## Suggested reproducibility and verification

Inspect the backend root and health payloads, frontend package metadata, changelog, generated API documentation, and frontend version endpoint if applicable. Verify which values are visible to users and which are internal only.

Review deployment and rollback scripts to determine whether they consume semantic versions or only commit SHAs. Search for tests or documentation that assume a specific version value.

## Suggested plan of action

The direction below is suggested rather than mandatory.

Define the identity model. Koaryu may want one product semantic version plus an immutable commit SHA, or it may decide that only release labels and SHAs are authoritative. Generate runtime metadata from one controlled source rather than duplicating literals.

Keep API schema versioning separate if it has distinct compatibility meaning. Update documentation and tests to state what each exposed field means. Avoid manually bumping unrelated files in every small internal PR unless that is part of an explicit release process.

## Scope guard

Do not declare a new major product release, change API compatibility, publish packages, or redesign the changelog in this work. Keep the change to version ownership, generation, and truthful exposure.

## Evidence expected before merge

The eventual PR should show one authoritative source, consistent runtime outputs, unchanged exact-SHA deployment evidence, and tests that fail when version surfaces drift. The release ledger and changelog guidance should remain clear.

## Future-work note

This branch contains only this investigation note. No version value has been changed.