-- ==========================================
-- Koaryu v1 - Attendance bulk read indexes
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_attendance_studio_session
    ON attendance(studio_id, session_id);

CREATE INDEX IF NOT EXISTS idx_attendance_studio_session_countable
    ON attendance(studio_id, session_id)
    WHERE status <> 'absent';
