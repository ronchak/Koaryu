# Explicit release authorization

The owner authorized the coordinating Astra task to execute production releases directly. A TTY proves only that a process has a terminal; it does not identify the person who authorized a release. This change replaces that check with an explicit owner/release token, named executor, deliberate exact phrase and an audit record.

The fix belongs at the rollout tool's authorization boundary because every production apply must bind the owner approval and reported executor to the same reviewed candidate and migration set in its evidence.

## Scope and controls

The tool requires `--release-authorization ronchak:<candidate-sha>`, `--release-operator` and `--confirmation-phrase`. The phrase format is unchanged. It is checked immediately before apply, after all source, target, inspection, approval, staging-fingerprint and dry-run checks. The actual GitHub PR138 OWNER approval remains the authorization record; the new string does not replace it. Backup with verified restore and named recovery authority remain mandatory.

Started, provider-response, verified-success and failed-or-unknown records carry their full authorization context and timestamps. Success records include the versions proved applied. Failure records do not invent applied versions or hide the warning that remote state may have changed.

Repository policy now documents the mandatory announcement and 60-second pause before each irreversible or outward-facing release action, one command and announcement per action, immediate verification, and stop conditions. The owner permits the exact planned old-frontend/new-backend pair only during that transition. All unexpected SHA mismatches still halt.

The executor name is caller-reported attribution, not an authenticated process identity. GitHub verifies the approval account and exact release scope. A public owner/release label or a second name comparison cannot isolate a malicious process that shares provider credentials. The named-coordinator restriction remains an operating-policy requirement; subagents are not authorized.

Private runbooks are unchanged. The proposed policy diff is checked with a dry-run and recorded file hashes. The owner's explicit instruction governs this run while the private notes await alignment. Physical recovery-key handling and separate live-billing authorization retain their existing rules.

## Verification

The existing production-gate test now checks missing/wrong owner, release, executor, phrase and restore evidence. One table-driven entry-point test covers non-TTY success, apply failure, wrong post-state and bad confirmation. It uses strict command fixtures, verifies that a bad phrase never applies, and checks that failure cannot emit successful/applied evidence. The existing child-process contract also proves response capture on success, nonzero exit, spawn failure and timeout. The main contract proves a V46 single-migration success and rejects the actual nine-migration V38 remainder before apply. Tool cases change 66→67; workflow cases 127→128. The tool changes 5,527→5,612 lines and its tests 3,468→3,702. No source-text assertion or fixture framework is added.

Require coordinator review, a fresh independent reviewer, exact-head CI, the guarded merge and main's own CI. No product behavior, migration, SQL contract or provider setting changes belong in this PR. No hosted apply or deployment occurs during verification.

## Pending execution-mode decision

Production execution now refuses a remainder containing multiple migrations. The underlying CLI still applies a complete pending chain in one call; no per-migration selection mode has been implemented. The requested pause before every migration needs a separately confirmed per-migration mode. The coordinator has asked the owner whether to include that bounded extension. Until answered and implemented, the production packet remains blocked. Do not substitute a bulk apply for the protocol.
