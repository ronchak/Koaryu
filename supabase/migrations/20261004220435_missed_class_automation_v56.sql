-- Missed-class automation after the exact reviewed V55 checkpoint.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(
        (SELECT p.prosrc FROM pg_catalog.pg_proc p
         WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v36()')),
        'UTF8'),'sha256'),'hex') IS DISTINCT FROM 'bf8eb2b0cebd23371297280e9c968d89e82987bfba66bc93ae5b9a997f43d706' THEN
        RAISE EXCEPTION 'V56 requires the reviewed V55 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v36();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 150
       OR v.migration_head IS DISTINCT FROM '20260930192626'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v55'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 66
       OR v.pending_versions[66] IS DISTINCT FROM '20260930192626' THEN
        RAISE EXCEPTION 'V56 requires a fully verified V55 predecessor.';
    END IF;
END;
$predecessor$;

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
    last_evaluated_at TIMESTAMPTZ,
    dispatch_deferred_until TIMESTAMPTZ,
    last_dispatch_claim_at TIMESTAMPTZ
);
CREATE INDEX automation_rules_due ON public.automation_rules(last_evaluated_at NULLS FIRST,studio_id) WHERE enabled;
CREATE INDEX automation_rules_dispatch ON public.automation_rules(last_dispatch_claim_at NULLS FIRST,studio_id) WHERE enabled;
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
    provider_key TEXT PRIMARY KEY CHECK (length(provider_key) >= 1 AND length(provider_key) <= 128 AND provider_key ~ '^[a-zA-Z0-9:_-]+$'),
    encrypted_credentials TEXT NOT NULL CHECK (length(encrypted_credentials) BETWEEN 1 AND 131072),
    revision BIGINT NOT NULL CHECK (revision>0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_email_credentials ENABLE ROW LEVEL SECURITY;
-- Preserve the existing restrictive guard required on every public RLS table.
CREATE POLICY reject_ambiguous_staff_membership_access ON public.automation_rules
    AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership() AS has_unambiguous_studio_membership))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership() AS has_unambiguous_studio_membership));
CREATE POLICY reject_ambiguous_staff_membership_access ON public.automation_deliveries
    AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership() AS has_unambiguous_studio_membership))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership() AS has_unambiguous_studio_membership));
CREATE POLICY reject_ambiguous_staff_membership_access ON public.automation_suppressions
    AS RESTRICTIVE FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership() AS has_unambiguous_studio_membership))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership() AS has_unambiguous_studio_membership));

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
    p_studio_id UUID,p_inactivity_days INTEGER,p_student_id UUID DEFAULT NULL,p_delivery_id UUID DEFAULT NULL,
    p_reference_at TIMESTAMPTZ DEFAULT clock_timestamp()
) RETURNS TABLE(student_id UUID,student_name TEXT,student_first_name TEXT,studio_name TEXT,
    reference_date DATE,last_attendance_date DATE,days_absent INTEGER,attendance_id UUID,
    attendance_checked_in_at TIMESTAMPTZ,attendance_occurred_at TIMESTAMPTZ,
    recipient_name TEXT,recipient_email TEXT,recipient_kind TEXT,skip_reason TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
WITH studio_zone AS MATERIALIZED (
    SELECT s.id,s.name,
        CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone)
            THEN s.timezone ELSE 'UTC' END AS timezone FROM public.studios s WHERE s.id=p_studio_id
), studio_clock AS MATERIALIZED (
    SELECT z.*,(p_reference_at AT TIME ZONE z.timezone)::date AS today,p_reference_at AS reference_at
    FROM studio_zone z WHERE isfinite(p_reference_at)
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
            AND isfinite(cs.date) AND cs.date<=c.today AND isfinite(a.checked_in_at) AND a.checked_in_at<=c.reference_at
            AND (cs.date+cs.start_time) AT TIME ZONE c.timezone<=c.reference_at
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
DECLARE v_result JSONB; v_reference_at TIMESTAMPTZ;
BEGIN
    PERFORM private.automation_require_admin(p_studio_id,p_actor_id);
    IF p_inactivity_days IS NULL OR p_inactivity_days NOT BETWEEN 1 AND 90 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid inactivity days.';
    END IF;
    v_reference_at:=clock_timestamp();
    WITH candidates AS MATERIALIZED (SELECT * FROM private.missed_class_automation_candidates(p_studio_id,p_inactivity_days,NULL,NULL,v_reference_at)),
    sample AS (SELECT * FROM candidates ORDER BY (skip_reason IS NOT NULL),student_name,student_id LIMIT 100)
    SELECT jsonb_build_object('reference_date',(SELECT (v_reference_at AT TIME ZONE
        CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone) THEN s.timezone ELSE 'UTC' END)::date
        FROM public.studios s WHERE s.id=p_studio_id),
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

-- A fresh answer after a claim or cooldown must not reuse an enqueue flag
-- captured before that studio was deferred. Include eligible unqueued work too.
CREATE FUNCTION private.automation_has_actionable_work(p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM public.automation_rules r
        WHERE r.enabled AND (r.dispatch_deferred_until IS NULL OR r.dispatch_deferred_until<=clock_timestamp())
        AND private.automation_core_entitled(r.studio_id)
        AND (EXISTS(SELECT 1 FROM public.automation_deliveries d
            CROSS JOIN LATERAL private.missed_class_automation_candidates(r.studio_id,r.inactivity_days,d.student_id,d.id) c
            WHERE d.studio_id=r.studio_id AND c.skip_reason IS NULL
            AND ((d.state IN ('queued','retry_wait') AND d.next_attempt_at<=clock_timestamp())
                OR (d.state='claimed' AND d.lease_expires_at<=clock_timestamp()))
            AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR c.recipient_email=ANY(p_allowed_recipients)))
        OR EXISTS(SELECT 1 FROM private.missed_class_automation_candidates(r.studio_id,r.inactivity_days) c
            WHERE c.skip_reason IS NULL AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR c.recipient_email=ANY(p_allowed_recipients))
            AND NOT EXISTS(SELECT 1 FROM public.automation_deliveries d WHERE d.studio_id=r.studio_id AND d.student_id=c.student_id
                AND d.state IN ('queued','claimed','sending','retry_wait')))))
$$;

CREATE FUNCTION public.enqueue_missed_class_automations_v1(p_limit INTEGER DEFAULT 10,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_rule public.automation_rules; v_candidate RECORD; v_count INTEGER:=0; v_added INTEGER; v_more BOOLEAN:=false;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid enqueue limit.'; END IF;
    -- Each invocation visits at most ten studios and creates at most p_limit rows.
    -- Rotation advances even when a studio has no eligible students.
    FOR v_rule IN SELECT * FROM public.automation_rules WHERE enabled
        AND (dispatch_deferred_until IS NULL OR dispatch_deferred_until<=clock_timestamp())
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
    v_more:=private.automation_has_actionable_work(p_allowed_recipients);
    RETURN jsonb_build_object('enqueued',v_count,'has_more',v_more);
END $$;

CREATE FUNCTION public.claim_missed_class_automations_v1(p_limit INTEGER DEFAULT 10,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_items JSONB:='[]'::jsonb; v_more BOOLEAN; v_rule public.automation_rules;
    v_delivery public.automation_deliveries; v_scan INTEGER; v_visited UUID[]:='{}';
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid claim limit.'; END IF;
    -- Sending expiry is recovery, not another attempt, even during a cooldown.
    WITH expired AS (SELECT id FROM public.automation_deliveries WHERE state='sending' AND lease_expires_at<=clock_timestamp()
        ORDER BY lease_expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED)
    UPDATE public.automation_deliveries d SET state='unknown',reason='lease_expired',settled_at=clock_timestamp(),
        claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() FROM expired e WHERE d.id=e.id;
    -- Rotate across studios, not a globally oldest row list. Ten bounded visits
    -- still allow a sole ready studio to fill the caller's requested batch.
    FOR v_scan IN 1..10 LOOP
        EXIT WHEN jsonb_array_length(v_items)>=p_limit;
        SELECT r.* INTO v_rule FROM public.automation_rules r
        WHERE r.enabled AND (r.dispatch_deferred_until IS NULL OR r.dispatch_deferred_until<=clock_timestamp())
            AND NOT r.studio_id=ANY(v_visited)
            AND EXISTS(SELECT 1 FROM public.automation_deliveries d WHERE d.studio_id=r.studio_id
                AND ((d.state IN ('queued','retry_wait') AND d.next_attempt_at<=clock_timestamp())
                    OR (d.state='claimed' AND d.lease_expires_at<=clock_timestamp()))
                AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR EXISTS(
                    SELECT 1 FROM private.missed_class_automation_candidates(r.studio_id,r.inactivity_days,d.student_id,d.id) c
                    WHERE c.recipient_email=ANY(p_allowed_recipients))))
        ORDER BY r.last_dispatch_claim_at NULLS FIRST,r.studio_id LIMIT 1 FOR UPDATE OF r SKIP LOCKED;
        EXIT WHEN NOT FOUND;
        -- Advance even a busy parent so fixed oldest studios cannot monopolize
        -- every invocation. These internal fields never change the rule draft.
        UPDATE public.automation_rules SET last_dispatch_claim_at=clock_timestamp() WHERE studio_id=v_rule.studio_id;
        BEGIN
            PERFORM 1 FROM public.studios WHERE id=v_rule.studio_id FOR KEY SHARE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            v_visited:=array_append(v_visited,v_rule.studio_id); CONTINUE;
        END;
        SELECT d.* INTO v_delivery FROM public.automation_deliveries d WHERE d.studio_id=v_rule.studio_id
            AND ((d.state IN ('queued','retry_wait') AND d.next_attempt_at<=clock_timestamp())
                OR (d.state='claimed' AND d.lease_expires_at<=clock_timestamp()))
            AND (COALESCE(cardinality(p_allowed_recipients),0)=0 OR EXISTS(
                SELECT 1 FROM private.missed_class_automation_candidates(v_rule.studio_id,v_rule.inactivity_days,d.student_id,d.id) c
                WHERE c.recipient_email=ANY(p_allowed_recipients)))
        ORDER BY d.next_attempt_at,d.created_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED;
        IF NOT FOUND THEN v_visited:=array_append(v_visited,v_rule.studio_id); CONTINUE; END IF;
        UPDATE public.automation_deliveries SET state='claimed',claim_token=gen_random_uuid(),
            lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE id=v_delivery.id RETURNING * INTO v_delivery;
        v_items:=v_items||jsonb_build_array(jsonb_build_object('id',v_delivery.id,'claim_token',v_delivery.claim_token,'studio_id',v_delivery.studio_id));
    END LOOP;
    v_more:=private.automation_has_actionable_work(p_allowed_recipients);
    RETURN jsonb_build_object('items',v_items,'has_more',v_more);
END $$;

CREATE FUNCTION public.defer_missed_class_automation_studio_v1(p_delivery_id UUID,p_claim_token UUID,p_reason TEXT,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; v_until TIMESTAMPTZ; v_rule public.automation_rules;
BEGIN
    IF p_reason IS NULL OR p_reason NOT IN ('subscription_required','unavailable') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid automation deferral reason.';
    END IF;
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('updated',false,'state',NULL,'dispatch_deferred_until',NULL,'has_more',private.automation_has_actionable_work(p_allowed_recipients)); END IF;
    -- Match begin's parent/rule/delivery order. No delivery lock precedes a rule
    -- lock, and no provider call is made inside this transaction.
    PERFORM 1 FROM public.studios WHERE id=d.studio_id FOR KEY SHARE;
    SELECT * INTO v_rule FROM public.automation_rules WHERE studio_id=d.studio_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('updated',false,'state',d.state,'dispatch_deferred_until',NULL,'has_more',private.automation_has_actionable_work(p_allowed_recipients)); END IF;
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id FOR UPDATE;
    IF NOT FOUND OR d.state<>'claimed' OR p_claim_token IS NULL OR d.claim_token IS DISTINCT FROM p_claim_token
        OR d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('updated',false,'state',d.state,'dispatch_deferred_until',NULL,'has_more',private.automation_has_actionable_work(p_allowed_recipients));
    END IF;
    v_until:=greatest(COALESCE(v_rule.dispatch_deferred_until,clock_timestamp()),clock_timestamp()+INTERVAL '1 hour');
    UPDATE public.automation_rules SET dispatch_deferred_until=v_until WHERE studio_id=d.studio_id;
    -- A claimed safe retry has historical attempt facts. Release this unstarted
    -- claim without erasing that episode, message, retry eligibility or count.
    UPDATE public.automation_deliveries SET state=CASE WHEN attempted_at IS NULL THEN 'queued' ELSE 'retry_wait' END,
        reason=p_reason,claim_token=NULL,lease_expires_at=NULL,next_attempt_at=greatest(next_attempt_at,v_until),updated_at=clock_timestamp()
        WHERE id=d.id RETURNING * INTO d;
    RETURN jsonb_build_object('updated',true,'state',d.state,'dispatch_deferred_until',v_until,'has_more',private.automation_has_actionable_work(p_allowed_recipients));
END $$;

CREATE FUNCTION public.begin_missed_class_automation_v1(p_delivery_id UUID,p_claim_token UUID,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; r public.automation_rules; c RECORD; v_reason TEXT;
    v_reference_at TIMESTAMPTZ; v_locked_recipient TEXT; v_defer BOOLEAN:=false;
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
    v_reference_at:=clock_timestamp();
    IF r.dispatch_deferred_until>v_reference_at THEN
        UPDATE public.automation_deliveries SET state=CASE WHEN attempted_at IS NULL THEN 'queued' ELSE 'retry_wait' END,
            reason='unavailable',claim_token=NULL,lease_expires_at=NULL,next_attempt_at=greatest(next_attempt_at,r.dispatch_deferred_until),
            updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
        RETURN jsonb_build_object('ready',false,'state',d.state,'reason',d.reason,'message',NULL);
    END IF;
    IF r.enabled IS DISTINCT FROM true THEN v_reason:='rule_paused';
    ELSIF NOT private.automation_core_entitled(d.studio_id) THEN v_reason:='subscription_required';
    ELSE
        SELECT * INTO c FROM private.missed_class_automation_candidates(d.studio_id,r.inactivity_days,d.student_id,d.id,v_reference_at);
        IF NOT FOUND THEN v_reason:='student_unavailable'; ELSE v_reason:=c.skip_reason; END IF;
    END IF;
    IF v_reason IS NULL THEN
        -- Routing is needed to choose the suppression lock. Waiting for that
        -- lock can cross a studio midnight, so the final evaluation uses one
        -- fresh reference for age, holds, gap and attendance after the wait.
        v_locked_recipient:=c.recipient_email;
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(d.studio_id::text||':'||v_locked_recipient,0));
        v_reference_at:=clock_timestamp();
        IF d.lease_expires_at<=v_reference_at THEN
            RETURN jsonb_build_object('ready',false,'state',d.state,'reason',NULL,'message',NULL);
        END IF;
        SELECT * INTO c FROM private.missed_class_automation_candidates(d.studio_id,r.inactivity_days,d.student_id,d.id,v_reference_at);
        IF NOT FOUND THEN v_reason:='student_unavailable';
        ELSIF c.recipient_email IS DISTINCT FROM v_locked_recipient THEN
            -- A birthday can move routing from guardian to student at midnight.
            -- Defer instead of dispatching under the wrong key or taking a
            -- second recipient lock in an inconsistent order.
            v_reason:='contact_changed'; v_defer:=true;
        ELSE
            v_reason:=c.skip_reason;
            IF NOT private.automation_core_entitled(d.studio_id) THEN v_reason:='subscription_required'; END IF;
            IF COALESCE(cardinality(p_allowed_recipients),0)>0 AND (c.recipient_email=ANY(p_allowed_recipients)) IS DISTINCT FROM true THEN
                v_reason:='recipient_not_allowed';
            END IF;
            IF d.attempted_at IS NOT NULL THEN
                IF c.attendance_id IS DISTINCT FROM d.attendance_id OR c.last_attendance_date IS DISTINCT FROM d.attendance_date THEN v_reason:='attendance_changed';
                ELSIF c.recipient_email IS DISTINCT FROM d.original_recipient_email THEN v_reason:='contact_changed'; END IF;
            END IF;
        END IF;
    END IF;
    IF v_reason IS NOT NULL THEN
        UPDATE public.automation_deliveries SET
            state=CASE WHEN NOT v_defer AND v_reason IN ('suppressed','episode_already_attempted','attendance_changed','contact_changed') THEN 'skipped' ELSE 'queued' END,
            reason=v_reason,claim_token=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+INTERVAL '1 hour',
            settled_at=CASE WHEN NOT v_defer AND v_reason IN ('suppressed','episode_already_attempted','attendance_changed','contact_changed') THEN clock_timestamp() END,
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
        WHERE (n.nspname='private' AND p.proname IN ('automation_delivery_immutable','automation_normalize_email','automation_require_admin','automation_core_entitled','automation_has_actionable_work','missed_class_automation_candidates'))
        OR (n.nspname='public' AND p.proname IN ('get_missed_class_automation_rule_v1','save_missed_class_automation_rule_v1',
            'preview_missed_class_automation_v1','get_missed_class_automation_activity_v1','enqueue_missed_class_automations_v1',
            'claim_missed_class_automations_v1','defer_missed_class_automation_studio_v1','begin_missed_class_automation_v1','settle_missed_class_automation_v1',
            'suppress_missed_class_automation_v1','get_automation_email_credential_v1','save_automation_email_credential_v1')) LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.signature);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);
    END LOOP;
END $acl$;

-- Only the explicit new public-table inventory changes this inherited checksum.
DO $expectation$
DECLARE changed INTEGER;
BEGIN
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256 = '783e1a1a99b05067fd86e20165dc43e20d190b331e6ec89f82e48a20dbe625f8'
    WHERE expectation_key = 'operational_contract_v31'
      AND expected_sha256 = 'd4d730c0911b63e8fe9cd13ed5f42b156430062f6f9aa547cabafaf3e3aed94d';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'V56 requires the exact V55 operational expectation singleton.'; END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v37()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> 151 OR v_head <> '20261004220435' THEN
        v_failures := array_append(v_failures, 'migration_history_v56');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:c4d547c0e82fa0376ea97b9302502d16aa79685f2e6a00a341da7859cafc147a' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_schedule_window_manifest_v1()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '8df0d054a33defc36a16f802283cd815a6e5cfd9b1633d7aef288daa4b8158f0' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1_function');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v31_expectations
    WHERE expectation_key = 'operational_contract_v31';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1
       OR private.koaryu_release_operational_contract_v31()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v31');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname='koaryu_release_v31_expectations'
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid='private.koaryu_release_v31_expectations'::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, 'operational_contract_v31_expectation_acl');
    END IF;
    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
                ('koaryu_release_v27_expectations'),
                ('koaryu_release_v28_expectations'),
                ('koaryu_release_v29_expectations'),
                ('koaryu_release_v30_expectations')
        ), expectation_table_state AS (
            SELECT
                required.table_name,
                relation.oid,
                relation.relkind,
                relation.relrowsecurity,
                owner.rolname AS owner_name,
                COALESCE((
                    SELECT count(DISTINCT privilege.privilege_type)
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee=relation.relowner
                      AND NOT privilege.is_grantable
                      AND privilege.privilege_type IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                      )
                ), 0) AS owner_privilege_count,
                EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee<>relation.relowner
                       OR privilege.is_grantable
                       OR privilege.privilege_type NOT IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                       )
                ) AS unexpected_privilege
            FROM required_expectation_tables AS required
            LEFT JOIN pg_class AS relation
              ON relation.relname=required.table_name
             AND relation.relnamespace='private'::REGNAMESPACE
            LEFT JOIN pg_roles AS owner ON owner.oid=relation.relowner
        )
        SELECT 1
        FROM expectation_table_state
        WHERE oid IS NULL
           OR relkind<>'r'
           OR owner_name<>'postgres'
           OR NOT relrowsecurity
           OR owner_privilege_count<>8
           OR unexpected_privilege
    ) THEN
        v_failures := array_append(
            v_failures,
            'inherited_operational_contract_expectation_acl'
        );
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8ce5a3a090a1fc1d29dab85c65fe8be07d6efa9639950732d13cf88e854f91f1' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v7_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '245040e7bfe42122a551d112ec9d411999b519866e59c8cd537de02c85f9889a' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v8_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '0f34947cbc4126a929b69db07690ca4bc73fe8b5b9982190ebb6fe2ebbb2d179' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v9_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '6b14a7594f511f258d6b94863c369a67f08e142dc721429adc7cdab4d4e64f86' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v10_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8270ab9a1a4ee091e700dc6fd2d33f2af5fa79dc1de34f3afd391c626e076843' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v11_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:80b98274fd3e19fc0f578d7f6a79a5279275687fc92c373226d495152bdcd67d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'a70b46c8b13a88f51d795be3ae4bc759bcc14495fda1cab9629e5c9c86e66228' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '79e338cb42307acf37e395647f29dbb88df57fa8d65443cc976a30c566cff6d2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11_function');
    END IF;
    IF private.koaryu_release_operational_manifest_v11()
       <> '3e51d286b79754b3d37077ba3090be86d1c8fe38ec68422c65bfdbed636698ec' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:6389e87cdb8a5db79c540f38da4fdc71aa56ed10fa5d5533518f470bf52f7dfc' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6ee84c579e50be2b514ac00c975c1f60cf5f116e36adc27fe4296312e5188090' THEN
        v_failures:=array_append(v_failures,'resource_ownership_manifest_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6b54e02534f38bcd7bb6e6e811d9e01c9782958319514fee3f0a2f1d4ed167d4' THEN
        v_failures:=array_append(v_failures,'operational_contract_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'b16b633c6f78a2d5cf7d63f1d32679563ff2429197cc92a4d94e826b33a26035' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28_function');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
        v_failures := array_append(v_failures, 'operational_contract_v26');
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6500b8aaf8bb91cc91841f2bafaf3699b7ffa328ccaba4a0023721e3eb68f811' THEN
        v_failures := array_append(v_failures, 'operation_authorization_writer_function');
    END IF;
    IF has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, 'legacy_authorization_scope_execute');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND conname = 'studio_live_billing_authorizations_operation_set_exact'
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_constraint');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'text[]'
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'ARRAY[]::text[]'
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_column');
    END IF;
    IF private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.release',
                'connected_subscription_schedule.update'
            ]::TEXT[]
       ) IS DISTINCT FROM true
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.update',
                'connected_subscription_schedule.create'
            ]::TEXT[]
       ) IS DISTINCT FROM false
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.unknown'
            ]::TEXT[]
       ) IS DISTINCT FROM false THEN
        v_failures := array_append(
            v_failures,'operation_allowlist_schedule_semantics'
        );
    END IF;
    IF private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM '46d30248f99d376efa39420093ff6c01c6c22fd6dfcb903323c7a75f1cb419d0' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '57a017e4e7be92f023d31dc4a18e75b95c676765f42b54f9f5fb9f4b768ca3bd' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    IF private.koaryu_release_invoice_retry_preread_manifest_v32()
           <> '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
            v_failures := array_append(
                v_failures,'invoice_retry_preread_manifest_v32'
            );
        END IF;
        IF private.koaryu_release_invoice_retry_compatibility_manifest_v33()
       <> '0:8497daa806dcd7e33992fe8ca76f3207eb36b41e5a976be781e3bf33b22d4fdb' THEN
      v_failures:=array_append(v_failures,'invoice_retry_compatibility_manifest_v33');
    END IF;
    IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
       <> '0:70e87b852a84f9fcad61413ea8660fdf9d5adcb028ec03427f30d815e42526b6' THEN
      v_failures:=array_append(v_failures,'invoice_retry_closeout_manifest_v34');
    END IF;
    IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_manifest_v35');
    END IF;
    IF has_function_privilege('anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR has_function_privilege('authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR NOT has_function_privilege('service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE') THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_acl_v35');
    END IF;
    IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    IS DISTINCT FROM (SELECT recovery_manifest FROM private.koaryu_release_v36_expectations WHERE singleton) THEN
   v_failures:=array_append(v_failures,'payer_setup_recovery_manifest_v36');
 END IF;
 IF private.koaryu_release_adjustment_trigger_guard_manifest_v37()
      IS DISTINCT FROM (
        SELECT trigger_guard_manifest
        FROM private.koaryu_release_v37_expectations
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,'adjustment_trigger_guard_manifest_v37');
   END IF;

 IF EXISTS (
  SELECT 1 FROM (VALUES
  ('public.billing_payment_cohort(uuid,timestamptz,timestamptz)','5d6f683e3c56fe05db7e4101073d1a23792081192219cfa9eda4db8dcf734a1d'),
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','9af84c3c261a4ddb8aad9bc1c9cc332260fb1e31b1e7f51816b402339e2ad576'),
  ('public.billing_webhook_health(text,boolean,timestamptz)','3bdcc77c7d768e5ede8750900c0b75ac98bdffbb14ada059c580185133a9fd52')
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,'billing_landing_reads_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.idx_billing_invoices_studio_history','public.billing_invoices','CREATE INDEX idx_billing_invoices_studio_history ON public.billing_invoices USING btree (studio_id, created_at DESC, id DESC)'),
   ('public.idx_billing_payments_studio_history','public.billing_payments','CREATE INDEX idx_billing_payments_studio_history ON public.billing_payments USING btree (studio_id, created_at DESC, id DESC)')
  ) expected(index_name,table_name,definition)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(expected.index_name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.oid IS NULL OR c.relkind<>'i' OR c.relowner<>'postgres'::regrole
   OR i.indrelid IS DISTINCT FROM to_regclass(expected.table_name)
   OR i.indisvalid IS DISTINCT FROM true OR i.indisready IS DISTINCT FROM true
   OR i.indislive IS DISTINCT FROM true OR i.indisunique IS DISTINCT FROM false
   OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM expected.definition
 ) THEN v_failures:=array_append(v_failures,'billing_history_indexes_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid='private.koaryu_release_critical_surface_manifest_v16()'::REGPROCEDURE
    AND (p.proowner <> 'postgres'::REGROLE OR p.prosecdef OR p.provolatile <> 's'
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
         IS DISTINCT FROM '7fb0ba103de76167982cc96f0698d7516418ababb0892dc70d5c85e1d83efc0f'
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee <> p.proowner))
 ) THEN v_failures:=array_append(v_failures,'rank_command_manifest_v40_definition'); END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='recompute_billing_payer_balance_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.recompute_billing_payer_balance_v1(uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '78890d7907bb56bfdb337df262b17cc5144f8bd87d169df26a10fc048072670f'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_balance_rpc_v41');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='record_external_payment_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '150aedb400108d00c3fe90ca3de7d4ccde6df24ad8dda4f045cd6256af1ad13d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'external_payment_rpc_v43');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='write_billing_plan_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ac577f4bec60aecc52b4950eda7d8a8a469d6ac035d05afeabb74e3a9c8fe789'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_rpc_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='clear_studio_operational_data_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.clear_studio_operational_data_atomic(uuid,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '9bc03bc31ae70310497bfa020088045b604e113550d79e1a9c6c754b58ec2876'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_clear_coordination_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='claim_student_import_run_owned') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '34c8fbfd2e843be56034d686c2d90911c6c3938ca5e71da1616ea092a6edcddc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_claim_student_import_run_owned_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '8a735334eb60047f7dfd06490949b9286cc693eb1fd7990900aa58d8d8c9b661'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_actor') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_actor(uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='boolean'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'd04e6d08b7fd24eca4a46eddf8fbcaaeeef80d65431e55de5562a198ac09c331'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_actor_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_run(uuid,uuid,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.student_import_runs'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '95ea7bdd011af07a17f77120ab7227dd540a1e612b79e03f305f9f5c591002af'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '187d0eb3385fc7958efc0dedc1e2a39a61224b59596f4611339b6eb7da1c159d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run_v2') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '91c5c8919bd1ddfc2b9bfa82ca9cced577a94974e7854a17fc3156540216add2'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v2_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='finish_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.finish_student_import_run(uuid,text,text,jsonb,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '8f40eed2f27ce892b08a673121247a34e8eaf342e0fb9953b6c873945e16b032'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_finish_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, private']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '6d9d129040e0f3cb831cbb883c56ee6c8bf4c4b18aff59eb55c0ccf862ae2bd9'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='bind_student_import_rank_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'e428fbeb91f8457bf717917bd93685531188d49d25b003eb2bd6ab7f184f2e68'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_bind_student_import_rank_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_belts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '7b61469ec2de918d7f79effa3a52c590b3eef9416c2ba716f1b6d9cfc91669bb'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_belts_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_program_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '25fadfe0298192b7d2bf6c6210ad199743e7dd01d9dd035e7c9f36ba7c17794e'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_program_v1_v45');
    END IF;
    IF (SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'no_policies',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('private.student_import_receipts')
          AND relation.relkind='r') IS DISTINCT FROM '{"owner":"postgres","rls":false,"force_rls":false,"columns":[["import_run_id","uuid",true,null,"","",true],["kind","text",true,null,"","",true],["key","text",true,null,"","",true],["result_json","jsonb",true,null,"","",true],["created_at","timestamp with time zone",true,"now()","","",true]],"acl":[["postgres","postgres","DELETE",false],["postgres","postgres","INSERT",false],["postgres","postgres","MAINTAIN",false],["postgres","postgres","REFERENCES",false],["postgres","postgres","SELECT",false],["postgres","postgres","TRIGGER",false],["postgres","postgres","TRUNCATE",false],["postgres","postgres","UPDATE",false],["service_role","postgres","INSERT",false],["service_role","postgres","SELECT",false]],"constraints":[["student_import_receipts_import_run_id_fkey","f",true,false,false,"FOREIGN KEY (import_run_id) REFERENCES public.student_import_runs(id) ON DELETE CASCADE"],["student_import_receipts_key_check","c",true,false,false,"CHECK (((char_length(key) >= 1) AND (char_length(key) <= 512)))"],["student_import_receipts_kind_check","c",true,false,false,"CHECK ((kind = ANY (ARRAY[''student''::text, ''program''::text, ''ladder''::text, ''rank''::text])))"],["student_import_receipts_pkey","p",true,false,false,"PRIMARY KEY (import_run_id, kind, key)"],["student_import_receipts_result_json_check","c",true,false,false,"CHECK ((jsonb_typeof(result_json) = ''object''::text))"]],"indexes":[["student_import_receipts_pkey",true,true,true,true,"CREATE UNIQUE INDEX student_import_receipts_pkey ON private.student_import_receipts USING btree (import_run_id, kind, key)"]],"no_policies":true,"no_user_triggers":true}'::JSONB
       OR (SELECT jsonb_build_array(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
                attribute.attnotnull,pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL)
            FROM pg_catalog.pg_attribute attribute LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=pg_catalog.to_regclass('public.student_import_runs')
              AND attribute.attname='receipts_enabled' AND NOT attribute.attisdropped)
          IS DISTINCT FROM '["boolean",true,"false","","",true]'::JSONB THEN
        v_failures:=array_append(v_failures,'import_receipts_v45');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       IS DISTINCT FROM '0:dc6043dd0992042b9e27d0fb73a49f4abe0acd06a6b9bfb500d68e7e85ab5daf' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'feed7c0421cbeb5bcb2555837dd1c244367f180c8a884380f2f281ef919c82ee' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_definition_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='begin_billing_enrollment_activation_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'a104d7696ec9a711358697783ca065c9d78233ffa4c63d77633c8fcf42ff5e59'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_begin_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='reject_billing_autopay_activation_without_provider_v31') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'b2bee4e53471d0a949ff4533f7ab14938c4fc919e8c97ce8d767f854bc876b44'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_rejection_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.billing_subscriptions'::REGCLASS
          AND a.attname IN ('currency','billing_interval') AND NOT a.attisdropped
          AND a.atttypid='text'::REGTYPE AND NOT a.attnotnull AND d.oid IS NULL
          AND a.attidentity='' AND a.attgenerated='') IS DISTINCT FROM 2 THEN
        v_failures:=array_append(v_failures,'subscription_terms_v49');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_invoice_collection_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_invoice_collection_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '40d16d06464c028c1bd4a27089163181865cd65a8ce963b1738ee0abe3c5eacc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'invoice_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_payer_balance_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_payer_balance_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'f81f1d839e26e5fe0abe9bf84af7bcb58c654f88cea4107f4e97b1cf993492b4'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='list_billing_payers_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.list_billing_payers_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='jsonb'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ca4a6d2d6657cf82900a315b492af687a42be2fd1a6a3cad296119f6be72ff8d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_read_projection_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_attention_count_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_attention_count_v1(uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='integer'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '4e57973f97038e57ec411c502960453b07d5f59374ab0e2bc856a42ecbb7e036'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'billing_attention_count_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='update_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.update_lead_atomic(uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '141eff02dc1b430336270aee0aa48e281f42b8e1a82b2656bfd4e31b58b615cb'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'update_lead_atomic_v52');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='follow_up_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'f36021e09be3f208ba2d538e25efae1c97862b06c72f283755dd0db5f9ed3f30'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'follow_up_lead_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'policies',(SELECT jsonb_agg(jsonb_build_array(policy.polname,policy.polcmd,policy.polpermissive,
                (SELECT jsonb_agg(pg_catalog.pg_get_userbyid(role_oid)::TEXT ORDER BY pg_catalog.pg_get_userbyid(role_oid)::TEXT COLLATE "C") FROM unnest(policy.polroles) role_oid),
                pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid)) ORDER BY policy.polname COLLATE "C")
                FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('public.lead_follow_up_operations')
          AND relation.relkind='r')::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '796b4c0fe4d033966248b78138776b6695dfbc80bdab7e0e9026b6c9745318cb' THEN
        v_failures:=array_append(v_failures,'lead_follow_up_operations_v52');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '350a7ffbea0fab5fe570d6243a5b22fa0ed6d528053bebf5ccfb2f6e7433cec6' THEN
        v_failures := array_append(v_failures, 'dashboard_summary_facts_v53');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(jsonb_build_object(
        'signature',required.signature,'exists',function.oid IS NOT NULL,
        'definition',pg_catalog.pg_get_functiondef(function.oid),'body',function.prosrc,
        'owner',pg_catalog.pg_get_userbyid(function.proowner),'language',language.lanname,
        'volatility',function.provolatile,'security_definer',function.prosecdef,
        'strict',function.proisstrict,'parallel',function.proparallel,
        'config',function.proconfig,'result',pg_catalog.pg_get_function_result(function.oid),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
            ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT COLLATE "C",acl.privilege_type,acl.is_grantable)
            FROM pg_catalog.aclexplode(COALESCE(function.proacl,pg_catalog.acldefault('f',function.proowner))) acl)
        ) ORDER BY required.signature COLLATE "C")
        FROM (VALUES
            ('public.student_business_date(uuid)'),
            ('public.validate_student_birth_date()'),
            ('public.set_student_is_minor()'),
            ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
            ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')
        ) required(signature)
        LEFT JOIN pg_catalog.pg_proc function ON function.oid=pg_catalog.to_regprocedure(required.signature)
        LEFT JOIN pg_catalog.pg_language language ON language.oid=function.prolang),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',required.name,'expected_function',required.signature,
        'exists',trigger_row.oid IS NOT NULL,
        'binding_matches',trigger_row.tgfoid=pg_catalog.to_regprocedure(required.signature),
        'definition',pg_catalog.pg_get_triggerdef(trigger_row.oid),
        'enabled',trigger_row.tgenabled,'type',trigger_row.tgtype,
        'arguments',encode(trigger_row.tgargs,'hex'),
        'internal',trigger_row.tgisinternal,'constraint',trigger_row.tgconstraint<>0,
        'deferrable',trigger_row.tgdeferrable,'initially_deferred',trigger_row.tginitdeferred
        ) ORDER BY required.name COLLATE "C")
        FROM (VALUES ('set_students_is_minor','public.set_student_is_minor()'),
            ('validate_students_birth_date','public.validate_student_birth_date()')) required(name,signature)
        LEFT JOIN pg_catalog.pg_trigger trigger_row
          ON trigger_row.tgrelid=pg_catalog.to_regclass('public.students') AND trigger_row.tgname=required.name)
    ))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM 'fad46920fe7205c3de8d9a3cf04994de52c257e3dd5d1d1b66710566470a4029' THEN
        v_failures:=array_append(v_failures,'student_profile_facts_v55');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='convert_lead_to_student_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '1bb565ea30d71939049387d0d34ab89c6656c5c76bc07aedf60e95b55acef011'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'convert_lead_to_student_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('public.automation_rules'),('public.automation_deliveries'),
    ('public.automation_suppressions'),('private.automation_email_credentials')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM 'd80c19a977860ed634cd2959a4bbf1cdf4c2af0bca7829e2c033092301f0b405' THEN
        v_failures:=array_append(v_failures,'automation_tables_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES
    ('private.automation_delivery_immutable()'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)')
) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '306e359fc1af2adf2d894c0beba02618c4fa16d6725909345a5abdaaa051d642' THEN
        v_failures:=array_append(v_failures,'automation_functions_v56');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v56'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v36()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v37();
    IF v.ready IS TRUE AND v.migration_count = 151 AND v.migration_head = '20261004220435'
       AND v.manifest_version = 'release-db-attestation-v56'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 67
       AND v.pending_versions[cardinality(v.pending_versions)] = '20261004220435' THEN
        RETURN QUERY SELECT TRUE, 150, '20260930192626'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v55'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v55'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v37() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v37() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v37() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v36() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v36() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v36() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v37();
    IF v.migration_count IS DISTINCT FROM 150 OR v.migration_head IS DISTINCT FROM '20260930192626'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v56',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V56 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
