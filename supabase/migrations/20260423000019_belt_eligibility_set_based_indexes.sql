-- Support set-based belt eligibility attendance lookups.
CREATE INDEX IF NOT EXISTS idx_attendance_eligibility_student_checked_in
    ON attendance(studio_id, student_id, checked_in_at)
    INCLUDE (session_id)
    WHERE status <> 'absent';
