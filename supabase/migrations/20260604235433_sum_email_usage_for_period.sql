-- Koaryu v1 - Aggregate monthly email usage in SQL

CREATE OR REPLACE FUNCTION public.sum_email_usage_for_period(
    p_studio_id UUID,
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(SUM(quantity), 0)::INTEGER
      FROM public.email_usage_events
     WHERE studio_id = p_studio_id
       AND sent_at >= p_period_start
       AND sent_at < p_period_end;
$$;

REVOKE ALL ON FUNCTION public.sum_email_usage_for_period(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.sum_email_usage_for_period(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
TO service_role;
