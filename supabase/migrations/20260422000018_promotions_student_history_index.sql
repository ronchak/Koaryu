-- Speed up student profile promotion-history reads:
-- WHERE studio_id = ? AND student_id = ? ORDER BY promoted_at DESC
CREATE INDEX IF NOT EXISTS idx_promotions_studio_student_promoted_at_desc
    ON promotions(studio_id, student_id, promoted_at DESC);
