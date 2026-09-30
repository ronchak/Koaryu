-- Date-only student validation shares the studio clock with API and UI reads.
-- No backfill: legacy dates remain available for explicit owner correction.
CREATE FUNCTION public.student_business_date(p_studio_id UUID)
RETURNS DATE
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_timezone TEXT;
BEGIN
    SELECT COALESCE(NULLIF(studio.timezone, ''), 'UTC') INTO v_timezone
    FROM public.studios AS studio WHERE studio.id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student studio not found.' USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = v_timezone) THEN
        v_timezone := 'UTC';
    END IF;
    RETURN (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::DATE;
END;
$$;

CREATE FUNCTION public.validate_student_birth_date()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF NEW.date_of_birth IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.date_of_birth IS NOT DISTINCT FROM OLD.date_of_birth
           AND NEW.studio_id IS NOT DISTINCT FROM OLD.studio_id THEN
            RETURN NEW;
        END IF;
    END IF;
    IF NOT pg_catalog.isfinite(NEW.date_of_birth)
       OR NEW.date_of_birth > public.student_business_date(NEW.studio_id) THEN
        RAISE EXCEPTION 'Date of birth cannot be in the future.'
            USING ERRCODE = '23514', CONSTRAINT = 'students_birth_date_not_future';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.student_business_date(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_student_birth_date() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.student_business_date(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_student_birth_date() TO service_role;

CREATE TRIGGER validate_students_birth_date
BEFORE INSERT OR UPDATE OF date_of_birth, studio_id ON public.students
FOR EACH ROW EXECUTE FUNCTION public.validate_student_birth_date();
