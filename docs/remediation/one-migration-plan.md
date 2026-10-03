# One migration per invocation

The owner approved this extension after PR208. The existing CLI pushes the entire pending suffix, so it cannot return control for the required announcement, pause and verification between migrations. The guarded tool will add `--one-migration` for inspection, dry-run and apply on the declared V38-to-V47 chain.

The selection belongs at the existing rollout boundary because that boundary already owns the reviewed source, approval, provider invocation and verified result.

## Contract

Full candidate verification remains mandatory. The selected file is always the first remaining migration; its declared successor must be exactly one history entry later. Inspection reports the full remainder and the selected file separately. The selected file's source hash binds the inspection token, OWNER-authored PR138 approval and deliberate production confirmation phrase. A full-chain or stale-step approval cannot authorize it.

Inside the existing disposable checkout, the tool first proves the full pending list with CLI dry-run. It then temporarily parks later pending files outside the CLI scan directory, retains all earlier files and the selected file unchanged, and requires a second dry-run containing exactly that file. Every parked file is restored in `finally`. Neither the ordinary checkout nor migration history is rewritten.

One apply call follows. The existing remote-state reader must prove the exact declared successor using its complete history, raw catalog and readiness checks. Intermediate success is not final release readiness. Failure or an unexpected state stops; the tool never proceeds to another migration. Each next invocation needs fresh inspection and approval.

All owner, project, candidate, source, staging-fingerprint, backup/restore and confirmation gates remain. Provider output and outcome evidence remain private. The default mode retains its production bulk refusal. This extension adds no SQL, database object, release-attestation format, CLI upgrade or deployment infrastructure.

## Verification and execution

Use behavioral selector, token/approval, filesystem-restoration and entry-point contracts. The coordinator separately replays the V38-to-V47 chain on disposable PostgreSQL, exercising the actual remote-state query reader and one applied file at each checkpoint. Historical migration bytes must remain identical.

Require a fresh independent reviewer, exact-head CI, guarded merge and main CI before hosted use. Then re-derive the candidate, hosted states and every approval. Hosted staging rehearsal, fresh production backup with verified disposable restore, and a per-migration recovery plan still precede production. The owner-authorized database/backend/frontend ordering and announce-and-pause protocol remain in force. Live billing activation and historical financial backfill remain outside this run.
