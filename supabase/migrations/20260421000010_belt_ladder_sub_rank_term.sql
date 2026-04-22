-- ==========================================
-- Koaryu v1 — Migration 010
-- Persist configurable belt sub-rank terminology
-- ==========================================

ALTER TABLE belt_ladders
    ADD COLUMN sub_rank_term TEXT NOT NULL DEFAULT 'Stripe';
