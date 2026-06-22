# Changelog

All notable Koaryu release changes are tracked here.

## 0.1.1 - 2026-06-21

### Added

- Added backend-paginated Students roster controls, compact dashboard summary loading, performance diagnostics, and a conservative v0.1.1 rollout runbook.

### Fixed

- Hardened tenant-safety and partial-state workflows around student import, account deletion, paid-in-full enrollment invoices, support tickets, lead conversion, student profile writes, recurring class deletion, student relationships, and demo data clearing.

### Improved

- Split large frontend page/state modules and backend services into focused helpers for billing, dashboard, Students, leads, reports, schedules, belt tracker, and demo data workflows.
- Aligned frontend import/API helpers, destructive settings confirmations, production config validation, deployment docs, and Supabase contract verification coverage.

## 0.1.0 - 2026-05-19

### Added

- Added hardened Koaryu Core checkout, portal, and webhook ordering for live-mode testing.
- Added hardened Koaryu Payments autopay authorization, Connect projection, invoice reconciliation, and cancellation cleanup.
- Added production startup checks for missing Supabase, Stripe, and frontend configuration.
- Added admin-only demo reset and clear-studio-data controls that preserve platform subscription access.
- Added account menu, account pages, help routes, and public legal routes.

### Improved

- Improved fresh-account onboarding and studio isolation.
- Removed mock-data fallbacks from live onboarding paths.
- Added landing-page backend warmup without blocking first paint.
- Expanded reports, CSV export coverage, and operational dashboard surfaces.
