# Eligibility and report identity lifetime

This frontend change addresses FSH3-01 and FC2-08. Backend authorization,
promotion rules, report role gates, and request tenant headers are unchanged.

Eligibility has one owner for the selected ladder, request sequence, and access
identity. The existing live-read helper makes at most three attempts when that
same identity receives a different token. Each attempt receives its own explicit
token. A superseded ladder or access identity cannot begin another attempt or
settle another request's pending/error state. Cached rows remain visible during
background revalidation, and student mutations retain their existing invalidation.

Report downloads capture the browser's last observed authoritative access scope
and revision. Profile commits publish user, studio, role, and membership status;
existing access resets invalidate the revision. A profile-only observation retains
known access but cannot grant it; only a verified workspace can do so. Subscription-
required bootstrap explicitly records denied access. Equal profile observations across
provider remounts preserve it. A request-scoped Supabase Auth subscription remains
until the download settles, including while the panel or dashboard layout is
unmounted. Sign-out, a different user, and USER_UPDATED invalidate the captured
scope. The existing API signal supports early cancellation; a separate identity
check immediately before file handoff also handles an already completed response.
Panel mounting controls only UI messages. It does not control file completion.

`tests/identity-lifetime-mounted.test.mjs` mounts the real StoreProvider, Belt
Tracker page/controller/panel, Dashboard controller, report export panel, and
Dashboard layout. Only external I/O and unrelated display components are replaced.
Eligibility reads use the real API client with deferred HTTP responses, including
the backend's expired-token 401 envelope. Downloads use the real API client with a
deferred response body and its actual signal/timeout handling.

The suite covers:

- Renewal success/failure, bounded exhaustion, ordinary errors and the real Retry
  button; older A and replayed A settling while B remains pending.
- User, studio, role, USER_UPDATED, and subscription-access resets during replay;
  cached background renewal/failure, forced loading, status-mutation invalidation,
  null ladders, preview mode, and lazy Dashboard promotions loading.
- Panel/layout removal, same-identity remount, token renewal, and INITIAL_SESSION
  arriving before a remounted provider's getSession resolves.
- Sign-out and user/access changes after unmount, observed A-to-B-to-A replacement,
  and an obsolete provider's late workspace response.
- Invalidation after the API resolves, error/timeout listener cleanup, old error
  suppression with a usable new download, filename fallback, URL/anchor cleanup,
  tenant headers, role gates, preview mode, missing tokens, stale rendered scope,
  and rejected new exports after subscription-required bootstrap.

Before implementation, the initial 16-case mounted suite reproduced the renewal
and stale file-handoff failures. Actual source mutations also demonstrated failing
unconditional-finally, same-identity-only, and unbounded-retry eligibility fixes,
plus mounted-only,
exact-token, component-local-ref, and abort-only report fixes. Private logs retain
those runs; these tests do not claim to catch every future regression.

This is browser lifecycle evidence with synthetic I/O, not hosted validation. It
covers identity/access changes observed by this client through existing auth and
profile paths. It does not add remote permission polling, cross-tab coordination,
or durable downloads across browser-process destruction or hard reloads. There is
no database change or provider deployment in this batch.

Local final verification passed 976 frontend tests with zero failures in 230.198
seconds, the production build, full lint with one existing warning in the untouched
Belt Tracker controller, formatting, and TypeScript checks. The 37 focused mounted
cases also passed separately. No PR review or exact-head CI result is asserted here.
