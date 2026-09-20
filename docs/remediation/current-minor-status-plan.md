# Current minor status

DM1-01 derives minor status from date of birth and the studio's current business date at read boundaries. The stored `is_minor` column remains compatible; no historical rows are rewritten. The cutoff remains eighteen, null DOB remains non-minor, and a February 29 birthday reaches eighteen on March 1 in a non-leap year.

The response builder, paged roster, bootstrap and student exports project the same calendar rule. A batch resolves its date once. Bootstrap reuses its loaded studio timezone; unavailable date context does not turn dated student records into a successful empty roster. Authentication failures retain their existing behavior. Student CSV and hygiene reports use the studio date; other reports retain their existing date definitions.

Photo and profile writes resolve required date context before mutation, so this change adds no post-commit lookup that could turn a successful write into a reported failure. Photo responses also handle a DOB added concurrently. Preview create, import and update use the existing business-date context. Cached roster, detail and schedule attendance views reproject when that context changes, with no new timer, request or worker.

The Students and hygiene export date lookup uses the same provider-call and fetched-row budget as report data. Injected test dates perform no studio lookup. Other report clocks and limits stay unchanged.

Tests cover birthdays, leap days, null clearing, stale stored flags, tenant-scoped date lookup, one lookup per batch, partial bootstrap, write ordering, CSV and hygiene. Duplicate pure calendar tests were consolidated into response and preview behavioral cases. Existing authorization, tenant, guardian, export-budget and audit assertions remain. This change needs no database migration and introduces no new guardian policy.

The boundary is the read projection because age changes with the calendar even when nobody edits a student record.
