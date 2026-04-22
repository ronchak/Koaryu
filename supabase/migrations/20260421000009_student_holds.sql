-- ==========================================
-- Koaryu v1 — Phase 2.1 Migration
-- Student hold / vacation windows
-- ==========================================

ALTER TABLE students
    ADD COLUMN hold_start_date DATE,
    ADD COLUMN hold_end_date DATE;

ALTER TABLE students
    ADD CONSTRAINT students_hold_window_check
    CHECK (
        hold_start_date IS NULL
        OR hold_end_date IS NULL
        OR hold_end_date >= hold_start_date
    );

CREATE INDEX idx_students_hold_window
    ON students(studio_id, hold_start_date, hold_end_date)
    WHERE deleted_at IS NULL;
