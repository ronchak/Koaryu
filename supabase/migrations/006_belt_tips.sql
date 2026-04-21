-- ==========================================
-- Koaryu v1 — Migration 006
-- Belt Rank: Tip/Stripe Support
-- ==========================================
-- Adds intermediary "tip" or "stripe" support to belt ranks.
-- A tip is a sub-step within a belt (e.g., White → Red Tip 1 → Red Tip 2 → Yellow).
-- The tip_color_hex is the color of the stripe on the belt, separate from the belt color.

ALTER TABLE belt_ranks
    ADD COLUMN IF NOT EXISTS is_tip BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS tip_color_hex TEXT DEFAULT NULL;

COMMENT ON COLUMN belt_ranks.is_tip IS
    'If true, this rank is an intermediary stripe/tip rather than a full belt promotion.';

COMMENT ON COLUMN belt_ranks.tip_color_hex IS
    'The color of the stripe/tip on the belt. Only meaningful when is_tip = true.';
