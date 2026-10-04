-- V56 business SQL. Exact predecessor/readiness declarations are appended by the
-- release-attestation worker before this candidate is eligible for release.
CREATE TABLE public.automation_rules (
    studio_id UUID PRIMARY KEY REFERENCES public.studios(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    inactivity_days INTEGER NOT NULL CHECK (inactivity_days BETWEEN 1 AND 90),
    subject_template TEXT NOT NULL CHECK (length(btrim(subject_template)) BETWEEN 1 AND 200),
    body_template TEXT NOT NULL CHECK (length(btrim(body_template)) BETWEEN 1 AND 5000),
    reply_to_email TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_evaluated_at TIMESTAMPTZ
);
CREATE INDEX automation_rules_due ON public.automation_rules(last_evaluated_at NULLS FIRST,studio_id) WHERE enabled;
CREATE TABLE public.automation_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    attendance_id UUID NOT NULL,
    attendance_date DATE NOT NULL CHECK (isfinite(attendance_date)),
    attendance_checked_in_at TIMESTAMPTZ NOT NULL,
    attendance_occurred_at TIMESTAMPTZ NOT NULL,
    student_name TEXT NOT NULL,
    student_first_name TEXT NOT NULL,
    studio_name TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('student','guardian')),
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    reply_to_email TEXT NOT NULL,
    rule_revision BIGINT NOT NULL,
    days_absent INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','sending','accepted','retry_wait','failed','unknown','skipped')),
    claim_token UUID,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
    attempted_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    reason TEXT CHECK (reason IN ('rule_paused','subscription_required','student_unavailable','inactive','on_hold','invalid_birth_date','never_attended','recent_attendance','invalid_email','guardian_missing','guardian_ambiguous','suppressed','episode_already_attempted','attendance_changed','contact_changed','lease_expired','rate_limited','connection_failed','authentication_required','provider_rejected','provider_unknown','retry_exhausted','unavailable','recipient_not_allowed')),
    unsubscribe_token TEXT UNIQUE,
    original_recipient_email TEXT,
    provider_request_id TEXT CHECK (length(provider_request_id) <= 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((attempted_at IS NULL AND attempts=0 AND unsubscribe_token IS NULL AND original_recipient_email IS NULL)
        OR (attempted_at IS NOT NULL AND attempts>0 AND length(unsubscribe_token)=64 AND original_recipient_email IS NOT NULL))
);
CREATE UNIQUE INDEX automation_deliveries_pending_student ON public.automation_deliveries(studio_id,student_id)
    WHERE state IN ('queued','claimed','sending','retry_wait');
CREATE INDEX automation_deliveries_due ON public.automation_deliveries(next_attempt_at,created_at,id)
    WHERE state IN ('queued','claimed','sending','retry_wait');
CREATE INDEX automation_deliveries_episode ON public.automation_deliveries(studio_id,student_id,attempted_at DESC)
    WHERE attempted_at IS NOT NULL;
CREATE INDEX automation_deliveries_activity ON public.automation_deliveries(studio_id,created_at DESC,id DESC);
CREATE TABLE public.automation_suppressions (
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(studio_id,recipient_email)
);
CREATE TABLE private.automation_email_credentials (
    provider_key TEXT PRIMARY KEY CHECK (length(provider_key) BETWEEN 1 AND 128 AND provider_key ~ '^[a-zA-Z0-9:_-]+$'),
    encrypted_credentials TEXT NOT NULL CHECK (length(encrypted_credentials) BETWEEN 1 AND 131072),
    revision BIGINT NOT NULL CHECK (revision>0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_email_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_rules,public.automation_deliveries,public.automation_suppressions,private.automation_email_credentials FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.automation_rules,public.automation_deliveries,private.automation_email_credentials TO service_role;
GRANT SELECT,INSERT ON public.automation_suppressions TO service_role;

-- Once dispatch begins, neither profile correction nor retry may rewrite its
-- original contact/token, attendance evidence, or first attempt timestamp.
CREATE FUNCTION private.automation_delivery_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF OLD.attempted_at IS NOT NULL AND
        ROW(NEW.studio_id,NEW.student_id,NEW.attendance_id,NEW.attendance_date,NEW.attendance_checked_in_at,
            NEW.attendance_occurred_at,NEW.attempted_at,NEW.unsubscribe_token,NEW.original_recipient_email,
            NEW.recipient_email,NEW.recipient_name,NEW.recipient_kind,NEW.student_name,NEW.student_first_name,
            NEW.studio_name,NEW.subject_template,NEW.body_template,NEW.reply_to_email,NEW.rule_revision,NEW.days_absent)
        IS DISTINCT FROM
        ROW(OLD.studio_id,OLD.student_id,OLD.attendance_id,OLD.attendance_date,OLD.attendance_checked_in_at,
            OLD.attendance_occurred_at,OLD.attempted_at,OLD.unsubscribe_token,OLD.original_recipient_email,
            OLD.recipient_email,OLD.recipient_name,OLD.recipient_kind,OLD.student_name,OLD.student_first_name,
            OLD.studio_name,OLD.subject_template,OLD.body_template,OLD.reply_to_email,OLD.rule_revision,OLD.days_absent) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Automation attempt identity is immutable.';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_delivery_immutable BEFORE UPDATE ON public.automation_deliveries
    FOR EACH ROW EXECUTE FUNCTION private.automation_delivery_immutable();

CREATE FUNCTION private.automation_normalize_email(p_email TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_email TEXT; v_local TEXT; v_domain TEXT; v_label TEXT;
BEGIN
    IF p_email IS NULL OR p_email ~ '[^ -~]' THEN RETURN NULL; END IF;
    v_email:=lower(btrim(p_email,' '));
    IF length(v_email)>254 OR length(v_email)-length(replace(v_email,'@',''))<>1 THEN RETURN NULL; END IF;
    v_local:=split_part(v_email,'@',1); v_domain:=split_part(v_email,'@',2);
    IF length(v_local) NOT BETWEEN 1 AND 64 OR v_local !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+$'
        OR left(v_local,1)='.' OR right(v_local,1)='.' OR position('..' IN v_local)>0
        OR position('.' IN v_domain)=0 THEN RETURN NULL; END IF;
    FOREACH v_label IN ARRAY string_to_array(v_domain,'.') LOOP
        IF length(v_label) NOT BETWEEN 1 AND 63 OR v_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN RETURN NULL; END IF;
    END LOOP;
    RETURN v_email;
END $$;

CREATE FUNCTION private.automation_require_admin(p_studio_id UUID,p_actor_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT private.lock_student_import_actor(p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Automation admin permission required.';
    END IF;
    IF (SELECT count(*) FROM public.staff_roles WHERE user_id=p_actor_id)<>1 THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Automation admin permission required.';
    END IF;
    PERFORM 1 FROM public.staff_roles WHERE studio_id=p_studio_id AND user_id=p_actor_id
        AND archived_at IS NULL AND role='admin' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Automation admin permission required.';
    END IF;
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
END $$;

CREATE FUNCTION private.automation_core_entitled(p_studio_id UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM public.studio_subscriptions s WHERE s.studio_id=p_studio_id
        AND (s.comped OR s.status IN ('active','trialing','comped'))
        AND NOT (s.status='trialing' AND s.trial_end IS NOT NULL AND s.trial_end<=clock_timestamp()))
$$;

-- One source for previews, enqueue decisions, and dispatch revalidation.
CREATE FUNCTION private.missed_class_automation_candidates(
    p_studio_id UUID,p_inactivity_days INTEGER,p_student_id UUID DEFAULT NULL,p_delivery_id UUID DEFAULT NULL
) RETURNS TABLE(student_id UUID,student_name TEXT,student_first_name TEXT,studio_name TEXT,
    reference_date DATE,last_attendance_date DATE,days_absent INTEGER,attendance_id UUID,
    attendance_checked_in_at TIMESTAMPTZ,attendance_occurred_at TIMESTAMPTZ,
    recipient_name TEXT,recipient_email TEXT,recipient_kind TEXT,skip_reason TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
WITH studio_clock AS MATERIALIZED (
    SELECT s.id,s.name,public.student_business_date(s.id) AS today,
        CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone)
            THEN s.timezone ELSE 'UTC' END AS timezone FROM public.studios s WHERE s.id=p_studio_id
), facts AS MATERIALIZED (
    SELECT s.*,c.name AS studio_name,c.today,c.timezone,
        CASE WHEN s.date_of_birth IS NULL THEN COALESCE(s.is_minor,false)
            WHEN isfinite(s.date_of_birth) AND s.date_of_birth<=c.today
            THEN s.date_of_birth>(c.today-INTERVAL '18 years')::date ELSE NULL END AS minor,
        a.id AS attendance_id,a.date AS attendance_date,a.checked_in_at,a.occurred_at,
        g.valid_count,g.primary_count,g.valid_primary_count,g.primary_email,g.primary_name,g.any_email,g.any_name
    FROM public.students s JOIN studio_clock c ON c.id=s.studio_id
    LEFT JOIN LATERAL (
        SELECT a.id,cs.date,a.checked_in_at,(cs.date+cs.start_time) AT TIME ZONE c.timezone AS occurred_at
        FROM public.attendance a JOIN public.class_sessions cs ON cs.id=a.session_id AND cs.studio_id=s.studio_id
        WHERE a.studio_id=s.studio_id AND a.student_id=s.id AND a.status IN ('present','late')
            AND cs.deleted_at IS NULL AND cs.status IS DISTINCT FROM 'canceled'
            AND isfinite(cs.date) AND cs.date<=c.today AND isfinite(a.checked_in_at) AND a.checked_in_at<=clock_timestamp()
            AND (cs.date+cs.start_time) AT TIME ZONE c.timezone<=clock_timestamp()
        ORDER BY cs.date DESC,cs.start_time DESC,a.checked_in_at DESC,a.id DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE private.automation_normalize_email(g.email) IS NOT NULL) AS valid_count,
            count(*) FILTER (WHERE g.is_primary_contact) AS primary_count,
            count(*) FILTER (WHERE g.is_primary_contact AND private.automation_normalize_email(g.email) IS NOT NULL) AS valid_primary_count,
            max(private.automation_normalize_email(g.email)) FILTER (WHERE g.is_primary_contact) AS primary_email,
            max(g.first_name||' '||g.last_name) FILTER (WHERE g.is_primary_contact) AS primary_name,
            max(private.automation_normalize_email(g.email)) AS any_email,max(g.first_name||' '||g.last_name) FILTER (WHERE private.automation_normalize_email(g.email) IS NOT NULL) AS any_name
        FROM public.student_guardians sg JOIN public.guardians g ON g.id=sg.guardian_id AND g.studio_id=s.studio_id
        WHERE sg.student_id=s.id
    ) g ON true
    WHERE s.studio_id=p_studio_id AND (p_student_id IS NULL OR s.id=p_student_id)
), routed AS MATERIALIZED (
    SELECT f.*,CASE WHEN minor THEN CASE WHEN primary_count=1 AND valid_primary_count=1 THEN primary_email
            WHEN primary_count<=1 AND valid_count=1 THEN any_email END
        ELSE private.automation_normalize_email(email) END AS routed_email,
        CASE WHEN minor THEN CASE WHEN primary_count=1 AND valid_primary_count=1 THEN primary_name
            WHEN primary_count<=1 AND valid_count=1 THEN any_name END
        ELSE legal_first_name||' '||legal_last_name END AS routed_name
    FROM facts f
)
SELECT r.id,r.legal_first_name||' '||r.legal_last_name,COALESCE(NULLIF(r.preferred_name,''),r.legal_first_name),
    r.studio_name,r.today,r.attendance_date,r.today-r.attendance_date,r.attendance_id,r.checked_in_at,r.occurred_at,
    r.routed_name,r.routed_email,CASE WHEN minor THEN 'guardian' ELSE 'student' END,
    CASE WHEN r.deleted_at IS NOT NULL THEN 'student_unavailable'
        WHEN r.status<>'active' THEN 'inactive'
        WHEN r.hold_start_date IS NOT NULL AND r.hold_start_date<=r.today
            AND (r.hold_end_date IS NULL OR r.hold_end_date>=r.today) THEN 'on_hold'
        WHEN r.minor IS NULL THEN 'invalid_birth_date'
        WHEN r.attendance_id IS NULL THEN 'never_attended'
        WHEN r.today-r.attendance_date<p_inactivity_days THEN 'recent_attendance'
        WHEN r.minor AND (r.primary_count>1 OR (r.valid_primary_count=0 AND r.valid_count>1)) THEN 'guardian_ambiguous'
        WHEN r.minor AND r.routed_email IS NULL THEN 'guardian_missing'
        WHEN r.routed_email IS NULL THEN 'invalid_email'
        WHEN EXISTS(SELECT 1 FROM public.automation_suppressions x WHERE x.studio_id=p_studio_id AND x.recipient_email=r.routed_email) THEN 'suppressed'
        WHEN EXISTS(SELECT 1 FROM public.automation_deliveries d WHERE d.studio_id=p_studio_id AND d.student_id=r.id
            AND d.attempted_at IS NOT NULL AND d.id IS DISTINCT FROM p_delivery_id
            AND NOT (r.attendance_id<>d.attendance_id AND r.attendance_date>d.attendance_date AND r.checked_in_at>d.attempted_at AND r.occurred_at>d.attempted_at))
            THEN 'episode_already_attempted'
    END
FROM routed r
$$;

CREATE FUNCTION public.get_missed_class_automation_rule_v1(p_studio_id UUID,p_actor_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_rule JSONB;
BEGIN
    PERFORM private.automation_require_admin(p_studio_id,p_actor_id);
    SELECT jsonb_build_object('enabled',enabled,'inactivity_days',inactivity_days,'subject_template',subject_template,
        'body_template',body_template,'reply_to_email',reply_to_email,'revision',revision,'updated_at',updated_at)
        INTO v_rule FROM public.automation_rules WHERE studio_id=p_studio_id;
    RETURN jsonb_build_object('rule',v_rule);
END $$;
CREATE FUNCTION public.save_missed_class_automation_rule_v1(p_studio_id UUID,p_actor_id UUID,p_expected_revision BIGINT,
    p_enabled BOOLEAN,p_inactivity_days INTEGER,p_subject_template TEXT,p_body_template TEXT,p_reply_to_email TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_revision BIGINT;
BEGIN
    PERFORM private.automation_require_admin(p_studio_id,p_actor_id);
    IF p_expected_revision IS NULL OR p_expected_revision<0 OR p_enabled IS NULL
        OR p_inactivity_days IS NULL OR p_inactivity_days NOT BETWEEN 1 AND 90
        OR p_subject_template IS NULL OR length(btrim(p_subject_template)) NOT BETWEEN 1 AND 200
        OR p_body_template IS NULL OR length(btrim(p_body_template)) NOT BETWEEN 1 AND 5000
        OR private.automation_normalize_email(p_reply_to_email) IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid automation rule.';
    END IF;
    INSERT INTO public.automation_rules(studio_id,enabled,inactivity_days,subject_template,body_template,reply_to_email,revision,updated_by)
    SELECT p_studio_id,p_enabled,p_inactivity_days,p_subject_template,p_body_template,
        private.automation_normalize_email(p_reply_to_email),1,p_actor_id WHERE p_expected_revision=0
    ON CONFLICT DO NOTHING RETURNING revision INTO v_revision;
    IF v_revision IS NULL AND p_expected_revision>0 THEN
        UPDATE public.automation_rules SET enabled=p_enabled,inactivity_days=p_inactivity_days,subject_template=p_subject_template,
            body_template=p_body_template,reply_to_email=private.automation_normalize_email(p_reply_to_email),
            revision=revision+1,updated_by=p_actor_id,updated_at=clock_timestamp()
        WHERE studio_id=p_studio_id AND revision=p_expected_revision RETURNING revision INTO v_revision;
    END IF;
    IF v_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RULE_CONFLICT'; END IF;
    RETURN public.get_missed_class_automation_rule_v1(p_studio_id,p_actor_id);
END $$;
CREATE FUNCTION public.preview_missed_class_automation_v1(p_studio_id UUID,p_actor_id UUID,p_inactivity_days INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result JSONB;
BEGIN
    PERFORM private.automation_require_admin(p_studio_id,p_actor_id);
    IF p_inactivity_days IS NULL OR p_inactivity_days NOT BETWEEN 1 AND 90 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inactivity days.';
    END IF;
    WITH candidates AS MATERIALIZED (SELECT * FROM private.missed_class_automation_candidates(p_studio_id,p_inactivity_days)),
    sample AS (SELECT * FROM candidates ORDER BY (skip_reason IS NOT NULL),student_name,student_id LIMIT 100)
    SELECT jsonb_build_object('reference_date',public.student_business_date(p_studio_id),
        'eligible_count',(SELECT count(*) FROM candidates WHERE skip_reason IS NULL),
        'skipped_count',(SELECT count(*) FROM candidates WHERE skip_reason IS NOT NULL),
        'recipients',COALESCE((SELECT jsonb_agg(jsonb_build_object('student_id',student_id,'student_name',student_name,
            'student_first_name',student_first_name,'studio_name',studio_name,'last_attendance_date',last_attendance_date,
            'days_absent',days_absent,'recipient_name',recipient_name,'recipient_email',recipient_email,
            'recipient_kind',recipient_kind,'skip_reason',skip_reason) ORDER BY (skip_reason IS NOT NULL),student_name,student_id) FROM sample),'[]'::jsonb),
        'truncated',(SELECT count(*)>100 FROM candidates)) INTO v_result;
    RETURN v_result;
END $$;
CREATE FUNCTION public.get_missed_class_automation_activity_v1(p_studio_id UUID,p_actor_id UUID,p_limit INTEGER DEFAULT 50) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result JSONB;
BEGIN
    PERFORM private.automation_require_admin(p_studio_id,p_actor_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid activity limit.'; END IF;
    SELECT jsonb_build_object('items',COALESCE(jsonb_agg(jsonb_build_object('id',d.id,'student_id',d.student_id,
        'student_name',d.student_name,'recipient_email',d.recipient_email,'state',d.state,'created_at',d.created_at,
        'attempted_at',d.attempted_at,'settled_at',d.settled_at,'attempts',d.attempts,'reason',d.reason)
        ORDER BY d.created_at DESC,d.id DESC),'[]'::jsonb),
        'has_more',(SELECT count(*)>p_limit FROM (SELECT 1 FROM public.automation_deliveries WHERE studio_id=p_studio_id LIMIT p_limit+1) q))
    INTO v_result FROM (SELECT * FROM public.automation_deliveries WHERE studio_id=p_studio_id ORDER BY created_at DESC,id DESC LIMIT p_limit) d;
    RETURN v_result;
END $$;

CREATE FUNCTION public.enqueue_missed_class_automations_v1(p_limit INTEGER DEFAULT 10,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_rule public.automation_rules; v_candidate RECORD; v_count INTEGER:=0; v_added INTEGER; v_more BOOLEAN:=false;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid enqueue limit.'; END IF;
    -- Each invocation visits at most ten studios and creates at most p_limit rows.
    -- Rotation advances even when a studio has no eligible students.
    FOR v_rule IN SELECT * FROM public.automation_rules WHERE enabled
        ORDER BY last_evaluated_at NULLS FIRST,studio_id LIMIT 10 FOR UPDATE SKIP LOCKED LOOP
        UPDATE public.automation_rules SET last_evaluated_at=clock_timestamp() WHERE studio_id=v_rule.studio_id;
        BEGIN
            PERFORM 1 FROM public.studios WHERE id=v_rule.studio_id FOR KEY SHARE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN CONTINUE;
        END;
        IF NOT private.automation_core_entitled(v_rule.studio_id) THEN CONTINUE; END IF;
        FOR v_candidate IN SELECT * FROM private.missed_class_automation_candidates(v_rule.studio_id,v_rule.inactivity_days) c
            WHERE c.skip_reason IS NULL AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR c.recipient_email=ANY(p_allowed_recipients)) AND NOT EXISTS(SELECT 1 FROM public.automation_deliveries d
                WHERE d.studio_id=v_rule.studio_id AND d.student_id=c.student_id AND d.state IN ('queued','claimed','sending','retry_wait'))
            ORDER BY c.last_attendance_date,c.student_id LIMIT p_limit-v_count LOOP
            INSERT INTO public.automation_deliveries(studio_id,student_id,attendance_id,attendance_date,attendance_checked_in_at,
                attendance_occurred_at,student_name,student_first_name,studio_name,recipient_email,recipient_name,recipient_kind,
                subject_template,body_template,reply_to_email,rule_revision,days_absent)
            VALUES(v_rule.studio_id,v_candidate.student_id,v_candidate.attendance_id,v_candidate.last_attendance_date,v_candidate.attendance_checked_in_at,v_candidate.attendance_occurred_at,
                v_candidate.student_name,v_candidate.student_first_name,v_candidate.studio_name,v_candidate.recipient_email,v_candidate.recipient_name,v_candidate.recipient_kind,
                v_rule.subject_template,v_rule.body_template,v_rule.reply_to_email,v_rule.revision,v_candidate.days_absent) ON CONFLICT DO NOTHING;
            GET DIAGNOSTICS v_added=ROW_COUNT; v_count:=v_count+v_added;
        END LOOP;
        IF v_count>=p_limit THEN EXIT; END IF;
    END LOOP;
    SELECT EXISTS(SELECT 1 FROM public.automation_rules remaining_rule
        CROSS JOIN LATERAL private.missed_class_automation_candidates(remaining_rule.studio_id,remaining_rule.inactivity_days) c
        WHERE remaining_rule.enabled AND private.automation_core_entitled(remaining_rule.studio_id) AND c.skip_reason IS NULL
        AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR c.recipient_email=ANY(p_allowed_recipients))
        AND NOT EXISTS(SELECT 1 FROM public.automation_deliveries d WHERE d.studio_id=remaining_rule.studio_id AND d.student_id=c.student_id
            AND d.state IN ('queued','claimed','sending','retry_wait'))) INTO v_more;
    RETURN jsonb_build_object('enqueued',v_count,'has_more',v_more);
END $$;

CREATE FUNCTION public.claim_missed_class_automations_v1(p_limit INTEGER DEFAULT 10,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_items JSONB; v_more BOOLEAN;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid claim limit.'; END IF;
    -- A lost sending lease has an uncertain provider outcome, never a new send.
    WITH expired AS (SELECT id FROM public.automation_deliveries WHERE state='sending' AND lease_expires_at<=now()
        ORDER BY lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)
    UPDATE public.automation_deliveries d SET state='unknown',reason='lease_expired',settled_at=clock_timestamp(),
        claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() FROM expired e WHERE d.id=e.id;
    WITH due AS (SELECT id FROM public.automation_deliveries
        WHERE ((state IN ('queued','retry_wait') AND next_attempt_at<=now())
            OR (state='claimed' AND lease_expires_at<=now()))
            AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR EXISTS(
                SELECT 1 FROM public.automation_rules r CROSS JOIN LATERAL private.missed_class_automation_candidates(
                    r.studio_id,r.inactivity_days,automation_deliveries.student_id,automation_deliveries.id) c
                WHERE r.studio_id=automation_deliveries.studio_id AND c.recipient_email=ANY(p_allowed_recipients)))
        ORDER BY next_attempt_at,created_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED),
    claimed AS (UPDATE public.automation_deliveries d SET state='claimed',claim_token=gen_random_uuid(),
        lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',updated_at=clock_timestamp()
        FROM due WHERE due.id=d.id RETURNING d.id,d.claim_token,d.studio_id)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'claim_token',claim_token,'studio_id',studio_id)),'[]'::jsonb) INTO v_items FROM claimed;
    SELECT EXISTS(SELECT 1 FROM public.automation_deliveries WHERE ((state IN ('queued','retry_wait') AND next_attempt_at<=now())
        OR (state='claimed' AND lease_expires_at<=now()))
        AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR EXISTS(
                SELECT 1 FROM public.automation_rules r CROSS JOIN LATERAL private.missed_class_automation_candidates(
                    r.studio_id,r.inactivity_days,automation_deliveries.student_id,automation_deliveries.id) c
                WHERE r.studio_id=automation_deliveries.studio_id AND c.recipient_email=ANY(p_allowed_recipients)))) INTO v_more;
    RETURN jsonb_build_object('items',v_items,'has_more',v_more);
END $$;

CREATE FUNCTION public.begin_missed_class_automation_v1(p_delivery_id UUID,p_claim_token UUID,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; r public.automation_rules; c RECORD; v_reason TEXT;
BEGIN
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ready',false,'state',NULL,'reason',NULL,'message',NULL); END IF;
    -- Match the existing parent/student writer order before owning the outbox row.
    PERFORM 1 FROM public.studios WHERE id=d.studio_id FOR KEY SHARE;
    SELECT * INTO r FROM public.automation_rules WHERE studio_id=d.studio_id FOR SHARE;
    PERFORM 1 FROM public.studio_subscriptions WHERE studio_id=d.studio_id FOR SHARE;
    PERFORM 1 FROM public.students WHERE id=d.student_id AND studio_id=d.studio_id FOR UPDATE;
    PERFORM 1 FROM public.guardians g JOIN public.student_guardians sg ON sg.guardian_id=g.id
        WHERE sg.student_id=d.student_id AND g.studio_id=d.studio_id ORDER BY g.id FOR SHARE OF g,sg;
    PERFORM 1 FROM public.class_sessions cs JOIN public.attendance a ON a.session_id=cs.id AND a.studio_id=cs.studio_id
        WHERE a.student_id=d.student_id AND a.studio_id=d.studio_id ORDER BY cs.id,a.id FOR SHARE OF cs,a;
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id FOR UPDATE;
    IF NOT FOUND OR d.state<>'claimed' OR d.claim_token IS DISTINCT FROM p_claim_token OR d.lease_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('ready',false,'state',d.state,'reason',NULL,'message',NULL);
    END IF;
    IF r.enabled IS DISTINCT FROM true THEN v_reason:='rule_paused';
    ELSIF NOT private.automation_core_entitled(d.studio_id) THEN v_reason:='subscription_required';
    ELSE
        SELECT * INTO c FROM private.missed_class_automation_candidates(d.studio_id,r.inactivity_days,d.student_id,d.id);
        IF NOT FOUND THEN v_reason:='student_unavailable'; ELSE v_reason:=c.skip_reason; END IF;
    END IF;
    IF v_reason IS NULL THEN
        -- The suppression POST and dispatch boundary serialize on the same pair.
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(d.studio_id::text||':'||c.recipient_email,0));
        SELECT * INTO c FROM private.missed_class_automation_candidates(d.studio_id,r.inactivity_days,d.student_id,d.id);
        v_reason:=c.skip_reason;
        IF COALESCE(cardinality(p_allowed_recipients),0)>0 AND (c.recipient_email=ANY(p_allowed_recipients)) IS DISTINCT FROM true THEN
            v_reason:='recipient_not_allowed';
        END IF;
        IF d.attempted_at IS NOT NULL THEN
            IF c.attendance_id IS DISTINCT FROM d.attendance_id OR c.last_attendance_date IS DISTINCT FROM d.attendance_date THEN v_reason:='attendance_changed';
            ELSIF c.recipient_email IS DISTINCT FROM d.original_recipient_email THEN v_reason:='contact_changed'; END IF;
        END IF;
    END IF;
    IF v_reason IS NOT NULL THEN
        UPDATE public.automation_deliveries SET
            state=CASE WHEN v_reason IN ('suppressed','episode_already_attempted','attendance_changed','contact_changed') THEN 'skipped' ELSE 'queued' END,
            reason=v_reason,claim_token=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+INTERVAL '1 hour',
            settled_at=CASE WHEN v_reason IN ('suppressed','episode_already_attempted','attendance_changed','contact_changed') THEN clock_timestamp() END,
            updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
        RETURN jsonb_build_object('ready',false,'state',d.state,'reason',d.reason,'message',NULL);
    END IF;
    UPDATE public.automation_deliveries SET state='sending',attempts=attempts+1,
        attempted_at=COALESCE(attempted_at,clock_timestamp()),lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',
        unsubscribe_token=COALESCE(unsubscribe_token,encode(extensions.gen_random_bytes(32),'hex')),
        original_recipient_email=COALESCE(original_recipient_email,c.recipient_email),
        attendance_id=CASE WHEN attempted_at IS NULL THEN c.attendance_id ELSE attendance_id END,
        attendance_date=CASE WHEN attempted_at IS NULL THEN c.last_attendance_date ELSE attendance_date END,
        attendance_checked_in_at=CASE WHEN attempted_at IS NULL THEN c.attendance_checked_in_at ELSE attendance_checked_in_at END,
        attendance_occurred_at=CASE WHEN attempted_at IS NULL THEN c.attendance_occurred_at ELSE attendance_occurred_at END,
        recipient_email=CASE WHEN attempted_at IS NULL THEN c.recipient_email ELSE recipient_email END,
        recipient_name=CASE WHEN attempted_at IS NULL THEN c.recipient_name ELSE recipient_name END,
        recipient_kind=CASE WHEN attempted_at IS NULL THEN c.recipient_kind ELSE recipient_kind END,
        student_name=CASE WHEN attempted_at IS NULL THEN c.student_name ELSE student_name END,
        student_first_name=CASE WHEN attempted_at IS NULL THEN c.student_first_name ELSE student_first_name END,
        studio_name=CASE WHEN attempted_at IS NULL THEN c.studio_name ELSE studio_name END,
        subject_template=CASE WHEN attempted_at IS NULL THEN r.subject_template ELSE subject_template END,
        body_template=CASE WHEN attempted_at IS NULL THEN r.body_template ELSE body_template END,
        reply_to_email=CASE WHEN attempted_at IS NULL THEN r.reply_to_email ELSE reply_to_email END,
        rule_revision=CASE WHEN attempted_at IS NULL THEN r.revision ELSE rule_revision END,
        days_absent=CASE WHEN attempted_at IS NULL THEN c.days_absent ELSE days_absent END,
        reason=NULL,settled_at=NULL,updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
    RETURN jsonb_build_object('ready',true,'state',d.state,'reason',NULL,'message',jsonb_build_object(
        'delivery_id',d.id,'attempt_id',d.id::text||':'||d.attempts::text,'student_first_name',d.student_first_name,
        'studio_name',d.studio_name,'days_absent',d.days_absent,'recipient_email',d.recipient_email,
        'subject_template',d.subject_template,'body_template',d.body_template,'reply_to_email',d.reply_to_email,
        'unsubscribe_token',d.unsubscribe_token));
END $$;

CREATE FUNCTION public.settle_missed_class_automation_v1(p_delivery_id UUID,p_claim_token UUID,p_outcome TEXT,
    p_error_code TEXT DEFAULT NULL,p_provider_request_id TEXT DEFAULT NULL,p_retry_after_seconds INTEGER DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; v_state TEXT; v_reason TEXT;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','retryable_failure','permanent_failure','unknown') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid delivery outcome.';
    END IF;
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id FOR UPDATE;
    IF NOT FOUND OR d.state<>'sending' OR d.claim_token IS DISTINCT FROM p_claim_token OR d.lease_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('updated',false,'state',d.state);
    END IF;
    v_state:=CASE p_outcome WHEN 'accepted' THEN 'accepted' WHEN 'unknown' THEN 'unknown'
        WHEN 'permanent_failure' THEN 'failed' WHEN 'retryable_failure' THEN CASE WHEN d.attempts<3 THEN 'retry_wait' ELSE 'failed' END END;
    v_reason:=CASE WHEN p_outcome='accepted' THEN NULL
        WHEN p_outcome='unknown' THEN 'provider_unknown'
        WHEN p_outcome='retryable_failure' AND d.attempts>=3 THEN 'retry_exhausted'
        WHEN p_error_code IN ('rate_limited','connection_failed','authentication_required','provider_rejected','unavailable') THEN p_error_code
        ELSE CASE WHEN p_outcome='retryable_failure' THEN 'unavailable' ELSE 'provider_rejected' END END;
    UPDATE public.automation_deliveries SET state=v_state,reason=v_reason,
        provider_request_id=CASE WHEN p_provider_request_id ~ '^[A-Za-z0-9_.:-]{1,200}$' THEN p_provider_request_id END,
        next_attempt_at=clock_timestamp()+make_interval(secs=>greatest(60,least(86400,COALESCE(p_retry_after_seconds,60*(2^d.attempts)::int)))),
        claim_token=NULL,lease_expires_at=NULL,settled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=d.id;
    RETURN jsonb_build_object('updated',true,'state',v_state);
END $$;
CREATE FUNCTION public.suppress_missed_class_automation_v1(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d RECORD;
BEGIN
    IF p_token IS NOT NULL AND p_token ~ '^[a-f0-9]{64}$' THEN
        SELECT studio_id,original_recipient_email INTO d FROM public.automation_deliveries WHERE unsubscribe_token=p_token AND attempted_at IS NOT NULL;
        IF FOUND THEN
            PERFORM 1 FROM public.studios WHERE id=d.studio_id FOR KEY SHARE;
            IF NOT FOUND THEN RETURN jsonb_build_object('success',true); END IF;
            PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(d.studio_id::text||':'||d.original_recipient_email,0));
            INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES(d.studio_id,d.original_recipient_email) ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    RETURN jsonb_build_object('success',true);
END $$;

CREATE FUNCTION public.get_automation_email_credential_v1(p_provider_key TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_result JSONB;
BEGIN
    IF p_provider_key IS NULL OR length(p_provider_key) NOT BETWEEN 1 AND 128 OR p_provider_key !~ '^[a-zA-Z0-9:_-]+$' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid email provider key.';
    END IF;
    SELECT jsonb_build_object('provider_key',provider_key,'encrypted_credentials',encrypted_credentials,'revision',revision)
        INTO v_result FROM private.automation_email_credentials WHERE provider_key=p_provider_key;
    RETURN COALESCE(v_result,jsonb_build_object('provider_key',p_provider_key,'encrypted_credentials',NULL,'revision',0));
END $$;
CREATE FUNCTION public.save_automation_email_credential_v1(p_provider_key TEXT,p_expected_revision BIGINT,p_encrypted_credentials TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_revision BIGINT;
BEGIN
    PERFORM public.get_automation_email_credential_v1(p_provider_key);
    IF p_expected_revision IS NULL OR p_expected_revision<0 OR p_encrypted_credentials IS NULL OR length(p_encrypted_credentials) NOT BETWEEN 1 AND 131072 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid encrypted email credential.';
    END IF;
    INSERT INTO private.automation_email_credentials(provider_key,encrypted_credentials,revision)
        SELECT p_provider_key,p_encrypted_credentials,1 WHERE p_expected_revision=0
        ON CONFLICT DO NOTHING RETURNING revision INTO v_revision;
    IF v_revision IS NULL AND p_expected_revision>0 THEN
        UPDATE private.automation_email_credentials SET encrypted_credentials=p_encrypted_credentials,revision=revision+1,updated_at=clock_timestamp()
        WHERE provider_key=p_provider_key AND revision=p_expected_revision RETURNING revision INTO v_revision;
    END IF;
    IF v_revision IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_EMAIL_CREDENTIAL_CONFLICT'; END IF;
    RETURN public.get_automation_email_credential_v1(p_provider_key);
END $$;

-- Do not rely on the provider's default privileges for any callable helper.
DO $acl$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_delivery_immutable','automation_normalize_email','automation_require_admin','automation_core_entitled','missed_class_automation_candidates'))
        OR (n.nspname='public' AND p.proname IN ('get_missed_class_automation_rule_v1','save_missed_class_automation_rule_v1',
            'preview_missed_class_automation_v1','get_missed_class_automation_activity_v1','enqueue_missed_class_automations_v1',
            'claim_missed_class_automations_v1','begin_missed_class_automation_v1','settle_missed_class_automation_v1',
            'suppress_missed_class_automation_v1','get_automation_email_credential_v1','save_automation_email_credential_v1')) LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.signature);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
    END LOOP;
END $acl$;
