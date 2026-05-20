-- ==========================================
-- Koaryu v1 - Privacy-safe support triage digest
-- ==========================================
--
-- Codex automations should never load raw support-ticket bodies just to
-- summarize them. This RPC returns only the bounded, redacted fields needed for
-- daily operator triage.

CREATE OR REPLACE FUNCTION public.support_triage_digest(
    p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    WITH triage AS (
        SELECT *
        FROM public.support_triage_list_tickets(
            NULL,
            NULL,
            NULL,
            LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
        )
    ),
    sanitized AS (
        SELECT
            id::TEXT AS id,
            studio_id::TEXT AS studio_id,
            topic,
            severity,
            status,
            CASE severity
                WHEN 'urgent' THEN 0
                WHEN 'high' THEN 1
                WHEN 'normal' THEN 2
                ELSE 3
            END AS severity_rank,
            CASE
                WHEN topic = 'student_records' THEN 'details withheld'
                ELSE LEFT(BTRIM(regexp_replace(COALESCE(subject, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 160)
            END AS subject,
            CASE
                WHEN topic = 'student_records' THEN 'details withheld'
                ELSE LEFT(BTRIM(regexp_replace(COALESCE(details, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 240)
            END AS summary_seed,
            CASE
                WHEN COALESCE(requester_email, '') = '' THEN ''
                WHEN position('@' IN requester_email) > 1 AND split_part(requester_email, '@', 2) <> ''
                    THEN LEFT(split_part(requester_email, '@', 1), 1) || '***@' || split_part(requester_email, '@', 2)
                ELSE 'redacted'
            END AS requester,
            created_at,
            updated_at,
            resolved_at,
            GREATEST(FLOOR(EXTRACT(EPOCH FROM (now() - created_at)) / 3600)::INTEGER, 0) AS age_hours
        FROM triage
    )
    SELECT jsonb_build_object(
        'ok', true,
        'source', 'support_triage_digest',
        'checked_at', now(),
        'count', COUNT(*),
        'counts_by_severity', COALESCE(
            (
                SELECT jsonb_object_agg(severity, ticket_count)
                FROM (
                    SELECT severity, COUNT(*) AS ticket_count
                    FROM sanitized
                    GROUP BY severity
                ) severity_counts
            ),
            '{}'::jsonb
        ),
        'counts_by_status', COALESCE(
            (
                SELECT jsonb_object_agg(status, ticket_count)
                FROM (
                    SELECT status, COUNT(*) AS ticket_count
                    FROM sanitized
                    GROUP BY status
                ) status_counts
            ),
            '{}'::jsonb
        ),
        'counts_by_topic', COALESCE(
            (
                SELECT jsonb_object_agg(topic, ticket_count)
                FROM (
                    SELECT topic, COUNT(*) AS ticket_count
                    FROM sanitized
                    GROUP BY topic
                ) topic_counts
            ),
            '{}'::jsonb
        ),
        'tickets', COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'id', id,
                    'studio_id', studio_id,
                    'topic', topic,
                    'severity', severity,
                    'status', status,
                    'subject', subject,
                    'summary_seed', summary_seed,
                    'requester', requester,
                    'created_at', created_at,
                    'updated_at', updated_at,
                    'resolved_at', resolved_at,
                    'age_hours', age_hours
                )
                ORDER BY severity_rank, created_at ASC, id ASC
            ),
            '[]'::jsonb
        )
    )
    FROM sanitized;
$$;

REVOKE ALL ON FUNCTION public.support_triage_digest(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_triage_digest(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.support_triage_digest(INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.support_triage_digest(INTEGER) TO service_role;
