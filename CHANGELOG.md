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

### Changed
- Re-architected belt progression mock data to a "Kids Martial Arts" curriculum with white/yellow/orange/purple/blue/green/brown/black belts and tips.
- Updated dashboard layout and several pages to align with updated data structures.
- Refined Supabase middleware session handling for dev preview mode.
- Hardened the documented fresh-account flow so signed-in users without a studio are routed to onboarding and fully onboarded users are routed back to the dashboard.
- Documented live-mode behavior for empty new studios, CSV import and lead conversion persistence, reports/holds data paths, and belt ladder persistence improvements.
- Documented deployment/demo caveats for shared Supabase dev projects, including public-signup email rate limits and the need to prepare example CSV/demo data for live demos.
- Hardened `sync_belt_ladder_ranks` so the atomic ladder save path no longer fails on PL/pgSQL identifier ambiguity and continues to return the full ladder state after sync.
- Locked the live belt ladder save flow to the atomic `/belts/ladders/{id}/sync` contract instead of depending on multi-request rank replacement behavior.

### Verified
- Confirmed health endpoints, fresh-account onboarding, redirect behavior, and multi-studio isolation in the local Supabase-backed development environment.
- Verified a fresh-user browser flow creates a ladder and persists the first belt through a single atomic sync request.
- Verified authenticated repeated sync calls preserve existing rank IDs, add new ranks safely, and roll back cleanly when invalid payloads are submitted.
