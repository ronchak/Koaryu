# Direct owner release authorization

The owner has explicitly removed per-migration GitHub approval comments for this release. Production apply already requires an exact owner/candidate authorization, named executor and deliberate confirmation phrase. Accept that authorization without a comment URL. Staging retains its comment gate; if an operator supplies a comment URL, it is still validated in full.

The change belongs at the authorization boundary. It does not bypass the guarded runner or change migrations. Exact project, candidate/source hashes, inspection token, staging fingerprint, restore declarations, full/single-file dry runs, one-migration limit, confirmation, post-state verification and audit output remain. Direct executions record a null approval URL with the existing owner/executor/candidate fields.

The existing production authorization and full runner tests now exercise the no-comment path and reject any attempted GitHub comment request. They retain wrong owner/candidate/project, missing executor/phrase/restore, stale fingerprint, bulk apply, provider failure and wrong successor assertions. No new test cases or helper layers. Existing staging comment tests remain.

Executable changes require fresh independent review and exact-head CI. Broader operational bookkeeping will be one final PR, as the owner requested. No production apply is authorized by test output alone: the fresh backup/verified restore and per-file original-row comparisons remain mandatory. Production apply announcements use the newly authorized 30-second window; other steps no longer require a pause. Live activation and historical backfill remain forbidden.
