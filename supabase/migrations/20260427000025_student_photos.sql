-- ==========================================
-- Student profile photos
-- ==========================================

ALTER TABLE students
    ADD COLUMN IF NOT EXISTS photo_path TEXT,
    ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_students_photo_path
    ON students(studio_id, photo_path)
    WHERE photo_path IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN students.photo_path IS
    'Private Supabase Storage object path for the student profile photo.';

COMMENT ON COLUMN students.photo_updated_at IS
    'Timestamp of the latest student profile photo replacement.';

INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'student-photos',
    'student-photos',
    false,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
    public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Intentionally no storage.objects policies: photos are private and accessed
-- only through the backend service role, which returns short-lived signed URLs.
