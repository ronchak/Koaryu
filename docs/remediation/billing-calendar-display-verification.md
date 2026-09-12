# Billing calendar display verification

Base: `d14a1bac0709a83a90f27a532bedbcc4d6557f05`. Implementation: `168a08620864bb9b971a18948de10318946253cc`.

FSH1-04 is fixed. Enrollment start/end/next-bill dates and invoice due dates use a calendar-date formatter with UTC interpretation and the existing abbreviated month display. Null/empty values remain “Not set”. Report creation/payment timestamps retain the original local-time formatter. Monetary, overdue, provider timestamp and write semantics are unchanged.

The test consolidates the two prior billing-date cases while retaining their assertions. It also proves September 1 remains September 1 under Los Angeles and UTC, and that a midnight-UTC timestamp still displays August 31 in Los Angeles. The previous process timezone is restored. The existing enrollment rendering stub only changes its formatter import name; financial, tenant and retry assertions are unchanged. No source-text wiring test or new helper framework was added.

The three source files change 498 → 508 lines. The two test files change 397 → 413 lines; their combined cases change 14 → 13. All five files change 895 → 921 lines and 37,077 → 38,112 bytes. Existing formatter exclusions were preserved and the tabs received only import/call changes.

Coordinator source/caller review and the independent 13-test date/transition run passed. The implementer passed 24 focused billing tests, all 911 frontend tests, targeted lint, full formatter check and whitespace checks. No build was required locally for this helper/call-site change; exact-head CI includes the build. Fresh independent review and candidate CI remain required before guarded merge. No backend, schema, provider, deployment or financial behavior change.
