# Navigation reliability follow-up

This work follows the September 6 production navigation review. Delivery is split
into recovery, data loading and measurement, and measured deployment and bundle
improvements. All candidates require the exact-head Release candidate gate.

## Recovery

Temporary Supabase user-read failures retain session and studio cookies. User
reads have one bounded retry and an eight-second total deadline, including SDK
work. Missing or rejected credentials still require sign-in. Late SDK callbacks
cannot change response cookies after the deadline. Rate limits are not retried
without their Retry-After information.

Unavailable navigation retains a validated application destination in `returnTo`.
Try again makes a fresh document request to that destination. The informational
status route is not itself a health probe; middleware emits a privacy-safe
`auth_unavailable` event for the actual failure.

The root layout embeds its build identity. History restoration, a return after
30 seconds hidden, and reconnecting trigger a bounded, deduplicated version
check. A changed build offers refresh without replacing unsaved work. Refresh
waits for API commands to settle. Unknown versions, another environment, and
network failures do not trigger reload. Existing open builds without this code
need one initial refresh. Same-build restoration emits `koaryu:resume` for
workspace revalidation in the data-loading follow-up.

Sidebar feedback stays inside its fixed icon slot and appears only after 200 ms.
Reduced-motion mode uses a static indicator. Release CI exercises side, collapsed,
top and mobile navigation, recovery destination, and an update with an open form.
The update test supplies a persisted pageshow event; it verifies lifecycle handling,
not a claim that every browser history navigation uses bfcache.

## Remaining review items

- Revalidate access and visible data after same-build restoration without replacing drafts.
- Make initial feature reads route-specific and bound large datasets.
- Record click-to-content latency and retain privacy-safe production metrics.
- Evaluate cheaper page identity verification against revocation requirements.
- Separate ordinary fact-cache reads from post-command reconciliation.
- Align operation deadlines and measure function locality.
- Trial intent prefetch and profile initial production bundles before splitting them.

Implementation evidence and completed items must be updated in each follow-up PR.
Existing authorization, command-outcome and subscription protections remain
acceptance criteria throughout.
