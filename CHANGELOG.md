# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Created `.vscode/settings.json` to ignore unknown CSS at-rules (Tailwind v4 `@theme` compatibility).
- Expanded `BeltRank` schema and types to support belt Tips (`is_tip`, `tip_color_hex`).
- Added deployment documentation for Supabase environment expectations, onboarding behavior, and tenant verification notes.
- Added migration guidance for tenant-hardening and the `staff_roles` RLS recursion fix.
- Added repair migrations `20260421000013` through `20260421000015` to harden the atomic belt ladder sync RPC for already-linked Supabase projects.
- Added a targeted end-to-end regression proof for atomic belt ladder syncing in `frontend/e2e/atomic-belt-ladder.spec.ts`.
- Added demo-readiness tooling and data, including a one-click demo reset path, polished demo CSV, and clearer demo seed coverage for students, leads, belts, schedules, and promotion history.
- Added bulk schedule attendance reads and supporting database indexes so schedule range loads no longer fan out into one attendance request per session.
- Added promotion-history and eligibility indexes for faster student profile and belt tracker reads.
- Added a client-side theme system with persisted dark/light/system preference, first-paint theme hydration, and a sidebar theme toggle.
- Added shared route and modal transition primitives for the dashboard shell, KPI insights, lead details, student forms, schedule modals, and belt tracker dialogs.
- Added a non-blocking landing-page backend warmup that calls `/api/proxy/health` after the informational page paints.

### Changed
- Re-architected belt progression mock data to a "Kids Martial Arts" curriculum with white/yellow/orange/purple/blue/green/brown/black belts and tips.
- Updated dashboard layout and several pages to align with updated data structures.
- Refined Supabase middleware session handling for dev preview mode.
- Hardened the documented fresh-account flow so signed-in users without a studio are routed to onboarding and fully onboarded users are routed back to the dashboard.
- Documented live-mode behavior for empty new studios, CSV import and lead conversion persistence, reports/holds data paths, and belt ladder persistence improvements.
- Documented deployment/demo caveats for shared Supabase dev projects, including public-signup email rate limits and the need to prepare example CSV/demo data for live demos.
- Hardened `sync_belt_ladder_ranks` so the atomic ladder save path no longer fails on PL/pgSQL identifier ambiguity and continues to return the full ladder state after sync.
- Locked the live belt ladder save flow to the atomic `/belts/ladders/{id}/sync` contract instead of depending on multi-request rank replacement behavior.
- Optimized dashboard bootstrap so critical studio, auth, roster, leads, and belt data are committed before dashboard children render.
- Batched student guardian hydration in roster and dashboard bootstrap responses, removing per-student guardian lookups.
- Reworked belt eligibility calculation to use set-based promotion and attendance reads instead of per-student queries.
- Optimized student profiles by caching and de-duplicating promotion-history requests, avoiding unnecessary detail refetches for students without guardians, and using the store's belt ladder data when available.
- Reduced render-time work across dashboard, students, reports, and schedule views by memoizing derived rows/counts and narrowing broad UI transitions.
- Improved student list refresh behavior so freshly bootstrapped rosters are not immediately refetched unless the bootstrap payload may be partial.
- Switched the Render and Procfile backend startup command from four Gunicorn workers to a single Uvicorn process for better cold-start headroom on small Render instances.
- Removed the unused Gunicorn backend dependency after moving production startup to Uvicorn.
- Kept the informational landing page out of Supabase auth middleware so it does not block on session resolution or backend `/auth/me`; login, onboarding, subscription, and dashboard routes still use the normal auth gate.
- Updated light-theme-safe color tokens for accent contrast, raised surfaces, hover states, calendar cells, buttons, inputs, and status actions.
- Replaced broad `transition-all` usage across key dashboard controls with narrower transition properties and reduced-motion support.

### Verified
- Confirmed health endpoints, fresh-account onboarding, redirect behavior, and multi-studio isolation in the local Supabase-backed development environment.
- Verified a fresh-user browser flow creates a ladder and persists the first belt through a single atomic sync request.
- Verified authenticated repeated sync calls preserve existing rank IDs, add new ranks safely, and roll back cleanly when invalid payloads are submitted.
- Verified the performance pass with frontend lint, TypeScript, production build, backend compile/import smoke tests, diff whitespace checks, and local dev health checks.
- Confirmed runtime request shape now uses one promotion-history request per student profile load and one bulk attendance request per schedule range.
- Verified the new Uvicorn production command boots locally and returns an OK `/health` response.
- Verified the landing-page middleware/warmup changes with targeted frontend lint.
