# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Created `.vscode/settings.json` to ignore unknown CSS at-rules (Tailwind v4 `@theme` compatibility).
- Expanded `BeltRank` schema and types to support belt Tips (`is_tip`, `tip_color_hex`).

### Changed
- Re-architected belt progression mock data to a "Kids Martial Arts" curriculum with white/yellow/orange/purple/blue/green/brown/black belts and tips.
- Updated dashboard layout and several pages to align with updated data structures.
- Refined Supabase middleware session handling for dev preview mode.
