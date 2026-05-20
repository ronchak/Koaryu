#!/usr/bin/env bash
set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo '{"ok":false,"error":"Supabase CLI is required for support triage digest."}'
  exit 0
fi

supabase db query --linked "
WITH triage AS (
  SELECT *
  FROM public.support_triage_list_tickets(NULL, NULL, NULL, 50)
),
sanitized AS (
  SELECT
    id::text,
    studio_id::text,
    topic,
    severity,
    status,
    CASE
      WHEN topic = 'student_records' THEN 'details withheld'
      ELSE LEFT(regexp_replace(subject, '[[:cntrl:]]+', ' ', 'g'), 160)
    END AS subject,
    CASE
      WHEN topic = 'student_records' THEN 'details withheld'
      ELSE LEFT(regexp_replace(details, '[[:cntrl:]]+', ' ', 'g'), 240)
    END AS summary_seed,
    CASE
      WHEN requester_email = '' THEN ''
      ELSE LEFT(split_part(requester_email, '@', 1), 1) || '***@' || split_part(requester_email, '@', 2)
    END AS requester,
    created_at,
    updated_at,
    resolved_at,
    FLOOR(EXTRACT(EPOCH FROM (now() - created_at)) / 3600)::integer AS age_hours
  FROM triage
)
SELECT jsonb_build_object(
  'ok', true,
  'checked_at', now(),
  'count', COUNT(*),
  'counts_by_severity', COALESCE(
    (SELECT jsonb_object_agg(severity, count) FROM (
      SELECT severity, COUNT(*) AS count
      FROM sanitized
      GROUP BY severity
    ) severity_counts),
    '{}'::jsonb
  ),
  'counts_by_status', COALESCE(
    (SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, COUNT(*) AS count
      FROM sanitized
      GROUP BY status
    ) status_counts),
    '{}'::jsonb
  ),
  'counts_by_topic', COALESCE(
    (SELECT jsonb_object_agg(topic, count) FROM (
      SELECT topic, COUNT(*) AS count
      FROM sanitized
      GROUP BY topic
    ) topic_counts),
    '{}'::jsonb
  ),
  'tickets', COALESCE(jsonb_agg(to_jsonb(sanitized)), '[]'::jsonb)
) AS digest
FROM sanitized;
"
