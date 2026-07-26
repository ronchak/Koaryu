# Off-site encrypted backup recovery investigation brief

> Planning-only draft. This note does not upload, move, decrypt, restore, rotate, or delete any backup. It refines the operational gap tracked by issue #22 using repository evidence available on `main` at `0dbf7c0`. Every provider, cost, key-custody, or production-data action remains subject to its existing approval boundary.

## Executive summary

Koaryu has demonstrated encrypted logical backup creation, integrity checks, a second-machine copy, and disposable restore work. The repository still does not establish a fully approved off-site recovery path with independently verified provider origin, access controls, version retention, named ownership, clean-machine retrieval, and key availability across a separate trust boundary.

The narrow finding is not that Koaryu has no backups. It has meaningful recovery artifacts. The gap is that the current evidence does not yet prove those artifacts remain recoverable if the primary machine, local storage, or current operator environment is lost.

## What the operational bug is

Current release records state that encrypted artifacts exist and have been copied, but geographic separation, provider independence, ongoing retention, and clean retrieval remain unproven. The recovery key remains tied to the current macOS Keychain workflow, and the repository correctly avoids storing key material.

A local or same-account copy can fail under the same incident as the source. A backup is operationally useful only when the organization can locate, authenticate, decrypt, and restore it under adverse conditions.

## Why this matters

Koaryu stores tenant, authentication, operational, and potentially financial records. Loss of the primary environment without an independently accessible encrypted copy could make recovery impossible even if the application code is intact.

This is also a governance problem. Recovery depends on named ownership, access review, retention, rotation, and periodic proof. A one-time successful copy does not establish a durable process.

## Current impact

No data loss was identified. The current impact is an unclosed disaster-recovery dependency and unproven RPO/RTO assumptions. Production may be operating with encrypted backup evidence that is materially better than nothing but still depends on the availability of the current local environment and operator knowledge.

## Root cause hypothesis

The repository correctly paused before selecting or configuring a paid or external storage service without explicit approval. Recovery work focused first on artifact correctness, encryption, classification, and local restore mechanics. Provider choice, trust boundaries, key escrow, and recurring operations were intentionally left open.

## Suggested reproducibility and verification

Inventory the current encrypted generations without exposing filenames or metadata that would reveal production PII. Confirm where each copy physically and administratively resides, who can access it, whether deletion/versioning policies exist, and whether a compromised primary account could delete every copy.

Using a disposable or approved backup generation, prove retrieval from the proposed off-site source on a clean machine. Verify ciphertext hashes, permissions, provider receipt or origin evidence, correct-key decryption, wrong-key rejection, and cleanup. Do not use production plaintext outside the approved recovery process.

## Suggested plan of action

The following is guidance, not a provider recommendation.

Select an off-site storage model with an explicit trust boundary, cost, retention policy, versioning behavior, and deletion protection. Define primary and backup owners. Establish a high-entropy key-custody process that does not place the key beside the ciphertext and does not put secrets in GitHub.

Automate or document generation rotation and verification at a cadence grounded in the desired RPO. Preserve at least two known-good generations until replacement verification completes. Link the resulting evidence to issue #22 and the release ledger.

## Scope guard

Do not upload production artifacts to an unapproved service, expose keys or plaintext, delete the only known-good generation, enable paid infrastructure without approval, or conflate off-site possession with a complete application restore.

## Evidence expected before merge

The future PR should document the approved provider or storage boundary, artifact and version-retention policy, ownership, retrieval and decryption proof, denied-access behavior, recurring cadence, cost, and rollback or provider-exit procedure. Sensitive values must remain outside the repository.

## Future-work note

This branch contains only the investigation note. No backup or provider state has changed.