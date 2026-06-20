-- ==========================================
-- Koaryu v1 - Recurring session soft-delete uniqueness
-- ==========================================
--
-- A generated recurring class session is logically unique only while it is
-- active. Soft-deleted occurrences must not block the scheduler from creating a
-- replacement for the same template/date.

DROP INDEX IF EXISTS public.idx_class_sessions_template_date_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_sessions_template_date_active_unique
    ON public.class_sessions(template_id, date)
    WHERE template_id IS NOT NULL
      AND deleted_at IS NULL;
