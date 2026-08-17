# Release identity model

This note records the implemented identity contract. It does not announce a new
release: the current product release remains `0.1.2`, matching the latest dated
changelog entry.

## Authoritative identities

- `backend/release.json` is the only machine-readable source for the current
  Koaryu product release. It lives under `backend/` because Render's configured
  root directory cannot access repository files outside that directory.
- `commit_sha` is the immutable deployed-artifact identity. Vercel supplies
  `VERCEL_GIT_COMMIT_SHA`; Render supplies `RENDER_GIT_COMMIT`. Both public
  endpoints validate a full lowercase 40-character SHA and return `null` for
  missing or malformed provider metadata.
- `API_SCHEMA_VERSION` is the FastAPI/OpenAPI compatibility identity. It remains
  `1.0.0` and is intentionally separate from the product release. This change
  does not claim a new API compatibility level.

The product release is a human support and release-notes label. The commit SHA
is the deploy, rollback, and exact-head evidence. One never substitutes for the
other.

## Surface and consumer inventory

| Surface | Identity and consumer |
| --- | --- |
| `backend/release.json` | Read once by the backend at startup and statically imported into the frontend version route. |
| FastAPI `info.version` | Uses `API_SCHEMA_VERSION`; generated OpenAPI and API-contract tooling retain their compatibility identity. |
| Backend `/` | Exposes explicit `product_version` and `api_schema_version`; legacy `version` remains the API schema alias. |
| Backend health/live/readiness aliases | Expose product release, API schema compatibility, normalized environment, and validated Render commit SHA. |
| Frontend `/api/version` | Exposes product release, frontend service/environment, and validated Vercel commit SHA. |
| `frontend/CHANGELOG.md` | Human release history; its first dated entry must match the product release source. |
| `frontend/package.json` | Private application workspace, not a published product package; it intentionally has no version field. |
| Release ledger and provider checks | Continue to require full exact SHAs for candidate, deployment, and rollback evidence. |

Stripe API dates, dependency versions, migration identities, billing plan
versions, and historical copy such as the v0.1.1 rollout notes are scoped
protocol or historical identifiers. They are not product release sources.

## Change semantics

Routine feature, fix, documentation, and internal maintenance PRs do not bump
the product release. An explicit release-preparation change updates
`backend/release.json` and adds the matching dated changelog entry together.
Historical changelog entries remain unchanged.

`npm run check:release-identity` fails when the current changelog entry drifts,
the release source is malformed, or a private frontend package version is
reintroduced. The exact-head release-candidate workflow runs this guard in
addition to frontend and backend behavior tests.

## Deployment boundary

The frontend Vercel project uses `frontend/` as its root and statically imports
the release source from `backend/`; its project setting that includes source
files outside the Root Directory must remain enabled. The backend has no
outside-root dependency, so Render can read the source in both build and runtime
environments.

Neither runtime derives a commit from a product release. Provider readback,
application-reported SHA, exact-head CI, and the release ledger remain the
required immutable evidence chain.
