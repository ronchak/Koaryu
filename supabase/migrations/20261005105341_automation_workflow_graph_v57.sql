-- Complete V57 workflow execution, sender ownership, synthetic mail and operational clear.
-- Exact V56 predecessor, observed from the unchanged source on the owned clean PG17 base.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to((SELECT prosrc FROM pg_catalog.pg_proc
        WHERE oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v37()')),
        'UTF8'),'sha256'),'hex') IS DISTINCT FROM '01dde42f07bfc77761f44bee98f00017d5f70e2c5c19f17c2c502d08394aa755' THEN
        RAISE EXCEPTION 'V57 requires the reviewed V56 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v37();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 151
        OR v.migration_head IS DISTINCT FROM '20261004220435'
        OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v56'
        OR v.security_failures IS DISTINCT FROM ARRAY[]::TEXT[]
        OR v.pending_versions IS DISTINCT FROM ARRAY['20260727100000','20260727110000','20260801050957','20260801060000','20260801070000','20260801080000','20260801090000','20260801091000','20260801092000','20260801093000','20260801094000','20260801105313','20260801112153','20260801115044','20260801123112','20260801131844','20260814043325','20260814103046','20260814105424','20260814114500','20260814152000','20260814170000','20260814183000','20260814200000','20260814213000','20260815220402','20260816012723','20260820012533','20260820025759','20260820060216','20260822193000','20260823193155','20260824190500','20260825042838','20260825043911','20260826030234','20260826030249','20260826051527','20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435']::TEXT[] THEN
        RAISE EXCEPTION 'V57 requires a fully verified V56 predecessor.';
    END IF;
END;
$predecessor$;

-- Freeze the observed baseline before installing source callbacks.
DO $migration_lock$
BEGIN
    LOCK TABLE public.students,public.student_program_memberships,public.belt_ranks IN ACCESS EXCLUSIVE MODE;
END;
$migration_lock$;

-- Hosted projects provisioned with Supabase's legacy default function privileges
-- retain service_role EXECUTE on these retained trigger functions; clean replays
-- never grant it. Trigger firing does not check the caller's EXECUTE privilege,
-- so converge every target to the canonical postgres-only ACL before attesting.
REVOKE EXECUTE ON FUNCTION
    public.update_updated_at_column(),
    public.validate_attendance_program_integrity(),
    public.validate_billing_adjustment_refs(),
    public.validate_billing_dispute_refs(),
    public.validate_billing_invoice_item_refs(),
    public.validate_billing_invoice_refs(),
    public.validate_billing_payer_guardian(),
    public.validate_billing_payment_refs(),
    public.validate_billing_plan_program(),
    public.validate_billing_refund_refs(),
    public.validate_billing_subscription_refs(),
    public.validate_class_session_program_integrity(),
    public.validate_class_template_program_integrity(),
    public.validate_lead_program_integrity(),
    public.validate_student_billing_enrollment(),
    public.validate_student_guardian_tenant_integrity(),
    public.validate_student_profile_tenant_integrity()
FROM service_role;

-- Mechanical projection of workflow_catalog.CATALOG: full maps for these five keys.
-- Reproduce with json.dumps(projection,sort_keys=True,separators=(',',':'),ensure_ascii=True).
-- catalog-source-sha256: f575ad4f3676e0d6d2134c888c9d24ac756bff05a1525f5af95b51185385cb7a
CREATE FUNCTION private.workflow_catalog_v1() RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $catalog$
SELECT $json${"delay_fields":{"belt_test.starts_at":{"id":"belt_test.starts_at","label":"Belt test start","trigger_ids":["belt_test.approved","belt_test.upcoming"],"value_type":"datetime"},"trial.starts_at":{"id":"trial.starts_at","label":"Trial start","trigger_ids":["trial.scheduled","trial.upcoming"],"value_type":"datetime"}},"fields":{"belt_test.approval_current":{"id":"belt_test.approval_current","label":"Belt test approval is current","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"belt_test.event_scheduled":{"id":"belt_test.event_scheduled","label":"Belt test is scheduled","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"invoice.collection_method":{"id":"invoice.collection_method","label":"Invoice collection method","nullable":true,"operators":["eq","neq","in","not_in"],"value_type":"enum","values":["send_invoice","charge_automatically"]},"invoice.open_balance":{"id":"invoice.open_balance","label":"Invoice has an open balance","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"invoice.overdue":{"id":"invoice.overdue","label":"Invoice is overdue","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"lead.source":{"id":"lead.source","label":"Lead source","nullable":false,"operators":["eq","neq","in","not_in"],"value_type":"enum","values":["walk_in","referral","social","search","website","other"]},"lead.stage":{"id":"lead.stage","label":"Lead stage","nullable":false,"operators":["eq","neq","in","not_in"],"value_type":"enum","values":["inquiry","trial_scheduled","trial_completed","offer_sent","enrolled","closed_lost"]},"lead.unconverted":{"id":"lead.unconverted","label":"Lead is unconverted","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"program.id":{"id":"program.id","label":"Program","nullable":true,"operators":["eq","neq","in","not_in"],"value_type":"uuid"},"promotion.rank_id":{"id":"promotion.rank_id","label":"Promoted rank","nullable":false,"operators":["eq","neq","in","not_in"],"value_type":"uuid"},"student.is_minor":{"id":"student.is_minor","label":"Student is a minor","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"student.on_hold":{"id":"student.on_hold","label":"Student is on hold","nullable":false,"operators":["eq","neq"],"value_type":"boolean"},"student.status":{"id":"student.status","label":"Student status","nullable":false,"operators":["eq","neq","in","not_in"],"value_type":"enum","values":["active","trialing","inactive","paused","canceled"]},"trial.status":{"id":"trial.status","label":"Trial status","nullable":false,"operators":["eq","neq","in","not_in"],"value_type":"enum","values":["scheduled","completed","no_show","canceled"]}},"recipients":{"assigned_staff":{"id":"assigned_staff","label":"Assigned staff member"},"invoice_payer":{"id":"invoice_payer","label":"Invoice payer"},"lead_or_guardian":{"id":"lead_or_guardian","label":"Lead or guardian"},"student_or_guardian":{"id":"student_or_guardian","label":"Student or guardian"}},"triggers":{"belt_test.approved":{"delay_fields":["belt_test.starts_at"],"field_ids":["student.status","student.on_hold","student.is_minor","program.id","belt_test.event_scheduled","belt_test.approval_current"],"id":"belt_test.approved","label":"Student is approved for a belt test","recipient_ids":["student_or_guardian"],"simulation_entity_type":"belt_test_recipient","subject_kind":"belt_test","supports_lead_follow_up":false,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","student_first_name","event_name","event_start","event_location"]},"belt_test.upcoming":{"delay_fields":["belt_test.starts_at"],"field_ids":["student.status","student.on_hold","student.is_minor","program.id","belt_test.event_scheduled","belt_test.approval_current"],"id":"belt_test.upcoming","label":"Approved belt test is approaching","recipient_ids":["student_or_guardian"],"simulation_entity_type":"belt_test_recipient","subject_kind":"belt_test","supports_lead_follow_up":false,"supports_offset":true,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","student_first_name","event_name","event_start","event_location"]},"invoice.overdue":{"delay_fields":[],"field_ids":["invoice.overdue","invoice.open_balance","invoice.collection_method"],"id":"invoice.overdue","label":"Invoice becomes overdue","recipient_ids":["invoice_payer"],"simulation_entity_type":"invoice","subject_kind":"invoice","supports_lead_follow_up":false,"supports_offset":false,"supports_program_filter":false,"template_variables":["studio_name","recipient_name","invoice_number","invoice_balance","invoice_due_date"]},"invoice.payment_failed":{"delay_fields":[],"field_ids":["invoice.overdue","invoice.open_balance","invoice.collection_method"],"id":"invoice.payment_failed","label":"When a new payment first fails","recipient_ids":["invoice_payer"],"simulation_entity_type":"payment","subject_kind":"invoice","supports_lead_follow_up":false,"supports_offset":false,"supports_program_filter":false,"template_variables":["studio_name","recipient_name","invoice_number","invoice_balance","invoice_due_date"]},"lead.created":{"delay_fields":[],"field_ids":["lead.stage","lead.source","lead.unconverted","program.id"],"id":"lead.created","label":"Lead is created","recipient_ids":["lead_or_guardian","assigned_staff"],"simulation_entity_type":"lead","subject_kind":"lead","supports_lead_follow_up":true,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","lead_first_name"]},"lead.stage_changed":{"delay_fields":[],"field_ids":["lead.stage","lead.source","lead.unconverted","program.id"],"id":"lead.stage_changed","label":"Lead stage changes","recipient_ids":["lead_or_guardian","assigned_staff"],"simulation_entity_type":"lead","subject_kind":"lead","supports_lead_follow_up":true,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","lead_first_name"]},"student.enrolled":{"delay_fields":[],"field_ids":["student.status","student.on_hold","student.is_minor"],"id":"student.enrolled","label":"Student first enrolls","recipient_ids":["student_or_guardian"],"simulation_entity_type":"student","subject_kind":"student","supports_lead_follow_up":false,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","student_first_name"]},"student.promoted":{"delay_fields":[],"field_ids":["student.status","student.on_hold","student.is_minor","program.id","promotion.rank_id"],"id":"student.promoted","label":"Student earns a rank promotion","recipient_ids":["student_or_guardian"],"simulation_entity_type":"promotion","subject_kind":"promotion","supports_lead_follow_up":false,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","student_first_name","rank_name","program_name"]},"trial.completed":{"delay_fields":[],"field_ids":["lead.stage","lead.source","lead.unconverted","trial.status","program.id"],"id":"trial.completed","label":"Trial is completed","recipient_ids":["lead_or_guardian","assigned_staff"],"simulation_entity_type":"trial_appointment","subject_kind":"trial","supports_lead_follow_up":true,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","lead_first_name","trial_start","trial_location"]},"trial.no_show":{"delay_fields":[],"field_ids":["lead.stage","lead.source","lead.unconverted","trial.status","program.id"],"id":"trial.no_show","label":"Trial is marked as missed","recipient_ids":["lead_or_guardian","assigned_staff"],"simulation_entity_type":"trial_appointment","subject_kind":"trial","supports_lead_follow_up":true,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","lead_first_name","trial_start","trial_location"]},"trial.scheduled":{"delay_fields":["trial.starts_at"],"field_ids":["lead.stage","lead.source","lead.unconverted","trial.status","program.id"],"id":"trial.scheduled","label":"Trial is scheduled","recipient_ids":["lead_or_guardian","assigned_staff"],"simulation_entity_type":"trial_appointment","subject_kind":"trial","supports_lead_follow_up":true,"supports_offset":false,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","lead_first_name","trial_start","trial_location"]},"trial.upcoming":{"delay_fields":["trial.starts_at"],"field_ids":["lead.stage","lead.source","lead.unconverted","trial.status","program.id"],"id":"trial.upcoming","label":"Trial is approaching","recipient_ids":["lead_or_guardian","assigned_staff"],"simulation_entity_type":"trial_appointment","subject_kind":"trial","supports_lead_follow_up":true,"supports_offset":true,"supports_program_filter":true,"template_variables":["studio_name","recipient_name","lead_first_name","trial_start","trial_location"]}},"variables":{"event_location":{"fallback":"Please contact the studio for the location","id":"event_location","label":"Belt test location","value_type":"string"},"event_name":{"fallback":null,"id":"event_name","label":"Belt test name","value_type":"string"},"event_start":{"fallback":null,"id":"event_start","label":"Belt test date and time","value_type":"string"},"invoice_balance":{"fallback":null,"id":"invoice_balance","label":"Current invoice balance","value_type":"string"},"invoice_due_date":{"fallback":"No due date listed","id":"invoice_due_date","label":"Invoice due date","value_type":"string"},"invoice_number":{"fallback":"not numbered","id":"invoice_number","label":"Invoice number","value_type":"string"},"lead_first_name":{"fallback":null,"id":"lead_first_name","label":"Lead first name","value_type":"string"},"program_name":{"fallback":"your program","id":"program_name","label":"Promotion program name","value_type":"string"},"rank_name":{"fallback":null,"id":"rank_name","label":"Promoted rank name","value_type":"string"},"recipient_name":{"fallback":"there","id":"recipient_name","label":"Recipient name","value_type":"string"},"student_first_name":{"fallback":null,"id":"student_first_name","label":"Student first name","value_type":"string"},"studio_name":{"fallback":null,"id":"studio_name","label":"Studio name","value_type":"string"},"trial_location":{"fallback":"Please contact the studio for the location","id":"trial_location","label":"Trial location","value_type":"string"},"trial_start":{"fallback":null,"id":"trial_start","label":"Trial date and time","value_type":"string"}}}$json$::JSONB
$catalog$;

CREATE TABLE public.automation_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description)<=500),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    draft_graph JSONB NOT NULL CHECK (jsonb_typeof(draft_graph)='object'),
    draft_layout JSONB NOT NULL CHECK (jsonb_typeof(draft_layout)='object'),
    validation_issues JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(validation_issues)='array'),
    published_version_id UUID,
    published_version_number BIGINT CHECK (published_version_number>0),
    published_at TIMESTAMPTZ CHECK (isfinite(published_at)),
    enrollment_epoch BIGINT NOT NULL DEFAULT 0 CHECK (enrollment_epoch>=0),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
    UNIQUE(studio_id,id),
    CHECK ((published_version_id IS NULL AND published_version_number IS NULL AND published_at IS NULL)
        OR (published_version_id IS NOT NULL AND published_version_number IS NOT NULL AND published_at IS NOT NULL)),
    CHECK (status NOT IN ('active','paused') OR published_version_id IS NOT NULL),
    CHECK (status<>'active' OR enrollment_epoch>0)
);
CREATE INDEX automation_workflows_list ON public.automation_workflows(studio_id,created_at DESC,id DESC);
CREATE INDEX automation_workflows_active ON public.automation_workflows(studio_id,id) WHERE status='active';
CREATE TABLE public.automation_workflow_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL,
    version_number BIGINT NOT NULL CHECK (version_number>0),
    graph JSONB NOT NULL CHECK (jsonb_typeof(graph)='object' AND NOT graph ? 'layout'),
    graph_sha256 TEXT NOT NULL CHECK (graph_sha256 ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
    published_by UUID,
    FOREIGN KEY(studio_id,workflow_id) REFERENCES public.automation_workflows(studio_id,id) ON DELETE CASCADE,
    UNIQUE(workflow_id,version_number),
    UNIQUE(studio_id,workflow_id,id),
    UNIQUE(studio_id,workflow_id,id,version_number)
);
ALTER TABLE public.automation_workflows ADD CONSTRAINT automation_workflows_published_version_fk
    FOREIGN KEY(studio_id,id,published_version_id,published_version_number)
    REFERENCES public.automation_workflow_versions(studio_id,workflow_id,id,version_number);
CREATE TABLE public.automation_workflow_activations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL,
    version_id UUID NOT NULL,
    epoch BIGINT NOT NULL CHECK (epoch>0),
    active_from TIMESTAMPTZ NOT NULL CHECK (isfinite(active_from)),
    retired_at TIMESTAMPTZ CHECK (isfinite(retired_at) AND retired_at>=active_from),
    cancelled_at TIMESTAMPTZ CHECK (isfinite(cancelled_at) AND cancelled_at>=active_from),
    FOREIGN KEY(studio_id,workflow_id) REFERENCES public.automation_workflows(studio_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,workflow_id,version_id) REFERENCES public.automation_workflow_versions(studio_id,workflow_id,id) ON DELETE CASCADE,
    UNIQUE(studio_id,workflow_id,version_id,epoch,id),
    CHECK (cancelled_at IS NULL OR (retired_at IS NOT NULL AND cancelled_at>=retired_at))
);
CREATE UNIQUE INDEX automation_workflow_activations_open ON public.automation_workflow_activations(workflow_id)
    WHERE retired_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX automation_workflow_activations_epoch ON public.automation_workflow_activations(studio_id,workflow_id,epoch);
CREATE TABLE private.automation_workflow_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 500),
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('student','promotion','lead','trial','invoice','belt_test')),
    subject_id UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL CHECK (isfinite(occurred_at)),
    context JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(context)='object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
    UNIQUE(studio_id,id),
    UNIQUE(studio_id,event_type,source_key)
);
CREATE TABLE public.automation_workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL,
    version_id UUID NOT NULL,
    event_id UUID NOT NULL,
    activation_id UUID NOT NULL,
    epoch BIGINT NOT NULL CHECK (epoch>0),
    current_node_id TEXT NOT NULL CHECK (current_node_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','waiting','claimed','running','sending','completed','cancelled','failed','unknown')),
    next_due_at TIMESTAMPTZ DEFAULT clock_timestamp() CHECK (next_due_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    claim_token UUID,
    lease_expires_at TIMESTAMPTZ CHECK (isfinite(lease_expires_at)),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    reason TEXT CHECK (reason ~ '^[a-z][a-z0-9_]{0,79}$'),
    deferral_count INTEGER NOT NULL DEFAULT 0 CHECK (deferral_count BETWEEN 0 AND 7),
    cancel_requested_at TIMESTAMPTZ CHECK (cancel_requested_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    cancel_reason TEXT CHECK (cancel_reason ~ '^[a-z][a-z0-9_]{0,79}$'),
    CHECK ((cancel_requested_at IS NULL)=(cancel_reason IS NULL)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (created_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (updated_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    FOREIGN KEY(studio_id,workflow_id) REFERENCES public.automation_workflows(studio_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,workflow_id,version_id) REFERENCES public.automation_workflow_versions(studio_id,workflow_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,event_id) REFERENCES private.automation_workflow_events(studio_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,workflow_id,version_id,epoch,activation_id)
        REFERENCES public.automation_workflow_activations(studio_id,workflow_id,version_id,epoch,id) ON DELETE CASCADE,
    UNIQUE(workflow_id,event_id),
    UNIQUE(studio_id,id),
    CHECK ((state IN ('queued','waiting','claimed','running'))=(next_due_at IS NOT NULL)),
    CHECK ((claim_token IS NULL)=(lease_expires_at IS NULL)),
    CHECK (state NOT IN ('claimed','running','sending') OR claim_token IS NOT NULL),
    CHECK (state NOT IN ('queued','waiting','completed','cancelled','failed') OR claim_token IS NULL)
);
CREATE INDEX automation_workflow_runs_due ON public.automation_workflow_runs(next_due_at,created_at,id)
    WHERE state IN ('queued','waiting','claimed','running');
CREATE INDEX automation_workflow_runs_workflow ON public.automation_workflow_runs(studio_id,workflow_id,state);
CREATE INDEX automation_workflow_runs_event ON public.automation_workflow_runs(studio_id,event_id);
CREATE INDEX automation_workflow_runs_activation ON public.automation_workflow_runs(activation_id);
CREATE INDEX automation_workflow_runs_list ON public.automation_workflow_runs(studio_id,workflow_id,created_at DESC,id DESC);
CREATE TABLE private.automation_command_operations (
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    command TEXT NOT NULL CHECK (length(command) BETWEEN 1 AND 100),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
    entity_id UUID,
    result JSONB NOT NULL CHECK (jsonb_typeof(result)='object'),
    committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(committed_at)),
    PRIMARY KEY(studio_id,operation_id)
);

CREATE FUNCTION private.workflow_immutable_record_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_versions_immutable BEFORE UPDATE ON public.automation_workflow_versions
    FOR EACH ROW EXECUTE FUNCTION private.workflow_immutable_record_v1();
CREATE TRIGGER automation_workflow_events_immutable BEFORE UPDATE ON private.automation_workflow_events
    FOR EACH ROW EXECUTE FUNCTION private.workflow_immutable_record_v1();
CREATE TRIGGER automation_command_operations_immutable BEFORE UPDATE ON private.automation_command_operations
    FOR EACH ROW EXECUTE FUNCTION private.workflow_immutable_record_v1();
CREATE FUNCTION private.workflow_activation_immutable_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF ROW(NEW.id,NEW.studio_id,NEW.workflow_id,NEW.version_id,NEW.epoch,NEW.active_from)
        IS DISTINCT FROM ROW(OLD.id,OLD.studio_id,OLD.workflow_id,OLD.version_id,OLD.epoch,OLD.active_from)
        OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
        OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_activations_immutable BEFORE UPDATE ON public.automation_workflow_activations
    FOR EACH ROW EXECUTE FUNCTION private.workflow_activation_immutable_v1();
CREATE FUNCTION private.workflow_run_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF ROW(NEW.id,NEW.studio_id,NEW.workflow_id,NEW.version_id,NEW.event_id,NEW.activation_id,NEW.epoch,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.studio_id,OLD.workflow_id,OLD.version_id,OLD.event_id,OLD.activation_id,OLD.epoch,OLD.created_at) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    IF OLD.cancel_requested_at IS NOT NULL AND ROW(NEW.cancel_requested_at,NEW.cancel_reason)
        IS DISTINCT FROM ROW(OLD.cancel_requested_at,OLD.cancel_reason) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_runs_identity BEFORE UPDATE ON public.automation_workflow_runs
    FOR EACH ROW EXECUTE FUNCTION private.workflow_run_identity_v1();

CREATE FUNCTION private.workflow_semantic_graph_v1(p_graph JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('schema_version',p_graph->'schema_version',
        'nodes',coalesce((SELECT jsonb_agg(n ORDER BY (n->>'id') COLLATE "C") FROM jsonb_array_elements(p_graph->'nodes') n),'[]'::JSONB),
        'edges',coalesce((SELECT jsonb_agg(e ORDER BY (e->>'id') COLLATE "C") FROM jsonb_array_elements(p_graph->'edges') e),'[]'::JSONB))
$$;
CREATE FUNCTION private.workflow_hash_v1(p_value JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT encode(extensions.digest(convert_to(p_value::TEXT,'UTF8'),'sha256'),'hex')
$$;
CREATE FUNCTION private.workflow_json_keys_v1(p_value JSONB,p_allowed TEXT[],p_required TEXT[] DEFAULT ARRAY[]::TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN false ELSE
        p_value ?& p_required AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE NOT k=ANY(p_allowed)) END
$$;
CREATE FUNCTION private.workflow_blank_v1(p_value JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT p_value IS NULL OR p_value='null'::JSONB OR
        (jsonb_typeof(p_value)='string' AND btrim(p_value#>>'{}',U&'\0009\000a\000b\000c\000d\001c\001d\001e\001f\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000')='')
$$;
-- Keep meaningful name text byte-for-byte while matching Python's nonblank boundary.
ALTER TABLE public.automation_workflows ADD CONSTRAINT automation_workflows_name_nonblank
    CHECK (private.workflow_blank_v1(to_jsonb(name)) IS FALSE);

CREATE FUNCTION private.workflow_integer_v1(p_value JSONB,p_min BIGINT,p_max BIGINT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT CASE WHEN jsonb_typeof(p_value)='number' AND p_value::TEXT ~ '^-?[0-9]+$'
        THEN p_value::TEXT::NUMERIC BETWEEN p_min AND p_max ELSE false END
$$;
CREATE FUNCTION private.workflow_typed_value_v1(p_value JSONB,p_metadata JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    RETURN CASE p_metadata->>'value_type'
        WHEN 'string' THEN jsonb_typeof(p_value)='string'
        WHEN 'boolean' THEN jsonb_typeof(p_value)='boolean'
        WHEN 'number' THEN jsonb_typeof(p_value)='number'
        WHEN 'enum' THEN jsonb_typeof(p_value)='string' AND p_metadata->'values' ? (p_value#>>'{}')
        WHEN 'uuid' THEN jsonb_typeof(p_value)='string' AND (p_value#>>'{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ELSE false END;
END $$;

-- SQL independently checks every save boundary. Diagnostics contain only fixed text
-- and validated graph identifiers. Incomplete drafts keep their original JSON keys.
CREATE FUNCTION private.workflow_validate_v1(p_graph JSONB,p_layout JSONB,p_executable BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
    cat JSONB:=private.workflow_catalog_v1(); n JSONB; e JSONB; c JSONB; v JSONB; t JSONB;
    meta JSONB; item JSONB; pos RECORD; k TEXT; kind TEXT; choice TEXT; group_name TEXT;
    applicability TEXT; op TEXT; node_id TEXT; edge_id TEXT; field_name TEXT; template TEXT;
    token TEXT[]; ids TEXT[]:=ARRAY[]::TEXT[]; edge_ids TEXT[]:=ARRAY[]::TEXT[];
    selected JSONB:='[]'; ntrigger INTEGER; nend INTEGER; outgoing INTEGER; bad BOOLEAN;
    issue_code TEXT:='invalid_structure';
BEGIN
    IF p_executable IS NULL OR NOT private.workflow_json_keys_v1(p_graph,
        ARRAY['schema_version','nodes','edges'],ARRAY['schema_version','nodes','edges'])
        OR NOT private.workflow_integer_v1(p_graph->'schema_version',1,1)
        OR jsonb_typeof(p_graph->'nodes') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_graph->'edges') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE='P5701';
    END IF;
    IF jsonb_array_length(p_graph->'nodes')>40 OR jsonb_array_length(p_graph->'edges')>60
        OR NOT private.workflow_json_keys_v1(p_layout,ARRAY['positions'])
        OR (p_layout ? 'positions' AND jsonb_typeof(p_layout->'positions') IS DISTINCT FROM 'object') THEN
        RAISE EXCEPTION USING ERRCODE='P5701';
    END IF;
    FOR n IN SELECT value FROM jsonb_array_elements(p_graph->'nodes') LOOP
        IF NOT private.workflow_json_keys_v1(n,ARRAY['id','type','config'],ARRAY['id','type','config'])
            OR jsonb_typeof(n->'id') IS DISTINCT FROM 'string' OR n->>'id' !~ '^[A-Za-z0-9_-]{1,64}$'
            OR (n->>'id')=ANY(ids) OR jsonb_typeof(n->'type') IS DISTINCT FROM 'string'
            OR n->>'type' NOT IN ('trigger','condition','delay','email','lead_follow_up','end')
            OR jsonb_typeof(n->'config') IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION USING ERRCODE='P5701';
        END IF;
        ids:=array_append(ids,n->>'id');
        IF n->>'type'='trigger' AND cat->'triggers' ? (n->'config'->>'event_type') THEN
            selected:=selected||jsonb_build_array(cat->'triggers'->(n->'config'->>'event_type'));
        END IF;
    END LOOP;
    FOR e IN SELECT value FROM jsonb_array_elements(p_graph->'edges') LOOP
        IF NOT private.workflow_json_keys_v1(e,ARRAY['id','source','target','port'],ARRAY['id','source','target','port'])
            OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string' OR e->>'id' !~ '^[A-Za-z0-9_-]{1,64}$'
            OR (e->>'id')=ANY(edge_ids) OR jsonb_typeof(e->'source') IS DISTINCT FROM 'string'
            OR jsonb_typeof(e->'target') IS DISTINCT FROM 'string'
            OR NOT (e->>'source')=ANY(ids) OR NOT (e->>'target')=ANY(ids)
            OR jsonb_typeof(e->'port') IS DISTINCT FROM 'string' OR e->>'port' NOT IN ('next','yes','no') THEN
            RAISE EXCEPTION USING ERRCODE='P5701';
        END IF;
        edge_ids:=array_append(edge_ids,e->>'id');
    END LOOP;
    FOR pos IN SELECT key,value FROM jsonb_each(coalesce(p_layout->'positions','{}')) LOOP
        IF NOT pos.key=ANY(ids) OR NOT private.workflow_json_keys_v1(pos.value,ARRAY['x','y'],ARRAY['x','y'])
            OR jsonb_typeof(pos.value->'x') IS DISTINCT FROM 'number'
            OR jsonb_typeof(pos.value->'y') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION USING ERRCODE='P5701';
        END IF;
        IF abs((pos.value->>'x')::NUMERIC)>100000 OR abs((pos.value->>'y')::NUMERIC)>100000 THEN
            RAISE EXCEPTION USING ERRCODE='P5701';
        END IF;
    END LOOP;
    FOR n IN SELECT value FROM jsonb_array_elements(p_graph->'nodes') ORDER BY value->>'id' LOOP
        node_id:=n->>'id'; kind:=n->>'type'; c:=n->'config';
        issue_code:='invalid_config'; group_name:=NULL; applicability:=NULL; choice:=NULL;
        IF NOT private.workflow_json_keys_v1(c,CASE kind
            WHEN 'trigger' THEN ARRAY['event_type','program_id','offset_minutes']
            WHEN 'condition' THEN ARRAY['field','operator','value']
            WHEN 'delay' THEN CASE c->>'mode' WHEN 'duration' THEN ARRAY['mode','minutes'] WHEN 'until' THEN ARRAY['mode','field','offset_minutes'] ELSE ARRAY[]::TEXT[] END
            WHEN 'email' THEN ARRAY['recipient','subject_template','body_template','reply_to_email']
            WHEN 'lead_follow_up' THEN ARRAY['due_in_days','note'] ELSE ARRAY[]::TEXT[] END) THEN
            RAISE EXCEPTION USING ERRCODE='P5701';
        END IF;
        -- Optional catalog selections permit null/blank but never wrong JSON types.
        FOREACH k IN ARRAY ARRAY['event_type','field','operator','recipient'] LOOP
            IF c ? k AND c->k<>'null' AND (jsonb_typeof(c->k)<>'string' OR length(c->>k)>100) THEN
                RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
        END LOOP;
        IF kind='trigger' THEN
            group_name:='triggers'; choice:=c->>'event_type';
            IF c ? 'program_id' AND c->'program_id'<>'null' AND
                (jsonb_typeof(c->'program_id')<>'string' OR c->>'program_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
                RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
            IF c ? 'offset_minutes' AND NOT private.workflow_integer_v1(c->'offset_minutes',-129600,-1) THEN
                RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
            meta:=cat->'triggers'->choice;
            IF meta IS NOT NULL THEN
                IF (c ? 'offset_minutes' AND NOT (meta->>'supports_offset')::BOOLEAN)
                    OR (c->'program_id'<>'null' AND NOT (meta->>'supports_program_filter')::BOOLEAN)
                    OR (p_executable AND (meta->>'supports_offset')::BOOLEAN AND NOT c ? 'offset_minutes') THEN
                    RAISE EXCEPTION USING ERRCODE='P5701';
                END IF;
            END IF;
        ELSIF kind='condition' THEN
            group_name:='fields'; choice:=c->>'field'; applicability:='field_ids'; op:=c->>'operator'; v:=c->'value';
            IF NOT private.workflow_blank_v1(c->'operator') AND op NOT IN ('eq','neq','gt','gte','lt','lte','in','not_in') THEN
                RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
            IF p_executable AND private.workflow_blank_v1(c->'operator') THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            IF v IS NOT NULL AND v<>'null' THEN
                IF jsonb_typeof(v) NOT IN ('string','number','boolean','array') THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                IF jsonb_typeof(v)='array' AND jsonb_array_length(v)>100 THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v)='array' THEN v ELSE jsonb_build_array(v) END) LOOP
                    IF jsonb_typeof(item) NOT IN ('string','number','boolean') OR (jsonb_typeof(item)='string' AND length(item#>>'{}')>500) THEN
                        RAISE EXCEPTION USING ERRCODE='P5701';
                    END IF;
                END LOOP;
            END IF;
            meta:=cat->'fields'->choice;
            IF meta IS NOT NULL THEN
                IF NOT private.workflow_blank_v1(c->'operator') AND
                    (NOT meta->'operators' ? op OR (op IN ('gt','gte','lt','lte') AND meta->>'value_type' NOT IN ('number','datetime'))
                        OR (op IN ('in','not_in') AND meta->>'value_type' NOT IN ('enum','uuid'))) THEN
                    RAISE EXCEPTION USING ERRCODE='P5701';
                END IF;
                IF v IS NULL OR v='null' THEN
                    IF p_executable AND NOT (v IS NOT NULL AND coalesce((meta->>'nullable')::BOOLEAN,false) AND op IN ('eq','neq')) THEN
                        RAISE EXCEPTION USING ERRCODE='P5701';
                    END IF;
                ELSIF jsonb_typeof(v)='array' THEN
                    IF jsonb_array_length(v)=0 OR NOT (op IN ('in','not_in') OR
                        (private.workflow_blank_v1(c->'operator') AND meta->>'value_type' IN ('enum','uuid'))) THEN
                        RAISE EXCEPTION USING ERRCODE='P5701';
                    END IF;
                    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
                        IF NOT private.workflow_typed_value_v1(item,meta) THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                    END LOOP;
                ELSIF op IN ('in','not_in') OR NOT private.workflow_typed_value_v1(v,meta) THEN
                    RAISE EXCEPTION USING ERRCODE='P5701';
                END IF;
            ELSIF p_executable AND private.workflow_blank_v1(v) THEN RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
        ELSIF kind='delay' THEN
            IF jsonb_typeof(c->'mode') IS DISTINCT FROM 'string' OR c->>'mode' NOT IN ('duration','until') THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            IF c->>'mode'='duration' THEN
                IF c->'minutes' IS NOT NULL AND c->'minutes'<>'null' AND NOT private.workflow_integer_v1(c->'minutes',0,129600) THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                IF p_executable AND (c->'minutes' IS NULL OR c->'minutes'='null') THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            ELSE
                group_name:='delay_fields'; choice:=c->>'field'; applicability:='delay_fields';
                IF c ? 'offset_minutes' AND NOT private.workflow_integer_v1(c->'offset_minutes',-129600,129600) THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                IF cat->'delay_fields' ? choice THEN
                    FOR t IN SELECT value FROM jsonb_array_elements(selected) LOOP
                        IF NOT cat->'delay_fields'->choice->'trigger_ids' ? (t->>'id') THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                    END LOOP;
                END IF;
            END IF;
        ELSIF kind='email' THEN
            group_name:='recipients'; choice:=c->>'recipient'; applicability:='recipient_ids';
            FOREACH k IN ARRAY ARRAY['subject_template','body_template','reply_to_email'] LOOP
                IF c ? k AND (jsonb_typeof(c->k) IS DISTINCT FROM 'string' OR length(c->>k)>CASE k WHEN 'subject_template' THEN 200 WHEN 'body_template' THEN 5000 ELSE 254 END) THEN
                    RAISE EXCEPTION USING ERRCODE='P5701';
                END IF;
            END LOOP;
            IF c ? 'reply_to_email' AND btrim(c->>'reply_to_email',' ')<>'' AND private.automation_normalize_email(c->>'reply_to_email') IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
            FOREACH field_name IN ARRAY ARRAY['subject_template','body_template'] LOOP
                template:=coalesce(c->>field_name,'');
                IF p_executable AND private.workflow_blank_v1(to_jsonb(template)) THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                IF regexp_replace(template,'\{\{([a-z][a-z0-9_]*)\}\}','','g') ~ '[{}]'
                    OR EXISTS(SELECT 1 FROM regexp_split_to_table(template,'') ch
                        WHERE ch<>'' AND (ascii(ch) BETWEEN 127 AND 159 OR ascii(ch)<32 AND
                            (field_name='subject_template' OR ascii(ch) NOT IN (9,10)))) THEN
                    RAISE EXCEPTION USING ERRCODE='P5701';
                END IF;
                FOR token IN SELECT regexp_matches(template,'\{\{([a-z][a-z0-9_]*)\}\}','g') LOOP
                    IF NOT cat->'variables' ? token[1] THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                    FOR t IN SELECT value FROM jsonb_array_elements(selected) LOOP
                        IF NOT t->'template_variables' ? token[1] THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                    END LOOP;
                END LOOP;
            END LOOP;
        ELSIF kind='lead_follow_up' THEN
            IF c ? 'note' AND (jsonb_typeof(c->'note') IS DISTINCT FROM 'string' OR length(c->>'note')>1000) THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            IF c->'due_in_days' IS NOT NULL AND c->'due_in_days'<>'null' AND NOT private.workflow_integer_v1(c->'due_in_days',0,90) THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            IF p_executable AND (c->'due_in_days' IS NULL OR c->'due_in_days'='null') THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            FOR t IN SELECT value FROM jsonb_array_elements(selected) LOOP
                IF NOT (t->>'supports_lead_follow_up')::BOOLEAN THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            END LOOP;
        END IF;
        IF group_name IS NOT NULL THEN
            IF private.workflow_blank_v1(to_jsonb(choice)) THEN
                IF p_executable THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
            ELSIF NOT cat->group_name ? choice THEN RAISE EXCEPTION USING ERRCODE='P5701';
            ELSIF applicability IS NOT NULL THEN
                FOR t IN SELECT value FROM jsonb_array_elements(selected) LOOP
                    IF NOT t->applicability ? choice THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
                END LOOP;
            END IF;
        END IF;
    END LOOP;
    node_id:=NULL; issue_code:='invalid_topology';
    IF p_executable THEN
        SELECT count(*) FILTER(WHERE value->>'type'='trigger'),count(*) FILTER(WHERE value->>'type'='end')
            INTO ntrigger,nend FROM jsonb_array_elements(p_graph->'nodes');
        IF ntrigger<>1 OR nend=0 THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
        FOR n IN SELECT value FROM jsonb_array_elements(p_graph->'nodes') LOOP
            node_id:=n->>'id'; kind:=n->>'type';
            SELECT count(*),coalesce(bool_or(value->>'port'<>CASE WHEN kind='condition' THEN value->>'port' ELSE 'next' END
                OR (kind='condition' AND value->>'port' NOT IN ('yes','no'))),false)
                INTO outgoing,bad FROM jsonb_array_elements(p_graph->'edges') WHERE value->>'source'=node_id;
            IF outgoing<>(CASE kind WHEN 'condition' THEN 2 WHEN 'end' THEN 0 ELSE 1 END) OR bad
                OR (kind='condition' AND (SELECT count(DISTINCT value->>'port') FROM jsonb_array_elements(p_graph->'edges') WHERE value->>'source'=node_id)<>2)
                OR (kind='trigger' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_graph->'edges') WHERE value->>'target'=node_id)) THEN
                RAISE EXCEPTION USING ERRCODE='P5701';
            END IF;
        END LOOP;
        node_id:=NULL;
        -- UNION bounds transitive closure to 40*40 pairs, including cyclic drafts.
        WITH RECURSIVE edges AS (SELECT value->>'source' s,value->>'target' t FROM jsonb_array_elements(p_graph->'edges')),
        reach(s,t) AS (SELECT edges.s,edges.t FROM edges UNION SELECT r.s,e.t FROM reach r JOIN edges e ON e.s=r.t)
        SELECT EXISTS(SELECT 1 FROM reach WHERE reach.s=reach.t) OR EXISTS(
            SELECT 1 FROM jsonb_array_elements(p_graph->'nodes') AS nod(value)
            WHERE (nod.value->>'type'<>'trigger' AND NOT EXISTS(SELECT 1 FROM reach r JOIN jsonb_array_elements(p_graph->'nodes') tr ON tr->>'id'=r.s AND tr->>'type'='trigger' WHERE r.t=nod.value->>'id'))
               OR (nod.value->>'type'<>'end' AND NOT EXISTS(SELECT 1 FROM reach r JOIN jsonb_array_elements(p_graph->'nodes') en ON en->>'id'=r.t AND en->>'type'='end' WHERE r.s=nod.value->>'id')))
            INTO bad;
        IF bad THEN RAISE EXCEPTION USING ERRCODE='P5701'; END IF;
    END IF;
    RETURN '[]'::JSONB;
EXCEPTION WHEN SQLSTATE 'P5701' THEN
    RETURN jsonb_build_array(jsonb_build_object('code',issue_code,
        'message',CASE issue_code WHEN 'invalid_structure' THEN 'Use the supported workflow data format.'
            WHEN 'invalid_config' THEN 'Complete the supported node settings before running this workflow.'
            ELSE 'Connect one trigger to every node and an end without cycles.' END,
        'node_id',node_id,'edge_id',NULL,'field',NULL));
END $$;

CREATE FUNCTION private.workflow_require_actor_v1(p_studio_id UUID,p_actor_id UUID,p_allow_lead_manager BOOLEAN DEFAULT false)
RETURNS TEXT LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_role TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR NOT private.lock_student_import_actor(p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    IF (SELECT count(*) FROM public.staff_roles WHERE user_id=p_actor_id)<>1 THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    SELECT role INTO v_role FROM public.staff_roles WHERE studio_id=p_studio_id AND user_id=p_actor_id
        AND archived_at IS NULL AND (role='admin' OR (p_allow_lead_manager AND role='front_desk')) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED'; END IF;
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    PERFORM 1 FROM public.studio_subscriptions WHERE studio_id=p_studio_id FOR SHARE;
    IF NOT private.automation_core_entitled(p_studio_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    RETURN v_role;
END $$;

CREATE FUNCTION private.workflow_require_graph_tenant_v1(p_studio_id UUID,p_graph JSONB) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE n JSONB; v JSONB; kind TEXT;
BEGIN
    -- Call only after structural validation. Lock current referenced parents while
    -- writing; the stored literal never supplies tenant authority at execution.
    FOR n IN SELECT value FROM jsonb_array_elements(p_graph->'nodes') ORDER BY value->>'id' LOOP
        kind:=CASE WHEN n->>'type'='trigger' THEN 'program.id' ELSE n->'config'->>'field' END;
        IF n->>'type'='trigger' THEN v:=n->'config'->'program_id';
        ELSIF n->>'type'='condition' AND kind IN ('program.id','promotion.rank_id') THEN v:=n->'config'->'value';
        ELSE CONTINUE; END IF;
        IF v IS NULL OR v='null' THEN CONTINUE; END IF;
        FOR v IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v)='array' THEN v ELSE jsonb_build_array(v) END) ORDER BY value::TEXT LOOP
            BEGIN
                IF kind='program.id' THEN
                    PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=(v#>>'{}')::UUID FOR KEY SHARE NOWAIT;
                ELSE
                    PERFORM 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=(v#>>'{}')::UUID FOR KEY SHARE NOWAIT;
                END IF;
                IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            EXCEPTION WHEN lock_not_available THEN
                -- Publication already holds its workflow. Waiting for a deleted
                -- source reference could invert source -> workflow cancellation.
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
            END;
        END LOOP;
    END LOOP;
END $$;

-- A validation read observes all references in one statement snapshot. It does
-- not reserve them for a later command, whose receipt-owning checks stay atomic.
CREATE FUNCTION public.validate_automation_workflow_v1(
    p_studio_id UUID,p_actor_id UUID,p_graph JSONB,p_layout JSONB DEFAULT '{}'
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_issues JSONB;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    v_issues:=private.workflow_validate_v1(p_graph,p_layout,false);
    IF v_issues<>'[]'::JSONB THEN
        RETURN jsonb_build_object('payload',jsonb_build_object('valid',false,'issues',v_issues));
    END IF;
    -- Draft safety includes typed UUIDs, even when an operator or trigger choice
    -- is incomplete. Only validated nodes reach the reference casts below.
    WITH nodes AS (
        SELECT n->>'id' node_id,
            CASE WHEN n->>'type'='trigger' THEN 'program.id' ELSE n->'config'->>'field' END kind,
            CASE WHEN n->>'type'='trigger' THEN 'config.program_id' ELSE 'config.value' END field,
            CASE WHEN n->>'type'='trigger' THEN n->'config'->'program_id' ELSE n->'config'->'value' END value
        FROM jsonb_array_elements(p_graph->'nodes') n
        WHERE n->>'type'='trigger' OR n->>'type'='condition' AND n->'config'->>'field' IN ('program.id','promotion.rank_id')
    ), refs AS (
        SELECT n.node_id,n.kind,n.field,(v.value#>>'{}')::UUID id FROM nodes n
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN n.value IS NULL OR n.value='null' THEN '[]'::JSONB
            WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE jsonb_build_array(n.value) END) v(value)
    ), issues AS (
        SELECT jsonb_build_object('code','reference_unavailable','message','Choose an available program or rank.',
            'node_id',r.node_id,'edge_id',NULL,'field',r.field) issue
        FROM refs r
        LEFT JOIN public.programs p ON r.kind='program.id' AND p.studio_id=p_studio_id AND p.id=r.id
        LEFT JOIN public.belt_ranks b ON r.kind='promotion.rank_id' AND b.studio_id=p_studio_id AND b.id=r.id
        WHERE r.kind='program.id' AND p.id IS NULL OR r.kind='promotion.rank_id' AND b.id IS NULL
        UNION
        SELECT value FROM jsonb_array_elements(private.workflow_validate_v1(p_graph,p_layout,true))
    )
    SELECT coalesce(jsonb_agg(issue ORDER BY (issue->>'node_id') COLLATE "C" NULLS FIRST,
        (issue->>'field') COLLATE "C" NULLS FIRST,(issue->>'code') COLLATE "C",issue::TEXT COLLATE "C"),'[]'::JSONB)
        INTO v_issues FROM issues;
    RETURN jsonb_build_object('payload',jsonb_build_object('valid',v_issues='[]'::JSONB,'issues',v_issues));
END $$;

CREATE FUNCTION private.workflow_detail_v1(p_studio_id UUID,p_workflow_id UUID) RETURNS JSONB
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',w.id,'name',w.name,'description',w.description,'status',w.status,
        'revision',w.revision,'draft_graph',w.draft_graph,'draft_layout',w.draft_layout,
        'validation_issues',w.validation_issues,'published_version_id',w.published_version_id,
        'published_version_number',w.published_version_number,'published_at',w.published_at,'updated_at',w.updated_at,
        'has_unpublished_changes',w.published_version_id IS NULL OR
            private.workflow_semantic_graph_v1(w.draft_graph) IS DISTINCT FROM private.workflow_semantic_graph_v1(v.graph),
        'pending_run_count',(SELECT count(*) FROM public.automation_workflow_runs r
            WHERE r.studio_id=w.studio_id AND r.workflow_id=w.id AND r.state IN ('queued','waiting','claimed','running')),
        'sending_run_count',(SELECT count(*) FROM public.automation_workflow_runs r
            WHERE r.studio_id=w.studio_id AND r.workflow_id=w.id AND r.state='sending'))
    FROM public.automation_workflows w LEFT JOIN public.automation_workflow_versions v
        ON v.studio_id=w.studio_id AND v.workflow_id=w.id AND v.id=w.published_version_id
    WHERE w.studio_id=p_studio_id AND w.id=p_workflow_id
$$;

CREATE FUNCTION private.workflow_cancel_pending_v1(p_studio_id UUID,p_workflow_id UUID,p_at TIMESTAMPTZ,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    -- Caller holds the workflow. Future claim/begin implementations take that same
    -- parent before runs, so cancellation cannot leave a usable stale claim.
    PERFORM 1 FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND workflow_id=p_workflow_id
        AND state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY id FOR UPDATE;
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY(SELECT id FROM public.automation_workflow_runs
        WHERE studio_id=p_studio_id AND workflow_id=p_workflow_id AND state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY id),p_at,p_reason);
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,p_at),cancelled_at=p_at
        WHERE studio_id=p_studio_id AND workflow_id=p_workflow_id AND cancelled_at IS NULL;
END $$;

CREATE FUNCTION private.workflow_mutate_v1(
    p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,p_operation_id UUID,p_expected_revision BIGINT,
    p_action TEXT,p_name TEXT,p_description TEXT,p_graph JSONB,p_layout JSONB,p_cancel_pending BOOLEAN,
    p_start_replay_only BOOLEAN DEFAULT false
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE w public.automation_workflows; receipt private.automation_command_operations;
    v_fingerprint TEXT; v_request JSONB; v_result JSONB; v_at TIMESTAMPTZ; v_version UUID;
    v_number BIGINT; v_graph JSONB; v_issues JSONB; v_epoch BIGINT; v_target UUID:=p_workflow_id;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_operation_id IS NULL OR p_action IS NULL OR p_action NOT IN ('create','save','publish','start','pause','archive')
        OR p_cancel_pending IS NULL OR (p_cancel_pending AND p_action<>'publish')
        OR p_start_replay_only IS NULL OR (p_start_replay_only AND p_action<>'start')
        OR (p_action='create' AND (p_workflow_id IS NOT NULL OR p_expected_revision IS NOT NULL))
        OR (p_action<>'create' AND (p_workflow_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    v_request:=jsonb_build_object('command','workflow.'||p_action,'studio_id',p_studio_id,'actor_id',p_actor_id,
        'workflow_id',p_workflow_id,'expected_revision',p_expected_revision,'cancel_pending',p_cancel_pending);
    IF p_action IN ('create','save') THEN
        IF p_name IS NULL OR private.workflow_blank_v1(to_jsonb(p_name)) OR length(p_name)>120
            OR p_description IS NULL OR length(p_description)>500
            OR private.workflow_validate_v1(p_graph,p_layout,false)<>'[]'::JSONB THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        v_request:=v_request||jsonb_build_object('name',p_name,'description',p_description,
            'graph',private.workflow_semantic_graph_v1(p_graph),'layout',p_layout);
    END IF;
    v_fingerprint:=private.workflow_hash_v1(v_request);
    -- This lock covers the absent-key case without committing a started receipt.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    IF FOUND THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>'workflow.'||p_action OR receipt.request_fingerprint<>v_fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    IF p_start_replay_only THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF p_action<>'create' AND NOT EXISTS(SELECT 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=p_workflow_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND';
    END IF;
    IF p_action IN ('create','start') AND NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('automation.workflow.admission:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    IF p_action='create' THEN
        IF (SELECT count(*) FROM public.automation_workflows WHERE studio_id=p_studio_id)>=100 THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        PERFORM private.workflow_require_graph_tenant_v1(p_studio_id,p_graph);
        v_issues:=private.workflow_validate_v1(p_graph,p_layout,true);
        INSERT INTO public.automation_workflows(studio_id,name,description,draft_graph,draft_layout,validation_issues,created_by)
            VALUES(p_studio_id,p_name,p_description,p_graph,p_layout,v_issues,p_actor_id) RETURNING id INTO v_target;
    ELSE
        SELECT * INTO w FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=p_workflow_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        IF w.revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT'; END IF;
        IF w.status='archived' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        v_at:=clock_timestamp();
        IF p_action='save' THEN
            PERFORM private.workflow_require_graph_tenant_v1(p_studio_id,p_graph);
            v_issues:=private.workflow_validate_v1(p_graph,p_layout,true);
            UPDATE public.automation_workflows SET name=p_name,description=p_description,draft_graph=p_graph,draft_layout=p_layout,
                validation_issues=v_issues,revision=revision+1,updated_at=v_at WHERE id=w.id;
        ELSIF p_action='publish' THEN
            IF private.workflow_validate_v1(w.draft_graph,w.draft_layout,true)<>'[]'::JSONB THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            PERFORM private.workflow_require_graph_tenant_v1(p_studio_id,w.draft_graph);
            v_at:=clock_timestamp();
            v_number:=coalesce(w.published_version_number,0)+1;
            v_graph:=private.workflow_semantic_graph_v1(w.draft_graph);
            INSERT INTO public.automation_workflow_versions(studio_id,workflow_id,version_number,graph,graph_sha256,published_by,created_at)
                VALUES(p_studio_id,w.id,v_number,v_graph,private.workflow_hash_v1(v_graph),p_actor_id,v_at) RETURNING id INTO v_version;
            v_epoch:=w.enrollment_epoch;
            IF p_cancel_pending THEN
                PERFORM private.workflow_cancel_pending_v1(p_studio_id,w.id,v_at,'workflow_republished');
                v_epoch:=v_epoch+1;
            ELSIF w.status='active' THEN
                UPDATE public.automation_workflow_activations SET retired_at=v_at
                    WHERE studio_id=p_studio_id AND workflow_id=w.id AND retired_at IS NULL AND cancelled_at IS NULL;
            END IF;
            IF w.status='active' THEN
                INSERT INTO public.automation_workflow_activations(studio_id,workflow_id,version_id,epoch,active_from)
                    VALUES(p_studio_id,w.id,v_version,v_epoch,v_at);
            END IF;
            UPDATE public.automation_workflows SET published_version_id=v_version,published_version_number=v_number,published_at=v_at,
                status=CASE WHEN status='draft' THEN 'paused' ELSE status END,enrollment_epoch=v_epoch,
                validation_issues='[]',revision=revision+1,updated_at=v_at WHERE id=w.id;
        ELSIF p_action='start' THEN
            IF w.status<>'paused' OR w.published_version_id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            SELECT graph INTO v_graph FROM public.automation_workflow_versions WHERE studio_id=p_studio_id AND workflow_id=w.id AND id=w.published_version_id;
            IF v_graph IS NULL OR private.workflow_validate_v1(v_graph,'{}',true)<>'[]'::JSONB THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            PERFORM private.workflow_require_graph_tenant_v1(p_studio_id,v_graph);
            IF (SELECT count(*) FROM public.automation_workflows WHERE studio_id=p_studio_id AND status='active')>=25 THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            v_at:=clock_timestamp();
            INSERT INTO public.automation_workflow_activations(studio_id,workflow_id,version_id,epoch,active_from)
                VALUES(p_studio_id,w.id,w.published_version_id,w.enrollment_epoch+1,v_at);
            UPDATE public.automation_workflows SET status='active',enrollment_epoch=enrollment_epoch+1,revision=revision+1,updated_at=v_at WHERE id=w.id;
        ELSIF p_action='pause' THEN
            -- A fresh pause on paused is a state conflict. Same-operation replay
            -- above remains successful and returns the original committed detail.
            IF w.status<>'active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            PERFORM private.workflow_cancel_pending_v1(p_studio_id,w.id,v_at,'workflow_paused');
            UPDATE public.automation_workflows SET status='paused',revision=revision+1,updated_at=v_at WHERE id=w.id;
        ELSE
            PERFORM private.workflow_cancel_pending_v1(p_studio_id,w.id,v_at,'workflow_archived');
            UPDATE public.automation_workflows SET status='archived',revision=revision+1,updated_at=v_at WHERE id=w.id;
        END IF;
    END IF;
    v_result:=private.workflow_detail_v1(p_studio_id,v_target);
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'workflow.'||p_action,v_fingerprint,'workflow',v_target,v_result);
    RETURN jsonb_build_object('payload',v_result,'operation_id',p_operation_id,'replayed',false);
END $$;

CREATE FUNCTION public.create_automation_workflow_v1(p_studio_id UUID,p_actor_id UUID,p_operation_id UUID,p_name TEXT,p_description TEXT,p_graph JSONB,p_layout JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT private.workflow_mutate_v1(p_studio_id,p_actor_id,NULL,p_operation_id,NULL,'create',p_name,p_description,p_graph,p_layout,false)
$$;
CREATE FUNCTION public.save_automation_workflow_v1(p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,p_operation_id UUID,p_expected_revision BIGINT,p_name TEXT,p_description TEXT,p_graph JSONB,p_layout JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT private.workflow_mutate_v1(p_studio_id,p_actor_id,p_workflow_id,p_operation_id,p_expected_revision,'save',p_name,p_description,p_graph,p_layout,false)
$$;
CREATE FUNCTION public.command_automation_workflow_v1(p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,p_operation_id UUID,p_expected_revision BIGINT,p_action TEXT,p_cancel_pending BOOLEAN DEFAULT false,p_start_replay_only BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_action IS NULL OR p_action NOT IN ('publish','start','pause','archive') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN private.workflow_mutate_v1(p_studio_id,p_actor_id,p_workflow_id,p_operation_id,p_expected_revision,p_action,NULL,NULL,NULL,NULL,p_cancel_pending,p_start_replay_only);
END $$;
CREATE FUNCTION public.get_automation_workflow_v1(p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v JSONB;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    v:=private.workflow_detail_v1(p_studio_id,p_workflow_id);
    IF v IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('payload',v);
END $$;
CREATE FUNCTION private.workflow_trigger_event_type_v1(p_graph JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT CASE WHEN count(*)=1 AND private.workflow_catalog_v1()->'triggers' ? max(n->'config'->>'event_type')
        THEN max(n->'config'->>'event_type') ELSE NULL END
    FROM jsonb_array_elements(p_graph->'nodes') n WHERE n->>'type'='trigger'
$$;
CREATE FUNCTION public.list_automation_workflows_v1(p_studio_id UUID,p_actor_id UUID,p_limit INTEGER DEFAULT 50,p_cursor JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_at TIMESTAMPTZ; v_id UUID; v_items JSONB:='[]'; v_next JSONB; r RECORD; v_count INTEGER:=0;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    IF p_cursor IS NOT NULL THEN
        IF NOT private.workflow_json_keys_v1(p_cursor,ARRAY['created_at','id'],ARRAY['created_at','id'])
            OR jsonb_typeof(p_cursor->'created_at') IS DISTINCT FROM 'string' OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string'
            OR p_cursor->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR length(p_cursor->>'created_at')>40 OR p_cursor->>'created_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        BEGIN
            v_at:=(p_cursor->>'created_at')::TIMESTAMPTZ; v_id:=(p_cursor->>'id')::UUID;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END;
        IF NOT isfinite(v_at) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    END IF;
    -- Capture the complete summary in this statement's snapshot. Calling a
    -- VOLATILE row reader in the loop would mix later revisions with old labels.
    FOR r IN SELECT w.id,w.created_at,jsonb_build_object(
            'id',w.id,'name',w.name,'description',w.description,'status',w.status,'revision',w.revision,
            'trigger_event_type',private.workflow_trigger_event_type_v1(coalesce(v.graph,w.draft_graph)),
            'draft_trigger_event_type',private.workflow_trigger_event_type_v1(w.draft_graph),
            'published_version_id',w.published_version_id,'published_version_number',w.published_version_number,
            'published_at',w.published_at,'created_at',w.created_at,'updated_at',w.updated_at,
            'has_unpublished_changes',w.published_version_id IS NULL OR
                private.workflow_semantic_graph_v1(w.draft_graph) IS DISTINCT FROM private.workflow_semantic_graph_v1(v.graph),
            'pending_run_count',(SELECT count(*) FROM public.automation_workflow_runs pending
                WHERE pending.studio_id=w.studio_id AND pending.workflow_id=w.id AND pending.state IN ('queued','waiting','claimed','running')),
            'sending_run_count',(SELECT count(*) FROM public.automation_workflow_runs sending
                WHERE sending.studio_id=w.studio_id AND sending.workflow_id=w.id AND sending.state='sending')) summary
        FROM public.automation_workflows w
        LEFT JOIN public.automation_workflow_versions v ON v.studio_id=w.studio_id AND v.workflow_id=w.id AND v.id=w.published_version_id
        WHERE w.studio_id=p_studio_id AND (p_cursor IS NULL OR (w.created_at,w.id)<(v_at,v_id))
        ORDER BY w.created_at DESC,w.id DESC LIMIT p_limit+1 LOOP
        v_count:=v_count+1;
        IF v_count>p_limit THEN RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',v_next,'has_more',true)); END IF;
        v_items:=v_items||jsonb_build_array(r.summary);
        v_next:=jsonb_build_object('created_at',r.created_at,'id',r.id);
    END LOOP;
    RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',NULL,'has_more',false));
END $$;
CREATE FUNCTION public.get_automation_operation_v1(p_studio_id UUID,p_actor_id UUID,p_operation_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_role TEXT; r private.automation_command_operations;
BEGIN
    v_role:=private.workflow_require_actor_v1(p_studio_id,p_actor_id,true);
    SELECT * INTO r FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF v_role<>'admin' AND NOT (r.command='lead.create' AND r.actor_id=p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('operation_id',r.operation_id,'state','committed','command',r.command,
        'entity_type',r.entity_type,'entity_id',r.entity_id,'result',r.result,'committed_at',r.committed_at));
END $$;

DO $table_privileges$
DECLARE v TEXT; schema_name TEXT;
BEGIN
    FOREACH v IN ARRAY ARRAY['automation_workflows','automation_workflow_versions','automation_workflow_activations',
        'automation_workflow_runs','automation_workflow_events','automation_command_operations'] LOOP
        schema_name:=CASE WHEN v IN ('automation_workflow_events','automation_command_operations') THEN 'private' ELSE 'public' END;
        EXECUTE format('ALTER TABLE %I.%I OWNER TO postgres',schema_name,v);
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',schema_name,v);
        EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC,anon,authenticated,service_role',schema_name,v);
        EXECUTE format('GRANT SELECT,INSERT%s ON TABLE %I.%I TO service_role',
            CASE WHEN v IN ('automation_workflows','automation_workflow_activations','automation_workflow_runs') THEN ',UPDATE' ELSE '' END,schema_name,v);
        EXECUTE format('CREATE POLICY reject_client_access ON %I.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING (false) WITH CHECK (false)',schema_name,v);
        IF schema_name='public' THEN
            EXECUTE format('CREATE POLICY reject_ambiguous_staff_membership_access ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.has_unambiguous_studio_membership())) WITH CHECK ((SELECT private.has_unambiguous_studio_membership()))',v);
        END IF;
    END LOOP;
END;
$table_privileges$;
DO $function_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.proname
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_catalog_v1','workflow_immutable_record_v1',
            'workflow_activation_immutable_v1','workflow_run_identity_v1','workflow_semantic_graph_v1',
            'workflow_hash_v1','workflow_json_keys_v1','workflow_blank_v1','workflow_integer_v1',
            'workflow_typed_value_v1','workflow_validate_v1','workflow_require_actor_v1',
            'workflow_require_graph_tenant_v1','workflow_trigger_event_type_v1','workflow_detail_v1','workflow_cancel_pending_v1','workflow_mutate_v1'))
        OR (n.nspname='public' AND p.proname IN ('create_automation_workflow_v1','save_automation_workflow_v1',
            'command_automation_workflow_v1','get_automation_workflow_v1','list_automation_workflows_v1','get_automation_operation_v1',
            'validate_automation_workflow_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.proname NOT IN ('workflow_immutable_record_v1','workflow_activation_immutable_v1','workflow_run_identity_v1') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
        END IF;
    END LOOP;
END;
$function_privileges$;

-- Installation and history registration are one transaction. The final guard
-- below verifies the complete installed V57 contracts before registration.

-- Trial scheduling uses resolved instants. The display zone never reinterprets
-- an already resolved offset. All serialized instants stay in Python's UTC range.
CREATE FUNCTION private.automation_instant_v1(p_value JSONB) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v TEXT; v_at TIMESTAMPTZ; v_offset TEXT; v_local TEXT;
BEGIN
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    v:=p_value#>>'{}';
    IF length(v)>64 OR v !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- Python truncates excess fractional precision; PostgreSQL otherwise rounds.
    v:=regexp_replace(v,'(\.\d{6})\d+','\1');
    BEGIN
        -- Python permits aware offsets up to 23:59; PostgreSQL's direct
        -- timestamptz parser has a smaller displacement bound. Resolve the
        -- already-validated numeric offset explicitly, without local-zone rules.
        v_offset:=CASE WHEN right(v,1)='Z' THEN '+00:00' ELSE right(v,6) END;
        v_local:=left(v,length(v)-CASE WHEN right(v,1)='Z' THEN 1 ELSE 6 END);
        v_at:=(v_local::TIMESTAMP AT TIME ZONE 'UTC')
            - CASE WHEN left(v_offset,1)='-' THEN -1 ELSE 1 END
            * make_interval(hours=>substring(v_offset,2,2)::INTEGER,mins=>substring(v_offset,5,2)::INTEGER);
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END;
    IF NOT isfinite(v_at) OR v_at<TIMESTAMPTZ '0001-01-01 00:00:00+00'
        OR v_at>TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN v_at;
END $$;
CREATE FUNCTION private.automation_utc_text_v1(p_at TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;
CREATE FUNCTION private.automation_timezone_v1(p_value JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v TEXT;
BEGIN
    v:=p_value#>>'{}';
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR length(v)>128
        OR v !~ '^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$'
        OR v ~ '(^|/)(\.|\.\.)(/|$)' OR split_part(v,'/',1) IN ('localtime','posixrules','posix','right')
        OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN v;
END $$;

ALTER TABLE public.leads ADD CONSTRAINT leads_studio_id_id_key UNIQUE(studio_id,id);
CREATE TABLE public.lead_trial_appointments (
    rebooking_superseded BOOLEAN NOT NULL DEFAULT false,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL,
    program_id UUID,
    starts_at TIMESTAMPTZ NOT NULL CHECK (starts_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    timezone TEXT NOT NULL CHECK (private.automation_timezone_v1(to_jsonb(timezone))=timezone),
    location TEXT NOT NULL DEFAULT '' CHECK (length(location)<=240),
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','no_show','canceled')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (created_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (updated_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    FOREIGN KEY(studio_id,lead_id) REFERENCES public.leads(studio_id,id) ON DELETE CASCADE,
    UNIQUE(studio_id,id),
    CHECK (ends_at>starts_at AND ends_at-starts_at<=INTERVAL '24 hours')
);
CREATE UNIQUE INDEX lead_trial_appointments_scheduled ON public.lead_trial_appointments(studio_id,lead_id) WHERE status='scheduled';
CREATE INDEX lead_trial_appointments_list ON public.lead_trial_appointments(studio_id,lead_id,created_at DESC,id DESC);
CREATE INDEX automation_workflow_events_subject ON private.automation_workflow_events(studio_id,subject_kind,subject_id);

CREATE FUNCTION private.trial_appointment_payload_v1(p_row public.lead_trial_appointments) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',p_row.id,'studio_id',p_row.studio_id,'lead_id',p_row.lead_id,
        'program_id',p_row.program_id,'starts_at',private.automation_utc_text_v1(p_row.starts_at),
        'ends_at',private.automation_utc_text_v1(p_row.ends_at),'timezone',p_row.timezone,'location',p_row.location,
        'status',p_row.status,'revision',p_row.revision,'created_by',p_row.created_by,
        'created_at',private.automation_utc_text_v1(p_row.created_at),'updated_at',private.automation_utc_text_v1(p_row.updated_at))
$$;
CREATE FUNCTION private.workflow_cancel_source_pending_v1(p_studio_id UUID,p_subject_kind TEXT,p_subject_id UUID,p_at TIMESTAMPTZ,p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    -- Caller owns the authoritative source parents. Every affected workflow is
    -- acquired before any run; event identity is immutable. Epochs stay intact.
    PERFORM 1 FROM public.automation_workflows w WHERE w.studio_id=p_studio_id AND EXISTS(
        SELECT 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e
            ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND r.workflow_id=w.id AND e.subject_kind=p_subject_kind
            AND e.subject_id=p_subject_id AND r.state IN ('queued','waiting','claimed','running','sending','unknown'))
        ORDER BY w.id FOR UPDATE;
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e
        ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind=p_subject_kind AND e.subject_id=p_subject_id
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id FOR UPDATE OF r;
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY(SELECT r.id
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind=p_subject_kind AND e.subject_id=p_subject_id
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id),p_at,p_reason);
END $$;

CREATE FUNCTION public.mutate_lead_trial_appointment_v1(
    p_studio_id UUID,p_actor_id UUID,p_lead_id UUID,p_appointment_id UUID,p_operation_id UUID,p_expected_revision BIGINT,p_request JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE lead public.leads; old public.lead_trial_appointments; changed public.lead_trial_appointments;
    receipt private.automation_command_operations; program public.programs;
    v_request JSONB:=p_request; v_fingerprint TEXT; v_command TEXT; v_result JSONB; v_at TIMESTAMPTZ;
    targets JSONB; workflow_ids UUID[]; replaced_ids UUID[]:='{}'; run_ids UUID[]; events JSONB:='[]'; activity_id UUID;
    v_replay BOOLEAN; v_cancel BOOLEAN; v_stage TEXT; k TEXT; v UUID;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    -- Operational clear takes the exclusive gate before its Auth/staff locks.
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_operation_id IS NULL OR p_lead_id IS NULL OR
        (p_appointment_id IS NULL AND p_expected_revision IS NOT NULL) OR
        (p_appointment_id IS NOT NULL AND (p_expected_revision IS NULL OR p_expected_revision<1)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    v_command:=CASE WHEN p_appointment_id IS NULL THEN 'trial.create' ELSE 'trial.update' END;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    v_replay:=FOUND;
    BEGIN
        IF p_appointment_id IS NULL THEN
            IF NOT private.workflow_json_keys_v1(v_request,ARRAY['starts_at','ends_at','timezone','location','program_id'],ARRAY['starts_at','ends_at','timezone']) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            v_request:=jsonb_build_object('location','')||v_request;
        ELSIF NOT private.workflow_json_keys_v1(v_request,ARRAY['starts_at','ends_at','timezone','location','program_id','status']) OR v_request='{}' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOREACH k IN ARRAY ARRAY['starts_at','ends_at'] LOOP
            IF v_request ? k THEN v_request:=jsonb_set(v_request,ARRAY[k],to_jsonb(private.automation_utc_text_v1(private.automation_instant_v1(v_request->k)))); END IF;
        END LOOP;
        IF v_request ? 'timezone' THEN v_request:=jsonb_set(v_request,'{timezone}',to_jsonb(private.automation_timezone_v1(v_request->'timezone'))); END IF;
        IF v_request ? 'location' AND (jsonb_typeof(v_request->'location') IS DISTINCT FROM 'string' OR length(v_request->>'location')>240) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        IF v_request ? 'program_id' AND v_request->'program_id'<>'null'::JSONB THEN
            IF jsonb_typeof(v_request->'program_id') IS DISTINCT FROM 'string' OR v_request->>'program_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            v:=(v_request->>'program_id')::UUID; v_request:=jsonb_set(v_request,'{program_id}',to_jsonb(v));
        END IF;
        IF v_request ? 'status' AND (jsonb_typeof(v_request->'status') IS DISTINCT FROM 'string'
            OR v_request->>'status' NOT IN ('scheduled','completed','no_show','canceled')
            OR (v_request->>'status'<>'scheduled' AND v_request-'status'<>'{}'::JSONB)) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF v_replay THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT'; END IF;
        RAISE;
    END;
    v_fingerprint:=private.workflow_hash_v1(jsonb_build_object('command',v_command,'studio_id',p_studio_id,
        'actor_id',p_actor_id,'lead_id',p_lead_id,'appointment_id',p_appointment_id,
        'expected_revision',p_expected_revision,'request',v_request));
    IF v_replay THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>v_command OR receipt.request_fingerprint<>v_fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_lead_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF p_appointment_id IS NULL THEN
        changed.studio_id:=p_studio_id; changed.lead_id:=p_lead_id; changed.status:='scheduled'; changed.revision:=1;
        changed.program_id:=lead.program_id; changed.created_by:=p_actor_id; changed.rebooking_superseded:=false;
        -- Lead ownership serializes creation; lock every prior appointment before workflows.
        PERFORM 1 FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND lead_id=p_lead_id ORDER BY id FOR UPDATE;
        SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO replaced_ids FROM public.lead_trial_appointments
            WHERE studio_id=p_studio_id AND lead_id=p_lead_id;
    ELSE
        SELECT * INTO old FROM public.lead_trial_appointments
            WHERE studio_id=p_studio_id AND lead_id=p_lead_id AND id=p_appointment_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        IF old.revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT'; END IF;
        IF old.status<>'scheduled' OR old.revision=9223372036854775807 THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        changed:=old;
    END IF;
    changed:=jsonb_populate_record(changed,v_request);
    v_cancel:=changed.status='canceled';
    IF NOT v_cancel AND (lead.converted_student_id IS NOT NULL OR lead.stage IN ('enrolled','closed_lost')) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF NOT v_cancel AND changed.program_id IS NOT NULL THEN
        BEGIN
            SELECT * INTO program FROM public.programs WHERE studio_id=p_studio_id AND id=changed.program_id FOR SHARE NOWAIT;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF program.archived_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END;
    END IF;
    IF p_appointment_id IS NOT NULL THEN
        IF ROW(changed.starts_at,changed.ends_at,changed.timezone,changed.location,changed.program_id,changed.status)
            IS NOT DISTINCT FROM ROW(old.starts_at,old.ends_at,old.timezone,old.location,old.program_id,old.status) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END IF;
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]) INTO workflow_ids
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='trial' AND (e.subject_id=old.id OR (e.event_type='trial.no_show' AND e.subject_id=ANY(replaced_ids)));
    targets:=private.workflow_prepare_capture_v1(p_studio_id,workflow_ids,true);
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='trial'
            AND (e.subject_id=old.id OR (e.event_type='trial.no_show' AND e.subject_id=ANY(replaced_ids)))
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id FOR UPDATE OF r;
    -- Source, workflow and run acquisition can all wait. Validate the moving
    -- clock after those waits. Rejection rolls pending cancellation back too.
    v_at:=clock_timestamp();
    IF changed.ends_at<=changed.starts_at OR changed.ends_at-changed.starts_at>INTERVAL '24 hours' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF (changed.status='scheduled' AND changed.starts_at<=v_at)
        OR (changed.status='completed' AND v_at<changed.starts_at)
        OR (changed.status='no_show' AND v_at<changed.ends_at) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF p_appointment_id IS NULL THEN
        IF EXISTS(SELECT 1 FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND lead_id=p_lead_id AND status='scheduled') THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        UPDATE public.lead_trial_appointments SET rebooking_superseded=true
            WHERE studio_id=p_studio_id AND id=ANY(replaced_ids);
        changed.id:=gen_random_uuid(); changed.created_at:=v_at; changed.updated_at:=v_at;
        INSERT INTO public.lead_trial_appointments SELECT changed.*;
    ELSE
        UPDATE public.lead_trial_appointments SET starts_at=changed.starts_at,ends_at=changed.ends_at,timezone=changed.timezone,
            location=changed.location,program_id=changed.program_id,status=changed.status,revision=old.revision+1,updated_at=v_at
            WHERE studio_id=p_studio_id AND id=old.id RETURNING * INTO changed;
    END IF;
    v_stage:=CASE WHEN lead.stage='inquiry' AND changed.status='scheduled' THEN 'trial_scheduled'
        WHEN lead.stage='trial_scheduled' AND changed.status='completed' THEN 'trial_completed' ELSE lead.stage END;
    IF v_stage<>lead.stage THEN
        UPDATE public.leads SET stage=v_stage WHERE studio_id=p_studio_id AND id=p_lead_id;
        INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
            VALUES(p_studio_id,p_lead_id,'stage_change','Stage changed from '||lead.stage||' to '||v_stage,p_actor_id) RETURNING id INTO activity_id;
    END IF;
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
        VALUES(p_studio_id,p_lead_id,'meeting','Trial appointment '||changed.id::TEXT||' '||changed.status||' at '||private.automation_utc_text_v1(changed.starts_at),p_actor_id);
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,v_command,'trial_appointment',changed.id,
            jsonb_build_object('lead_id',p_lead_id,'revision',changed.revision,'status',changed.status,
                'starts_at',private.automation_utc_text_v1(changed.starts_at),'ends_at',private.automation_utc_text_v1(changed.ends_at)));
    SELECT coalesce(array_agg(r.id ORDER BY r.id),'{}'::UUID[]) INTO run_ids
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='trial'
            AND (e.subject_id=old.id OR (e.event_type='trial.no_show' AND e.subject_id=ANY(replaced_ids)))
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown');
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,run_ids,v_at,
        CASE WHEN p_appointment_id IS NULL THEN 'trial_replaced' ELSE 'trial_changed' END);
    IF changed.status IN ('scheduled','completed','no_show') THEN
        events:=events||jsonb_build_array(jsonb_build_object('event_type','trial.'||changed.status,
            'source_key',changed.id::TEXT||':'||changed.revision::TEXT,'subject_kind','trial','subject_id',changed.id,
            'occurred_at',private.automation_utc_text_v1(v_at),'context',jsonb_build_object('appointment_id',changed.id,
                'lead_id',p_lead_id,'program_id',changed.program_id,'revision',changed.revision,'status',changed.status)));
    END IF;
    IF activity_id IS NOT NULL THEN
        events:=events||jsonb_build_array(jsonb_build_object('event_type','lead.stage_changed','source_key',activity_id::TEXT,
            'subject_kind','lead','subject_id',p_lead_id,'occurred_at',private.automation_utc_text_v1(v_at),
            'context',jsonb_build_object('lead_id',p_lead_id,'program_id',lead.program_id,'activity_id',activity_id,'old_stage',lead.stage,'stage',v_stage)));
    END IF;
    IF events<>'[]'::JSONB THEN PERFORM private.workflow_capture_events_v1(p_studio_id,events,targets); END IF;
    v_result:=private.trial_appointment_payload_v1(changed);
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,v_command,v_fingerprint,'trial_appointment',changed.id,v_result,v_at);
    RETURN jsonb_build_object('payload',v_result,'operation_id',p_operation_id,'replayed',false);
END $$;

CREATE FUNCTION public.list_lead_trial_appointments_v1(p_studio_id UUID,p_actor_id UUID,p_lead_id UUID,p_limit INTEGER DEFAULT 50,p_cursor JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_at TIMESTAMPTZ; v_id UUID; v_items JSONB:='[]'; v_next JSONB; r RECORD; v_count INTEGER:=0;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    PERFORM 1 FROM public.leads WHERE studio_id=p_studio_id AND id=p_lead_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    IF p_cursor IS NOT NULL THEN
        IF NOT private.workflow_json_keys_v1(p_cursor,ARRAY['created_at','id'],ARRAY['created_at','id'])
            OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string'
            OR p_cursor->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        v_at:=private.automation_instant_v1(p_cursor->'created_at'); v_id:=(p_cursor->>'id')::UUID;
    END IF;
    -- Pass the complete row to an immutable serializer; the DTO and cursor use
    -- this one query snapshot even while another session updates appointments.
    FOR r IN SELECT a.id,a.created_at,private.trial_appointment_payload_v1(a) payload FROM public.lead_trial_appointments a
        WHERE a.studio_id=p_studio_id AND a.lead_id=p_lead_id AND (p_cursor IS NULL OR (a.created_at,a.id)<(v_at,v_id))
        ORDER BY a.created_at DESC,a.id DESC LIMIT p_limit+1 LOOP
        v_count:=v_count+1;
        IF v_count>p_limit THEN RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',v_next,'has_more',true)); END IF;
        v_items:=v_items||jsonb_build_array(r.payload);
        v_next:=jsonb_build_object('created_at',private.automation_utc_text_v1(r.created_at),'id',r.id);
    END LOOP;
    RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',NULL,'has_more',false));
END $$;
ALTER TABLE public.lead_trial_appointments OWNER TO postgres;
ALTER TABLE public.lead_trial_appointments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lead_trial_appointments FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.lead_trial_appointments TO service_role;
CREATE POLICY reject_client_access ON public.lead_trial_appointments AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY reject_ambiguous_staff_membership_access ON public.lead_trial_appointments AS RESTRICTIVE FOR ALL TO authenticated
    USING((SELECT private.has_unambiguous_studio_membership())) WITH CHECK((SELECT private.has_unambiguous_studio_membership()));
DO $trial_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_instant_v1','automation_utc_text_v1','automation_timezone_v1','trial_appointment_payload_v1','workflow_cancel_source_pending_v1'))
        OR (n.nspname='public' AND p.proname IN ('mutate_lead_trial_appointment_v1','list_lead_trial_appointments_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
    END LOOP;
END;
$trial_privileges$;

-- Belt-test scheduling retains logical ladder/program and approval snapshots.
-- Parent deletion must not erase history or silently select a different context.
CREATE FUNCTION private.belt_test_name_v1(p_value JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v TEXT;
BEGIN
    -- Match Pydantic's Unicode White_Space trimming, including tabs and NBSP.
    v:=btrim(p_value#>>'{}',U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000');
    IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' OR length(v) NOT BETWEEN 1 AND 140 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN v;
END $$;
CREATE TABLE public.belt_test_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (private.belt_test_name_v1(to_jsonb(name))=name),
    ladder_id UUID NOT NULL,
    program_id UUID,
    starts_at TIMESTAMPTZ NOT NULL CHECK (starts_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    timezone TEXT NOT NULL CHECK (private.automation_timezone_v1(to_jsonb(timezone))=timezone),
    location TEXT NOT NULL DEFAULT '' CHECK (length(location)<=240),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','completed','canceled')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    schedule_revision BIGINT NOT NULL DEFAULT 1 CHECK (schedule_revision>0 AND schedule_revision<=revision),
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (created_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (updated_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    UNIQUE(studio_id,id),
    CHECK (ends_at>starts_at AND ends_at-starts_at<=INTERVAL '24 hours')
);
CREATE INDEX belt_test_events_list ON public.belt_test_events(studio_id,created_at DESC,id DESC);

ALTER TABLE public.students ADD CONSTRAINT students_id_studio_id_key UNIQUE(id,studio_id);
CREATE TABLE public.belt_test_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    event_id UUID NOT NULL,
    student_id UUID NOT NULL,
    student_program_membership_id UUID,
    approved_schedule_revision BIGINT NOT NULL CHECK (approved_schedule_revision>0),
    -- Internal logical context. Public recipient DTOs intentionally omit it.
    approved_program_id UUID,
    approved_rank_context_generation BIGINT NOT NULL CHECK (approved_rank_context_generation>=1),
    approved_current_rank_id UUID,
    approved_target_rank_id UUID NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('approved','revoked')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    approved_by UUID,
    approved_at TIMESTAMPTZ NOT NULL CHECK (approved_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    revoked_at TIMESTAMPTZ CHECK (revoked_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (created_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (updated_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    FOREIGN KEY(studio_id,event_id) REFERENCES public.belt_test_events(studio_id,id) ON DELETE CASCADE,
    FOREIGN KEY(student_id,studio_id) REFERENCES public.students(id,studio_id) ON DELETE CASCADE,
    UNIQUE(studio_id,id),
    UNIQUE NULLS NOT DISTINCT(event_id,student_id,student_program_membership_id),
    CHECK ((state='approved' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX belt_test_recipients_list ON public.belt_test_recipients(studio_id,event_id,created_at DESC,id DESC);
CREATE INDEX belt_test_recipients_student ON public.belt_test_recipients(student_id,studio_id);
CREATE FUNCTION private.belt_test_recipient_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF ROW(NEW.id,NEW.studio_id,NEW.event_id,NEW.student_id,NEW.student_program_membership_id,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.studio_id,OLD.event_id,OLD.student_id,OLD.student_program_membership_id,OLD.created_at)
        OR OLD.revision=9223372036854775807 OR NEW.revision<>OLD.revision+1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    -- A revocation retains the exact facts of the last explicit approval.
    IF NEW.state='revoked' AND ROW(NEW.approved_schedule_revision,NEW.approved_rank_context_generation,NEW.approved_program_id,NEW.approved_current_rank_id,
        NEW.approved_target_rank_id,NEW.approved_by,NEW.approved_at) IS DISTINCT FROM
        ROW(OLD.approved_schedule_revision,OLD.approved_rank_context_generation,OLD.approved_program_id,OLD.approved_current_rank_id,OLD.approved_target_rank_id,OLD.approved_by,OLD.approved_at) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER belt_test_recipient_identity BEFORE UPDATE ON public.belt_test_recipients
    FOR EACH ROW EXECUTE FUNCTION private.belt_test_recipient_identity_v1();

CREATE FUNCTION private.belt_test_event_payload_v1(p_row public.belt_test_events) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',p_row.id,'studio_id',p_row.studio_id,'name',p_row.name,
        'ladder_id',p_row.ladder_id,'program_id',p_row.program_id,'starts_at',private.automation_utc_text_v1(p_row.starts_at),
        'ends_at',private.automation_utc_text_v1(p_row.ends_at),'timezone',p_row.timezone,'location',p_row.location,
        'status',p_row.status,'revision',p_row.revision,'schedule_revision',p_row.schedule_revision,'created_by',p_row.created_by,
        'created_at',private.automation_utc_text_v1(p_row.created_at),'updated_at',private.automation_utc_text_v1(p_row.updated_at))
$$;

CREATE FUNCTION public.mutate_belt_test_event_v1(
    p_studio_id UUID,p_actor_id UUID,p_event_id UUID,p_operation_id UUID,p_expected_revision BIGINT,p_request JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE old public.belt_test_events; changed public.belt_test_events; ladder public.belt_ladders; program public.programs;
    receipt private.automation_command_operations; v_request JSONB:=p_request; v_fingerprint TEXT; v_command TEXT;
    v_result JSONB; v_at TIMESTAMPTZ; v_replay BOOLEAN; v_schedule BOOLEAN:=false; v_invalidate BOOLEAN:=false; k TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_operation_id IS NULL OR (p_event_id IS NULL AND p_expected_revision IS NOT NULL)
        OR (p_event_id IS NOT NULL AND (p_expected_revision IS NULL OR p_expected_revision<1)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    v_command:=CASE WHEN p_event_id IS NULL THEN 'belt_test.create' ELSE 'belt_test.update' END;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    v_replay:=FOUND;
    BEGIN
        IF p_event_id IS NULL THEN
            IF NOT private.workflow_json_keys_v1(v_request,ARRAY['name','ladder_id','starts_at','ends_at','timezone','location','status'],
                ARRAY['name','ladder_id','starts_at','ends_at','timezone']) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            v_request:=jsonb_build_object('location','','status','draft')||v_request;
        ELSIF NOT private.workflow_json_keys_v1(v_request,ARRAY['name','ladder_id','starts_at','ends_at','timezone','location','status']) OR v_request='{}' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOREACH k IN ARRAY ARRAY['starts_at','ends_at'] LOOP
            IF v_request ? k THEN v_request:=jsonb_set(v_request,ARRAY[k],to_jsonb(private.automation_utc_text_v1(private.automation_instant_v1(v_request->k)))); END IF;
        END LOOP;
        IF v_request ? 'timezone' THEN v_request:=jsonb_set(v_request,'{timezone}',to_jsonb(private.automation_timezone_v1(v_request->'timezone'))); END IF;
        IF v_request ? 'name' THEN
            v_request:=jsonb_set(v_request,'{name}',to_jsonb(private.belt_test_name_v1(v_request->'name')));
        END IF;
        IF v_request ? 'location' AND (jsonb_typeof(v_request->'location') IS DISTINCT FROM 'string' OR length(v_request->>'location')>240) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        IF v_request ? 'ladder_id' THEN
            IF jsonb_typeof(v_request->'ladder_id') IS DISTINCT FROM 'string' OR v_request->>'ladder_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            v_request:=jsonb_set(v_request,'{ladder_id}',to_jsonb((v_request->>'ladder_id')::UUID));
        END IF;
        IF v_request ? 'status' AND (jsonb_typeof(v_request->'status') IS DISTINCT FROM 'string'
            OR v_request->>'status' NOT IN ('draft','scheduled','completed','canceled')
            OR (p_event_id IS NULL AND v_request->>'status' NOT IN ('draft','scheduled'))) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF v_replay THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT'; END IF;
        RAISE;
    END;
    v_fingerprint:=private.workflow_hash_v1(jsonb_build_object('command',v_command,'studio_id',p_studio_id,'actor_id',p_actor_id,
        'event_id',p_event_id,'expected_revision',p_expected_revision,'request',v_request));
    IF v_replay THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>v_command OR receipt.request_fingerprint<>v_fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    IF p_event_id IS NULL THEN
        changed.studio_id:=p_studio_id; changed.revision:=1; changed.schedule_revision:=1; changed.created_by:=p_actor_id;
    ELSE
        SELECT * INTO old FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=p_event_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        IF old.revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT'; END IF;
        IF old.status IN ('completed','canceled') OR old.revision=9223372036854775807 THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        changed:=old;
    END IF;
    changed:=jsonb_populate_record(changed,v_request);
    IF (old.status='scheduled' AND changed.status='draft') OR (old.status='draft' AND changed.status='completed') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    -- Status-only cancellation, including a name correction, retains missing
    -- parents. Effective schedule/context edits still require current parents.
    IF changed.status<>'canceled' OR ROW(changed.starts_at,changed.ends_at,changed.timezone,changed.location,changed.ladder_id)
        IS DISTINCT FROM ROW(old.starts_at,old.ends_at,old.timezone,old.location,old.ladder_id) THEN
        BEGIN
            SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=changed.ladder_id FOR SHARE NOWAIT;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF p_event_id IS NOT NULL AND changed.ladder_id=old.ladder_id AND ladder.program_id IS DISTINCT FROM old.program_id THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            IF ladder.program_id IS NOT NULL THEN
                SELECT * INTO program FROM public.programs WHERE studio_id=p_studio_id AND id=ladder.program_id FOR SHARE NOWAIT;
                IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
                IF program.archived_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            END IF;
            changed.program_id:=ladder.program_id;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END;
    END IF;
    IF changed.ends_at<=changed.starts_at OR changed.ends_at-changed.starts_at>INTERVAL '24 hours' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF p_event_id IS NOT NULL THEN
        v_schedule:=ROW(changed.starts_at,changed.ends_at,changed.timezone,changed.location,changed.ladder_id,changed.program_id)
            IS DISTINCT FROM ROW(old.starts_at,old.ends_at,old.timezone,old.location,old.ladder_id,old.program_id);
        IF NOT v_schedule AND ROW(changed.name,changed.status) IS NOT DISTINCT FROM ROW(old.name,old.status) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        v_invalidate:=v_schedule OR changed.status IN ('canceled','completed');
        IF v_invalidate THEN
            -- Event first, then every recipient, then every workflow, then runs.
            -- Do not cancel one recipient at a time: that reverses workflow order.
            PERFORM 1 FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND event_id=old.id ORDER BY id FOR UPDATE;
            IF EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND event_id=old.id
                AND state='approved' AND revision=9223372036854775807) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            PERFORM 1 FROM public.automation_workflows w WHERE w.studio_id=p_studio_id AND EXISTS(
                SELECT 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
                JOIN public.belt_test_recipients b ON b.studio_id=e.studio_id AND b.id=e.subject_id
                WHERE r.studio_id=p_studio_id AND r.workflow_id=w.id AND e.subject_kind='belt_test' AND b.event_id=old.id
                    AND r.state IN ('queued','waiting','claimed','running','sending','unknown')) ORDER BY w.id FOR UPDATE;
            PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
                JOIN public.belt_test_recipients b ON b.studio_id=e.studio_id AND b.id=e.subject_id
                WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND b.event_id=old.id
                    AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id FOR UPDATE OF r;
        END IF;
    END IF;
    -- Resample only after the final run wait. Every rejection remains atomic.
    v_at:=clock_timestamp();
    IF (changed.status='scheduled' AND (p_event_id IS NULL OR old.status='draft' OR v_schedule) AND changed.starts_at<=v_at)
        OR (changed.status='completed' AND changed.starts_at>v_at) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF v_invalidate THEN
        UPDATE public.belt_test_recipients SET state='revoked',revision=revision+1,revoked_at=v_at,updated_at=v_at
            WHERE studio_id=p_studio_id AND event_id=old.id AND state='approved';
        PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY(SELECT r.id FROM public.automation_workflow_runs r
            JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
            JOIN public.belt_test_recipients b ON b.studio_id=e.studio_id AND b.id=e.subject_id
            WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND b.event_id=old.id
                AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id),v_at,'belt_test_changed');
    END IF;
    IF p_event_id IS NULL THEN
        changed.id:=gen_random_uuid(); changed.created_at:=v_at; changed.updated_at:=v_at;
        INSERT INTO public.belt_test_events SELECT changed.*;
    ELSE
        UPDATE public.belt_test_events SET name=changed.name,ladder_id=changed.ladder_id,program_id=changed.program_id,
            starts_at=changed.starts_at,ends_at=changed.ends_at,timezone=changed.timezone,location=changed.location,status=changed.status,
            revision=old.revision+1,schedule_revision=old.schedule_revision+CASE WHEN v_schedule THEN 1 ELSE 0 END,updated_at=v_at
            WHERE studio_id=p_studio_id AND id=old.id RETURNING * INTO changed;
    END IF;
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,v_command,'belt_test',changed.id,jsonb_build_object('revision',changed.revision,
            'schedule_revision',changed.schedule_revision,'status',changed.status,'ladder_id',changed.ladder_id,'program_id',changed.program_id));
    v_result:=private.belt_test_event_payload_v1(changed);
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,v_command,v_fingerprint,'belt_test',changed.id,v_result,v_at);
    RETURN jsonb_build_object('payload',v_result,'operation_id',p_operation_id,'replayed',false);
END $$;

CREATE FUNCTION public.get_belt_test_event_v1(p_studio_id UUID,p_actor_id UUID,p_event_id UUID) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.belt_test_events;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    SELECT * INTO r FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=p_event_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('payload',private.belt_test_event_payload_v1(r));
END $$;
CREATE FUNCTION public.list_belt_test_events_v1(p_studio_id UUID,p_actor_id UUID,p_limit INTEGER DEFAULT 50,p_cursor JSONB DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_at TIMESTAMPTZ; v_id UUID; v_items JSONB:='[]'; v_next JSONB; r RECORD; v_count INTEGER:=0;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    IF p_cursor IS NOT NULL THEN
        IF NOT private.workflow_json_keys_v1(p_cursor,ARRAY['created_at','id'],ARRAY['created_at','id'])
            OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string'
            OR p_cursor->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        v_at:=private.automation_instant_v1(p_cursor->'created_at'); v_id:=(p_cursor->>'id')::UUID;
    END IF;
    FOR r IN SELECT a.id,a.created_at,private.belt_test_event_payload_v1(a) payload FROM public.belt_test_events a
        WHERE a.studio_id=p_studio_id AND (p_cursor IS NULL OR (a.created_at,a.id)<(v_at,v_id))
        ORDER BY a.created_at DESC,a.id DESC LIMIT p_limit+1 LOOP
        v_count:=v_count+1;
        IF v_count>p_limit THEN RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',v_next,'has_more',true)); END IF;
        v_items:=v_items||jsonb_build_array(r.payload);
        v_next:=jsonb_build_object('created_at',private.automation_utc_text_v1(r.created_at),'id',r.id);
    END LOOP;
    RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',NULL,'has_more',false));
END $$;
DO $belt_privileges$
DECLARE r RECORD; t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['belt_test_events','belt_test_recipients'] LOOP
        EXECUTE format('ALTER TABLE public.%I OWNER TO postgres',t);
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',t);
        EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO service_role',t);
        EXECUTE format('CREATE POLICY reject_client_access ON public.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',t);
        EXECUTE format('CREATE POLICY reject_ambiguous_staff_membership_access ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING((SELECT private.has_unambiguous_studio_membership())) WITH CHECK((SELECT private.has_unambiguous_studio_membership()))',t);
    END LOOP;
    FOR r IN SELECT p.oid::REGPROCEDURE identity FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('belt_test_name_v1','belt_test_event_payload_v1','belt_test_recipient_identity_v1'))
        OR (n.nspname='public' AND p.proname IN ('mutate_belt_test_event_v1','get_belt_test_event_v1','list_belt_test_events_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.identity::TEXT<>'private.belt_test_recipient_identity_v1()' THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
        END IF;
    END LOOP;
END;
$belt_privileges$;

-- Explicit recipient commands preserve the original context and each receipt.
CREATE FUNCTION private.belt_test_recipient_payload_v1(p_row public.belt_test_recipients) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',p_row.id,'studio_id',p_row.studio_id,'event_id',p_row.event_id,
        'student_id',p_row.student_id,'student_program_membership_id',p_row.student_program_membership_id,
        'approved_schedule_revision',p_row.approved_schedule_revision,'approved_current_rank_id',p_row.approved_current_rank_id,
        'approved_target_rank_id',p_row.approved_target_rank_id,'state',p_row.state,'revision',p_row.revision,
        'approved_by',p_row.approved_by,'approved_at',private.automation_utc_text_v1(p_row.approved_at),
        'revoked_at',private.automation_utc_text_v1(p_row.revoked_at),'created_at',private.automation_utc_text_v1(p_row.created_at),
        'updated_at',private.automation_utc_text_v1(p_row.updated_at))
$$;

CREATE FUNCTION public.list_belt_test_recipients_v1(
    p_studio_id UUID,p_actor_id UUID,p_event_id UUID,p_limit INTEGER DEFAULT 50,p_cursor JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_at TIMESTAMPTZ; v_id UUID; v_items JSONB:='[]'; v_next JSONB; r RECORD; v_count INTEGER:=0;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    PERFORM 1 FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=p_event_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    IF p_cursor IS NOT NULL THEN
        IF NOT private.workflow_json_keys_v1(p_cursor,ARRAY['created_at','id'],ARRAY['created_at','id'])
            OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string'
            OR p_cursor->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        v_at:=private.automation_instant_v1(p_cursor->'created_at'); v_id:=(p_cursor->>'id')::UUID;
    END IF;
    FOR r IN SELECT b.id,b.created_at,private.belt_test_recipient_payload_v1(b) payload FROM public.belt_test_recipients b
        WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND (p_cursor IS NULL OR (b.created_at,b.id)<(v_at,v_id))
        ORDER BY b.created_at DESC,b.id DESC LIMIT p_limit+1 LOOP
        v_count:=v_count+1;
        IF v_count>p_limit THEN RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',v_next,'has_more',true)); END IF;
        v_items:=v_items||jsonb_build_array(r.payload);
        v_next:=jsonb_build_object('created_at',private.automation_utc_text_v1(r.created_at),'id',r.id);
    END LOOP;
    RETURN jsonb_build_object('payload',jsonb_build_object('items',v_items,'next_cursor',NULL,'has_more',false));
END $$;

CREATE FUNCTION private.belt_test_lock_recipient_runs_v1(p_studio_id UUID,p_recipient_ids UUID[]) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    -- Caller already owns event, required sources and sorted recipient rows.
    -- Lock the union, never one recipient's workflows followed by another's.
    PERFORM 1 FROM public.automation_workflows w WHERE w.studio_id=p_studio_id AND EXISTS(
        SELECT 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND r.workflow_id=w.id AND e.subject_kind='belt_test' AND e.subject_id=ANY(p_recipient_ids)
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown')) ORDER BY w.id FOR UPDATE;
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(p_recipient_ids)
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id FOR UPDATE OF r;
END $$;

CREATE FUNCTION private.belt_test_cancel_recipient_runs_v1(p_studio_id UUID,p_recipient_ids UUID[],p_at TIMESTAMPTZ) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY(SELECT r.id FROM public.automation_workflow_runs r
        JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(p_recipient_ids)
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown') ORDER BY r.id),p_at,'belt_test_approval_changed');
END $$;

CREATE FUNCTION public.revoke_belt_test_recipient_v1(
    p_studio_id UUID,p_actor_id UUID,p_event_id UUID,p_recipient_id UUID,p_operation_id UUID,p_expected_revision BIGINT
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE receipt private.automation_command_operations; recipient public.belt_test_recipients;
    v_fingerprint TEXT; v_result JSONB; v_at TIMESTAMPTZ;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_event_id IS NULL OR p_recipient_id IS NULL OR p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    v_fingerprint:=private.workflow_hash_v1(jsonb_build_object('command','belt_test.revoke','studio_id',p_studio_id,'actor_id',p_actor_id,
        'event_id',p_event_id,'recipient_id',p_recipient_id,'expected_revision',p_expected_revision));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    IF FOUND THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>'belt_test.revoke' OR receipt.request_fingerprint<>v_fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    PERFORM 1 FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    SELECT * INTO recipient FROM public.belt_test_recipients
        WHERE studio_id=p_studio_id AND event_id=p_event_id AND id=p_recipient_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF recipient.revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT'; END IF;
    IF recipient.state<>'approved' OR recipient.revision=9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    PERFORM private.belt_test_lock_recipient_runs_v1(p_studio_id,ARRAY[recipient.id]);
    v_at:=clock_timestamp();
    UPDATE public.belt_test_recipients SET state='revoked',revision=revision+1,revoked_at=v_at,updated_at=v_at
        WHERE id=recipient.id RETURNING * INTO recipient;
    PERFORM private.belt_test_cancel_recipient_runs_v1(p_studio_id,ARRAY[recipient.id],v_at);
    v_result:=private.belt_test_recipient_payload_v1(recipient);
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,'belt_test.revoke','belt_test_recipient',recipient.id,
            jsonb_build_object('event_id',p_event_id,'revision',recipient.revision));
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'belt_test.revoke',v_fingerprint,'belt_test_recipient',recipient.id,v_result,v_at);
    RETURN jsonb_build_object('payload',v_result,'operation_id',p_operation_id,'replayed',false);
END $$;

CREATE FUNCTION public.approve_belt_test_recipients_v1(
    p_studio_id UUID,p_actor_id UUID,p_event_id UUID,p_operation_id UUID,p_expected_event_revision BIGINT,p_recipients JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE event public.belt_test_events; ladder public.belt_ladders; student public.students;
    membership public.student_program_memberships; current_rank public.belt_ranks; target_rank public.belt_ranks;
    recipient public.belt_test_recipients; receipt private.automation_command_operations;
    item JSONB; prepared JSONB:='[]'; normalized JSONB:='[]'; items JSONB:='[]'; result JSONB;
    fingerprint TEXT; replay BOOLEAN; student_ids UUID[]; changed_ids UUID[]:='{}'; v_program UUID;
    v_membership UUID; v_rank UUID; v_at TIMESTAMPTZ; v_today DATE; v_promotion TIMESTAMPTZ; v_anchor TIMESTAMPTZ;
    targets JSONB; workflow_ids UUID[]; events JSONB:='[]'; did_change BOOLEAN;
    v_classes BIGINT; v_days NUMERIC; v_timezone TEXT; v_generation BIGINT; v_student_id UUID; rank_workflows UUID[]; rank_runs UUID[];
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_event_id IS NULL OR p_operation_id IS NULL OR p_expected_event_revision IS NULL OR p_expected_event_revision<1 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    replay:=FOUND;
    BEGIN
        IF jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        IF jsonb_array_length(p_recipients) NOT BETWEEN 1 AND 100 THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(p_recipients) LOOP
            IF NOT private.workflow_json_keys_v1(item,ARRAY['student_id','student_program_membership_id'],ARRAY['student_id'])
                OR jsonb_typeof(item->'student_id') IS DISTINCT FROM 'string'
                OR item->>'student_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                OR (item ? 'student_program_membership_id' AND item->'student_program_membership_id'<>'null'::JSONB
                    AND (jsonb_typeof(item->'student_program_membership_id') IS DISTINCT FROM 'string'
                        OR item->>'student_program_membership_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            normalized:=normalized||jsonb_build_array(jsonb_build_object('student_id',(item->>'student_id')::UUID,
                'student_program_membership_id',(item->>'student_program_membership_id')::UUID));
        END LOOP;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(normalized) GROUP BY value HAVING count(*)>1) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        SELECT jsonb_agg(value ORDER BY (value->>'student_id')::UUID,(value->>'student_program_membership_id')::UUID NULLS FIRST)
            INTO normalized FROM jsonb_array_elements(normalized);
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF replay THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT'; END IF;
        RAISE;
    END;
    fingerprint:=private.workflow_hash_v1(jsonb_build_object('command','belt_test.approve','studio_id',p_studio_id,'actor_id',p_actor_id,
        'event_id',p_event_id,'expected_event_revision',p_expected_event_revision,'recipients',normalized));
    IF replay THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>'belt_test.approve' OR receipt.request_fingerprint<>fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    SELECT * INTO event FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=p_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF event.revision<>p_expected_event_revision THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT'; END IF;
    SELECT array_agg(DISTINCT (value->>'student_id')::UUID ORDER BY (value->>'student_id')::UUID)
        INTO student_ids FROM jsonb_array_elements(normalized);
    PERFORM 1 FROM public.students WHERE studio_id=p_studio_id AND id=ANY(student_ids) ORDER BY id FOR UPDATE;
    IF (SELECT count(*) FROM public.students WHERE studio_id=p_studio_id AND id=ANY(student_ids))<>cardinality(student_ids) THEN
        RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND';
    END IF;
    -- Include ended memberships: reactivation cannot change a legacy predicate.
    PERFORM 1 FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=ANY(student_ids) ORDER BY id FOR UPDATE;
    FOREACH v_student_id IN ARRAY student_ids LOOP
        PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,v_student_id);
    END LOOP;
    BEGIN
        -- UPDATE, rather than SHARE, excludes a concurrent rank INSERT's FK lock.
        SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=event.ladder_id FOR UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        IF ladder.program_id IS DISTINCT FROM event.program_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        PERFORM 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND ladder_id=ladder.id ORDER BY id FOR SHARE NOWAIT;
        -- Legacy scalar programs remain meaningful even when the event is unscoped.
        FOR v_program IN SELECT id FROM (
            SELECT event.program_id id UNION SELECT s.program_id FROM public.students s
            JOIN jsonb_array_elements(normalized) n ON s.id=(n.value->>'student_id')::UUID
            WHERE n.value->'student_program_membership_id'='null'::JSONB AND s.studio_id=p_studio_id
            UNION SELECT m.program_id FROM public.student_program_memberships m
            JOIN jsonb_array_elements(normalized) n ON m.id=(n.value->>'student_program_membership_id')::UUID
                AND m.student_id=(n.value->>'student_id')::UUID WHERE m.studio_id=p_studio_id
        ) programs WHERE id IS NOT NULL ORDER BY id LOOP
            PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=v_program FOR SHARE NOWAIT;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF EXISTS(SELECT 1 FROM public.programs WHERE id=v_program AND archived_at IS NOT NULL) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
        END LOOP;
        -- These are actual evidence rows, not a stale pre-lock count. Lock all
        -- selected students' existing evidence so credit updates cannot race it.
        PERFORM 1 FROM public.class_sessions cs WHERE cs.studio_id=p_studio_id AND EXISTS(
            SELECT 1 FROM public.attendance a WHERE a.studio_id=p_studio_id AND a.student_id=ANY(student_ids) AND a.session_id=cs.id)
            ORDER BY cs.id FOR SHARE NOWAIT;
        PERFORM 1 FROM public.attendance a WHERE a.studio_id=p_studio_id AND a.student_id=ANY(student_ids) ORDER BY a.id FOR SHARE NOWAIT;
        -- An attendance edit may commit a different session between the two
        -- statements. Its row is now stable; own every current session too.
        PERFORM 1 FROM public.class_sessions cs WHERE cs.studio_id=p_studio_id AND EXISTS(
            SELECT 1 FROM public.attendance a WHERE a.studio_id=p_studio_id AND a.student_id=ANY(student_ids) AND a.session_id=cs.id)
            ORDER BY cs.id FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    FOR item IN SELECT value FROM jsonb_array_elements(normalized) LOOP
        SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=(item->>'student_id')::UUID;
        v_membership:=(item->>'student_program_membership_id')::UUID;
        IF v_membership IS NOT NULL THEN
            SELECT * INTO membership FROM public.student_program_memberships WHERE studio_id=p_studio_id
                AND id=v_membership AND student_id=student.id;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF membership.status NOT IN ('active','paused') OR membership.ended_at IS NOT NULL
                OR (event.program_id IS NOT NULL AND membership.program_id IS DISTINCT FROM event.program_id) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            v_rank:=membership.current_belt_rank_id; v_program:=membership.program_id;
            v_anchor:=membership.started_at::TIMESTAMP AT TIME ZONE 'UTC';
        ELSE
            IF event.program_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.student_program_memberships
                WHERE studio_id=p_studio_id AND student_id=student.id AND status IN ('active','paused') AND ended_at IS NULL) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            v_rank:=student.current_belt_rank_id; v_program:=student.program_id;
            v_anchor:=student.membership_start_date::TIMESTAMP AT TIME ZONE 'UTC';
        END IF;
        current_rank:=NULL;
        IF v_rank IS NOT NULL THEN
            SELECT * INTO current_rank FROM public.belt_ranks WHERE studio_id=p_studio_id AND ladder_id=ladder.id AND id=v_rank;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        END IF;
        WITH ordered AS (SELECT r.id,row_number() OVER (ORDER BY r.display_order,r.created_at,r.id) position
            FROM public.belt_ranks r WHERE r.studio_id=p_studio_id AND r.ladder_id=ladder.id)
        SELECT r.* INTO target_rank FROM ordered o JOIN public.belt_ranks r ON r.id=o.id
            WHERE v_rank IS NULL OR o.position>(SELECT position FROM ordered WHERE id=v_rank)
            ORDER BY o.position LIMIT 1;
        IF NOT FOUND OR target_rank.min_classes IS NULL OR target_rank.min_months IS NULL
            OR target_rank.min_classes<0 OR target_rank.min_months<0 THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        SELECT p.promoted_at INTO v_promotion FROM public.promotions p WHERE p.studio_id=p_studio_id AND p.student_id=student.id
            AND ((v_membership IS NOT NULL AND p.student_program_membership_id=v_membership)
                OR (v_program IS NOT NULL AND p.program_id=v_program) OR (v_membership IS NULL AND p.program_id IS NULL))
            ORDER BY p.promoted_at DESC,p.id DESC LIMIT 1;
        v_anchor:=coalesce(v_promotion,v_anchor,student.membership_start_date::TIMESTAMP AT TIME ZONE 'UTC');
        IF (v_promotion IS NOT NULL AND NOT isfinite(v_promotion)) OR (v_anchor IS NOT NULL AND NOT isfinite(v_anchor)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        v_generation:=private.workflow_rank_context_generation_v1(p_studio_id,student.id,v_membership);
        prepared:=prepared||jsonb_build_array(item||jsonb_build_object('rank_context_generation',v_generation,'program_id',v_program,'current_rank_id',v_rank,'target_rank_id',target_rank.id,
            'promotion_at',v_promotion,'anchor_at',v_anchor,'min_classes',target_rank.min_classes,'min_days',target_rank.min_months::BIGINT*30));
    END LOOP;
    PERFORM 1 FROM public.belt_test_recipients b WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(normalized) n WHERE b.student_id=(n.value->>'student_id')::UUID
            AND b.student_program_membership_id IS NOT DISTINCT FROM (n.value->>'student_program_membership_id')::UUID) ORDER BY b.id FOR UPDATE;
    SELECT coalesce(array_agg(b.id ORDER BY b.id),'{}'::UUID[]) INTO changed_ids FROM public.belt_test_recipients b
        JOIN jsonb_array_elements(prepared) n ON b.student_id=(n.value->>'student_id')::UUID
            AND b.student_program_membership_id IS NOT DISTINCT FROM (n.value->>'student_program_membership_id')::UUID
        WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND (b.state<>'approved' OR b.approved_schedule_revision<>event.schedule_revision
            OR b.approved_rank_context_generation IS DISTINCT FROM (n.value->>'rank_context_generation')::BIGINT
            OR b.approved_program_id IS DISTINCT FROM (n.value->>'program_id')::UUID
            OR b.approved_current_rank_id IS DISTINCT FROM (n.value->>'current_rank_id')::UUID OR b.approved_target_rank_id<>(n.value->>'target_rank_id')::UUID);
    IF EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE id=ANY(changed_ids) AND revision=9223372036854775807) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]) INTO workflow_ids
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(changed_ids);
    IF EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() AND (state='active' OR (state='unknown' AND owner='private_profile'))) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    FOR v_student_id IN SELECT DISTINCT student_id FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY student_id LOOP
        PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,v_student_id);
    END LOOP;
    -- Include earlier completed rank commands in the same final-mode union.
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]),
        coalesce(array_agg(DISTINCT r.id ORDER BY r.id),'{}'::UUID[]) INTO rank_workflows,rank_runs
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.event_type IN ('student.promoted','belt_test.approved','belt_test.upcoming')
            AND EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts p JOIN private.workflow_rank_scopes s ON s.id=p.scope_id
                WHERE p.studio_id=e.studio_id AND p.student_id=(e.context->>'student_id')::UUID
                    AND p.student_program_membership_id IS NOT DISTINCT FROM (e.context->>'student_program_membership_id')::UUID
                    AND p.changed AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id());
    SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::UUID[]) INTO workflow_ids FROM unnest(workflow_ids||rank_workflows) id;
    targets:=private.workflow_prepare_capture_v1(p_studio_id,workflow_ids,true);
    UPDATE private.workflow_rank_scopes SET capture_targets=jsonb_build_object('lock_mode','update','packet',targets) WHERE studio_id=p_studio_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND ((e.subject_kind='belt_test' AND e.subject_id=ANY(changed_ids)
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown')) OR r.id=ANY(rank_runs)) ORDER BY r.id FOR UPDATE OF r;
    -- Time and all eligibility are evaluated after the final potentially blocking lock.
    v_at:=clock_timestamp();
    SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone) THEN s.timezone ELSE 'UTC' END
        INTO v_timezone FROM public.studios s WHERE id=p_studio_id;
    v_today:=(v_at AT TIME ZONE v_timezone)::DATE;
    IF event.status<>'scheduled' OR event.starts_at<=v_at THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(prepared) LOOP
        SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=(item->>'student_id')::UUID;
        IF student.status<>'active' OR student.deleted_at IS NOT NULL OR (student.hold_start_date IS NOT NULL
            AND student.hold_start_date<=v_today AND (student.hold_end_date IS NULL OR student.hold_end_date>=v_today)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        SELECT count(*) INTO v_classes FROM public.attendance a JOIN public.class_sessions cs ON cs.id=a.session_id AND cs.studio_id=p_studio_id
            WHERE a.studio_id=p_studio_id AND a.student_id=student.id AND a.status<>'absent' AND a.counts_toward_eligibility IS DISTINCT FROM false
                AND cs.deleted_at IS NULL AND cs.status<>'canceled'
                AND (event.program_id IS NULL OR cs.program_id=event.program_id)
                AND (item->>'promotion_at' IS NULL OR a.checked_in_at>=(item->>'promotion_at')::TIMESTAMPTZ);
        v_days:=CASE WHEN item->>'anchor_at' IS NULL THEN 0 ELSE greatest(0,floor(extract(epoch FROM (v_at-(item->>'anchor_at')::TIMESTAMPTZ))/86400)) END;
        IF v_classes<(item->>'min_classes')::BIGINT OR v_days<(item->>'min_days')::BIGINT THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END LOOP;
    -- Every selected context has passed before any recipient/audit/receipt write.
    FOR item IN SELECT value FROM jsonb_array_elements(prepared) LOOP
        SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND event_id=p_event_id
            AND student_id=(item->>'student_id')::UUID
            AND student_program_membership_id IS NOT DISTINCT FROM (item->>'student_program_membership_id')::UUID;
        did_change:=false;
        IF NOT FOUND THEN
            did_change:=true;
            INSERT INTO public.belt_test_recipients(studio_id,event_id,student_id,student_program_membership_id,approved_schedule_revision,approved_program_id,approved_rank_context_generation,
                approved_current_rank_id,approved_target_rank_id,state,revision,approved_by,approved_at,created_at,updated_at)
                VALUES(p_studio_id,p_event_id,(item->>'student_id')::UUID,(item->>'student_program_membership_id')::UUID,event.schedule_revision,(item->>'program_id')::UUID,(item->>'rank_context_generation')::BIGINT,
                    (item->>'current_rank_id')::UUID,(item->>'target_rank_id')::UUID,'approved',1,p_actor_id,v_at,v_at,v_at) RETURNING * INTO recipient;
        ELSIF recipient.id=ANY(changed_ids) THEN
            did_change:=true;
            UPDATE public.belt_test_recipients SET approved_schedule_revision=event.schedule_revision,
                approved_program_id=(item->>'program_id')::UUID,approved_rank_context_generation=(item->>'rank_context_generation')::BIGINT,
                approved_current_rank_id=(item->>'current_rank_id')::UUID,approved_target_rank_id=(item->>'target_rank_id')::UUID,
                state='approved',revision=revision+1,approved_by=p_actor_id,approved_at=v_at,revoked_at=NULL,updated_at=v_at
                WHERE id=recipient.id RETURNING * INTO recipient;
        END IF;
        IF did_change THEN
            events:=events||jsonb_build_array(jsonb_build_object('event_type','belt_test.approved',
                'source_key',recipient.id::TEXT||':'||recipient.revision::TEXT||':'||recipient.approved_schedule_revision::TEXT,
                'subject_kind','belt_test','subject_id',recipient.id,'occurred_at',private.automation_utc_text_v1(v_at),
                'context',jsonb_build_object('event_id',recipient.event_id,'student_id',recipient.student_id,
                    'student_program_membership_id',recipient.student_program_membership_id,'approved_program_id',recipient.approved_program_id,
                    'approved_current_rank_id',recipient.approved_current_rank_id,'approved_target_rank_id',recipient.approved_target_rank_id,
                    'approved_schedule_revision',recipient.approved_schedule_revision,'approval_revision',recipient.revision,
                    'approved_rank_context_generation',recipient.approved_rank_context_generation)));
        END IF;
        items:=items||jsonb_build_array(private.belt_test_recipient_payload_v1(recipient));
    END LOOP;
    PERFORM private.belt_test_cancel_recipient_runs_v1(p_studio_id,changed_ids,v_at);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    IF events<>'[]'::JSONB THEN PERFORM private.workflow_capture_events_v1(p_studio_id,events,targets); END IF;
    result:=jsonb_build_object('items',items,'event_revision',p_expected_event_revision,'schedule_revision',event.schedule_revision);
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,'belt_test.approve','belt_test',p_event_id,
            jsonb_build_object('event_revision',p_expected_event_revision,'schedule_revision',event.schedule_revision,'recipient_count',jsonb_array_length(items)));
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'belt_test.approve',fingerprint,'belt_test',p_event_id,result,v_at);
    RETURN jsonb_build_object('payload',result,'operation_id',p_operation_id,'replayed',false);
END $$;

DO $recipient_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('belt_test_recipient_payload_v1','belt_test_lock_recipient_runs_v1','belt_test_cancel_recipient_runs_v1'))
            OR (n.nspname='public' AND p.proname IN ('approve_belt_test_recipients_v1','revoke_belt_test_recipient_v1','list_belt_test_recipients_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
    END LOOP;
END;
$recipient_privileges$;

-- Committed source occurrences. Preparation owns every target before temporal
-- validation; emission consumes that transaction's frozen targets without waits.
CREATE FUNCTION private.workflow_prepare_capture_v1(p_studio_id UUID,p_update_workflow_ids UUID[] DEFAULT '{}',p_for_update BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE ids UUID[]; wid UUID; targets JSONB;
BEGIN
    IF p_studio_id IS NULL OR p_update_workflow_ids IS NULL OR p_for_update IS NULL
        OR coalesce(array_ndims(p_update_workflow_ids),1)<>1 OR cardinality(p_update_workflow_ids)>100
        OR array_position(p_update_workflow_ids,NULL) IS NOT NULL
        OR EXISTS(SELECT 1 FROM unnest(p_update_workflow_ids) i WHERE NOT EXISTS(
            SELECT 1 FROM public.automation_workflows w WHERE w.studio_id=p_studio_id AND w.id=i))
        OR (NOT p_for_update AND cardinality(p_update_workflow_ids)>0) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- The same admission key used exclusively by workflow create/start.
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('automation.workflow.admission:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO ids FROM public.automation_workflows
        WHERE studio_id=p_studio_id AND (status='active' OR id=ANY(p_update_workflow_ids));
    IF cardinality(ids)>100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    FOREACH wid IN ARRAY ids LOOP
        IF p_for_update THEN
            PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=wid FOR UPDATE;
        ELSE
            PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=wid FOR SHARE;
        END IF;
    END LOOP;
    -- Separate statement after all waits: no stale outer join/cursor tuple is
    -- allowed to select a version published while this source was blocked.
    SELECT coalesce(jsonb_agg(jsonb_build_object('workflow_id',w.id,'version_id',v.id,'activation_id',a.id,
        'epoch',a.epoch,'event_type',n.value#>>'{config,event_type}','program_id',n.value#>'{config,program_id}') ORDER BY w.id),'[]'::JSONB)
        INTO targets FROM public.automation_workflows w
        JOIN public.automation_workflow_versions v ON v.studio_id=w.studio_id AND v.workflow_id=w.id AND v.id=w.published_version_id
        JOIN public.automation_workflow_activations a ON a.studio_id=w.studio_id AND a.workflow_id=w.id
            AND a.version_id=v.id AND a.epoch=w.enrollment_epoch AND a.retired_at IS NULL AND a.cancelled_at IS NULL
        CROSS JOIN LATERAL jsonb_array_elements(v.graph->'nodes') n
        WHERE w.studio_id=p_studio_id AND w.id=ANY(ids) AND w.status='active' AND n.value->>'type'='trigger';
    IF jsonb_array_length(targets)>25 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    RETURN jsonb_build_object('studio_id',p_studio_id,'transaction_id',pg_catalog.pg_current_xact_id()::TEXT,
        'backend_pid',pg_catalog.pg_backend_pid(),'locked_workflow_ids',to_jsonb(ids),'targets',targets);
END $$;

CREATE FUNCTION private.workflow_capture_events_v1(p_studio_id UUID,p_events JSONB,p_targets JSONB)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE item JSONB; target JSONB; context JSONB; fields TEXT[]; required TEXT[]; k TEXT; value JSONB;
    kind TEXT; occurrence UUID; trigger_id TEXT; at TIMESTAMPTZ; program UUID;
    uuid_pattern CONSTANT TEXT:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
    IF p_studio_id IS NULL OR NOT private.workflow_json_keys_v1(p_targets,
        ARRAY['studio_id','transaction_id','backend_pid','locked_workflow_ids','targets'],
        ARRAY['studio_id','transaction_id','backend_pid','locked_workflow_ids','targets'])
        OR p_targets->'studio_id' IS DISTINCT FROM to_jsonb(p_studio_id)
        OR p_targets->'transaction_id' IS DISTINCT FROM to_jsonb(pg_catalog.pg_current_xact_id()::TEXT)
        OR p_targets->'backend_pid' IS DISTINCT FROM to_jsonb(pg_catalog.pg_backend_pid())
        OR jsonb_typeof(p_targets->'locked_workflow_ids') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_targets->'targets') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF jsonb_array_length(p_events) NOT BETWEEN 1 AND 100 OR jsonb_array_length(p_targets->'targets')>25
        OR jsonb_array_length(p_targets->'locked_workflow_ids')>100 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    FOR value IN SELECT v FROM jsonb_array_elements(p_targets->'locked_workflow_ids') v LOOP
        IF jsonb_typeof(value)<>'string' OR value#>>'{}' !~ uuid_pattern THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
    END LOOP;
    FOR target IN SELECT v FROM jsonb_array_elements(p_targets->'targets') v LOOP
        IF NOT private.workflow_json_keys_v1(target,ARRAY['workflow_id','version_id','activation_id','epoch','event_type','program_id'],
            ARRAY['workflow_id','version_id','activation_id','epoch','event_type','program_id'])
            OR NOT private.workflow_integer_v1(target->'epoch',1,9223372036854775807)
            OR jsonb_typeof(target->'event_type') IS DISTINCT FROM 'string'
            OR NOT (private.workflow_catalog_v1()->'triggers') ? (target->>'event_type')
            OR NOT (p_targets->'locked_workflow_ids') @> jsonb_build_array(target->'workflow_id') THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOREACH k IN ARRAY ARRAY['workflow_id','version_id','activation_id','program_id'] LOOP
            IF NOT (k='program_id' AND target->k='null'::JSONB)
                AND (jsonb_typeof(target->k) IS DISTINCT FROM 'string' OR target->>k !~ uuid_pattern) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        END LOOP;
    END LOOP;
    -- Validate the full bounded owner batch before inserting any occurrence.
    FOR item IN SELECT v FROM jsonb_array_elements(p_events) v LOOP
        IF NOT private.workflow_json_keys_v1(item,ARRAY['event_type','source_key','subject_kind','subject_id','occurred_at','context'],
            ARRAY['event_type','source_key','subject_kind','subject_id','occurred_at','context'])
            OR jsonb_typeof(item->'event_type') IS DISTINCT FROM 'string'
            OR item->>'event_type' NOT IN ('student.enrolled','student.promoted','lead.created','lead.stage_changed',
                'trial.scheduled','trial.completed','trial.no_show','invoice.payment_failed','belt_test.approved')
            OR jsonb_typeof(item->'source_key') IS DISTINCT FROM 'string' OR length(item->>'source_key') NOT BETWEEN 1 AND 500
            OR item->>'source_key' !~ '^[a-z0-9_.:-]+$'
            OR jsonb_typeof(item->'subject_id') IS DISTINCT FROM 'string' OR item->>'subject_id' !~ uuid_pattern
            OR item->'subject_kind' IS DISTINCT FROM private.workflow_catalog_v1()#>ARRAY['triggers',item->>'event_type','subject_kind'] THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        IF item->>'event_type'='student.enrolled' AND EXISTS(
            SELECT 1 FROM private.workflow_rank_scopes s WHERE s.studio_id=p_studio_id
                AND s.student_id=(item->>'subject_id')::UUID AND s.backend_pid=pg_catalog.pg_backend_pid()
                AND s.transaction_id=pg_catalog.pg_current_xact_id() AND s.state<>'completed') THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
        END IF;
        at:=private.automation_instant_v1(item->'occurred_at');
        context:=item->'context'; kind:=item->>'event_type';
        CASE
            WHEN kind='lead.created' THEN fields:=ARRAY['lead_id','program_id','stage']; required:=fields;
            WHEN kind='lead.stage_changed' THEN fields:=ARRAY['lead_id','program_id','activity_id','old_stage','stage']; required:=fields;
            WHEN kind LIKE 'trial.%' THEN fields:=ARRAY['appointment_id','lead_id','program_id','revision','status']; required:=fields;
            WHEN kind='belt_test.approved' THEN fields:=ARRAY['event_id','student_id','student_program_membership_id','approved_program_id',
                'approved_current_rank_id','approved_target_rank_id','approved_schedule_revision','approval_revision','approved_rank_context_generation']; required:=fields;
            -- Store only matching frozen target filters, never the full membership list.
            WHEN kind='student.enrolled' THEN fields:=ARRAY['student_id','matched_program_ids']; required:=fields;
            WHEN kind='student.promoted' THEN fields:=ARRAY['promotion_id','student_id','student_program_membership_id','program_id','rank_id','from_rank_id','rank_context_generation']; required:=array_remove(fields,'from_rank_id');
            WHEN kind='invoice.payment_failed' THEN fields:=ARRAY['payment_id','invoice_id','payer_id','invoice_settlement_generation','payment_evidence']; required:=fields;
        END CASE;
        IF NOT private.workflow_json_keys_v1(context,fields,required) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOREACH k IN ARRAY fields LOOP
            value:=context->k;
            IF k='from_rank_id' AND NOT context ? k THEN CONTINUE; END IF;
            IF k='matched_program_ids' THEN
                IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
                IF jsonb_array_length(value)>25 OR EXISTS(SELECT 1 FROM jsonb_array_elements(value) p
                    WHERE jsonb_typeof(p)<>'string' OR p#>>'{}' !~ uuid_pattern) THEN
                    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
                END IF;
            ELSIF kind='invoice.payment_failed' AND k='payment_evidence' THEN
                IF NOT private.workflow_payment_evidence_valid_v1(value) OR value->>'status' IS DISTINCT FROM 'failed'
                    OR value->'payment_id' IS DISTINCT FROM context->'payment_id'
                    OR (context->'invoice_id'<>'null'::JSONB AND context->'invoice_id' IS DISTINCT FROM value->'invoice_id')
                    OR (context->'payer_id'<>'null'::JSONB AND context->'payer_id' IS DISTINCT FROM value->'payer_id') THEN
                    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
                END IF;
            ELSIF kind='invoice.payment_failed' AND k='invoice_settlement_generation' THEN
                IF (value='null'::JSONB) IS DISTINCT FROM (context->'invoice_id'='null'::JSONB)
                    OR (value<>'null'::JSONB AND NOT private.workflow_integer_v1(value,1,9223372036854775807)) THEN
                    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
                END IF;
            ELSIF k IN ('revision','approved_schedule_revision','approval_revision','rank_context_generation','approved_rank_context_generation') THEN
                IF NOT private.workflow_integer_v1(value,1,9223372036854775807) THEN
                    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
                END IF;
            ELSIF k IN ('old_stage','stage') THEN
                IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' NOT IN ('inquiry','trial_scheduled','trial_completed','offer_sent','enrolled','closed_lost') THEN
                    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
                END IF;
            ELSIF k='status' THEN
                IF value IS DISTINCT FROM to_jsonb(substr(kind,7)) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
            ELSIF NOT (k IN ('program_id','student_program_membership_id','approved_program_id','approved_current_rank_id','from_rank_id','invoice_id','payer_id') AND value='null'::JSONB)
                AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ uuid_pattern) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        END LOOP;
        IF (kind LIKE 'lead.%' AND context->'lead_id' IS DISTINCT FROM item->'subject_id')
            OR (kind LIKE 'trial.%' AND context->'appointment_id' IS DISTINCT FROM item->'subject_id')
            OR (kind='student.enrolled' AND context->'student_id' IS DISTINCT FROM item->'subject_id')
            OR (kind='student.promoted' AND context->'promotion_id' IS DISTINCT FROM item->'subject_id')
            OR (kind='invoice.payment_failed' AND context->'payment_id' IS DISTINCT FROM item->'subject_id') THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
    END LOOP;
    FOR item IN SELECT v FROM jsonb_array_elements(p_events) v LOOP
        occurrence:=NULL;
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
            VALUES(p_studio_id,item->>'event_type',item->>'source_key',item->>'subject_kind',(item->>'subject_id')::UUID,
                private.automation_instant_v1(item->'occurred_at'),item->'context')
            ON CONFLICT(studio_id,event_type,source_key) DO NOTHING RETURNING id INTO occurrence;
        -- Seen with zero active targets is still seen forever. No backfill on replay.
        IF occurrence IS NULL THEN CONTINUE; END IF;
        -- Retain the occurrence even when a committed replacement forbids enrollment.
        IF item->>'event_type'='trial.no_show' AND EXISTS(SELECT 1 FROM public.lead_trial_appointments a
            WHERE a.studio_id=p_studio_id AND a.id=(item->>'subject_id')::UUID AND a.rebooking_superseded) THEN
            CONTINUE;
        END IF;
        context:=item->'context';
        program:=CASE WHEN item->>'event_type'='belt_test.approved' THEN (context->>'approved_program_id')::UUID ELSE (context->>'program_id')::UUID END;
        FOR target IN SELECT v FROM jsonb_array_elements(p_targets->'targets') v LOOP
            IF target->>'event_type'<>item->>'event_type' OR (target->>'program_id' IS NOT NULL
                AND NOT CASE WHEN item->>'event_type'='student.enrolled' THEN context->'matched_program_ids' @> jsonb_build_array(target->'program_id')
                    ELSE (target->>'program_id')::UUID IS NOT DISTINCT FROM program END) THEN CONTINUE; END IF;
            SELECT n.value->>'id' INTO STRICT trigger_id FROM public.automation_workflow_versions v
                CROSS JOIN LATERAL jsonb_array_elements(v.graph->'nodes') n
                WHERE v.studio_id=p_studio_id AND v.workflow_id=(target->>'workflow_id')::UUID
                    AND v.id=(target->>'version_id')::UUID AND n.value->>'type'='trigger';
            INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,next_due_at)
                VALUES(p_studio_id,(target->>'workflow_id')::UUID,(target->>'version_id')::UUID,occurrence,
                    (target->>'activation_id')::UUID,(target->>'epoch')::BIGINT,trigger_id,private.automation_instant_v1(item->'occurred_at'));
        END LOOP;
    END LOOP;
END $$;

-- Actor authority and the shared operation identity are already owned. Never
-- wait backwards for assignee Auth behind its invited_by FK child cleanup.
CREATE FUNCTION private.workflow_lock_lead_assignee_v1(p_assignee_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM 1 FROM auth.users WHERE id=p_assignee_id FOR KEY SHARE NOWAIT;
    RETURN FOUND;
END $$;

CREATE FUNCTION public.create_lead_atomic_v1(p_studio_id UUID,p_actor_id UUID,p_operation_id UUID,p_request JSONB)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE request JSONB; fingerprint TEXT; receipt private.automation_command_operations; lead public.leads;
    targets JSONB; k TEXT; v_at TIMESTAMPTZ; result JSONB; replay BOOLEAN;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED'; END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id,true);
    IF p_operation_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    replay:=FOUND;
    BEGIN
        IF NOT private.workflow_json_keys_v1(p_request,ARRAY['first_name','last_name','email','phone','source','stage','program_interest',
            'program_id','is_minor','guardian_name','guardian_email','guardian_phone','assigned_staff_id','follow_up_date','notes'],ARRAY['first_name','last_name']) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        request:=jsonb_build_object('email',NULL,'phone',NULL,'source','walk_in','stage','inquiry','program_interest',NULL,
            'program_id',NULL,'is_minor',false,'guardian_name',NULL,'guardian_email',NULL,'guardian_phone',NULL,
            'assigned_staff_id',NULL,'follow_up_date',NULL,'notes',NULL)||p_request;
        FOREACH k IN ARRAY ARRAY['first_name','last_name','email','phone','source','stage','program_interest','guardian_name','guardian_email','guardian_phone','notes'] LOOP
            IF NOT (k NOT IN ('first_name','last_name','source','stage') AND request->k='null'::JSONB)
                AND jsonb_typeof(request->k) IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        END LOOP;
        IF request->>'source' NOT IN ('walk_in','referral','social','search','website','other')
            OR request->>'stage' NOT IN ('inquiry','trial_scheduled','trial_completed','offer_sent','closed_lost')
            OR jsonb_typeof(request->'is_minor') IS DISTINCT FROM 'boolean' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOREACH k IN ARRAY ARRAY['program_id','assigned_staff_id'] LOOP
            IF request->k<>'null'::JSONB THEN
                IF jsonb_typeof(request->k) IS DISTINCT FROM 'string' OR request->>k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
                END IF;
                request:=jsonb_set(request,ARRAY[k],to_jsonb((request->>k)::UUID));
            END IF;
        END LOOP;
        IF request->'follow_up_date'<>'null'::JSONB THEN
            IF jsonb_typeof(request->'follow_up_date') IS DISTINCT FROM 'string' THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
            -- Fingerprint the original string: DATE interpretation can change
            -- with TimeZone, DateStyle or the day of a later receipt replay.
        END IF;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR SQLSTATE '22023' THEN
        IF replay THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT'; END IF;
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END;
    fingerprint:=private.workflow_hash_v1(jsonb_build_object('command','lead.create','studio_id',p_studio_id,'actor_id',p_actor_id,'request',request));
    IF replay THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>'lead.create' OR receipt.request_fingerprint<>fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    BEGIN
        -- Only a fresh command interprets the retained DATE input syntax.
        lead:=jsonb_populate_record(NULL::public.leads,request);
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END;
    IF lead.assigned_staff_id IS NOT NULL THEN
        BEGIN
            IF NOT private.workflow_lock_lead_assignee_v1(lead.assigned_staff_id) THEN
                RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND';
            END IF;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END;
        PERFORM 1 FROM public.staff_roles WHERE studio_id=p_studio_id AND user_id=lead.assigned_staff_id AND archived_at IS NULL FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    END IF;
    IF lead.program_id IS NOT NULL THEN
        BEGIN
            PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=lead.program_id FOR SHARE NOWAIT;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
            IF EXISTS(SELECT 1 FROM public.programs WHERE id=lead.program_id AND archived_at IS NOT NULL) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='PROGRAM_INACTIVE',DETAIL=lead.program_id::TEXT;
            END IF;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END;
    END IF;
    lead.id:=gen_random_uuid(); lead.studio_id:=p_studio_id;
    v_at:=clock_timestamp(); lead.created_at:=v_at; lead.updated_at:=v_at;
    INSERT INTO public.leads SELECT lead.*;
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
        VALUES(p_studio_id,lead.id,'note','Lead created',p_actor_id);
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,'lead.created','lead',lead.id,jsonb_build_object('name',lead.first_name||' '||lead.last_name));
    targets:=private.workflow_prepare_capture_v1(p_studio_id);
    PERFORM private.workflow_capture_events_v1(p_studio_id,jsonb_build_array(jsonb_build_object('event_type','lead.created',
        'source_key',lead.id::TEXT,'subject_kind','lead','subject_id',lead.id,'occurred_at',private.automation_utc_text_v1(clock_timestamp()),
        'context',jsonb_build_object('lead_id',lead.id,'program_id',lead.program_id,'stage',lead.stage))),targets);
    result:=to_jsonb(lead);
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'lead.create',fingerprint,'lead',lead.id,result);
    RETURN jsonb_build_object('payload',result,'operation_id',p_operation_id,'replayed',false);
END $$;

-- Retained lead owners: only clear/reference coordination and owned stage capture.
CREATE OR REPLACE FUNCTION public.update_lead_atomic(
    p_studio_id UUID, p_actor_id UUID, p_lead_id UUID, p_patch JSONB
)
RETURNS public.leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
    v_lead public.leads;
    v_update public.leads;
    v_assigned_user UUID;
    v_program public.programs;
    v_activity UUID;
    v_targets JSONB;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END IF;
    -- Use the existing narrow Auth-owner helper before locking memberships or
    -- leads. Account cleanup locks Auth first and then visits these FK children.
    IF NOT private.lock_student_import_actor(p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
          AND user_id=p_actor_id AND archived_at IS NULL
          AND role IN ('admin','front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    -- Validate tenant membership without a row lock, acquire the referenced
    -- Auth parent, then revalidate membership below under its existing lock.
    IF p_patch ? 'assigned_staff_id' AND p_patch->>'assigned_staff_id' IS NOT NULL THEN
        v_assigned_user := (p_patch->>'assigned_staff_id')::UUID;
        IF NOT EXISTS (SELECT 1 FROM public.staff_roles
            WHERE user_id=v_assigned_user AND studio_id=p_studio_id AND archived_at IS NULL) THEN
            RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Assigned staff not found for studio.';
        END IF;
        IF NOT private.lock_student_import_actor(v_assigned_user) THEN
            RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Assigned staff not found for studio.';
        END IF;
    END IF;
    PERFORM 1 FROM public.staff_roles
    WHERE studio_id=p_studio_id AND user_id=p_actor_id
      AND archived_at IS NULL AND role IN ('admin','front_desk') FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    IF v_assigned_user IS NOT NULL THEN
        PERFORM 1 FROM public.staff_roles WHERE user_id=v_assigned_user
            AND studio_id=p_studio_id AND archived_at IS NULL FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Assigned staff not found for studio.';
        END IF;
    END IF;
    -- Staff administration locks membership before studio. Fail before lead
    -- effects if a parent-first writer already owns the studio row.
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END;
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch='{}'::jsonb THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='A nonempty lead patch is required.';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) AS fields(name)
        WHERE name <> ALL(ARRAY['first_name','last_name','email','phone','source','stage',
        'program_interest','program_id','is_minor','guardian_name','guardian_email','guardian_phone',
        'assigned_staff_id','follow_up_date','notes','lost_reason']))
       OR (p_patch ? 'stage' AND p_patch->>'stage' IS NOT NULL AND p_patch->>'stage' <> ALL(
           ARRAY['inquiry','trial_scheduled','trial_completed','offer_sent','closed_lost'])) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported lead patch field or stage.';
    END IF;
    SELECT * INTO v_lead FROM public.leads
    WHERE id=p_lead_id AND studio_id=p_studio_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Lead not found for studio.';
    END IF;
    -- Populating the locked record preserves omitted fields and explicit nulls.
    v_update := jsonb_populate_record(v_lead,p_patch);
    IF p_patch ? 'program_id' AND v_update.program_id IS NOT NULL THEN
        BEGIN
            SELECT * INTO v_program FROM public.programs WHERE id=v_update.program_id
                AND studio_id=p_studio_id FOR SHARE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
        END;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Program not found for studio.';
        END IF;
        IF v_program.archived_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='PROGRAM_INACTIVE', DETAIL=v_program.id::text;
        END IF;
    END IF;
    UPDATE public.leads SET
        first_name=v_update.first_name,last_name=v_update.last_name,email=v_update.email,
        phone=v_update.phone,source=v_update.source,stage=v_update.stage,
        program_interest=v_update.program_interest,program_id=v_update.program_id,
        is_minor=v_update.is_minor,guardian_name=v_update.guardian_name,
        guardian_email=v_update.guardian_email,guardian_phone=v_update.guardian_phone,
        assigned_staff_id=v_update.assigned_staff_id,follow_up_date=v_update.follow_up_date,
        notes=v_update.notes,lost_reason=v_update.lost_reason
    WHERE id=p_lead_id AND studio_id=p_studio_id RETURNING * INTO v_update;
    IF v_lead.stage IS DISTINCT FROM v_update.stage THEN
        INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
        VALUES(p_studio_id,p_lead_id,'stage_change',
            'Stage changed from ' || v_lead.stage || ' to ' || v_update.stage,p_actor_id) RETURNING id INTO v_activity;
        BEGIN
            v_targets:=private.workflow_prepare_capture_v1(p_studio_id);
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM='AUTOMATION_STUDIO_BUSY' THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY'; END IF;
            RAISE;
        END;
        PERFORM private.workflow_capture_events_v1(p_studio_id,jsonb_build_array(jsonb_build_object('event_type','lead.stage_changed',
            'source_key',v_activity::TEXT,'subject_kind','lead','subject_id',p_lead_id,
            'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',jsonb_build_object('lead_id',p_lead_id,
                'program_id',v_update.program_id,'activity_id',v_activity,'old_stage',v_lead.stage,'stage',v_update.stage))),v_targets);
    END IF;
    RETURN v_update;
END;
$function$;

CREATE OR REPLACE FUNCTION public.follow_up_lead_atomic(
    p_studio_id UUID, p_actor_id UUID, p_lead_id UUID, p_operation_id UUID, p_request JSONB
)
RETURNS public.leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
    v_lead public.leads;
    v_result public.leads;
    v_receipt public.lead_follow_up_operations;
    v_request JSONB;
    v_stage TEXT;
    v_program UUID;
    v_program_archived TIMESTAMPTZ;
    v_student UUID;
    v_guardian UUID;
    v_link UUID;
    v_digest BYTEA;
    v_timezone TEXT;
    v_start DATE;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END IF;
    -- Use the existing narrow Auth-owner helper before locking memberships or
    -- leads. Account cleanup locks Auth first and then visits these FK children.
    IF NOT private.lock_student_import_actor(p_actor_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
          AND user_id=p_actor_id AND archived_at IS NULL
          AND role IN ('admin','front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    PERFORM 1 FROM public.staff_roles
    WHERE studio_id=p_studio_id AND user_id=p_actor_id
      AND archived_at IS NULL AND role IN ('admin','front_desk') FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead management permission required.';
    END IF;
    -- Use the same membership-before-studio order as staff administration.
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END;
    IF p_operation_id IS NULL OR p_request IS NULL OR jsonb_typeof(p_request) <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='A keyed follow-up request is required.';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) AS fields(name) WHERE name <> 'next_stage')
       OR (p_request ? 'next_stage' AND jsonb_typeof(p_request->'next_stage') NOT IN ('null','string')) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported follow-up request.';
    END IF;
    v_stage := p_request->>'next_stage';
    IF v_stage IS NOT NULL AND v_stage <> ALL(ARRAY['inquiry','trial_scheduled','trial_completed',
        'offer_sent','enrolled','closed_lost']) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported follow-up stage.';
    END IF;
    -- Keep conversion authorization explicit even while its roles match lead management.
    IF v_stage='enrolled' AND NOT EXISTS(SELECT 1 FROM public.staff_roles
        WHERE studio_id=p_studio_id AND user_id=p_actor_id AND archived_at IS NULL
        AND role IN ('admin','front_desk')) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Lead conversion permission required.';
    END IF;
    v_request := jsonb_build_object('next_stage',v_stage);
    -- A global operation identity also rejects reuse for another tenant or lead.
    -- This lock precedes the lead lock for every follow-up caller.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'lead-follow-up:' || p_operation_id::text,0));
    SELECT * INTO v_receipt FROM public.lead_follow_up_operations WHERE operation_id=p_operation_id;
    IF FOUND THEN
        IF v_receipt.studio_id IS DISTINCT FROM p_studio_id
           OR v_receipt.actor_id IS DISTINCT FROM p_actor_id
           OR v_receipt.lead_id IS DISTINCT FROM p_lead_id
           OR v_receipt.request IS DISTINCT FROM v_request THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Follow-up operation identity conflict.';
        END IF;
        RETURN jsonb_populate_record(NULL::public.leads,v_receipt.result);
    END IF;
    SELECT * INTO v_lead FROM public.leads
    WHERE id=p_lead_id AND studio_id=p_studio_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Lead not found for studio.';
    END IF;
    IF v_stage='enrolled' THEN
        IF v_lead.converted_student_id IS NOT NULL THEN
            -- Restoring the existing conversion must also work after the lead's
            -- original program was archived or its interest was cleared.
            SELECT * INTO v_result FROM public.convert_lead_to_student_atomic(
                p_studio_id,p_actor_id,p_lead_id,v_lead.converted_student_id,
                NULL,NULL,NULL,NULL,NULL);
        ELSE
            v_program := v_lead.program_id;
            IF v_program IS NULL THEN
                SELECT id INTO v_program FROM public.programs
                WHERE studio_id=p_studio_id AND name='Unassigned' LIMIT 1;
                IF v_program IS NULL THEN
                    INSERT INTO public.programs(studio_id,name,description,color_hex,sort_order,is_system)
                    VALUES(p_studio_id,'Unassigned','Students awaiting program assignment.','#94A3B8',9999,TRUE)
                    ON CONFLICT (studio_id,lower(name)) WHERE archived_at IS NULL DO NOTHING
                    RETURNING id INTO v_program;
                    IF v_program IS NULL THEN
                        SELECT id INTO v_program FROM public.programs
                        WHERE studio_id=p_studio_id AND name='Unassigned' AND archived_at IS NULL;
                    END IF;
                END IF;
            END IF;
            BEGIN
                SELECT archived_at INTO v_program_archived FROM public.programs
                WHERE id=v_program AND studio_id=p_studio_id FOR SHARE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
            END;
            IF NOT FOUND THEN
                RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='Program not found for studio.';
            END IF;
            IF v_program_archived IS NOT NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='PROGRAM_INACTIVE', DETAIL=v_program::text;
            END IF;
            -- RFC 4122 UUIDv5, identical to LeadService's established namespace/names.
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(p_studio_id::text || ':' || p_lead_id::text || ':student','UTF8'),'sha1') FROM 1 FOR 16);
            v_student := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(p_studio_id::text || ':' || p_lead_id::text || ':guardian','UTF8'),'sha1') FROM 1 FOR 16);
            v_guardian := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            v_digest := substring(extensions.digest(uuid_send('27c8322f-a4e4-46d7-bfae-018f6b638858'::uuid)
                || convert_to(v_student::text || ':' || v_guardian::text || ':link','UTF8'),'sha1') FROM 1 FOR 16);
            v_link := encode(set_byte(set_byte(v_digest,6,(get_byte(v_digest,6) & 15) | 80),
                8,(get_byte(v_digest,8) & 63) | 128),'hex')::uuid;
            SELECT COALESCE(NULLIF(timezone,''),'UTC') INTO v_timezone FROM public.studios WHERE id=p_studio_id;
            IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v_timezone) THEN
                v_timezone := 'UTC';
            END IF;
            v_start := (CURRENT_TIMESTAMP AT TIME ZONE v_timezone)::date;
            SELECT * INTO v_result FROM public.convert_lead_to_student_atomic(p_studio_id,p_actor_id,p_lead_id,
                v_student,v_program,'active',v_start,v_guardian,v_link);
        END IF;
    ELSE
        SELECT * INTO v_result FROM public.update_lead_atomic(p_studio_id,p_actor_id,p_lead_id,
            jsonb_build_object('follow_up_date',NULL) ||
            CASE WHEN v_stage IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stage',v_stage) END);
    END IF;
    INSERT INTO public.lead_activities(studio_id,lead_id,activity_type,description,created_by)
    VALUES(p_studio_id,p_lead_id,'follow_up',CASE WHEN v_stage IS NULL THEN 'Contacted lead'
        ELSE 'Contacted lead and moved to ' || v_stage END,p_actor_id);
    INSERT INTO public.lead_follow_up_operations(operation_id,studio_id,actor_id,lead_id,request,result)
    VALUES(p_operation_id,p_studio_id,p_actor_id,p_lead_id,v_request,to_jsonb(v_result));
    RETURN v_result;
END;
$function$;

DO $capture_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_prepare_capture_v1','workflow_capture_events_v1','workflow_lock_lead_assignee_v1'))
            OR (n.nspname='public' AND p.proname='create_lead_atomic_v1') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
    END LOOP;
END;
$capture_privileges$;

-- Only actual interactive INSERT owners call this helper. Keep the filter
-- projection bounded by frozen targets, not by the student's membership count.
CREATE FUNCTION private.workflow_student_enrollment_event_v1(p_studio_id UUID,p_student_id UUID,p_targets JSONB)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('event_type','student.enrolled','source_key',p_student_id::TEXT,
        'subject_kind','student','subject_id',p_student_id,'occurred_at',private.automation_utc_text_v1(clock_timestamp()),
        'context',jsonb_build_object('student_id',p_student_id,'matched_program_ids',coalesce((
            SELECT jsonb_agg(program_id ORDER BY program_id) FROM (
                SELECT DISTINCT (t->>'program_id')::UUID program_id
                FROM jsonb_array_elements(p_targets->'targets') t
                WHERE t->>'event_type'='student.enrolled' AND t->>'program_id' IS NOT NULL
                    AND EXISTS(SELECT 1 FROM public.student_program_memberships m
                        JOIN public.programs p ON p.id=m.program_id AND p.studio_id=m.studio_id
                        WHERE m.studio_id=p_studio_id AND m.student_id=p_student_id
                            AND m.program_id=(t->>'program_id')::UUID AND m.status IN ('active','paused')
                            AND m.ended_at IS NULL AND p.archived_at IS NULL)
            ) matched),'[]'::JSONB)))
$$;

-- Retained source owners: entry coordination, actual identities and capture only.
CREATE OR REPLACE FUNCTION private.write_student_profile_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_student JSONB,
    p_program_ids UUID[] DEFAULT NULL,
    p_guardians JSONB DEFAULT '[]'::JSONB,
    p_replace_programs BOOLEAN DEFAULT FALSE,
    p_audit_action TEXT DEFAULT 'student.updated'
)
RETURNS public.students
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.students%ROWTYPE;
    v_updated public.students%ROWTYPE;
    v_program_ids UUID[] := COALESCE(p_program_ids, ARRAY[]::UUID[]);
    v_program_id UUID;
    v_rank_program_id UUID;
    v_membership_id UUID;
    v_current_belt_rank_id UUID;
    v_membership_started_at DATE;
    v_today DATE := CURRENT_DATE;
    v_tags TEXT[];
    v_guardian JSONB;
    v_guardian_row public.guardians%ROWTYPE;
    v_guardian_id UUID;
    v_guardian_key TEXT;
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
    v_inserted BOOLEAN := false;
    v_rank_scope UUID;
    v_rank_unmarked BOOLEAN := false;
BEGIN
    -- Public rank preservation may already own the student; never wait on clear.
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended(
        'koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    IF p_student IS NULL OR jsonb_typeof(p_student) <> 'object' THEN
        RAISE EXCEPTION 'Student write payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    IF p_student_id IS NULL THEN
        RAISE EXCEPTION 'Student write requires a student id.'
            USING ERRCODE = '22023';
    END IF;

    IF p_student ? 'studio_id' AND NULLIF(p_student->>'studio_id', '')::UUID IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Student write payload studio does not match request studio.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_replace_programs THEN
        IF cardinality(v_program_ids) IS NULL OR cardinality(v_program_ids) = 0 THEN
            RAISE EXCEPTION 'Student write requires program memberships.'
                USING ERRCODE = '22023';
        END IF;

        FOREACH v_program_id IN ARRAY v_program_ids LOOP
            IF v_program_id IS NULL THEN
                RAISE EXCEPTION 'Student write includes an empty program id.'
                    USING ERRCODE = '22023';
            END IF;

            PERFORM 1
              FROM public.programs
             WHERE id = v_program_id
               AND studio_id = p_studio_id
               AND archived_at IS NULL;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Student write program does not belong to this studio or is archived.'
                    USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
    END IF;

    IF p_student ? 'tags' THEN
        SELECT COALESCE(array_agg(tag.value), ARRAY[]::TEXT[])
          INTO v_tags
          FROM jsonb_array_elements_text(
              CASE
                  WHEN jsonb_typeof(p_student->'tags') = 'array' THEN p_student->'tags'
                  ELSE '[]'::JSONB
              END
          ) AS tag(value);
    END IF;

    SELECT *
      INTO v_existing
      FROM public.students
     WHERE id = p_student_id
     FOR UPDATE;

    IF FOUND AND v_existing.studio_id <> p_studio_id THEN
        RAISE EXCEPTION 'Student id already belongs to another studio.'
            USING ERRCODE = 'P0001';
    END IF;

    -- Preserve FOUND from the source lookup before any coordination query.
    IF v_existing.id IS NULL THEN
        IF p_audit_action <> 'student.created' THEN
            RAISE EXCEPTION 'Student not found for update.'
                USING ERRCODE = 'P0001';
        END IF;

        IF NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '') IS NULL
           OR NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Student create payload is missing required name fields.'
                USING ERRCODE = '22023';
        END IF;

        SELECT id INTO v_rank_scope FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND student_id=p_student_id
            AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() AND state='active' AND owner='profile';
        IF v_rank_scope IS NULL AND EXISTS(SELECT 1 FROM public.studios WHERE id=p_studio_id) THEN
            v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,p_student_id,'private_profile');
            v_rank_unmarked := true;
        END IF;

        INSERT INTO public.students (
            id,
            studio_id,
            legal_first_name,
            legal_last_name,
            preferred_name,
            date_of_birth,
            is_minor,
            email,
            phone,
            address_line1,
            address_city,
            address_state,
            address_zip,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_contact_relation,
            status,
            membership_start_date,
            program_id,
            current_belt_rank_id,
            notes,
            tags,
            hold_start_date,
            hold_end_date
        )
        VALUES (
            p_student_id,
            p_studio_id,
            NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), ''),
            NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), ''),
            NULLIF(p_student->>'preferred_name', ''),
            NULLIF(p_student->>'date_of_birth', '')::DATE,
            COALESCE((p_student->>'is_minor')::BOOLEAN, false),
            NULLIF(p_student->>'email', ''),
            NULLIF(p_student->>'phone', ''),
            NULLIF(p_student->>'address_line1', ''),
            NULLIF(p_student->>'address_city', ''),
            NULLIF(p_student->>'address_state', ''),
            NULLIF(p_student->>'address_zip', ''),
            NULLIF(p_student->>'emergency_contact_name', ''),
            NULLIF(p_student->>'emergency_contact_phone', ''),
            NULLIF(p_student->>'emergency_contact_relation', ''),
            COALESCE(NULLIF(p_student->>'status', ''), 'active'),
            NULLIF(p_student->>'membership_start_date', '')::DATE,
            CASE WHEN p_replace_programs THEN v_program_ids[1] ELSE NULLIF(p_student->>'program_id', '')::UUID END,
            NULLIF(p_student->>'current_belt_rank_id', '')::UUID,
            NULLIF(p_student->>'notes', ''),
            COALESCE(v_tags, ARRAY[]::TEXT[]),
            NULLIF(p_student->>'hold_start_date', '')::DATE,
            NULLIF(p_student->>'hold_end_date', '')::DATE
        )
        RETURNING * INTO v_updated;
        v_inserted := true;
    ELSE
        SELECT id INTO v_rank_scope FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND student_id=p_student_id
            AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() AND state='active' AND owner='profile';
        IF v_rank_scope IS NULL AND EXISTS(SELECT 1 FROM public.studios WHERE id=p_studio_id) THEN
            v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,p_student_id,'private_profile');
            v_rank_unmarked := true;
        END IF;
        UPDATE public.students
           SET legal_first_name = CASE WHEN p_student ? 'legal_first_name' THEN NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '') ELSE legal_first_name END,
               legal_last_name = CASE WHEN p_student ? 'legal_last_name' THEN NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '') ELSE legal_last_name END,
               preferred_name = CASE WHEN p_student ? 'preferred_name' THEN NULLIF(p_student->>'preferred_name', '') ELSE preferred_name END,
               date_of_birth = CASE WHEN p_student ? 'date_of_birth' THEN NULLIF(p_student->>'date_of_birth', '')::DATE ELSE date_of_birth END,
               is_minor = CASE WHEN p_student ? 'is_minor' THEN COALESCE((p_student->>'is_minor')::BOOLEAN, false) ELSE is_minor END,
               email = CASE WHEN p_student ? 'email' THEN NULLIF(p_student->>'email', '') ELSE email END,
               phone = CASE WHEN p_student ? 'phone' THEN NULLIF(p_student->>'phone', '') ELSE phone END,
               address_line1 = CASE WHEN p_student ? 'address_line1' THEN NULLIF(p_student->>'address_line1', '') ELSE address_line1 END,
               address_city = CASE WHEN p_student ? 'address_city' THEN NULLIF(p_student->>'address_city', '') ELSE address_city END,
               address_state = CASE WHEN p_student ? 'address_state' THEN NULLIF(p_student->>'address_state', '') ELSE address_state END,
               address_zip = CASE WHEN p_student ? 'address_zip' THEN NULLIF(p_student->>'address_zip', '') ELSE address_zip END,
               emergency_contact_name = CASE WHEN p_student ? 'emergency_contact_name' THEN NULLIF(p_student->>'emergency_contact_name', '') ELSE emergency_contact_name END,
               emergency_contact_phone = CASE WHEN p_student ? 'emergency_contact_phone' THEN NULLIF(p_student->>'emergency_contact_phone', '') ELSE emergency_contact_phone END,
               emergency_contact_relation = CASE WHEN p_student ? 'emergency_contact_relation' THEN NULLIF(p_student->>'emergency_contact_relation', '') ELSE emergency_contact_relation END,
               status = CASE WHEN p_student ? 'status' THEN COALESCE(NULLIF(p_student->>'status', ''), status) ELSE status END,
               membership_start_date = CASE WHEN p_student ? 'membership_start_date' THEN NULLIF(p_student->>'membership_start_date', '')::DATE ELSE membership_start_date END,
               program_id = CASE WHEN p_replace_programs THEN v_program_ids[1] WHEN p_student ? 'program_id' THEN NULLIF(p_student->>'program_id', '')::UUID ELSE program_id END,
               current_belt_rank_id = CASE WHEN p_student ? 'current_belt_rank_id' THEN NULLIF(p_student->>'current_belt_rank_id', '')::UUID ELSE current_belt_rank_id END,
               notes = CASE WHEN p_student ? 'notes' THEN NULLIF(p_student->>'notes', '') ELSE notes END,
               tags = CASE WHEN p_student ? 'tags' THEN COALESCE(v_tags, ARRAY[]::TEXT[]) ELSE tags END,
               hold_start_date = CASE WHEN p_student ? 'hold_start_date' THEN NULLIF(p_student->>'hold_start_date', '')::DATE ELSE hold_start_date END,
               hold_end_date = CASE WHEN p_student ? 'hold_end_date' THEN NULLIF(p_student->>'hold_end_date', '')::DATE ELSE hold_end_date END
         WHERE id = p_student_id
           AND studio_id = p_studio_id
         RETURNING * INTO v_updated;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student not found for update.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_replace_programs THEN
        v_current_belt_rank_id := v_updated.current_belt_rank_id;
        v_membership_started_at := v_updated.membership_start_date;

        IF v_current_belt_rank_id IS NOT NULL THEN
            SELECT ladder.program_id
              INTO v_rank_program_id
              FROM public.belt_ranks AS belt_rank
              JOIN public.belt_ladders AS ladder ON ladder.id = belt_rank.ladder_id
             WHERE belt_rank.id = v_current_belt_rank_id
               AND belt_rank.studio_id = p_studio_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Current belt rank does not belong to this studio.'
                    USING ERRCODE = 'P0001';
            END IF;
        END IF;

        UPDATE public.student_program_memberships AS membership
           SET status = 'ended',
               ended_at = v_today,
               current_belt_rank_id = NULL
         WHERE membership.student_id = p_student_id
           AND membership.studio_id = p_studio_id
           AND membership.ended_at IS NULL
           AND NOT (membership.program_id = ANY(v_program_ids));

        FOREACH v_program_id IN ARRAY v_program_ids LOOP
            SELECT membership.id
              INTO v_membership_id
              FROM public.student_program_memberships AS membership
             WHERE membership.student_id = p_student_id
               AND membership.studio_id = p_studio_id
               AND membership.program_id = v_program_id
               AND membership.ended_at IS NULL
             FOR UPDATE;

            IF FOUND THEN
                UPDATE public.student_program_memberships AS membership
                   SET status = CASE WHEN membership.status = 'paused' THEN 'paused' ELSE 'active' END,
                       ended_at = NULL,
                       current_belt_rank_id = CASE
                           WHEN v_current_belt_rank_id IS NOT NULL
                                AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                           THEN v_current_belt_rank_id
                           ELSE NULL
                       END
                 WHERE membership.id = v_membership_id
                   AND membership.studio_id = p_studio_id;
            ELSE
                INSERT INTO public.student_program_memberships (
                    studio_id,
                    student_id,
                    program_id,
                    status,
                    started_at,
                    current_belt_rank_id
                )
                VALUES (
                    p_studio_id,
                    p_student_id,
                    v_program_id,
                    'active',
                    v_membership_started_at,
                    CASE
                        WHEN v_current_belt_rank_id IS NOT NULL
                             AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                        THEN v_current_belt_rank_id
                        ELSE NULL
                    END
                );
            END IF;
        END LOOP;
    END IF;

    -- An empty array preserves every guardian and link. Supplied entries add a
    -- contact or patch an already-linked contact; removal is never implicit.
    IF p_guardians IS NULL OR jsonb_typeof(p_guardians) <> 'array' THEN
        RAISE EXCEPTION 'Student guardians payload must be an array.'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT (entry->>'id')::UUID
          FROM jsonb_array_elements(p_guardians) entry
         WHERE jsonb_typeof(entry) = 'object' AND entry ? 'id'
         GROUP BY (entry->>'id')::UUID HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Duplicate guardian id in student write.' USING ERRCODE = '22023';
    END IF;

    -- Shared family contacts can be edited from different students. Lock the
    -- guardian rows in UUID order after the existing student/membership locks.
    PERFORM guardian.id
      FROM public.guardians guardian
     WHERE guardian.studio_id = p_studio_id
       AND guardian.id IN (
           SELECT (entry->>'id')::UUID
             FROM jsonb_array_elements(p_guardians) entry
            WHERE jsonb_typeof(entry) = 'object' AND entry ? 'id'
       )
     ORDER BY guardian.id
     FOR UPDATE;

    FOR v_guardian IN SELECT value FROM jsonb_array_elements(p_guardians)
    LOOP
        IF jsonb_typeof(v_guardian) <> 'object' THEN
            RAISE EXCEPTION 'Guardian payload must be a JSON object.' USING ERRCODE = '22023';
        END IF;
        FOR v_guardian_key IN SELECT jsonb_object_keys(v_guardian)
        LOOP
            IF v_guardian_key NOT IN ('id', 'first_name', 'last_name', 'email', 'phone', 'relation', 'is_primary_contact') THEN
                RAISE EXCEPTION 'Unknown guardian field.' USING ERRCODE = '22023';
            END IF;
            IF v_guardian_key = 'is_primary_contact' THEN
                IF jsonb_typeof(v_guardian->v_guardian_key) <> 'boolean' THEN
                    RAISE EXCEPTION 'Guardian primary contact flag must be a boolean.' USING ERRCODE = '22023';
                END IF;
            ELSIF jsonb_typeof(v_guardian->v_guardian_key) <> 'string'
                  AND NOT (v_guardian_key IN ('email', 'phone', 'relation') AND v_guardian->v_guardian_key = 'null'::JSONB) THEN
                RAISE EXCEPTION 'Guardian field must be a string.' USING ERRCODE = '22023';
            END IF;
        END LOOP;

        v_guardian_first_name := NULLIF(btrim(COALESCE(v_guardian->>'first_name', '')), '');
        v_guardian_last_name := NULLIF(btrim(COALESCE(v_guardian->>'last_name', '')), '');
        IF (NOT (v_guardian ? 'id') OR v_guardian ? 'first_name') AND v_guardian_first_name IS NULL
           OR NOT (v_guardian ? 'id') AND NOT (v_guardian ? 'last_name') THEN
            RAISE EXCEPTION 'Guardian first name is required; last name must be a string.' USING ERRCODE = '22023';
        END IF;

        IF v_guardian ? 'id' THEN
            v_guardian_id := (v_guardian->>'id')::UUID;
            IF v_guardian_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.student_guardians link
                JOIN public.guardians guardian ON guardian.id = link.guardian_id
                WHERE link.student_id = p_student_id
                  AND guardian.id = v_guardian_id
                  AND guardian.studio_id = p_studio_id
            ) THEN
                RAISE EXCEPTION 'Guardian is not linked to this student in this studio.' USING ERRCODE = '22023';
            END IF;
            IF v_guardian = jsonb_build_object('id', v_guardian_id) THEN
                RAISE EXCEPTION 'Provide guardian fields to update.' USING ERRCODE = '22023';
            END IF;
            UPDATE public.guardians
               SET first_name = CASE WHEN v_guardian ? 'first_name' THEN v_guardian_first_name ELSE first_name END,
                   last_name = CASE WHEN v_guardian ? 'last_name' THEN btrim(v_guardian->>'last_name') ELSE last_name END,
                   email = CASE WHEN v_guardian ? 'email' THEN NULLIF(btrim(v_guardian->>'email'), '') ELSE email END,
                   phone = CASE WHEN v_guardian ? 'phone' THEN NULLIF(btrim(v_guardian->>'phone'), '') ELSE phone END,
                   relation = CASE WHEN v_guardian ? 'relation' THEN NULLIF(btrim(v_guardian->>'relation'), '') ELSE relation END,
                   is_primary_contact = CASE WHEN v_guardian ? 'is_primary_contact' THEN (v_guardian->>'is_primary_contact')::BOOLEAN ELSE is_primary_contact END
             WHERE id = v_guardian_id AND studio_id = p_studio_id;
        ELSE
            INSERT INTO public.guardians (
                studio_id, first_name, last_name, email, phone, relation, is_primary_contact
            ) VALUES (
                p_studio_id, v_guardian_first_name, btrim(v_guardian->>'last_name'),
                NULLIF(btrim(v_guardian->>'email'), ''), NULLIF(btrim(v_guardian->>'phone'), ''),
                NULLIF(btrim(v_guardian->>'relation'), ''),
                COALESCE((v_guardian->>'is_primary_contact')::BOOLEAN, false)
            ) RETURNING * INTO v_guardian_row;
            INSERT INTO public.student_guardians (student_id, guardian_id)
            VALUES (p_student_id, v_guardian_row.id);
        END IF;
    END LOOP;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        p_studio_id,
        p_actor_id,
        p_audit_action,
        'student',
        p_student_id,
        CASE
            WHEN p_audit_action = 'student.created' THEN
                jsonb_build_object('name', concat_ws(' ', v_updated.legal_first_name, v_updated.legal_last_name))
            ELSE
                p_student || CASE WHEN jsonb_array_length(p_guardians) > 0 THEN jsonb_build_object('guardians', p_guardians) ELSE '{}'::JSONB END
        END
    );

    IF v_inserted THEN
        INSERT INTO private.workflow_rank_pending_events(scope_id,studio_id,intent)
            VALUES(v_rank_scope,p_studio_id,jsonb_build_object('event_type','student.enrolled','student_id',p_student_id));
    END IF;
    IF v_rank_unmarked THEN
        -- The retained public caller may still restore ranks after this return.
        UPDATE private.workflow_rank_scopes SET state='unknown' WHERE id=v_rank_scope;
    END IF;
    RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION public.convert_lead_to_student_atomic(
    p_studio_id UUID,
    p_actor_id UUID,
    p_lead_id UUID,
    p_student_id UUID,
    p_program_id UUID,
    p_status TEXT,
    p_membership_start_date DATE,
    p_guardian_id UUID DEFAULT NULL,
    p_student_guardian_id UUID DEFAULT NULL
)
RETURNS public.leads
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lead public.leads%ROWTYPE;
    v_student public.students%ROWTYPE;
    v_existing_studio UUID;
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
    v_updated public.leads%ROWTYPE;
    v_inserted INTEGER;
    v_activity UUID;
    v_targets JSONB;
    v_events JSONB := '[]'::JSONB;
    v_rank_scope UUID;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended(
        'koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='LEAD_STUDIO_BUSY';
    END IF;
    SELECT *
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
      AND studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead not found for studio.';
    END IF;

    -- Conversion identity is permanent even when an ordinary edit moves the lead
    -- backwards. Re-enrollment restores only lead state, never student details,
    -- program membership or guardians. It needs no active/new program selection.
    IF v_lead.converted_student_id IS NOT NULL THEN
        IF v_lead.stage = 'enrolled' AND v_lead.follow_up_date IS NULL THEN
            RETURN v_lead;
        END IF;
        UPDATE public.leads
        SET stage = 'enrolled', follow_up_date = NULL
        WHERE id = p_lead_id AND studio_id = p_studio_id
        RETURNING * INTO v_updated;
        IF v_lead.stage IS DISTINCT FROM 'enrolled' THEN
            INSERT INTO public.lead_activities (
                studio_id, lead_id, activity_type, description, created_by
            ) VALUES (
                p_studio_id, p_lead_id, 'stage_change',
                'Stage changed from ' || v_lead.stage || ' to enrolled', p_actor_id
            ) RETURNING id INTO v_activity;
            v_targets := private.workflow_prepare_capture_v1(p_studio_id);
            PERFORM private.workflow_capture_events_v1(p_studio_id,jsonb_build_array(jsonb_build_object(
                'event_type','lead.stage_changed','source_key',v_activity::TEXT,'subject_kind','lead','subject_id',p_lead_id,
                'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',jsonb_build_object(
                    'lead_id',p_lead_id,'program_id',v_updated.program_id,'activity_id',v_activity,
                    'old_stage',v_lead.stage,'stage',v_updated.stage))),v_targets);
        END IF;
        RETURN v_updated;
    END IF;

    IF p_program_id IS NULL THEN
        RAISE EXCEPTION 'Lead conversion requires a program id.';
    END IF;

    SELECT studio_id
    INTO v_existing_studio
    FROM public.students
    WHERE id = p_student_id
    FOR UPDATE;

    IF v_existing_studio IS NOT NULL AND v_existing_studio <> p_studio_id THEN
        RAISE EXCEPTION 'Student id already belongs to another studio.';
    END IF;

    v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,p_student_id,'conversion');

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        is_minor,
        email,
        phone,
        status,
        membership_start_date,
        program_id,
        notes,
        tags
    )
    VALUES (
        p_student_id,
        p_studio_id,
        v_lead.first_name,
        v_lead.last_name,
        COALESCE(v_lead.is_minor, false),
        v_lead.email,
        v_lead.phone,
        p_status,
        p_membership_start_date,
        p_program_id,
        v_lead.notes,
        ARRAY['converted-lead']::TEXT[]
    )
    ON CONFLICT (id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    SELECT *
    INTO v_student
    FROM public.students
    WHERE id = p_student_id
      AND studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Converted student was not available after insert.';
    END IF;

    UPDATE public.student_program_memberships
    SET status = 'active',
        started_at = p_membership_start_date,
        ended_at = NULL
    WHERE studio_id = p_studio_id
      AND student_id = p_student_id
      AND program_id = p_program_id
      AND ended_at IS NULL;

    IF NOT FOUND THEN
        INSERT INTO public.student_program_memberships (
            studio_id,
            student_id,
            program_id,
            status,
            started_at
        )
        VALUES (
            p_studio_id,
            p_student_id,
            p_program_id,
            'active',
            p_membership_start_date
        )
        ON CONFLICT (student_id, program_id) WHERE ended_at IS NULL
        DO UPDATE SET
            status = 'active',
            started_at = EXCLUDED.started_at,
            ended_at = NULL
        WHERE student_program_memberships.studio_id = p_studio_id
        ;

        IF NOT EXISTS (
            SELECT 1
            FROM public.student_program_memberships
            WHERE studio_id = p_studio_id
              AND student_id = p_student_id
              AND program_id = p_program_id
              AND ended_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Converted student membership could not be activated for this studio.';
        END IF;
    END IF;

    IF v_lead.is_minor AND NULLIF(btrim(COALESCE(v_lead.guardian_name, '')), '') IS NOT NULL THEN
        IF p_guardian_id IS NULL OR p_student_guardian_id IS NULL THEN
            RAISE EXCEPTION 'Minor lead conversion requires guardian ids.';
        END IF;

        SELECT studio_id
        INTO v_existing_studio
        FROM public.guardians
        WHERE id = p_guardian_id;

        IF v_existing_studio IS NOT NULL AND v_existing_studio <> p_studio_id THEN
            RAISE EXCEPTION 'Guardian id already belongs to another studio.';
        END IF;

        v_guardian_first_name := split_part(btrim(v_lead.guardian_name), ' ', 1);
        v_guardian_last_name := NULLIF(btrim(substr(btrim(v_lead.guardian_name), length(v_guardian_first_name) + 1)), '');

        INSERT INTO public.guardians (
            id,
            studio_id,
            first_name,
            last_name,
            email,
            phone,
            is_primary_contact
        )
        VALUES (
            p_guardian_id,
            p_studio_id,
            v_guardian_first_name,
            COALESCE(v_guardian_last_name, ''),
            v_lead.guardian_email,
            v_lead.guardian_phone,
            TRUE
        )
        ON CONFLICT (id) DO NOTHING;

        SELECT student.studio_id
        INTO v_existing_studio
        FROM public.student_guardians AS link
        JOIN public.students AS student ON student.id = link.student_id
        WHERE link.id = p_student_guardian_id;

        IF v_existing_studio IS NOT NULL AND v_existing_studio <> p_studio_id THEN
            RAISE EXCEPTION 'Student guardian link id already belongs to another studio.';
        END IF;

        INSERT INTO public.student_guardians (
            id,
            student_id,
            guardian_id
        )
        VALUES (
            p_student_guardian_id,
            p_student_id,
            p_guardian_id
        )
        ON CONFLICT (id) DO NOTHING;

        IF NOT EXISTS (
            SELECT 1
            FROM public.student_guardians
            WHERE id = p_student_guardian_id
              AND student_id = p_student_id
              AND guardian_id = p_guardian_id
        ) THEN
            RAISE EXCEPTION 'Student guardian link id already points at a different relationship.';
        END IF;
    END IF;

    UPDATE public.leads
    SET stage = 'enrolled',
        converted_student_id = p_student_id,
        follow_up_date = NULL
    WHERE id = p_lead_id
      AND studio_id = p_studio_id
    RETURNING * INTO v_updated;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lead was not updated during conversion.';
    END IF;

    INSERT INTO public.lead_activities (
        studio_id,
        lead_id,
        activity_type,
        description,
        created_by
    )
    VALUES (
        p_studio_id,
        p_lead_id,
        'stage_change',
        'Converted to student (ID: ' || p_student_id::TEXT || ')',
        p_actor_id
    ) RETURNING id INTO v_activity;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        p_studio_id,
        p_actor_id,
        'lead.converted',
        'lead',
        p_lead_id,
        jsonb_build_object('student_id', p_student_id)
    );

    -- The finalizer freezes stage and welcome capture with rank invalidation.
    IF v_lead.stage IS DISTINCT FROM v_updated.stage THEN
        v_events := jsonb_build_array(jsonb_build_object(
            'event_type','lead.stage_changed','source_key',v_activity::TEXT,'subject_kind','lead','subject_id',p_lead_id,
            'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',jsonb_build_object(
                'lead_id',p_lead_id,'program_id',v_updated.program_id,'activity_id',v_activity,
                'old_stage',v_lead.stage,'stage',v_updated.stage)));
    END IF;
    IF v_inserted = 1 THEN
        v_events := v_events || jsonb_build_array(jsonb_build_object('event_type','student.enrolled','student_id',p_student_id));
    END IF;
    PERFORM private.workflow_rank_scope_finish_v1(v_rank_scope,NULL,v_events);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    RETURN v_updated;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_student_rank_transition_v3(
    p_studio_id UUID,
    p_student_id UUID,
    p_student_program_membership_id UUID,
    p_program_id UUID,
    p_from_rank_id UUID,
    p_to_rank_id UUID,
    p_actor_id UUID,
    p_notes TEXT,
    p_transition_kind TEXT,
    p_operation_id UUID,
    p_resolve_context BOOLEAN
)
RETURNS public.promotions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_transition public.promotions%ROWTYPE;
    v_student public.students%ROWTYPE;
    v_membership public.student_program_memberships%ROWTYPE;
    v_target_ladder_id UUID;
    v_target_ladder_program_id UUID;
    v_from_ladder_id UUID;
    v_from_position INTEGER;
    v_to_position INTEGER;
    v_expected_action TEXT;
    v_requested_program UUID := p_program_id;
    v_evidence_program UUID;
    v_evidence_membership UUID;
    v_evidence_from UUID;
    v_legacy_audits INTEGER;
    v_legacy_verified BOOLEAN;
    v_rank_scope UUID;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended(
        'koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    IF p_studio_id IS NULL OR p_student_id IS NULL OR p_to_rank_id IS NULL
       OR p_actor_id IS NULL OR p_resolve_context IS NULL
       OR (p_resolve_context AND p_operation_id IS NULL)
       OR p_transition_kind IS NULL OR p_transition_kind NOT IN ('promotion', 'demotion') THEN
        RAISE EXCEPTION 'Rank transition command is invalid.'
            USING ERRCODE = '22023', DETAIL = 'rank_transition_invalid';
    END IF;
    IF p_transition_kind = 'demotion' AND NULLIF(BTRIM(p_notes), '') IS NULL THEN
        RAISE EXCEPTION 'A demotion reason is required.'
            USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
    END IF;
    v_expected_action := CASE p_transition_kind
        WHEN 'promotion' THEN 'student.promoted' ELSE 'student.demoted' END;

    IF p_operation_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'student_rank_transition|' || p_studio_id::TEXT || '|' || p_operation_id::TEXT, 0
        ));
        SELECT * INTO v_transition FROM public.promotions promotion
        WHERE promotion.studio_id = p_studio_id AND promotion.operation_id = p_operation_id;
        IF FOUND THEN
            IF v_transition.command_fingerprint IS NOT NULL THEN
                v_evidence_program := CASE WHEN p_resolve_context
                    THEN COALESCE(p_program_id, v_transition.command_program_id) ELSE p_program_id END;
                v_evidence_membership := CASE WHEN p_resolve_context
                    THEN COALESCE(p_student_program_membership_id, v_transition.command_membership_id)
                    ELSE p_student_program_membership_id END;
                v_evidence_from := CASE WHEN p_resolve_context
                    THEN v_transition.command_from_rank_id ELSE p_from_rank_id END;
                IF v_transition.command_fingerprint IS DISTINCT FROM private.rank_transition_fingerprint_v1(
                    p_studio_id, p_operation_id, p_student_id, p_actor_id, p_to_rank_id,
                    v_evidence_from, v_evidence_program, v_evidence_membership,
                    p_transition_kind, p_notes
                ) THEN
                    RAISE EXCEPTION 'Operation ID was already used for a different rank transition.'
                        USING ERRCODE = '22023', DETAIL = 'rank_transition_conflict';
                END IF;
            ELSE
                -- The API asserts only supplied context. V2 asserts exact context/from.
                IF v_transition.student_id IS DISTINCT FROM p_student_id
                   OR v_transition.to_rank_id IS DISTINCT FROM p_to_rank_id
                   OR v_transition.promoted_by IS DISTINCT FROM p_actor_id
                   OR v_transition.transition_kind IS DISTINCT FROM p_transition_kind
                   OR v_transition.notes IS DISTINCT FROM p_notes
                   OR ((NOT p_resolve_context OR p_program_id IS NOT NULL)
                       AND v_transition.program_id IS DISTINCT FROM p_program_id)
                   OR ((NOT p_resolve_context OR p_student_program_membership_id IS NOT NULL)
                       AND v_transition.student_program_membership_id IS DISTINCT FROM p_student_program_membership_id)
                   OR (NOT p_resolve_context AND v_transition.from_rank_id IS DISTINCT FROM p_from_rank_id) THEN
                    RAISE EXCEPTION 'Operation ID was already used for a different rank transition.'
                        USING ERRCODE = '22023', DETAIL = 'rank_transition_conflict';
                END IF;
                IF NOT p_resolve_context AND (p_program_id IS NULL
                    OR p_student_program_membership_id IS NULL OR p_from_rank_id IS NULL) THEN
                    -- A nullable FK cannot prove an original null. Match one complete
                    -- transaction audit, with explicit JSON nulls rather than missing keys.
                    SELECT count(*), bool_and(
                        audit.actor_id = p_actor_id AND audit.action = v_expected_action
                        AND audit.metadata @> jsonb_build_object(
                            'student_id', p_student_id, 'operation_id', p_operation_id,
                            'transition_kind', p_transition_kind, 'program_id', p_program_id,
                            'student_program_membership_id', p_student_program_membership_id,
                            'from_rank_id', p_from_rank_id, 'to_rank_id', p_to_rank_id
                        )
                    ) INTO v_legacy_audits, v_legacy_verified FROM public.audit_logs audit
                    WHERE audit.studio_id = p_studio_id AND audit.entity_type = 'promotion'
                      AND audit.entity_id = v_transition.id;
                    IF v_legacy_audits IS DISTINCT FROM 1 OR v_legacy_verified IS DISTINCT FROM TRUE THEN
                        RAISE EXCEPTION 'The original rank transition cannot be verified; review its history before retrying.'
                            USING ERRCODE = '22023', DETAIL = 'rank_transition_conflict';
                    END IF;
                END IF;
            END IF;
            RETURN v_transition;
        END IF;
    END IF;

    SELECT * INTO v_student
    FROM public.students student
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found for rank transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;

    SELECT rank.ladder_id, ladder.program_id
    INTO v_target_ladder_id, v_target_ladder_program_id
    FROM public.belt_ranks rank
    JOIN public.belt_ladders ladder ON ladder.id = rank.ladder_id
    WHERE rank.id = p_to_rank_id
      AND rank.studio_id = p_studio_id
      AND ladder.studio_id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target belt rank not found for rank transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;
    IF p_resolve_context THEN
        p_program_id := COALESCE(p_program_id, v_target_ladder_program_id,
            CASE WHEN p_student_program_membership_id IS NULL THEN v_student.program_id END);
    END IF;
    IF v_target_ladder_program_id IS NOT NULL
       AND p_program_id IS DISTINCT FROM v_target_ladder_program_id THEN
        RAISE EXCEPTION 'Rank transition program must match the target ladder program.'
            USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
    END IF;

    IF p_student_program_membership_id IS NOT NULL
       OR (p_resolve_context AND p_program_id IS NOT NULL) THEN
        SELECT * INTO v_membership FROM public.student_program_memberships membership
        WHERE membership.studio_id = p_studio_id AND membership.student_id = p_student_id
          AND CASE WHEN p_student_program_membership_id IS NOT NULL
              THEN membership.id = p_student_program_membership_id
              ELSE membership.program_id = p_program_id
                   AND membership.status IN ('active', 'paused') AND membership.ended_at IS NULL END
        FOR UPDATE;
        IF NOT FOUND AND p_student_program_membership_id IS NOT NULL THEN
            RAISE EXCEPTION 'Student program membership not found for rank transition.'
                USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
        END IF;
        IF FOUND THEN p_student_program_membership_id := v_membership.id; END IF;
    END IF;

    IF p_student_program_membership_id IS NOT NULL THEN
        IF v_membership.ended_at IS NOT NULL OR v_membership.status NOT IN ('active', 'paused') THEN
            RAISE EXCEPTION 'Cannot transition an inactive program membership.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        IF p_resolve_context THEN
            IF (v_requested_program IS NOT NULL AND v_membership.program_id IS DISTINCT FROM v_requested_program)
               OR (v_target_ladder_program_id IS NOT NULL
                   AND v_membership.program_id IS DISTINCT FROM v_target_ladder_program_id) THEN
                RAISE EXCEPTION 'Rank transition program must match the student program membership.'
                    USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
            END IF;
            p_program_id := v_membership.program_id;
            p_from_rank_id := v_membership.current_belt_rank_id;
        END IF;
        IF v_membership.program_id IS DISTINCT FROM p_program_id THEN
            RAISE EXCEPTION 'Rank transition program must match the student program membership.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        IF v_membership.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student program membership rank changed before transition.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
    ELSE
        IF v_target_ladder_program_id IS NOT NULL THEN
            IF p_transition_kind = 'promotion' THEN
                RAISE EXCEPTION 'Program-scoped promotions require a student program membership.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
            ELSE
                RAISE EXCEPTION 'Program-scoped demotions require a student program membership.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
            END IF;
        END IF;
        IF p_resolve_context THEN
            IF v_requested_program IS NOT NULL AND v_requested_program IS DISTINCT FROM v_student.program_id THEN
                RAISE EXCEPTION 'Student program membership not found for rank transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
            END IF;
            p_program_id := v_student.program_id;
            p_from_rank_id := v_student.current_belt_rank_id;
        END IF;
        IF v_student.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student rank changed before transition.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
    END IF;

    IF p_program_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.programs program
        WHERE program.id = p_program_id AND program.studio_id = p_studio_id
    ) THEN
        RAISE EXCEPTION 'Program not found in this studio for rank transition.'
            USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;

    IF p_from_rank_id IS NOT NULL THEN
        SELECT rank.ladder_id INTO v_from_ladder_id
        FROM public.belt_ranks rank
        WHERE rank.id = p_from_rank_id
          AND rank.studio_id = p_studio_id;
        IF NOT FOUND OR v_from_ladder_id IS DISTINCT FROM v_target_ladder_id THEN
            RAISE EXCEPTION 'Rank transitions must stay within one belt ladder.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
    END IF;

    WITH ordered AS (
        SELECT rank.id,
               row_number() OVER (
                   ORDER BY rank.display_order, rank.created_at, rank.id
               )::INTEGER AS position
        FROM public.belt_ranks rank
        WHERE rank.studio_id = p_studio_id
          AND rank.ladder_id = v_target_ladder_id
    )
    SELECT
        max(position) FILTER (WHERE id = p_from_rank_id),
        max(position) FILTER (WHERE id = p_to_rank_id)
    INTO v_from_position, v_to_position
    FROM ordered;

    IF v_to_position IS NULL THEN
        RAISE EXCEPTION 'Target belt rank disappeared before transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;
    IF p_transition_kind = 'promotion' THEN
        IF (p_from_rank_id IS NULL AND v_to_position <> 1)
           OR (p_from_rank_id IS NOT NULL AND v_to_position <> v_from_position + 1) THEN
            RAISE EXCEPTION 'Students can only be promoted to the next rank.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        v_expected_action := 'student.promoted';
    ELSE
        IF p_from_rank_id IS NULL OR v_to_position <> v_from_position - 1 THEN
            RAISE EXCEPTION 'Students can only be demoted to the previous rank.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        v_expected_action := 'student.demoted';
    END IF;

    v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,p_student_id,'rank_transition');

    INSERT INTO public.promotions (
        studio_id, student_id, student_program_membership_id, program_id,
        from_rank_id, to_rank_id, promoted_by, notes, operation_id, transition_kind
    ) VALUES (
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_actor_id, p_notes, p_operation_id,
        p_transition_kind
    )
    RETURNING * INTO v_transition;

    IF p_student_program_membership_id IS NOT NULL THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = p_to_rank_id
        WHERE membership.id = p_student_program_membership_id;
    END IF;
    IF p_student_program_membership_id IS NULL
       OR v_student.program_id IS NOT DISTINCT FROM p_program_id THEN
        UPDATE public.students student
        SET current_belt_rank_id = p_to_rank_id
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;
    END IF;

    INSERT INTO public.audit_logs (
        studio_id, actor_id, action, entity_type, entity_id, metadata
    ) VALUES (
        p_studio_id, p_actor_id, v_expected_action, 'promotion', v_transition.id,
        jsonb_build_object(
            'student_id', p_student_id,
            'student_program_membership_id', p_student_program_membership_id,
            'program_id', p_program_id,
            'from_rank_id', p_from_rank_id,
            'to_rank_id', p_to_rank_id,
            'operation_id', p_operation_id,
            'transition_kind', p_transition_kind
        ) || CASE
            WHEN p_transition_kind = 'demotion' THEN
                jsonb_build_object('reason', BTRIM(p_notes))
            ELSE '{}'::JSONB
        END
    );
    PERFORM private.workflow_rank_scope_finish_v1(v_rank_scope,v_transition.id);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    RETURN v_transition;
END;
$$;

-- Installation excludes every existing payment under a lock that conflicts
-- with INSERT/UPDATE/DELETE. Logical identities survive operational clear.
DO $migration_lock$
BEGIN
    LOCK TABLE public.studio_payment_accounts,public.billing_payers,public.billing_invoices,public.billing_payments
        IN SHARE ROW EXCLUSIVE MODE NOWAIT;
END;
$migration_lock$;
-- Settlement generations order committed evidence, never monetary totals.
CREATE TABLE private.workflow_invoice_settlement_authority (
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL,
    generation BIGINT NOT NULL CHECK(generation>0),
    PRIMARY KEY(studio_id,invoice_id)
);
CREATE TABLE private.workflow_payment_settlement_observations (
    payment_id UUID PRIMARY KEY,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    invoice_id UUID,
    first_evidence JSONB NOT NULL,
    baseline BOOLEAN NOT NULL DEFAULT false,
    accepted_generation BIGINT CHECK(accepted_generation>0),
    accepted_identity JSONB,
    uncertain BOOLEAN NOT NULL,
    CHECK((accepted_generation IS NULL)=(accepted_identity IS NULL)),
    CHECK(accepted_generation IS NULL OR invoice_id IS NOT NULL),
    CHECK(accepted_generation IS NOT NULL OR uncertain),
    CHECK(NOT baseline OR (accepted_generation IS NOT NULL AND accepted_generation=1))
);
CREATE INDEX workflow_payment_settlement_uncertain_invoice ON private.workflow_payment_settlement_observations(studio_id,invoice_id)
    WHERE uncertain AND invoice_id IS NOT NULL;

CREATE FUNCTION private.workflow_payment_evidence_v1(p_payment public.billing_payments)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE evidence JSONB; invalid TEXT[]:='{}'; k TEXT; value TEXT;
BEGIN
    evidence:=jsonb_build_object('payment_id',p_payment.id,'status',p_payment.status,'amount_cents',p_payment.amount_cents,
        'currency',p_payment.currency,'payer_id',p_payment.payer_id,'invoice_id',p_payment.invoice_id,
        'stripe_account_id',p_payment.stripe_account_id,'stripe_customer_id',p_payment.stripe_customer_id,
        'stripe_invoice_id',p_payment.stripe_invoice_id,'stripe_payment_intent_id',p_payment.stripe_payment_intent_id,
        'stripe_charge_id',p_payment.stripe_charge_id,'connect_account_generation',p_payment.connect_account_generation,
        'payment_method_type',p_payment.payment_method_type,'external_method',p_payment.external_method,
        'adjustment_reconciliation_required',p_payment.adjustment_reconciliation_required,
        'demo',coalesce(p_payment.metadata->'demo'='true'::JSONB,false));
    FOREACH k IN ARRAY ARRAY['currency','stripe_account_id','stripe_customer_id','stripe_invoice_id',
        'stripe_payment_intent_id','stripe_charge_id','connect_account_generation','payment_method_type','external_method'] LOOP
        value:=evidence->>k;
        IF value IS NULL THEN CONTINUE; END IF;
        IF (CASE WHEN k='currency' THEN value !~ '^[A-Za-z]{3}$'
            WHEN k='connect_account_generation' THEN p_payment.connect_account_generation<=0
            WHEN k='external_method' THEN length(value) NOT BETWEEN 1 AND 80 OR private.workflow_blank_v1(to_jsonb(value))
                OR value ~ ('['||chr(1)||'-'||chr(31)||chr(127)||'-'||chr(159)||']')
            ELSE octet_length(value) NOT BETWEEN 1 AND CASE WHEN k='payment_method_type' THEN 80 ELSE 255 END
                OR value !~ '^[!-~]+$' END) THEN
            evidence:=jsonb_set(evidence,ARRAY[k],'null'); invalid:=array_append(invalid,k);
        ELSIF k='currency' THEN evidence:=jsonb_set(evidence,ARRAY[k],to_jsonb(upper(value)));
        END IF;
    END LOOP;
    RETURN evidence||jsonb_build_object('invalid_fields',ARRAY(SELECT x FROM unnest(invalid) x ORDER BY x COLLATE "C"));
END $$;

CREATE FUNCTION private.workflow_payment_evidence_valid_v1(p_evidence JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE k TEXT; value JSONB; invalid JSONB; allowed CONSTANT TEXT[]:=ARRAY['payment_id','status','amount_cents','currency',
    'payer_id','invoice_id','stripe_account_id','stripe_customer_id','stripe_invoice_id','stripe_payment_intent_id',
    'stripe_charge_id','connect_account_generation','payment_method_type','external_method',
    'adjustment_reconciliation_required','demo','invalid_fields'];
    uuid_pattern CONSTANT TEXT:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
    IF NOT private.workflow_json_keys_v1(p_evidence,allowed,allowed) OR octet_length(p_evidence::TEXT)>4096 THEN RETURN false; END IF;
    invalid:=p_evidence->'invalid_fields';
    IF jsonb_typeof(invalid) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(invalid)>9 OR EXISTS(SELECT 1 FROM jsonb_array_elements(invalid) x
        WHERE jsonb_typeof(x)<>'string' OR x#>>'{}' NOT IN ('currency','stripe_account_id','stripe_customer_id',
            'stripe_invoice_id','stripe_payment_intent_id','stripe_charge_id','connect_account_generation','payment_method_type','external_method')
            OR p_evidence->(x#>>'{}') IS DISTINCT FROM 'null'::JSONB) THEN RETURN false; END IF;
    IF invalid IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY x COLLATE "C"),'[]'::JSONB)
        FROM (SELECT DISTINCT jsonb_array_elements_text(invalid) x) names) THEN RETURN false; END IF;
    FOREACH k IN ARRAY allowed LOOP
        value:=p_evidence->k;
        IF k='invalid_fields' THEN CONTINUE;
        ELSIF k IN ('adjustment_reconciliation_required','demo') THEN
            IF jsonb_typeof(value) IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
        ELSIF k='amount_cents' THEN
            IF NOT private.workflow_integer_v1(value,0,2147483647) THEN RETURN false; END IF;
        ELSIF k='status' THEN
            IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' NOT IN
                ('pending','processing','succeeded','failed','refunded','disputed','externally_recorded') THEN RETURN false; END IF;
        ELSIF value='null'::JSONB THEN
            IF k='payment_id' OR (k='currency' AND NOT invalid ? k) THEN RETURN false; END IF;
        ELSIF k IN ('payment_id','payer_id','invoice_id') THEN
            IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR value#>>'{}' !~ uuid_pattern THEN RETURN false; END IF;
        ELSIF k='connect_account_generation' THEN
            IF NOT private.workflow_integer_v1(value,1,2147483647) THEN RETURN false; END IF;
        ELSE
            IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
            IF (CASE WHEN k='currency' THEN value#>>'{}' !~ '^[A-Z]{3}$'
                WHEN k='external_method' THEN length(value#>>'{}') NOT BETWEEN 1 AND 80 OR private.workflow_blank_v1(value)
                    OR value#>>'{}' ~ ('['||chr(1)||'-'||chr(31)||chr(127)||'-'||chr(159)||']')
                ELSE octet_length(value#>>'{}') NOT BETWEEN 1 AND CASE WHEN k='payment_method_type' THEN 80 ELSE 255 END
                    OR value#>>'{}' !~ '^[!-~]+$' END) THEN RETURN false; END IF;
        END IF;
    END LOOP;
    RETURN true;
END $$;

-- Pure identity comparison shared by positive evidence and every visible contributor.
-- Only account metadata retains the established absent/empty generation convention.
CREATE FUNCTION private.workflow_financial_identity_valid_v1(p_invoice public.billing_invoices,p_payer public.billing_payers,
    p_account public.studio_payment_accounts,p_payment public.billing_payments DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE invoice_generation TEXT:=p_invoice.metadata->>'connect_account_generation';
    account_generation TEXT:=p_account.metadata->>'connect_account_generation'; generation INTEGER; evidence JSONB; value TEXT;
BEGIN
    IF p_invoice.id IS NULL OR p_payer.id IS NULL OR p_account.studio_id IS NULL
        OR p_invoice.studio_id IS DISTINCT FROM p_payer.studio_id OR p_invoice.studio_id IS DISTINCT FROM p_account.studio_id
        OR p_invoice.payer_id IS DISTINCT FROM p_payer.id OR p_invoice.external IS DISTINCT FROM false
        OR p_invoice.currency !~ '^[A-Za-z]{3}$'
        OR coalesce(p_invoice.metadata->'demo'='true'::JSONB,false) OR coalesce(p_payer.metadata->'demo'='true'::JSONB,false)
        OR invoice_generation IS NULL OR length(invoice_generation) NOT BETWEEN 1 AND 10
        OR invoice_generation !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
    IF invoice_generation::NUMERIC>2147483647 THEN RETURN false; END IF;
    IF account_generation IS NOT NULL AND account_generation<>'' THEN
        IF length(account_generation) NOT BETWEEN 1 AND 10 OR account_generation !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
        IF account_generation::NUMERIC>2147483647 THEN RETURN false; END IF;
    END IF;
    generation:=private.current_connect_account_generation(p_account.metadata);
    IF generation IS NULL OR generation IS DISTINCT FROM invoice_generation::INTEGER
        OR p_payer.connect_account_generation IS DISTINCT FROM generation
        OR p_invoice.stripe_account_id IS DISTINCT FROM p_account.stripe_connected_account_id
        OR p_payer.stripe_account_id IS DISTINCT FROM p_invoice.stripe_account_id
        OR p_payer.stripe_customer_id IS DISTINCT FROM p_invoice.stripe_customer_id THEN RETURN false; END IF;
    FOREACH value IN ARRAY ARRAY[p_invoice.stripe_account_id,p_invoice.stripe_customer_id,p_invoice.stripe_invoice_id] LOOP
        IF value IS NULL OR octet_length(value) NOT BETWEEN 1 AND 255 OR value !~ '^[!-~]+$' THEN RETURN false; END IF;
    END LOOP;
    IF p_payment.id IS NULL THEN RETURN true; END IF;
    evidence:=private.workflow_payment_evidence_v1(p_payment);
    IF NOT private.workflow_payment_evidence_valid_v1(evidence) OR evidence->'invalid_fields'<>'[]'::JSONB
        OR p_payment.studio_id IS DISTINCT FROM p_invoice.studio_id OR p_payment.invoice_id IS DISTINCT FROM p_invoice.id
        OR p_payment.payer_id IS DISTINCT FROM p_payer.id OR upper(p_payment.currency) IS DISTINCT FROM upper(p_invoice.currency)
        OR p_payment.adjustment_reconciliation_required OR evidence->'demo'='true'::JSONB THEN RETURN false; END IF;
    IF p_payment.status='externally_recorded' OR p_payment.payment_method_type='external' THEN
        RETURN coalesce(p_payment.amount_cents>0 AND evidence->>'currency'='USD' AND p_payment.payment_method_type='external'
            AND p_payment.external_method IS NOT NULL
            AND (p_payment.stripe_account_id IS NULL OR p_payment.stripe_account_id=p_invoice.stripe_account_id)
            AND (p_payment.stripe_customer_id IS NULL OR p_payment.stripe_customer_id=p_invoice.stripe_customer_id)
            AND (p_payment.stripe_invoice_id IS NULL OR p_payment.stripe_invoice_id=p_invoice.stripe_invoice_id)
            AND (p_payment.connect_account_generation IS NULL OR p_payment.connect_account_generation=generation),false);
    END IF;
    RETURN p_payment.stripe_account_id IS NOT DISTINCT FROM p_invoice.stripe_account_id
        AND p_payment.stripe_customer_id IS NOT DISTINCT FROM p_invoice.stripe_customer_id
        AND p_payment.stripe_invoice_id IS NOT DISTINCT FROM p_invoice.stripe_invoice_id
        AND p_payment.connect_account_generation IS NOT DISTINCT FROM generation;
END $$;

CREATE FUNCTION private.workflow_payment_settlement_valid_v1(p_studio_id UUID,p_payment_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM public.billing_payments p
        JOIN public.billing_invoices i ON i.id=p.invoice_id AND i.studio_id=p.studio_id
        JOIN public.billing_payers y ON y.id=i.payer_id AND y.studio_id=i.studio_id
        JOIN public.studio_payment_accounts a ON a.studio_id=i.studio_id
        WHERE p.studio_id=p_studio_id AND p.id=p_payment_id AND p.status IN ('succeeded','externally_recorded')
            AND p.amount_cents>0 AND private.workflow_financial_identity_valid_v1(i,y,a,p));
$$;

CREATE FUNCTION private.workflow_invoice_financial_context_v1(p_studio_id UUID,p_invoice_id UUID,p_payment_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    WITH current_context AS (
        SELECT i.currency,s.generation FROM public.billing_invoices i
        JOIN public.billing_payers y ON y.id=i.payer_id AND y.studio_id=i.studio_id
        JOIN public.studio_payment_accounts a ON a.studio_id=i.studio_id
        JOIN private.workflow_invoice_settlement_authority s ON s.studio_id=i.studio_id AND s.invoice_id=i.id
        WHERE i.studio_id=p_studio_id AND i.id=p_invoice_id AND private.workflow_financial_identity_valid_v1(i,y,a)
            AND NOT EXISTS(SELECT 1 FROM public.billing_payments p WHERE p.invoice_id=i.id
                AND p.status IN ('succeeded','refunded','disputed','externally_recorded')
                AND private.workflow_financial_identity_valid_v1(i,y,a,p) IS NOT TRUE)
            AND NOT EXISTS(SELECT 1 FROM private.workflow_payment_settlement_observations o
                WHERE o.studio_id=i.studio_id AND o.invoice_id=i.id AND o.uncertain)
            AND NOT EXISTS(SELECT 1 FROM public.billing_payments p JOIN private.workflow_payment_settlement_observations o ON o.payment_id=p.id
                WHERE ((p.invoice_id=i.id AND p.status IN ('succeeded','refunded','disputed','externally_recorded')) OR p.id=p_payment_id)
                    AND (o.studio_id IS DISTINCT FROM p.studio_id OR o.uncertain
                        OR (o.invoice_id IS NOT NULL AND o.invoice_id IS DISTINCT FROM p.invoice_id)
                        OR EXISTS(SELECT 1 FROM jsonb_each(o.accepted_identity) x WHERE x.value<>'null'::JSONB
                            AND x.value IS DISTINCT FROM private.workflow_payment_evidence_v1(p)->x.key)))
            AND (p_payment_id IS NULL OR EXISTS(SELECT 1 FROM public.billing_payments p
                WHERE p.studio_id=i.studio_id AND p.id=p_payment_id AND private.workflow_financial_identity_valid_v1(i,y,a,p)))
    ) SELECT coalesce((SELECT jsonb_build_object('available',true,'currency',upper(currency),'unit_convention','stripe_minor_units',
        'invoice_settlement_generation',generation) FROM current_context),jsonb_build_object('available',false,'currency',NULL,
        'unit_convention',NULL,'invoice_settlement_generation',NULL));
$$;

-- The caller owns its first source. Every additional financial parent is NOWAIT.
-- No workflow/run lock is acquired here or in the single-payment observer.
CREATE FUNCTION private.workflow_lock_financial_sources_v1(p_studio_id UUID,p_invoice_id UUID,p_payment_ids UUID[])
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    PERFORM 1 FROM public.billing_payments WHERE studio_id=p_studio_id AND id=ANY(p_payment_ids) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=p_invoice_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.billing_payers y WHERE y.studio_id=p_studio_id AND (y.id IN (
        SELECT p.payer_id FROM public.billing_payments p WHERE p.studio_id=p_studio_id AND p.id=ANY(p_payment_ids))
        OR y.id IN (SELECT i.payer_id FROM public.billing_invoices i WHERE i.studio_id=p_studio_id AND i.id=p_invoice_id))
        ORDER BY y.id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.studio_payment_accounts WHERE studio_id=p_studio_id FOR SHARE NOWAIT;
    IF p_invoice_id IS NOT NULL THEN
        IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
            'koaryu.workflow-invoice-settlement:'||p_studio_id::TEXT||':'||p_invoice_id::TEXT,0)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END IF;
        PERFORM 1 FROM private.workflow_invoice_settlement_authority
            WHERE studio_id=p_studio_id AND invoice_id=p_invoice_id FOR UPDATE NOWAIT;
        IF NOT FOUND AND EXISTS(SELECT 1 FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=p_invoice_id) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END IF;
    PERFORM 1 FROM private.workflow_payment_settlement_observations
        WHERE studio_id=p_studio_id AND payment_id=ANY(p_payment_ids) ORDER BY payment_id FOR UPDATE NOWAIT;
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_observe_payment_settlement_v1(p_studio_id UUID,p_payment_id UUID)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE payment public.billing_payments; observation private.workflow_payment_settlement_observations;
    invoice UUID; generation BIGINT; evidence JSONB; identity JSONB; valid BOOLEAN; consistent BOOLEAN; advanced BOOLEAN:=false; uncertain BOOLEAN:=false;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    SELECT * INTO payment FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_payment_id FOR UPDATE NOWAIT;
    IF payment.id IS NULL THEN RETURN jsonb_build_object('invoice_id',NULL,'generation',NULL,'advanced',false,'uncertain',true); END IF;
    SELECT id INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=payment.invoice_id;
    PERFORM private.workflow_lock_financial_sources_v1(p_studio_id,invoice,ARRAY[p_payment_id]);
    SELECT a.generation INTO generation FROM private.workflow_invoice_settlement_authority a WHERE a.studio_id=p_studio_id AND a.invoice_id=invoice;
    SELECT * INTO observation FROM private.workflow_payment_settlement_observations WHERE payment_id=p_payment_id;
    IF observation.payment_id IS NOT NULL AND observation.studio_id IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF observation.payment_id IS NULL AND payment.status NOT IN ('succeeded','externally_recorded') THEN
        RETURN jsonb_build_object('invoice_id',invoice,'generation',generation,'advanced',false,'uncertain',false);
    END IF;
    evidence:=private.workflow_payment_evidence_v1(payment);
    identity:=evidence-ARRAY['status','amount_cents','payment_method_type','external_method','adjustment_reconciliation_required','demo','invalid_fields'];
    consistent:=EXISTS(SELECT 1 FROM public.billing_invoices i JOIN public.billing_payers y ON y.id=i.payer_id AND y.studio_id=i.studio_id
        JOIN public.studio_payment_accounts a ON a.studio_id=i.studio_id WHERE i.id=invoice AND i.studio_id=p_studio_id
            AND private.workflow_financial_identity_valid_v1(i,y,a,payment))
        AND (observation.invoice_id IS NULL OR observation.invoice_id=invoice)
        AND (observation.accepted_identity IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_each(observation.accepted_identity) x
            WHERE x.value<>'null'::JSONB AND x.value IS DISTINCT FROM identity->x.key));
    valid:=consistent AND private.workflow_payment_settlement_valid_v1(p_studio_id,p_payment_id);
    IF observation.payment_id IS NULL THEN
        INSERT INTO private.workflow_payment_settlement_observations(payment_id,studio_id,invoice_id,first_evidence,uncertain)
            VALUES(p_payment_id,p_studio_id,invoice,evidence,true) RETURNING * INTO observation;
    ELSIF observation.invoice_id IS NULL AND invoice IS NOT NULL THEN
        UPDATE private.workflow_payment_settlement_observations SET invoice_id=invoice WHERE payment_id=p_payment_id RETURNING * INTO observation;
    END IF;
    uncertain:=observation.uncertain;
    IF valid THEN
        IF observation.accepted_generation IS NULL THEN
            IF generation IS NULL OR generation=9223372036854775807 THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            UPDATE private.workflow_invoice_settlement_authority a SET generation=a.generation+1
                WHERE a.studio_id=p_studio_id AND a.invoice_id=invoice RETURNING a.generation INTO generation;
            UPDATE private.workflow_payment_settlement_observations SET accepted_generation=generation,accepted_identity=identity,uncertain=false
                WHERE payment_id=p_payment_id;
            advanced:=true;
        ELSIF observation.uncertain THEN
            UPDATE private.workflow_payment_settlement_observations SET uncertain=false WHERE payment_id=p_payment_id;
        END IF;
        uncertain:=false;
    ELSIF (NOT coalesce(consistent,false) OR payment.status IN ('succeeded','externally_recorded','failed','pending','processing')) AND NOT observation.uncertain THEN
        UPDATE private.workflow_payment_settlement_observations SET uncertain=true WHERE payment_id=p_payment_id;
        uncertain:=true;
    END IF;
    RETURN jsonb_build_object('invoice_id',invoice,'generation',generation,'advanced',advanced,'uncertain',uncertain);
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_cancel_settled_invoice_runs_v1(p_studio_id UUID,p_invoice_ids UUID[])
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE runs UUID[]; workflows UUID[];
BEGIN
    SELECT coalesce(array_agg(r.id ORDER BY r.id),'{}'::UUID[]),coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[])
        INTO runs,workflows FROM public.automation_workflow_runs r
        JOIN private.automation_workflow_events e ON e.id=r.event_id AND e.studio_id=r.studio_id
        JOIN private.workflow_invoice_settlement_authority a ON a.studio_id=e.studio_id AND a.invoice_id=(e.context->>'invoice_id')::UUID
        WHERE r.studio_id=p_studio_id AND a.invoice_id=ANY(p_invoice_ids) AND e.event_type='invoice.payment_failed'
            AND e.context->>'invoice_settlement_generation' IS NOT NULL
            AND (e.context->>'invoice_settlement_generation')::BIGINT<a.generation
            AND r.cancel_requested_at IS NULL AND r.state IN ('queued','waiting','claimed','running','sending','unknown');
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=ANY(workflows) ORDER BY id FOR UPDATE;
    PERFORM 1 FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=ANY(runs) ORDER BY id FOR UPDATE;
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,runs,clock_timestamp(),'payment_settled');
END $$;

CREATE FUNCTION private.workflow_prepare_financial_context_v1(p_studio_id UUID,p_invoice_id UUID,p_payment_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE candidates UUID[]; payments UUID[]; changed UUID[]:='{}'; payment UUID; observed JSONB;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    IF p_payment_id IS NOT NULL THEN
        PERFORM 1 FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_payment_id FOR UPDATE NOWAIT;
    END IF;
    PERFORM 1 FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=p_invoice_id FOR SHARE NOWAIT;
    IF p_invoice_id IS NOT NULL AND NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'koaryu.workflow-invoice-settlement:'||p_studio_id::TEXT||':'||p_invoice_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    -- Freeze contributors after admission excludes another committing projection.
    SELECT coalesce(array_agg(payment_id ORDER BY payment_id),'{}'::UUID[]) INTO candidates FROM (
        SELECT payment_id FROM private.workflow_payment_settlement_observations WHERE studio_id=p_studio_id
            AND invoice_id=p_invoice_id AND uncertain ORDER BY payment_id LIMIT 20) bounded;
    SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::UUID[]) INTO payments FROM public.billing_payments
        WHERE studio_id=p_studio_id AND (id=p_payment_id OR id=ANY(candidates)
            OR (invoice_id=p_invoice_id AND status IN ('succeeded','refunded','disputed','externally_recorded')));
    PERFORM private.workflow_lock_financial_sources_v1(p_studio_id,p_invoice_id,payments);
    FOREACH payment IN ARRAY candidates LOOP
        IF NOT EXISTS(SELECT 1 FROM public.billing_payments p WHERE p.id=payment AND p.studio_id=p_studio_id AND p.invoice_id=p_invoice_id) THEN CONTINUE; END IF;
        observed:=private.workflow_observe_payment_settlement_v1(p_studio_id,payment);
        IF (observed->>'advanced')::BOOLEAN THEN changed:=array_append(changed,(observed->>'invoice_id')::UUID); END IF;
    END LOOP;
    -- This is the only workflow/run acquisition, after every bounded source parent.
    PERFORM private.workflow_cancel_settled_invoice_runs_v1(p_studio_id,ARRAY(SELECT DISTINCT x FROM unnest(changed) x ORDER BY x));
    RETURN private.workflow_invoice_financial_context_v1(p_studio_id,p_invoice_id,p_payment_id);
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

-- Installer classification does not invoke runtime observation or cancellation.
INSERT INTO private.workflow_invoice_settlement_authority(studio_id,invoice_id,generation)
    SELECT studio_id,id,1 FROM public.billing_invoices;
INSERT INTO private.workflow_payment_settlement_observations(payment_id,studio_id,invoice_id,first_evidence,baseline,accepted_generation,accepted_identity,uncertain)
    SELECT p.id,p.studio_id,i.id,e.evidence,v.valid,CASE WHEN v.valid THEN 1 END,
        CASE WHEN v.valid THEN e.evidence-ARRAY['status','amount_cents','payment_method_type','external_method','adjustment_reconciliation_required','demo','invalid_fields'] END,
        NOT v.valid FROM public.billing_payments p
        LEFT JOIN public.billing_invoices i ON i.id=p.invoice_id AND i.studio_id=p.studio_id
        CROSS JOIN LATERAL (SELECT private.workflow_payment_evidence_v1(p) evidence) e
        CROSS JOIN LATERAL (SELECT private.workflow_payment_settlement_valid_v1(p.studio_id,p.id) valid) v
        WHERE p.status IN ('succeeded','externally_recorded');

CREATE FUNCTION private.workflow_invoice_settlement_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        IF NEW.generation<>1 OR NOT EXISTS(SELECT 1 FROM public.billing_invoices i WHERE i.studio_id=NEW.studio_id AND i.id=NEW.invoice_id) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    ELSIF NEW.studio_id IS DISTINCT FROM OLD.studio_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
        OR (NEW.generation IS DISTINCT FROM OLD.generation AND (OLD.generation=9223372036854775807 OR NEW.generation::NUMERIC<>OLD.generation::NUMERIC+1)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_invoice_settlement_identity_v1 BEFORE INSERT OR UPDATE ON private.workflow_invoice_settlement_authority
    FOR EACH ROW EXECUTE FUNCTION private.workflow_invoice_settlement_identity_v1();

CREATE FUNCTION private.workflow_settlement_observation_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE payment public.billing_payments; evidence JSONB; identity JSONB;
BEGIN
    IF NOT private.workflow_payment_evidence_valid_v1(NEW.first_evidence)
        OR NEW.first_evidence->'payment_id' IS DISTINCT FROM to_jsonb(NEW.payment_id)
        OR NEW.first_evidence->>'status' NOT IN ('succeeded','externally_recorded') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT * INTO payment FROM public.billing_payments WHERE studio_id=NEW.studio_id AND id=NEW.payment_id;
    evidence:=private.workflow_payment_evidence_v1(payment);
    identity:=evidence-ARRAY['status','amount_cents','payment_method_type','external_method','adjustment_reconciliation_required','demo','invalid_fields'];
    IF TG_OP='INSERT' THEN
        IF NEW.baseline OR NEW.first_evidence IS DISTINCT FROM evidence THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    ELSE
        IF NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.studio_id IS DISTINCT FROM OLD.studio_id
            OR NEW.first_evidence IS DISTINCT FROM OLD.first_evidence OR NEW.baseline IS DISTINCT FROM OLD.baseline
            OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
            OR (OLD.accepted_generation IS NOT NULL AND (NEW.accepted_generation IS DISTINCT FROM OLD.accepted_generation
                OR NEW.accepted_identity IS DISTINCT FROM OLD.accepted_identity)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END IF;
    IF (TG_OP='INSERT' OR (OLD.invoice_id IS NULL AND NEW.invoice_id IS NOT NULL)) AND NEW.invoice_id IS NOT NULL
        AND (NEW.invoice_id IS DISTINCT FROM payment.invoice_id OR NOT EXISTS(SELECT 1 FROM public.billing_invoices
            WHERE id=NEW.invoice_id AND studio_id=NEW.studio_id)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF NEW.accepted_generation IS NOT NULL AND (TG_OP='INSERT' OR OLD.accepted_generation IS NULL) THEN
        IF NEW.accepted_identity IS DISTINCT FROM identity OR NEW.accepted_generation IS DISTINCT FROM (
            SELECT generation FROM private.workflow_invoice_settlement_authority WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id)
            OR NOT private.workflow_payment_settlement_valid_v1(NEW.studio_id,NEW.payment_id) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END IF;
    IF NOT NEW.uncertain AND (TG_OP='INSERT' OR OLD.uncertain) THEN
        IF NOT private.workflow_payment_settlement_valid_v1(NEW.studio_id,NEW.payment_id) OR NEW.invoice_id IS DISTINCT FROM payment.invoice_id
            OR EXISTS(SELECT 1 FROM jsonb_each(NEW.accepted_identity) x WHERE x.value<>'null'::JSONB AND x.value IS DISTINCT FROM identity->x.key) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_settlement_observation_identity_v1 BEFORE INSERT OR UPDATE ON private.workflow_payment_settlement_observations
    FOR EACH ROW EXECUTE FUNCTION private.workflow_settlement_observation_identity_v1();

CREATE FUNCTION private.workflow_invoice_settlement_seed_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||NEW.studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=NEW.studio_id FOR KEY SHARE NOWAIT;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'koaryu.workflow-invoice-settlement:'||NEW.studio_id::TEXT||':'||NEW.id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM private.workflow_invoice_settlement_authority WHERE studio_id=NEW.studio_id AND invoice_id=NEW.id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN INSERT INTO private.workflow_invoice_settlement_authority(studio_id,invoice_id,generation) VALUES(NEW.studio_id,NEW.id,1); END IF;
    RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;
CREATE TRIGGER workflow_invoice_settlement_seed_v1 AFTER INSERT ON public.billing_invoices
    FOR EACH ROW EXECUTE FUNCTION private.workflow_invoice_settlement_seed_v1();

DO $financial_authority_privileges$
DECLARE item TEXT; r RECORD;
BEGIN
    FOREACH item IN ARRAY ARRAY['workflow_invoice_settlement_authority','workflow_payment_settlement_observations'] LOOP
        EXECUTE format('ALTER TABLE private.%I OWNER TO postgres',item);
        EXECUTE format('ALTER TABLE private.%I ENABLE ROW LEVEL SECURITY',item);
        EXECUTE format('REVOKE ALL ON private.%I FROM PUBLIC,anon,authenticated,service_role',item);
        EXECUTE format('GRANT SELECT,INSERT,UPDATE ON private.%I TO service_role',item);
        EXECUTE format('CREATE POLICY reject_client_access ON private.%I AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)',item);
    END LOOP;
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.prorettype FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname IN ('workflow_invoice_settlement_seed_v1','workflow_payment_evidence_v1',
            'workflow_payment_evidence_valid_v1','workflow_financial_identity_valid_v1','workflow_payment_settlement_valid_v1',
            'workflow_invoice_financial_context_v1','workflow_lock_financial_sources_v1','workflow_prepare_financial_context_v1',
            'workflow_observe_payment_settlement_v1','workflow_cancel_settled_invoice_runs_v1',
            'workflow_invoice_settlement_identity_v1','workflow_settlement_observation_identity_v1') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.prorettype<>'trigger'::REGTYPE THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity); END IF;
    END LOOP;
END;
$financial_authority_privileges$;

CREATE TABLE private.workflow_payment_capture_markers (
    payment_id UUID PRIMARY KEY,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    eligible BOOLEAN NOT NULL,
    failure_seen BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO private.workflow_payment_capture_markers(payment_id,studio_id,eligible)
    SELECT id,studio_id,false FROM public.billing_payments;
ALTER TABLE private.workflow_payment_capture_markers OWNER TO postgres;
ALTER TABLE private.workflow_payment_capture_markers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.workflow_payment_capture_markers FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON private.workflow_payment_capture_markers TO service_role;
CREATE POLICY reject_client_access ON private.workflow_payment_capture_markers AS RESTRICTIVE FOR ALL
    TO anon,authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION private.workflow_capture_payment_failure_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE invoice public.billing_invoices; payer public.billing_payers; invoice_payer public.billing_payers;
    excluded BOOLEAN; marker private.workflow_payment_capture_markers; targets JSONB; observation JSONB; generation BIGINT;
BEGIN
    -- A projection already owns its payment. Neither clear nor studio deletion
    -- may make this late entry wait backwards for a parent.
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||NEW.studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=NEW.studio_id FOR KEY SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    observation:=private.workflow_observe_payment_settlement_v1(NEW.studio_id,NEW.id);
    generation:=(observation->>'generation')::BIGINT;
    -- The shared observer owns the exact payment and financial parents.
    SELECT * INTO invoice FROM public.billing_invoices WHERE id=NEW.invoice_id AND studio_id=NEW.studio_id;
    SELECT * INTO payer FROM public.billing_payers WHERE id=NEW.payer_id AND studio_id=NEW.studio_id;
    SELECT * INTO invoice_payer FROM public.billing_payers WHERE id=invoice.payer_id AND studio_id=NEW.studio_id;
    excluded := coalesce(NEW.metadata @> '{"demo":true}'::JSONB,false)
        OR coalesce(invoice.metadata @> '{"demo":true}'::JSONB,false)
        OR coalesce(payer.metadata @> '{"demo":true}'::JSONB,false)
        OR coalesce(invoice_payer.metadata @> '{"demo":true}'::JSONB,false);
    IF TG_OP='INSERT' THEN
        INSERT INTO private.workflow_payment_capture_markers(payment_id,studio_id,eligible)
            VALUES(NEW.id,NEW.studio_id,NOT excluded) ON CONFLICT(payment_id) DO NOTHING;
    END IF;
    SELECT * INTO marker FROM private.workflow_payment_capture_markers WHERE payment_id=NEW.id AND studio_id=NEW.studio_id;
    IF NEW.status<>'failed' THEN
        IF (observation->>'advanced')::BOOLEAN THEN
            PERFORM private.workflow_cancel_settled_invoice_runs_v1(NEW.studio_id,ARRAY[(observation->>'invoice_id')::UUID]);
        END IF;
        RETURN NEW;
    END IF;
    IF NOT FOUND OR NOT marker.eligible OR marker.failure_seen THEN RETURN NEW; END IF;
    UPDATE private.workflow_payment_capture_markers SET failure_seen=true WHERE payment_id=NEW.id;
    -- Consume the first committed failure even when demo or no target is active.
    IF excluded THEN RETURN NEW; END IF;
    targets := private.workflow_prepare_capture_v1(NEW.studio_id);
    PERFORM private.workflow_capture_events_v1(NEW.studio_id,jsonb_build_array(jsonb_build_object(
        'event_type','invoice.payment_failed','source_key',NEW.id::TEXT,'subject_kind','invoice','subject_id',NEW.id,
        'occurred_at',private.automation_utc_text_v1(clock_timestamp()),'context',jsonb_build_object(
            'payment_id',NEW.id,'invoice_id',invoice.id,'payer_id',payer.id,'invoice_settlement_generation',generation,
            'payment_evidence',private.workflow_payment_evidence_v1(NEW)))),targets);
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_capture_payment_failure_v1
    AFTER INSERT OR UPDATE OF status,invoice_id,payer_id,amount_cents,currency,stripe_account_id,stripe_customer_id,
        stripe_invoice_id,stripe_payment_intent_id,stripe_charge_id,connect_account_generation,payment_method_type,external_method,
        metadata,adjustment_reconciliation_required,adjustment_reconciliation_reason_code ON public.billing_payments
    FOR EACH ROW EXECUTE FUNCTION private.workflow_capture_payment_failure_v1();

DO $student_payment_capture_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname IN ('workflow_student_enrollment_event_v1','workflow_capture_payment_failure_v1') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
    END LOOP;
END;
$student_payment_capture_privileges$;

-- Exact rank-context authority. Logical identities survive operational deletion.
CREATE TABLE private.workflow_rank_contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    student_program_membership_id UUID,
    generation BIGINT NOT NULL CHECK (generation>=1),
    context JSONB NOT NULL CHECK (jsonb_typeof(context)='object'),
    tombstoned BOOLEAN NOT NULL,
    UNIQUE NULLS NOT DISTINCT(studio_id,student_id,student_program_membership_id)
);
CREATE TABLE private.workflow_rank_scopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    backend_pid INTEGER NOT NULL,
    transaction_id XID8 NOT NULL,
    owner TEXT NOT NULL CHECK (owner IN ('profile','private_profile','conversion','rank_transition','membership','import','rank_plan','callback')),
    state TEXT NOT NULL CHECK (state IN ('active','completed','unknown')),
    transition_id UUID,
    capture_targets JSONB
);
CREATE INDEX workflow_rank_scopes_transaction ON private.workflow_rank_scopes(backend_pid,transaction_id,studio_id,student_id);
CREATE UNIQUE INDEX workflow_rank_scopes_active ON private.workflow_rank_scopes(backend_pid,transaction_id,studio_id,student_id) WHERE state='active';
CREATE TABLE private.workflow_rank_pending_contexts (
    scope_id UUID NOT NULL REFERENCES private.workflow_rank_scopes(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL,
    student_program_membership_id UUID,
    previous_generation BIGINT CHECK (previous_generation>=1),
    previous_context JSONB,
    dirty BOOLEAN NOT NULL DEFAULT true,
    identity_removed BOOLEAN NOT NULL DEFAULT false,
    legacy_membership_gained BOOLEAN NOT NULL DEFAULT false,
    source_inserted BOOLEAN NOT NULL DEFAULT false,
    compared BOOLEAN NOT NULL DEFAULT false,
    changed BOOLEAN NOT NULL DEFAULT false,
    UNIQUE NULLS NOT DISTINCT(scope_id,studio_id,student_id,student_program_membership_id),
    CHECK ((previous_generation IS NULL)=(previous_context IS NULL))
);
CREATE TABLE private.workflow_rank_pending_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id UUID NOT NULL REFERENCES private.workflow_rank_scopes(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    intent JSONB NOT NULL CHECK (jsonb_typeof(intent)='object')
);

CREATE FUNCTION private.workflow_rank_context_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF ROW(NEW.id,NEW.studio_id,NEW.student_id,NEW.student_program_membership_id)
        IS DISTINCT FROM ROW(OLD.id,OLD.studio_id,OLD.student_id,OLD.student_program_membership_id)
        OR NEW.generation<OLD.generation
        OR (ROW(NEW.context,NEW.tombstoned) IS DISTINCT FROM ROW(OLD.context,OLD.tombstoned) AND NEW.generation<=OLD.generation) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_rank_context_identity BEFORE UPDATE ON private.workflow_rank_contexts
    FOR EACH ROW EXECUTE FUNCTION private.workflow_rank_context_identity_v1();

-- A side-effect-free tuple projection. Status/hold/contact details are separate
-- eligibility guards. Active and paused both describe the same live context.
CREATE FUNCTION private.workflow_rank_tuple_v1(p_studio_id UUID,p_student_id UUID,p_membership_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT CASE WHEN p_membership_id IS NULL THEN jsonb_build_object(
        'source_exists',s.id IS NOT NULL,'program_id',s.program_id,'rank_id',s.current_belt_rank_id,
        'live',s.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.student_program_memberships m
            WHERE m.studio_id=p_studio_id AND m.student_id=p_student_id AND m.status IN ('active','paused') AND m.ended_at IS NULL))
    ELSE jsonb_build_object('source_exists',s.id IS NOT NULL AND m.id IS NOT NULL,
        'program_id',m.program_id,'rank_id',m.current_belt_rank_id,
        'live',s.id IS NOT NULL AND m.id IS NOT NULL AND m.status IN ('active','paused') AND m.ended_at IS NULL) END
    FROM (SELECT 1) singleton
    LEFT JOIN public.students s ON s.studio_id=p_studio_id AND s.id=p_student_id
    LEFT JOIN public.student_program_memberships m ON m.studio_id=p_studio_id AND m.student_id=p_student_id AND m.id=p_membership_id
$$;

CREATE FUNCTION private.workflow_rank_compare_pending_v1(p_studio_id UUID,p_student_id UUID)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE pending RECORD; authority private.workflow_rank_contexts; current_context JSONB; forced BOOLEAN; v_changed BOOLEAN;
BEGIN
    IF EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND student_id=p_student_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() AND state='active') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    -- Only a recognized same-student command/consumer calls this early boundary.
    UPDATE private.workflow_rank_scopes SET state='completed' WHERE studio_id=p_studio_id AND student_id=p_student_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() AND state='unknown';
    FOR pending IN SELECT p.*,s.transition_id,s.owner FROM private.workflow_rank_pending_contexts p
        JOIN private.workflow_rank_scopes s ON s.id=p.scope_id
        WHERE p.studio_id=p_studio_id AND p.student_id=p_student_id AND NOT p.compared
            AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id() AND s.state='completed'
        ORDER BY p.student_program_membership_id NULLS FIRST LOOP
        current_context:=private.workflow_rank_tuple_v1(p_studio_id,p_student_id,pending.student_program_membership_id);
        SELECT * INTO authority FROM private.workflow_rank_contexts WHERE studio_id=p_studio_id AND student_id=p_student_id
            AND student_program_membership_id IS NOT DISTINCT FROM pending.student_program_membership_id FOR UPDATE;
        IF NOT FOUND THEN
            IF NOT pending.source_inserted OR pending.previous_generation IS NOT NULL THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
            END IF;
            -- The INSERT observation, never a read-time fallback, owns baseline 1.
            INSERT INTO private.workflow_rank_contexts(studio_id,student_id,student_program_membership_id,generation,context,tombstoned)
                VALUES(p_studio_id,p_student_id,pending.student_program_membership_id,1,current_context,
                    NOT (current_context->>'source_exists')::BOOLEAN) RETURNING * INTO authority;
            v_changed:=false;
        ELSE
            forced:=pending.owner='rank_transition' AND pending.transition_id IS NOT NULL AND EXISTS(
                SELECT 1 FROM public.promotions t WHERE t.id=pending.transition_id AND t.studio_id=p_studio_id AND t.student_id=p_student_id
                    AND t.command_membership_id IS NOT DISTINCT FROM pending.student_program_membership_id);
            v_changed:=pending.identity_removed OR pending.legacy_membership_gained OR current_context IS DISTINCT FROM authority.context OR forced;
            IF v_changed THEN
                IF authority.generation=9223372036854775807 THEN
                    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
                END IF;
                UPDATE private.workflow_rank_contexts SET generation=generation+1,context=current_context,
                    tombstoned=NOT (current_context->>'source_exists')::BOOLEAN WHERE id=authority.id;
            END IF;
        END IF;
        UPDATE private.workflow_rank_pending_contexts SET compared=true,changed=v_changed WHERE scope_id=pending.scope_id
            AND student_program_membership_id IS NOT DISTINCT FROM pending.student_program_membership_id;
    END LOOP;
END $$;

CREATE FUNCTION private.workflow_rank_scope_enter_v1(p_studio_id UUID,p_student_id UUID,p_owner TEXT)
RETURNS UUID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope UUID;
BEGIN
    IF p_studio_id IS NULL OR p_student_id IS NULL OR p_owner IS NULL
        OR p_owner NOT IN ('profile','private_profile','conversion','rank_transition','membership','import','rank_plan') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- This private constraint alone must not inherit caller ALL IMMEDIATE mode.
    SET CONSTRAINTS private.workflow_rank_deferred DEFERRED;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE'; END IF;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,p_student_id);
    INSERT INTO private.workflow_rank_scopes(studio_id,student_id,backend_pid,transaction_id,owner,state)
        VALUES(p_studio_id,p_student_id,pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),p_owner,'active') RETURNING id INTO scope;
    RETURN scope;
END $$;

CREATE FUNCTION private.workflow_rank_mark_dirty_v1(p_studio_id UUID,p_student_id UUID,p_membership_id UUID,p_identity_removed BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope UUID; authority private.workflow_rank_contexts;
BEGIN
    SET CONSTRAINTS private.workflow_rank_deferred DEFERRED;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    BEGIN
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
        -- Studio deletion owns the cascade and removes all private evidence.
        IF NOT FOUND THEN RETURN; END IF;
        -- Standalone callbacks cannot introduce a membership -> student wait.
        PERFORM 1 FROM public.students WHERE studio_id=p_studio_id AND id=p_student_id FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    SELECT id INTO scope FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND student_id=p_student_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id()
        AND state IN ('active','unknown') ORDER BY (state='active') DESC LIMIT 1;
    IF scope IS NULL THEN
        INSERT INTO private.workflow_rank_scopes(studio_id,student_id,backend_pid,transaction_id,owner,state)
            VALUES(p_studio_id,p_student_id,pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),'callback','unknown') RETURNING id INTO scope;
    END IF;
    SELECT * INTO authority FROM private.workflow_rank_contexts WHERE studio_id=p_studio_id AND student_id=p_student_id
        AND student_program_membership_id IS NOT DISTINCT FROM p_membership_id;
    INSERT INTO private.workflow_rank_pending_contexts(scope_id,studio_id,student_id,student_program_membership_id,
        previous_generation,previous_context,identity_removed)
        VALUES(scope,p_studio_id,p_student_id,p_membership_id,authority.generation,authority.context,p_identity_removed)
        ON CONFLICT(scope_id,studio_id,student_id,student_program_membership_id) DO UPDATE
            SET dirty=true,identity_removed=workflow_rank_pending_contexts.identity_removed OR EXCLUDED.identity_removed;
END $$;

CREATE FUNCTION private.workflow_rank_scope_finish_v1(p_scope_id UUID,p_transition_id UUID DEFAULT NULL,p_events JSONB DEFAULT '[]')
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.workflow_rank_scopes; item JSONB; transition public.promotions; generation BIGINT;
BEGIN
    SELECT * INTO scope FROM private.workflow_rank_scopes WHERE id=p_scope_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() AND state='active';
    IF NOT FOUND OR scope.owner IN ('private_profile','callback') OR jsonb_typeof(p_events) IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_events)>100 OR (p_transition_id IS NOT NULL AND scope.owner<>'rank_transition') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    IF scope.owner='rank_transition' THEN
        SELECT * INTO transition FROM public.promotions WHERE id=p_transition_id AND studio_id=scope.studio_id AND student_id=scope.student_id;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE'; END IF;
        PERFORM private.workflow_rank_mark_dirty_v1(scope.studio_id,scope.student_id,transition.command_membership_id);
    END IF;
    UPDATE private.workflow_rank_scopes SET state='completed',transition_id=p_transition_id WHERE id=scope.id;
    PERFORM private.workflow_rank_compare_pending_v1(scope.studio_id,scope.student_id);
    FOR item IN SELECT value FROM jsonb_array_elements(p_events) LOOP
        IF item->>'event_type'='student.enrolled' THEN
            IF scope.owner NOT IN ('profile','conversion') OR item->>'student_id' IS DISTINCT FROM scope.student_id::TEXT THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        ELSIF item->>'event_type'='lead.stage_changed' THEN
            IF scope.owner<>'conversion' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
        ELSE
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        INSERT INTO private.workflow_rank_pending_events(scope_id,studio_id,intent) VALUES(scope.id,scope.studio_id,item);
    END LOOP;
    IF scope.owner='rank_transition' AND transition.transition_kind='promotion' THEN
        SELECT c.generation INTO STRICT generation FROM private.workflow_rank_contexts c WHERE c.studio_id=scope.studio_id
            AND c.student_id=scope.student_id AND c.student_program_membership_id IS NOT DISTINCT FROM transition.command_membership_id;
        INSERT INTO private.workflow_rank_pending_events(scope_id,studio_id,intent) VALUES(scope.id,scope.studio_id,
            jsonb_build_object('event_type','student.promoted','source_key',transition.id::TEXT,'subject_kind','promotion','subject_id',transition.id,
                'context',jsonb_build_object('promotion_id',transition.id,'student_id',transition.student_id,
                    'student_program_membership_id',transition.command_membership_id,'program_id',transition.command_program_id,
                    'rank_id',transition.to_rank_id,'from_rank_id',transition.command_from_rank_id,'rank_context_generation',generation)));
    END IF;
END $$;

CREATE FUNCTION private.workflow_rank_context_generation_v1(p_studio_id UUID,p_student_id UUID,p_membership_id UUID)
RETURNS BIGINT LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE generation BIGINT;
BEGIN
    PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,p_student_id);
    SELECT c.generation INTO generation FROM private.workflow_rank_contexts c WHERE c.studio_id=p_studio_id AND c.student_id=p_student_id
        AND c.student_program_membership_id IS NOT DISTINCT FROM p_membership_id AND NOT c.tombstoned;
    IF generation IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE'; END IF;
    RETURN generation;
END $$;

CREATE FUNCTION private.workflow_cancel_runs_v1(p_studio_id UUID,p_run_ids UUID[],p_at TIMESTAMPTZ,p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE cancelled INTEGER; intended INTEGER;
BEGIN
    IF p_studio_id IS NULL OR p_run_ids IS NULL OR coalesce(array_ndims(p_run_ids),1)<>1 OR array_position(p_run_ids,NULL) IS NOT NULL
        OR p_at IS NULL OR NOT isfinite(p_at) OR p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,79}$'
        OR EXISTS(SELECT 1 FROM unnest(p_run_ids) requested(id) WHERE NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs r
            WHERE r.id=requested.id AND r.studio_id=p_studio_id)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=ANY(p_run_ids)
        AND cancel_requested_at IS NULL AND state IN ('queued','waiting','claimed','running','sending','unknown') AND revision=9223372036854775807) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    WITH changed AS (
        UPDATE public.automation_workflow_runs SET cancel_requested_at=p_at,cancel_reason=p_reason,revision=revision+1,updated_at=p_at,
            state=CASE WHEN state IN ('queued','waiting','claimed','running') THEN 'cancelled' ELSE state END,
            reason=CASE WHEN state IN ('queued','waiting','claimed','running') THEN p_reason ELSE reason END,
            next_due_at=NULL,
            claim_token=CASE WHEN state IN ('queued','waiting','claimed','running') THEN NULL ELSE claim_token END,
            lease_expires_at=CASE WHEN state IN ('queued','waiting','claimed','running') THEN NULL ELSE lease_expires_at END
        WHERE studio_id=p_studio_id AND id=ANY(p_run_ids) AND cancel_requested_at IS NULL
            AND state IN ('queued','waiting','claimed','running','sending','unknown') RETURNING state
    ) SELECT count(*) FILTER (WHERE state='cancelled'),count(*) INTO cancelled,intended FROM changed;
    RETURN jsonb_build_object('cancelled_count',cancelled,'intent_count',intended);
END $$;

CREATE FUNCTION private.workflow_rank_finalize_pending_v1(p_studio_id UUID)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE source RECORD; workflows UUID[]; runs UUID[]; targets JSONB; coordination JSONB; item RECORD; events JSONB:='[]'; at TIMESTAMPTZ;
BEGIN
    IF EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() AND (state='active' OR (state='unknown' AND owner='private_profile'))) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    FOR source IN SELECT DISTINCT student_id FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY student_id LOOP
        PERFORM private.workflow_rank_compare_pending_v1(p_studio_id,source.student_id);
    END LOOP;
    IF NOT EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts p JOIN private.workflow_rank_scopes s ON s.id=p.scope_id
        WHERE p.studio_id=p_studio_id AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id() AND p.changed)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_pending_events e JOIN private.workflow_rank_scopes s ON s.id=e.scope_id
            WHERE e.studio_id=p_studio_id AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id()) THEN
        DELETE FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND backend_pid=pg_catalog.pg_backend_pid()
            AND transaction_id=pg_catalog.pg_current_xact_id();
        RETURN;
    END IF;
    -- Capture context supplies identity; no student -> belt-event lock inversion.
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]),
        coalesce(array_agg(DISTINCT r.id ORDER BY r.id),'{}'::UUID[]) INTO workflows,runs
    FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
    JOIN private.workflow_rank_contexts c ON c.studio_id=e.studio_id AND c.student_id=(e.context->>'student_id')::UUID
        AND c.student_program_membership_id IS NOT DISTINCT FROM (e.context->>'student_program_membership_id')::UUID
    WHERE r.studio_id=p_studio_id AND e.event_type IN ('student.promoted','belt_test.approved','belt_test.upcoming')
        AND (e.context->>CASE WHEN e.event_type='student.promoted' THEN 'rank_context_generation' ELSE 'approved_rank_context_generation' END)::BIGINT
            IS DISTINCT FROM c.generation
        AND EXISTS(SELECT 1 FROM private.workflow_rank_pending_contexts p JOIN private.workflow_rank_scopes s ON s.id=p.scope_id
            WHERE p.studio_id=c.studio_id AND p.student_id=c.student_id
                AND p.student_program_membership_id IS NOT DISTINCT FROM c.student_program_membership_id AND p.changed
                AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id());
    SELECT s.capture_targets INTO coordination FROM private.workflow_rank_scopes s WHERE s.studio_id=p_studio_id
        AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id()
        AND s.capture_targets IS NOT NULL LIMIT 1;
    IF coordination IS NULL THEN
        targets:=private.workflow_prepare_capture_v1(p_studio_id,workflows,true);
    ELSE
        targets:=coordination->'packet';
        IF NOT private.workflow_json_keys_v1(coordination,ARRAY['lock_mode','packet'],ARRAY['lock_mode','packet'])
        OR coordination->>'lock_mode' IS DISTINCT FROM 'update'
        OR NOT private.workflow_json_keys_v1(targets,
            ARRAY['studio_id','transaction_id','backend_pid','locked_workflow_ids','targets'],
            ARRAY['studio_id','transaction_id','backend_pid','locked_workflow_ids','targets'])
        OR jsonb_typeof(targets->'locked_workflow_ids') IS DISTINCT FROM 'array'
        OR jsonb_typeof(targets->'targets') IS DISTINCT FROM 'array'
        OR EXISTS(SELECT 1 FROM private.workflow_rank_scopes s WHERE s.studio_id=p_studio_id
            AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id()
            AND s.capture_targets IS NOT NULL AND s.capture_targets IS DISTINCT FROM coordination)
        OR targets->'studio_id' IS DISTINCT FROM to_jsonb(p_studio_id)
        OR targets->'transaction_id' IS DISTINCT FROM to_jsonb(pg_catalog.pg_current_xact_id()::TEXT)
        OR targets->'backend_pid' IS DISTINCT FROM to_jsonb(pg_catalog.pg_backend_pid())
        OR NOT (targets->'locked_workflow_ids') @> to_jsonb(workflows) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
        END IF;
    END IF;
    PERFORM 1 FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=ANY(runs) ORDER BY id FOR UPDATE;
    at:=clock_timestamp();
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,runs,at,'rank_context_superseded');
    FOR item IN SELECT e.intent FROM private.workflow_rank_pending_events e JOIN private.workflow_rank_scopes s ON s.id=e.scope_id
        WHERE e.studio_id=p_studio_id AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id() LOOP
        IF item.intent->>'event_type'='student.enrolled' THEN
            events:=events||jsonb_build_array(private.workflow_student_enrollment_event_v1(p_studio_id,(item.intent->>'student_id')::UUID,targets));
        ELSE
            events:=events||jsonb_build_array(item.intent||jsonb_build_object('occurred_at',private.automation_utc_text_v1(at)));
        END IF;
        IF jsonb_array_length(events)=100 THEN
            PERFORM private.workflow_capture_events_v1(p_studio_id,events,targets); events:='[]';
        END IF;
    END LOOP;
    IF events<>'[]'::JSONB THEN PERFORM private.workflow_capture_events_v1(p_studio_id,events,targets); END IF;
    DELETE FROM private.workflow_rank_scopes WHERE studio_id=p_studio_id AND backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id();
END $$;

CREATE FUNCTION private.workflow_finalize_rank_deferred_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE id=NEW.id) THEN RETURN NULL; END IF;
    IF NEW.backend_pid<>pg_catalog.pg_backend_pid() OR NEW.transaction_id<>pg_catalog.pg_current_xact_id()
        OR EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE studio_id=NEW.studio_id AND backend_pid=NEW.backend_pid
            AND transaction_id=NEW.transaction_id AND state='active') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    -- An external forced flush after an unmarked return declares that boundary
    -- final. Current/frozen owners never force it during restoration.
    UPDATE private.workflow_rank_scopes SET state='completed' WHERE studio_id=NEW.studio_id AND backend_pid=NEW.backend_pid
        AND transaction_id=NEW.transaction_id AND state='unknown';
    PERFORM private.workflow_rank_finalize_pending_v1(NEW.studio_id);
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_rank_deferred AFTER INSERT ON private.workflow_rank_scopes
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.workflow_finalize_rank_deferred_v1();

DO $rank_privileges$
DECLARE item RECORD;
BEGIN
    FOR item IN SELECT c.oid::REGCLASS identity,c.relname name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='private' AND c.relname IN ('workflow_rank_contexts','workflow_rank_scopes','workflow_rank_pending_contexts','workflow_rank_pending_events') LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO postgres',item.identity);
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.identity);
        EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,anon,authenticated,service_role',item.identity);
        EXECUTE format('GRANT SELECT,INSERT ON TABLE %s TO service_role',item.identity);
        IF item.name<>'workflow_rank_pending_events' THEN
            EXECUTE format('GRANT UPDATE ON TABLE %s TO service_role',item.identity);
        END IF;
    END LOOP;
    GRANT DELETE ON private.workflow_rank_scopes TO service_role;
    FOR item IN SELECT p.oid::REGPROCEDURE identity,p.proname name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname IN ('workflow_rank_context_identity_v1','workflow_rank_tuple_v1','workflow_rank_compare_pending_v1',
            'workflow_rank_scope_enter_v1','workflow_rank_mark_dirty_v1','workflow_rank_scope_finish_v1','workflow_rank_context_generation_v1',
            'workflow_rank_finalize_pending_v1','workflow_finalize_rank_deferred_v1','workflow_cancel_runs_v1') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',item.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',item.identity);
        IF item.name NOT IN ('workflow_rank_context_identity_v1','workflow_finalize_rank_deferred_v1') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',item.identity);
        END IF;
    END LOOP;
END;
$rank_privileges$;

CREATE OR REPLACE FUNCTION public.write_student_profile_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_student JSONB,
    p_program_ids UUID[] DEFAULT NULL,
    p_guardians JSONB DEFAULT '[]'::JSONB,
    p_replace_programs BOOLEAN DEFAULT FALSE,
    p_audit_action TEXT DEFAULT 'student.updated'
)
RETURNS public.students
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, private
AS $$
DECLARE
    v_student JSONB := p_student;
    v_existing_program_id UUID;
    v_rank_was_supplied BOOLEAN := p_student IS NOT NULL
        AND jsonb_typeof(p_student) = 'object'
        AND p_student ? 'current_belt_rank_id';
    v_retained_membership_ranks JSONB := '{}'::JSONB;
    v_result public.students%ROWTYPE;
    v_rank_scope UUID;
BEGIN
    IF (p_replace_programs AND cardinality(p_program_ids) > 0)
       OR v_rank_was_supplied THEN
        -- Match every belt-plan writer's students-then-memberships lock order.
        -- The private writer locks this row again later in the same transaction.
        PERFORM 1
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id
        FOR UPDATE;

        IF p_replace_programs AND cardinality(p_program_ids) > 0 THEN
            SELECT COALESCE(
                jsonb_object_agg(
                    locked.program_id::TEXT,
                    COALESCE(to_jsonb(locked.current_belt_rank_id), 'null'::JSONB)
                ),
                '{}'::JSONB
            )
            INTO v_retained_membership_ranks
            FROM (
                SELECT membership.program_id, membership.current_belt_rank_id
                FROM public.student_program_memberships membership
                WHERE membership.student_id = p_student_id
                  AND membership.studio_id = p_studio_id
                  AND membership.program_id = ANY(p_program_ids)
                  AND membership.status IN ('active', 'paused')
                  AND membership.ended_at IS NULL
                FOR UPDATE
            ) locked;
        ELSE
            PERFORM 1
            FROM public.student_program_memberships membership
            JOIN public.students student
              ON student.id = membership.student_id
             AND student.studio_id = membership.studio_id
             AND student.program_id = membership.program_id
            WHERE membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
              AND membership.status IN ('active', 'paused')
              AND membership.ended_at IS NULL
            FOR UPDATE OF membership;
        END IF;
    END IF;

    -- Contact-only calls need the same final-owner boundary as rank writes.
    IF p_student_id IS NOT NULL AND p_studio_id IS NOT NULL AND jsonb_typeof(p_student)='object'
        AND EXISTS(SELECT 1 FROM public.studios WHERE id=p_studio_id) THEN
        PERFORM 1 FROM public.students WHERE id=p_student_id AND studio_id=p_studio_id FOR UPDATE;
        v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,p_student_id,'profile');
    END IF;

    IF p_replace_programs
       AND cardinality(p_program_ids) > 0
       AND p_student IS NOT NULL
       AND jsonb_typeof(p_student) = 'object'
       AND NOT (p_student ? 'current_belt_rank_id') THEN
        SELECT student.program_id
        INTO v_existing_program_id
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;

        IF FOUND AND v_existing_program_id IS DISTINCT FROM p_program_ids[1] THEN
            v_student := jsonb_set(
                v_student,
                '{current_belt_rank_id}',
                'null'::JSONB,
                TRUE
            );
        END IF;
    END IF;

    SELECT *
    INTO v_result
    FROM private.write_student_profile_atomic(
        p_student_id,
        p_studio_id,
        p_actor_id,
        v_student,
        p_program_ids,
        p_guardians,
        p_replace_programs,
        p_audit_action
    );

    IF p_replace_programs AND cardinality(p_program_ids) > 0 THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = (saved.value #>> '{}')::UUID,
            updated_at = NOW()
        FROM jsonb_each(v_retained_membership_ranks) saved
        WHERE membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id
          AND membership.program_id = saved.key::UUID
          AND membership.program_id = ANY(p_program_ids)
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND membership.current_belt_rank_id IS NULL
          AND saved.value <> 'null'::JSONB
          AND (
              membership.program_id IS DISTINCT FROM p_program_ids[1]
              OR NOT v_rank_was_supplied
          )
          AND EXISTS (
              SELECT 1
              FROM public.belt_ranks rank
              JOIN public.belt_ladders ladder
                ON ladder.id = rank.ladder_id
               AND ladder.studio_id = rank.studio_id
              WHERE rank.id = (saved.value #>> '{}')::UUID
                AND rank.studio_id = p_studio_id
                AND ladder.program_id = membership.program_id
          );

        UPDATE public.students student
        SET current_belt_rank_id = membership.current_belt_rank_id,
            updated_at = NOW()
        FROM public.student_program_memberships membership
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id
          AND membership.student_id = student.id
          AND membership.studio_id = student.studio_id
          AND membership.program_id = student.program_id
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

        SELECT *
        INTO v_result
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;
    ELSIF v_rank_was_supplied THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = v_result.current_belt_rank_id,
            updated_at = NOW()
        WHERE membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id
          AND membership.program_id = v_result.program_id
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student primary program membership is missing.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF v_rank_scope IS NOT NULL THEN
        PERFORM private.workflow_rank_scope_finish_v1(v_rank_scope);
        PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    END IF;
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.mutate_student_program_membership_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation TEXT,
    p_membership_id UUID DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::JSONB
)
RETURNS public.student_program_memberships
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_student public.students%ROWTYPE;
    v_result public.student_program_memberships%ROWTYPE;
    v_primary public.student_program_memberships%ROWTYPE;
    v_program_id UUID;
    v_unassigned_program_id UUID;
    v_status TEXT;
    v_audit_action TEXT;
    v_audit_entity_id UUID;
    v_rank_scope UUID;
BEGIN
    IF p_operation NOT IN ('add', 'update', 'remove') THEN
        RAISE EXCEPTION 'Unsupported student program membership operation.'
            USING ERRCODE = '22023';
    END IF;
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'Student program membership payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_student
    FROM public.students student
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id
      AND student.deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'P0002';
    END IF;

    PERFORM 1
    FROM public.student_program_memberships membership
    WHERE membership.student_id = p_student_id
      AND membership.studio_id = p_studio_id
    ORDER BY membership.id
    FOR UPDATE;

    v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,p_student_id,'membership');

    IF p_operation = 'add' THEN
        v_program_id := NULLIF(p_payload->>'program_id', '')::UUID;
        IF v_program_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM public.programs program
            WHERE program.id = v_program_id
              AND program.studio_id = p_studio_id
              AND program.archived_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Program does not belong to this studio or is archived.'
                USING ERRCODE = 'P0001';
        END IF;

        v_status := COALESCE(NULLIF(p_payload->>'status', ''), 'active');
        INSERT INTO public.student_program_memberships (
            studio_id,
            student_id,
            program_id,
            status,
            started_at,
            ended_at,
            current_belt_rank_id
        ) VALUES (
            p_studio_id,
            p_student_id,
            v_program_id,
            v_status,
            NULLIF(p_payload->>'started_at', '')::DATE,
            CASE
                WHEN v_status = 'ended' THEN COALESCE(NULLIF(p_payload->>'ended_at', '')::DATE, CURRENT_DATE)
                ELSE NULLIF(p_payload->>'ended_at', '')::DATE
            END,
            NULLIF(p_payload->>'current_belt_rank_id', '')::UUID
        )
        RETURNING * INTO v_result;
        v_audit_action := 'student.program_added';
        v_audit_entity_id := p_student_id;
    ELSE
        IF p_membership_id IS NULL THEN
            RAISE EXCEPTION 'Student program membership id is required.'
                USING ERRCODE = '22023';
        END IF;

        SELECT *
        INTO v_result
        FROM public.student_program_memberships membership
        WHERE membership.id = p_membership_id
          AND membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student program membership not found.'
                USING ERRCODE = 'P0002';
        END IF;

        IF p_operation = 'remove' THEN
            UPDATE public.student_program_memberships membership
            SET status = 'ended',
                ended_at = CURRENT_DATE,
                current_belt_rank_id = NULL,
                updated_at = NOW()
            WHERE membership.id = p_membership_id
              AND membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
            RETURNING * INTO v_result;
            v_audit_action := 'student.program_removed';
        ELSE
            v_status := CASE
                WHEN p_payload ? 'status' THEN NULLIF(p_payload->>'status', '')
                ELSE v_result.status
            END;
            UPDATE public.student_program_memberships membership
            SET status = v_status,
                started_at = CASE
                    WHEN p_payload ? 'started_at' THEN NULLIF(p_payload->>'started_at', '')::DATE
                    ELSE membership.started_at
                END,
                ended_at = CASE
                    WHEN v_status IN ('active', 'paused') THEN NULL
                    WHEN p_payload ? 'ended_at' THEN NULLIF(p_payload->>'ended_at', '')::DATE
                    WHEN v_status = 'ended' THEN COALESCE(membership.ended_at, CURRENT_DATE)
                    ELSE membership.ended_at
                END,
                current_belt_rank_id = CASE
                    WHEN v_status = 'ended' THEN NULL
                    WHEN p_payload ? 'current_belt_rank_id'
                        THEN NULLIF(p_payload->>'current_belt_rank_id', '')::UUID
                    ELSE membership.current_belt_rank_id
                END,
                updated_at = NOW()
            WHERE membership.id = p_membership_id
              AND membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
            RETURNING * INTO v_result;
            v_audit_action := 'student.program_updated';
        END IF;
        v_audit_entity_id := p_membership_id;
    END IF;

    SELECT membership.*
    INTO v_primary
    FROM public.student_program_memberships membership
    WHERE membership.student_id = p_student_id
      AND membership.studio_id = p_studio_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
    ORDER BY
        (membership.program_id = v_student.program_id) DESC,
        membership.created_at,
        membership.id
    LIMIT 1;

    IF NOT FOUND THEN
        SELECT program.id
        INTO v_unassigned_program_id
        FROM public.programs program
        WHERE program.studio_id = p_studio_id
          AND program.is_system = TRUE
          AND lower(program.name) = 'unassigned'
          AND program.archived_at IS NULL
        ORDER BY program.created_at, program.id
        LIMIT 1;

        IF v_unassigned_program_id IS NULL THEN
            RAISE EXCEPTION 'Unassigned program is missing for this studio.'
                USING ERRCODE = 'P0001';
        END IF;

        INSERT INTO public.student_program_memberships (
            studio_id, student_id, program_id, status, started_at
        ) VALUES (
            p_studio_id,
            p_student_id,
            v_unassigned_program_id,
            'active',
            COALESCE(v_student.membership_start_date, CURRENT_DATE)
        )
        RETURNING * INTO v_primary;
    END IF;

    UPDATE public.students student
    SET program_id = v_primary.program_id,
        current_belt_rank_id = v_primary.current_belt_rank_id,
        updated_at = NOW()
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id;

    INSERT INTO public.audit_logs (
        studio_id, actor_id, action, entity_type, entity_id, metadata
    ) VALUES (
        p_studio_id,
        p_actor_id,
        v_audit_action,
        CASE WHEN p_operation = 'add' THEN 'student' ELSE 'student_program_membership' END,
        v_audit_entity_id,
        jsonb_build_object(
            'student_id', p_student_id,
            'program_id', v_result.program_id,
            'operation', p_operation,
            'changes', p_payload
        )
    );

    PERFORM private.workflow_rank_scope_finish_v1(v_rank_scope);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION private.import_student_row_atomic(
    p_student JSONB,
    p_studio_id UUID,
    p_import_run_id UUID,
    p_processing_token TEXT,
    p_row_number INTEGER,
    p_guardian_name TEXT DEFAULT NULL,
    p_guardian_email TEXT DEFAULT NULL,
    p_guardian_phone TEXT DEFAULT NULL,
    p_guardian_relation TEXT DEFAULT NULL,
    p_program_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(student_id UUID, guardian_imported BOOLEAN)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_student public.students%ROWTYPE;
    v_student_id UUID;
    v_program_ids UUID[];
    v_program_id UUID;
    v_current_belt_rank_id UUID;
    v_rank_program_id UUID;
    v_membership_id UUID;
    v_membership_started_at DATE;
    v_guardian_name TEXT := NULLIF(btrim(COALESCE(p_guardian_name, '')), '');
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
    v_guardian_id UUID;
    v_guardian_link_id UUID;
    v_run public.student_import_runs%ROWTYPE;
    v_receipt JSONB;
    v_outcome JSONB;
    v_rank_scope UUID;
BEGIN
    IF p_student IS NULL OR jsonb_typeof(p_student) <> 'object' THEN
        RAISE EXCEPTION 'Student import payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    IF p_import_run_id IS NULL OR p_row_number IS NULL THEN
        RAISE EXCEPTION 'Student import run id and row number are required.'
            USING ERRCODE = '22023';
    END IF;

    IF p_processing_token IS NULL OR btrim(p_processing_token) = '' THEN
        RAISE EXCEPTION 'Student import processing token is required.'
            USING ERRCODE = '22023';
    END IF;

    v_student.id := NULLIF(p_student->>'id', '')::UUID;
    v_student.studio_id := NULLIF(p_student->>'studio_id', '')::UUID;
    IF v_student.id IS NULL THEN
        RAISE EXCEPTION 'Student import payload is missing id.'
            USING ERRCODE = '22023';
    END IF;

    IF v_student.studio_id IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Student import payload studio does not match request studio.'
            USING ERRCODE = 'P0001';
    END IF;

    v_run := private.lock_student_import_run(p_studio_id, p_import_run_id, p_processing_token);
    IF NOT v_run.receipts_enabled THEN
        RAISE EXCEPTION 'This unfinished import has no safe retry receipts.' USING ERRCODE = '22023';
    END IF;
    SELECT receipt.result_json INTO v_receipt FROM private.student_import_receipts AS receipt
    WHERE receipt.import_run_id = p_import_run_id AND receipt.kind = 'student'
      AND receipt.key = p_row_number::TEXT;
    IF FOUND THEN
        IF v_receipt->>'student_id' IS NULL
           OR jsonb_typeof(v_receipt->'guardian_imported') IS DISTINCT FROM 'boolean'
           OR (v_receipt->>'student_id')::UUID IS DISTINCT FROM v_student.id THEN
            RAISE EXCEPTION 'Student import completion receipt does not match this row.' USING ERRCODE = 'P0001';
        END IF;
        student_id := (v_receipt->>'student_id')::UUID;
        guardian_imported := (v_receipt->>'guardian_imported')::BOOLEAN;
        RETURN NEXT;
        RETURN;
    END IF;
    -- Internal diagnostic facts are not student columns. Keep only the original
    -- successful-row outcome needed to rebuild the existing import response.
    v_outcome := p_student->'_import_outcome';
    IF p_row_number < 2 OR p_row_number > 10001
       OR jsonb_typeof(v_outcome) IS DISTINCT FROM 'object'
       OR (v_outcome->>'row_number')::INTEGER IS DISTINCT FROM p_row_number
       OR v_outcome->'is_valid' IS DISTINCT FROM 'true'::JSONB
       OR jsonb_typeof(v_outcome->'issues') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_outcome->'data') IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_outcome->'imported_without_belt') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'Student import completion facts are required.' USING ERRCODE = '22023';
    END IF;

    v_student.legal_first_name := NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '');
    v_student.legal_last_name := NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '');
    v_student.preferred_name := NULLIF(p_student->>'preferred_name', '');
    v_student.date_of_birth := NULLIF(p_student->>'date_of_birth', '')::DATE;
    v_student.is_minor := COALESCE((p_student->>'is_minor')::BOOLEAN, false);
    v_student.email := NULLIF(p_student->>'email', '');
    v_student.phone := NULLIF(p_student->>'phone', '');
    v_student.address_line1 := NULLIF(p_student->>'address_line1', '');
    v_student.address_city := NULLIF(p_student->>'address_city', '');
    v_student.address_state := NULLIF(p_student->>'address_state', '');
    v_student.address_zip := NULLIF(p_student->>'address_zip', '');
    v_student.emergency_contact_name := NULLIF(p_student->>'emergency_contact_name', '');
    v_student.emergency_contact_phone := NULLIF(p_student->>'emergency_contact_phone', '');
    v_student.emergency_contact_relation := NULLIF(p_student->>'emergency_contact_relation', '');
    v_student.status := COALESCE(NULLIF(p_student->>'status', ''), 'active');
    v_student.membership_start_date := NULLIF(p_student->>'membership_start_date', '')::DATE;
    v_student.current_belt_rank_id := NULLIF(p_student->>'current_belt_rank_id', '')::UUID;
    v_student.notes := NULLIF(p_student->>'notes', '');
    v_student.hold_start_date := NULLIF(p_student->>'hold_start_date', '')::DATE;
    v_student.hold_end_date := NULLIF(p_student->>'hold_end_date', '')::DATE;

    SELECT COALESCE(array_agg(tag.value), ARRAY[]::TEXT[])
      INTO v_student.tags
      FROM jsonb_array_elements_text(
          CASE
              WHEN jsonb_typeof(p_student->'tags') = 'array' THEN p_student->'tags'
              ELSE '[]'::JSONB
          END
      ) AS tag(value);

    IF v_student.legal_first_name IS NULL OR v_student.legal_last_name IS NULL THEN
        RAISE EXCEPTION 'Student import payload is missing required name fields.'
            USING ERRCODE = '22023';
    END IF;

    v_program_ids := COALESCE(p_program_ids, ARRAY[]::UUID[]);
    IF cardinality(v_program_ids) IS NULL OR cardinality(v_program_ids) = 0 THEN
        RAISE EXCEPTION 'Student import payload is missing program memberships.'
            USING ERRCODE = '22023';
    END IF;

    FOREACH v_program_id IN ARRAY v_program_ids LOOP
        IF v_program_id IS NULL THEN
            RAISE EXCEPTION 'Student import payload includes an empty program id.'
                USING ERRCODE = '22023';
        END IF;

        PERFORM 1
          FROM public.programs
         WHERE id = v_program_id
           AND studio_id = p_studio_id
           AND archived_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Import program does not belong to this studio or is archived.'
                USING ERRCODE = 'P0001';
        END IF;
    END LOOP;

    v_student.program_id := v_program_ids[1];
    v_current_belt_rank_id := v_student.current_belt_rank_id;
    v_membership_started_at := v_student.membership_start_date;

    IF v_current_belt_rank_id IS NOT NULL THEN
        SELECT ladder.program_id
          INTO v_rank_program_id
          FROM public.belt_ranks AS belt_rank
          JOIN public.belt_ladders AS ladder ON ladder.id = belt_rank.ladder_id
         WHERE belt_rank.id = v_current_belt_rank_id
           AND belt_rank.studio_id = p_studio_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Current belt rank does not belong to this studio.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    v_rank_scope := private.workflow_rank_scope_enter_v1(p_studio_id,v_student.id,'import');

    INSERT INTO public.students (
        id,
        studio_id,
        legal_first_name,
        legal_last_name,
        preferred_name,
        date_of_birth,
        is_minor,
        email,
        phone,
        address_line1,
        address_city,
        address_state,
        address_zip,
        emergency_contact_name,
        emergency_contact_phone,
        emergency_contact_relation,
        status,
        membership_start_date,
        program_id,
        current_belt_rank_id,
        notes,
        tags,
        hold_start_date,
        hold_end_date
    )
    VALUES (
        v_student.id,
        p_studio_id,
        v_student.legal_first_name,
        v_student.legal_last_name,
        v_student.preferred_name,
        v_student.date_of_birth,
        v_student.is_minor,
        v_student.email,
        v_student.phone,
        v_student.address_line1,
        v_student.address_city,
        v_student.address_state,
        v_student.address_zip,
        v_student.emergency_contact_name,
        v_student.emergency_contact_phone,
        v_student.emergency_contact_relation,
        v_student.status,
        v_student.membership_start_date,
        v_student.program_id,
        v_student.current_belt_rank_id,
        v_student.notes,
        v_student.tags,
        v_student.hold_start_date,
        v_student.hold_end_date
    );

    v_student_id := v_student.id;

    FOREACH v_program_id IN ARRAY v_program_ids LOOP
        SELECT membership.id
          INTO v_membership_id
          FROM public.student_program_memberships AS membership
         WHERE membership.student_id = v_student_id
           AND membership.studio_id = p_studio_id
           AND membership.program_id = v_program_id
           AND membership.ended_at IS NULL
         FOR UPDATE;

        IF FOUND THEN
            UPDATE public.student_program_memberships AS membership
               SET status = 'active',
                   ended_at = NULL,
                   started_at = COALESCE(v_membership_started_at, started_at),
                   current_belt_rank_id = CASE
                       WHEN v_current_belt_rank_id IS NOT NULL
                            AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                       THEN v_current_belt_rank_id
                       ELSE NULL
                   END
             WHERE membership.id = v_membership_id;
        ELSE
            INSERT INTO public.student_program_memberships (
                studio_id,
                student_id,
                program_id,
                status,
                started_at,
                current_belt_rank_id
            )
            VALUES (
                p_studio_id,
                v_student_id,
                v_program_id,
                'active',
                v_membership_started_at,
                CASE
                    WHEN v_current_belt_rank_id IS NOT NULL
                         AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                    THEN v_current_belt_rank_id
                    ELSE NULL
                END
            );
        END IF;
    END LOOP;

    UPDATE public.students
       SET program_id = v_program_ids[1],
           current_belt_rank_id = v_current_belt_rank_id
     WHERE id = v_student_id
       AND studio_id = p_studio_id;

    student_id := v_student_id;
    guardian_imported := false;
    IF v_guardian_name IS NOT NULL THEN
        v_guardian_first_name := split_part(v_guardian_name, ' ', 1);
        v_guardian_last_name := NULLIF(btrim(substr(v_guardian_name, length(v_guardian_first_name) + 1)), '');
        v_guardian_id := private.deterministic_import_uuid(
            p_import_run_id,
            'guardian-row:' || p_row_number::TEXT
        );
        v_guardian_link_id := private.deterministic_import_uuid(
            p_import_run_id,
            'student-guardian-link:' || v_student_id::TEXT || ':' || v_guardian_id::TEXT
        );

        INSERT INTO public.guardians (
            id,
            studio_id,
            first_name,
            last_name,
            email,
            phone,
            relation,
            is_primary_contact
        )
        VALUES (
            v_guardian_id,
            p_studio_id,
            v_guardian_first_name,
            COALESCE(v_guardian_last_name, ''),
            NULLIF(p_guardian_email, ''),
            NULLIF(p_guardian_phone, ''),
            NULLIF(p_guardian_relation, ''),
            true
        );

        INSERT INTO public.student_guardians (
            id,
            student_id,
            guardian_id
        )
        VALUES (
            v_guardian_link_id,
            v_student_id,
            v_guardian_id
        );

        guardian_imported := TRUE;
    END IF;

    UPDATE public.students student
    SET current_belt_rank_id = membership.current_belt_rank_id,
        updated_at = NOW()
    FROM public.student_program_memberships membership
    WHERE student.id = v_student_id
      AND student.studio_id = p_studio_id
      AND membership.student_id = student.id
      AND membership.studio_id = student.studio_id
      AND membership.program_id = student.program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

    INSERT INTO private.student_import_receipts(import_run_id, kind, key, result_json)
    VALUES (p_import_run_id, 'student', p_row_number::TEXT,
        jsonb_build_object('student_id', v_student_id, 'guardian_imported', guardian_imported,
            'outcome', v_outcome));

    UPDATE public.student_import_runs SET processing_started_at = clock_timestamp() WHERE id = p_import_run_id;
    PERFORM private.workflow_rank_scope_finish_v1(v_rank_scope);
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_belt_ladder_ranks(
    p_ladder_id UUID,
    p_studio_id UUID,
    p_sub_rank_term TEXT DEFAULT NULL,
    p_ranks JSONB DEFAULT '[]'::JSONB
)
RETURNS TABLE (
    id UUID,
    studio_id UUID,
    name TEXT,
    program_id UUID,
    sub_rank_term TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    ranks JSONB
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_program_id UUID;
    v_student_id UUID;
    v_scope UUID;
    v_scopes UUID[] := ARRAY[]::UUID[];
BEGIN
    SELECT ladder.program_id INTO v_program_id
    FROM public.belt_ladders ladder
    WHERE ladder.id = p_ladder_id
      AND ladder.studio_id = p_studio_id;

    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = p_studio_id
      AND (EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = p_studio_id
            AND membership.student_id = student.id
            AND membership.program_id = v_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
      ) OR student.current_belt_rank_id IN (SELECT rank.id FROM public.belt_ranks rank
          WHERE rank.studio_id=p_studio_id AND rank.ladder_id=p_ladder_id)
        OR EXISTS(SELECT 1 FROM public.student_program_memberships membership JOIN public.belt_ranks rank
            ON rank.id=membership.current_belt_rank_id AND rank.studio_id=membership.studio_id
            WHERE membership.studio_id=p_studio_id AND membership.student_id=student.id AND rank.ladder_id=p_ladder_id))
    ORDER BY student.id
    FOR UPDATE;

    FOR v_student_id IN SELECT student.id
    FROM public.students student
    WHERE student.studio_id = p_studio_id
      AND (EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = p_studio_id
            AND membership.student_id = student.id
            AND membership.program_id = v_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
      ) OR student.current_belt_rank_id IN (SELECT rank.id FROM public.belt_ranks rank
          WHERE rank.studio_id=p_studio_id AND rank.ladder_id=p_ladder_id)
        OR EXISTS(SELECT 1 FROM public.student_program_memberships membership JOIN public.belt_ranks rank
            ON rank.id=membership.current_belt_rank_id AND rank.studio_id=membership.studio_id
            WHERE membership.studio_id=p_studio_id AND membership.student_id=student.id AND rank.ladder_id=p_ladder_id))
    ORDER BY student.id
    LOOP
        v_scopes := array_append(v_scopes,private.workflow_rank_scope_enter_v1(p_studio_id,v_student_id,'rank_plan'));
    END LOOP;

    PERFORM set_config('koaryu.rank_plan_delete', 'enabled', TRUE);
    RETURN QUERY
    SELECT *
    FROM public.sync_belt_ladder_ranks_internal(
        p_ladder_id, p_studio_id, p_sub_rank_term, p_ranks
    );
    PERFORM set_config('koaryu.rank_plan_delete', 'disabled', TRUE);
    FOREACH v_scope IN ARRAY v_scopes LOOP
        PERFORM private.workflow_rank_scope_finish_v1(v_scope);
    END LOOP;
    PERFORM private.workflow_rank_finalize_pending_v1(p_studio_id);
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('koaryu.rank_plan_delete', 'disabled', TRUE);
    RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_primary_student_rank_from_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_RELID='public.students'::REGCLASS THEN
        IF TG_OP='DELETE' THEN
            PERFORM private.workflow_rank_mark_dirty_v1(OLD.studio_id,OLD.id,NULL,true);
            RETURN OLD;
        END IF;
        PERFORM private.workflow_rank_mark_dirty_v1(NEW.studio_id,NEW.id,NULL);
        IF TG_OP='INSERT' THEN
            UPDATE private.workflow_rank_pending_contexts p SET source_inserted=true FROM private.workflow_rank_scopes s
                WHERE s.id=p.scope_id AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id()
                    AND s.state IN ('active','unknown') AND p.studio_id=NEW.studio_id AND p.student_id=NEW.id AND p.student_program_membership_id IS NULL;
        END IF;
        RETURN NEW;
    ELSIF TG_RELID<>'public.student_program_memberships'::REGCLASS THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_RANK_CONTEXT_UNAVAILABLE';
    END IF;
    IF TG_OP='DELETE' THEN
        PERFORM private.workflow_rank_mark_dirty_v1(OLD.studio_id,OLD.student_id,OLD.id,true);
        PERFORM private.workflow_rank_mark_dirty_v1(OLD.studio_id,OLD.student_id,NULL);
        RETURN OLD;
    END IF;
    PERFORM private.workflow_rank_mark_dirty_v1(NEW.studio_id,NEW.student_id,NEW.id);
    PERFORM private.workflow_rank_mark_dirty_v1(NEW.studio_id,NEW.student_id,NULL);
    IF TG_OP='INSERT' THEN
        UPDATE private.workflow_rank_pending_contexts p SET source_inserted=true FROM private.workflow_rank_scopes s
            WHERE s.id=p.scope_id AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id()
                AND s.state IN ('active','unknown') AND p.studio_id=NEW.studio_id AND p.student_id=NEW.student_id AND p.student_program_membership_id=NEW.id;
    END IF;
    IF NEW.status IN ('active','paused') AND NEW.ended_at IS NULL
        AND (TG_OP='INSERT' OR OLD.status NOT IN ('active','paused') OR OLD.ended_at IS NOT NULL) THEN
        -- Even add/remove within one deferred boundary permanently supersedes a
        -- previously available legacy context. Rank-NULL mirrors do not set it.
        UPDATE private.workflow_rank_pending_contexts p SET legacy_membership_gained=true FROM private.workflow_rank_scopes s
            WHERE s.id=p.scope_id AND s.backend_pid=pg_catalog.pg_backend_pid() AND s.transaction_id=pg_catalog.pg_current_xact_id()
                AND s.state IN ('active','unknown') AND p.studio_id=NEW.studio_id AND p.student_id=NEW.student_id
                AND p.student_program_membership_id IS NULL AND p.previous_context->>'live'='true';
    END IF;
    IF TG_NARGS>0 THEN RETURN NEW; END IF;
    IF NEW.status IN ('active', 'paused')
       AND NEW.ended_at IS NULL THEN
        UPDATE public.students
        SET current_belt_rank_id = NEW.current_belt_rank_id,
            updated_at = NOW()
        WHERE id = NEW.student_id
          AND studio_id = NEW.studio_id
          AND program_id = NEW.program_id
          AND current_belt_rank_id IS DISTINCT FROM NEW.current_belt_rank_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reassign_memberships_before_belt_rank_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_program_id UUID;
    replacement_rank_id UUID;
    v_context RECORD;
BEGIN
    SELECT ladder.program_id
    INTO target_program_id
    FROM public.belt_ladders ladder
    WHERE ladder.id = OLD.ladder_id
      AND ladder.studio_id = OLD.studio_id;

    -- Preserve physical rank removal even when an unscoped FK later clears it.
    FOR v_context IN
        SELECT candidate.studio_id,candidate.student_id,candidate.student_program_membership_id,
            bool_or(candidate.current_rank_reference) current_rank_reference
        FROM (
            SELECT c.studio_id,c.student_id,c.student_program_membership_id,true current_rank_reference FROM private.workflow_rank_contexts c
                WHERE c.studio_id=OLD.studio_id AND c.context->>'rank_id'=OLD.id::TEXT
            UNION ALL SELECT m.studio_id,m.student_id,m.id,true FROM public.student_program_memberships m
                WHERE m.studio_id=OLD.studio_id AND m.current_belt_rank_id=OLD.id
            UNION ALL SELECT s.studio_id,s.id,NULL::UUID,true FROM public.students s
                WHERE s.studio_id=OLD.studio_id AND s.current_belt_rank_id=OLD.id
            UNION ALL SELECT b.studio_id,b.student_id,b.student_program_membership_id,false FROM public.belt_test_recipients b
                JOIN private.workflow_rank_contexts c ON c.studio_id=b.studio_id AND c.student_id=b.student_id
                    AND c.student_program_membership_id IS NOT DISTINCT FROM b.student_program_membership_id
                WHERE b.studio_id=OLD.studio_id AND b.state='approved' AND b.approved_rank_context_generation=c.generation
                    AND (b.approved_current_rank_id=OLD.id OR b.approved_target_rank_id=OLD.id)
        ) candidate
        GROUP BY candidate.studio_id,candidate.student_id,candidate.student_program_membership_id
        ORDER BY candidate.student_id,candidate.student_program_membership_id NULLS FIRST
    LOOP
        IF NOT v_context.current_rank_reference THEN
            -- Match the dirty owner's deleted-studio cascade short circuit.
            IF NOT EXISTS(SELECT 1 FROM public.studios WHERE id=v_context.studio_id) THEN CONTINUE; END IF;
            -- A cursor snapshot cannot authorize removal against a newer source
            -- generation. Recheck after owning the same nonblocking student lock.
            BEGIN
                PERFORM 1 FROM public.students WHERE studio_id=v_context.studio_id AND id=v_context.student_id FOR UPDATE NOWAIT;
            EXCEPTION WHEN lock_not_available THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
            END;
            IF NOT EXISTS(SELECT 1 FROM public.belt_test_recipients b
                JOIN private.workflow_rank_contexts c ON c.studio_id=b.studio_id AND c.student_id=b.student_id
                    AND c.student_program_membership_id IS NOT DISTINCT FROM b.student_program_membership_id
                WHERE b.studio_id=v_context.studio_id AND b.student_id=v_context.student_id
                    AND b.student_program_membership_id IS NOT DISTINCT FROM v_context.student_program_membership_id
                    AND b.state='approved' AND b.approved_rank_context_generation=c.generation
                    AND (b.approved_current_rank_id=OLD.id OR b.approved_target_rank_id=OLD.id)) THEN
                CONTINUE;
            END IF;
        END IF;
        PERFORM private.workflow_rank_mark_dirty_v1(v_context.studio_id,v_context.student_id,v_context.student_program_membership_id,true);
    END LOOP;

    IF target_program_id IS NULL THEN
        RETURN OLD;
    END IF;

    IF current_setting('koaryu.rank_plan_delete', TRUE) IS DISTINCT FROM 'enabled'
       AND (
           EXISTS (
               SELECT 1
               FROM public.students student
               WHERE student.studio_id = OLD.studio_id
                 AND student.program_id = target_program_id
                 AND student.current_belt_rank_id = OLD.id
           )
           OR EXISTS (
               SELECT 1
               FROM public.student_program_memberships membership
               WHERE membership.studio_id = OLD.studio_id
                 AND membership.program_id = target_program_id
                 AND membership.current_belt_rank_id = OLD.id
                 AND membership.status IN ('active', 'paused')
                 AND membership.ended_at IS NULL
           )
       ) THEN
        RAISE EXCEPTION 'Assigned belt ranks must be deleted through sync_belt_ladder_ranks.'
            USING ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = OLD.studio_id
      AND (
          (
              student.program_id = target_program_id
              AND student.current_belt_rank_id = OLD.id
          )
          OR EXISTS (
              SELECT 1
              FROM public.student_program_memberships membership
              WHERE membership.studio_id = OLD.studio_id
                AND membership.student_id = student.id
                AND membership.program_id = target_program_id
                AND membership.status IN ('active', 'paused')
                AND membership.ended_at IS NULL
                AND membership.current_belt_rank_id = OLD.id
          )
      )
    ORDER BY student.id
    FOR UPDATE;

    SELECT rank.id
    INTO replacement_rank_id
    FROM public.belt_ranks rank
    WHERE rank.ladder_id = OLD.ladder_id
      AND rank.studio_id = OLD.studio_id
      AND rank.id <> OLD.id
      AND rank.is_tip = FALSE
    ORDER BY
        ((rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)) DESC,
        CASE WHEN (rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)
            THEN rank.display_order END DESC,
        CASE WHEN (rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)
            THEN rank.created_at END DESC,
        CASE WHEN (rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)
            THEN rank.id END DESC,
        rank.display_order,
        rank.created_at,
        rank.id
    LIMIT 1;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = replacement_rank_id,
        updated_at = NOW()
    WHERE studio_id = OLD.studio_id
      AND program_id = target_program_id
      AND current_belt_rank_id = OLD.id
      AND status IN ('active', 'paused')
      AND ended_at IS NULL;

    UPDATE public.students
    SET current_belt_rank_id = replacement_rank_id,
        updated_at = NOW()
    WHERE studio_id = OLD.studio_id
      AND program_id = target_program_id
      AND current_belt_rank_id = OLD.id
      AND EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = OLD.studio_id
            AND membership.student_id = students.id
            AND membership.program_id = target_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
            AND membership.current_belt_rank_id IS NOT DISTINCT FROM replacement_rank_id
      );

    RETURN OLD;
END;
$$;

-- Explicit observed installation baselines. No business row or occurrence write.
INSERT INTO private.workflow_rank_contexts(studio_id,student_id,student_program_membership_id,generation,context,tombstoned)
SELECT s.studio_id,s.id,NULL,1,private.workflow_rank_tuple_v1(s.studio_id,s.id,NULL),false FROM public.students s;
INSERT INTO private.workflow_rank_contexts(studio_id,student_id,student_program_membership_id,generation,context,tombstoned)
SELECT m.studio_id,m.student_id,m.id,1,private.workflow_rank_tuple_v1(m.studio_id,m.student_id,m.id),false
FROM public.student_program_memberships m;
CREATE TRIGGER workflow_rank_student_dirty AFTER INSERT OR UPDATE OR DELETE ON public.students
    FOR EACH ROW EXECUTE FUNCTION public.sync_primary_student_rank_from_membership('dirty_only');
CREATE TRIGGER workflow_rank_membership_dirty AFTER INSERT OR UPDATE OR DELETE ON public.student_program_memberships
    FOR EACH ROW EXECUTE FUNCTION public.sync_primary_student_rank_from_membership('dirty_only');

-- Real entered-node and actual-attempt metadata. Admission and rendered mail
-- snapshots are separate later owners; these rows never grant effect authority.
CREATE TABLE private.automation_workflow_run_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL,
    run_id UUID NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 40),
    node_id TEXT NOT NULL CHECK (node_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    node_type TEXT NOT NULL CHECK (node_type IN ('trigger','condition','delay','email','lead_follow_up','end')),
    outcome TEXT NOT NULL CHECK (outcome IN ('entered','matched','not_matched','waiting','sending','accepted','skipped','failed','unknown','cancelled','completed')),
    edge_id TEXT CHECK (edge_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    reason TEXT CHECK (reason ~ '^[a-z][a-z0-9_]{0,79}$'),
    scheduled_at TIMESTAMPTZ CHECK (scheduled_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    entered_at TIMESTAMPTZ NOT NULL CHECK (entered_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    finished_at TIMESTAMPTZ CHECK (finished_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    FOREIGN KEY(studio_id,run_id) REFERENCES public.automation_workflow_runs(studio_id,id) ON DELETE CASCADE,
    UNIQUE(run_id,node_id),
    UNIQUE(run_id,sequence),
    UNIQUE(studio_id,run_id,id,node_id),
    CHECK ((outcome IN ('entered','waiting','sending'))=(finished_at IS NULL)),
    CHECK (finished_at>=entered_at)
);
CREATE TABLE private.automation_workflow_email_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL,
    run_id UUID NOT NULL,
    step_id UUID NOT NULL,
    node_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
    state TEXT NOT NULL CHECK (state IN ('sending','accepted','failed','unknown')),
    reason TEXT CHECK (reason ~ '^[a-z][a-z0-9_]{0,79}$'),
    recipient_email TEXT NOT NULL CHECK (length(recipient_email) BETWEEN 1 AND 254
        AND private.automation_normalize_email(recipient_email) IS NOT NULL
        AND private.automation_normalize_email(recipient_email)=recipient_email),
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('student','guardian','lead','invoice_payer','assigned_staff')),
    began_at TIMESTAMPTZ NOT NULL CHECK (began_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    settled_at TIMESTAMPTZ CHECK (settled_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    submission_evidence TEXT CHECK (submission_evidence IN ('not_submitted','rejected','accepted','unknown')),
    failure_scope TEXT CHECK (failure_scope IN ('sender_auth','sender_transient','message','unclassified')),
    FOREIGN KEY(studio_id,run_id,step_id,node_id)
        REFERENCES private.automation_workflow_run_steps(studio_id,run_id,id,node_id) ON DELETE CASCADE,
    UNIQUE(run_id,node_id,attempt_number),
    CHECK ((state='sending')=(settled_at IS NULL)),
    CHECK (settled_at>=began_at),
    CHECK (submission_evidence IS NULL OR (state='accepted' AND submission_evidence='accepted')
        OR (state='failed' AND submission_evidence IN ('not_submitted','rejected')) OR (state='unknown' AND submission_evidence='unknown')),
    CHECK (failure_scope IS NULL OR state='failed' OR (state='unknown' AND failure_scope='unclassified'))
);
CREATE FUNCTION private.workflow_run_step_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE graph JSONB;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.studio_id,NEW.run_id,NEW.sequence,NEW.node_id,NEW.node_type,NEW.entered_at)
            IS DISTINCT FROM ROW(OLD.id,OLD.studio_id,OLD.run_id,OLD.sequence,OLD.node_id,OLD.node_type,OLD.entered_at)
            OR (OLD.outcome NOT IN ('entered','waiting','sending') AND NEW IS DISTINCT FROM OLD) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
        END IF;
    END IF;
    SELECT v.graph INTO graph FROM public.automation_workflow_runs r
        JOIN public.automation_workflow_versions v ON v.studio_id=r.studio_id AND v.workflow_id=r.workflow_id AND v.id=r.version_id
        WHERE r.studio_id=NEW.studio_id AND r.id=NEW.run_id;
    -- Leave absent-parent rejection to the composite FK, including its SQLSTATE.
    IF graph IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'nodes') n
        WHERE n->>'id'=NEW.node_id AND n->>'type'=NEW.node_type)
        OR (NEW.edge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'edges') e
            WHERE e->>'id'=NEW.edge_id AND e->>'source'=NEW.node_id))) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_run_steps_identity BEFORE INSERT OR UPDATE ON private.automation_workflow_run_steps
    FOR EACH ROW EXECUTE FUNCTION private.workflow_run_step_identity_v1();
CREATE FUNCTION private.workflow_email_attempt_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF ROW(NEW.id,NEW.studio_id,NEW.run_id,NEW.step_id,NEW.node_id,NEW.attempt_number,NEW.recipient_email,NEW.recipient_kind,NEW.began_at)
            IS DISTINCT FROM ROW(OLD.id,OLD.studio_id,OLD.run_id,OLD.step_id,OLD.node_id,OLD.attempt_number,OLD.recipient_email,OLD.recipient_kind,OLD.began_at)
            OR (OLD.state<>'sending' AND NEW IS DISTINCT FROM OLD) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
        END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM private.automation_workflow_run_steps s
        WHERE s.studio_id=NEW.studio_id AND s.run_id=NEW.run_id AND s.id=NEW.step_id AND s.node_id=NEW.node_id AND s.node_type<>'email') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_email_attempts_identity BEFORE INSERT OR UPDATE ON private.automation_workflow_email_attempts
    FOR EACH ROW EXECUTE FUNCTION private.workflow_email_attempt_identity_v1();
CREATE FUNCTION private.trial_rebooking_marker_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF OLD.rebooking_superseded AND NEW.rebooking_superseded IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER lead_trial_appointments_rebooking_marker BEFORE UPDATE ON public.lead_trial_appointments
    FOR EACH ROW EXECUTE FUNCTION private.trial_rebooking_marker_v1();

-- STABLE label lookup inherits the caller's statement snapshot. Logical subject
-- IDs are resolved through their actual current same-studio parents only.
CREATE FUNCTION private.workflow_run_subject_label_v1(p_event private.automation_workflow_events) RETURNS TEXT
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT coalesce(nullif(left(btrim(label,U&'\0009\000a\000b\000c\000d\001c\001d\001e\001f\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000'),240),''),'Unavailable subject') FROM (
        SELECT CASE p_event.subject_kind
        WHEN 'student' THEN (SELECT concat_ws(' ',coalesce(nullif(btrim(s.preferred_name,U&'\0009\000a\000b\000c\000d\001c\001d\001e\001f\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000'),''),s.legal_first_name),s.legal_last_name)
            FROM public.students s WHERE s.studio_id=p_event.studio_id AND s.id=p_event.subject_id AND s.deleted_at IS NULL)
        WHEN 'promotion' THEN (SELECT concat_ws(' ',coalesce(nullif(btrim(s.preferred_name,U&'\0009\000a\000b\000c\000d\001c\001d\001e\001f\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000'),''),s.legal_first_name),s.legal_last_name)
            FROM public.promotions p JOIN public.students s ON s.studio_id=p.studio_id AND s.id=p.student_id
            WHERE p.studio_id=p_event.studio_id AND p.id=p_event.subject_id AND s.deleted_at IS NULL)
        WHEN 'belt_test' THEN (SELECT concat_ws(' ',coalesce(nullif(btrim(s.preferred_name,U&'\0009\000a\000b\000c\000d\001c\001d\001e\001f\0020\0085\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000'),''),s.legal_first_name),s.legal_last_name)
            FROM public.belt_test_recipients b JOIN public.students s ON s.studio_id=b.studio_id AND s.id=b.student_id
            WHERE b.studio_id=p_event.studio_id AND b.id=p_event.subject_id AND s.deleted_at IS NULL)
        WHEN 'lead' THEN (SELECT concat_ws(' ',l.first_name,l.last_name) FROM public.leads l
            WHERE l.studio_id=p_event.studio_id AND l.id=p_event.subject_id)
        WHEN 'trial' THEN (SELECT concat_ws(' ',l.first_name,l.last_name) FROM public.lead_trial_appointments a
            JOIN public.leads l ON l.studio_id=a.studio_id AND l.id=a.lead_id
            WHERE a.studio_id=p_event.studio_id AND a.id=p_event.subject_id)
        WHEN 'invoice' THEN CASE WHEN p_event.event_type='invoice.payment_failed' THEN
            (SELECT i.invoice_number FROM public.billing_payments p JOIN public.billing_invoices i ON i.studio_id=p.studio_id AND i.id=p.invoice_id
                WHERE p.studio_id=p_event.studio_id AND p.id=p_event.subject_id AND p.invoice_id::TEXT=p_event.context->>'invoice_id')
            ELSE (SELECT i.invoice_number FROM public.billing_invoices i WHERE i.studio_id=p_event.studio_id AND i.id=p_event.subject_id) END
        END label
    ) source
$$;
CREATE FUNCTION private.workflow_run_summary_payload_v1(p_run public.automation_workflow_runs,
    p_event private.automation_workflow_events,p_version public.automation_workflow_versions,p_subject_label TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',p_run.id,'studio_id',p_run.studio_id,'workflow_id',p_run.workflow_id,
        'version_id',p_run.version_id,'version_number',p_version.version_number,'event_type',p_event.event_type,
        'subject_kind',p_event.subject_kind,'subject_id',p_event.subject_id,'subject_label',p_subject_label,
        'state',p_run.state,'revision',p_run.revision,'current_node_id',p_run.current_node_id,
        'next_due_at',private.automation_utc_text_v1(p_run.next_due_at),'reason',p_run.reason,
        'cancel_requested_at',private.automation_utc_text_v1(p_run.cancel_requested_at),'cancel_reason',p_run.cancel_reason,
        'can_cancel',p_run.state IN ('queued','waiting','claimed','running','sending') AND p_run.cancel_requested_at IS NULL,
        'created_at',private.automation_utc_text_v1(p_run.created_at),'updated_at',private.automation_utc_text_v1(p_run.updated_at))
$$;
CREATE FUNCTION private.workflow_run_step_payload_v1(p_row private.automation_workflow_run_steps) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',p_row.id,'sequence',p_row.sequence,'node_id',p_row.node_id,'node_type',p_row.node_type,
        'outcome',p_row.outcome,'edge_id',p_row.edge_id,'reason',p_row.reason,
        'scheduled_at',private.automation_utc_text_v1(p_row.scheduled_at),'entered_at',private.automation_utc_text_v1(p_row.entered_at),
        'finished_at',private.automation_utc_text_v1(p_row.finished_at))
$$;
CREATE FUNCTION private.workflow_email_attempt_payload_v1(p_row private.automation_workflow_email_attempts) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('id',p_row.id,'node_id',p_row.node_id,'attempt_number',p_row.attempt_number,
        'state',p_row.state,'reason',p_row.reason,'recipient_email',p_row.recipient_email,'recipient_kind',p_row.recipient_kind,
        'began_at',private.automation_utc_text_v1(p_row.began_at),'settled_at',private.automation_utc_text_v1(p_row.settled_at),
        'submission_evidence',p_row.submission_evidence,'failure_scope',p_row.failure_scope)
$$;
CREATE FUNCTION private.workflow_run_detail_v1(p_studio_id UUID,p_run_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('run',private.workflow_run_summary_payload_v1(r,e,v,private.workflow_run_subject_label_v1(e)),
        'steps',coalesce((SELECT jsonb_agg(private.workflow_run_step_payload_v1(s) ORDER BY s.sequence)
            FROM private.automation_workflow_run_steps s WHERE s.studio_id=r.studio_id AND s.run_id=r.id),'[]'::JSONB),
        'attempts',coalesce((SELECT jsonb_agg(private.workflow_email_attempt_payload_v1(a) ORDER BY s.sequence,a.attempt_number,a.id)
            FROM private.automation_workflow_email_attempts a JOIN private.automation_workflow_run_steps s
                ON s.studio_id=a.studio_id AND s.run_id=a.run_id AND s.id=a.step_id
            WHERE a.studio_id=r.studio_id AND a.run_id=r.id),'[]'::JSONB))
    FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
    JOIN public.automation_workflow_versions v ON v.studio_id=r.studio_id AND v.workflow_id=r.workflow_id AND v.id=r.version_id
    WHERE r.studio_id=p_studio_id AND r.id=p_run_id
$$;
CREATE FUNCTION public.get_automation_workflow_run_v1(p_studio_id UUID,p_actor_id UUID,p_run_id UUID) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE result JSONB;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_run_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    SELECT private.workflow_run_detail_v1(p_studio_id,p_run_id) INTO result;
    IF result IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('payload',result);
END $$;
CREATE FUNCTION public.list_automation_workflow_runs_v1(p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,
    p_limit INTEGER DEFAULT 50,p_cursor JSONB DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE cursor_at TIMESTAMPTZ; cursor_id UUID; items JSONB; next_cursor JSONB; more BOOLEAN; exists_workflow BOOLEAN;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_workflow_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF p_cursor IS NOT NULL THEN
        IF NOT private.workflow_json_keys_v1(p_cursor,ARRAY['created_at','id'],ARRAY['created_at','id'])
            OR jsonb_typeof(p_cursor->'id') IS DISTINCT FROM 'string'
            OR p_cursor->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        cursor_at:=private.automation_instant_v1(p_cursor->'created_at'); cursor_id:=(p_cursor->>'id')::UUID;
    END IF;
    -- Workflow existence, page rows, current labels and cursor share one snapshot.
    WITH page AS MATERIALIZED (
        SELECT r.id,r.created_at,private.workflow_run_summary_payload_v1(r,e,v,private.workflow_run_subject_label_v1(e)) payload
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        JOIN public.automation_workflow_versions v ON v.studio_id=r.studio_id AND v.workflow_id=r.workflow_id AND v.id=r.version_id
        WHERE r.studio_id=p_studio_id AND r.workflow_id=p_workflow_id
            AND (cursor_at IS NULL OR (r.created_at,r.id)<(cursor_at,cursor_id))
        ORDER BY r.created_at DESC,r.id DESC LIMIT p_limit+1
    ), numbered AS (SELECT *,row_number() OVER (ORDER BY created_at DESC,id DESC) ordinal FROM page)
    SELECT EXISTS(SELECT 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=p_workflow_id),
        coalesce(jsonb_agg(payload ORDER BY created_at DESC,id DESC) FILTER (WHERE ordinal<=p_limit),'[]'::JSONB),
        count(*)>p_limit,
        CASE WHEN count(*)>p_limit THEN (jsonb_agg(jsonb_build_object('created_at',private.automation_utc_text_v1(created_at),'id',id)
            ORDER BY created_at DESC,id DESC) FILTER (WHERE ordinal<=p_limit))->(p_limit-1) ELSE NULL END
        INTO exists_workflow,items,more,next_cursor FROM numbered;
    IF NOT exists_workflow THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('items',items,'next_cursor',next_cursor,'has_more',more));
END $$;
CREATE FUNCTION public.cancel_automation_workflow_run_v1(p_studio_id UUID,p_actor_id UUID,p_run_id UUID,
    p_operation_id UUID,p_expected_revision BIGINT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE receipt private.automation_command_operations; fingerprint TEXT; workflow UUID;
    current_run public.automation_workflow_runs; result JSONB; at TIMESTAMPTZ;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_run_id IS NULL OR p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    fingerprint:=private.workflow_hash_v1(jsonb_build_object('command','run.cancel','studio_id',p_studio_id,
        'actor_id',p_actor_id,'run_id',p_run_id,'expected_revision',p_expected_revision));
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0));
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    IF FOUND THEN
        IF receipt.actor_id<>p_actor_id OR receipt.command<>'run.cancel' OR receipt.request_fingerprint<>fingerprint THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT';
        END IF;
        RETURN jsonb_build_object('payload',receipt.result,'operation_id',p_operation_id,'replayed',true);
    END IF;
    SELECT workflow_id INTO workflow FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
    IF workflow IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=workflow FOR UPDATE;
    SELECT * INTO current_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id AND workflow_id=workflow FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF current_run.revision<>p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_REVISION_CONFLICT';
    END IF;
    IF current_run.cancel_requested_at IS NOT NULL OR current_run.state NOT IN ('queued','waiting','claimed','running','sending')
        OR current_run.revision=9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    at:=clock_timestamp();
    PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY[p_run_id],at,'run_cancelled');
    SELECT private.workflow_run_detail_v1(p_studio_id,p_run_id) INTO result;
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'run.cancel',fingerprint,'workflow_run',p_run_id,result,at);
    RETURN jsonb_build_object('payload',result,'operation_id',p_operation_id,'replayed',false);
END $$;
CREATE FUNCTION public.get_lead_trial_appointment_v1(p_studio_id UUID,p_actor_id UUID,p_lead_id UUID,p_appointment_id UUID) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE result JSONB;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_lead_id IS NULL OR p_appointment_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    SELECT private.trial_appointment_payload_v1(a) INTO result FROM public.lead_trial_appointments a
        JOIN public.leads l ON l.studio_id=a.studio_id AND l.id=a.lead_id
        WHERE a.studio_id=p_studio_id AND a.lead_id=p_lead_id AND a.id=p_appointment_id;
    IF result IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('payload',result);
END $$;

ALTER TABLE private.automation_workflow_run_steps OWNER TO postgres;
ALTER TABLE private.automation_workflow_email_attempts OWNER TO postgres;
ALTER TABLE private.automation_workflow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_workflow_email_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.automation_workflow_run_steps,private.automation_workflow_email_attempts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON private.automation_workflow_run_steps,private.automation_workflow_email_attempts TO service_role;
DO $run_metadata_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure identity,p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_run_step_identity_v1','workflow_email_attempt_identity_v1','trial_rebooking_marker_v1',
            'workflow_run_subject_label_v1','workflow_run_summary_payload_v1','workflow_run_step_payload_v1','workflow_email_attempt_payload_v1','workflow_run_detail_v1'))
        OR (n.nspname='public' AND p.proname IN ('list_automation_workflow_runs_v1','get_automation_workflow_run_v1',
            'cancel_automation_workflow_run_v1','get_lead_trial_appointment_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.proname NOT IN ('workflow_run_step_identity_v1','workflow_email_attempt_identity_v1','trial_rebooking_marker_v1') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
        END IF;
    END LOOP;
END;
$run_metadata_privileges$;

-- One read-only current-fact authority. Preview observes a statement snapshot;
-- later effect owners must lock sources and pass their own final reference clock.
CREATE FUNCTION private.workflow_fact_text_v1(p_value TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('kind','text','value',left(p_value,5001))
$$;

-- Auth grants remain narrow: no metadata, session, invited-email or token access.
CREATE FUNCTION private.workflow_staff_auth_email_v1(p_studio_id UUID,p_user_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT private.automation_normalize_email(u.email) FROM auth.users u
    WHERE u.id=p_user_id AND (SELECT count(*) FROM public.staff_roles r WHERE r.user_id=u.id)=1
        AND EXISTS(SELECT 1 FROM public.staff_roles r WHERE r.user_id=u.id AND r.studio_id=p_studio_id
            AND r.archived_at IS NULL AND r.role IN ('admin','front_desk','instructor'))
$$;
CREATE FUNCTION private.workflow_current_staff_recipient_v1(p_studio_id UUID,p_user_id UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_count INTEGER; v_email TEXT; v_name TEXT; v_reason TEXT;
BEGIN
    SELECT count(*) INTO v_count FROM public.staff_roles WHERE user_id=p_user_id;
    IF v_count>1 THEN
        RETURN jsonb_build_object('decision','unavailable','reason','staff_membership_ambiguous','email',NULL,'name',NULL);
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.staff_roles WHERE user_id=p_user_id AND studio_id=p_studio_id
        AND archived_at IS NULL AND role IN ('admin','front_desk','instructor')) THEN
        RETURN jsonb_build_object('decision','skip','reason','staff_unavailable','email',NULL,'name',NULL);
    END IF;
    v_email:=private.workflow_staff_auth_email_v1(p_studio_id,p_user_id);
    SELECT legal_first_name||' '||legal_last_name INTO v_name FROM public.staff_profiles WHERE user_id=p_user_id;
    IF v_email IS NULL THEN v_reason:='invalid_email'; END IF;
    RETURN jsonb_build_object('decision',CASE WHEN v_reason IS NULL THEN 'ready' ELSE 'skip' END,
        'reason',v_reason,'email',v_email,'name',v_name);
END $$;

-- Pending scopes are uncertainty, never an invitation to run the comparator.
CREATE FUNCTION private.workflow_current_rank_authority_v1(p_studio_id UUID,p_student_id UUID,p_membership_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('available',c.id IS NOT NULL AND NOT c.tombstoned
        AND c.context=t.context AND NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes s
            WHERE s.studio_id=p_studio_id AND s.student_id=p_student_id),
        'generation',c.generation,'context',t.context,'pending',EXISTS(SELECT 1 FROM private.workflow_rank_scopes s
            WHERE s.studio_id=p_studio_id AND s.student_id=p_student_id))
    FROM (SELECT private.workflow_rank_tuple_v1(p_studio_id,p_student_id,p_membership_id) context) t
    LEFT JOIN private.workflow_rank_contexts c ON c.studio_id=p_studio_id AND c.student_id=p_student_id
        AND c.student_program_membership_id IS NOT DISTINCT FROM p_membership_id
$$;

CREATE FUNCTION private.workflow_current_source_facts_v1(
    p_studio_id UUID,p_event_type TEXT,p_subject_id UUID,p_captured_context JSONB,p_trigger_config JSONB,
    p_reference_at TIMESTAMPTZ,p_recipient_ids TEXT[]
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE
    cat JSONB:=private.workflow_catalog_v1(); meta JSONB:=cat#>ARRAY['triggers',p_event_type];
    studio public.studios; student public.students; promotion public.promotions; lead public.leads;
    trial public.lead_trial_appointments; event public.belt_test_events; recipient public.belt_test_recipients;
    invoice public.billing_invoices; payment public.billing_payments; payer public.billing_payers;
    program public.programs; rank public.belt_ranks; ladder public.belt_ladders;
    context JSONB:=p_captured_context; expected JSONB; authority JSONB; finance JSONB; evidence JSONB;
    conditions JSONB:='{}'; templates JSONB:='{}'; anchors JSONB:='{}'; recipients JSONB:='{}'; addresses JSONB:='{}';
    source_found BOOLEAN:=false; reason TEXT; unavailable BOOLEAN:=false; context_bad BOOLEAN:=false; current_context_bad BOOLEAN:=false;
    student_id UUID; lead_id UUID; program_id UUID; membership_id UUID; rank_id UUID; filter_id UUID;
    generation JSONB; settlement_generation BIGINT; today DATE; captured_due DATE; zone TEXT; minor BOOLEAN; on_hold BOOLEAN; approval_current BOOLEAN:=false;
    policy TEXT; email TEXT; name TEXT; kind TEXT; contact_reason TEXT; contact_decision TEXT; staff JSONB; guardian RECORD;
    fields TEXT[]; k TEXT; value JSONB; is_trial BOOLEAN:=p_event_type LIKE 'trial.%';
    is_belt BOOLEAN:=p_event_type LIKE 'belt_test.%'; is_invoice BOOLEAN:=p_event_type LIKE 'invoice.%';
BEGIN
    IF p_studio_id IS NULL OR p_subject_id IS NULL OR meta IS NULL OR p_reference_at IS NULL
        OR NOT isfinite(p_reference_at) OR p_reference_at NOT BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
        OR p_recipient_ids IS NULL OR cardinality(p_recipient_ids)>4
        OR cardinality(p_recipient_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_recipient_ids) x)
        OR EXISTS(SELECT 1 FROM unnest(p_recipient_ids) x WHERE x IS NULL OR NOT meta->'recipient_ids' ? x)
        OR NOT private.workflow_json_keys_v1(p_trigger_config,ARRAY['event_type','program_id','offset_minutes'],ARRAY['event_type','program_id'])
        OR p_trigger_config->>'event_type' IS DISTINCT FROM p_event_type
        OR (p_trigger_config->'program_id'<>'null'::JSONB AND NOT coalesce(private.workflow_typed_value_v1(p_trigger_config->'program_id',cat#>'{fields,program.id}'),false)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    filter_id:=(p_trigger_config->>'program_id')::UUID;
    SELECT * INTO studio FROM public.studios WHERE id=p_studio_id;
    IF studio.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    zone:=CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=studio.timezone) THEN studio.timezone ELSE 'UTC' END;
    today:=(p_reference_at AT TIME ZONE zone)::DATE;
    -- The primary record determines scoped404 independently from any missing parent.
    CASE
    WHEN p_event_type='student.enrolled' THEN
        SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=student.id IS NOT NULL; student_id:=student.id;
        IF p_captured_context IS NOT NULL THEN
            context_bad:=NOT private.workflow_json_keys_v1(context,ARRAY['student_id','matched_program_ids'],ARRAY['student_id','matched_program_ids'])
                OR context->'student_id' IS DISTINCT FROM to_jsonb(p_subject_id) OR jsonb_typeof(context->'matched_program_ids') IS DISTINCT FROM 'array';
            IF NOT context_bad THEN
                context_bad:=jsonb_array_length(context->'matched_program_ids')>25 OR EXISTS(SELECT 1 FROM jsonb_array_elements(context->'matched_program_ids') v
                    WHERE NOT coalesce(private.workflow_typed_value_v1(v,cat#>'{fields,program.id}'),false));
            END IF;
        END IF;
    WHEN p_event_type='student.promoted' THEN
        SELECT * INTO promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=promotion.id IS NOT NULL; student_id:=promotion.student_id;
        membership_id:=promotion.command_membership_id; program_id:=promotion.command_program_id; rank_id:=promotion.to_rank_id;
        IF source_found AND promotion.transition_kind IS DISTINCT FROM 'promotion' THEN reason:='promotion_unavailable'; END IF;
        IF p_captured_context IS NULL THEN
            SELECT e.context INTO context FROM private.automation_workflow_events e WHERE e.studio_id=p_studio_id
                AND e.event_type=p_event_type AND e.source_key=p_subject_id::TEXT AND e.subject_id=p_subject_id AND e.subject_kind='promotion';
        END IF;
        expected:=jsonb_build_object('promotion_id',p_subject_id,'student_id',student_id,'student_program_membership_id',membership_id,
            'program_id',program_id,'rank_id',rank_id);
        context_bad:=context IS NULL OR NOT private.workflow_json_keys_v1(context,
            ARRAY['promotion_id','student_id','student_program_membership_id','program_id','rank_id','from_rank_id','rank_context_generation'],
            ARRAY['promotion_id','student_id','student_program_membership_id','program_id','rank_id','rank_context_generation'])
            OR NOT coalesce(private.workflow_integer_v1(context->'rank_context_generation',1,9223372036854775807),false)
            OR (context ? 'from_rank_id' AND context->'from_rank_id' IS DISTINCT FROM coalesce(to_jsonb(promotion.command_from_rank_id),'null'::JSONB));
        IF NOT context_bad AND NOT context @> expected THEN reason:=coalesce(reason,'source_context_changed'); END IF;
        generation:=context->'rank_context_generation';
        IF NOT context_bad THEN conditions:=jsonb_build_object('program.id',program_id); END IF;
        IF rank_id IS NOT NULL THEN conditions:=conditions||jsonb_build_object('promotion.rank_id',rank_id); END IF;
        IF promotion.to_rank_name_snapshot IS NOT NULL THEN templates:=jsonb_build_object('rank_name',private.workflow_fact_text_v1(promotion.to_rank_name_snapshot)); END IF;
    WHEN p_event_type IN ('lead.created','lead.stage_changed') THEN
        SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=lead.id IS NOT NULL; lead_id:=lead.id; program_id:=lead.program_id;
        IF p_captured_context IS NOT NULL THEN
            fields:=CASE WHEN p_event_type='lead.created' THEN ARRAY['lead_id','program_id','stage'] ELSE ARRAY['lead_id','program_id','activity_id','old_stage','stage'] END;
            context_bad:=NOT private.workflow_json_keys_v1(context,fields,fields)
                OR context->'lead_id' IS DISTINCT FROM to_jsonb(p_subject_id)
                OR NOT coalesce(private.workflow_typed_value_v1(context->'stage',cat#>'{fields,lead.stage}'),false)
                OR (context->'program_id'<>'null'::JSONB AND NOT coalesce(private.workflow_typed_value_v1(context->'program_id',cat#>'{fields,program.id}'),false));
            IF p_event_type='lead.stage_changed' THEN
                context_bad:=context_bad OR NOT coalesce(private.workflow_typed_value_v1(context->'old_stage',cat#>'{fields,lead.stage}'),false)
                    OR NOT coalesce(private.workflow_typed_value_v1(context->'activity_id',cat#>'{fields,program.id}'),false);
            END IF;
        END IF;
    WHEN is_trial THEN
        SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=trial.id IS NOT NULL; lead_id:=trial.lead_id; program_id:=trial.program_id;
        expected:=jsonb_build_object('appointment_id',p_subject_id,'lead_id',lead_id,'program_id',program_id,'revision',trial.revision,'status',trial.status);
        IF p_captured_context IS NOT NULL THEN
            context_bad:=NOT private.workflow_json_keys_v1(context,ARRAY['appointment_id','lead_id','program_id','revision','status'],ARRAY['appointment_id','lead_id','program_id','revision','status'])
                OR NOT coalesce(private.workflow_integer_v1(context->'revision',1,9223372036854775807),false);
            IF NOT context_bad AND context IS DISTINCT FROM expected THEN reason:='source_context_changed'; END IF;
        END IF;
        IF source_found AND (trial.status IS DISTINCT FROM CASE WHEN p_event_type IN ('trial.scheduled','trial.upcoming') THEN 'scheduled' ELSE substr(p_event_type,7) END
            OR (p_event_type IN ('trial.scheduled','trial.upcoming') AND trial.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' AND trial.starts_at<=p_reference_at)) THEN reason:='trial_unavailable'; END IF;
        IF p_event_type='trial.no_show' AND trial.rebooking_superseded THEN reason:='trial_rebooked'; END IF;
        IF source_found THEN
            conditions:=jsonb_build_object('trial.status',trial.status);
            templates:=jsonb_build_object('trial_location',private.workflow_fact_text_v1(trial.location));
            IF trial.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
                AND trial.ends_at>trial.starts_at AND isfinite(trial.ends_at)
                AND EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=trial.timezone) THEN
                templates:=templates||jsonb_build_object('trial_start',jsonb_build_object('kind','event_time','instant',private.automation_utc_text_v1(trial.starts_at),'timezone',trial.timezone));
                IF meta->'delay_fields' ? 'trial.starts_at' THEN anchors:=jsonb_build_object('trial.starts_at',private.automation_utc_text_v1(trial.starts_at)); END IF;
            ELSE unavailable:=true; END IF;
        END IF;
    WHEN is_belt THEN
        SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_subject_id;
        source_found:=recipient.id IS NOT NULL; student_id:=recipient.student_id; membership_id:=recipient.student_program_membership_id;
        program_id:=recipient.approved_program_id; rank_id:=recipient.approved_current_rank_id; generation:=to_jsonb(recipient.approved_rank_context_generation);
        SELECT * INTO event FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=recipient.event_id;
        expected:=jsonb_build_object('event_id',recipient.event_id,'student_id',student_id,'student_program_membership_id',membership_id,
            'approved_program_id',program_id,'approved_current_rank_id',rank_id,'approved_target_rank_id',recipient.approved_target_rank_id,
            'approved_schedule_revision',recipient.approved_schedule_revision,'approval_revision',recipient.revision,'approved_rank_context_generation',recipient.approved_rank_context_generation);
        IF p_captured_context IS NOT NULL THEN
            fields:=ARRAY['event_id','student_id','student_program_membership_id','approved_program_id','approved_current_rank_id','approved_target_rank_id','approved_schedule_revision','approval_revision','approved_rank_context_generation'];
            context_bad:=NOT private.workflow_json_keys_v1(context,fields,fields);
            IF NOT context_bad AND context IS DISTINCT FROM expected THEN reason:='approval_changed'; END IF;
        END IF;
        IF source_found AND (event.id IS NULL OR recipient.state<>'approved' OR event.status<>'scheduled'
            OR (event.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' AND event.starts_at<=p_reference_at) OR event.schedule_revision<>recipient.approved_schedule_revision) THEN reason:='belt_test_unavailable'; END IF;
        IF event.id IS NOT NULL THEN
            conditions:=jsonb_build_object('belt_test.event_scheduled',event.status='scheduled');
            templates:=jsonb_build_object('event_name',private.workflow_fact_text_v1(event.name),'event_location',private.workflow_fact_text_v1(event.location));
            IF event.starts_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
                AND event.ends_at>event.starts_at AND isfinite(event.ends_at)
                AND EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=event.timezone) THEN
                templates:=templates||jsonb_build_object('event_start',jsonb_build_object('kind','event_time','instant',private.automation_utc_text_v1(event.starts_at),'timezone',event.timezone));
                anchors:=jsonb_build_object('belt_test.starts_at',private.automation_utc_text_v1(event.starts_at));
            ELSE unavailable:=true; END IF;
        END IF;
    WHEN is_invoice THEN
        IF p_event_type='invoice.payment_failed' THEN
            SELECT * INTO payment FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_subject_id;
            source_found:=payment.id IS NOT NULL;
            SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=payment.invoice_id;
            IF source_found AND payment.status<>'failed' THEN reason:='payment_not_failed'; END IF;
            IF p_captured_context IS NULL THEN
                SELECT e.context INTO context FROM private.automation_workflow_events e WHERE e.studio_id=p_studio_id
                    AND e.event_type=p_event_type AND e.source_key=p_subject_id::TEXT AND e.subject_id=p_subject_id AND e.subject_kind='invoice';
            END IF;
            context_bad:=context IS NULL OR NOT private.workflow_json_keys_v1(context,
                ARRAY['payment_id','invoice_id','payer_id','invoice_settlement_generation','payment_evidence'],
                ARRAY['payment_id','invoice_id','payer_id','invoice_settlement_generation','payment_evidence'])
                OR NOT coalesce(private.workflow_integer_v1(context->'invoice_settlement_generation',1,9223372036854775807),false)
                OR NOT coalesce(private.workflow_payment_evidence_valid_v1(context->'payment_evidence'),false);
        ELSE
            SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=p_subject_id;
            source_found:=invoice.id IS NOT NULL;
            IF p_captured_context IS NOT NULL THEN
                fields:=ARRAY['invoice_id','payer_id','due_date','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation','currency'];
                context_bad:=NOT private.workflow_json_keys_v1(context,fields,fields)
                    OR NOT coalesce(private.workflow_typed_value_v1(context->'invoice_id',cat#>'{fields,program.id}'),false)
                    OR NOT coalesce(private.workflow_typed_value_v1(context->'payer_id',cat#>'{fields,program.id}'),false)
                    OR NOT coalesce(private.workflow_integer_v1(context->'connect_account_generation',1,2147483647),false)
                    OR jsonb_typeof(context->'currency') IS DISTINCT FROM 'string' OR context->>'currency' !~ '^[A-Za-z]{3}$'
                    OR jsonb_typeof(context->'due_date') IS DISTINCT FROM 'string' OR context->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
                FOREACH k IN ARRAY ARRAY['stripe_account_id','stripe_customer_id','stripe_invoice_id'] LOOP
                    context_bad:=context_bad OR jsonb_typeof(context->k) IS DISTINCT FROM 'string'
                        OR octet_length(context->>k) NOT BETWEEN 1 AND 255 OR context->>k !~ '^[!-~]+$';
                END LOOP;
                IF NOT context_bad THEN
                    BEGIN
                        captured_due:=(context->>'due_date')::DATE;
                        context_bad:=NOT isfinite(captured_due) OR captured_due NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
                            OR to_char(captured_due,'YYYY-MM-DD') IS DISTINCT FROM context->>'due_date';
                    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN context_bad:=true;
                    END;
                END IF;
                -- Equality is meaningful only for known current comparison values.
                -- This validates scalar shape; the existing financial reader still
                -- owns provider/payer agreement, unit provenance and settlement.
                current_context_bad:=invoice.currency IS NULL OR invoice.currency !~ '^[A-Za-z]{3}$'
                    OR (invoice.due_date IS NOT NULL AND (NOT isfinite(invoice.due_date)
                        OR invoice.due_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'));
                k:=invoice.metadata->>'connect_account_generation';
                IF k IS NULL OR length(k) NOT BETWEEN 1 AND 10 OR k !~ '^[1-9][0-9]*$' THEN current_context_bad:=true;
                ELSIF k::NUMERIC>2147483647 THEN current_context_bad:=true; END IF;
                FOREACH k IN ARRAY ARRAY['stripe_account_id','stripe_customer_id','stripe_invoice_id'] LOOP
                    value:=to_jsonb(invoice)->k;
                    current_context_bad:=current_context_bad OR jsonb_typeof(value) IS DISTINCT FROM 'string'
                        OR octet_length(value#>>'{}') NOT BETWEEN 1 AND 255 OR value#>>'{}' !~ '^[!-~]+$';
                END LOOP;
                IF current_context_bad THEN unavailable:=true;
                ELSIF NOT context_bad AND invoice.due_date IS NOT NULL AND (context->'invoice_id' IS DISTINCT FROM to_jsonb(invoice.id)
                    OR context->'payer_id' IS DISTINCT FROM coalesce(to_jsonb(invoice.payer_id),'null'::JSONB)
                    OR captured_due IS DISTINCT FROM invoice.due_date OR upper(context->>'currency') IS DISTINCT FROM upper(invoice.currency)
                    OR context->>'stripe_account_id' IS DISTINCT FROM invoice.stripe_account_id
                    OR context->>'stripe_customer_id' IS DISTINCT FROM invoice.stripe_customer_id
                    OR context->>'stripe_invoice_id' IS DISTINCT FROM invoice.stripe_invoice_id
                    OR context->>'connect_account_generation' IS DISTINCT FROM invoice.metadata->>'connect_account_generation') THEN reason:='source_context_changed'; END IF;
            END IF;
        END IF;
        SELECT * INTO payer FROM public.billing_payers WHERE studio_id=p_studio_id AND id=invoice.payer_id;
        IF source_found AND (invoice.id IS NULL OR payer.id IS NULL) THEN reason:='invoice_parent_missing'; END IF;
        IF invoice.id IS NOT NULL THEN
            conditions:=jsonb_build_object('invoice.open_balance',invoice.status='open' AND invoice.amount_remaining_cents>0);
            IF invoice.collection_method IS NULL OR invoice.collection_method IN ('send_invoice','charge_automatically') THEN
                conditions:=conditions||jsonb_build_object('invoice.collection_method',invoice.collection_method);
            END IF;
            IF invoice.due_date IS NULL OR (isfinite(invoice.due_date) AND invoice.due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') THEN
                conditions:=conditions||jsonb_build_object('invoice.overdue',invoice.status='open' AND invoice.amount_remaining_cents>0
                    AND coalesce(invoice.due_date<today,false));
                templates:=templates||jsonb_build_object('invoice_due_date',jsonb_build_object('kind','date','value',to_char(invoice.due_date,'YYYY-MM-DD')));
                IF p_event_type='invoice.overdue' AND (invoice.due_date IS NULL OR invoice.due_date>=today) THEN reason:=coalesce(reason,'invoice_not_overdue'); END IF;
            ELSIF p_event_type='invoice.overdue' THEN unavailable:=true; END IF;
            IF invoice.status<>'open' OR invoice.amount_remaining_cents<=0 THEN reason:=coalesce(reason,'invoice_not_open'); END IF;
            IF coalesce(invoice.metadata->'demo'='true'::JSONB,false) OR coalesce(payer.metadata->'demo'='true'::JSONB,false)
                OR coalesce(payment.metadata->'demo'='true'::JSONB,false) THEN reason:=coalesce(reason,'demo_source'); END IF;
            -- A known newer committed settlement remains a successor even when
            -- unrelated current financial facts are unavailable. Never repair it.
            IF p_event_type='invoice.payment_failed' AND NOT context_bad
                AND context->'payment_id'=to_jsonb(payment.id) AND context->'invoice_id'=to_jsonb(invoice.id)
                AND context#>'{payment_evidence,invalid_fields}'='[]'::JSONB THEN
                SELECT a.generation INTO settlement_generation FROM private.workflow_invoice_settlement_authority a
                    WHERE a.studio_id=p_studio_id AND a.invoice_id=invoice.id;
                IF settlement_generation>(context->>'invoice_settlement_generation')::BIGINT THEN reason:=coalesce(reason,'payment_settled');
                ELSIF settlement_generation IS NULL OR settlement_generation<(context->>'invoice_settlement_generation')::BIGINT THEN unavailable:=true; END IF;
            END IF;
            finance:=private.workflow_invoice_financial_context_v1(p_studio_id,invoice.id,payment.id);
            IF finance->'available' IS DISTINCT FROM 'true'::JSONB THEN unavailable:=true;
            ELSE
                templates:=templates||jsonb_build_object('invoice_balance',jsonb_build_object('kind','money',
                    'amount_minor_units',invoice.amount_remaining_cents,'currency',finance->'currency','unit_convention',finance->'unit_convention'));
            END IF;
            templates:=templates||jsonb_build_object('invoice_number',private.workflow_fact_text_v1(invoice.invoice_number));
            IF p_event_type='invoice.payment_failed' AND NOT context_bad THEN
                evidence:=private.workflow_payment_evidence_v1(payment);
                -- The evidence normalizer records malformed nonnull values as
                -- null plus invalid_fields. Those are unknown, not new identities.
                IF evidence->'invalid_fields' IS DISTINCT FROM '[]'::JSONB
                    OR EXISTS(SELECT 1 FROM jsonb_each(evidence) x WHERE x.key IN
                        ('currency','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation') AND x.value='null'::JSONB) THEN unavailable:=true;
                ELSIF context->'payment_id' IS DISTINCT FROM to_jsonb(payment.id) OR context->'invoice_id' IS DISTINCT FROM to_jsonb(invoice.id)
                    OR context->'payer_id' IS DISTINCT FROM to_jsonb(payer.id) THEN reason:=coalesce(reason,'source_context_changed');
                ELSIF context#>>'{payment_evidence,status}' IS DISTINCT FROM 'failed'
                    OR context#>'{payment_evidence,invalid_fields}' IS DISTINCT FROM '[]'::JSONB
                    OR context#>'{payment_evidence,payment_id}' IS DISTINCT FROM context->'payment_id'
                    OR context#>'{payment_evidence,invoice_id}' IS DISTINCT FROM context->'invoice_id'
                    OR context#>'{payment_evidence,payer_id}' IS DISTINCT FROM context->'payer_id'
                    OR EXISTS(SELECT 1 FROM jsonb_each(context->'payment_evidence') x WHERE x.key IN
                        ('currency','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation') AND x.value='null'::JSONB) THEN unavailable:=true;
                ELSIF EXISTS(SELECT 1 FROM jsonb_each(context->'payment_evidence') x WHERE x.key IN
                    ('payment_id','payer_id','invoice_id','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation')
                    AND x.value IS DISTINCT FROM evidence->x.key) THEN reason:=coalesce(reason,'source_context_changed');
                ELSIF context#>'{payment_evidence,currency}' IS DISTINCT FROM evidence->'currency' THEN
                    IF finance->'available'='true'::JSONB THEN reason:=coalesce(reason,'source_context_changed'); ELSE unavailable:=true; END IF;
                ELSIF finance->'available'='true'::JSONB AND context->'invoice_settlement_generation' IS DISTINCT FROM finance->'invoice_settlement_generation' THEN
                    reason:=coalesce(reason,'payment_settled');
                END IF;
            END IF;
        END IF;
    ELSE RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END CASE;
    -- A present durable context is never repaired by current equality. Validate
    -- its stored types before interpreting a difference as a known successor.
    IF context IS NOT NULL AND p_event_type<>'invoice.overdue' THEN
        IF jsonb_typeof(context) IS DISTINCT FROM 'object' THEN context_bad:=true;
        ELSE
            FOR k,value IN SELECT x.key,x.value FROM jsonb_each(context) x LOOP
                IF k IN ('rank_context_generation','approved_rank_context_generation','approved_schedule_revision','approval_revision','revision','invoice_settlement_generation') THEN
                    context_bad:=context_bad OR NOT coalesce(private.workflow_integer_v1(value,1,9223372036854775807),false);
                ELSIF k IN ('stage','old_stage') THEN
                    context_bad:=context_bad OR NOT coalesce(private.workflow_typed_value_v1(value,cat#>'{fields,lead.stage}'),false);
                ELSIF k='status' THEN
                    context_bad:=context_bad OR NOT coalesce(private.workflow_typed_value_v1(value,cat#>'{fields,trial.status}'),false);
                ELSIF k NOT IN ('matched_program_ids','payment_evidence') THEN
                    context_bad:=context_bad OR NOT (coalesce(private.workflow_typed_value_v1(value,cat#>'{fields,program.id}'),false)
                        OR (value='null'::JSONB AND k IN ('program_id','student_program_membership_id','approved_program_id','approved_current_rank_id','from_rank_id')));
                END IF;
            END LOOP;
        END IF;
        -- Malformed context differences are unknown, not a fabricated successor.
        IF context_bad AND reason IN ('source_context_changed','approval_changed') THEN reason:=NULL; END IF;
    END IF;
    IF NOT source_found THEN reason:='source_missing'; END IF;
    -- Resolve exact current parents before optional contact/render availability.
    IF student_id IS NOT NULL THEN
        IF student.id IS NULL THEN SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=student_id; END IF;
        IF student.id IS NULL OR student.deleted_at IS NOT NULL THEN reason:=coalesce(reason,'student_unavailable');
        ELSIF student.status<>'active' THEN reason:=coalesce(reason,'inactive'); END IF;
        IF student.id IS NOT NULL THEN
            conditions:=conditions||jsonb_build_object('student.status',student.status);
            IF (student.hold_start_date IS NULL OR isfinite(student.hold_start_date)) AND (student.hold_end_date IS NULL OR isfinite(student.hold_end_date)) THEN
                on_hold:=student.hold_start_date IS NOT NULL AND student.hold_start_date<=today AND (student.hold_end_date IS NULL OR student.hold_end_date>=today);
                conditions:=conditions||jsonb_build_object('student.on_hold',on_hold);
                IF on_hold THEN reason:=coalesce(reason,'on_hold'); END IF;
            ELSE unavailable:=true; END IF;
            minor:=CASE WHEN student.date_of_birth IS NULL THEN coalesce(student.is_minor,false)
                WHEN isfinite(student.date_of_birth) AND student.date_of_birth BETWEEN DATE '0001-01-01' AND today
                THEN student.date_of_birth>(today-INTERVAL '18 years')::DATE END;
            IF minor IS NOT NULL THEN conditions:=conditions||jsonb_build_object('student.is_minor',minor); END IF;
            templates:=templates||jsonb_build_object('student_first_name',private.workflow_fact_text_v1(CASE WHEN private.workflow_blank_v1(to_jsonb(student.preferred_name)) THEN student.legal_first_name ELSE student.preferred_name END));
        END IF;
    END IF;
    IF lead_id IS NOT NULL THEN
        IF lead.id IS NULL THEN SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=lead_id; END IF;
        IF lead.id IS NULL THEN reason:=coalesce(reason,'lead_unavailable');
        ELSE
            conditions:=conditions||jsonb_build_object('lead.stage',lead.stage,'lead.unconverted',lead.converted_student_id IS NULL AND lead.stage<>'enrolled');
            IF lead.source IN ('walk_in','referral','social','search','website','other') THEN conditions:=conditions||jsonb_build_object('lead.source',lead.source); END IF;
            IF lead.converted_student_id IS NOT NULL OR lead.stage NOT IN ('inquiry','trial_scheduled','trial_completed','offer_sent') THEN reason:=coalesce(reason,'lead_closed'); END IF;
            templates:=templates||jsonb_build_object('lead_first_name',private.workflow_fact_text_v1(lead.first_name));
        END IF;
    END IF;
    IF meta->'field_ids' ? 'program.id' AND NOT (p_event_type='student.promoted' AND context_bad) THEN conditions:=conditions||jsonb_build_object('program.id',program_id); END IF;
    IF program_id IS NOT NULL THEN
        SELECT * INTO program FROM public.programs WHERE studio_id=p_studio_id AND id=program_id AND archived_at IS NULL;
        IF program.id IS NULL THEN reason:=coalesce(reason,'program_unavailable'); END IF;
    END IF;
    IF p_event_type='student.promoted' AND NOT context_bad THEN
        IF program_id IS NULL THEN templates:=templates||jsonb_build_object('program_name',private.workflow_fact_text_v1(NULL));
        ELSIF program.id IS NOT NULL THEN templates:=templates||jsonb_build_object('program_name',private.workflow_fact_text_v1(program.name)); END IF;
    END IF;
    IF filter_id IS NOT NULL AND NOT (p_event_type='student.promoted' AND context_bad) THEN
        IF p_event_type='student.enrolled' THEN
            IF NOT EXISTS(SELECT 1 FROM public.student_program_memberships m JOIN public.programs p ON p.studio_id=m.studio_id AND p.id=m.program_id
                WHERE m.studio_id=p_studio_id AND m.student_id=student.id AND m.program_id=filter_id AND m.status IN ('active','paused') AND m.ended_at IS NULL AND p.archived_at IS NULL)
                OR (p_captured_context IS NOT NULL AND NOT context_bad AND NOT context->'matched_program_ids' @> jsonb_build_array(filter_id)) THEN reason:=coalesce(reason,'program_unavailable'); END IF;
        ELSIF program_id IS DISTINCT FROM filter_id THEN reason:=coalesce(reason,'program_unavailable'); END IF;
    END IF;
    IF (p_event_type='student.promoted' OR is_belt) AND student.id IS NOT NULL THEN
        authority:=private.workflow_current_rank_authority_v1(p_studio_id,student.id,membership_id);
        IF authority->'pending'='true'::JSONB THEN unavailable:=true;
        ELSE
        IF NOT context_bad THEN
        IF authority#>'{context,source_exists}' IS DISTINCT FROM 'true'::JSONB OR authority#>'{context,live}' IS DISTINCT FROM 'true'::JSONB THEN
            reason:=coalesce(reason,'rank_context_lost');
        ELSIF authority->'available' IS DISTINCT FROM 'true'::JSONB THEN unavailable:=true;
        ELSIF authority#>'{context,program_id}' IS DISTINCT FROM coalesce(to_jsonb(program_id),'null'::JSONB)
            OR authority#>'{context,rank_id}' IS DISTINCT FROM coalesce(to_jsonb(rank_id),'null'::JSONB) THEN reason:=coalesce(reason,'rank_context_changed');
        ELSIF (authority->>'generation')::BIGINT<(generation#>>'{}')::BIGINT THEN unavailable:=true;
        ELSIF authority->'generation' IS DISTINCT FROM generation THEN reason:=coalesce(reason,'rank_context_superseded'); END IF;
        END IF;
        IF rank_id IS NOT NULL THEN
            SELECT * INTO rank FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=rank_id;
            IF rank.id IS NULL THEN reason:=coalesce(reason,'rank_unavailable'); END IF;
        ELSIF p_event_type='student.promoted' THEN reason:=coalesce(reason,'rank_unavailable'); END IF;
        SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=CASE WHEN is_belt THEN event.ladder_id ELSE rank.ladder_id END;
        IF ladder.id IS NULL
            OR (rank.id IS NOT NULL AND rank.ladder_id IS DISTINCT FROM ladder.id)
            OR (NOT context_bad AND ladder.program_id IS NOT NULL AND ladder.program_id IS DISTINCT FROM program_id)
            OR (is_belt AND ladder.program_id IS DISTINCT FROM event.program_id)
            OR (is_belt AND membership_id IS NULL AND event.program_id IS NOT NULL) THEN reason:=coalesce(reason,'ladder_unavailable'); END IF;
        IF is_belt AND NOT EXISTS(SELECT 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=recipient.approved_target_rank_id AND ladder_id=ladder.id) THEN reason:=coalesce(reason,'rank_unavailable'); END IF;
        END IF;
        approval_current:=reason IS NULL AND NOT unavailable AND NOT context_bad;
    END IF;
    IF is_belt THEN
        -- Unknown authority is omitted; a known terminal source is diagnostic false.
        IF reason IS NOT NULL OR (NOT unavailable AND NOT context_bad) THEN conditions:=conditions||jsonb_build_object('belt_test.approval_current',approval_current); END IF;
    END IF;
    unavailable:=unavailable OR context_bad;
    templates:=templates||jsonb_build_object('studio_name',private.workflow_fact_text_v1(studio.name));
    -- Resolve each role independently; no global recipient_name or guardian fallback.
    FOREACH policy IN ARRAY p_recipient_ids LOOP
        email:=NULL; name:=NULL; kind:=NULL; contact_reason:=NULL; contact_decision:='skip';
        CASE policy
        WHEN 'student_or_guardian' THEN
            IF student.id IS NULL THEN contact_reason:='student_unavailable';
            ELSIF minor IS NULL THEN contact_reason:='invalid_birth_date'; contact_decision:='unavailable';
            ELSIF NOT minor THEN email:=private.automation_normalize_email(student.email); name:=student.legal_first_name||' '||student.legal_last_name; kind:='student';
            ELSE
                SELECT count(*) FILTER(WHERE private.automation_normalize_email(g.email) IS NOT NULL) valid_count,
                    count(*) FILTER(WHERE g.is_primary_contact) primary_count,
                    count(*) FILTER(WHERE g.is_primary_contact AND private.automation_normalize_email(g.email) IS NOT NULL) valid_primary_count,
                    max(private.automation_normalize_email(g.email)) FILTER(WHERE g.is_primary_contact) primary_email,
                    max(g.first_name||' '||g.last_name) FILTER(WHERE g.is_primary_contact) primary_name,
                    max(private.automation_normalize_email(g.email)) any_email,
                    max(g.first_name||' '||g.last_name) FILTER(WHERE private.automation_normalize_email(g.email) IS NOT NULL) any_name
                    INTO guardian FROM public.student_guardians sg JOIN public.guardians g ON g.id=sg.guardian_id AND g.studio_id=p_studio_id WHERE sg.student_id=student.id;
                IF guardian.primary_count>1 OR (guardian.valid_primary_count=0 AND guardian.valid_count>1) THEN contact_reason:='guardian_ambiguous';
                ELSIF guardian.primary_count=1 AND guardian.valid_primary_count=1 THEN email:=guardian.primary_email; name:=guardian.primary_name;
                ELSIF guardian.primary_count<=1 AND guardian.valid_count=1 THEN email:=guardian.any_email; name:=guardian.any_name;
                ELSE contact_reason:='guardian_missing'; END IF;
                kind:='guardian';
            END IF;
        WHEN 'lead_or_guardian' THEN
            IF lead.id IS NULL THEN contact_reason:='lead_unavailable';
            ELSIF lead.is_minor IS NULL THEN contact_reason:='minority_unavailable'; contact_decision:='unavailable';
            ELSIF lead.is_minor THEN email:=private.automation_normalize_email(lead.guardian_email); name:=lead.guardian_name; kind:='guardian';
            ELSE email:=private.automation_normalize_email(lead.email); name:=lead.first_name||' '||lead.last_name; kind:='lead'; END IF;
        WHEN 'assigned_staff' THEN
            staff:=private.workflow_current_staff_recipient_v1(p_studio_id,lead.assigned_staff_id);
            contact_decision:=staff->>'decision'; contact_reason:=staff->>'reason'; email:=staff->>'email'; name:=staff->>'name'; kind:='assigned_staff';
        WHEN 'invoice_payer' THEN
            IF payer.id IS NULL THEN contact_reason:='payer_unavailable';
            ELSE email:=private.automation_normalize_email(payer.email); name:=payer.display_name; kind:='invoice_payer'; END IF;
        END CASE;
        IF contact_reason IS NULL AND email IS NULL THEN contact_reason:='invalid_email'; END IF;
        IF contact_reason IS NULL AND EXISTS(SELECT 1 FROM public.automation_suppressions WHERE studio_id=p_studio_id AND recipient_email=email) THEN contact_reason:='suppressed'; END IF;
        IF contact_reason IS NULL THEN contact_decision:='ready';
        ELSE
            IF contact_decision<>'unavailable' THEN contact_decision:='skip'; END IF;
            email:=NULL; kind:=NULL;
        END IF;
        recipients:=recipients||jsonb_build_object(policy,jsonb_build_object('decision',contact_decision,'reason',contact_reason,
            'template_facts',CASE WHEN contact_decision='unavailable' THEN '{}'::JSONB ELSE jsonb_build_object('recipient_name',private.workflow_fact_text_v1(name)) END));
        addresses:=addresses||jsonb_build_object(policy,jsonb_build_object('email',email,'kind',kind));
    END LOOP;
    -- Catalog applicability is the final closed-map boundary.
    SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::JSONB) INTO conditions FROM jsonb_each(conditions) e
        WHERE meta->'field_ids' ? e.key AND (private.workflow_typed_value_v1(e.value,cat#>ARRAY['fields',e.key])
            OR (e.value='null'::JSONB AND cat#>ARRAY['fields',e.key,'nullable']='true'::JSONB));
    SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::JSONB) INTO templates FROM jsonb_each(templates) e WHERE meta->'template_variables' ? e.key;
    RETURN jsonb_build_object('entity_found',source_found,'facts',jsonb_build_object(
        'source_decision',CASE WHEN reason IS NOT NULL THEN 'ineligible' WHEN unavailable THEN 'unavailable' ELSE 'eligible' END,
        'source_reason',coalesce(reason,CASE WHEN unavailable THEN 'facts_unavailable' END),
        'condition_facts',conditions,'template_facts',templates,'anchors',anchors,'recipients',recipients),'recipient_addresses',addresses);
END $$;

-- Same tenant-reference predicates as the retained validate read, without its
-- actor locks. Structural validation must finish before any reference UUID cast.
CREATE FUNCTION private.workflow_graph_read_issues_v1(p_studio_id UUID,p_graph JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE issues JSONB;
BEGIN
    issues:=private.workflow_validate_v1(p_graph,'{}',false);
    IF issues<>'[]'::JSONB THEN RETURN issues; END IF;
    WITH nodes AS (
        SELECT n->>'id' node_id,
            CASE WHEN n->>'type'='trigger' THEN 'program.id' ELSE n->'config'->>'field' END kind,
            CASE WHEN n->>'type'='trigger' THEN 'config.program_id' ELSE 'config.value' END field,
            CASE WHEN n->>'type'='trigger' THEN n->'config'->'program_id' ELSE n->'config'->'value' END value
        FROM jsonb_array_elements(p_graph->'nodes') n
        WHERE n->>'type'='trigger' OR n->>'type'='condition' AND n->'config'->>'field' IN ('program.id','promotion.rank_id')
    ), refs AS (
        SELECT n.node_id,n.kind,n.field,(v.value#>>'{}')::UUID id FROM nodes n
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN n.value IS NULL OR n.value='null' THEN '[]'::JSONB
            WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE jsonb_build_array(n.value) END) v(value)
    ), all_issues AS (
        SELECT jsonb_build_object('code','reference_unavailable','message','Choose an available program or rank.',
            'node_id',r.node_id,'edge_id',NULL,'field',r.field) issue
        FROM refs r
        LEFT JOIN public.programs p ON r.kind='program.id' AND p.studio_id=p_studio_id AND p.id=r.id
        LEFT JOIN public.belt_ranks b ON r.kind='promotion.rank_id' AND b.studio_id=p_studio_id AND b.id=r.id
        WHERE r.kind='program.id' AND p.id IS NULL OR r.kind='promotion.rank_id' AND b.id IS NULL
        UNION SELECT value FROM jsonb_array_elements(private.workflow_validate_v1(p_graph,'{}',true))
    )
    SELECT coalesce(jsonb_agg(issue ORDER BY (issue->>'node_id') COLLATE "C" NULLS FIRST,
        (issue->>'field') COLLATE "C" NULLS FIRST,(issue->>'code') COLLATE "C",issue::TEXT COLLATE "C"),'[]'::JSONB) INTO issues FROM all_issues;
    RETURN issues;
END $$;
CREATE FUNCTION private.workflow_simulation_projection_v1(
    p_studio_id UUID,p_workflow_id UUID,p_graph JSONB,p_context JSONB,p_reference_at TIMESTAMPTZ
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE issues JSONB; event_type TEXT; trigger_node JSONB; trigger_count INTEGER; built JSONB; result JSONB;
    policies TEXT[]; meta JSONB; uuid_meta JSONB:=private.workflow_catalog_v1()#>'{fields,program.id}';
BEGIN
    IF p_workflow_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=p_workflow_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    IF NOT private.workflow_json_keys_v1(p_context,ARRAY['kind','entity_type','entity_id'],ARRAY['kind'])
        OR p_context->>'kind' NOT IN ('synthetic','entity') OR jsonb_typeof(p_context->'kind') IS DISTINCT FROM 'string'
        OR (p_context->>'kind'='synthetic' AND NOT private.workflow_json_keys_v1(p_context,ARRAY['kind'],ARRAY['kind']))
        OR (p_context->>'kind'='entity' AND (NOT p_context ?& ARRAY['entity_type','entity_id']
            OR p_context->>'entity_type' NOT IN ('student','promotion','lead','trial_appointment','invoice','payment','belt_test_recipient')
            OR jsonb_typeof(p_context->'entity_type') IS DISTINCT FROM 'string'
            OR NOT coalesce(private.workflow_typed_value_v1(p_context->'entity_id',uuid_meta),false))) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    issues:=private.workflow_graph_read_issues_v1(p_studio_id,p_graph);
    IF jsonb_typeof(p_graph->'nodes')='array' THEN
        SELECT count(*) INTO trigger_count FROM jsonb_array_elements(p_graph->'nodes') n WHERE n->>'type'='trigger';
        IF trigger_count=1 THEN
            SELECT n INTO trigger_node FROM jsonb_array_elements(p_graph->'nodes') n WHERE n->>'type'='trigger';
            meta:=private.workflow_catalog_v1()#>ARRAY['triggers',trigger_node#>>'{config,event_type}'];
            IF meta IS NOT NULL THEN event_type:=trigger_node#>>'{config,event_type}'; END IF;
        END IF;
    END IF;
    IF event_type IS NOT NULL AND p_context->>'kind'='entity' AND p_context->>'entity_type' IS DISTINCT FROM meta->>'simulation_entity_type' THEN
        issues:=issues||jsonb_build_array(jsonb_build_object('code','context_mismatch','message','Select the entity type for this trigger.',
            'node_id',trigger_node->>'id','edge_id',NULL,'field','context.entity_type'));
    END IF;
    IF issues='[]'::JSONB AND p_context->>'kind'='entity' THEN
        SELECT coalesce(array_agg(DISTINCT n#>>'{config,recipient}' ORDER BY n#>>'{config,recipient}'),'{}'::TEXT[]) INTO policies
            FROM jsonb_array_elements(p_graph->'nodes') n WHERE n->>'type'='email';
        built:=private.workflow_current_source_facts_v1(p_studio_id,event_type,(p_context->>'entity_id')::UUID,NULL,
            trigger_node->'config',p_reference_at,policies);
        IF built->'entity_found' IS DISTINCT FROM 'true'::JSONB THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        result:=built->'facts';
    END IF;
    RETURN jsonb_build_object('studio_id',p_studio_id,'workflow_id',p_workflow_id,'context',p_context,
        'reference_time',private.automation_utc_text_v1(p_reference_at),'valid',issues='[]'::JSONB,'issues',issues,'event_type',event_type,'facts',result);
END $$;
CREATE FUNCTION public.get_automation_workflow_simulation_facts_v1(
    p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,p_graph JSONB,p_context JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE at TIMESTAMPTZ; result JSONB;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    at:=clock_timestamp();
    SELECT private.workflow_simulation_projection_v1(p_studio_id,p_workflow_id,p_graph,p_context,at) INTO result;
    RETURN jsonb_build_object('payload',result);
END $$;
CREATE FUNCTION public.get_belt_test_recipient_v1(p_studio_id UUID,p_actor_id UUID,p_event_id UUID,p_recipient_id UUID) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE result JSONB;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_event_id IS NULL OR p_recipient_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    SELECT private.belt_test_recipient_payload_v1(r) INTO result FROM public.belt_test_recipients r
        JOIN public.belt_test_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND r.event_id=p_event_id AND r.id=p_recipient_id;
    IF result IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('payload',result);
END $$;
DO $current_fact_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_fact_text_v1','workflow_staff_auth_email_v1','workflow_current_staff_recipient_v1',
            'workflow_current_rank_authority_v1','workflow_current_source_facts_v1','workflow_graph_read_issues_v1','workflow_simulation_projection_v1'))
        OR (n.nspname='public' AND p.proname IN ('get_automation_workflow_simulation_facts_v1','get_belt_test_recipient_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
    END LOOP;
END;
$current_fact_privileges$;

-- Bounded nonmail execution. Sending recovery remains with the later atomic mail owner.
-- A collection episode records observed identity, never financial or send authority.
CREATE FUNCTION private.workflow_invoice_episode_context_valid_v1(p_context JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE k TEXT; due DATE;
BEGIN
    IF NOT private.workflow_json_keys_v1(p_context,
        ARRAY['invoice_id','payer_id','due_date','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation','currency'],
        ARRAY['invoice_id','payer_id','due_date','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation','currency']) THEN RETURN false; END IF;
    FOREACH k IN ARRAY ARRAY['invoice_id','payer_id'] LOOP
        IF jsonb_typeof(p_context->k) IS DISTINCT FROM 'string' OR p_context->>k !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['stripe_account_id','stripe_customer_id','stripe_invoice_id'] LOOP
        IF jsonb_typeof(p_context->k) IS DISTINCT FROM 'string' OR octet_length(p_context->>k) NOT BETWEEN 1 AND 255
            OR p_context->>k !~ '^[!-~]+$' THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(p_context->'currency') IS DISTINCT FROM 'string' OR p_context->>'currency' !~ '^[A-Z]{3}$'
        OR NOT coalesce(private.workflow_integer_v1(p_context->'connect_account_generation',1,2147483647),false)
        OR jsonb_typeof(p_context->'due_date') IS DISTINCT FROM 'string' OR p_context->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
    due:=(p_context->>'due_date')::DATE;
    RETURN isfinite(due) AND due BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' AND to_char(due,'YYYY-MM-DD')=p_context->>'due_date';
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;

CREATE FUNCTION private.workflow_invoice_episode_projection_v1(p_invoice public.billing_invoices,p_payer public.billing_payers)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE reason TEXT; context JSONB; generation TEXT; k TEXT; value TEXT;
BEGIN
    -- Known stop facts outrank uncertainty. NULL or malformed values are never zero.
    reason:=CASE WHEN p_invoice.id IS NULL THEN 'source_missing'
        WHEN p_invoice.status IN ('draft','paid','void','uncollectible','refunded','partially_refunded')
            OR p_invoice.amount_remaining_cents<=0 THEN 'invoice_not_open'
        WHEN p_invoice.due_date IS NULL THEN 'invoice_not_overdue'
        WHEN p_invoice.payer_id IS NULL OR p_payer.id IS NULL OR p_payer.id IS DISTINCT FROM p_invoice.payer_id
            OR p_payer.studio_id IS DISTINCT FROM p_invoice.studio_id THEN 'invoice_parent_missing'
        WHEN p_invoice.metadata->'demo'='true'::JSONB OR p_payer.metadata->'demo'='true'::JSONB THEN 'demo_source' END;
    IF reason IS NOT NULL THEN RETURN jsonb_build_object('classification','excluded','reason',reason,'context',NULL); END IF;
    IF p_invoice.studio_id IS NULL OR p_invoice.status IS DISTINCT FROM 'open' OR p_invoice.amount_remaining_cents IS NULL
        OR NOT isfinite(p_invoice.due_date) OR p_invoice.due_date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        OR p_invoice.currency IS NULL OR p_invoice.currency !~ '^[A-Za-z]{3}$' THEN
        RETURN jsonb_build_object('classification','unavailable','reason','facts_unavailable','context',NULL);
    END IF;
    generation:=p_invoice.metadata->>'connect_account_generation';
    IF jsonb_typeof(p_invoice.metadata->'connect_account_generation') NOT IN ('number','string') OR generation IS NULL
        OR length(generation) NOT BETWEEN 1 AND 10 OR generation !~ '^[1-9][0-9]*$' THEN
        RETURN jsonb_build_object('classification','unavailable','reason','facts_unavailable','context',NULL);
    END IF;
    IF generation::NUMERIC>2147483647 THEN RETURN jsonb_build_object('classification','unavailable','reason','facts_unavailable','context',NULL); END IF;
    FOREACH k IN ARRAY ARRAY['stripe_account_id','stripe_customer_id','stripe_invoice_id'] LOOP
        value:=to_jsonb(p_invoice)->>k;
        IF value IS NULL OR octet_length(value) NOT BETWEEN 1 AND 255 OR value !~ '^[!-~]+$' THEN
            RETURN jsonb_build_object('classification','unavailable','reason','facts_unavailable','context',NULL);
        END IF;
    END LOOP;
    context:=jsonb_build_object('invoice_id',p_invoice.id,'payer_id',p_invoice.payer_id,'due_date',to_char(p_invoice.due_date,'YYYY-MM-DD'),
        'stripe_account_id',p_invoice.stripe_account_id,'stripe_customer_id',p_invoice.stripe_customer_id,'stripe_invoice_id',p_invoice.stripe_invoice_id,
        'connect_account_generation',generation::INTEGER,'currency',upper(p_invoice.currency));
    RETURN jsonb_build_object('classification','open_positive','reason',NULL,'context',context);
END $$;

-- PG17 resolves nonexistent midnight with the preceding offset and repeats with
-- the following offset. This is scheduled midnight, not a first actual crossing.
CREATE FUNCTION private.workflow_invoice_episode_threshold_v1(p_due DATE,p_zone TEXT) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE result TIMESTAMPTZ;
BEGIN
    IF p_due IS NULL OR p_zone IS NULL OR NOT isfinite(p_due) OR p_due NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-30' THEN RETURN NULL; END IF;
    result:=(p_due+1)::TIMESTAMP AT TIME ZONE p_zone;
    IF NOT isfinite(result) OR result NOT BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' THEN RETURN NULL; END IF;
    RETURN result;
EXCEPTION WHEN datetime_field_overflow OR invalid_parameter_value THEN RETURN NULL;
END $$;

CREATE TABLE private.workflow_invoice_episode_state (
    invoice_id UUID PRIMARY KEY,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    episode_number BIGINT NOT NULL DEFAULT 0 CHECK(episode_number>=0),
    current_episode_id UUID,
    ever_removed BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL CHECK(isfinite(updated_at) AND updated_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    UNIQUE(studio_id,invoice_id),
    CHECK(current_episode_id IS NULL OR episode_number>0)
);
CREATE TABLE private.workflow_invoice_collection_episodes (
    id UUID PRIMARY KEY,
    studio_id UUID NOT NULL,
    invoice_id UUID NOT NULL,
    episode_number BIGINT NOT NULL CHECK(episode_number>0),
    context JSONB NOT NULL CHECK(private.workflow_invoice_episode_context_valid_v1(context)),
    opened_at TIMESTAMPTZ NOT NULL CHECK(isfinite(opened_at) AND opened_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    frozen_timezone TEXT NOT NULL,
    threshold_at TIMESTAMPTZ CHECK(isfinite(threshold_at) AND threshold_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    threshold_eligible BOOLEAN NOT NULL,
    closed_at TIMESTAMPTZ CHECK(isfinite(closed_at) AND closed_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' AND closed_at>=opened_at),
    close_reason TEXT CHECK(close_reason IN ('source_missing','invoice_not_open','invoice_not_overdue','invoice_parent_missing','demo_source','source_context_changed')),
    FOREIGN KEY(studio_id,invoice_id) REFERENCES private.workflow_invoice_episode_state(studio_id,invoice_id) ON DELETE CASCADE,
    UNIQUE(invoice_id,episode_number), UNIQUE(studio_id,invoice_id,id),
    CHECK((closed_at IS NULL)=(close_reason IS NULL)),
    CHECK(context->>'invoice_id'=invoice_id::TEXT),
    CHECK(NOT threshold_eligible OR (threshold_at IS NOT NULL AND opened_at<=threshold_at AND (opened_at AT TIME ZONE frozen_timezone)::DATE<=(context->>'due_date')::DATE))
);
ALTER TABLE private.workflow_invoice_episode_state ADD CONSTRAINT workflow_invoice_episode_current_fk
    FOREIGN KEY(studio_id,invoice_id,current_episode_id) REFERENCES private.workflow_invoice_collection_episodes(studio_id,invoice_id,id);
CREATE INDEX workflow_invoice_episode_active_threshold ON private.workflow_invoice_collection_episodes(threshold_at,studio_id,invoice_id,id)
    WHERE closed_at IS NULL AND threshold_eligible;
CREATE INDEX workflow_invoice_episode_history ON private.workflow_invoice_collection_episodes(studio_id,invoice_id,episode_number);
CREATE TABLE private.workflow_invoice_episode_pending (
    studio_id UUID NOT NULL, invoice_id UUID NOT NULL, backend_pid INTEGER NOT NULL CHECK(backend_pid>0), transaction_id XID8 NOT NULL,
    may_initialize BOOLEAN NOT NULL, saw_known_transition BOOLEAN NOT NULL, saw_removal BOOLEAN NOT NULL,
    transition_reason TEXT CHECK(transition_reason IN ('source_missing','invoice_not_open','invoice_not_overdue','invoice_parent_missing','demo_source','source_context_changed')),
    PRIMARY KEY(studio_id,invoice_id,backend_pid,transaction_id),
    CHECK(NOT saw_removal OR saw_known_transition),
    CHECK(transition_reason IS NULL OR saw_known_transition)
);

-- The financial installation lock remains held. Freeze each seed studio zone
-- before one observation clock, with no events, runs or source-row mutation.
DO $invoice_episode_seed$
DECLARE item RECORD; projection JSONB; zone TEXT; boundary TIMESTAMPTZ; episode UUID; at TIMESTAMPTZ;
BEGIN
    PERFORM 1 FROM public.studios s WHERE EXISTS(SELECT 1 FROM public.billing_invoices i WHERE i.studio_id=s.id) ORDER BY s.id FOR SHARE NOWAIT;
    at:=clock_timestamp();
    INSERT INTO private.workflow_invoice_episode_state(invoice_id,studio_id,updated_at) SELECT id,studio_id,at FROM public.billing_invoices;
    FOR item IN SELECT i AS invoice,y AS payer,s.timezone FROM public.billing_invoices i
        JOIN public.studios s ON s.id=i.studio_id LEFT JOIN public.billing_payers y ON y.id=i.payer_id AND y.studio_id=i.studio_id ORDER BY i.id LOOP
        projection:=private.workflow_invoice_episode_projection_v1(item.invoice,item.payer);
        IF projection->>'classification'<>'open_positive' THEN CONTINUE; END IF;
        zone:=CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=item.timezone) THEN item.timezone ELSE 'UTC' END;
        boundary:=private.workflow_invoice_episode_threshold_v1((projection#>>'{context,due_date}')::DATE,zone); episode:=gen_random_uuid();
        INSERT INTO private.workflow_invoice_collection_episodes(id,studio_id,invoice_id,episode_number,context,opened_at,frozen_timezone,threshold_at,threshold_eligible)
            VALUES(episode,(item.invoice).studio_id,(item.invoice).id,1,projection->'context',at,zone,boundary,
                coalesce(boundary IS NOT NULL AND at<=boundary AND (at AT TIME ZONE zone)::DATE<=(item.invoice).due_date,false));
        UPDATE private.workflow_invoice_episode_state SET episode_number=1,current_episode_id=episode WHERE invoice_id=(item.invoice).id;
    END LOOP;
END $invoice_episode_seed$;

CREATE FUNCTION private.workflow_invoice_episode_state_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE pending private.workflow_invoice_episode_pending; episode private.workflow_invoice_collection_episodes;
BEGIN
    SELECT * INTO pending FROM private.workflow_invoice_episode_pending WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
    IF pending.invoice_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF TG_OP='INSERT' THEN
        IF NOT pending.may_initialize OR NEW.episode_number<>0 OR NEW.current_episode_id IS NOT NULL OR NEW.ever_removed THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        RETURN NEW;
    END IF;
    IF ROW(NEW.studio_id,NEW.invoice_id) IS DISTINCT FROM ROW(OLD.studio_id,OLD.invoice_id)
        OR NEW.episode_number<OLD.episode_number OR NEW.episode_number::NUMERIC>OLD.episode_number::NUMERIC+1
        OR (OLD.ever_removed AND NOT NEW.ever_removed) OR (NEW.ever_removed AND NOT OLD.ever_removed AND NOT pending.saw_removal)
        OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF NEW.current_episode_id IS NOT NULL THEN
        SELECT * INTO episode FROM private.workflow_invoice_collection_episodes WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id AND id=NEW.current_episode_id;
        IF episode.id IS NULL OR episode.episode_number<>NEW.episode_number OR episode.closed_at IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
    ELSIF NEW.episode_number<>OLD.episode_number THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF NEW.current_episode_id IS DISTINCT FROM OLD.current_episode_id AND OLD.current_episode_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM private.workflow_invoice_collection_episodes WHERE id=OLD.current_episode_id AND closed_at IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF (NEW.episode_number>OLD.episode_number) IS DISTINCT FROM (NEW.current_episode_id IS NOT NULL AND NEW.current_episode_id IS DISTINCT FROM OLD.current_episode_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_invoice_episode_state_identity_v1 BEFORE INSERT OR UPDATE ON private.workflow_invoice_episode_state
    FOR EACH ROW EXECUTE FUNCTION private.workflow_invoice_episode_state_identity_v1();

CREATE FUNCTION private.workflow_invoice_episode_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE state private.workflow_invoice_episode_state; pending private.workflow_invoice_episode_pending; invoice public.billing_invoices;
    payer public.billing_payers; zone TEXT; projection JSONB;
BEGIN
    SELECT * INTO pending FROM private.workflow_invoice_episode_pending WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id
        AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
    IF pending.invoice_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF TG_OP='UPDATE' THEN
        IF (to_jsonb(NEW)-ARRAY['closed_at','close_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['closed_at','close_reason'])
            OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL OR NEW.close_reason IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO state FROM private.workflow_invoice_episode_state WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id;
    SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=NEW.studio_id AND id=NEW.invoice_id;
    SELECT * INTO payer FROM public.billing_payers WHERE studio_id=NEW.studio_id AND id=invoice.payer_id;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone) THEN s.timezone ELSE 'UTC' END
        INTO zone FROM public.studios s WHERE s.id=NEW.studio_id;
    projection:=private.workflow_invoice_episode_projection_v1(invoice,payer);
    IF state.invoice_id IS NULL OR NEW.episode_number::NUMERIC<>state.episode_number::NUMERIC+1 OR NEW.closed_at IS NOT NULL OR NEW.close_reason IS NOT NULL
        OR projection->>'classification' IS DISTINCT FROM 'open_positive' OR NEW.context IS DISTINCT FROM projection->'context'
        OR NEW.frozen_timezone IS DISTINCT FROM zone OR NEW.threshold_at IS DISTINCT FROM private.workflow_invoice_episode_threshold_v1(invoice.due_date,zone)
        OR NEW.threshold_eligible IS DISTINCT FROM coalesce(NEW.threshold_at IS NOT NULL AND NEW.opened_at<=NEW.threshold_at
            AND (NEW.opened_at AT TIME ZONE zone)::DATE<=invoice.due_date,false)
        OR (state.current_episode_id IS NOT NULL AND EXISTS(SELECT 1 FROM private.workflow_invoice_collection_episodes WHERE id=state.current_episode_id AND closed_at IS NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_invoice_episode_identity_v1 BEFORE INSERT OR UPDATE ON private.workflow_invoice_collection_episodes
    FOR EACH ROW EXECUTE FUNCTION private.workflow_invoice_episode_identity_v1();

CREATE FUNCTION private.workflow_invoice_episode_pending_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NEW.backend_pid<>pg_catalog.pg_backend_pid() OR NEW.transaction_id<>pg_catalog.pg_current_xact_id() OR pg_catalog.pg_trigger_depth()<2 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF TG_OP='UPDATE' AND (ROW(NEW.studio_id,NEW.invoice_id,NEW.backend_pid,NEW.transaction_id)
        IS DISTINCT FROM ROW(OLD.studio_id,OLD.invoice_id,OLD.backend_pid,OLD.transaction_id)
        OR (OLD.may_initialize AND NOT NEW.may_initialize) OR (OLD.saw_known_transition AND NOT NEW.saw_known_transition)
        OR (OLD.saw_removal AND NOT NEW.saw_removal) OR (OLD.transition_reason IS NOT NULL AND NEW.transition_reason IS DISTINCT FROM OLD.transition_reason)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_invoice_episode_pending_identity_v1 BEFORE INSERT OR UPDATE ON private.workflow_invoice_episode_pending
    FOR EACH ROW EXECUTE FUNCTION private.workflow_invoice_episode_pending_identity_v1();

CREATE FUNCTION private.workflow_queue_invoice_episode_v1(p_studio_id UUID,p_invoice_id UUID,p_initialize BOOLEAN,p_transition BOOLEAN,p_removal BOOLEAN,p_reason TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_studio_id IS NULL OR p_invoice_id IS NULL OR pg_catalog.pg_trigger_depth()<1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SET CONSTRAINTS private.workflow_invoice_episode_deferred DEFERRED;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    IF EXISTS(SELECT 1 FROM public.billing_invoices WHERE id=p_invoice_id AND studio_id<>p_studio_id)
        OR EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE invoice_id=p_invoice_id AND studio_id<>p_studio_id)
        OR EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE invoice_id=p_invoice_id
            AND (studio_id<>p_studio_id OR backend_pid<>pg_catalog.pg_backend_pid() OR transaction_id<>pg_catalog.pg_current_xact_id())) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    INSERT INTO private.workflow_invoice_episode_pending(studio_id,invoice_id,backend_pid,transaction_id,may_initialize,saw_known_transition,saw_removal,transition_reason)
        VALUES(p_studio_id,p_invoice_id,pg_catalog.pg_backend_pid(),pg_catalog.pg_current_xact_id(),p_initialize,p_transition,p_removal,p_reason)
        ON CONFLICT(studio_id,invoice_id,backend_pid,transaction_id) DO UPDATE SET
            may_initialize=workflow_invoice_episode_pending.may_initialize OR EXCLUDED.may_initialize,
            saw_known_transition=workflow_invoice_episode_pending.saw_known_transition OR EXCLUDED.saw_known_transition,
            saw_removal=workflow_invoice_episode_pending.saw_removal OR EXCLUDED.saw_removal,
            transition_reason=coalesce(workflow_invoice_episode_pending.transition_reason,EXCLUDED.transition_reason);
END $$;

CREATE FUNCTION private.workflow_mark_invoice_episode_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE before JSONB; after JSONB; current_context JSONB; payer public.billing_payers; prior_payer public.billing_payers; changed BOOLEAN; reason TEXT;
BEGIN
    IF TG_OP='DELETE' THEN
        PERFORM private.workflow_queue_invoice_episode_v1(OLD.studio_id,OLD.id,false,true,true,'source_missing'); RETURN NULL;
    END IF;
    IF TG_OP='UPDATE' AND ROW(NEW.studio_id,NEW.id) IS DISTINCT FROM ROW(OLD.studio_id,OLD.id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT * INTO payer FROM public.billing_payers WHERE studio_id=NEW.studio_id AND id=NEW.payer_id;
    after:=private.workflow_invoice_episode_projection_v1(NEW,payer);
    IF TG_OP='INSERT' THEN
        PERFORM private.workflow_queue_invoice_episode_v1(NEW.studio_id,NEW.id,true,false,false,NULL); RETURN NULL;
    END IF;
    SELECT * INTO prior_payer FROM public.billing_payers WHERE studio_id=OLD.studio_id AND id=OLD.payer_id;
    before:=private.workflow_invoice_episode_projection_v1(OLD,prior_payer);
    IF NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE studio_id=NEW.studio_id AND invoice_id=NEW.id)
        AND NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE studio_id=NEW.studio_id AND invoice_id=NEW.id
            AND backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id() AND may_initialize) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT e.context INTO current_context FROM private.workflow_invoice_episode_state s
        JOIN private.workflow_invoice_collection_episodes e ON e.id=s.current_episode_id WHERE s.studio_id=NEW.studio_id AND s.invoice_id=NEW.id;
    -- A payer FK callback runs after its parent is gone. OLD therefore projects
    -- missing too; the retained active context still proves this known closure.
    IF before=after AND NOT (current_context IS NOT NULL AND (after->>'classification'='excluded'
        OR (after->>'classification'='open_positive' AND after->'context' IS DISTINCT FROM current_context))) THEN RETURN NULL; END IF;
    changed:=after->>'classification'='excluded' OR (before->>'classification'='excluded' AND after->>'classification'='open_positive')
        OR (after->>'classification'='open_positive' AND current_context IS NOT NULL AND current_context IS DISTINCT FROM after->'context')
        OR (before->>'classification'='open_positive' AND after->>'classification'='open_positive' AND before->'context' IS DISTINCT FROM after->'context');
    reason:=CASE WHEN changed THEN CASE WHEN after->>'classification'='excluded' THEN after->>'reason' ELSE 'source_context_changed' END END;
    PERFORM private.workflow_queue_invoice_episode_v1(NEW.studio_id,NEW.id,false,changed,false,reason);
    RETURN NULL;
END $$;

CREATE FUNCTION private.workflow_mark_payer_episode_demo_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE item RECORD;
BEGIN
    IF coalesce(OLD.metadata->'demo'='true'::JSONB,false)=coalesce(NEW.metadata->'demo'='true'::JSONB,false) THEN RETURN NULL; END IF;
    FOR item IN SELECT id FROM public.billing_invoices WHERE studio_id=NEW.studio_id AND payer_id=NEW.id ORDER BY id LOOP
        PERFORM private.workflow_queue_invoice_episode_v1(NEW.studio_id,item.id,false,true,false,
            CASE WHEN NEW.metadata->'demo'='true'::JSONB THEN 'demo_source' ELSE 'source_context_changed' END);
    END LOOP;
    RETURN NULL;
END $$;

CREATE FUNCTION private.workflow_finalize_invoice_episodes_v1() RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE item RECORD; invoice public.billing_invoices; payer public.billing_payers; state private.workflow_invoice_episode_state;
    episode private.workflow_invoice_collection_episodes; projection JSONB; decisions JSONB:='{}'; decision JSONB;
    workflows UUID[]; runs UUID[]; retired UUID[]:='{}'; at TIMESTAMPTZ; zone TEXT; boundary TIMESTAMPTZ; new_id UUID; reason TEXT; retire BOOLEAN;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id()) THEN RETURN; END IF;
    IF EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p JOIN private.workflow_invoice_episode_pending own USING(invoice_id)
        WHERE own.backend_pid=pg_catalog.pg_backend_pid() AND own.transaction_id=pg_catalog.pg_current_xact_id()
        AND (p.studio_id<>own.studio_id OR p.backend_pid<>own.backend_pid OR p.transaction_id<>own.transaction_id)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    FOR item IN SELECT DISTINCT studio_id FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY studio_id LOOP
        IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||item.studio_id::TEXT,0)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END IF;
    END LOOP;
    -- Complete source/reference ownership precedes the complete cancellation union.
    PERFORM 1 FROM public.studios s WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.studio_id=s.id
        AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY s.id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.billing_invoices i WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.invoice_id=i.id
        AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY i.id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.billing_payers y WHERE EXISTS(SELECT 1 FROM public.billing_invoices i JOIN private.workflow_invoice_episode_pending p ON p.invoice_id=i.id
        AND p.studio_id=i.studio_id WHERE i.payer_id=y.id AND i.studio_id=y.studio_id AND p.backend_pid=pg_catalog.pg_backend_pid()
        AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY y.id FOR SHARE NOWAIT;
    PERFORM 1 FROM private.workflow_invoice_episode_state s WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.invoice_id=s.invoice_id
        AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY s.invoice_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM private.workflow_invoice_collection_episodes e WHERE EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state s
        JOIN private.workflow_invoice_episode_pending p ON p.invoice_id=s.invoice_id WHERE s.current_episode_id=e.id AND p.backend_pid=pg_catalog.pg_backend_pid()
        AND p.transaction_id=pg_catalog.pg_current_xact_id()) ORDER BY e.id FOR UPDATE NOWAIT;
    FOR item IN SELECT * FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY invoice_id LOOP
        IF NOT EXISTS(SELECT 1 FROM public.studios WHERE id=item.studio_id) THEN CONTINUE; END IF;
        SELECT * INTO invoice FROM public.billing_invoices WHERE id=item.invoice_id;
        SELECT * INTO state FROM private.workflow_invoice_episode_state WHERE invoice_id=item.invoice_id;
        IF (invoice.id IS NOT NULL AND invoice.studio_id<>item.studio_id) OR (state.invoice_id IS NOT NULL AND state.studio_id<>item.studio_id)
            OR (state.invoice_id IS NULL AND NOT item.may_initialize) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        SELECT * INTO payer FROM public.billing_payers WHERE id=invoice.payer_id AND studio_id=item.studio_id;
        projection:=private.workflow_invoice_episode_projection_v1(invoice,payer);
        SELECT * INTO episode FROM private.workflow_invoice_collection_episodes WHERE id=state.current_episode_id;
        IF state.current_episode_id IS NOT NULL AND (episode.id IS NULL OR episode.closed_at IS NOT NULL) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        retire:=episode.id IS NOT NULL AND (item.saw_known_transition OR projection->>'classification'='excluded'
            OR (projection->>'classification'='open_positive' AND projection->'context' IS DISTINCT FROM episode.context));
        reason:=CASE WHEN projection->>'classification'='excluded' THEN projection->>'reason' ELSE 'source_context_changed' END;
        IF retire OR item.saw_known_transition THEN retired:=array_append(retired,item.invoice_id); END IF;
        decisions:=decisions||jsonb_build_object(item.invoice_id::TEXT,jsonb_build_object('projection',projection,'retire',retire,'reason',reason));
    END LOOP;
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]),coalesce(array_agg(DISTINCT r.id ORDER BY r.id),'{}'::UUID[])
        INTO workflows,runs FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.id=r.event_id AND e.studio_id=r.studio_id
        JOIN private.workflow_invoice_episode_pending p ON p.studio_id=e.studio_id AND p.invoice_id=e.subject_id
        WHERE p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id() AND p.invoice_id=ANY(retired)
        AND e.event_type='invoice.overdue' AND e.subject_kind='invoice' AND r.state IN ('queued','waiting','claimed','running','sending','unknown');
    PERFORM 1 FROM public.automation_workflows WHERE id=ANY(workflows) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_workflow_runs WHERE id=ANY(runs) ORDER BY id FOR UPDATE NOWAIT;
    at:=clock_timestamp();
    -- No additional parent acquisition is permitted below this final clock.
    FOR item IN SELECT * FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid()
        AND transaction_id=pg_catalog.pg_current_xact_id() ORDER BY invoice_id LOOP
        decision:=decisions->item.invoice_id::TEXT;
        IF decision IS NULL THEN CONTINUE; END IF;
        projection:=decision->'projection'; reason:=decision->>'reason';
        SELECT * INTO state FROM private.workflow_invoice_episode_state WHERE invoice_id=item.invoice_id;
        IF state.invoice_id IS NULL THEN
            INSERT INTO private.workflow_invoice_episode_state(invoice_id,studio_id,updated_at) VALUES(item.invoice_id,item.studio_id,at) RETURNING * INTO state;
        END IF;
        IF (decision->>'retire')::BOOLEAN THEN
            UPDATE private.workflow_invoice_collection_episodes SET closed_at=at,close_reason=reason WHERE id=state.current_episode_id;
            UPDATE private.workflow_invoice_episode_state SET current_episode_id=NULL,updated_at=at WHERE invoice_id=item.invoice_id RETURNING * INTO state;
        END IF;
        IF item.invoice_id=ANY(retired) THEN
            PERFORM private.workflow_cancel_runs_v1(item.studio_id,ARRAY(SELECT r.id FROM public.automation_workflow_runs r
                JOIN private.automation_workflow_events e ON e.id=r.event_id AND e.studio_id=r.studio_id WHERE r.id=ANY(runs)
                AND e.studio_id=item.studio_id AND e.subject_id=item.invoice_id ORDER BY r.id),at,reason);
        END IF;
        IF state.current_episode_id IS NULL AND projection->>'classification'='open_positive' THEN
            IF state.episode_number=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone) THEN s.timezone ELSE 'UTC' END
                INTO zone FROM public.studios s WHERE s.id=item.studio_id;
            boundary:=private.workflow_invoice_episode_threshold_v1((projection#>>'{context,due_date}')::DATE,zone); new_id:=gen_random_uuid();
            INSERT INTO private.workflow_invoice_collection_episodes(id,studio_id,invoice_id,episode_number,context,opened_at,frozen_timezone,threshold_at,threshold_eligible)
                VALUES(new_id,item.studio_id,item.invoice_id,state.episode_number+1,projection->'context',at,zone,boundary,
                    coalesce(boundary IS NOT NULL AND at<=boundary AND (at AT TIME ZONE zone)::DATE<=(projection#>>'{context,due_date}')::DATE,false));
            UPDATE private.workflow_invoice_episode_state SET episode_number=episode_number+1,current_episode_id=new_id,updated_at=at WHERE invoice_id=item.invoice_id;
        END IF;
        UPDATE private.workflow_invoice_episode_state SET ever_removed=ever_removed OR item.saw_removal,updated_at=at WHERE invoice_id=item.invoice_id;
    END LOOP;
    DELETE FROM private.workflow_invoice_episode_pending WHERE backend_pid=pg_catalog.pg_backend_pid() AND transaction_id=pg_catalog.pg_current_xact_id();
END $$;

CREATE FUNCTION private.workflow_finalize_invoice_episode_deferred_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending WHERE studio_id=NEW.studio_id AND invoice_id=NEW.invoice_id
        AND backend_pid=NEW.backend_pid AND transaction_id=NEW.transaction_id) THEN RETURN NULL; END IF;
    IF NEW.backend_pid<>pg_catalog.pg_backend_pid() OR NEW.transaction_id<>pg_catalog.pg_current_xact_id() THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    PERFORM private.workflow_finalize_invoice_episodes_v1(); RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_invoice_episode_deferred AFTER INSERT OR UPDATE ON private.workflow_invoice_episode_pending
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.workflow_finalize_invoice_episode_deferred_v1();
CREATE TRIGGER workflow_mark_invoice_episode_v1 AFTER INSERT OR UPDATE OR DELETE ON public.billing_invoices
    FOR EACH ROW EXECUTE FUNCTION private.workflow_mark_invoice_episode_v1();
CREATE TRIGGER workflow_mark_payer_episode_demo_v1 AFTER UPDATE OF metadata ON public.billing_payers
    FOR EACH ROW EXECUTE FUNCTION private.workflow_mark_payer_episode_demo_v1();
DO $invoice_episode_privileges$
DECLARE item RECORD;
BEGIN
    FOR item IN SELECT c.oid::REGCLASS identity,c.relname name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='private' AND c.relname IN ('workflow_invoice_episode_state','workflow_invoice_collection_episodes','workflow_invoice_episode_pending') LOOP
        EXECUTE format('ALTER TABLE %s OWNER TO postgres',item.identity);
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.identity);
        EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,anon,authenticated,service_role',item.identity);
        EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE %s TO service_role',item.identity);
    END LOOP;
    GRANT DELETE ON private.workflow_invoice_episode_pending TO service_role;
    FOR item IN SELECT p.oid::REGPROCEDURE identity,p.proname name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname IN ('workflow_invoice_episode_context_valid_v1','workflow_invoice_episode_projection_v1',
            'workflow_invoice_episode_threshold_v1','workflow_invoice_episode_state_identity_v1','workflow_invoice_episode_identity_v1',
            'workflow_invoice_episode_pending_identity_v1','workflow_queue_invoice_episode_v1','workflow_mark_invoice_episode_v1',
            'workflow_mark_payer_episode_demo_v1','workflow_finalize_invoice_episodes_v1','workflow_finalize_invoice_episode_deferred_v1') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',item.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',item.identity);
        IF item.name IN ('workflow_invoice_episode_context_valid_v1','workflow_invoice_episode_projection_v1','workflow_invoice_episode_threshold_v1',
            'workflow_queue_invoice_episode_v1','workflow_finalize_invoice_episodes_v1') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',item.identity); END IF;
    END LOOP;
END $invoice_episode_privileges$;

CREATE TABLE private.automation_workflow_dispatch_cursor (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    last_studio_id UUID,
    updated_at TIMESTAMPTZ NOT NULL CHECK (isfinite(updated_at))
);
INSERT INTO private.automation_workflow_dispatch_cursor(singleton,updated_at) VALUES(true,clock_timestamp());
CREATE INDEX automation_workflow_runs_studio_due ON public.automation_workflow_runs(studio_id,next_due_at,created_at,id)
    WHERE state IN ('queued','waiting','claimed','running');
CREATE TABLE private.automation_workflow_follow_up_actions (
    studio_id UUID NOT NULL,
    run_id UUID NOT NULL,
    step_id UUID NOT NULL,
    node_id TEXT NOT NULL,
    lead_id UUID NOT NULL,
    activity_id UUID NOT NULL UNIQUE,
    previous_due_date DATE CHECK (previous_due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
    due_date DATE NOT NULL CHECK (due_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
    created_at TIMESTAMPTZ NOT NULL CHECK (created_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    PRIMARY KEY(run_id,node_id),
    FOREIGN KEY(studio_id,run_id,step_id,node_id)
        REFERENCES private.automation_workflow_run_steps(studio_id,run_id,id,node_id) ON DELETE CASCADE
);
CREATE FUNCTION private.workflow_delay_due_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF OLD.node_type='delay' AND OLD.scheduled_at IS NOT NULL AND NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_delay_due_identity BEFORE UPDATE ON private.automation_workflow_run_steps
    FOR EACH ROW EXECUTE FUNCTION private.workflow_delay_due_identity_v1();
CREATE FUNCTION private.workflow_follow_up_receipt_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_event private.automation_workflow_events; v_kind TEXT;
BEGIN
    SELECT s.node_type INTO v_kind FROM private.automation_workflow_run_steps s
        WHERE s.studio_id=NEW.studio_id AND s.run_id=NEW.run_id AND s.id=NEW.step_id AND s.node_id=NEW.node_id;
    SELECT e.* INTO v_event FROM private.automation_workflow_run_steps s
        JOIN public.automation_workflow_runs r ON r.studio_id=s.studio_id AND r.id=s.run_id
        JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE s.studio_id=NEW.studio_id AND s.run_id=NEW.run_id AND s.id=NEW.step_id AND s.node_id=NEW.node_id;
    IF NOT FOUND THEN RETURN NEW; END IF; -- Composite FK owns absent-parent rejection.
    IF v_kind<>'lead_follow_up' OR ((
        (v_event.event_type IN ('lead.created','lead.stage_changed') AND v_event.subject_id=NEW.lead_id)
        OR (v_event.event_type LIKE 'trial.%' AND v_event.context->'lead_id'=to_jsonb(NEW.lead_id))) IS DISTINCT FROM true) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_workflow_follow_up_receipt_identity BEFORE INSERT ON private.automation_workflow_follow_up_actions
    FOR EACH ROW EXECUTE FUNCTION private.workflow_follow_up_receipt_identity_v1();
CREATE TRIGGER automation_workflow_follow_up_receipt_immutable BEFORE UPDATE ON private.automation_workflow_follow_up_actions
    FOR EACH ROW EXECUTE FUNCTION private.workflow_immutable_record_v1();

CREATE FUNCTION private.workflow_run_position_v1(p_run public.automation_workflow_runs) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('state',p_run.state,'current_node_id',p_run.current_node_id,
        'next_due_at',private.automation_utc_text_v1(p_run.next_due_at),'reason',p_run.reason)
$$;
CREATE FUNCTION private.workflow_condition_result_v1(p_field TEXT,p_operator TEXT,p_expected JSONB,p_actual JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE meta JSONB:=private.workflow_catalog_v1()#>ARRAY['fields',p_field]; item JSONB; normalized JSONB:='[]';
    values_to_check JSONB; actual JSONB; scalar TEXT; ordinal INTEGER:=0; expected_count INTEGER; valid BOOLEAN; matched BOOLEAN;
BEGIN
    IF meta IS NULL OR p_operator IS NULL OR NOT meta->'operators' ? p_operator OR p_expected IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF p_operator IN ('in','not_in') THEN
        IF jsonb_typeof(p_expected) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        expected_count:=jsonb_array_length(p_expected);
        IF expected_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
        values_to_check:=p_expected;
    ELSE expected_count:=1; values_to_check:=jsonb_build_array(p_expected); END IF;
    -- Validate immutable expected values even when actual is missing. UUID normalization
    -- matches Python UUID's string form, including braces, URNs and unhyphenated hex.
    values_to_check:=values_to_check||jsonb_build_array(p_actual);
    FOR item IN SELECT value FROM jsonb_array_elements(values_to_check) LOOP
        ordinal:=ordinal+1; valid:=false;
        IF item='null'::JSONB THEN
            valid:=coalesce((meta->>'nullable')::BOOLEAN,false) AND (ordinal>expected_count OR p_operator IN ('eq','neq'));
        ELSIF meta->>'value_type'='uuid' AND jsonb_typeof(item)='string' AND length(item#>>'{}')<=500 THEN
            scalar:=replace(btrim(replace(replace(item#>>'{}','urn:',''),'uuid:',''),'{}'),'-','');
            valid:=scalar ~* '^[0-9a-f]{32}$';
            IF valid THEN item:=to_jsonb(scalar::UUID); END IF;
        ELSE valid:=coalesce(private.workflow_typed_value_v1(item,meta),false); END IF;
        IF ordinal<=expected_count THEN
            IF NOT valid THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
            normalized:=normalized||jsonb_build_array(item);
        ELSE
            IF p_actual IS NULL OR NOT valid THEN RETURN NULL; END IF;
            actual:=item;
        END IF;
    END LOOP;
    IF p_operator IN ('eq','neq') THEN
        matched:=actual=normalized->0;
        RETURN CASE WHEN p_operator='eq' THEN matched ELSE NOT matched END;
    END IF;
    IF actual='null'::JSONB THEN RETURN false; END IF;
    matched:=normalized @> jsonb_build_array(actual);
    RETURN CASE WHEN p_operator='in' THEN matched ELSE NOT matched END;
END $$;

-- Caller already owns clear, studio and subscription. No source acquisition may
-- follow this owner. Discovery reads identify exact parents; locked facts decide.
CREATE FUNCTION private.workflow_lock_run_sources_v1(p_studio_id UUID,p_event private.automation_workflow_events,p_trigger_config JSONB)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_lead public.leads; v_trial public.lead_trial_appointments; v_student public.students; v_promotion public.promotions;
    v_recipient public.belt_test_recipients; v_event public.belt_test_events; v_membership public.student_program_memberships;
    v_student_id UUID; v_membership_id UUID; v_program UUID; v_rank UUID; v_ladder UUID; v_invoice UUID;
    v_program_ids UUID[]:='{}'; v_rank_ids UUID[]:='{}'; filter_id UUID:=(p_trigger_config->>'program_id')::UUID;
BEGIN
    IF p_event.event_type LIKE 'invoice.%' THEN
        IF p_event.event_type='invoice.payment_failed' THEN
            SELECT invoice_id INTO v_invoice FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR UPDATE NOWAIT;
        ELSE v_invoice:=p_event.subject_id; END IF;
        PERFORM private.workflow_prepare_financial_context_v1(p_studio_id,v_invoice,
            CASE WHEN p_event.event_type='invoice.payment_failed' THEN p_event.subject_id END);
        RETURN;
    END IF;
    IF p_event.event_type LIKE 'lead.%' OR p_event.event_type LIKE 'trial.%' THEN
        IF p_event.event_type LIKE 'trial.%' THEN
            SELECT * INTO v_trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_event.subject_id;
            SELECT * INTO v_lead FROM public.leads WHERE studio_id=p_studio_id AND id=v_trial.lead_id FOR UPDATE NOWAIT;
            SELECT * INTO v_trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR SHARE NOWAIT;
            v_program_ids:=array_append(v_program_ids,v_trial.program_id);
        ELSE
            SELECT * INTO v_lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR UPDATE NOWAIT;
        END IF;
        v_program_ids:=v_program_ids||ARRAY[v_lead.program_id,filter_id];
        PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=ANY(v_program_ids) ORDER BY id FOR SHARE NOWAIT;
        RETURN;
    END IF;
    IF p_event.event_type LIKE 'belt_test.%' THEN
        SELECT * INTO v_recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_event.subject_id;
        SELECT * INTO v_event FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=v_recipient.event_id FOR SHARE NOWAIT;
        v_student_id:=v_recipient.student_id; v_membership_id:=v_recipient.student_program_membership_id;
        v_program_ids:=ARRAY[v_event.program_id,v_recipient.approved_program_id,filter_id];
        v_rank_ids:=ARRAY[v_recipient.approved_current_rank_id,v_recipient.approved_target_rank_id]; v_ladder:=v_event.ladder_id;
    ELSIF p_event.event_type='student.promoted' THEN
        SELECT * INTO v_promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_event.subject_id;
        v_student_id:=v_promotion.student_id; v_membership_id:=v_promotion.command_membership_id;
        v_program_ids:=ARRAY[v_promotion.command_program_id,filter_id]; v_rank_ids:=ARRAY[v_promotion.to_rank_id,v_promotion.command_from_rank_id];
        SELECT ladder_id INTO v_ladder FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=v_promotion.to_rank_id;
    ELSE v_student_id:=p_event.subject_id; END IF;
    SELECT * INTO v_student FROM public.students WHERE studio_id=p_studio_id AND id=v_student_id FOR UPDATE NOWAIT;
    IF p_event.event_type='student.enrolled' THEN
        IF filter_id IS NOT NULL THEN
            PERFORM 1 FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=v_student_id
                AND program_id=filter_id ORDER BY id FOR SHARE NOWAIT;
            PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=filter_id FOR SHARE NOWAIT;
        END IF;
        RETURN;
    END IF;
    -- Legacy rank authority depends on absence of a live membership. Own existing
    -- rows, including ended ones; student ownership also excludes callback writers.
    PERFORM 1 FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=v_student_id
        AND (v_membership_id IS NULL OR id=v_membership_id) ORDER BY id FOR SHARE NOWAIT;
    SELECT * INTO v_membership FROM public.student_program_memberships WHERE studio_id=p_studio_id
        AND student_id=v_student_id AND id=v_membership_id;
    v_program:=CASE WHEN v_membership_id IS NULL THEN v_student.program_id ELSE v_membership.program_id END;
    v_rank:=CASE WHEN v_membership_id IS NULL THEN v_student.current_belt_rank_id ELSE v_membership.current_belt_rank_id END;
    v_program_ids:=array_append(v_program_ids,v_program); v_rank_ids:=array_append(v_rank_ids,v_rank);
    PERFORM 1 FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=v_ladder FOR SHARE NOWAIT;
    PERFORM 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=ANY(v_rank_ids) ORDER BY id FOR SHARE NOWAIT;
    IF p_event.event_type='student.promoted' AND EXISTS(SELECT 1 FROM public.belt_ranks
        WHERE studio_id=p_studio_id AND id=v_promotion.to_rank_id AND ladder_id IS DISTINCT FROM v_ladder) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=ANY(v_program_ids) ORDER BY id FOR SHARE NOWAIT;
    IF p_event.event_type LIKE 'belt_test.%' THEN
        PERFORM 1 FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR SHARE NOWAIT;
    ELSE PERFORM 1 FROM public.promotions WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR SHARE NOWAIT; END IF;
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_defer_owned_run_v1(p_studio_id UUID,p_run_id UUID,p_at TIMESTAMPTZ,p_reason TEXT)
RETURNS public.automation_workflow_runs LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_run public.automation_workflow_runs; due TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
    IF v_run.id IS NULL OR v_run.state NOT IN ('claimed','running') OR v_run.cancel_requested_at IS NOT NULL
        OR v_run.revision=9223372036854775807 OR p_at IS NULL OR NOT isfinite(p_at)
        OR p_reason IS NULL OR p_reason NOT IN ('facts_unavailable','subscription_required','sender_unavailable') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    due:=p_at+make_interval(secs=>least(3600,60*(1<<v_run.deferral_count)));
    IF due NOT BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    UPDATE public.automation_workflow_runs SET state='waiting',claim_token=NULL,lease_expires_at=NULL,
        next_due_at=due,reason=p_reason,deferral_count=least(7,deferral_count+1),revision=revision+1,updated_at=p_at
        WHERE studio_id=p_studio_id AND id=p_run_id RETURNING * INTO v_run;
    RETURN v_run;
END $$;
CREATE FUNCTION private.workflow_apply_lead_follow_up_v1(
    p_studio_id UUID,p_run_id UUID,p_step_id UUID,p_node_id TEXT,p_lead_id UUID,p_config JSONB,p_at TIMESTAMPTZ
) RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_lead public.leads; zone TEXT; due DATE; activity UUID:=gen_random_uuid(); previous DATE;
BEGIN
    IF EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE studio_id=p_studio_id AND run_id=p_run_id AND node_id=p_node_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT * INTO v_lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_lead_id;
    IF v_lead.id IS NULL OR v_lead.converted_student_id IS NOT NULL OR v_lead.stage NOT IN ('inquiry','trial_scheduled','trial_completed','offer_sent') THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone) THEN s.timezone ELSE 'UTC' END
        INTO zone FROM public.studios s WHERE id=p_studio_id;
    previous:=v_lead.follow_up_date;
    due:=(p_at AT TIME ZONE zone)::DATE+(p_config->>'due_in_days')::INTEGER;
    IF (previous IS NOT NULL AND previous NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
        OR due NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN
        RAISE EXCEPTION USING ERRCODE='P57F1',MESSAGE='AUTOMATION_FACTS_UNAVAILABLE';
    END IF;
    due:=least(previous,due);
    UPDATE public.leads SET follow_up_date=due WHERE studio_id=p_studio_id AND id=p_lead_id AND follow_up_date IS DISTINCT FROM due;
    INSERT INTO public.lead_activities(id,studio_id,lead_id,activity_type,description,created_by,created_at)
        VALUES(activity,p_studio_id,p_lead_id,'note','Automation follow-up due '||to_char(due,'YYYY-MM-DD')||'.'
            ||CASE WHEN coalesce(p_config->>'note','')<>'' THEN ' '||(p_config->>'note') ELSE '' END,NULL,p_at);
    INSERT INTO private.automation_workflow_follow_up_actions(studio_id,run_id,step_id,node_id,lead_id,activity_id,previous_due_date,due_date,created_at)
        VALUES(p_studio_id,p_run_id,p_step_id,p_node_id,p_lead_id,activity,previous,due,p_at);
EXCEPTION WHEN datetime_field_overflow THEN
    RAISE EXCEPTION USING ERRCODE='P57F1',MESSAGE='AUTOMATION_FACTS_UNAVAILABLE';
END $$;

CREATE FUNCTION public.claim_automation_workflow_runs_v1(p_limit INTEGER DEFAULT 10) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE cursor_row private.automation_workflow_dispatch_cursor; v_run public.automation_workflow_runs;
    claims JSONB:='[]'; at TIMESTAMPTZ; last_studio UUID; token UUID; more BOOLEAN; i INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    PERFORM private.workflow_expire_email_attempts_v1(100);
    SELECT * INTO cursor_row FROM private.automation_workflow_dispatch_cursor WHERE singleton FOR UPDATE SKIP LOCKED;
    IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_dispatch_cursor WHERE singleton) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    last_studio:=cursor_row.last_studio_id;
    IF cursor_row.singleton THEN
        FOR i IN 1..p_limit LOOP
            at:=clock_timestamp();
            -- Two ordered range scans wrap once. A busy run is skipped inside the
            -- index scan, without acquiring a workflow or source parent.
            SELECT * INTO v_run FROM public.automation_workflow_runs r WHERE r.state IN ('queued','waiting','claimed','running')
                AND r.cancel_requested_at IS NULL AND r.next_due_at<=at AND (last_studio IS NULL OR r.studio_id>last_studio)
                AND (r.state IN ('queued','waiting') OR r.lease_expires_at<=at)
                ORDER BY r.studio_id,r.next_due_at,r.created_at,r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
            IF NOT FOUND AND last_studio IS NOT NULL THEN
                SELECT * INTO v_run FROM public.automation_workflow_runs r WHERE r.state IN ('queued','waiting','claimed','running')
                    AND r.cancel_requested_at IS NULL AND r.next_due_at<=at AND r.studio_id<=last_studio
                    AND (r.state IN ('queued','waiting') OR r.lease_expires_at<=at)
                    ORDER BY r.studio_id,r.next_due_at,r.created_at,r.id LIMIT 1 FOR UPDATE SKIP LOCKED;
            END IF;
            EXIT WHEN v_run.id IS NULL;
            IF v_run.revision=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            at:=clock_timestamp(); token:=gen_random_uuid();
            UPDATE public.automation_workflow_runs SET state='claimed',claim_token=token,lease_expires_at=at+INTERVAL '60 seconds',
                revision=revision+1,updated_at=at WHERE studio_id=v_run.studio_id AND id=v_run.id RETURNING * INTO v_run;
            last_studio:=v_run.studio_id;
            UPDATE private.automation_workflow_dispatch_cursor SET last_studio_id=last_studio,updated_at=at WHERE singleton;
            claims:=claims||jsonb_build_array(jsonb_build_object('studio_id',v_run.studio_id,'run_id',v_run.id,
                'claim_token',token,'lease_expires_at',private.automation_utc_text_v1(v_run.lease_expires_at)));
        END LOOP;
    END IF;
    at:=clock_timestamp();
    SELECT EXISTS(SELECT 1 FROM public.automation_workflow_runs r WHERE r.state IN ('queued','waiting','claimed','running')
        AND r.cancel_requested_at IS NULL AND r.next_due_at<=at AND (r.state IN ('queued','waiting') OR r.lease_expires_at<=at)) INTO more;
    RETURN jsonb_build_object('payload',jsonb_build_object('claims',claims,'has_more',more));
END $$;

-- One transition owner keeps defer and advance's source, final-clock and lost-lease
-- semantics identical. The exception block also rolls back financial preparation.
CREATE FUNCTION private.workflow_transition_owned_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_step_limit INTEGER,p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
<<transition>>
DECLARE v_run public.automation_workflow_runs; original public.automation_workflow_runs; v_workflow public.automation_workflows;
    v_event private.automation_workflow_events; v_activation public.automation_workflow_activations;
    v_version public.automation_workflow_versions; step private.automation_workflow_run_steps; prior private.automation_workflow_run_steps;
    graph JSONB; trigger_config JSONB; node JSONB; edge JSONB; facts JSONB; value JSONB; result JSONB;
    at TIMESTAMPTZ; due TIMESTAMPTZ; anchor TIMESTAMPTZ; reason TEXT; outcome TEXT:='lease_lost'; port TEXT;
    count_steps INTEGER; max_sequence INTEGER; visit INTEGER; matched BOOLEAN; inserted BOOLEAN; lead_id UUID;
BEGIN
    IF p_studio_id IS NULL OR p_run_id IS NULL OR p_claim_token IS NULL OR p_step_limit IS NULL OR p_step_limit NOT BETWEEN 1 AND 10
        OR (p_reason IS NOT NULL AND p_reason NOT IN ('facts_unavailable','subscription_required','sender_unavailable')) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    result:=jsonb_build_object('studio_id',p_studio_id,'run_id',p_run_id,'claim_token',p_claim_token);
    SELECT * INTO original FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
    IF original.id IS NULL OR original.state NOT IN ('claimed','running') OR original.claim_token IS DISTINCT FROM p_claim_token
        OR original.lease_expires_at<=clock_timestamp() THEN
        RETURN jsonb_build_object('payload',result||jsonb_build_object('outcome','lease_lost','run',NULL));
    END IF;
    SELECT * INTO v_event FROM private.automation_workflow_events WHERE studio_id=p_studio_id AND id=original.event_id;
    SELECT * INTO v_version FROM public.automation_workflow_versions WHERE studio_id=p_studio_id AND workflow_id=original.workflow_id AND id=original.version_id;
    graph:=v_version.graph;
    IF v_event.id IS NULL OR graph IS NULL OR private.workflow_validate_v1(graph,'{}',true) IS DISTINCT FROM '[]'::JSONB
        OR private.workflow_hash_v1(graph) IS DISTINCT FROM v_version.graph_sha256 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT n->'config' INTO trigger_config FROM jsonb_array_elements(graph->'nodes') n WHERE n->>'type'='trigger';
    trigger_config:=jsonb_build_object('program_id',NULL)||trigger_config;
    IF trigger_config->>'event_type' IS DISTINCT FROM v_event.event_type
        OR private.workflow_catalog_v1()#>>ARRAY['triggers',v_event.event_type,'subject_kind'] IS DISTINCT FROM v_event.subject_kind THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.studio_subscriptions WHERE studio_id=p_studio_id FOR SHARE NOWAIT;
    PERFORM private.workflow_lock_run_sources_v1(p_studio_id,v_event,trigger_config);
    SELECT * INTO v_workflow FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=original.workflow_id FOR UPDATE NOWAIT;
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id FOR UPDATE NOWAIT;
    at:=clock_timestamp();
    -- Preparation may validly cancel its own failed-payment run and clear its
    -- token. Return that committed terminal truth before checking executable lease.
    IF v_run.cancel_requested_at IS NOT NULL AND v_run.state IN ('completed','cancelled','failed','unknown') THEN
        RETURN jsonb_build_object('payload',result||jsonb_build_object('outcome','stopped','run',private.workflow_run_position_v1(v_run)));
    END IF;
    IF v_run.id IS NULL OR v_run.state NOT IN ('claimed','running') OR v_run.claim_token IS DISTINCT FROM p_claim_token
        OR v_run.lease_expires_at<=at THEN RAISE EXCEPTION USING ERRCODE='P57L1'; END IF;
    IF v_workflow.id IS NULL OR ROW(v_run.workflow_id,v_run.version_id,v_run.event_id,v_run.activation_id,v_run.epoch)
        IS DISTINCT FROM ROW(original.workflow_id,original.version_id,original.event_id,original.activation_id,original.epoch) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT * INTO v_activation FROM public.automation_workflow_activations WHERE studio_id=p_studio_id
        AND workflow_id=v_run.workflow_id AND version_id=v_run.version_id AND epoch=v_run.epoch AND id=v_run.activation_id;
    IF v_activation.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    reason:=CASE WHEN v_workflow.status='paused' THEN 'workflow_paused' WHEN v_workflow.status='archived' THEN 'workflow_archived'
        WHEN v_workflow.status<>'active' OR v_activation.cancelled_at IS NOT NULL OR v_run.epoch<>v_workflow.enrollment_epoch THEN 'workflow_republished' END;
    IF v_run.cancel_requested_at IS NOT NULL THEN reason:=v_run.cancel_reason; END IF;
    IF reason IS NOT NULL THEN
        PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY[p_run_id],at,reason);
        SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
        RETURN jsonb_build_object('payload',result||jsonb_build_object('outcome','stopped','run',private.workflow_run_position_v1(v_run)));
    END IF;
    FOR visit IN 1..p_step_limit LOOP
        at:=clock_timestamp();
        IF v_run.lease_expires_at<=at THEN RAISE EXCEPTION USING ERRCODE='P57L1'; END IF;
        SELECT n INTO node FROM jsonb_array_elements(graph->'nodes') n WHERE n->>'id'=v_run.current_node_id;
        IF node IS NULL OR v_run.revision=9223372036854775807 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        -- Separate statement after every parent/target lock and at each reached node.
        SELECT private.workflow_current_source_facts_v1(p_studio_id,v_event.event_type,v_event.subject_id,v_event.context,trigger_config,at,'{}') INTO value;
        facts:=value->'facts';
        IF facts->>'source_decision'='ineligible' THEN
            PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY[p_run_id],at,facts->>'source_reason');
            SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
            outcome:='stopped'; EXIT;
        END IF;
        IF v_event.event_type='invoice.overdue' AND EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p
            WHERE p.studio_id=p_studio_id AND p.invoice_id=v_event.subject_id AND p.backend_pid=pg_catalog.pg_backend_pid()
                AND p.transaction_id=pg_catalog.pg_current_xact_id()) THEN
            v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,at,'facts_unavailable');
            outcome:='waiting'; EXIT;
        END IF;
        reason:=CASE WHEN facts->>'source_decision' IS DISTINCT FROM 'eligible' THEN 'facts_unavailable'
            WHEN NOT private.automation_core_entitled(p_studio_id) THEN 'subscription_required' ELSE p_reason END;
        IF reason IS NOT NULL THEN
            v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,at,reason); outcome:='waiting'; EXIT;
        END IF;
        SELECT count(*),coalesce(max(sequence),0) INTO count_steps,max_sequence FROM private.automation_workflow_run_steps WHERE studio_id=p_studio_id AND run_id=p_run_id;
        SELECT * INTO step FROM private.automation_workflow_run_steps WHERE studio_id=p_studio_id AND run_id=p_run_id AND node_id=v_run.current_node_id;
        IF count_steps<>max_sequence OR count_steps>40 OR (step.id IS NOT NULL AND (step.sequence<>max_sequence OR step.finished_at IS NOT NULL)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        IF EXISTS(SELECT 1 FROM private.automation_workflow_run_steps s LEFT JOIN private.automation_workflow_run_steps previous
            ON previous.run_id=s.run_id AND previous.sequence=s.sequence-1 WHERE s.studio_id=p_studio_id AND s.run_id=p_run_id
            AND ((s.sequence=1 AND s.node_type<>'trigger') OR (s.sequence>1 AND (previous.finished_at IS NULL OR NOT EXISTS(
                SELECT 1 FROM jsonb_array_elements(graph->'edges') e WHERE e->>'id'=previous.edge_id
                    AND e->>'source'=previous.node_id AND e->>'target'=s.node_id)))
                OR (s.sequence<max_sequence AND s.finished_at IS NULL))) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        inserted:=step.id IS NULL;
        IF inserted THEN
            IF count_steps=40 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            IF count_steps=0 THEN
                IF node->>'type'<>'trigger' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
            ELSE
                SELECT * INTO prior FROM private.automation_workflow_run_steps WHERE studio_id=p_studio_id AND run_id=p_run_id AND sequence=max_sequence;
                IF prior.finished_at IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(graph->'edges') e
                    WHERE e->>'id'=prior.edge_id AND e->>'source'=prior.node_id AND e->>'target'=v_run.current_node_id) THEN
                    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
                END IF;
            END IF;
            INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at)
                VALUES(p_studio_id,p_run_id,count_steps+1,v_run.current_node_id,node->>'type','entered',at) RETURNING * INTO step;
        END IF;
        IF step.entered_at>at OR step.node_type IS DISTINCT FROM node->>'type' OR step.outcome NOT IN ('entered','waiting') THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        port:='next'; reason:=NULL; due:=NULL; outcome:='continue';
        CASE node->>'type'
        WHEN 'condition' THEN
            matched:=private.workflow_condition_result_v1(node#>>'{config,field}',node#>>'{config,operator}',node#>'{config,value}',facts->'condition_facts'->(node#>>'{config,field}'));
            IF matched IS NULL THEN reason:='facts_unavailable'; ELSE port:=CASE WHEN matched THEN 'yes' ELSE 'no' END; END IF;
        WHEN 'delay' THEN
            due:=step.scheduled_at;
            IF due IS NULL THEN
                BEGIN
                    IF node#>>'{config,mode}'='duration' THEN
                        due:=step.entered_at+make_interval(mins=>(node#>>'{config,minutes}')::INTEGER);
                    ELSE
                        value:=facts->'anchors'->(node#>>'{config,field}');
                        IF value IS NOT NULL AND value<>'null'::JSONB THEN
                            anchor:=private.automation_instant_v1(value);
                            due:=anchor+make_interval(mins=>(node#>>'{config,offset_minutes}')::INTEGER);
                        END IF;
                    END IF;
                EXCEPTION WHEN datetime_field_overflow OR invalid_parameter_value THEN due:=NULL;
                END;
                IF due NOT BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' THEN due:=NULL; END IF;
                IF due IS NOT NULL THEN UPDATE private.automation_workflow_run_steps SET scheduled_at=due WHERE id=step.id; END IF;
            END IF;
            IF due IS NULL THEN reason:='facts_unavailable';
            ELSIF due>at THEN
                UPDATE private.automation_workflow_run_steps SET outcome='waiting',reason=NULL WHERE id=step.id;
                UPDATE public.automation_workflow_runs SET state='waiting',claim_token=NULL,lease_expires_at=NULL,next_due_at=due,
                    reason=NULL,revision=revision+1,updated_at=at WHERE studio_id=p_studio_id AND id=p_run_id RETURNING * INTO v_run;
                outcome:='waiting'; EXIT;
            END IF;
        WHEN 'email' THEN
            IF inserted OR step.outcome<>'entered' OR step.reason IS NOT NULL THEN
                UPDATE private.automation_workflow_run_steps SET outcome='entered',reason=NULL WHERE id=step.id;
                UPDATE public.automation_workflow_runs SET state='running',revision=revision+1,updated_at=at,reason=NULL
                    WHERE studio_id=p_studio_id AND id=p_run_id RETURNING * INTO v_run;
            END IF;
            outcome:='email'; EXIT;
        WHEN 'lead_follow_up' THEN
            lead_id:=CASE WHEN v_event.subject_kind='lead' THEN v_event.subject_id ELSE (v_event.context->>'lead_id')::UUID END;
            BEGIN
                PERFORM private.workflow_apply_lead_follow_up_v1(p_studio_id,p_run_id,step.id,step.node_id,lead_id,node->'config',at);
            EXCEPTION WHEN SQLSTATE 'P57F1' THEN reason:='facts_unavailable';
            END;
        WHEN 'trigger' THEN NULL;
        WHEN 'end' THEN NULL;
        ELSE RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END CASE;
        IF reason IS NOT NULL THEN
            UPDATE private.automation_workflow_run_steps SET outcome='waiting',reason=transition.reason WHERE id=step.id;
            v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,at,reason); outcome:='waiting'; EXIT;
        END IF;
        edge:=NULL;
        IF node->>'type'<>'end' THEN
            SELECT e INTO edge FROM jsonb_array_elements(graph->'edges') e WHERE e->>'source'=step.node_id AND e->>'port'=port;
            IF edge IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
        END IF;
        UPDATE private.automation_workflow_run_steps SET outcome=CASE WHEN node->>'type'='condition' THEN CASE WHEN matched THEN 'matched' ELSE 'not_matched' END ELSE 'completed' END,
            edge_id=edge->>'id',reason=NULL,finished_at=at WHERE id=step.id;
        UPDATE public.automation_workflow_runs SET current_node_id=coalesce(edge->>'target',current_node_id),
            state=CASE WHEN edge IS NULL THEN 'completed' ELSE 'running' END,next_due_at=CASE WHEN edge IS NOT NULL THEN at END,
            claim_token=CASE WHEN edge IS NOT NULL THEN claim_token END,lease_expires_at=CASE WHEN edge IS NOT NULL THEN lease_expires_at END,
            reason=NULL,deferral_count=0,revision=revision+1,updated_at=at WHERE studio_id=p_studio_id AND id=p_run_id RETURNING * INTO v_run;
        IF edge IS NULL THEN outcome:='stopped'; EXIT; END IF;
    END LOOP;
    RETURN jsonb_build_object('payload',result||jsonb_build_object('outcome',outcome,'run',private.workflow_run_position_v1(v_run)));
EXCEPTION WHEN SQLSTATE 'P57L1' THEN
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'run_id',p_run_id,
        'claim_token',p_claim_token,'outcome','lease_lost','run',NULL));
WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
END $$;
CREATE FUNCTION public.advance_automation_workflow_run_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_step_limit INTEGER DEFAULT 10)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT private.workflow_transition_owned_v1(p_studio_id,p_run_id,p_claim_token,p_step_limit,NULL)
$$;
CREATE FUNCTION public.defer_automation_workflow_run_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_reason IS NULL OR p_reason NOT IN ('facts_unavailable','subscription_required','sender_unavailable') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN private.workflow_transition_owned_v1(p_studio_id,p_run_id,p_claim_token,1,p_reason);
END $$;

ALTER TABLE private.automation_workflow_dispatch_cursor OWNER TO postgres;
ALTER TABLE private.automation_workflow_follow_up_actions OWNER TO postgres;
ALTER TABLE private.automation_workflow_dispatch_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_workflow_follow_up_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.automation_workflow_dispatch_cursor,private.automation_workflow_follow_up_actions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,UPDATE ON private.automation_workflow_dispatch_cursor TO service_role;
GRANT SELECT,INSERT ON private.automation_workflow_follow_up_actions TO service_role;
DO $advance_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_delay_due_identity_v1','workflow_follow_up_receipt_identity_v1',
            'workflow_run_position_v1','workflow_condition_result_v1','workflow_lock_run_sources_v1','workflow_defer_owned_run_v1',
            'workflow_apply_lead_follow_up_v1','workflow_transition_owned_v1'))
        OR (n.nspname='public' AND p.proname IN ('claim_automation_workflow_runs_v1','advance_automation_workflow_run_v1','defer_automation_workflow_run_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.proname NOT IN ('workflow_delay_due_identity_v1','workflow_follow_up_receipt_identity_v1') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity);
        END IF;
    END LOOP;
END;
$advance_privileges$;

-- Timed discovery is progress, never occurrence truth. Lifecycle writers project
-- immutable trigger metadata without acquiring this scanner's singleton.
CREATE TABLE private.workflow_timer_activations (
    activation_id UUID PRIMARY KEY, studio_id UUID NOT NULL, workflow_id UUID NOT NULL,
    version_id UUID NOT NULL, epoch BIGINT NOT NULL CHECK(epoch>0),
    trigger_event_type TEXT NOT NULL CHECK(trigger_event_type IN ('trial.upcoming','belt_test.upcoming','invoice.overdue')),
    offset_minutes INTEGER, program_id UUID,
    last_threshold_at TIMESTAMPTZ, last_event_id UUID, last_source_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
    FOREIGN KEY(studio_id,workflow_id,version_id,epoch,activation_id)
        REFERENCES public.automation_workflow_activations(studio_id,workflow_id,version_id,epoch,id) ON DELETE CASCADE,
    CHECK((trigger_event_type='invoice.overdue' AND offset_minutes IS NULL AND program_id IS NULL)
        OR (trigger_event_type<>'invoice.overdue' AND offset_minutes IS NOT NULL AND offset_minutes BETWEEN -129600 AND -1)),
    CHECK(last_threshold_at IS NULL OR last_threshold_at BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'),
    CHECK((last_threshold_at IS NULL AND last_event_id IS NULL AND last_source_id IS NULL)
        OR (last_threshold_at IS NOT NULL AND ((trigger_event_type='belt_test.upcoming' AND last_event_id IS NOT NULL)
            OR (trigger_event_type<>'belt_test.upcoming' AND last_event_id IS NULL AND last_source_id IS NOT NULL))))
);
CREATE TABLE private.workflow_timer_dispatch_cursor (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
    last_studio_id UUID, last_activation_id UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(updated_at)),
    CHECK((last_studio_id IS NULL)=(last_activation_id IS NULL))
);
INSERT INTO private.workflow_timer_dispatch_cursor(singleton) VALUES(true);
CREATE INDEX workflow_timer_activations_scan ON private.workflow_timer_activations(studio_id,activation_id);
CREATE INDEX lead_trial_appointments_timer_scan ON public.lead_trial_appointments(studio_id,starts_at,id) WHERE status='scheduled';
CREATE INDEX belt_test_events_timer_scan ON public.belt_test_events(studio_id,starts_at,id) WHERE status='scheduled';
CREATE INDEX belt_test_recipients_timer_scan ON public.belt_test_recipients(studio_id,event_id,id) WHERE state='approved';
CREATE INDEX workflow_invoice_episodes_timer_scan ON private.workflow_invoice_collection_episodes(studio_id,threshold_at,id)
    WHERE closed_at IS NULL AND threshold_eligible;
CREATE INDEX workflow_payment_settlement_uncertain_scan ON private.workflow_payment_settlement_observations(studio_id,invoice_id,payment_id)
    WHERE uncertain AND invoice_id IS NOT NULL;
CREATE INDEX workflow_events_failed_invoice ON private.automation_workflow_events(studio_id,(context->>'invoice_id'),id)
    WHERE event_type='invoice.payment_failed';

CREATE FUNCTION private.workflow_timer_activation_insert_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE graph JSONB; config JSONB;
BEGIN
    SELECT v.graph INTO graph FROM public.automation_workflow_versions v
        WHERE v.studio_id=NEW.studio_id AND v.workflow_id=NEW.workflow_id AND v.id=NEW.version_id;
    IF graph IS NULL OR private.workflow_validate_v1(graph,'{}',true) IS DISTINCT FROM '[]'::JSONB THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT n->'config' INTO config FROM jsonb_array_elements(graph->'nodes') n WHERE n->>'type'='trigger';
    IF config->>'event_type' IN ('trial.upcoming','belt_test.upcoming','invoice.overdue') THEN
        INSERT INTO private.workflow_timer_activations(activation_id,studio_id,workflow_id,version_id,epoch,trigger_event_type,offset_minutes,program_id)
            VALUES(NEW.id,NEW.studio_id,NEW.workflow_id,NEW.version_id,NEW.epoch,config->>'event_type',
                (config->>'offset_minutes')::INTEGER,(config->>'program_id')::UUID);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_timer_activation_insert_v1 AFTER INSERT ON public.automation_workflow_activations
    FOR EACH ROW EXECUTE FUNCTION private.workflow_timer_activation_insert_v1();
INSERT INTO private.workflow_timer_activations(activation_id,studio_id,workflow_id,version_id,epoch,trigger_event_type,offset_minutes,program_id)
    SELECT a.id,a.studio_id,a.workflow_id,a.version_id,a.epoch,n#>>'{config,event_type}',
        (n#>>'{config,offset_minutes}')::INTEGER,(n#>>'{config,program_id}')::UUID
    FROM public.automation_workflow_activations a JOIN public.automation_workflow_versions v
        ON v.studio_id=a.studio_id AND v.workflow_id=a.workflow_id AND v.id=a.version_id
    CROSS JOIN LATERAL jsonb_array_elements(v.graph->'nodes') n
    WHERE n->>'type'='trigger' AND n#>>'{config,event_type}' IN ('trial.upcoming','belt_test.upcoming','invoice.overdue');
CREATE FUNCTION private.workflow_timer_activation_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF (to_jsonb(NEW)-ARRAY['last_threshold_at','last_event_id','last_source_id','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_threshold_at','last_event_id','last_source_id','updated_at']) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER workflow_timer_activation_identity_v1 BEFORE UPDATE ON private.workflow_timer_activations
    FOR EACH ROW EXECUTE FUNCTION private.workflow_timer_activation_identity_v1();

CREATE FUNCTION private.workflow_timed_candidates_v1(p_limit INTEGER,p_reference_at TIMESTAMPTZ) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE dispatch private.workflow_timer_dispatch_cursor; timer private.workflow_timer_activations;
    activation public.automation_workflow_activations; parent public.belt_test_events;
    recipient_id UUID; source_id UUID; source_subject_id UUID; source_threshold_at TIMESTAMPTZ; source_starts_at TIMESTAMPTZ;
    pairs JSONB:='[]'; invoices TEXT[]:='{}'; invoice_key TEXT; more BOOLEAN:=false;
    global_studio UUID; global_activation UUID; global_wrapped BOOLEAN:=false;
    position_time TIMESTAMPTZ; position_source UUID; position_event UUID; wrapped BOOLEAN;
    lower_start TIMESTAMPTZ; upper_start TIMESTAMPTZ; retired_start TIMESTAMPTZ; shift INTERVAL;
    visits INTEGER:=0; decisions INTEGER; pair_cap INTEGER; parent_visits INTEGER; total_parents INTEGER:=0;
    resume_parent BOOLEAN; resumed BOOLEAN;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_reference_at IS NULL
        OR p_reference_at NOT BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    SELECT * INTO dispatch FROM private.workflow_timer_dispatch_cursor WHERE singleton FOR UPDATE NOWAIT;
    IF dispatch.singleton IS DISTINCT FROM true OR (dispatch.last_studio_id IS NULL)<>(dispatch.last_activation_id IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    global_studio:=dispatch.last_studio_id; global_activation:=dispatch.last_activation_id;
    LOOP
        -- A global cap must preserve the next activation's turn.
        IF visits=100 OR jsonb_array_length(pairs)=p_limit OR cardinality(invoices)=10
            OR total_parents=100 THEN more:=true; EXIT; END IF;
        -- LIMIT is on metadata alone. Canceled history consumes the same budget.
        EXECUTE 'SELECT * FROM private.workflow_timer_activations t WHERE true'
            ||CASE WHEN global_studio IS NOT NULL THEN ' AND (t.studio_id,t.activation_id)>($1,$2)' ELSE '' END
            ||CASE WHEN global_wrapped THEN ' AND (t.studio_id,t.activation_id)<=($3,$4)' ELSE '' END
            ||' ORDER BY t.studio_id,t.activation_id LIMIT 1 FOR UPDATE NOWAIT'
            INTO timer USING global_studio,global_activation,dispatch.last_studio_id,dispatch.last_activation_id;
        IF timer.activation_id IS NULL THEN
            IF NOT global_wrapped AND dispatch.last_studio_id IS NOT NULL THEN
                global_wrapped:=true; global_studio:=NULL; global_activation:=NULL; CONTINUE;
            END IF;
            EXIT;
        END IF;
        visits:=visits+1; global_studio:=timer.studio_id; global_activation:=timer.activation_id;
        UPDATE private.workflow_timer_dispatch_cursor SET last_studio_id=global_studio,last_activation_id=global_activation,
            updated_at=p_reference_at WHERE singleton;
        SELECT * INTO activation FROM public.automation_workflow_activations a WHERE a.id=timer.activation_id;
        IF activation.id IS NULL OR activation.cancelled_at IS NOT NULL THEN CONTINUE; END IF;
        position_time:=timer.last_threshold_at; position_source:=timer.last_source_id; position_event:=timer.last_event_id;
        wrapped:=false; decisions:=0; parent_visits:=0;
        pair_cap:=least(25,p_limit-jsonb_array_length(pairs));
        shift:=make_interval(mins=>coalesce(timer.offset_minutes,0));
        lower_start:=greatest(p_reference_at,activation.active_from-shift,TIMESTAMPTZ '0001-01-01+00'-shift);
        upper_start:=least(p_reference_at-shift,TIMESTAMPTZ '9999-12-31 23:59:59.999999+00');
        retired_start:=activation.retired_at-shift;
        IF timer.trigger_event_type='belt_test.upcoming' THEN
            resume_parent:=position_event IS NOT NULL AND position_source IS NOT NULL;
            LOOP
                IF decisions=pair_cap OR parent_visits=25 OR total_parents=100 THEN more:=true; EXIT; END IF;
                parent:=NULL; resumed:=resume_parent;
                IF resume_parent THEN
                    SELECT * INTO parent FROM public.belt_test_events e WHERE e.studio_id=timer.studio_id AND e.id=position_event
                        AND e.status='scheduled' AND e.starts_at=position_time-shift
                        AND e.starts_at>p_reference_at AND e.starts_at>=lower_start AND e.starts_at<=upper_start
                        AND (retired_start IS NULL OR e.starts_at<retired_start);
                    resume_parent:=false;
                ELSE
                    EXECUTE $scan$SELECT * FROM public.belt_test_events e WHERE e.studio_id=$1 AND e.status='scheduled'
                        AND e.starts_at>$4 AND e.starts_at>=$2 AND e.starts_at<=$3$scan$
                        ||CASE WHEN retired_start IS NOT NULL THEN ' AND e.starts_at<$5' ELSE '' END
                        ||CASE WHEN position_time IS NOT NULL THEN ' AND (e.starts_at,e.id)>($6-$10,$7)' ELSE '' END
                        ||CASE WHEN wrapped THEN ' AND (e.starts_at,e.id)<=($8-$10,$9)' ELSE '' END
                        ||' ORDER BY e.starts_at,e.id LIMIT 1' INTO parent
                        USING timer.studio_id,lower_start,upper_start,p_reference_at,retired_start,position_time,position_event,
                            timer.last_threshold_at,timer.last_event_id,shift;
                    position_source:=NULL;
                END IF;
                IF parent.id IS NULL THEN
                    IF resumed THEN position_source:=NULL; CONTINUE; END IF;
                    IF NOT wrapped AND timer.last_threshold_at IS NOT NULL THEN
                        wrapped:=true; position_time:=NULL; position_event:=NULL; position_source:=NULL; CONTINUE;
                    END IF;
                    EXIT;
                END IF;
                parent_visits:=parent_visits+1; total_parents:=total_parents+1;
                position_time:=parent.starts_at+shift; position_event:=parent.id;
                FOR recipient_id IN EXECUTE $scan$SELECT r.id FROM public.belt_test_recipients r
                    WHERE r.studio_id=$1 AND r.event_id=$2 AND r.state='approved'$scan$
                    ||CASE WHEN position_source IS NOT NULL THEN ' AND r.id>$3' ELSE '' END
                    ||CASE WHEN wrapped AND parent.id=timer.last_event_id AND position_time=timer.last_threshold_at
                        AND timer.last_source_id IS NOT NULL THEN ' AND r.id<=$4' ELSE '' END
                    ||' ORDER BY r.id LIMIT $5'
                    USING timer.studio_id,parent.id,position_source,timer.last_source_id,pair_cap-decisions LOOP
                    decisions:=decisions+1; position_source:=recipient_id;
                    pairs:=pairs||jsonb_build_array(jsonb_build_object('studio_id',timer.studio_id,'activation_id',timer.activation_id,
                        'workflow_id',timer.workflow_id,'version_id',timer.version_id,'epoch',timer.epoch,'event_type',timer.trigger_event_type,
                        'subject_id',recipient_id,'source_record_id',recipient_id,'source_parent_id',parent.id,
                        'source_starts_at',private.automation_utc_text_v1(parent.starts_at),'threshold_at',private.automation_utc_text_v1(position_time)));
                END LOOP;
                -- A full page is conservatively partial. No lookahead row.
                IF decisions<pair_cap THEN position_source:=NULL; END IF;
                UPDATE private.workflow_timer_activations SET last_threshold_at=position_time,last_event_id=position_event,
                    last_source_id=position_source,updated_at=p_reference_at WHERE activation_id=timer.activation_id;
                IF decisions=pair_cap OR parent_visits=25 OR total_parents=100 THEN more:=true; END IF;
                IF wrapped AND parent.id=timer.last_event_id AND position_time=timer.last_threshold_at THEN EXIT; END IF;
            END LOOP;
        ELSE
            LOOP
                IF decisions=pair_cap THEN more:=true; EXIT; END IF;
                IF timer.trigger_event_type='invoice.overdue' AND cardinality(invoices)=10 THEN more:=true; EXIT; END IF;
                IF timer.trigger_event_type='trial.upcoming' THEN
                    EXECUTE $scan$SELECT t.id,t.id subject_id,t.starts_at+$10 threshold_at,t.starts_at
                        FROM public.lead_trial_appointments t WHERE t.studio_id=$1 AND t.status='scheduled'
                            AND t.starts_at>$4 AND t.starts_at>=$2 AND t.starts_at<=$3$scan$
                        ||CASE WHEN retired_start IS NOT NULL THEN ' AND t.starts_at<$5' ELSE '' END
                        ||CASE WHEN position_time IS NOT NULL THEN ' AND (t.starts_at,t.id)>($6-$10,$7)' ELSE '' END
                        ||CASE WHEN wrapped THEN ' AND (t.starts_at,t.id)<=($8-$10,$9)' ELSE '' END
                        ||' ORDER BY t.starts_at,t.id LIMIT 1' INTO source_id,source_subject_id,source_threshold_at,source_starts_at
                        USING timer.studio_id,lower_start,upper_start,p_reference_at,retired_start,position_time,position_source,
                            timer.last_threshold_at,timer.last_source_id,shift;
                ELSE
                    EXECUTE $scan$SELECT e.id,e.invoice_id subject_id,e.threshold_at,NULL::TIMESTAMPTZ starts_at
                        FROM private.workflow_invoice_collection_episodes e WHERE e.studio_id=$1
                            AND e.closed_at IS NULL AND e.threshold_eligible AND e.threshold_at<=$4 AND e.threshold_at>=$2$scan$
                        ||CASE WHEN activation.retired_at IS NOT NULL THEN ' AND e.threshold_at<$5' ELSE '' END
                        ||CASE WHEN position_time IS NOT NULL THEN ' AND (e.threshold_at,e.id)>($6,$7)' ELSE '' END
                        ||CASE WHEN wrapped THEN ' AND (e.threshold_at,e.id)<=($8,$9)' ELSE '' END
                        ||' ORDER BY e.threshold_at,e.id LIMIT 1' INTO source_id,source_subject_id,source_threshold_at,source_starts_at
                        USING timer.studio_id,activation.active_from,NULL::TIMESTAMPTZ,p_reference_at,activation.retired_at,
                            position_time,position_source,timer.last_threshold_at,timer.last_source_id;
                END IF;
                IF source_id IS NULL THEN
                    IF NOT wrapped AND timer.last_threshold_at IS NOT NULL THEN
                        wrapped:=true; position_time:=NULL; position_source:=NULL; CONTINUE;
                    END IF;
                    EXIT;
                END IF;
                IF timer.trigger_event_type='invoice.overdue' THEN
                    invoice_key:=timer.studio_id::TEXT||':'||source_subject_id::TEXT;
                    IF NOT invoice_key=ANY(invoices) THEN invoices:=array_append(invoices,invoice_key); END IF;
                END IF;
                decisions:=decisions+1; position_time:=source_threshold_at; position_source:=source_id;
                pairs:=pairs||jsonb_build_array(jsonb_build_object('studio_id',timer.studio_id,'activation_id',timer.activation_id,
                    'workflow_id',timer.workflow_id,'version_id',timer.version_id,'epoch',timer.epoch,'event_type',timer.trigger_event_type,
                    'subject_id',source_subject_id,'source_record_id',source_id,'source_parent_id',NULL,
                    'source_starts_at',private.automation_utc_text_v1(source_starts_at),'threshold_at',private.automation_utc_text_v1(source_threshold_at)));
                UPDATE private.workflow_timer_activations SET last_threshold_at=position_time,last_source_id=position_source,
                    updated_at=p_reference_at WHERE activation_id=timer.activation_id;
            END LOOP;
        END IF;
    END LOOP;
    RETURN jsonb_build_object('pairs',pairs,'has_more',more);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_lock_timed_sources_v1(p_candidates JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE item JSONB; studio UUID; key TEXT; owned TEXT[]:='{}'; complete_sources TEXT[]:='{}'; complete_studios UUID[]:='{}';
    owned_candidates JSONB:='[]'; owned_pairs JSONB:='[]'; payments UUID[]; uncertain_ids UUID[];
    required_programs UUID[]; required_ranks UUID[]; required_payers UUID[]; held_ids UUID[]; held_filters UUID[]; complete BOOLEAN; found_parent UUID;
    invoice public.billing_invoices; payer public.billing_payers; account public.studio_payment_accounts;
    failed_runs UUID[]; workflows UUID[]; event private.automation_workflow_events; timer private.workflow_timer_activations;
    before_route JSONB; after_route JSONB; fields TEXT[]:=ARRAY['studio_id','activation_id','workflow_id','version_id','epoch',
        'event_type','subject_id','source_record_id','source_parent_id','source_starts_at','threshold_at'];
BEGIN
    IF jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_candidates)>100 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_candidates) LOOP
        IF NOT private.workflow_json_keys_v1(item,fields,fields) OR NOT private.workflow_integer_v1(item->'epoch',1,9223372036854775807)
            OR jsonb_typeof(item->'event_type') IS DISTINCT FROM 'string' OR item->>'event_type' NOT IN ('trial.upcoming','belt_test.upcoming','invoice.overdue') THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        FOREACH key IN ARRAY ARRAY['studio_id','activation_id','workflow_id','version_id','subject_id','source_record_id'] LOOP
            IF jsonb_typeof(item->key) IS DISTINCT FROM 'string' OR NOT coalesce(private.workflow_typed_value_v1(item->key,private.workflow_catalog_v1()#>'{fields,program.id}'),false) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        END LOOP;
        PERFORM private.automation_instant_v1(item->'threshold_at');
        IF item->>'event_type'='invoice.overdue' THEN
            IF item->'source_starts_at'<>'null'::JSONB OR item->'source_parent_id'<>'null'::JSONB THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        ELSE
            PERFORM private.automation_instant_v1(item->'source_starts_at');
            IF item->'subject_id' IS DISTINCT FROM item->'source_record_id'
                OR (item->>'event_type'='trial.upcoming' AND item->'source_parent_id'<>'null'::JSONB)
                OR (item->>'event_type'='belt_test.upcoming' AND (jsonb_typeof(item->'source_parent_id') IS DISTINCT FROM 'string'
                    OR NOT coalesce(private.workflow_typed_value_v1(item->'source_parent_id',private.workflow_catalog_v1()#>'{fields,program.id}'),false))) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
            END IF;
        END IF;
        SELECT * INTO timer FROM private.workflow_timer_activations WHERE activation_id=(item->>'activation_id')::UUID;
        IF timer.activation_id IS NULL OR ROW(timer.studio_id,timer.workflow_id,timer.version_id,timer.epoch,timer.trigger_event_type)
            IS DISTINCT FROM ROW((item->>'studio_id')::UUID,(item->>'workflow_id')::UUID,(item->>'version_id')::UUID,(item->>'epoch')::BIGINT,item->>'event_type') THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_candidates) x GROUP BY x->>'activation_id',x->>'source_record_id' HAVING count(*)>1)
        OR (SELECT count(DISTINCT (x->>'studio_id',x->>'subject_id')) FROM jsonb_array_elements(p_candidates) x WHERE x->>'event_type'='invoice.overdue')>10 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    FOR studio IN SELECT DISTINCT (x->>'studio_id')::UUID FROM jsonb_array_elements(p_candidates) x ORDER BY 1 LOOP
        IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||studio::TEXT,0)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END IF;
        SELECT id INTO found_parent FROM public.studios WHERE id=studio FOR SHARE NOWAIT;
        complete:=FOUND;
        PERFORM 1 FROM public.studio_subscriptions WHERE studio_id=studio FOR SHARE NOWAIT;
        IF complete THEN complete_studios:=array_append(complete_studios,studio); END IF;
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(p_candidates) ORDER BY value->>'studio_id',value->>'event_type',value->>'subject_id' LOOP
        key:=(item->>'studio_id')||':'||(item->>'event_type')||':'||(item->>'subject_id');
        IF key=ANY(owned) THEN CONTINUE; END IF;
        owned:=array_append(owned,key); studio:=(item->>'studio_id')::UUID; complete:=studio=ANY(complete_studios);
        IF NOT complete THEN CONTINUE; END IF;
        IF item->>'event_type'='invoice.overdue' THEN
            PERFORM private.workflow_lock_financial_sources_v1(studio,(item->>'subject_id')::UUID,'{}');
            -- Only repair candidates are capped. Current contributors and failed
            -- notice cancellation retain the accepted owners' full fanout.
            SELECT coalesce(array_agg(payment_id ORDER BY payment_id),'{}'::UUID[]) INTO uncertain_ids FROM (
                SELECT payment_id FROM private.workflow_payment_settlement_observations WHERE studio_id=studio
                    AND invoice_id=(item->>'subject_id')::UUID AND uncertain ORDER BY payment_id LIMIT 20) bounded;
            SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::UUID[]) INTO payments FROM public.billing_payments
                WHERE studio_id=studio AND (id=ANY(uncertain_ids) OR (invoice_id=(item->>'subject_id')::UUID
                    AND status IN ('succeeded','refunded','disputed','externally_recorded')));
            PERFORM private.workflow_lock_financial_sources_v1(studio,(item->>'subject_id')::UUID,payments);
            SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=studio AND id=(item->>'subject_id')::UUID FOR SHARE NOWAIT;
            SELECT * INTO payer FROM public.billing_payers WHERE studio_id=studio AND id=invoice.payer_id FOR SHARE NOWAIT;
            SELECT * INTO account FROM public.studio_payment_accounts WHERE studio_id=studio FOR SHARE NOWAIT;
            complete:=invoice.id IS NOT NULL AND payer.id IS NOT NULL AND account.studio_id IS NOT NULL;
            SELECT ARRAY(SELECT DISTINCT payer_id FROM public.billing_payments WHERE studio_id=studio AND id=ANY(payments)
                AND payer_id IS NOT NULL ORDER BY payer_id) INTO required_payers;
            SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO held_ids FROM (
                SELECT id FROM public.billing_payers WHERE studio_id=studio AND id=ANY(required_payers) ORDER BY id FOR SHARE NOWAIT) locked;
            complete:=complete AND held_ids=required_payers;
            SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO held_ids FROM (
                SELECT id FROM public.billing_payments WHERE studio_id=studio AND (id=ANY(uncertain_ids)
                    OR (invoice_id=(item->>'subject_id')::UUID AND status IN ('succeeded','refunded','disputed','externally_recorded')))
                    ORDER BY id FOR UPDATE NOWAIT) locked;
            IF held_ids IS DISTINCT FROM payments THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
        ELSE
            -- Capture every routing field the retained source owner may follow.
            IF item->>'event_type'='trial.upcoming' THEN
                SELECT jsonb_build_object('trial',to_jsonb(t),'lead',to_jsonb(l)) INTO before_route
                    FROM public.lead_trial_appointments t LEFT JOIN public.leads l ON l.studio_id=t.studio_id AND l.id=t.lead_id
                    WHERE t.studio_id=studio AND t.id=(item->>'subject_id')::UUID;
            ELSE
                SELECT jsonb_build_object('recipient',to_jsonb(r),'event',to_jsonb(e),'student',to_jsonb(s),'membership',to_jsonb(m)) INTO before_route
                    FROM public.belt_test_recipients r LEFT JOIN public.belt_test_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
                    LEFT JOIN public.students s ON s.studio_id=r.studio_id AND s.id=r.student_id
                    LEFT JOIN public.student_program_memberships m ON m.studio_id=r.studio_id AND m.id=r.student_program_membership_id
                    WHERE r.studio_id=studio AND r.id=(item->>'subject_id')::UUID;
                IF before_route#>>'{recipient,event_id}' IS DISTINCT FROM item->>'source_parent_id' AND before_route IS NOT NULL THEN
                    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
                END IF;
            END IF;
            event:=NULL; event.studio_id:=studio; event.event_type:=item->>'event_type'; event.subject_id:=(item->>'subject_id')::UUID;
            PERFORM private.workflow_lock_run_sources_v1(studio,event,'{"program_id":null}');
            IF item->>'event_type'='trial.upcoming' THEN
                SELECT jsonb_build_object('trial',to_jsonb(t),'lead',to_jsonb(l)) INTO after_route
                    FROM public.lead_trial_appointments t LEFT JOIN public.leads l ON l.studio_id=t.studio_id AND l.id=t.lead_id
                    WHERE t.studio_id=studio AND t.id=event.subject_id;
            ELSE
                SELECT jsonb_build_object('recipient',to_jsonb(r),'event',to_jsonb(e),'student',to_jsonb(s),'membership',to_jsonb(m)) INTO after_route
                    FROM public.belt_test_recipients r LEFT JOIN public.belt_test_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
                    LEFT JOIN public.students s ON s.studio_id=r.studio_id AND s.id=r.student_id
                    LEFT JOIN public.student_program_memberships m ON m.studio_id=r.studio_id AND m.id=r.student_program_membership_id
                    WHERE r.studio_id=studio AND r.id=event.subject_id;
            END IF;
            IF before_route IS DISTINCT FROM after_route THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
            IF item->>'event_type'='trial.upcoming' THEN
                complete:=after_route IS NOT NULL AND after_route->'lead'<>'null'::JSONB;
                required_programs:=ARRAY[(after_route#>>'{trial,program_id}')::UUID,(after_route#>>'{lead,program_id}')::UUID];
            ELSE
                complete:=after_route IS NOT NULL AND after_route->'event'<>'null'::JSONB AND after_route->'student'<>'null'::JSONB
                    AND (after_route#>>'{recipient,student_program_membership_id}' IS NULL OR after_route->'membership'<>'null'::JSONB);
                required_programs:=ARRAY[(after_route#>>'{event,program_id}')::UUID,(after_route#>>'{recipient,approved_program_id}')::UUID,
                    CASE WHEN after_route#>>'{recipient,student_program_membership_id}' IS NULL THEN (after_route#>>'{student,program_id}')::UUID
                        ELSE (after_route#>>'{membership,program_id}')::UUID END];
                required_ranks:=ARRAY[(after_route#>>'{recipient,approved_current_rank_id}')::UUID,(after_route#>>'{recipient,approved_target_rank_id}')::UUID,
                    CASE WHEN after_route#>>'{recipient,student_program_membership_id}' IS NULL THEN (after_route#>>'{student,current_belt_rank_id}')::UUID
                        ELSE (after_route#>>'{membership,current_belt_rank_id}')::UUID END];
                SELECT id INTO found_parent FROM public.belt_ladders WHERE studio_id=studio AND id=(after_route#>>'{event,ladder_id}')::UUID FOR SHARE NOWAIT;
                complete:=complete AND FOUND;
                SELECT ARRAY(SELECT DISTINCT id FROM unnest(required_ranks) id WHERE id IS NOT NULL ORDER BY id) INTO required_ranks;
                SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO held_ids FROM (
                    SELECT id FROM public.belt_ranks WHERE studio_id=studio AND id=ANY(required_ranks) ORDER BY id FOR SHARE NOWAIT) locked;
                complete:=complete AND held_ids=required_ranks;
            END IF;
            SELECT ARRAY(SELECT DISTINCT id FROM unnest(required_programs) id WHERE id IS NOT NULL ORDER BY id) INTO required_programs;
            SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO held_ids FROM (
                SELECT id FROM public.programs WHERE studio_id=studio AND id=ANY(required_programs) ORDER BY id FOR SHARE NOWAIT) locked;
            complete:=complete AND held_ids=required_programs;
        END IF;
        IF complete THEN complete_sources:=array_append(complete_sources,key); END IF;
    END LOOP;
    -- Source deduplication must not omit another selected activation's filter.
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO held_filters FROM (
        SELECT p.id FROM public.programs p WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_candidates) x
            JOIN private.workflow_timer_activations t ON t.activation_id=(x->>'activation_id')::UUID
            WHERE p.studio_id=t.studio_id AND p.id=t.program_id) ORDER BY p.id FOR SHARE NOWAIT) locked;
    FOR item IN SELECT value FROM jsonb_array_elements(p_candidates) LOOP
        SELECT * INTO timer FROM private.workflow_timer_activations WHERE activation_id=(item->>'activation_id')::UUID;
        key:=(item->>'studio_id')||':'||(item->>'event_type')||':'||(item->>'subject_id');
        IF key=ANY(complete_sources) AND (timer.program_id IS NULL OR timer.program_id=ANY(held_filters)) THEN
            owned_candidates:=owned_candidates||jsonb_build_array(item);
            owned_pairs:=owned_pairs||jsonb_build_array(jsonb_build_object('activation_id',item->'activation_id','source_record_id',item->'source_record_id'));
        END IF;
    END LOOP;
    SELECT coalesce(array_agg(DISTINCT r.id ORDER BY r.id),'{}'::UUID[]),coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[])
        INTO failed_runs,workflows FROM private.automation_workflow_events e JOIN public.automation_workflow_runs r ON r.studio_id=e.studio_id AND r.event_id=e.id
        WHERE e.event_type='invoice.payment_failed' AND r.cancel_requested_at IS NULL
            AND r.state IN ('queued','waiting','claimed','running','sending','unknown')
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(owned_candidates) x WHERE x->>'event_type'='invoice.overdue'
                AND e.studio_id=(x->>'studio_id')::UUID AND e.context->>'invoice_id'=((x->>'subject_id')::UUID)::TEXT);
    SELECT ARRAY(SELECT DISTINCT id FROM (SELECT unnest(workflows) id UNION ALL
        SELECT (x->>'workflow_id')::UUID FROM jsonb_array_elements(owned_candidates) x) ids ORDER BY id) INTO workflows;
    PERFORM 1 FROM public.automation_workflows WHERE id=ANY(workflows) ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_workflow_runs WHERE id=ANY(failed_runs) ORDER BY id FOR UPDATE NOWAIT;
    -- Every blocking cancellation selection below reenters this preowned union.
    FOR item IN SELECT DISTINCT jsonb_build_object('studio',x->'studio_id','invoice',x->'subject_id')
        FROM jsonb_array_elements(owned_candidates) x WHERE x->>'event_type'='invoice.overdue' ORDER BY 1 LOOP
        PERFORM private.workflow_prepare_financial_context_v1((item->>'studio')::UUID,(item->>'invoice')::UUID);
    END LOOP;
    RETURN jsonb_build_object('owned_pairs',owned_pairs);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_enroll_timed_occurrence_v1(
    p_activation_id UUID,p_subject_id UUID,p_source_record_id UUID,p_discovered_start TIMESTAMPTZ,
    p_discovered_threshold TIMESTAMPTZ,p_at TIMESTAMPTZ) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE timer private.workflow_timer_activations; activation public.automation_workflow_activations;
    workflow public.automation_workflows; version public.automation_workflow_versions; trial public.lead_trial_appointments;
    recipient public.belt_test_recipients; parent public.belt_test_events; episode private.workflow_invoice_collection_episodes;
    provenance private.automation_workflow_events; occurrence private.automation_workflow_events;
    context JSONB; config JSONB; facts JSONB; threshold TIMESTAMPTZ; starts TIMESTAMPTZ;
    v_source_key TEXT; source_kind TEXT; trigger_id TEXT; v_event_id UUID; run_id UUID;
    decision TEXT:='ineligible'; created BOOLEAN:=false; enqueued BOOLEAN:=false;
BEGIN
    IF p_activation_id IS NULL OR p_subject_id IS NULL OR p_source_record_id IS NULL OR p_at IS NULL
        OR p_at NOT BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    <<admission>>
    BEGIN
        SELECT * INTO timer FROM private.workflow_timer_activations WHERE activation_id=p_activation_id;
        SELECT * INTO activation FROM public.automation_workflow_activations WHERE id=p_activation_id;
        SELECT * INTO workflow FROM public.automation_workflows WHERE id=timer.workflow_id AND studio_id=timer.studio_id;
        IF timer.activation_id IS NULL OR activation.id IS NULL OR workflow.id IS NULL OR workflow.status<>'active'
            OR activation.cancelled_at IS NOT NULL OR activation.epoch<>workflow.enrollment_epoch
            OR ROW(activation.studio_id,activation.workflow_id,activation.version_id,activation.epoch)
                IS DISTINCT FROM ROW(timer.studio_id,timer.workflow_id,timer.version_id,timer.epoch) THEN EXIT admission; END IF;
        SELECT * INTO version FROM public.automation_workflow_versions WHERE studio_id=timer.studio_id AND workflow_id=timer.workflow_id AND id=timer.version_id;
        SELECT n->>'id',jsonb_build_object('program_id',NULL)||(n->'config') INTO trigger_id,config
            FROM jsonb_array_elements(version.graph->'nodes') n WHERE n->>'type'='trigger';
        IF trigger_id IS NULL OR config->>'event_type' IS DISTINCT FROM timer.trigger_event_type
            OR (config->>'offset_minutes')::INTEGER IS DISTINCT FROM timer.offset_minutes
            OR (config->>'program_id')::UUID IS DISTINCT FROM timer.program_id THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
        END IF;
        IF timer.trigger_event_type='invoice.overdue' THEN
            SELECT * INTO episode FROM private.workflow_invoice_collection_episodes WHERE studio_id=timer.studio_id AND invoice_id=p_subject_id AND id=p_source_record_id;
            IF episode.id IS NULL OR episode.closed_at IS NOT NULL OR NOT episode.threshold_eligible
                OR NOT EXISTS(SELECT 1 FROM private.workflow_invoice_episode_state WHERE studio_id=timer.studio_id
                    AND invoice_id=p_subject_id AND current_episode_id=episode.id) THEN EXIT admission; END IF;
            threshold:=episode.threshold_at; context:=episode.context; v_source_key:=episode.id::TEXT; source_kind:='invoice';
            IF episode.opened_at>threshold OR (episode.opened_at AT TIME ZONE episode.frozen_timezone)::DATE>(context->>'due_date')::DATE
                OR (activation.active_from AT TIME ZONE episode.frozen_timezone)::DATE>(context->>'due_date')::DATE THEN EXIT admission; END IF;
        ELSIF timer.trigger_event_type='trial.upcoming' THEN
            SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=timer.studio_id AND id=p_subject_id AND id=p_source_record_id;
            IF trial.id IS NULL OR trial.status<>'scheduled' THEN EXIT admission; END IF;
            starts:=trial.starts_at; source_kind:='trial'; v_source_key:=trial.id::TEXT||':'||trial.revision::TEXT;
            SELECT * INTO provenance FROM private.automation_workflow_events e WHERE e.studio_id=timer.studio_id AND e.event_type='trial.scheduled' AND e.source_key=v_source_key;
            v_source_key:=v_source_key||':'||timer.offset_minutes::TEXT;
        ELSE
            SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=timer.studio_id AND id=p_subject_id AND id=p_source_record_id;
            SELECT * INTO parent FROM public.belt_test_events WHERE studio_id=timer.studio_id AND id=recipient.event_id;
            IF recipient.id IS NULL OR recipient.state<>'approved' OR parent.id IS NULL OR parent.status<>'scheduled'
                OR recipient.approved_schedule_revision<>parent.schedule_revision THEN EXIT admission; END IF;
            starts:=parent.starts_at; source_kind:='belt_test'; v_source_key:=recipient.id::TEXT||':'||recipient.revision::TEXT||':'||recipient.approved_schedule_revision::TEXT;
            SELECT * INTO provenance FROM private.automation_workflow_events e WHERE e.studio_id=timer.studio_id AND e.event_type='belt_test.approved' AND e.source_key=v_source_key;
            v_source_key:=v_source_key||':'||timer.offset_minutes::TEXT;
        END IF;
        IF timer.trigger_event_type<>'invoice.overdue' THEN
            threshold:=starts+make_interval(mins=>timer.offset_minutes);
            IF starts<=p_at OR starts IS DISTINCT FROM p_discovered_start THEN EXIT admission; END IF;
            IF provenance.id IS NULL OR provenance.subject_kind IS DISTINCT FROM source_kind OR provenance.subject_id IS DISTINCT FROM p_subject_id THEN
                decision:='unavailable'; EXIT admission;
            END IF;
            IF provenance.occurred_at>threshold THEN EXIT admission; END IF;
            context:=provenance.context;
        ELSIF p_discovered_start IS NOT NULL THEN EXIT admission;
        END IF;
        IF threshold IS NULL OR threshold IS DISTINCT FROM p_discovered_threshold
            OR threshold NOT BETWEEN TIMESTAMPTZ '0001-01-01+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
            OR threshold>p_at OR threshold<activation.active_from OR (activation.retired_at IS NOT NULL AND threshold>=activation.retired_at) THEN EXIT admission; END IF;
        facts:=private.workflow_current_source_facts_v1(timer.studio_id,timer.trigger_event_type,p_subject_id,context,config,p_at,'{}')->'facts';
        IF facts->>'source_decision'='ineligible' THEN EXIT admission; END IF;
        IF facts->>'source_decision' IS DISTINCT FROM 'eligible'
            OR (timer.trigger_event_type='invoice.overdue' AND EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p
                WHERE p.studio_id=timer.studio_id AND p.invoice_id=p_subject_id AND p.backend_pid=pg_catalog.pg_backend_pid()
                    AND p.transaction_id=pg_catalog.pg_current_xact_id())) THEN decision:='unavailable'; EXIT admission; END IF;
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context,created_at)
            VALUES(timer.studio_id,timer.trigger_event_type,v_source_key,source_kind,p_subject_id,threshold,context,p_at)
            ON CONFLICT(studio_id,event_type,source_key) DO NOTHING RETURNING id INTO v_event_id;
        created:=v_event_id IS NOT NULL;
        IF NOT created THEN
            SELECT * INTO occurrence FROM private.automation_workflow_events e WHERE e.studio_id=timer.studio_id AND e.event_type=timer.trigger_event_type AND e.source_key=v_source_key;
            IF occurrence.id IS NULL OR ROW(occurrence.subject_kind,occurrence.subject_id,occurrence.occurred_at,occurrence.context)
                IS DISTINCT FROM ROW(source_kind,p_subject_id,threshold,context) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            v_event_id:=occurrence.id;
        END IF;
        INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,next_due_at,created_at,updated_at)
            VALUES(timer.studio_id,timer.workflow_id,timer.version_id,v_event_id,timer.activation_id,timer.epoch,trigger_id,p_at,p_at,p_at)
            ON CONFLICT(workflow_id,event_id) DO NOTHING RETURNING id INTO run_id;
        enqueued:=run_id IS NOT NULL; decision:=CASE WHEN enqueued THEN 'enrolled' ELSE 'already_enrolled' END;
    END admission;
    RETURN jsonb_build_object('decision',decision,'created_event',created,'enqueued_run',enqueued);
END $$;

CREATE FUNCTION public.process_automation_workflow_occurrences_v1(p_limit INTEGER DEFAULT 100) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE candidates JSONB; ownership JSONB; item JSONB; result JSONB; at TIMESTAMPTZ; events INTEGER:=0; runs INTEGER:=0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    candidates:=private.workflow_timed_candidates_v1(p_limit,clock_timestamp());
    ownership:=private.workflow_lock_timed_sources_v1(candidates->'pairs');
    at:=clock_timestamp();
    FOR item IN SELECT x.value FROM jsonb_array_elements(candidates->'pairs') x WHERE EXISTS(
        SELECT 1 FROM jsonb_array_elements(ownership->'owned_pairs') o WHERE o->'activation_id'=x.value->'activation_id'
            AND o->'source_record_id'=x.value->'source_record_id') LOOP
        result:=private.workflow_enroll_timed_occurrence_v1((item->>'activation_id')::UUID,(item->>'subject_id')::UUID,
            (item->>'source_record_id')::UUID,(item->>'source_starts_at')::TIMESTAMPTZ,(item->>'threshold_at')::TIMESTAMPTZ,at);
        events:=events+(result->>'created_event')::BOOLEAN::INTEGER; runs:=runs+(result->>'enqueued_run')::BOOLEAN::INTEGER;
    END LOOP;
    RETURN jsonb_build_object('payload',jsonb_build_object('created_event_count',events,'enqueued_run_count',runs,'has_more',candidates->'has_more'));
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

ALTER TABLE private.workflow_timer_activations OWNER TO postgres;
ALTER TABLE private.workflow_timer_dispatch_cursor OWNER TO postgres;
ALTER TABLE private.workflow_timer_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.workflow_timer_dispatch_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.workflow_timer_activations,private.workflow_timer_dispatch_cursor FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON private.workflow_timer_activations TO service_role;
GRANT SELECT,UPDATE ON private.workflow_timer_dispatch_cursor TO service_role;
CREATE POLICY reject_client_access ON private.workflow_timer_activations AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY reject_client_access ON private.workflow_timer_dispatch_cursor AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
DO $timed_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.prorettype FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_timer_activation_insert_v1','workflow_timer_activation_identity_v1',
            'workflow_timed_candidates_v1','workflow_lock_timed_sources_v1','workflow_enroll_timed_occurrence_v1'))
            OR (n.nspname='public' AND p.proname='process_automation_workflow_occurrences_v1') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.prorettype<>'trigger'::REGTYPE THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity); END IF;
    END LOOP;
END $timed_privileges$;

-- Common sender admission. Parents retain source, render and continuation authority.
-- This section neither adopts legacy callers nor declares V57 release readiness.
CREATE FUNCTION private.automation_sender_instant_v1(p_at TIMESTAMPTZ) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT p_at BETWEEN TIMESTAMPTZ '0001-01-01 00:00:00+00' AND TIMESTAMPTZ '9999-12-31 23:59:59.999999+00'
$$;

CREATE FUNCTION private.automation_sender_preparation_result_valid_v1(p_result JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT coalesce(private.workflow_json_keys_v1(p_result,
        ARRAY['outcome','credential_revision','sender_binding','safe_reason','retry_after_seconds'],
        ARRAY['outcome','credential_revision','sender_binding','safe_reason','retry_after_seconds'])
        AND jsonb_typeof(p_result->'sender_binding')='string' AND p_result->>'sender_binding' ~ '^[a-f0-9]{64}$'
        AND CASE WHEN p_result->>'outcome'='prepared' THEN
            jsonb_typeof(p_result->'credential_revision')='number'
            AND p_result->>'credential_revision' ~ '^[1-9][0-9]{0,18}$'
            AND (p_result->>'credential_revision')::NUMERIC<=9223372036854775807
            AND p_result->'safe_reason'='null'::JSONB AND p_result->'retry_after_seconds'='null'::JSONB
        WHEN p_result->>'outcome' IN ('sender_transient','sender_auth') THEN
            p_result->'credential_revision'='null'::JSONB AND jsonb_typeof(p_result->'safe_reason')='string'
            AND p_result->>'safe_reason'=ANY(ARRAY['authentication_required','credential_refresh_conflict','credential_store_unavailable',
                'invalid_message','provider_connection_failed','provider_rejected','provider_submission_unknown','provider_throttled',
                'provider_unavailable','recipient_not_allowed','send_budget_exhausted','sending_disabled','setup_required',
                'token_refresh_invalid','token_refresh_rejected','token_refresh_throttled','token_refresh_unavailable'])
            AND (p_result->'retry_after_seconds'='null'::JSONB OR
                (jsonb_typeof(p_result->'retry_after_seconds')='number' AND p_result->>'retry_after_seconds' ~ '^[1-9][0-9]{0,3}$'
                    AND (p_result->>'retry_after_seconds')::NUMERIC<=3600))
        ELSE false END,false)
$$;

CREATE FUNCTION private.automation_legacy_projection_valid_v1(p_projection JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT coalesce(private.workflow_json_keys_v1(p_projection,ARRAY['state','reason'],ARRAY['state','reason'])
        AND jsonb_typeof(p_projection->'state')='string' AND p_projection->>'state' IN ('accepted','retry_wait','failed','unknown')
        AND (p_projection->'reason'='null'::JSONB OR (jsonb_typeof(p_projection->'reason')='string'
            AND p_projection->>'reason'=ANY(ARRAY['rule_paused','subscription_required','student_unavailable','inactive','on_hold',
                'invalid_birth_date','never_attended','recent_attendance','invalid_email','guardian_missing','guardian_ambiguous',
                'suppressed','episode_already_attempted','attendance_changed','contact_changed','lease_expired','rate_limited',
                'connection_failed','authentication_required','provider_rejected','provider_unknown','retry_exhausted','unavailable',
                'recipient_not_allowed']))),false)
$$;

CREATE FUNCTION private.automation_delivery_result_v1(p_result JSONB,p_expected_revision BIGINT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE revision BIGINT; request_id TEXT; code TEXT; valid BOOLEAN; outcome TEXT; evidence TEXT; scope TEXT;
BEGIN
    IF jsonb_typeof(p_result->'credential_revision')='number' AND p_result->>'credential_revision' ~ '^[1-9][0-9]{0,18}$' THEN
        IF (p_result->>'credential_revision')::NUMERIC<=9223372036854775807 THEN revision:=(p_result->>'credential_revision')::BIGINT; END IF;
    END IF;
    IF jsonb_typeof(p_result->'provider_request_id')='string' AND p_result->>'provider_request_id' COLLATE "C" ~ '^[A-Za-z0-9_.:-]{1,200}$' THEN
        request_id:=p_result->>'provider_request_id';
    END IF;
    outcome:=p_result->>'outcome'; evidence:=p_result->>'submission_evidence'; scope:=p_result->>'failure_scope';
    code:=p_result->>'error_code';
    IF outcome='accepted' THEN code:=NULL;
    ELSIF jsonb_typeof(p_result->'error_code') IS DISTINCT FROM 'string' OR code<>ALL(ARRAY[
        'authentication_required','credential_refresh_conflict','credential_store_unavailable','invalid_message',
        'provider_connection_failed','provider_rejected','provider_submission_unknown','provider_throttled','provider_unavailable',
        'recipient_not_allowed','send_budget_exhausted','sending_disabled','setup_required','token_refresh_invalid',
        'token_refresh_rejected','token_refresh_throttled','token_refresh_unavailable']) THEN code:='provider_unavailable'; END IF;
    valid:=private.workflow_json_keys_v1(p_result,
        ARRAY['outcome','error_code','provider_request_id','retry_after_seconds','submission_evidence','failure_scope','credential_revision'],
        ARRAY['outcome','error_code','provider_request_id','retry_after_seconds','submission_evidence','failure_scope','credential_revision'])
        AND jsonb_typeof(p_result->'outcome')='string' AND outcome IN ('accepted','retryable_failure','permanent_failure','unknown')
        AND (p_result->'credential_revision'='null'::JSONB OR revision IS NOT NULL)
        AND (p_result->'submission_evidence'='null'::JSONB OR (jsonb_typeof(p_result->'submission_evidence')='string'
            AND evidence IN ('not_submitted','rejected','accepted','unknown')))
        AND (p_result->'failure_scope'='null'::JSONB OR (jsonb_typeof(p_result->'failure_scope')='string'
            AND scope IN ('sender_auth','sender_transient','message','unclassified')));
    IF p_result->'retry_after_seconds'<>'null'::JSONB THEN
        IF jsonb_typeof(p_result->'retry_after_seconds')='number' AND p_result->>'retry_after_seconds' ~ '^[1-9][0-9]{0,4}$' THEN
            valid:=valid AND (p_result->>'retry_after_seconds')::NUMERIC<=86400;
        ELSE valid:=false; END IF;
    END IF;
    valid:=valid AND (revision IS NULL OR p_expected_revision IS NULL OR revision=p_expected_revision)
        AND CASE outcome WHEN 'accepted' THEN (evidence IS NULL OR evidence='accepted') AND scope IS NULL
            WHEN 'retryable_failure' THEN evidence IN ('not_submitted','rejected') AND scope IS DISTINCT FROM 'sender_auth'
            WHEN 'permanent_failure' THEN evidence IN ('not_submitted','rejected') ELSE false END;
    IF valid IS TRUE THEN
        RETURN p_result||jsonb_build_object('error_code',code,'provider_request_id',request_id);
    END IF;
    RETURN jsonb_build_object('outcome','unknown','error_code','provider_submission_unknown','provider_request_id',request_id,
        'retry_after_seconds',NULL,'submission_evidence','unknown','failure_scope','unclassified',
        'credential_revision',CASE WHEN p_expected_revision IS NULL OR revision=p_expected_revision THEN revision END);
END $$;

CREATE FUNCTION private.automation_legacy_delivery_result_v1(p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE code TEXT; request_id TEXT; retry INTEGER;
BEGIN
    IF NOT private.workflow_json_keys_v1(p_result,ARRAY['outcome','error_code','provider_request_id','retry_after_seconds'],
        ARRAY['outcome','error_code','provider_request_id','retry_after_seconds'])
        OR jsonb_typeof(p_result->'outcome') IS DISTINCT FROM 'string'
        OR p_result->>'outcome' NOT IN ('accepted','retryable_failure','permanent_failure','unknown') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    code:=CASE p_result->>'error_code' WHEN 'rate_limited' THEN 'provider_throttled' WHEN 'connection_failed' THEN 'provider_connection_failed'
        WHEN 'authentication_required' THEN 'authentication_required' WHEN 'provider_rejected' THEN 'provider_rejected' ELSE 'provider_unavailable' END;
    IF p_result->>'error_code'=ANY(ARRAY['authentication_required','credential_refresh_conflict','credential_store_unavailable','invalid_message',
        'provider_connection_failed','provider_rejected','provider_submission_unknown','provider_throttled','provider_unavailable',
        'recipient_not_allowed','send_budget_exhausted','sending_disabled','setup_required','token_refresh_invalid','token_refresh_rejected',
        'token_refresh_throttled','token_refresh_unavailable']) THEN code:=p_result->>'error_code'; END IF;
    IF p_result->>'outcome'='accepted' THEN code:=NULL;
    ELSIF p_result->>'outcome'='unknown' THEN code:='provider_submission_unknown'; END IF;
    IF jsonb_typeof(p_result->'provider_request_id')='string' AND p_result->>'provider_request_id' COLLATE "C" ~ '^[A-Za-z0-9_.:-]{1,200}$' THEN
        request_id:=p_result->>'provider_request_id';
    END IF;
    IF jsonb_typeof(p_result->'retry_after_seconds')='number' AND p_result->>'retry_after_seconds' ~ '^[1-9][0-9]{0,4}$' THEN
        IF (p_result->>'retry_after_seconds')::INTEGER<=86400 THEN retry:=(p_result->>'retry_after_seconds')::INTEGER; END IF;
    END IF;
    RETURN jsonb_build_object('outcome',p_result->>'outcome','error_code',code,'provider_request_id',request_id,
        'retry_after_seconds',retry,'submission_evidence',NULL,'failure_scope',NULL,'credential_revision',NULL);
END $$;

CREATE TABLE private.automation_sender_gate (
    provider_key TEXT PRIMARY KEY CHECK (provider_key='microsoft_graph:primary'),
    generation BIGINT NOT NULL CHECK (generation>0),
    mode TEXT NOT NULL CHECK (mode IN ('ready','cooldown','auth_blocked')),
    reason TEXT CHECK (reason=ANY(ARRAY['authentication_required','credential_refresh_conflict','credential_store_unavailable','invalid_message',
        'provider_connection_failed','provider_rejected','provider_submission_unknown','provider_throttled','provider_unavailable',
        'recipient_not_allowed','send_budget_exhausted','sending_disabled','setup_required','token_refresh_invalid','token_refresh_rejected',
        'token_refresh_throttled','token_refresh_unavailable','sender_rejection_unclassified'])),
    sender_binding TEXT CHECK (sender_binding ~ '^[a-f0-9]{64}$'),
    failed_credential_revision BIGINT CHECK (failed_credential_revision>0),
    transient_failures INTEGER NOT NULL CHECK (transient_failures BETWEEN 0 AND 7),
    next_probe_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(next_probe_at)),
    active_preparation_id UUID, active_probe_token UUID, active_attempt_id UUID,
    probe_expires_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(probe_expires_at)),
    updated_at TIMESTAMPTZ NOT NULL CHECK (private.automation_sender_instant_v1(updated_at)),
    CHECK ((mode='ready' AND reason IS NULL AND next_probe_at IS NULL)
        OR (mode='cooldown' AND reason IS NOT NULL AND next_probe_at IS NOT NULL)
        OR (mode='auth_blocked' AND reason IS NOT NULL AND next_probe_at IS NULL)),
    CHECK ((active_preparation_id IS NULL AND active_probe_token IS NULL AND active_attempt_id IS NULL AND probe_expires_at IS NULL)
        OR (mode<>'ready' AND active_preparation_id IS NOT NULL AND active_probe_token IS NOT NULL AND probe_expires_at IS NOT NULL))
);
CREATE TABLE private.automation_sender_preparations (
    id UUID PRIMARY KEY, provider_key TEXT NOT NULL CHECK (provider_key='microsoft_graph:primary'),
    kind TEXT NOT NULL CHECK (kind IN ('normal','cooldown_probe','synthetic_recovery')), test_scope_id UUID,
    generation BIGINT NOT NULL CHECK (generation>0), sender_binding TEXT NOT NULL CHECK (sender_binding ~ '^[a-f0-9]{64}$'),
    preparation_token UUID NOT NULL UNIQUE, probe_token UUID UNIQUE,
    created_at TIMESTAMPTZ NOT NULL CHECK (private.automation_sender_instant_v1(created_at)),
    lease_expires_at TIMESTAMPTZ NOT NULL CHECK (private.automation_sender_instant_v1(lease_expires_at)),
    state TEXT NOT NULL CHECK (state IN ('pending','prepared','failed','expired')),
    credential_revision BIGINT CHECK (credential_revision>0), result JSONB,
    settled_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(settled_at) AND settled_at>=created_at),
    consumed_by_attempt_id UUID, consumed_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(consumed_at) AND consumed_at>=created_at),
    CHECK ((kind='synthetic_recovery')=(test_scope_id IS NOT NULL)),
    CHECK (kind<>'normal' OR probe_token IS NULL), CHECK (kind<>'cooldown_probe' OR probe_token IS NOT NULL),
    CHECK (lease_expires_at=created_at+INTERVAL '60 seconds'),
    CHECK ((state IN ('pending','expired') AND credential_revision IS NULL AND result IS NULL AND settled_at IS NULL)
        OR (state IN ('prepared','failed') AND result IS NOT NULL AND settled_at IS NOT NULL
            AND private.automation_sender_preparation_result_valid_v1(result)
            AND result->>'sender_binding'=sender_binding
            AND ((state='prepared' AND credential_revision IS NOT NULL AND result->>'outcome'='prepared'
                    AND result->>'credential_revision'=credential_revision::TEXT)
                OR (state='failed' AND credential_revision IS NULL AND result->>'outcome' IN ('sender_auth','sender_transient'))))),
    CHECK ((consumed_by_attempt_id IS NULL AND consumed_at IS NULL) OR
        (consumed_by_attempt_id IS NOT NULL AND consumed_at IS NOT NULL AND probe_token IS NOT NULL AND state='prepared' AND consumed_at<lease_expires_at))
);
CREATE TABLE private.automation_email_attempt_reservations (
    id UUID PRIMARY KEY, studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    provider_key TEXT NOT NULL CHECK (provider_key='microsoft_graph:primary'),
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('legacy','workflow','test')), scope_id UUID NOT NULL,
    node_id TEXT CHECK (node_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    recipient_email TEXT NOT NULL CHECK (private.automation_normalize_email(recipient_email) IS NOT NULL
        AND private.automation_normalize_email(recipient_email)=recipient_email),
    origin TEXT NOT NULL CHECK (origin IN ('actual','legacy_settlement_upper_bound','legacy_sending_upper_bound','cutover_fallback')),
    protocol TEXT NOT NULL CHECK (protocol IN ('prepared','legacy_v1','historical')),
    state TEXT NOT NULL CHECK (state IN ('sending','accepted','failed','unknown')),
    frequency_state TEXT NOT NULL CHECK (frequency_state IN ('sending','accepted','unknown','released')),
    actual_began_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(actual_began_at)),
    attempt_number INTEGER CHECK (attempt_number BETWEEN 1 AND 3),
    conservative_anchor_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(conservative_anchor_at)),
    observed_legacy_ordinal INTEGER CHECK (observed_legacy_ordinal BETWEEN 0 AND 3),
    owner_token UUID, lease_expires_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(lease_expires_at)),
    sender_generation BIGINT CHECK (sender_generation>0), sender_binding TEXT CHECK (sender_binding ~ '^[a-f0-9]{64}$'),
    preparation_id UUID, preparation_token UUID, probe_token UUID, admitted_credential_revision BIGINT CHECK (admitted_credential_revision>0),
    settled_at TIMESTAMPTZ CHECK (private.automation_sender_instant_v1(settled_at)), result JSONB, legacy_projection JSONB,
    budget_at TIMESTAMPTZ GENERATED ALWAYS AS (coalesce(actual_began_at,conservative_anchor_at)) STORED,
    CHECK ((scope_kind='workflow')=(node_id IS NOT NULL)), CHECK (scope_kind<>'test' OR attempt_number=1),
    CHECK (frequency_state=CASE state WHEN 'failed' THEN 'released' ELSE state END),
    CHECK ((origin='actual' AND actual_began_at IS NOT NULL AND attempt_number IS NOT NULL AND owner_token IS NOT NULL
            AND lease_expires_at IS NOT NULL AND lease_expires_at=actual_began_at+INTERVAL '60 seconds'
            AND conservative_anchor_at IS NULL AND observed_legacy_ordinal IS NULL AND sender_generation IS NOT NULL
            AND ((protocol='prepared' AND sender_binding IS NOT NULL AND preparation_id IS NOT NULL AND preparation_token IS NOT NULL
                    AND admitted_credential_revision IS NOT NULL)
                OR (protocol='legacy_v1' AND scope_kind='legacy' AND sender_binding IS NULL AND preparation_id IS NULL
                    AND preparation_token IS NULL AND probe_token IS NULL AND admitted_credential_revision IS NULL)))
        OR (origin<>'actual' AND scope_kind='legacy' AND protocol='historical' AND actual_began_at IS NULL AND attempt_number IS NULL
            AND conservative_anchor_at IS NOT NULL AND observed_legacy_ordinal IS NOT NULL AND sender_generation IS NULL
            AND sender_binding IS NULL AND preparation_id IS NULL AND preparation_token IS NULL AND probe_token IS NULL
            AND admitted_credential_revision IS NULL AND (owner_token IS NULL)=(lease_expires_at IS NULL))),
    CHECK ((state='sending' AND result IS NULL AND settled_at IS NULL) OR (state<>'sending'
        AND ((origin<>'actual' AND result IS NULL) OR (result IS NOT NULL AND settled_at IS NOT NULL
            AND jsonb_typeof(result)='object' AND result->>'outcome'=CASE state WHEN 'accepted' THEN 'accepted' WHEN 'unknown' THEN 'unknown' ELSE result->>'outcome' END
            AND (state<>'failed' OR result->>'outcome' IN ('retryable_failure','permanent_failure'))
            AND (protocol<>'prepared' OR result=private.automation_delivery_result_v1(result,admitted_credential_revision))))
        AND (settled_at IS NULL OR settled_at>=coalesce(actual_began_at,conservative_anchor_at)))),
    CHECK (legacy_projection IS NULL OR (scope_kind='legacy' AND state<>'sending'
        AND private.automation_legacy_projection_valid_v1(legacy_projection)
        AND CASE state WHEN 'failed' THEN legacy_projection->>'state' IN ('failed','retry_wait') ELSE legacy_projection->>'state'=state END)),
    CHECK (result IS NULL OR (private.workflow_json_keys_v1(result,
        ARRAY['outcome','error_code','provider_request_id','retry_after_seconds','submission_evidence','failure_scope','credential_revision'],
        ARRAY['outcome','error_code','provider_request_id','retry_after_seconds','submission_evidence','failure_scope','credential_revision'])
        AND (protocol='prepared' OR (result->'credential_revision'='null'::JSONB AND
            (result=private.automation_legacy_delivery_result_v1(result-ARRAY['submission_evidence','failure_scope','credential_revision'])
                OR (state='unknown' AND result=private.automation_delivery_result_v1(result)))))))
);
CREATE INDEX automation_email_recipient_budget ON private.automation_email_attempt_reservations(studio_id,recipient_email,budget_at DESC,id)
    WHERE frequency_state IN ('sending','accepted','unknown');
CREATE UNIQUE INDEX automation_email_actual_ordinal ON private.automation_email_attempt_reservations(studio_id,scope_kind,scope_id,node_id,attempt_number)
    NULLS NOT DISTINCT WHERE origin='actual';
CREATE UNIQUE INDEX automation_email_historical_scope ON private.automation_email_attempt_reservations(studio_id,scope_id) WHERE origin<>'actual';
CREATE UNIQUE INDEX automation_email_legacy_token ON private.automation_email_attempt_reservations(studio_id,scope_id,owner_token)
    WHERE scope_kind='legacy' AND owner_token IS NOT NULL;
CREATE INDEX automation_email_scope ON private.automation_email_attempt_reservations(studio_id,scope_kind,scope_id,node_id);

CREATE FUNCTION private.automation_sender_gate_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE preparation private.automation_sender_preparations; attempt private.automation_email_attempt_reservations;
BEGIN
    IF NEW.provider_key IS DISTINCT FROM OLD.provider_key OR NEW.generation<OLD.generation THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF NEW.active_preparation_id IS NOT NULL THEN
        SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=NEW.active_preparation_id;
        IF preparation.id IS NULL OR ROW(preparation.generation,preparation.sender_binding,preparation.probe_token)
            IS DISTINCT FROM ROW(NEW.generation,NEW.sender_binding,NEW.active_probe_token) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        IF NEW.active_attempt_id IS NULL THEN
            IF preparation.consumed_by_attempt_id IS NOT NULL OR NEW.probe_expires_at IS DISTINCT FROM preparation.lease_expires_at THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
        ELSE
            SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=NEW.active_attempt_id;
            IF preparation.consumed_by_attempt_id IS DISTINCT FROM NEW.active_attempt_id
                OR (attempt.id IS NULL AND ROW(NEW.active_preparation_id,NEW.active_probe_token,NEW.active_attempt_id,NEW.probe_expires_at)
                    IS DISTINCT FROM ROW(OLD.active_preparation_id,OLD.active_probe_token,OLD.active_attempt_id,OLD.probe_expires_at))
                OR (attempt.id IS NOT NULL AND (attempt.state<>'sending'
                    OR ROW(attempt.preparation_id,attempt.preparation_token,attempt.probe_token,attempt.lease_expires_at)
                        IS DISTINCT FROM ROW(preparation.id,preparation.preparation_token,NEW.active_probe_token,NEW.probe_expires_at))) THEN
                RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_sender_gate_identity BEFORE UPDATE ON private.automation_sender_gate
    FOR EACH ROW EXECUTE FUNCTION private.automation_sender_gate_identity_v1();

CREATE FUNCTION private.automation_sender_preparation_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF (to_jsonb(NEW)-ARRAY['state','credential_revision','result','settled_at','consumed_by_attempt_id','consumed_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','credential_revision','result','settled_at','consumed_by_attempt_id','consumed_at'])
        OR (OLD.state<>'pending' AND ROW(NEW.state,NEW.credential_revision,NEW.result,NEW.settled_at)
            IS DISTINCT FROM ROW(OLD.state,OLD.credential_revision,OLD.result,OLD.settled_at))
        OR (OLD.consumed_by_attempt_id IS NOT NULL AND ROW(NEW.consumed_by_attempt_id,NEW.consumed_at)
            IS DISTINCT FROM ROW(OLD.consumed_by_attempt_id,OLD.consumed_at)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_sender_preparation_identity BEFORE UPDATE ON private.automation_sender_preparations
    FOR EACH ROW EXECUTE FUNCTION private.automation_sender_preparation_identity_v1();

CREATE FUNCTION private.automation_email_attempt_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    -- PostgreSQL computes stored generated columns after BEFORE triggers. Their
    -- immutable input clocks, rather than NEW.budget_at, prove identity here.
    IF (to_jsonb(NEW)-ARRAY['state','frequency_state','result','settled_at','legacy_projection','budget_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','frequency_state','result','settled_at','legacy_projection','budget_at'])
        OR (OLD.state<>'sending' AND ROW(NEW.state,NEW.frequency_state,NEW.result,NEW.settled_at)
            IS DISTINCT FROM ROW(OLD.state,OLD.frequency_state,OLD.result,OLD.settled_at))
        OR (OLD.legacy_projection IS NOT NULL AND NEW.legacy_projection IS DISTINCT FROM OLD.legacy_projection) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_email_attempt_identity BEFORE UPDATE ON private.automation_email_attempt_reservations
    FOR EACH ROW EXECUTE FUNCTION private.automation_email_attempt_identity_v1();

CREATE FUNCTION private.automation_sender_gate_lock_v1() RETURNS private.automation_sender_gate
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate; preparation private.automation_sender_preparations;
BEGIN
    SELECT * INTO gate FROM private.automation_sender_gate WHERE provider_key='microsoft_graph:primary' FOR UPDATE;
    IF gate.provider_key IS NULL OR gate.generation IS NULL OR gate.generation<=0 OR gate.transient_failures IS NULL
        OR gate.transient_failures NOT BETWEEN 0 AND 7 OR gate.mode IS NULL OR gate.mode NOT IN ('ready','cooldown','auth_blocked')
        OR gate.failed_credential_revision<=0
        OR (gate.sender_binding IS NOT NULL AND gate.sender_binding !~ '^[a-f0-9]{64}$')
        OR private.automation_sender_instant_v1(gate.updated_at) IS DISTINCT FROM true
        OR (gate.mode='ready' AND (gate.reason IS NOT NULL OR gate.next_probe_at IS NOT NULL OR gate.active_preparation_id IS NOT NULL))
        OR (gate.mode='cooldown' AND (gate.reason IS NULL OR private.automation_sender_instant_v1(gate.next_probe_at) IS DISTINCT FROM true))
        OR (gate.mode='auth_blocked' AND (gate.reason IS NULL OR gate.next_probe_at IS NOT NULL))
        OR (gate.active_preparation_id IS NULL AND (gate.active_probe_token IS NOT NULL OR gate.active_attempt_id IS NOT NULL OR gate.probe_expires_at IS NOT NULL))
        OR (gate.active_preparation_id IS NOT NULL AND (gate.active_probe_token IS NULL
            OR private.automation_sender_instant_v1(gate.probe_expires_at) IS DISTINCT FROM true)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
    END IF;
    IF gate.reason IS NOT NULL AND gate.reason<>'sender_rejection_unclassified'
        AND NOT private.automation_sender_preparation_result_valid_v1(jsonb_build_object('outcome','sender_transient',
            'credential_revision',NULL,'sender_binding',repeat('a',64),'safe_reason',gate.reason,'retry_after_seconds',NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
    END IF;
    IF gate.active_preparation_id IS NOT NULL THEN
        SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=gate.active_preparation_id;
        IF preparation.id IS NULL OR ROW(preparation.generation,preparation.sender_binding,preparation.probe_token,preparation.consumed_by_attempt_id)
            IS DISTINCT FROM ROW(gate.generation,gate.sender_binding,gate.active_probe_token,gate.active_attempt_id)
            OR (gate.active_attempt_id IS NULL AND gate.probe_expires_at IS DISTINCT FROM preparation.lease_expires_at) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
        END IF;
    END IF;
    RETURN gate;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
END $$;

CREATE FUNCTION private.automation_sender_retry_at_v1(p_gate private.automation_sender_gate,p_at TIMESTAMPTZ) RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT CASE WHEN p_gate.mode='cooldown' THEN greatest(p_gate.next_probe_at,p_gate.probe_expires_at,
        CASE WHEN p_gate.active_attempt_id IS NOT NULL AND p_gate.probe_expires_at<=p_at THEN p_at+INTERVAL '60 seconds' END) END
$$;

CREATE FUNCTION private.automation_sender_preparation_reply_v1(p_id UUID,p_gate private.automation_sender_gate,
    p_preparation private.automation_sender_preparations,p_outcome TEXT,p_reason TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('payload',jsonb_build_object('preparation_id',p_id,'generation',p_gate.generation,
        'preparation_token',p_preparation.preparation_token,'probe_token',p_preparation.probe_token,
        'lease_expires_at',p_preparation.lease_expires_at,'retry_at',CASE WHEN p_preparation.id IS NULL
            THEN private.automation_sender_retry_at_v1(p_gate,clock_timestamp()) END,'reason',p_reason)
        ||CASE WHEN p_outcome='claim' THEN jsonb_build_object('allowed',p_preparation.id IS NOT NULL,'mode',p_gate.mode)
            ELSE jsonb_build_object('outcome',p_outcome) END)
$$;

CREATE FUNCTION private.automation_email_scope_lock_v1(p_studio_id UUID,p_scope_kind TEXT,p_scope_id UUID,p_node_id TEXT,p_recipient TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('koaryu.automation-email-scope:'||
        jsonb_build_array(p_studio_id::TEXT,p_scope_kind,p_scope_id::TEXT,p_node_id)::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(p_studio_id::TEXT||':'||p_recipient,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
END $$;

CREATE FUNCTION private.automation_sender_failure_v1(p_scope TEXT,p_reason TEXT,p_revision BIGINT,p_retry INTEGER,p_at TIMESTAMPTZ) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    UPDATE private.automation_sender_gate SET generation=generation+1,
        mode=CASE WHEN p_scope='sender_auth' OR mode='auth_blocked' THEN 'auth_blocked' ELSE 'cooldown' END,
        reason=CASE WHEN mode='auth_blocked' AND p_scope<>'sender_auth' THEN reason ELSE p_reason END,
        failed_credential_revision=CASE WHEN mode='auth_blocked' AND p_scope<>'sender_auth' THEN failed_credential_revision ELSE p_revision END,
        transient_failures=CASE WHEN p_scope='sender_auth' THEN transient_failures ELSE least(7,transient_failures+1) END,
        next_probe_at=CASE WHEN p_scope<>'sender_auth' AND mode<>'auth_blocked' THEN greatest(next_probe_at,
            p_at+make_interval(secs=>least(3600,greatest(60*(2^transient_failures)::INTEGER,coalesce(p_retry,0))))) END,
        active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL,updated_at=p_at
        WHERE provider_key='microsoft_graph:primary';
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE'; END IF;
END $$;

CREATE FUNCTION private.automation_sender_release_probe_v1(p_preparation_id UUID,p_preparation_token UUID,p_probe_token UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate; preparation private.automation_sender_preparations; at TIMESTAMPTZ;
BEGIN
    gate:=private.automation_sender_gate_lock_v1();
    SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=p_preparation_id FOR UPDATE;
    at:=clock_timestamp();
    IF preparation.id IS NULL OR p_preparation_token IS NULL OR p_probe_token IS NULL
        OR preparation.preparation_token IS DISTINCT FROM p_preparation_token OR preparation.probe_token IS DISTINCT FROM p_probe_token
        OR preparation.consumed_by_attempt_id IS NOT NULL OR gate.active_attempt_id IS NOT NULL
        OR gate.active_preparation_id IS DISTINCT FROM p_preparation_id OR gate.active_probe_token IS DISTINCT FROM p_probe_token THEN RETURN false; END IF;
    UPDATE private.automation_sender_gate SET active_preparation_id=NULL,active_probe_token=NULL,probe_expires_at=NULL,updated_at=at
        WHERE provider_key=gate.provider_key;
    IF preparation.state='pending' AND preparation.lease_expires_at<=at THEN
        UPDATE private.automation_sender_preparations SET state='expired' WHERE id=preparation.id;
    END IF;
    RETURN true;
END $$;

CREATE FUNCTION private.automation_sender_release_orphan_probe_v1() RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate; at TIMESTAMPTZ;
BEGIN
    gate:=private.automation_sender_gate_lock_v1(); at:=clock_timestamp();
    IF gate.active_attempt_id IS NULL OR gate.probe_expires_at>at OR EXISTS(
        SELECT 1 FROM private.automation_email_attempt_reservations WHERE id=gate.active_attempt_id) THEN RETURN false; END IF;
    UPDATE private.automation_sender_gate SET active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,
        probe_expires_at=NULL,updated_at=at WHERE provider_key=gate.provider_key;
    RETURN true;
END $$;

CREATE FUNCTION private.automation_sender_claim_v1(p_preparation_id UUID,p_sender_binding TEXT,
    p_kind TEXT DEFAULT 'normal',p_test_scope_id UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate; preparation private.automation_sender_preparations;
    prior private.automation_sender_preparations; at TIMESTAMPTZ; kind TEXT; probe UUID; revision BIGINT;
BEGIN
    IF p_preparation_id IS NULL OR p_sender_binding IS NULL OR p_sender_binding !~ '^[a-f0-9]{64}$'
        OR p_kind IS NULL OR p_kind NOT IN ('normal','synthetic_recovery') OR (p_kind='synthetic_recovery')<>(p_test_scope_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- Acquire credential ownership before the gate even if a pending preparation
    -- settles while this claim waits. Fresh/pending claims do not require a row.
    SELECT c.revision INTO revision FROM private.automation_email_credentials c
        WHERE c.provider_key='microsoft_graph:primary' FOR SHARE NOWAIT;
    gate:=private.automation_sender_gate_lock_v1();
    SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=p_preparation_id FOR UPDATE;
    IF preparation.id IS NOT NULL THEN
        IF preparation.sender_binding<>p_sender_binding OR preparation.test_scope_id IS DISTINCT FROM p_test_scope_id
            OR (preparation.kind='synthetic_recovery')<>(p_kind='synthetic_recovery') THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        at:=clock_timestamp();
        IF preparation.generation=gate.generation AND preparation.sender_binding=gate.sender_binding AND preparation.lease_expires_at>at
            AND preparation.state IN ('pending','prepared') AND preparation.consumed_by_attempt_id IS NULL
            AND (preparation.state='pending' OR preparation.credential_revision=revision)
            AND ((preparation.probe_token IS NULL AND gate.mode='ready') OR
                (preparation.probe_token IS NOT NULL AND gate.active_preparation_id=preparation.id
                    AND gate.active_probe_token=preparation.probe_token AND gate.active_attempt_id IS NULL)) THEN
            RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,preparation,'claim',NULL);
        END IF;
        RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,'claim','preparation_stale');
    END IF;
    IF gate.sender_binding IS DISTINCT FROM p_sender_binding THEN
        UPDATE private.automation_sender_gate SET sender_binding=p_sender_binding,
            generation=generation+CASE WHEN sender_binding IS NULL THEN 0 ELSE 1 END,
            active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL,updated_at=clock_timestamp()
            WHERE provider_key=gate.provider_key RETURNING * INTO gate;
    END IF;
    PERFORM private.automation_sender_release_orphan_probe_v1();
    gate:=private.automation_sender_gate_lock_v1(); at:=clock_timestamp();
    IF gate.active_preparation_id IS NOT NULL AND gate.active_attempt_id IS NULL AND gate.probe_expires_at<=at THEN
        SELECT * INTO prior FROM private.automation_sender_preparations WHERE id=gate.active_preparation_id;
        PERFORM private.automation_sender_release_probe_v1(prior.id,prior.preparation_token,gate.active_probe_token);
        gate:=private.automation_sender_gate_lock_v1(); at:=clock_timestamp();
    END IF;
    IF (gate.mode='auth_blocked' AND p_kind='normal') OR gate.active_preparation_id IS NOT NULL
        OR (gate.mode='cooldown' AND gate.next_probe_at>at) THEN
        RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,'claim','sender_unavailable');
    END IF;
    kind:=CASE WHEN p_kind='synthetic_recovery' THEN p_kind WHEN gate.mode='cooldown' THEN 'cooldown_probe' ELSE 'normal' END;
    IF gate.mode<>'ready' THEN probe:=gen_random_uuid(); END IF;
    INSERT INTO private.automation_sender_preparations(id,provider_key,kind,test_scope_id,generation,sender_binding,preparation_token,
        probe_token,created_at,lease_expires_at,state)
        VALUES(p_preparation_id,gate.provider_key,kind,p_test_scope_id,gate.generation,p_sender_binding,gen_random_uuid(),probe,at,at+INTERVAL '60 seconds','pending')
        RETURNING * INTO preparation;
    IF probe IS NOT NULL THEN
        UPDATE private.automation_sender_gate SET active_preparation_id=preparation.id,active_probe_token=probe,
            probe_expires_at=preparation.lease_expires_at,updated_at=at WHERE provider_key=gate.provider_key RETURNING * INTO gate;
    END IF;
    RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,preparation,'claim',NULL);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    WHEN undefined_table OR undefined_column THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
END $$;

CREATE FUNCTION public.claim_automation_sender_preparation_v1(p_provider_key TEXT,p_preparation_id UUID,p_sender_binding TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_provider_key IS DISTINCT FROM 'microsoft_graph:primary' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    RETURN private.automation_sender_claim_v1(p_preparation_id,p_sender_binding);
END $$;

CREATE FUNCTION private.automation_sender_preparation_settle_v1(p_preparation_id UUID,p_preparation_token UUID,p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate; preparation private.automation_sender_preparations; revision BIGINT; at TIMESTAMPTZ; outcome TEXT;
BEGIN
    IF p_preparation_id IS NULL OR p_preparation_token IS NULL OR NOT private.automation_sender_preparation_result_valid_v1(p_result) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF p_result->>'outcome'='prepared' THEN
        SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE c.provider_key='microsoft_graph:primary' FOR SHARE NOWAIT;
    END IF;
    gate:=private.automation_sender_gate_lock_v1();
    SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=p_preparation_id FOR UPDATE;
    at:=clock_timestamp();
    IF preparation.id IS NULL OR preparation.preparation_token IS DISTINCT FROM p_preparation_token
        OR preparation.sender_binding IS DISTINCT FROM p_result->>'sender_binding'
        OR (preparation.result IS NOT NULL AND preparation.result IS DISTINCT FROM p_result) THEN
        RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,'stale','preparation_stale');
    END IF;
    IF preparation.state='failed' THEN
        outcome:=CASE gate.mode WHEN 'auth_blocked' THEN 'blocked' WHEN 'cooldown' THEN 'deferred' ELSE 'stale' END;
        RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,outcome,
            CASE WHEN outcome='stale' THEN 'preparation_stale' ELSE 'sender_unavailable' END);
    END IF;
    IF preparation.state='expired' OR preparation.lease_expires_at<=at OR preparation.consumed_by_attempt_id IS NOT NULL
        OR (p_result->>'outcome'='prepared' AND (preparation.generation<>gate.generation
            OR preparation.sender_binding IS DISTINCT FROM gate.sender_binding
            OR (preparation.probe_token IS NULL AND gate.mode<>'ready') OR (preparation.probe_token IS NOT NULL AND
                (gate.active_preparation_id IS DISTINCT FROM preparation.id OR gate.active_probe_token IS DISTINCT FROM preparation.probe_token OR gate.active_attempt_id IS NOT NULL))
            OR revision IS DISTINCT FROM (p_result->>'credential_revision')::BIGINT)) THEN
        RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,'stale','preparation_stale');
    END IF;
    IF preparation.state='pending' THEN
        UPDATE private.automation_sender_preparations SET state=CASE WHEN p_result->>'outcome'='prepared' THEN 'prepared' ELSE 'failed' END,
            credential_revision=CASE WHEN p_result->>'outcome'='prepared' THEN revision END,result=p_result,settled_at=at
            WHERE id=preparation.id RETURNING * INTO preparation;
        IF preparation.state='failed' THEN
            PERFORM private.automation_sender_failure_v1(p_result->>'outcome',p_result->>'safe_reason',NULL,(p_result->>'retry_after_seconds')::INTEGER,at);
            gate:=private.automation_sender_gate_lock_v1();
        END IF;
    END IF;
    outcome:=CASE WHEN preparation.state='prepared' THEN 'prepared' WHEN gate.mode='auth_blocked' THEN 'blocked' ELSE 'deferred' END;
    RETURN private.automation_sender_preparation_reply_v1(p_preparation_id,gate,
        CASE WHEN outcome='prepared' THEN preparation END,outcome,CASE WHEN outcome<>'prepared' THEN 'sender_unavailable' END);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    WHEN undefined_table OR undefined_column THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
END $$;

CREATE FUNCTION public.settle_automation_sender_preparation_v1(p_preparation_id UUID,p_preparation_token UUID,p_result JSONB) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
    SELECT private.automation_sender_preparation_settle_v1(p_preparation_id,p_preparation_token,p_result)
$$;

CREATE FUNCTION private.automation_email_attempt_begin_v1(p_studio_id UUID,p_scope_kind TEXT,p_scope_id UUID,p_node_id TEXT,
    p_attempt_id UUID,p_owner_token UUID,p_recipient_email TEXT,p_preparation_id UUID,p_preparation_token UUID,
    p_probe_token UUID DEFAULT NULL,p_legacy_prior_attempts INTEGER DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate; preparation private.automation_sender_preparations;
    attempt private.automation_email_attempt_reservations; revision BIGINT; at TIMESTAMPTZ; ordinal INTEGER; prior INTEGER;
    charged TIMESTAMPTZ[]; retry TIMESTAMPTZ; reason TEXT; protocol TEXT; terminal BOOLEAN;
BEGIN
    IF p_studio_id IS NULL OR p_scope_id IS NULL OR p_attempt_id IS NULL OR p_owner_token IS NULL OR p_scope_kind IS NULL
        OR p_scope_kind NOT IN ('legacy','workflow','test') OR (p_scope_kind='workflow')<>(p_node_id IS NOT NULL)
        OR (p_node_id IS NOT NULL AND p_node_id !~ '^[A-Za-z0-9_-]{1,64}$')
        OR private.automation_normalize_email(p_recipient_email) IS NULL
        OR private.automation_normalize_email(p_recipient_email) IS DISTINCT FROM p_recipient_email
        OR (p_preparation_id IS NULL)<>(p_preparation_token IS NULL)
        OR (p_preparation_id IS NULL AND (p_scope_kind<>'legacy' OR p_probe_token IS NOT NULL))
        OR (p_scope_kind='legacy' AND (p_legacy_prior_attempts IS NULL OR p_legacy_prior_attempts NOT BETWEEN 0 AND 2))
        OR (p_scope_kind<>'legacy' AND p_legacy_prior_attempts IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- Establish FK ownership before scope/recipient/credential/gate. Never wait backward.
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    PERFORM private.automation_email_scope_lock_v1(p_studio_id,p_scope_kind,p_scope_id,p_node_id,p_recipient_email);
    IF p_preparation_id IS NOT NULL THEN
        SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE c.provider_key='microsoft_graph:primary' FOR SHARE NOWAIT;
    END IF;
    gate:=private.automation_sender_gate_lock_v1();
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id FOR UPDATE;
    protocol:=CASE WHEN p_preparation_id IS NULL THEN 'legacy_v1' ELSE 'prepared' END;
    IF attempt.id IS NOT NULL THEN
        IF ROW(attempt.studio_id,attempt.scope_kind,attempt.scope_id,attempt.node_id,attempt.owner_token,attempt.recipient_email,
            attempt.preparation_id,attempt.preparation_token,attempt.probe_token,attempt.protocol,attempt.origin)
            IS DISTINCT FROM ROW(p_studio_id,p_scope_kind,p_scope_id,p_node_id,p_owner_token,p_recipient_email,
                p_preparation_id,p_preparation_token,p_probe_token,protocol,'actual'::TEXT) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
        END IF;
        RETURN jsonb_build_object('outcome','already_begun','attempt_id',attempt.id,'attempt_number',attempt.attempt_number,
            'owner_token',NULL,'lease_expires_at',NULL,'generation',NULL,'reason','already_begun','retry_at',NULL);
    END IF;
    IF p_scope_kind='legacy' AND EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations a
        WHERE a.studio_id=p_studio_id AND a.scope_kind='legacy' AND a.scope_id=p_scope_id AND a.owner_token=p_owner_token) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    SELECT coalesce(max(coalesce(a.attempt_number,a.observed_legacy_ordinal)),0),coalesce(bool_or(a.state IN ('sending','accepted','unknown')),false)
        INTO prior,terminal FROM private.automation_email_attempt_reservations a
        WHERE a.studio_id=p_studio_id AND a.scope_kind=p_scope_kind AND a.scope_id=p_scope_id AND a.node_id IS NOT DISTINCT FROM p_node_id;
    IF p_scope_kind='legacy' THEN
        IF p_legacy_prior_attempts<prior THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
        prior:=p_legacy_prior_attempts;
    END IF;
    IF p_preparation_id IS NOT NULL THEN
        SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=p_preparation_id FOR UPDATE;
    END IF;
    at:=clock_timestamp(); ordinal:=prior+1;
    IF terminal THEN reason:='scope_terminal';
    ELSIF ordinal>(CASE WHEN p_scope_kind='test' THEN 1 ELSE 3 END) THEN reason:='retry_exhausted';
    ELSIF EXISTS(SELECT 1 FROM public.automation_suppressions WHERE studio_id=p_studio_id AND recipient_email=p_recipient_email) THEN reason:='recipient_suppressed';
    ELSIF protocol='legacy_v1' AND gate.mode<>'ready' THEN
        reason:='sender_unavailable'; retry:=private.automation_sender_retry_at_v1(gate,at);
    ELSIF protocol='prepared' AND (preparation.id IS NULL OR preparation.state<>'prepared'
        OR preparation.preparation_token IS DISTINCT FROM p_preparation_token OR preparation.probe_token IS DISTINCT FROM p_probe_token
        OR preparation.generation<>gate.generation OR preparation.sender_binding IS DISTINCT FROM gate.sender_binding
        OR preparation.credential_revision IS DISTINCT FROM revision OR preparation.lease_expires_at<=at OR preparation.consumed_by_attempt_id IS NOT NULL
        OR (preparation.kind='synthetic_recovery')<>(p_scope_kind='test')
        OR (p_scope_kind='test' AND preparation.test_scope_id IS DISTINCT FROM p_scope_id)
        OR (p_probe_token IS NULL AND gate.mode<>'ready')
        OR (p_probe_token IS NOT NULL AND (gate.active_preparation_id IS DISTINCT FROM p_preparation_id
            OR gate.active_probe_token IS DISTINCT FROM p_probe_token OR gate.active_attempt_id IS NOT NULL))) THEN reason:='preparation_stale';
    ELSE
        SELECT array_agg(budget_at ORDER BY budget_at DESC,id) INTO charged FROM (
            SELECT budget_at,id FROM private.automation_email_attempt_reservations
            WHERE studio_id=p_studio_id AND recipient_email=p_recipient_email AND frequency_state IN ('sending','accepted','unknown')
                AND budget_at>at-INTERVAL '24 hours' ORDER BY budget_at DESC,id LIMIT 3) recent;
        retry:=greatest(charged[1]+INTERVAL '60 minutes',charged[3]+INTERVAL '24 hours');
        IF retry>at THEN reason:='rate_limited'; ELSE retry:=NULL; END IF;
    END IF;
    IF reason IS NOT NULL THEN
        RETURN jsonb_build_object('outcome','denied','attempt_id',NULL,'attempt_number',NULL,'owner_token',NULL,
            'lease_expires_at',NULL,'generation',NULL,'reason',reason,'retry_at',retry);
    END IF;
    INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,node_id,recipient_email,
        origin,protocol,state,frequency_state,actual_began_at,attempt_number,owner_token,lease_expires_at,sender_generation,sender_binding,
        preparation_id,preparation_token,probe_token,admitted_credential_revision)
        VALUES(p_attempt_id,p_studio_id,gate.provider_key,p_scope_kind,p_scope_id,p_node_id,p_recipient_email,'actual',protocol,'sending','sending',
            at,ordinal,p_owner_token,at+INTERVAL '60 seconds',gate.generation,preparation.sender_binding,p_preparation_id,p_preparation_token,
            p_probe_token,preparation.credential_revision) RETURNING * INTO attempt;
    IF p_probe_token IS NOT NULL THEN
        UPDATE private.automation_sender_preparations SET consumed_by_attempt_id=attempt.id,consumed_at=at WHERE id=preparation.id;
        UPDATE private.automation_sender_gate SET active_attempt_id=attempt.id,probe_expires_at=attempt.lease_expires_at,updated_at=at
            WHERE provider_key=gate.provider_key;
    END IF;
    RETURN jsonb_build_object('outcome','begun','attempt_id',attempt.id,'attempt_number',attempt.attempt_number,'owner_token',attempt.owner_token,
        'lease_expires_at',attempt.lease_expires_at,'generation',attempt.sender_generation,'reason',NULL,'retry_at',NULL);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    WHEN undefined_table OR undefined_column THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
END $$;

CREATE FUNCTION private.automation_email_attempt_settle_v1(p_attempt_id UUID,p_owner_token UUID,p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
<<settlement>>
DECLARE attempt private.automation_email_attempt_reservations; gate private.automation_sender_gate;
    preparation private.automation_sender_preparations; revision BIGINT; result JSONB; at TIMESTAMPTZ; state TEXT;
    owns_probe BOOLEAN; recovery BOOLEAN; expired BOOLEAN; outcome TEXT:='confirmed';
    refused JSONB:=jsonb_build_object('outcome','refused','attempt_id',p_attempt_id,'state',NULL,'result',NULL,'settled_at',NULL);
BEGIN
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id;
    IF attempt.id IS NULL OR p_owner_token IS NULL OR attempt.owner_token IS DISTINCT FROM p_owner_token THEN RETURN refused; END IF;
    PERFORM private.automation_email_scope_lock_v1(attempt.studio_id,attempt.scope_kind,attempt.scope_id,attempt.node_id,attempt.recipient_email);
    IF attempt.protocol='prepared' THEN
        SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE c.provider_key=attempt.provider_key FOR SHARE NOWAIT;
    END IF;
    gate:=private.automation_sender_gate_lock_v1();
    IF attempt.preparation_id IS NOT NULL THEN
        SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=attempt.preparation_id FOR UPDATE;
    END IF;
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id FOR UPDATE;
    at:=clock_timestamp();
    IF attempt.id IS NULL OR attempt.owner_token IS DISTINCT FROM p_owner_token THEN RETURN refused; END IF;
    IF attempt.protocol='prepared' THEN result:=private.automation_delivery_result_v1(p_result,attempt.admitted_credential_revision);
    ELSE result:=private.automation_legacy_delivery_result_v1(p_result); END IF;
    IF attempt.state<>'sending' THEN
        IF attempt.result IS DISTINCT FROM result THEN RETURN refused; END IF;
        RETURN jsonb_build_object('outcome','replayed','attempt_id',attempt.id,'state',attempt.state,'result',attempt.result,'settled_at',attempt.settled_at);
    END IF;
    IF attempt.lease_expires_at IS NULL THEN RETURN refused; END IF;
    expired:=attempt.lease_expires_at<=at;
    IF expired THEN
        result:=private.automation_delivery_result_v1(NULL,attempt.admitted_credential_revision);
    END IF;
    state:=CASE result->>'outcome' WHEN 'accepted' THEN 'accepted' WHEN 'unknown' THEN 'unknown' ELSE 'failed' END;
    owns_probe:=attempt.probe_token IS NOT NULL AND ROW(gate.active_attempt_id,gate.active_preparation_id,gate.active_probe_token,gate.probe_expires_at)
        IS NOT DISTINCT FROM ROW(attempt.id,attempt.preparation_id,attempt.probe_token,attempt.lease_expires_at);
    recovery:=owns_probe AND NOT expired AND result->>'outcome'='accepted' AND result->>'submission_evidence'='accepted'
        AND attempt.sender_generation=gate.generation AND attempt.sender_binding=gate.sender_binding
        AND (result->>'credential_revision')::BIGINT=attempt.admitted_credential_revision AND revision=attempt.admitted_credential_revision
        AND preparation.consumed_by_attempt_id=attempt.id AND preparation.preparation_token=attempt.preparation_token
        AND (gate.mode='cooldown' OR (gate.mode='auth_blocked' AND preparation.kind='synthetic_recovery'));
    UPDATE private.automation_email_attempt_reservations SET state=settlement.state,
        frequency_state=CASE WHEN settlement.state='failed' THEN 'released' ELSE settlement.state END,
        result=settlement.result,settled_at=at WHERE id=attempt.id RETURNING * INTO attempt;
    IF recovery IS TRUE THEN
        UPDATE private.automation_sender_gate SET mode='ready',reason=NULL,next_probe_at=NULL,transient_failures=0,
            active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL,updated_at=at WHERE provider_key=gate.provider_key;
    ELSIF owns_probe THEN
        UPDATE private.automation_sender_gate SET active_preparation_id=NULL,active_probe_token=NULL,active_attempt_id=NULL,
            probe_expires_at=NULL,updated_at=at WHERE provider_key=gate.provider_key;
    END IF;
    -- Terminal pointer cleanup above never changes failure evidence. A new provider
    -- observation separately fences all earlier preparation and probe generations.
    IF state='unknown' AND attempt.origin='actual' THEN
        PERFORM private.automation_sender_failure_v1('sender_transient','provider_submission_unknown',
            (result->>'credential_revision')::BIGINT,NULL,at);
    ELSIF state='failed' AND attempt.protocol='prepared' AND result->>'failure_scope' IS DISTINCT FROM 'message' THEN
        PERFORM private.automation_sender_failure_v1(CASE WHEN result->>'failure_scope'='sender_auth' THEN 'sender_auth' ELSE 'sender_transient' END,
            result->>'error_code',(result->>'credential_revision')::BIGINT,(result->>'retry_after_seconds')::INTEGER,at);
    ELSIF state='failed' AND attempt.protocol<>'prepared' THEN
        PERFORM private.automation_sender_failure_v1(CASE WHEN result->>'outcome'='permanent_failure' THEN 'sender_auth' ELSE 'sender_transient' END,
            CASE WHEN result->>'outcome'='permanent_failure' THEN 'sender_rejection_unclassified' ELSE result->>'error_code' END,
            NULL,(result->>'retry_after_seconds')::INTEGER,at);
    END IF;
    RETURN jsonb_build_object('outcome',outcome,'attempt_id',attempt.id,'state',attempt.state,'result',attempt.result,'settled_at',attempt.settled_at);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    WHEN undefined_table OR undefined_column THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
END $$;

CREATE FUNCTION private.automation_email_attempt_expire_v1(p_attempt_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE attempt private.automation_email_attempt_reservations; result JSONB;
BEGIN
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id;
    IF attempt.id IS NULL OR attempt.state<>'sending' OR attempt.lease_expires_at IS NULL OR attempt.lease_expires_at>clock_timestamp() THEN
        RETURN jsonb_build_object('outcome','refused','attempt_id',p_attempt_id,'state',NULL,'result',NULL,'settled_at',NULL);
    END IF;
    result:=CASE WHEN attempt.protocol='prepared' THEN private.automation_delivery_result_v1(NULL)
        ELSE jsonb_build_object('outcome','unknown','error_code',NULL,'provider_request_id',NULL,'retry_after_seconds',NULL) END;
    RETURN private.automation_email_attempt_settle_v1(attempt.id,attempt.owner_token,result);
END $$;

CREATE FUNCTION private.automation_legacy_projection_pin_v1(p_attempt_id UUID,p_owner_token UUID,p_projection JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE attempt private.automation_email_attempt_reservations;
BEGIN
    IF NOT private.automation_legacy_projection_valid_v1(p_projection) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id FOR UPDATE NOWAIT;
    IF attempt.id IS NULL OR attempt.scope_kind<>'legacy' OR attempt.state='sending' OR attempt.owner_token IS DISTINCT FROM p_owner_token
        OR (attempt.state='failed' AND p_projection->>'state' NOT IN ('failed','retry_wait'))
        OR (attempt.state<>'failed' AND p_projection->>'state'<>attempt.state)
        OR (attempt.legacy_projection IS NOT NULL AND attempt.legacy_projection IS DISTINCT FROM p_projection) THEN RETURN false; END IF;
    IF attempt.legacy_projection IS NULL THEN
        UPDATE private.automation_email_attempt_reservations SET legacy_projection=p_projection WHERE id=attempt.id;
    END IF;
    RETURN true;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

INSERT INTO private.automation_sender_gate(provider_key,generation,mode,transient_failures,updated_at)
    VALUES('microsoft_graph:primary',1,'ready',0,clock_timestamp());
ALTER TABLE private.automation_sender_gate OWNER TO postgres;
ALTER TABLE private.automation_sender_preparations OWNER TO postgres;
ALTER TABLE private.automation_email_attempt_reservations OWNER TO postgres;
ALTER TABLE private.automation_sender_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_sender_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_email_attempt_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.automation_sender_gate,private.automation_sender_preparations,private.automation_email_attempt_reservations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,UPDATE ON private.automation_sender_gate TO service_role;
GRANT SELECT,INSERT,UPDATE ON private.automation_sender_preparations,private.automation_email_attempt_reservations TO service_role;
CREATE POLICY reject_client_access ON private.automation_sender_gate AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY reject_client_access ON private.automation_sender_preparations AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY reject_client_access ON private.automation_email_attempt_reservations AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
DO $sender_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.prorettype FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_sender_instant_v1','automation_sender_preparation_result_valid_v1',
            'automation_legacy_projection_valid_v1','automation_legacy_delivery_result_v1','automation_sender_gate_identity_v1',
            'automation_sender_preparation_identity_v1','automation_email_attempt_identity_v1','automation_sender_gate_lock_v1',
            'automation_sender_retry_at_v1','automation_sender_preparation_reply_v1','automation_email_scope_lock_v1','automation_sender_failure_v1',
            'automation_sender_claim_v1','automation_sender_preparation_settle_v1','automation_delivery_result_v1',
            'automation_email_attempt_begin_v1','automation_email_attempt_settle_v1','automation_email_attempt_expire_v1',
            'automation_legacy_projection_pin_v1','automation_sender_release_probe_v1','automation_sender_release_orphan_probe_v1'))
            OR (n.nspname='public' AND p.proname IN ('claim_automation_sender_preparation_v1','settle_automation_sender_preparation_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.prorettype<>'trigger'::REGTYPE THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity); END IF;
    END LOOP;
END $sender_privileges$;

-- Advisory provider state only. Configuration/codec checks remain server-owned;
-- this read neither claims a probe nor refreshes, expires, repairs or binds one.
CREATE FUNCTION public.get_automation_sender_status_v1(p_provider_key TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE gate private.automation_sender_gate;
BEGIN
    IF p_provider_key IS DISTINCT FROM 'microsoft_graph:primary' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    SELECT * INTO gate FROM private.automation_sender_gate WHERE provider_key=p_provider_key;
    IF gate.provider_key IS NULL OR gate.generation IS NULL OR gate.generation<=0 OR gate.transient_failures IS NULL
        OR gate.transient_failures NOT BETWEEN 0 AND 7 OR gate.failed_credential_revision<=0
        OR gate.mode IS NULL OR gate.mode NOT IN ('ready','cooldown','auth_blocked')
        OR (gate.sender_binding IS NOT NULL AND gate.sender_binding !~ '^[a-f0-9]{64}$')
        OR private.automation_sender_instant_v1(gate.updated_at) IS DISTINCT FROM true
        OR (gate.mode='ready' AND (gate.reason IS NOT NULL OR gate.next_probe_at IS NOT NULL OR gate.active_preparation_id IS NOT NULL))
        OR (gate.mode='cooldown' AND (gate.reason IS NULL OR private.automation_sender_instant_v1(gate.next_probe_at) IS DISTINCT FROM true))
        OR (gate.mode='auth_blocked' AND (gate.reason IS NULL OR gate.next_probe_at IS NOT NULL))
        OR (gate.active_preparation_id IS NULL AND (gate.active_probe_token IS NOT NULL OR gate.active_attempt_id IS NOT NULL OR gate.probe_expires_at IS NOT NULL))
        OR (gate.active_preparation_id IS NOT NULL AND (gate.active_probe_token IS NULL
            OR private.automation_sender_instant_v1(gate.probe_expires_at) IS DISTINCT FROM true)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
    END IF;
    IF gate.reason IS NOT NULL AND gate.reason<>'sender_rejection_unclassified'
        AND NOT private.automation_sender_preparation_result_valid_v1(jsonb_build_object('outcome','sender_transient',
            'credential_revision',NULL,'sender_binding',repeat('a',64),'safe_reason',gate.reason,'retry_after_seconds',NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
    END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('mode',gate.mode,'reason',gate.reason));
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
END $$;
ALTER FUNCTION public.get_automation_sender_status_v1(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_automation_sender_status_v1(TEXT) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_automation_sender_status_v1(TEXT) TO service_role;

-- Legacy attendance delivery adopts the common sender without retaining payloads
-- after its existing student cascade. The installation snapshot and late guards
-- are one transaction; a busy delivery writer aborts installation immediately.
DO $migration_lock$
BEGIN
    LOCK TABLE public.automation_deliveries IN ACCESS EXCLUSIVE MODE NOWAIT;
END;
$migration_lock$;

CREATE TABLE private.automation_unsubscribe_token_bindings (
    token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL CHECK (private.automation_normalize_email(recipient_email) IS NOT NULL
        AND private.automation_normalize_email(recipient_email)=recipient_email),
    created_at TIMESTAMPTZ NOT NULL CHECK (private.automation_sender_instant_v1(created_at))
);
CREATE INDEX automation_email_attempts_legacy_expiry
    ON private.automation_email_attempt_reservations(lease_expires_at,id)
    WHERE scope_kind='legacy' AND state='sending';

CREATE FUNCTION private.automation_unsubscribe_binding_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Automation unsubscribe identity is immutable.';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_unsubscribe_binding_identity BEFORE UPDATE ON private.automation_unsubscribe_token_bindings
    FOR EACH ROW EXECUTE FUNCTION private.automation_unsubscribe_binding_identity_v1();

CREATE FUNCTION private.automation_bind_unsubscribe_token_v1(p_studio_id UUID,p_token TEXT,p_recipient_email TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE binding private.automation_unsubscribe_token_bindings; v_hash TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$'
        OR private.automation_normalize_email(p_recipient_email) IS NULL
        OR private.automation_normalize_email(p_recipient_email) IS DISTINCT FROM p_recipient_email THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    v_hash:=encode(extensions.digest(p_token,'sha256'),'hex');
    SELECT * INTO binding FROM private.automation_unsubscribe_token_bindings b WHERE b.token_hash=v_hash;
    IF binding.token_hash IS NULL THEN
        -- Callers already own their studio. The NOWAIT also makes late callbacks
        -- refuse a concurrent studio cascade instead of acquiring backward.
        PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
        INSERT INTO private.automation_unsubscribe_token_bindings VALUES(v_hash,p_studio_id,p_recipient_email,clock_timestamp())
            ON CONFLICT DO NOTHING;
        SELECT * INTO binding FROM private.automation_unsubscribe_token_bindings b WHERE b.token_hash=v_hash;
    END IF;
    IF ROW(binding.studio_id,binding.recipient_email) IS DISTINCT FROM ROW(p_studio_id,p_recipient_email) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Automation unsubscribe binding conflict.';
    END IF;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

DO $legacy_snapshot$
DECLARE d public.automation_deliveries; cutover TIMESTAMPTZ:=clock_timestamp(); anchor TIMESTAMPTZ;
    origin TEXT; token UUID; lease TIMESTAMPTZ;
BEGIN
    FOR d IN SELECT * FROM public.automation_deliveries ORDER BY studio_id,id LOOP
        PERFORM 1 FROM public.studios WHERE id=d.studio_id FOR KEY SHARE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION 'AUTOMATION_LEGACY_PARENT_MISMATCH'; END IF;
        IF d.attempted_at IS NOT NULL AND d.unsubscribe_token ~ '^[a-f0-9]{64}$' THEN
            PERFORM private.automation_bind_unsubscribe_token_v1(d.studio_id,d.unsubscribe_token,d.original_recipient_email);
        END IF;
        IF d.state NOT IN ('sending','accepted','unknown') THEN CONTINUE; END IF;
        IF private.automation_normalize_email(d.original_recipient_email) IS NULL
            OR private.automation_normalize_email(d.original_recipient_email) IS DISTINCT FROM d.original_recipient_email THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_LEGACY_RECIPIENT_MISMATCH';
        END IF;
        anchor:=cutover; origin:='cutover_fallback'; token:=NULL; lease:=NULL;
        IF d.state='sending' AND d.attempts>0 AND d.claim_token IS NOT NULL
            AND private.automation_sender_instant_v1(d.lease_expires_at) IS TRUE THEN
            token:=d.claim_token; lease:=d.lease_expires_at;
        END IF;
        IF private.automation_sender_instant_v1(d.attempted_at) IS TRUE THEN
            IF d.state IN ('accepted','unknown') AND private.automation_sender_instant_v1(d.settled_at) IS TRUE
                AND d.attempted_at<=d.settled_at AND d.settled_at<=cutover THEN
                anchor:=d.settled_at; origin:='legacy_settlement_upper_bound';
            ELSIF d.state='sending' AND token IS NOT NULL AND private.automation_sender_instant_v1(d.updated_at) IS TRUE
                AND d.attempted_at<=d.updated_at AND d.updated_at<=cutover THEN
                anchor:=d.updated_at; origin:='legacy_sending_upper_bound';
            END IF;
        END IF;
        INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,
            recipient_email,origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal,
            owner_token,lease_expires_at,legacy_projection)
        VALUES(gen_random_uuid(),d.studio_id,'microsoft_graph:primary','legacy',d.id,d.original_recipient_email,
            origin,'historical',d.state,d.state,anchor,d.attempts,token,lease,
            CASE WHEN d.state<>'sending' THEN jsonb_build_object('state',d.state,'reason',d.reason) END);
    END LOOP;
END $legacy_snapshot$;

CREATE FUNCTION private.automation_legacy_terminal_v1(p_result JSONB,p_attempts INTEGER) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('state',CASE p_result->>'outcome' WHEN 'accepted' THEN 'accepted' WHEN 'unknown' THEN 'unknown'
        WHEN 'permanent_failure' THEN 'failed' WHEN 'retryable_failure' THEN CASE WHEN p_attempts<3 THEN 'retry_wait' ELSE 'failed' END END,
        'reason',CASE WHEN p_result->>'outcome'='accepted' THEN NULL WHEN p_result->>'outcome'='unknown' THEN 'provider_unknown'
        WHEN p_result->>'outcome'='retryable_failure' AND p_attempts>=3 THEN 'retry_exhausted'
        WHEN p_result->>'error_code' IN ('rate_limited','connection_failed','authentication_required','provider_rejected','unavailable')
            THEN p_result->>'error_code'
        ELSE CASE WHEN p_result->>'outcome'='retryable_failure' THEN 'unavailable' ELSE 'provider_rejected' END END)
$$;

CREATE FUNCTION private.automation_legacy_begin_v1(p_delivery_id UUID,p_claim_token UUID,p_allowed_recipients TEXT[],
    p_preparation_id UUID DEFAULT NULL,p_preparation_token UUID DEFAULT NULL,p_probe_token UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; r public.automation_rules; c RECORD; v_reason TEXT;
    admission JSONB; attempt private.automation_email_attempt_reservations; revision BIGINT; v_reference_at TIMESTAMPTZ; v_locked_recipient TEXT; v_defer BOOLEAN:=false;
BEGIN
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ready',false,'state',NULL,'reason',NULL,'message',NULL); END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||d.studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
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
        PERFORM private.automation_email_scope_lock_v1(d.studio_id,'legacy',d.id,NULL,v_locked_recipient);
        IF p_preparation_id IS NOT NULL THEN
            SELECT cr.revision INTO revision FROM private.automation_email_credentials cr
                WHERE cr.provider_key='microsoft_graph:primary' FOR SHARE NOWAIT;
        END IF;
        PERFORM private.automation_sender_gate_lock_v1();
        -- The existing final source evaluation follows the last possible wait.
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
    IF EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations a WHERE a.studio_id=d.studio_id
        AND a.scope_kind='legacy' AND a.scope_id=d.id AND a.state IN ('sending','accepted','unknown')) THEN
        RETURN jsonb_build_object('ready',false,'state',d.state,'reason',d.reason,'message',NULL);
    END IF;
    IF d.attempts>=3 THEN
        UPDATE public.automation_deliveries SET state='failed',reason='retry_exhausted',claim_token=NULL,lease_expires_at=NULL,
            settled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
        RETURN jsonb_build_object('ready',false,'state',d.state,'reason',d.reason,'message',NULL);
    END IF;
    admission:=private.automation_email_attempt_begin_v1(d.studio_id,'legacy',d.id,NULL,gen_random_uuid(),p_claim_token,
        c.recipient_email,p_preparation_id,p_preparation_token,p_probe_token,d.attempts);
    IF admission->>'outcome'<>'begun' THEN
        IF admission->>'reason'='scope_terminal' OR admission->>'outcome'='already_begun' THEN
            RETURN jsonb_build_object('ready',false,'state',d.state,'reason',d.reason,'message',NULL);
        END IF;
        v_reason:=CASE admission->>'reason' WHEN 'recipient_suppressed' THEN 'suppressed'
            WHEN 'rate_limited' THEN 'rate_limited' WHEN 'retry_exhausted' THEN 'retry_exhausted' ELSE 'unavailable' END;
        UPDATE public.automation_deliveries SET state=CASE v_reason WHEN 'suppressed' THEN 'skipped'
            WHEN 'retry_exhausted' THEN 'failed' ELSE CASE WHEN attempts=0 THEN 'queued' ELSE 'retry_wait' END END,
            reason=v_reason,claim_token=NULL,lease_expires_at=NULL,
            next_attempt_at=greatest(next_attempt_at,coalesce((admission->>'retry_at')::TIMESTAMPTZ,clock_timestamp()+INTERVAL '1 hour')),
            settled_at=CASE WHEN v_reason IN ('suppressed','retry_exhausted') THEN clock_timestamp() END,
            updated_at=clock_timestamp() WHERE id=d.id RETURNING * INTO d;
        RETURN jsonb_build_object('ready',false,'state',d.state,'reason',d.reason,'message',NULL);
    END IF;
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=(admission->>'attempt_id')::UUID;
    UPDATE public.automation_deliveries SET state='sending',attempts=attempts+1,
        attempted_at=COALESCE(attempted_at,attempt.actual_began_at),lease_expires_at=attempt.lease_expires_at,
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
    RETURN jsonb_build_object('attempt_id',attempt.id,'lease_expires_at',attempt.lease_expires_at,
        'credential_revision',attempt.admitted_credential_revision,'sender_binding',attempt.sender_binding,
        'ready',true,'state',d.state,'reason',NULL,'message',jsonb_build_object(
        'delivery_id',d.id,'attempt_id',d.id::text||':'||d.attempts::text,'student_first_name',d.student_first_name,
        'studio_name',d.studio_name,'days_absent',d.days_absent,'recipient_email',d.recipient_email,
        'subject_template',d.subject_template,'body_template',d.body_template,'reply_to_email',d.reply_to_email,
        'unsubscribe_token',d.unsubscribe_token));
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE OR REPLACE FUNCTION public.begin_missed_class_automation_v1(p_delivery_id UUID,p_claim_token UUID,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
    SELECT private.automation_legacy_begin_v1(p_delivery_id,p_claim_token,p_allowed_recipients)
        -ARRAY['attempt_id','lease_expires_at','credential_revision','sender_binding']
$$;

CREATE FUNCTION public.begin_missed_class_automation_v2(p_delivery_id UUID,p_claim_token UUID,p_preparation_id UUID,
    p_preparation_token UUID,p_allowed_recipients TEXT[] DEFAULT NULL,p_probe_token UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE result JSONB;
BEGIN
    IF p_delivery_id IS NULL OR p_claim_token IS NULL OR p_preparation_id IS NULL OR p_preparation_token IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    result:=private.automation_legacy_begin_v1(p_delivery_id,p_claim_token,p_allowed_recipients,
        p_preparation_id,p_preparation_token,p_probe_token);
    RETURN jsonb_build_object('payload',jsonb_build_object('delivery_id',p_delivery_id,'claim_token',p_claim_token,
        'attempt_id',NULL,'lease_expires_at',NULL,'credential_revision',NULL,'sender_binding',NULL)||result);
END $$;

CREATE FUNCTION private.automation_legacy_delivery_transition_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE attempt private.automation_email_attempt_reservations; admission JSONB; settlement JSONB; result JSONB;
    projection JSONB; r public.automation_rules; c RECORD; at TIMESTAMPTZ;
BEGIN
    IF NEW.state='sending' AND OLD.state<>'sending' THEN
        IF OLD.state<>'claimed' OR OLD.attempts NOT BETWEEN 0 AND 2 OR NEW.attempts<>OLD.attempts+1
            OR NEW.claim_token IS NULL OR NEW.claim_token IS DISTINCT FROM OLD.claim_token THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='AUTOMATION_INVALID_LEGACY_TRANSITION';
        END IF;
        IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||OLD.studio_id::TEXT,0)) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
        END IF;
        PERFORM private.automation_email_scope_lock_v1(OLD.studio_id,'legacy',OLD.id,NULL,NEW.original_recipient_email);
        SELECT * INTO attempt FROM private.automation_email_attempt_reservations
            WHERE studio_id=OLD.studio_id AND scope_kind='legacy' AND scope_id=OLD.id AND owner_token=OLD.claim_token;
        IF attempt.id IS NULL THEN
            -- An already loaded V56 begin reaches this branch. All its source
            -- locks are already held; only TRY/NOWAIT acquisitions go backward.
            PERFORM private.automation_sender_gate_lock_v1();
            at:=clock_timestamp();
            SELECT * INTO r FROM public.automation_rules WHERE studio_id=OLD.studio_id;
            SELECT * INTO c FROM private.missed_class_automation_candidates(OLD.studio_id,r.inactivity_days,OLD.student_id,OLD.id,at);
            IF NOT FOUND OR r.enabled IS DISTINCT FROM true OR r.dispatch_deferred_until>at
                OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=at
                OR NOT private.automation_core_entitled(OLD.studio_id) OR c.skip_reason IS NOT NULL
                OR c.recipient_email IS DISTINCT FROM NEW.original_recipient_email
                OR c.attendance_id IS DISTINCT FROM NEW.attendance_id
                OR c.last_attendance_date IS DISTINCT FROM NEW.attendance_date THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
            END IF;
            admission:=private.automation_email_attempt_begin_v1(OLD.studio_id,'legacy',OLD.id,NULL,gen_random_uuid(),
                OLD.claim_token,NEW.original_recipient_email,NULL,NULL,NULL,OLD.attempts);
            IF admission->>'outcome'<>'begun' THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
            END IF;
            SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=(admission->>'attempt_id')::UUID;
        END IF;
        IF attempt.origin<>'actual' OR attempt.state<>'sending' OR attempt.attempt_number<>NEW.attempts
            OR attempt.recipient_email IS DISTINCT FROM NEW.original_recipient_email
            OR attempt.lease_expires_at<=clock_timestamp() THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
        END IF;
        NEW.lease_expires_at:=attempt.lease_expires_at;
        PERFORM private.automation_bind_unsubscribe_token_v1(NEW.studio_id,NEW.unsubscribe_token,NEW.original_recipient_email);
    ELSIF OLD.state='sending' AND NEW.state<>'sending' THEN
        SELECT * INTO attempt FROM private.automation_email_attempt_reservations
            WHERE studio_id=OLD.studio_id AND scope_kind='legacy' AND scope_id=OLD.id
                AND owner_token IS NOT DISTINCT FROM OLD.claim_token;
        IF attempt.id IS NULL OR NEW.state NOT IN ('accepted','retry_wait','failed','unknown') THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
        END IF;
        projection:=jsonb_build_object('state',NEW.state,'reason',NEW.reason);
        IF attempt.state='sending' THEN
            IF NEW.state='unknown' AND NEW.reason='lease_expired' THEN
                IF attempt.origin<>'actual' AND (attempt.owner_token IS NULL OR attempt.lease_expires_at IS NULL) THEN
                    -- No usable old sending ownership was observed at cutover.
                    -- Only old claim expiry can establish this conservative truth.
                    PERFORM private.automation_email_scope_lock_v1(attempt.studio_id,'legacy',attempt.scope_id,NULL,attempt.recipient_email);
                    UPDATE private.automation_email_attempt_reservations SET state='unknown',frequency_state='unknown'
                        WHERE id=attempt.id AND state='sending';
                ELSE
                    settlement:=private.automation_email_attempt_expire_v1(attempt.id);
                    IF settlement->>'outcome'<>'confirmed' THEN
                        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
                    END IF;
                END IF;
            ELSE
                IF attempt.protocol='prepared' THEN
                    -- A new parent must record its seven-field evidence before
                    -- this transition. A cached old body cannot downgrade it.
                    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
                END IF;
                result:=jsonb_build_object('outcome',CASE NEW.state WHEN 'accepted' THEN 'accepted' WHEN 'unknown' THEN 'unknown'
                    WHEN 'retry_wait' THEN 'retryable_failure' ELSE CASE WHEN NEW.reason='retry_exhausted' THEN 'retryable_failure' ELSE 'permanent_failure' END END,
                    'error_code',NEW.reason,'provider_request_id',NEW.provider_request_id,'retry_after_seconds',NULL);
                settlement:=private.automation_email_attempt_settle_v1(attempt.id,OLD.claim_token,result);
                -- Frozen settle returns its local v_state. Rewriting NEW would
                -- let an accepted response escape despite expired common truth.
                IF settlement->>'outcome'<>'confirmed'
                    OR settlement->>'state' IS DISTINCT FROM (CASE WHEN NEW.state='retry_wait' THEN 'failed' ELSE NEW.state END)
                    OR (attempt.lease_expires_at<=(settlement->>'settled_at')::TIMESTAMPTZ
                        AND projection<>jsonb_build_object('state','unknown','reason','lease_expired')) THEN
                    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
                END IF;
            END IF;
            IF NOT private.automation_legacy_projection_pin_v1(attempt.id,attempt.owner_token,projection) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
            END IF;
        ELSE
            -- Current wrappers have already settled and pinned this exact pair.
            IF attempt.legacy_projection IS DISTINCT FROM projection THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER automation_legacy_delivery_transition BEFORE UPDATE ON public.automation_deliveries
    FOR EACH ROW EXECUTE FUNCTION private.automation_legacy_delivery_transition_v1();

CREATE FUNCTION private.automation_legacy_delivery_delete_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    -- Actual studio removal owns both studio-only cascades. Operational clear
    -- and student removal retain the independent reservation and token mapping.
    IF NOT EXISTS(SELECT 1 FROM public.studios WHERE id=OLD.studio_id) THEN RETURN OLD; END IF;
    IF OLD.state='sending' AND NOT EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations
        WHERE studio_id=OLD.studio_id AND scope_kind='legacy' AND scope_id=OLD.id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
    END IF;
    IF OLD.attempted_at IS NOT NULL AND OLD.unsubscribe_token ~ '^[a-f0-9]{64}$' AND NOT EXISTS(
        SELECT 1 FROM private.automation_unsubscribe_token_bindings WHERE token_hash=encode(extensions.digest(OLD.unsubscribe_token,'sha256'),'hex')
            AND studio_id=OLD.studio_id AND recipient_email=OLD.original_recipient_email) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER automation_legacy_delivery_delete BEFORE DELETE ON public.automation_deliveries
    FOR EACH ROW EXECUTE FUNCTION private.automation_legacy_delivery_delete_v1();

CREATE FUNCTION private.automation_legacy_settle_v1(p_delivery_id UUID,p_claim_token UUID,p_attempt_id UUID,p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; attempt private.automation_email_attempt_reservations; settlement JSONB;
    projection JSONB; result JSONB; retry INTEGER;
    refused JSONB:=jsonb_build_object('delivery_id',p_delivery_id,'attempt_id',p_attempt_id,'updated',false,'replayed',false,'state',NULL,'reason',NULL);
BEGIN
    -- Always delivery before common ownership, including a concurrent cascade.
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id FOR UPDATE;
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id;
    IF attempt.id IS NULL OR attempt.scope_kind<>'legacy' OR attempt.scope_id IS DISTINCT FROM p_delivery_id
        OR p_claim_token IS NULL OR attempt.owner_token IS DISTINCT FROM p_claim_token
        OR (d.id IS NOT NULL AND d.studio_id IS DISTINCT FROM attempt.studio_id) THEN RETURN refused; END IF;
    IF attempt.protocol='prepared' THEN
        IF NOT private.workflow_json_keys_v1(p_result,
            ARRAY['outcome','error_code','provider_request_id','retry_after_seconds','submission_evidence','failure_scope','credential_revision'],
            ARRAY['outcome','error_code','provider_request_id','retry_after_seconds','submission_evidence','failure_scope','credential_revision']) THEN RETURN refused; END IF;
        result:=private.automation_delivery_result_v1(p_result,attempt.admitted_credential_revision);
    ELSE
        IF NOT private.workflow_json_keys_v1(p_result,ARRAY['outcome','error_code','provider_request_id','retry_after_seconds'],
            ARRAY['outcome','error_code','provider_request_id','retry_after_seconds']) THEN RETURN refused; END IF;
        result:=p_result;
    END IF;
    settlement:=private.automation_email_attempt_settle_v1(attempt.id,p_claim_token,result);
    IF settlement->>'outcome'='refused' THEN RETURN refused; END IF;
    IF settlement->>'outcome'='replayed' THEN
        SELECT * INTO attempt FROM private.automation_email_attempt_reservations WHERE id=attempt.id;
        IF attempt.legacy_projection IS NULL THEN RETURN refused; END IF;
        projection:=attempt.legacy_projection;
    ELSE
        IF settlement->>'state'='unknown' AND attempt.lease_expires_at<=(settlement->>'settled_at')::TIMESTAMPTZ THEN
            projection:=jsonb_build_object('state','unknown','reason','lease_expired');
        ELSE
            projection:=private.automation_legacy_terminal_v1(result,coalesce(attempt.attempt_number,attempt.observed_legacy_ordinal));
        END IF;
        IF NOT private.automation_legacy_projection_pin_v1(attempt.id,p_claim_token,projection) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
        END IF;
        IF d.id IS NOT NULL THEN
            IF d.state<>'sending' OR d.claim_token IS DISTINCT FROM p_claim_token THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
            END IF;
            retry:=greatest(60,least(86400,coalesce((result->>'retry_after_seconds')::INTEGER,60*(2^d.attempts)::INTEGER)));
            UPDATE public.automation_deliveries SET state=projection->>'state',reason=projection->>'reason',
                provider_request_id=settlement->'result'->>'provider_request_id',next_attempt_at=clock_timestamp()+make_interval(secs=>retry),
                claim_token=NULL,lease_expires_at=NULL,settled_at=(settlement->>'settled_at')::TIMESTAMPTZ,updated_at=clock_timestamp() WHERE id=d.id;
        END IF;
    END IF;
    RETURN jsonb_build_object('delivery_id',p_delivery_id,'attempt_id',p_attempt_id,'updated',true,
        'replayed',settlement->>'outcome'='replayed')||projection;
END $$;

CREATE FUNCTION public.settle_missed_class_automation_v2(p_delivery_id UUID,p_claim_token UUID,p_attempt_id UUID,p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_delivery_id IS NULL OR p_claim_token IS NULL OR p_attempt_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN jsonb_build_object('payload',private.automation_legacy_settle_v1(p_delivery_id,p_claim_token,p_attempt_id,
        private.automation_delivery_result_v1(p_result)));
END $$;

CREATE OR REPLACE FUNCTION public.settle_missed_class_automation_v1(p_delivery_id UUID,p_claim_token UUID,p_outcome TEXT,
    p_error_code TEXT DEFAULT NULL,p_provider_request_id TEXT DEFAULT NULL,p_retry_after_seconds INTEGER DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d public.automation_deliveries; attempt private.automation_email_attempt_reservations; result JSONB;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','retryable_failure','permanent_failure','unknown') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid delivery outcome.';
    END IF;
    SELECT * INTO d FROM public.automation_deliveries WHERE id=p_delivery_id FOR UPDATE;
    IF d.id IS NOT NULL AND (d.state<>'sending' OR d.claim_token IS DISTINCT FROM p_claim_token) THEN
        RETURN jsonb_build_object('updated',false,'state',d.state);
    END IF;
    SELECT * INTO attempt FROM private.automation_email_attempt_reservations
        WHERE scope_kind='legacy' AND scope_id=p_delivery_id AND owner_token=p_claim_token
            AND (d.id IS NULL OR studio_id=d.studio_id);
    IF attempt.id IS NULL OR attempt.protocol='prepared' THEN RETURN jsonb_build_object('updated',false,'state',d.state); END IF;
    result:=private.automation_legacy_settle_v1(p_delivery_id,p_claim_token,attempt.id,jsonb_build_object(
        'outcome',p_outcome,'error_code',p_error_code,'provider_request_id',p_provider_request_id,'retry_after_seconds',p_retry_after_seconds));
    RETURN jsonb_build_object('updated',(result->>'updated')::BOOLEAN AND NOT (result->>'replayed')::BOOLEAN,
        'state',CASE WHEN (result->>'updated')::BOOLEAN THEN result->>'state' ELSE d.state END);
END $$;

CREATE OR REPLACE FUNCTION public.suppress_missed_class_automation_v1(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE binding private.automation_unsubscribe_token_bindings;
BEGIN
    IF p_token IS NOT NULL AND p_token ~ '^[a-f0-9]{64}$' THEN
        SELECT * INTO binding FROM private.automation_unsubscribe_token_bindings WHERE token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
        IF FOUND THEN
            PERFORM 1 FROM public.studios WHERE id=binding.studio_id FOR KEY SHARE;
            IF NOT FOUND THEN RETURN jsonb_build_object('success',true); END IF;
            PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(binding.studio_id::TEXT||':'||binding.recipient_email,0));
            INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES(binding.studio_id,binding.recipient_email) ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    RETURN jsonb_build_object('success',true);
END $$;

CREATE FUNCTION private.automation_expire_orphaned_legacy_attempts_v1(p_limit INTEGER DEFAULT 100) RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE item private.automation_email_attempt_reservations; ids UUID[]; result JSONB; count INTEGER:=0; cutoff TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- MATERIALIZED bounds the raw ordered page before the parent anti-join.
    -- Attached attempts consume page slots and are expired by the retained
    -- claim UPDATE below, allowing a later invocation to reach later orphans.
    WITH raw AS MATERIALIZED (
        SELECT a.id,a.studio_id,a.scope_id FROM private.automation_email_attempt_reservations a
        WHERE a.scope_kind='legacy' AND a.state='sending' AND a.lease_expires_at<=cutoff
            AND private.automation_sender_instant_v1(a.lease_expires_at) IS TRUE
        ORDER BY a.lease_expires_at,a.id LIMIT p_limit
    ) SELECT array_agg(raw.id ORDER BY raw.id) INTO ids FROM raw WHERE NOT EXISTS(
        SELECT 1 FROM public.automation_deliveries d WHERE d.studio_id=raw.studio_id AND d.id=raw.scope_id);
    -- Own the entire chosen subset before taking the provider gate. These
    -- locks remain held through the complete caller transaction.
    FOR item IN SELECT * FROM private.automation_email_attempt_reservations WHERE id=ANY(ids) ORDER BY studio_id,id LOOP
        PERFORM 1 FROM public.studios WHERE id=item.studio_id FOR KEY SHARE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
        PERFORM private.automation_email_scope_lock_v1(item.studio_id,'legacy',item.scope_id,NULL,item.recipient_email);
        IF item.protocol='prepared' THEN
            PERFORM 1 FROM private.automation_email_credentials WHERE provider_key=item.provider_key FOR SHARE NOWAIT;
        END IF;
        PERFORM 1 FROM private.automation_email_attempt_reservations WHERE id=item.id FOR UPDATE NOWAIT;
    END LOOP;
    FOR item IN SELECT * FROM private.automation_email_attempt_reservations WHERE id=ANY(ids) ORDER BY studio_id,id LOOP
        IF item.state<>'sending' OR item.lease_expires_at>clock_timestamp() OR EXISTS(
            SELECT 1 FROM public.automation_deliveries WHERE studio_id=item.studio_id AND id=item.scope_id) THEN CONTINUE; END IF;
        result:=private.automation_email_attempt_expire_v1(item.id);
        IF result->>'outcome'='confirmed' THEN
            IF NOT private.automation_legacy_projection_pin_v1(item.id,item.owner_token,
                jsonb_build_object('state','unknown','reason','lease_expired')) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
            END IF;
            count:=count+1;
        ELSIF result->>'outcome'<>'replayed' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE';
        END IF;
    END LOOP;
    RETURN count;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE OR REPLACE FUNCTION public.claim_missed_class_automations_v1(p_limit INTEGER DEFAULT 10,p_allowed_recipients TEXT[] DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_items JSONB:='[]'::jsonb; v_more BOOLEAN; v_rule public.automation_rules;
    v_delivery public.automation_deliveries; v_scan INTEGER; v_visited UUID[]:='{}';
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid claim limit.'; END IF;
    PERFORM private.automation_expire_orphaned_legacy_attempts_v1(100);
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

ALTER TABLE private.automation_unsubscribe_token_bindings OWNER TO postgres;
ALTER TABLE private.automation_unsubscribe_token_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.automation_unsubscribe_token_bindings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON private.automation_unsubscribe_token_bindings TO service_role;
CREATE POLICY reject_client_access ON private.automation_unsubscribe_token_bindings AS RESTRICTIVE
    FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
DO $legacy_privileges$
DECLARE item RECORD;
BEGIN
    FOR item IN SELECT p.oid::REGPROCEDURE identity,p.prorettype FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_bind_unsubscribe_token_v1','automation_legacy_begin_v1',
            'automation_legacy_settle_v1','automation_legacy_terminal_v1','automation_legacy_delivery_transition_v1',
            'automation_legacy_delivery_delete_v1','automation_unsubscribe_binding_identity_v1','automation_expire_orphaned_legacy_attempts_v1'))
            OR (n.nspname='public' AND p.proname IN ('begin_missed_class_automation_v2','settle_missed_class_automation_v2')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',item.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',item.identity);
        IF item.prorettype<>'trigger'::REGTYPE THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',item.identity); END IF;
    END LOOP;
END $legacy_privileges$;

-- Graph mail uses the common real-attempt owner. Bodies and plaintext footer
-- pins are disposable payloads; run/step/attempt truth remains body-free.
CREATE FUNCTION private.workflow_email_rendered_valid_v1(p_rendered JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT private.workflow_json_keys_v1(p_rendered,ARRAY['subject','text_body','html_body'],ARRAY['subject','text_body','html_body'])
        AND jsonb_typeof(p_rendered->'subject')='string' AND length(p_rendered->>'subject')<=200 AND octet_length(p_rendered->>'subject')<=800
        AND jsonb_typeof(p_rendered->'text_body')='string' AND length(p_rendered->>'text_body')<=22084 AND octet_length(p_rendered->>'text_body')<=88228
        AND jsonb_typeof(p_rendered->'html_body')='string' AND length(p_rendered->>'html_body')<=132383 AND octet_length(p_rendered->>'html_body')<=132383
$$;
CREATE TABLE private.workflow_email_unsubscribe_pins (
    studio_id UUID NOT NULL,run_id UUID NOT NULL,step_id UUID NOT NULL,node_id TEXT NOT NULL,
    first_attempt_id UUID NOT NULL REFERENCES private.automation_workflow_email_attempts(id) ON DELETE CASCADE,
    unsubscribe_token TEXT NOT NULL CHECK(unsubscribe_token ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL CHECK(private.automation_sender_instant_v1(created_at)),
    PRIMARY KEY(run_id,node_id),
    FOREIGN KEY(studio_id,run_id,step_id,node_id) REFERENCES private.automation_workflow_run_steps(studio_id,run_id,id,node_id) ON DELETE CASCADE
);
CREATE TABLE private.workflow_email_attempt_payloads (
    attempt_id UUID PRIMARY KEY REFERENCES private.automation_workflow_email_attempts(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL,run_id UUID NOT NULL,step_id UUID NOT NULL,node_id TEXT NOT NULL,
    plan_fingerprint TEXT NOT NULL CHECK(plan_fingerprint ~ '^[a-f0-9]{64}$'),
    reply_to TEXT NOT NULL CHECK(private.automation_normalize_email(reply_to) IS NOT NULL AND private.automation_normalize_email(reply_to)=reply_to),
    rendered JSONB NOT NULL CHECK(private.workflow_email_rendered_valid_v1(rendered)),
    selected_template_facts JSONB NOT NULL CHECK(jsonb_typeof(selected_template_facts)='object' AND octet_length(selected_template_facts::TEXT)<=320000),
    created_at TIMESTAMPTZ NOT NULL CHECK(private.automation_sender_instant_v1(created_at)),
    FOREIGN KEY(studio_id,run_id,step_id,node_id) REFERENCES private.automation_workflow_run_steps(studio_id,run_id,id,node_id) ON DELETE CASCADE
);
CREATE INDEX automation_email_attempts_workflow_expiry ON private.automation_email_attempt_reservations(lease_expires_at,id)
    WHERE scope_kind='workflow' AND state='sending';
CREATE FUNCTION private.workflow_email_payload_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE actual private.automation_workflow_email_attempts;
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD'; END IF;
        RETURN NEW;
    END IF;
    SELECT * INTO actual FROM private.automation_workflow_email_attempts
        WHERE id=CASE WHEN TG_TABLE_NAME='workflow_email_unsubscribe_pins' THEN (to_jsonb(NEW)->>'first_attempt_id')::UUID ELSE (to_jsonb(NEW)->>'attempt_id')::UUID END;
    IF actual.id IS NOT NULL AND (ROW(actual.studio_id,actual.run_id,actual.step_id,actual.node_id)
        IS DISTINCT FROM ROW(NEW.studio_id,NEW.run_id,NEW.step_id,NEW.node_id)
        OR (TG_TABLE_NAME='workflow_email_unsubscribe_pins' AND actual.attempt_number<>1)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION private.workflow_email_payload_delete_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE key BIGINT:=pg_catalog.hashtextextended('koaryu.local-plan-clear:'||OLD.studio_id::TEXT,0);
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.studios WHERE id=OLD.studio_id) THEN RETURN OLD; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE studio_id=OLD.studio_id AND id=OLD.run_id
        AND (cancel_requested_at IS NOT NULL OR state IN ('completed','failed','cancelled')))
        OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_catalog.pg_backend_pid()
            AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
            AND l.classid=((key>>32)&4294967295)::OID AND l.objid=(key&4294967295)::OID AND l.objsubid=1
            AND l.mode='ExclusiveLock' AND l.granted) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_PAYLOAD_CLEAR_REQUIRED';
    END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER workflow_email_pins_identity BEFORE INSERT OR UPDATE ON private.workflow_email_unsubscribe_pins
    FOR EACH ROW EXECUTE FUNCTION private.workflow_email_payload_identity_v1();
CREATE TRIGGER workflow_email_payloads_identity BEFORE INSERT OR UPDATE ON private.workflow_email_attempt_payloads
    FOR EACH ROW EXECUTE FUNCTION private.workflow_email_payload_identity_v1();
CREATE TRIGGER workflow_email_pins_delete BEFORE DELETE ON private.workflow_email_unsubscribe_pins
    FOR EACH ROW EXECUTE FUNCTION private.workflow_email_payload_delete_v1();
CREATE TRIGGER workflow_email_payloads_delete BEFORE DELETE ON private.workflow_email_attempt_payloads
    FOR EACH ROW EXECUTE FUNCTION private.workflow_email_payload_delete_v1();

-- The sole Auth exception returns only ownership success. UPDATE excludes
-- non-key email changes and FK-backed insertions of absent roles/profiles.
CREATE FUNCTION private.workflow_lock_recipient_auth_v1(p_user_id UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
    PERFORM 1 FROM auth.users WHERE id=p_user_id FOR UPDATE NOWAIT;
    RETURN FOUND;
END $$;

CREATE FUNCTION private.workflow_email_source_inventory_v1(p_studio_id UUID,p_event private.automation_workflow_events,p_trigger_config JSONB,p_recipient_policy TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
#variable_conflict use_column
<<source_owner>>
DECLARE lead public.leads; trial public.lead_trial_appointments; student public.students; promotion public.promotions; recipient public.belt_test_recipients; belt public.belt_test_events; membership public.student_program_memberships; ladder public.belt_ladders; invoice public.billing_invoices; payment public.billing_payments; account public.studio_payment_accounts; settlement private.workflow_invoice_settlement_authority; item RECORD;
    complete BOOLEAN:=true; parents JSONB:='{}'; generations JSONB:='{}'; filter_id UUID:=(p_trigger_config->>'program_id')::UUID;
    student_id UUID; membership_id UUID; ladder_id UUID; invoice_id UUID; rank_generation BIGINT;
    program_ids UUID[]:='{}'; rank_ids UUID[]:='{}'; candidates UUID[]; payments UUID[];
BEGIN
    IF p_event.event_type LIKE 'invoice.%' THEN
    IF p_event.event_type='invoice.payment_failed' THEN
    SELECT * INTO payment FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    complete:=complete AND payment.id IS NOT NULL;
    IF payment.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.billing_payments:'||payment.id::TEXT,true); END IF;
    invoice_id:=payment.invoice_id; ELSE invoice_id:=p_event.subject_id; END IF;
    SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=source_owner.invoice_id;
    complete:=complete AND invoice.id IS NOT NULL;
    IF invoice.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.billing_invoices:'||invoice.id::TEXT,true); END IF;
    SELECT coalesce(array_agg(payment_id ORDER BY payment_id),'{}'::UUID[]) INTO candidates FROM (SELECT payment_id FROM private.workflow_payment_settlement_observations WHERE studio_id=p_studio_id AND invoice_id=source_owner.invoice_id AND uncertain ORDER BY payment_id LIMIT 20) bounded;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO payments FROM public.billing_payments WHERE studio_id=p_studio_id AND (id=payment.id OR id=ANY(candidates) OR (invoice_id=source_owner.invoice_id AND status IN ('succeeded','refunded','disputed','externally_recorded')));
    FOR item IN SELECT * FROM public.billing_payments WHERE studio_id=p_studio_id AND id=ANY(payments) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.billing_payments:'||item.id::TEXT,true); END LOOP;
    FOR item IN SELECT * FROM public.billing_payers WHERE studio_id=p_studio_id AND (id=invoice.payer_id OR id IN (SELECT payer_id FROM public.billing_payments WHERE studio_id=p_studio_id AND id=ANY(payments))) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.billing_payers:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND invoice.payer_id IS NOT NULL AND parents ? ('public.billing_payers:'||invoice.payer_id::TEXT) AND NOT EXISTS(SELECT 1 FROM public.billing_payments p WHERE p.studio_id=p_studio_id AND p.id=ANY(payments) AND (p.payer_id IS NULL OR NOT parents ? ('public.billing_payers:'||p.payer_id::TEXT)));
    SELECT * INTO account FROM public.studio_payment_accounts WHERE studio_id=p_studio_id;
    complete:=complete AND account.studio_id IS NOT NULL;
    IF account.studio_id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.studio_payment_accounts:'||account.studio_id::TEXT,true); END IF;
    SELECT * INTO settlement FROM private.workflow_invoice_settlement_authority WHERE studio_id=p_studio_id AND invoice_id=source_owner.invoice_id;
    complete:=complete AND settlement.invoice_id IS NOT NULL;
    IF settlement.invoice_id IS NOT NULL THEN parents:=parents||jsonb_build_object('private.workflow_invoice_settlement_authority:'||settlement.invoice_id::TEXT,true); END IF;
    FOR item IN SELECT * FROM private.workflow_payment_settlement_observations WHERE studio_id=p_studio_id AND payment_id=ANY(payments) ORDER BY payment_id LOOP parents:=parents||jsonb_build_object('private.workflow_payment_settlement_observations:'||item.payment_id::TEXT,true); END LOOP;
    generations:=jsonb_build_object('invoice_settlement_generation',settlement.generation,'account_generation',account.metadata->'connect_account_generation');
    ELSIF p_event.event_type LIKE 'lead.%' OR p_event.event_type LIKE 'trial.%' THEN
    IF p_event.event_type LIKE 'trial.%' THEN
    SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=trial.lead_id;
    complete:=complete AND lead.id IS NOT NULL;
    IF lead.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.leads:'||lead.id::TEXT,true); END IF;
    SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    complete:=complete AND trial.id IS NOT NULL;
    IF trial.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.lead_trial_appointments:'||trial.id::TEXT,true); END IF;
    generations:=jsonb_build_object('trial_revision',trial.revision,'trial_rebooking_superseded',trial.rebooking_superseded); program_ids:=array_append(program_ids,trial.program_id); ELSE
    SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    complete:=complete AND lead.id IS NOT NULL;
    IF lead.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.leads:'||lead.id::TEXT,true); END IF;
    END IF; program_ids:=program_ids||ARRAY[lead.program_id,filter_id];
    FOR item IN SELECT * FROM public.programs WHERE studio_id=p_studio_id AND id=ANY(program_ids) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.programs:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM unnest(program_ids) id WHERE id IS NOT NULL AND NOT parents ? ('public.programs:'||id::TEXT));
    IF p_recipient_policy='assigned_staff' AND lead.assigned_staff_id IS NOT NULL THEN
    parents:=parents||jsonb_build_object('recipient_auth:'||lead.assigned_staff_id::TEXT,true);
    FOR item IN SELECT * FROM public.staff_roles WHERE user_id=lead.assigned_staff_id ORDER BY id LOOP parents:=parents||jsonb_build_object('public.staff_roles:'||item.id::TEXT,true); END LOOP;
    FOR item IN SELECT * FROM public.staff_profiles WHERE user_id=lead.assigned_staff_id ORDER BY user_id LOOP parents:=parents||jsonb_build_object('public.staff_profiles:'||item.user_id::TEXT,true); END LOOP;
    END IF; ELSE
    IF p_event.event_type LIKE 'belt_test.%' THEN
    SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    SELECT * INTO belt FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=recipient.event_id;
    complete:=complete AND belt.id IS NOT NULL;
    IF belt.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.belt_test_events:'||belt.id::TEXT,true); END IF;
    student_id:=recipient.student_id; membership_id:=recipient.student_program_membership_id; ladder_id:=belt.ladder_id; program_ids:=ARRAY[belt.program_id,recipient.approved_program_id,filter_id]; rank_ids:=ARRAY[recipient.approved_current_rank_id,recipient.approved_target_rank_id];
    ELSIF p_event.event_type='student.promoted' THEN SELECT * INTO promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_event.subject_id; student_id:=promotion.student_id; membership_id:=promotion.command_membership_id; program_ids:=ARRAY[promotion.command_program_id,filter_id]; rank_ids:=ARRAY[promotion.to_rank_id,promotion.command_from_rank_id]; SELECT r.ladder_id INTO ladder_id FROM public.belt_ranks r WHERE studio_id=p_studio_id AND id=promotion.to_rank_id; ELSE student_id:=p_event.subject_id; END IF;
    SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=source_owner.student_id;
    complete:=complete AND student.id IS NOT NULL;
    IF student.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.students:'||student.id::TEXT,true); END IF;
    IF p_event.event_type='student.enrolled' THEN
    FOR item IN SELECT * FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND program_id=filter_id ORDER BY id LOOP parents:=parents||jsonb_build_object('public.student_program_memberships:'||item.id::TEXT,true); END LOOP;
    program_ids:=ARRAY[filter_id]; ELSE
    FOR item IN SELECT * FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND (membership_id IS NULL OR id=membership_id) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.student_program_memberships:'||item.id::TEXT,true); END LOOP;
    SELECT * INTO membership FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND id=membership_id;
    complete:=complete AND (membership_id IS NULL OR parents ? ('public.student_program_memberships:'||membership_id::TEXT)); program_ids:=array_append(program_ids,CASE WHEN membership_id IS NULL THEN student.program_id ELSE membership.program_id END); rank_ids:=array_append(rank_ids,CASE WHEN membership_id IS NULL THEN student.current_belt_rank_id ELSE membership.current_belt_rank_id END);
    SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=source_owner.ladder_id;
    complete:=complete AND ladder.id IS NOT NULL;
    IF ladder.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.belt_ladders:'||ladder.id::TEXT,true); END IF;
    FOR item IN SELECT * FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=ANY(rank_ids) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.belt_ranks:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM unnest(rank_ids) id WHERE id IS NOT NULL AND NOT parents ? ('public.belt_ranks:'||id::TEXT));
    END IF;
    FOR item IN SELECT * FROM public.programs WHERE studio_id=p_studio_id AND id=ANY(program_ids) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.programs:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM unnest(program_ids) id WHERE id IS NOT NULL AND NOT parents ? ('public.programs:'||id::TEXT));
    IF p_event.event_type LIKE 'belt_test.%' THEN
    SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    complete:=complete AND recipient.id IS NOT NULL;
    IF recipient.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.belt_test_recipients:'||recipient.id::TEXT,true); END IF;
    generations:=jsonb_build_object('approval_revision',recipient.revision,'schedule_revision',belt.schedule_revision,'approved_rank_context_generation',recipient.approved_rank_context_generation); ELSIF p_event.event_type='student.promoted' THEN
    SELECT * INTO promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    complete:=complete AND promotion.id IS NOT NULL;
    IF promotion.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.promotions:'||promotion.id::TEXT,true); END IF;
    END IF;
    IF p_event.event_type='student.promoted' OR p_event.event_type LIKE 'belt_test.%' THEN SELECT generation INTO rank_generation FROM private.workflow_rank_contexts WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND student_program_membership_id IS NOT DISTINCT FROM membership_id; generations:=generations||jsonb_build_object('rank_context_generation',rank_generation); END IF;
    IF p_recipient_policy='student_or_guardian' THEN
    FOR item IN SELECT * FROM public.student_guardians WHERE student_id=source_owner.student_id ORDER BY id LOOP parents:=parents||jsonb_build_object('public.student_guardians:'||item.id::TEXT,true); END LOOP;
    FOR item IN SELECT * FROM public.guardians WHERE studio_id=p_studio_id AND id IN (SELECT guardian_id FROM public.student_guardians WHERE student_id=source_owner.student_id) ORDER BY id LOOP parents:=parents||jsonb_build_object('public.guardians:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM public.student_guardians g WHERE g.student_id=source_owner.student_id AND NOT parents ? ('public.guardians:'||g.guardian_id::TEXT)); END IF; END IF;
    RETURN jsonb_build_object('complete',complete,'authority',jsonb_build_object('parents',parents,'generations',generations));
END $$;

CREATE FUNCTION private.workflow_lock_email_sources_v1(p_studio_id UUID,p_event private.automation_workflow_events,p_trigger_config JSONB,p_recipient_policy TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
#variable_conflict use_column
<<source_owner>>
DECLARE lead public.leads; trial public.lead_trial_appointments; student public.students; promotion public.promotions; recipient public.belt_test_recipients; belt public.belt_test_events; membership public.student_program_memberships; ladder public.belt_ladders; invoice public.billing_invoices; payment public.billing_payments; account public.studio_payment_accounts; settlement private.workflow_invoice_settlement_authority; item RECORD;
    complete BOOLEAN:=true; parents JSONB:='{}'; generations JSONB:='{}'; filter_id UUID:=(p_trigger_config->>'program_id')::UUID;
    student_id UUID; membership_id UUID; ladder_id UUID; invoice_id UUID; rank_generation BIGINT;
    program_ids UUID[]:='{}'; rank_ids UUID[]:='{}'; candidates UUID[]; payments UUID[];
BEGIN
    IF p_event.event_type LIKE 'invoice.%' THEN
    IF p_event.event_type='invoice.payment_failed' THEN
    SELECT * INTO payment FROM public.billing_payments WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR UPDATE NOWAIT;
    complete:=complete AND payment.id IS NOT NULL;
    IF payment.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.billing_payments:'||payment.id::TEXT,true); END IF;
    invoice_id:=payment.invoice_id; ELSE invoice_id:=p_event.subject_id; END IF;
    SELECT * INTO invoice FROM public.billing_invoices WHERE studio_id=p_studio_id AND id=source_owner.invoice_id FOR SHARE NOWAIT;
    complete:=complete AND invoice.id IS NOT NULL;
    IF invoice.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.billing_invoices:'||invoice.id::TEXT,true); END IF;
    IF invoice_id IS NOT NULL AND NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('koaryu.workflow-invoice-settlement:'||p_studio_id::TEXT||':'||invoice_id::TEXT,0)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
    SELECT coalesce(array_agg(payment_id ORDER BY payment_id),'{}'::UUID[]) INTO candidates FROM (SELECT payment_id FROM private.workflow_payment_settlement_observations WHERE studio_id=p_studio_id AND invoice_id=source_owner.invoice_id AND uncertain ORDER BY payment_id LIMIT 20) bounded;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO payments FROM public.billing_payments WHERE studio_id=p_studio_id AND (id=payment.id OR id=ANY(candidates) OR (invoice_id=source_owner.invoice_id AND status IN ('succeeded','refunded','disputed','externally_recorded')));
    FOR item IN SELECT * FROM public.billing_payments WHERE studio_id=p_studio_id AND id=ANY(payments) ORDER BY id FOR UPDATE NOWAIT LOOP parents:=parents||jsonb_build_object('public.billing_payments:'||item.id::TEXT,true); END LOOP;
    FOR item IN SELECT * FROM public.billing_payers WHERE studio_id=p_studio_id AND (id=invoice.payer_id OR id IN (SELECT payer_id FROM public.billing_payments WHERE studio_id=p_studio_id AND id=ANY(payments))) ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.billing_payers:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND invoice.payer_id IS NOT NULL AND parents ? ('public.billing_payers:'||invoice.payer_id::TEXT) AND NOT EXISTS(SELECT 1 FROM public.billing_payments p WHERE p.studio_id=p_studio_id AND p.id=ANY(payments) AND (p.payer_id IS NULL OR NOT parents ? ('public.billing_payers:'||p.payer_id::TEXT)));
    SELECT * INTO account FROM public.studio_payment_accounts WHERE studio_id=p_studio_id FOR SHARE NOWAIT;
    complete:=complete AND account.studio_id IS NOT NULL;
    IF account.studio_id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.studio_payment_accounts:'||account.studio_id::TEXT,true); END IF;
    SELECT * INTO settlement FROM private.workflow_invoice_settlement_authority WHERE studio_id=p_studio_id AND invoice_id=source_owner.invoice_id FOR UPDATE NOWAIT;
    complete:=complete AND settlement.invoice_id IS NOT NULL;
    IF settlement.invoice_id IS NOT NULL THEN parents:=parents||jsonb_build_object('private.workflow_invoice_settlement_authority:'||settlement.invoice_id::TEXT,true); END IF;
    FOR item IN SELECT * FROM private.workflow_payment_settlement_observations WHERE studio_id=p_studio_id AND payment_id=ANY(payments) ORDER BY payment_id FOR UPDATE NOWAIT LOOP parents:=parents||jsonb_build_object('private.workflow_payment_settlement_observations:'||item.payment_id::TEXT,true); END LOOP;
    generations:=jsonb_build_object('invoice_settlement_generation',settlement.generation,'account_generation',account.metadata->'connect_account_generation');
    PERFORM private.workflow_prepare_financial_context_v1(p_studio_id,invoice_id,CASE WHEN p_event.event_type='invoice.payment_failed' THEN payment.id END);
    ELSIF p_event.event_type LIKE 'lead.%' OR p_event.event_type LIKE 'trial.%' THEN
    IF p_event.event_type LIKE 'trial.%' THEN
    SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=trial.lead_id FOR UPDATE NOWAIT;
    complete:=complete AND lead.id IS NOT NULL;
    IF lead.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.leads:'||lead.id::TEXT,true); END IF;
    SELECT * INTO trial FROM public.lead_trial_appointments WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR SHARE NOWAIT;
    complete:=complete AND trial.id IS NOT NULL;
    IF trial.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.lead_trial_appointments:'||trial.id::TEXT,true); END IF;
    generations:=jsonb_build_object('trial_revision',trial.revision,'trial_rebooking_superseded',trial.rebooking_superseded); program_ids:=array_append(program_ids,trial.program_id); ELSE
    SELECT * INTO lead FROM public.leads WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR UPDATE NOWAIT;
    complete:=complete AND lead.id IS NOT NULL;
    IF lead.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.leads:'||lead.id::TEXT,true); END IF;
    END IF; program_ids:=program_ids||ARRAY[lead.program_id,filter_id];
    FOR item IN SELECT * FROM public.programs WHERE studio_id=p_studio_id AND id=ANY(program_ids) ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.programs:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM unnest(program_ids) id WHERE id IS NOT NULL AND NOT parents ? ('public.programs:'||id::TEXT));
    IF p_recipient_policy='assigned_staff' AND lead.assigned_staff_id IS NOT NULL THEN
    complete:=private.workflow_lock_recipient_auth_v1(lead.assigned_staff_id) AND complete;
    parents:=parents||jsonb_build_object('recipient_auth:'||lead.assigned_staff_id::TEXT,true);
    FOR item IN SELECT * FROM public.staff_roles WHERE user_id=lead.assigned_staff_id ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.staff_roles:'||item.id::TEXT,true); END LOOP;
    FOR item IN SELECT * FROM public.staff_profiles WHERE user_id=lead.assigned_staff_id ORDER BY user_id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.staff_profiles:'||item.user_id::TEXT,true); END LOOP;
    END IF; ELSE
    IF p_event.event_type LIKE 'belt_test.%' THEN
    SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_event.subject_id;
    SELECT * INTO belt FROM public.belt_test_events WHERE studio_id=p_studio_id AND id=recipient.event_id FOR SHARE NOWAIT;
    complete:=complete AND belt.id IS NOT NULL;
    IF belt.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.belt_test_events:'||belt.id::TEXT,true); END IF;
    student_id:=recipient.student_id; membership_id:=recipient.student_program_membership_id; ladder_id:=belt.ladder_id; program_ids:=ARRAY[belt.program_id,recipient.approved_program_id,filter_id]; rank_ids:=ARRAY[recipient.approved_current_rank_id,recipient.approved_target_rank_id];
    ELSIF p_event.event_type='student.promoted' THEN SELECT * INTO promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_event.subject_id; student_id:=promotion.student_id; membership_id:=promotion.command_membership_id; program_ids:=ARRAY[promotion.command_program_id,filter_id]; rank_ids:=ARRAY[promotion.to_rank_id,promotion.command_from_rank_id]; SELECT r.ladder_id INTO ladder_id FROM public.belt_ranks r WHERE studio_id=p_studio_id AND id=promotion.to_rank_id; ELSE student_id:=p_event.subject_id; END IF;
    SELECT * INTO student FROM public.students WHERE studio_id=p_studio_id AND id=source_owner.student_id FOR UPDATE NOWAIT;
    complete:=complete AND student.id IS NOT NULL;
    IF student.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.students:'||student.id::TEXT,true); END IF;
    IF p_event.event_type='student.enrolled' THEN
    FOR item IN SELECT * FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND program_id=filter_id ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.student_program_memberships:'||item.id::TEXT,true); END LOOP;
    program_ids:=ARRAY[filter_id]; ELSE
    FOR item IN SELECT * FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND (membership_id IS NULL OR id=membership_id) ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.student_program_memberships:'||item.id::TEXT,true); END LOOP;
    SELECT * INTO membership FROM public.student_program_memberships WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND id=membership_id;
    complete:=complete AND (membership_id IS NULL OR parents ? ('public.student_program_memberships:'||membership_id::TEXT)); program_ids:=array_append(program_ids,CASE WHEN membership_id IS NULL THEN student.program_id ELSE membership.program_id END); rank_ids:=array_append(rank_ids,CASE WHEN membership_id IS NULL THEN student.current_belt_rank_id ELSE membership.current_belt_rank_id END);
    SELECT * INTO ladder FROM public.belt_ladders WHERE studio_id=p_studio_id AND id=source_owner.ladder_id FOR SHARE NOWAIT;
    complete:=complete AND ladder.id IS NOT NULL;
    IF ladder.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.belt_ladders:'||ladder.id::TEXT,true); END IF;
    FOR item IN SELECT * FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=ANY(rank_ids) ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.belt_ranks:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM unnest(rank_ids) id WHERE id IS NOT NULL AND NOT parents ? ('public.belt_ranks:'||id::TEXT));
    END IF;
    FOR item IN SELECT * FROM public.programs WHERE studio_id=p_studio_id AND id=ANY(program_ids) ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.programs:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM unnest(program_ids) id WHERE id IS NOT NULL AND NOT parents ? ('public.programs:'||id::TEXT));
    IF p_event.event_type LIKE 'belt_test.%' THEN
    SELECT * INTO recipient FROM public.belt_test_recipients WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR SHARE NOWAIT;
    complete:=complete AND recipient.id IS NOT NULL;
    IF recipient.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.belt_test_recipients:'||recipient.id::TEXT,true); END IF;
    generations:=jsonb_build_object('approval_revision',recipient.revision,'schedule_revision',belt.schedule_revision,'approved_rank_context_generation',recipient.approved_rank_context_generation); ELSIF p_event.event_type='student.promoted' THEN
    SELECT * INTO promotion FROM public.promotions WHERE studio_id=p_studio_id AND id=p_event.subject_id FOR SHARE NOWAIT;
    complete:=complete AND promotion.id IS NOT NULL;
    IF promotion.id IS NOT NULL THEN parents:=parents||jsonb_build_object('public.promotions:'||promotion.id::TEXT,true); END IF;
    END IF;
    IF p_event.event_type='student.promoted' OR p_event.event_type LIKE 'belt_test.%' THEN SELECT generation INTO rank_generation FROM private.workflow_rank_contexts WHERE studio_id=p_studio_id AND student_id=source_owner.student_id AND student_program_membership_id IS NOT DISTINCT FROM membership_id; generations:=generations||jsonb_build_object('rank_context_generation',rank_generation); END IF;
    IF p_recipient_policy='student_or_guardian' THEN
    FOR item IN SELECT * FROM public.student_guardians WHERE student_id=source_owner.student_id ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.student_guardians:'||item.id::TEXT,true); END LOOP;
    FOR item IN SELECT * FROM public.guardians WHERE studio_id=p_studio_id AND id IN (SELECT guardian_id FROM public.student_guardians WHERE student_id=source_owner.student_id) ORDER BY id FOR SHARE NOWAIT LOOP parents:=parents||jsonb_build_object('public.guardians:'||item.id::TEXT,true); END LOOP;
    complete:=complete AND NOT EXISTS(SELECT 1 FROM public.student_guardians g WHERE g.student_id=source_owner.student_id AND NOT parents ? ('public.guardians:'||g.guardian_id::TEXT)); END IF; END IF;
    RETURN jsonb_build_object('complete',complete,'authority',jsonb_build_object('parents',parents,'generations',generations));
    EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_email_selected_values_v1(p_node JSONB,p_facts JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT coalesce(jsonb_object_agg(name,jsonb_build_object('present',values ? name,'value',values->name)),'{}'::JSONB)
    FROM (SELECT DISTINCT match[1] name FROM regexp_matches((p_node#>>'{config,subject_template}')||E'\n'||(p_node#>>'{config,body_template}'),'\{\{([a-z][a-z0-9_]*)\}\}','g') match) names
    CROSS JOIN LATERAL (SELECT (p_facts->'template_facts')||coalesce(p_facts#>ARRAY['recipients',p_node#>>'{config,recipient}','template_facts'],'{}') values) selected
$$;
CREATE FUNCTION private.workflow_email_fingerprint_v1(p_identity JSONB,p_selected_values JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT private.workflow_hash_v1(jsonb_build_object('identity',p_identity,'selected_values',p_selected_values))
$$;
CREATE FUNCTION private.workflow_email_parameters_valid_v1(p_token TEXT,p_allowed TEXT[],p_reply TEXT,p_api TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT p_token ~ '^[a-f0-9]{64}$' AND private.automation_normalize_email(p_reply) IS NOT NULL AND private.automation_normalize_email(p_reply)=p_reply
        AND p_allowed IS NOT NULL AND coalesce(array_ndims(p_allowed),1)=1 AND array_position(p_allowed,NULL) IS NULL
        AND NOT EXISTS(SELECT 1 FROM unnest(p_allowed) a WHERE private.automation_normalize_email(a) IS NULL OR private.automation_normalize_email(a) IS DISTINCT FROM a)
        AND length(p_api)+89<=2048 AND p_api ~ '^https://[A-Za-z0-9.-]+(:443)?/api/v1$'
        AND split_part(substr(p_api,9),'/',1) LIKE '%.%' AND lower(split_part(substr(p_api,9),'/',1)) !~ '(^|\.)localhost(:443)?$'
$$;
CREATE FUNCTION private.workflow_email_plan_v1(p_run public.automation_workflow_runs,p_event private.automation_workflow_events,
    p_graph JSONB,p_node JSONB,p_reference_at TIMESTAMPTZ,p_unsubscribe_token TEXT,p_allowed_recipients TEXT[],p_default_reply_to TEXT,p_public_api_url TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE trigger_config JSONB; source JSONB; facts JSONB; address JSONB; recipient JSONB; inventory JSONB; identity JSONB;
    workflow public.automation_workflows; activation public.automation_workflow_activations; first_attempt private.automation_workflow_email_attempts;
    token TEXT; url TEXT; reply TEXT; policy TEXT:=p_node#>>'{config,recipient}'; reason TEXT; disposition TEXT:='send';
BEGIN
    SELECT n->'config' INTO trigger_config FROM jsonb_array_elements(p_graph->'nodes') n WHERE n->>'type'='trigger';
    source:=private.workflow_current_source_facts_v1(p_run.studio_id,p_event.event_type,p_event.subject_id,p_event.context,trigger_config,p_reference_at,ARRAY[policy]);
    facts:=source->'facts'; recipient:=facts#>ARRAY['recipients',policy]; address:=source#>ARRAY['recipient_addresses',policy];
    inventory:=private.workflow_email_source_inventory_v1(p_run.studio_id,p_event,trigger_config,policy);
    SELECT * INTO workflow FROM public.automation_workflows WHERE studio_id=p_run.studio_id AND id=p_run.workflow_id;
    SELECT * INTO activation FROM public.automation_workflow_activations WHERE studio_id=p_run.studio_id AND id=p_run.activation_id;
    SELECT * INTO first_attempt FROM private.automation_workflow_email_attempts WHERE studio_id=p_run.studio_id AND run_id=p_run.id AND node_id=p_node->>'id' AND attempt_number=1;
    SELECT unsubscribe_token INTO token FROM private.workflow_email_unsubscribe_pins WHERE studio_id=p_run.studio_id AND run_id=p_run.id AND node_id=p_node->>'id';
    token:=coalesce(token,p_unsubscribe_token); url:=p_public_api_url||'/automations/unsubscribe#'||token;
    reply:=coalesce(private.automation_normalize_email(nullif(btrim(p_node#>>'{config,reply_to_email}'),' ')),p_default_reply_to);
    reason:=CASE WHEN p_run.cancel_requested_at IS NOT NULL THEN p_run.cancel_reason
        WHEN workflow.status='paused' THEN 'workflow_paused' WHEN workflow.status='archived' THEN 'workflow_archived'
        WHEN workflow.id IS NULL OR workflow.status<>'active' OR activation.cancelled_at IS NOT NULL OR activation.epoch<>workflow.enrollment_epoch THEN 'workflow_republished'
        WHEN facts->>'source_decision'='ineligible' THEN facts->>'source_reason' END;
    IF reason IS NOT NULL THEN disposition:='stop';
    ELSIF facts->>'source_decision' IS DISTINCT FROM 'eligible' OR inventory->'complete' IS DISTINCT FROM 'true'::JSONB THEN disposition:='wait'; reason:='facts_unavailable';
    ELSIF NOT private.automation_core_entitled(p_run.studio_id) THEN disposition:='wait'; reason:='subscription_required';
    ELSIF p_event.event_type='invoice.overdue' AND EXISTS(SELECT 1 FROM private.workflow_invoice_episode_pending p WHERE p.studio_id=p_run.studio_id AND p.invoice_id=p_event.subject_id AND p.backend_pid=pg_catalog.pg_backend_pid() AND p.transaction_id=pg_catalog.pg_current_xact_id()) THEN disposition:='wait'; reason:='facts_unavailable';
    ELSIF first_attempt.id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM private.workflow_email_unsubscribe_pins WHERE run_id=p_run.id AND node_id=p_node->>'id')
        OR NOT EXISTS(SELECT 1 FROM private.workflow_email_attempt_payloads WHERE attempt_id=first_attempt.id)) THEN disposition:='wait'; reason:='facts_unavailable';
    ELSIF recipient->>'decision'='unavailable' THEN disposition:='wait'; reason:='facts_unavailable';
    ELSIF recipient->>'decision' IS DISTINCT FROM 'ready' THEN disposition:='skip'; reason:=coalesce(recipient->>'reason','recipient_unavailable');
    ELSIF first_attempt.id IS NOT NULL AND ROW(address->>'email',address->>'kind') IS DISTINCT FROM ROW(first_attempt.recipient_email,first_attempt.recipient_kind) THEN disposition:='skip'; reason:='contact_changed';
    ELSIF cardinality(p_allowed_recipients)>0 AND NOT (address->>'email'=ANY(p_allowed_recipients)) THEN disposition:='skip'; reason:='recipient_not_allowed';
    END IF;
    identity:=jsonb_build_object('studio_id',p_run.studio_id,'run_id',p_run.id,'version_id',p_run.version_id,'activation_id',p_run.activation_id,'epoch',p_run.epoch,
        'node',p_node,'event_id',p_event.id,'event_type',p_event.event_type,'source_authority',inventory->'authority',
        'recipient_policy',policy,'recipient_email',address->'email','recipient_kind',address->'kind','reply_to',reply,'unsubscribe_token',token,'unsubscribe_url',url);
    RETURN jsonb_build_object('fingerprint',private.workflow_email_fingerprint_v1(identity,private.workflow_email_selected_values_v1(p_node,facts)),
        'disposition',disposition,'reason',reason,'event_type',p_event.event_type,'recipient_policy',policy,'recipient_email',address->'email','recipient_kind',address->'kind',
        'subject_template',p_node#>>'{config,subject_template}','body_template',p_node#>>'{config,body_template}','reply_to',reply,'unsubscribe_token',token,'unsubscribe_url',url,'facts',facts);
END $$;
CREATE FUNCTION public.get_workflow_email_plan_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_node_id TEXT,
    p_candidate_unsubscribe_token TEXT,p_allowed_recipients TEXT[],p_default_reply_to TEXT,p_public_api_url TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE result JSONB; at TIMESTAMPTZ:=statement_timestamp();
BEGIN
    IF p_studio_id IS NULL OR p_run_id IS NULL OR p_claim_token IS NULL OR p_node_id IS NULL OR p_node_id !~ '^[A-Za-z0-9_-]{1,64}$'
        OR private.workflow_email_parameters_valid_v1(p_candidate_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- Every nested STABLE read inherits this statement's one snapshot and clock.
    SELECT jsonb_build_object('outcome','planned','run',private.workflow_run_position_v1(r),'plan',private.workflow_email_plan_v1(r,e,v.graph,n,at,p_candidate_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url)) INTO result
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        JOIN public.automation_workflow_versions v ON v.studio_id=r.studio_id AND v.workflow_id=r.workflow_id AND v.id=r.version_id
        CROSS JOIN LATERAL jsonb_array_elements(v.graph->'nodes') n
        JOIN private.automation_workflow_run_steps s ON s.studio_id=r.studio_id AND s.run_id=r.id AND s.node_id=p_node_id AND s.node_type='email' AND s.finished_at IS NULL
        WHERE r.studio_id=p_studio_id AND r.id=p_run_id AND r.current_node_id=p_node_id AND n->>'id'=p_node_id AND n->>'type'='email'
        AND r.state IN ('claimed','running') AND r.claim_token=p_claim_token AND r.lease_expires_at>at;
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'run_id',p_run_id,'claim_token',p_claim_token,'node_id',p_node_id)
        ||coalesce(result,jsonb_build_object('outcome','lease_lost','run',NULL,'plan',NULL)));
END $$;

CREATE FUNCTION private.workflow_email_finish_step_v1(p_studio_id UUID,p_run_id UUID,p_step_id UUID,p_node_id TEXT,
    p_at TIMESTAMPTZ,p_outcome TEXT,p_reason TEXT,p_release_claim BOOLEAN) RETURNS public.automation_workflow_runs
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_run public.automation_workflow_runs; edge JSONB;
BEGIN
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
    SELECT e INTO edge FROM public.automation_workflow_versions v CROSS JOIN LATERAL jsonb_array_elements(v.graph->'edges') e
        WHERE v.studio_id=p_studio_id AND v.workflow_id=v_run.workflow_id AND v.id=v_run.version_id AND e->>'source'=p_node_id AND e->>'port'='next';
    IF edge IS NULL OR v_run.current_node_id IS DISTINCT FROM p_node_id OR v_run.revision=9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    UPDATE private.automation_workflow_run_steps SET outcome=p_outcome,reason=p_reason,edge_id=edge->>'id',finished_at=p_at WHERE studio_id=p_studio_id AND run_id=p_run_id AND id=p_step_id AND finished_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    UPDATE public.automation_workflow_runs SET current_node_id=edge->>'target',state=CASE WHEN p_release_claim THEN 'queued' ELSE 'running' END,next_due_at=p_at,
        claim_token=CASE WHEN NOT p_release_claim THEN claim_token END,lease_expires_at=CASE WHEN NOT p_release_claim THEN lease_expires_at END,
        reason=NULL,deferral_count=0,revision=revision+1,updated_at=p_at WHERE studio_id=p_studio_id AND id=p_run_id RETURNING * INTO v_run;
    RETURN v_run;
END $$;
-- Source-first claim owner. A lost lease rolls back financial preparation in this
-- function's savepoint; real monotonic self-cancellation remains terminal truth.
CREATE FUNCTION private.workflow_email_own_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_node_id TEXT,
    p_unsubscribe_token TEXT,p_allowed_recipients TEXT[],p_default_reply_to TEXT,p_public_api_url TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE original public.automation_workflow_runs; v_run public.automation_workflow_runs; workflow public.automation_workflows;
    event private.automation_workflow_events; version public.automation_workflow_versions; activation public.automation_workflow_activations;
    step private.automation_workflow_run_steps; node JSONB; trigger_config JSONB; ownership JSONB; current_ownership JSONB; plan JSONB; at TIMESTAMPTZ;
BEGIN
    IF p_studio_id IS NULL OR p_run_id IS NULL OR p_claim_token IS NULL OR p_node_id IS NULL OR p_node_id !~ '^[A-Za-z0-9_-]{1,64}$'
        OR private.workflow_email_parameters_valid_v1(p_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    SELECT * INTO original FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
    IF original.id IS NULL OR original.state NOT IN ('claimed','running') OR original.claim_token IS DISTINCT FROM p_claim_token OR original.lease_expires_at<=clock_timestamp() OR original.current_node_id IS DISTINCT FROM p_node_id THEN
        RETURN jsonb_build_object('outcome','lease_lost','run',NULL);
    END IF;
    SELECT * INTO event FROM private.automation_workflow_events WHERE studio_id=p_studio_id AND id=original.event_id;
    SELECT * INTO version FROM public.automation_workflow_versions WHERE studio_id=p_studio_id AND workflow_id=original.workflow_id AND id=original.version_id;
    SELECT n INTO node FROM jsonb_array_elements(version.graph->'nodes') n WHERE n->>'id'=p_node_id AND n->>'type'='email';
    SELECT n->'config' INTO trigger_config FROM jsonb_array_elements(version.graph->'nodes') n WHERE n->>'type'='trigger';
    IF event.id IS NULL OR node IS NULL OR trigger_config->>'event_type' IS DISTINCT FROM event.event_type OR private.workflow_hash_v1(version.graph) IS DISTINCT FROM version.graph_sha256 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.studio_subscriptions WHERE studio_id=p_studio_id FOR SHARE NOWAIT;
    ownership:=private.workflow_lock_email_sources_v1(p_studio_id,event,trigger_config,node#>>'{config,recipient}');
    SELECT * INTO workflow FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=original.workflow_id FOR UPDATE NOWAIT;
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id FOR UPDATE NOWAIT;
    at:=clock_timestamp();
    IF v_run.cancel_requested_at IS NOT NULL AND v_run.state IN ('completed','cancelled','failed','unknown') THEN
        RETURN jsonb_build_object('outcome','stopped','run',private.workflow_run_position_v1(v_run));
    END IF;
    IF v_run.id IS NULL OR v_run.state NOT IN ('claimed','running') OR v_run.claim_token IS DISTINCT FROM p_claim_token OR v_run.lease_expires_at<=at THEN RAISE EXCEPTION USING ERRCODE='P57L1'; END IF;
    IF workflow.id IS NULL OR ROW(v_run.workflow_id,v_run.version_id,v_run.event_id,v_run.activation_id,v_run.epoch,v_run.current_node_id)
        IS DISTINCT FROM ROW(original.workflow_id,original.version_id,original.event_id,original.activation_id,original.epoch,p_node_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT * INTO activation FROM public.automation_workflow_activations WHERE studio_id=p_studio_id AND id=v_run.activation_id AND workflow_id=v_run.workflow_id AND version_id=v_run.version_id AND epoch=v_run.epoch;
    SELECT * INTO step FROM private.automation_workflow_run_steps WHERE studio_id=p_studio_id AND run_id=p_run_id AND node_id=p_node_id FOR UPDATE NOWAIT;
    IF activation.id IS NULL OR step.id IS NULL OR step.node_type<>'email' OR step.finished_at IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    plan:=private.workflow_email_plan_v1(v_run,event,version.graph,node,at,p_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url);
    IF plan->>'disposition'='stop' THEN
        PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY[p_run_id],at,plan->>'reason');
        UPDATE private.automation_workflow_run_steps SET outcome='cancelled',reason=plan->>'reason',finished_at=at WHERE id=step.id AND finished_at IS NULL;
        SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
        RETURN jsonb_build_object('outcome','stopped','run',private.workflow_run_position_v1(v_run));
    END IF;
    current_ownership:=private.workflow_email_source_inventory_v1(p_studio_id,event,trigger_config,node#>>'{config,recipient}');
    IF ownership->'complete' IS DISTINCT FROM 'true'::JSONB OR current_ownership#>'{authority,parents}' IS DISTINCT FROM ownership#>'{authority,parents}' THEN
        v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,at,'facts_unavailable');
        RETURN jsonb_build_object('outcome','waiting','run',private.workflow_run_position_v1(v_run));
    END IF;
    RETURN jsonb_build_object('outcome','owned','run',to_jsonb(v_run),'event',to_jsonb(event),'graph',version.graph,'node',node,'step_id',step.id,'plan',plan);
EXCEPTION WHEN SQLSTATE 'P57L1' THEN RETURN jsonb_build_object('outcome','lease_lost','run',NULL);
    WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;
CREATE FUNCTION public.resolve_workflow_email_without_attempt_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_node_id TEXT,
    p_plan_fingerprint TEXT,p_unsubscribe_token TEXT,p_allowed_recipients TEXT[],p_default_reply_to TEXT,p_public_api_url TEXT,p_resolution JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE owned JSONB; plan JSONB; v_run public.automation_workflow_runs; outcome TEXT; reason TEXT; kind TEXT:=p_resolution->>'kind'; result JSONB;
BEGIN
    IF p_plan_fingerprint IS NULL OR p_plan_fingerprint !~ '^[a-f0-9]{64}$'
        OR kind IS NULL OR kind NOT IN ('plan_decision','render_failed','facts_unavailable','sender_unavailable')
        OR NOT private.workflow_json_keys_v1(p_resolution,CASE WHEN kind='render_failed' THEN ARRAY['kind','reason'] ELSE ARRAY['kind'] END,CASE WHEN kind='render_failed' THEN ARRAY['kind','reason'] ELSE ARRAY['kind'] END)
        OR (kind='render_failed' AND (p_resolution->>'reason' IS NULL OR p_resolution->>'reason' NOT IN ('unsupported_currency','invalid_email_template','invalid_email_context'))) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    owned:=private.workflow_email_own_v1(p_studio_id,p_run_id,p_claim_token,p_node_id,p_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url);
    outcome:=owned->>'outcome';
    IF outcome='owned' THEN
        v_run:=jsonb_populate_record(NULL::public.automation_workflow_runs,owned->'run'); plan:=owned->'plan';
        IF plan->>'fingerprint' IS DISTINCT FROM p_plan_fingerprint OR (kind='plan_decision' AND plan->>'disposition'='send') THEN outcome:='stale_plan';
        ELSIF plan->>'disposition'='wait' OR kind IN ('facts_unavailable','sender_unavailable') THEN
            reason:=CASE WHEN plan->>'disposition'='wait' THEN plan->>'reason' ELSE kind END;
            v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,clock_timestamp(),reason); outcome:='waiting';
        ELSE
            reason:=CASE WHEN kind='render_failed' THEN p_resolution->>'reason' ELSE plan->>'reason' END;
            v_run:=private.workflow_email_finish_step_v1(p_studio_id,p_run_id,(owned->>'step_id')::UUID,p_node_id,clock_timestamp(),'skipped',reason,false); outcome:='continue';
        END IF;
        result:=private.workflow_run_position_v1(v_run);
    ELSE result:=owned->'run'; END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'run_id',p_run_id,'claim_token',p_claim_token,'node_id',p_node_id,'outcome',outcome,'run',result));
END $$;

CREATE FUNCTION public.begin_workflow_email_v1(p_studio_id UUID,p_run_id UUID,p_claim_token UUID,p_node_id TEXT,
    p_plan_fingerprint TEXT,p_unsubscribe_token TEXT,p_allowed_recipients TEXT[],p_default_reply_to TEXT,p_public_api_url TEXT,
    p_rendered JSONB,p_preparation_id UUID,p_preparation_token UUID,p_probe_token UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE owned JSONB; plan JSONB; fresh_plan JSONB; admission JSONB; attempt_payload JSONB; result JSONB;
    v_run public.automation_workflow_runs; event private.automation_workflow_events; actual private.automation_email_attempt_reservations;
    prior UUID; new_id UUID:=gen_random_uuid(); outcome TEXT; reason TEXT; at TIMESTAMPTZ; retry TIMESTAMPTZ; starts TIMESTAMPTZ;
BEGIN
    IF p_plan_fingerprint IS NULL OR p_plan_fingerprint !~ '^[a-f0-9]{64}$' OR p_preparation_id IS NULL OR p_preparation_token IS NULL
        OR private.workflow_email_rendered_valid_v1(p_rendered) IS DISTINCT FROM true
        OR private.workflow_email_parameters_valid_v1(p_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    -- A claim can yield only one actual begin for this node, even after settlement.
    SELECT a.id INTO prior FROM private.automation_email_attempt_reservations a WHERE a.studio_id=p_studio_id AND a.scope_kind='workflow' AND a.scope_id=p_run_id AND a.node_id=p_node_id AND a.owner_token=p_claim_token AND a.origin='actual';
    IF prior IS NOT NULL THEN
        SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=p_run_id;
        IF v_run.id IS NULL THEN outcome:='lease_lost'; result:=NULL; ELSE outcome:='already_begun'; result:=private.workflow_run_position_v1(v_run); END IF;
    ELSE
        owned:=private.workflow_email_own_v1(p_studio_id,p_run_id,p_claim_token,p_node_id,p_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url);
        outcome:=owned->>'outcome';
        IF outcome='owned' THEN
            v_run:=jsonb_populate_record(NULL::public.automation_workflow_runs,owned->'run'); event:=jsonb_populate_record(NULL::private.automation_workflow_events,owned->'event'); plan:=owned->'plan';
            IF plan->>'fingerprint' IS DISTINCT FROM p_plan_fingerprint THEN outcome:='stale_plan';
            ELSIF plan->>'disposition'='wait' THEN
                v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,clock_timestamp(),plan->>'reason'); outcome:='waiting';
            ELSIF plan->>'disposition'='skip' THEN
                v_run:=private.workflow_email_finish_step_v1(p_studio_id,p_run_id,(owned->>'step_id')::UUID,p_node_id,clock_timestamp(),'skipped',plan->>'reason',true); outcome:='skipped';
            ELSE
                BEGIN
                    admission:=private.automation_email_attempt_begin_v1(p_studio_id,'workflow',p_run_id,p_node_id,new_id,p_claim_token,plan->>'recipient_email',p_preparation_id,p_preparation_token,p_probe_token);
                    -- Common admission may wait on its gate/preparation. All sources
                    -- are already frozen, but clocks and lease must be sampled again.
                    at:=clock_timestamp();
                    IF v_run.lease_expires_at<=at THEN RAISE EXCEPTION USING ERRCODE='P57L1'; END IF;
                    fresh_plan:=private.workflow_email_plan_v1(v_run,event,owned->'graph',owned->'node',at,p_unsubscribe_token,p_allowed_recipients,p_default_reply_to,p_public_api_url);
                    IF fresh_plan->>'disposition'='stop' OR fresh_plan->>'fingerprint' IS DISTINCT FROM p_plan_fingerprint OR fresh_plan->>'disposition' IS DISTINCT FROM 'send' THEN
                        RAISE EXCEPTION USING ERRCODE='P57T1';
                    END IF;
                    IF admission->>'outcome'='begun' THEN
                        SELECT * INTO actual FROM private.automation_email_attempt_reservations WHERE id=new_id;
                        INSERT INTO private.automation_workflow_email_attempts(id,studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at)
                            VALUES(actual.id,p_studio_id,p_run_id,(owned->>'step_id')::UUID,p_node_id,actual.attempt_number,'sending',actual.recipient_email,plan->>'recipient_kind',actual.actual_began_at);
                        IF actual.attempt_number=1 THEN
                            INSERT INTO private.workflow_email_unsubscribe_pins(studio_id,run_id,step_id,node_id,first_attempt_id,unsubscribe_token,created_at)
                                VALUES(p_studio_id,p_run_id,(owned->>'step_id')::UUID,p_node_id,actual.id,plan->>'unsubscribe_token',actual.actual_began_at);
                            PERFORM private.automation_bind_unsubscribe_token_v1(p_studio_id,plan->>'unsubscribe_token',actual.recipient_email);
                        END IF;
                        INSERT INTO private.workflow_email_attempt_payloads(attempt_id,studio_id,run_id,step_id,node_id,plan_fingerprint,reply_to,rendered,selected_template_facts,created_at)
                            VALUES(actual.id,p_studio_id,p_run_id,(owned->>'step_id')::UUID,p_node_id,p_plan_fingerprint,plan->>'reply_to',p_rendered,
                                private.workflow_email_selected_values_v1(owned->'node',plan->'facts'),actual.actual_began_at);
                        UPDATE private.automation_workflow_run_steps SET outcome='sending',reason=NULL WHERE id=(owned->>'step_id')::UUID;
                        UPDATE public.automation_workflow_runs SET state='sending',next_due_at=NULL,lease_expires_at=actual.lease_expires_at,
                            reason=NULL,deferral_count=0,revision=revision+1,updated_at=actual.actual_began_at WHERE studio_id=p_studio_id AND id=p_run_id RETURNING * INTO v_run;
                        attempt_payload:=jsonb_build_object('id',actual.id,'attempt_number',actual.attempt_number,'lease_expires_at',private.automation_utc_text_v1(actual.lease_expires_at),
                            'credential_revision',actual.admitted_credential_revision,'sender_binding',actual.sender_binding,
                            'message',p_rendered||jsonb_build_object('to_address',actual.recipient_email,'reply_to',plan->>'reply_to','attempt_id',actual.id)); outcome:='begun';
                    ELSE
                        reason:=admission->>'reason'; retry:=(admission->>'retry_at')::TIMESTAMPTZ;
                        starts:=CASE WHEN event.event_type IN ('trial.scheduled','trial.upcoming') THEN private.automation_instant_v1(plan#>'{facts,anchors,trial.starts_at}')
                            WHEN event.event_type LIKE 'belt_test.%' THEN private.automation_instant_v1(plan#>'{facts,anchors,belt_test.starts_at}') END;
                        IF reason IN ('recipient_suppressed','scope_terminal','retry_exhausted') OR (reason='rate_limited' AND starts IS NOT NULL AND retry>=starts) THEN
                            v_run:=private.workflow_email_finish_step_v1(p_studio_id,p_run_id,(owned->>'step_id')::UUID,p_node_id,at,'skipped',CASE WHEN reason='rate_limited' THEN 'event_window_exhausted' ELSE reason END,true); outcome:='skipped';
                        ELSE
                            v_run:=private.workflow_defer_owned_run_v1(p_studio_id,p_run_id,at,'sender_unavailable');
                            IF retry>v_run.next_due_at THEN UPDATE public.automation_workflow_runs SET next_due_at=retry WHERE id=p_run_id RETURNING * INTO v_run; END IF;
                            outcome:='waiting';
                        END IF;
                    END IF;
                EXCEPTION WHEN SQLSTATE 'P57T1' THEN
                    -- Admission, frequency, probe and attempt writes roll back before
                    -- projecting the fresh no-attempt decision.
                    IF fresh_plan->>'disposition'='stop' THEN
                        PERFORM private.workflow_cancel_runs_v1(p_studio_id,ARRAY[p_run_id],clock_timestamp(),fresh_plan->>'reason');
                        UPDATE private.automation_workflow_run_steps SET outcome='cancelled',reason=fresh_plan->>'reason',finished_at=clock_timestamp() WHERE id=(owned->>'step_id')::UUID;
                        SELECT * INTO v_run FROM public.automation_workflow_runs WHERE id=p_run_id; outcome:='stopped';
                    ELSE outcome:='stale_plan'; END IF;
                END;
            END IF;
            result:=private.workflow_run_position_v1(v_run);
        ELSE result:=owned->'run'; END IF;
    END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'run_id',p_run_id,'claim_token',p_claim_token,'node_id',p_node_id,'outcome',outcome,'run',result,'attempt',attempt_payload));
EXCEPTION WHEN SQLSTATE 'P57L1' THEN
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'run_id',p_run_id,'claim_token',p_claim_token,'node_id',p_node_id,'outcome','lease_lost','run',NULL,'attempt',NULL));
    WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.workflow_email_project_settlement_v1(p_attempt_id UUID,p_replayed BOOLEAN) RETURNS public.automation_workflow_runs
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE actual private.automation_email_attempt_reservations; metadata private.automation_workflow_email_attempts;
    v_run public.automation_workflow_runs; at TIMESTAMPTZ; due TIMESTAMPTZ; v_reason TEXT;
BEGIN
    SELECT * INTO actual FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id;
    SELECT * INTO metadata FROM private.automation_workflow_email_attempts WHERE id=p_attempt_id;
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=metadata.studio_id AND id=metadata.run_id;
    IF actual.id IS NULL OR metadata.id IS NULL OR v_run.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF p_replayed THEN RETURN v_run; END IF;
    IF metadata.state<>'sending' OR actual.state='sending' OR v_run.state<>'sending' OR v_run.current_node_id<>metadata.node_id
        OR v_run.claim_token IS DISTINCT FROM actual.owner_token OR v_run.revision=9223372036854775807 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    at:=actual.settled_at; v_reason:=actual.result->>'error_code';
    UPDATE private.automation_workflow_email_attempts SET state=actual.state,reason=v_reason,settled_at=at,
        submission_evidence=actual.result->>'submission_evidence',failure_scope=actual.result->>'failure_scope' WHERE id=metadata.id;
    IF v_run.cancel_requested_at IS NOT NULL OR actual.state='unknown' THEN
        UPDATE private.automation_workflow_run_steps SET outcome=actual.state,reason=v_reason,finished_at=at WHERE id=metadata.step_id;
        UPDATE public.automation_workflow_runs SET state=CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'unknown' END,
            reason=coalesce(cancel_reason,v_reason,'provider_submission_unknown'),claim_token=NULL,lease_expires_at=NULL,next_due_at=NULL,revision=revision+1,updated_at=at
            WHERE id=v_run.id RETURNING * INTO v_run;
    ELSIF actual.state='accepted' THEN
        v_run:=private.workflow_email_finish_step_v1(metadata.studio_id,metadata.run_id,metadata.step_id,metadata.node_id,at,'accepted',NULL,true);
    ELSIF actual.attempt_number>=3 OR (actual.result->>'outcome'='permanent_failure' AND actual.result->>'failure_scope'='message') THEN
        v_run:=private.workflow_email_finish_step_v1(metadata.studio_id,metadata.run_id,metadata.step_id,metadata.node_id,at,'failed',CASE WHEN actual.attempt_number>=3 THEN 'retry_exhausted' ELSE v_reason END,true);
    ELSIF actual.result->>'outcome'='retryable_failure' OR actual.result->>'failure_scope' IN ('sender_auth','sender_transient') THEN
        due:=at+make_interval(secs=>least(3600,greatest(60*(1<<(actual.attempt_number-1)),coalesce((actual.result->>'retry_after_seconds')::INTEGER,0))));
        UPDATE private.automation_workflow_run_steps SET outcome='waiting',reason=v_reason WHERE id=metadata.step_id;
        UPDATE public.automation_workflow_runs SET state='waiting',next_due_at=due,claim_token=NULL,lease_expires_at=NULL,reason=coalesce(v_reason,'sender_unavailable'),
            deferral_count=0,revision=revision+1,updated_at=at WHERE id=v_run.id RETURNING * INTO v_run;
    ELSE
        UPDATE private.automation_workflow_run_steps SET outcome='failed',reason=v_reason,finished_at=at WHERE id=metadata.step_id;
        UPDATE public.automation_workflow_runs SET state='failed',next_due_at=NULL,claim_token=NULL,lease_expires_at=NULL,reason=coalesce(v_reason,'provider_rejected'),revision=revision+1,updated_at=at WHERE id=v_run.id RETURNING * INTO v_run;
    END IF;
    RETURN v_run;
END $$;
CREATE FUNCTION public.settle_workflow_email_v1(p_studio_id UUID,p_attempt_id UUID,p_claim_token UUID,p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE metadata private.automation_workflow_email_attempts; actual private.automation_email_attempt_reservations;
    v_run public.automation_workflow_runs; settlement JSONB; result JSONB:=jsonb_build_object('studio_id',p_studio_id,'attempt_id',p_attempt_id,'updated',false,'replayed',false,'state',NULL,'reason',NULL,'run',NULL);
BEGIN
    SELECT * INTO metadata FROM private.automation_workflow_email_attempts WHERE studio_id=p_studio_id AND id=p_attempt_id;
    SELECT * INTO actual FROM private.automation_email_attempt_reservations WHERE id=p_attempt_id AND studio_id=p_studio_id AND scope_kind='workflow' AND origin='actual';
    IF metadata.id IS NULL OR actual.id IS NULL OR p_claim_token IS NULL OR actual.owner_token IS DISTINCT FROM p_claim_token OR actual.scope_id IS DISTINCT FROM metadata.run_id OR actual.node_id IS DISTINCT FROM metadata.node_id THEN RETURN jsonb_build_object('payload',result); END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=metadata.run_id;
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=v_run.workflow_id FOR UPDATE NOWAIT;
    SELECT * INTO v_run FROM public.automation_workflow_runs WHERE studio_id=p_studio_id AND id=metadata.run_id FOR UPDATE NOWAIT;
    IF v_run.id IS NULL THEN RETURN jsonb_build_object('payload',result); END IF;
    PERFORM 1 FROM private.automation_workflow_email_attempts WHERE id=metadata.id FOR UPDATE NOWAIT;
    settlement:=private.automation_email_attempt_settle_v1(p_attempt_id,p_claim_token,p_result);
    IF settlement->>'outcome'='refused' THEN RETURN jsonb_build_object('payload',result); END IF;
    v_run:=private.workflow_email_project_settlement_v1(p_attempt_id,settlement->>'outcome'='replayed');
    result:=result||jsonb_build_object('updated',true,'replayed',settlement->>'outcome'='replayed','state',settlement->>'state','reason',settlement#>'{result,error_code}','run',private.workflow_run_position_v1(v_run));
    RETURN jsonb_build_object('payload',result);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

-- Raw lease/id LIMIT precedes ownership. Acquire the entire parent union before
-- entering the common gate, because returning keeps every transaction lock.
CREATE FUNCTION private.workflow_expire_email_attempts_v1(p_limit INTEGER DEFAULT 100) RETURNS INTEGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE ids UUID[]; item RECORD; result JSONB; count_expired INTEGER:=0; cutoff TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    SELECT coalesce(array_agg(id ORDER BY lease_expires_at,id),'{}'::UUID[]) INTO ids FROM (
        SELECT id,lease_expires_at FROM private.automation_email_attempt_reservations WHERE scope_kind='workflow' AND origin='actual' AND state='sending' AND lease_expires_at<=cutoff ORDER BY lease_expires_at,id LIMIT p_limit) raw;
    FOR item IN SELECT DISTINCT studio_id FROM private.automation_email_attempt_reservations WHERE id=ANY(ids) ORDER BY studio_id LOOP
        IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||item.studio_id::TEXT,0)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
        PERFORM 1 FROM public.studios WHERE id=item.studio_id FOR KEY SHARE NOWAIT;
    END LOOP;
    PERFORM 1 FROM public.automation_workflows w WHERE EXISTS(SELECT 1 FROM public.automation_workflow_runs r JOIN private.automation_email_attempt_reservations a ON a.studio_id=r.studio_id AND a.scope_id=r.id WHERE a.id=ANY(ids) AND r.workflow_id=w.id AND r.studio_id=w.studio_id) ORDER BY w.studio_id,w.id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_workflow_runs r WHERE EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations a WHERE a.id=ANY(ids) AND a.studio_id=r.studio_id AND a.scope_id=r.id) ORDER BY r.studio_id,r.id FOR UPDATE NOWAIT;
    PERFORM 1 FROM private.automation_workflow_email_attempts WHERE id=ANY(ids) ORDER BY studio_id,id FOR UPDATE NOWAIT;
    FOR item IN SELECT * FROM private.automation_email_attempt_reservations WHERE id=ANY(ids) ORDER BY studio_id,scope_id,node_id,id LOOP
        PERFORM private.automation_email_scope_lock_v1(item.studio_id,'workflow',item.scope_id,item.node_id,item.recipient_email);
        PERFORM 1 FROM private.automation_email_credentials WHERE provider_key=item.provider_key FOR SHARE NOWAIT;
        PERFORM 1 FROM private.automation_email_attempt_reservations WHERE id=item.id FOR UPDATE NOWAIT;
    END LOOP;
    FOR item IN SELECT * FROM private.automation_email_attempt_reservations WHERE id=ANY(ids) ORDER BY lease_expires_at,id LOOP
        result:=private.automation_email_attempt_expire_v1(item.id);
        IF result->>'outcome'='confirmed' THEN
            IF EXISTS(SELECT 1 FROM private.automation_workflow_email_attempts WHERE id=item.id) THEN
                PERFORM private.workflow_email_project_settlement_v1(item.id,false);
            ELSIF EXISTS(SELECT 1 FROM public.studios WHERE id=item.studio_id) THEN
                RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
            END IF;
            count_expired:=count_expired+1;
        END IF;
    END LOOP;
    RETURN count_expired;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;
ALTER TABLE private.workflow_email_unsubscribe_pins OWNER TO postgres;
ALTER TABLE private.workflow_email_attempt_payloads OWNER TO postgres;
ALTER TABLE private.workflow_email_unsubscribe_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.workflow_email_attempt_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.workflow_email_unsubscribe_pins,private.workflow_email_attempt_payloads FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,DELETE ON private.workflow_email_unsubscribe_pins,private.workflow_email_attempt_payloads TO service_role;
CREATE POLICY reject_client_access ON private.workflow_email_unsubscribe_pins AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY reject_client_access ON private.workflow_email_attempt_payloads AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
DO $graph_mail_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('workflow_email_rendered_valid_v1','workflow_email_payload_identity_v1','workflow_email_payload_delete_v1',
            'workflow_lock_recipient_auth_v1','workflow_email_source_inventory_v1','workflow_lock_email_sources_v1','workflow_email_selected_values_v1',
            'workflow_email_fingerprint_v1','workflow_email_parameters_valid_v1','workflow_email_plan_v1','workflow_email_finish_step_v1',
            'workflow_email_own_v1','workflow_email_project_settlement_v1','workflow_expire_email_attempts_v1'))
        OR (n.nspname='public' AND p.proname IN ('get_workflow_email_plan_v1','resolve_workflow_email_without_attempt_v1','begin_workflow_email_v1','settle_workflow_email_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.proname NOT IN ('workflow_email_payload_identity_v1','workflow_email_payload_delete_v1') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity); END IF;
    END LOOP;
END;
$graph_mail_privileges$;

-- Foreground synthetic mail owns one immutable command and at most one real send.
-- Selected templates and rendered bytes can be purged without erasing its truth.
CREATE FUNCTION private.automation_test_rendered_valid_v1(p_rendered JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE subject TEXT:=p_rendered->>'subject'; body TEXT:=p_rendered->>'text_body'; ch TEXT;
BEGIN
    IF NOT private.workflow_json_keys_v1(p_rendered,ARRAY['subject','text_body','html_body'],ARRAY['subject','text_body','html_body'])
        OR jsonb_typeof(p_rendered->'subject') IS DISTINCT FROM 'string' OR jsonb_typeof(p_rendered->'text_body') IS DISTINCT FROM 'string'
        OR jsonb_typeof(p_rendered->'html_body') IS DISTINCT FROM 'string'
        OR left(subject,7)<>'[Test] ' OR left(body,46)<>E'Synthetic automation test. Sample data only.\n\n'
        OR length(subject)>207 OR octet_length(subject)>807 OR length(body)>20046 OR octet_length(body)>80046
        OR length(p_rendered->>'html_body')>120317 OR octet_length(p_rendered->>'html_body')>120317
        OR btrim(substr(subject,8),U&'\0009\000A\000B\000C\000D\001C\001D\001E\001F\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000')='' OR btrim(substr(body,47),U&'\0009\000A\000B\000C\000D\001C\001D\001E\001F\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000')='' THEN RETURN false; END IF;
    FOR ch IN SELECT regexp_split_to_table(subject,'') LOOP
        IF ascii(ch)<32 OR ascii(ch) BETWEEN 127 AND 159 THEN RETURN false; END IF;
    END LOOP;
    FOR ch IN SELECT regexp_split_to_table(body,'') LOOP
        IF (ascii(ch)<32 AND ascii(ch) NOT IN (9,10)) OR ascii(ch) BETWEEN 127 AND 159 THEN RETURN false; END IF;
    END LOOP;
    -- Compare only the established plain-text escaping profile, never render a template.
    RETURN p_rendered->>'html_body'='<div style="white-space: pre-wrap">'||
        replace(replace(replace(replace(replace(body,'&','&amp;'),'<','&lt;'),'>','&gt;'),'"','&quot;'),'''','&#x27;')||'</div>';
END $$;

CREATE TABLE private.automation_test_email_scopes (
    id UUID PRIMARY KEY, studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL, workflow_id UUID NOT NULL, operation_id UUID NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
    scope_fingerprint TEXT NOT NULL CHECK(scope_fingerprint ~ '^[a-f0-9]{64}$'),
    execution_token UUID NOT NULL UNIQUE, reference_time TIMESTAMPTZ NOT NULL CHECK(private.automation_sender_instant_v1(reference_time)),
    execution_expires_at TIMESTAMPTZ NOT NULL CHECK(execution_expires_at=reference_time+INTERVAL '60 seconds'),
    recipient_email TEXT NOT NULL CHECK(private.automation_normalize_email(recipient_email)=recipient_email AND private.automation_normalize_email(recipient_email) IS NOT NULL),
    reply_to TEXT NOT NULL CHECK(private.automation_normalize_email(reply_to)=reply_to AND private.automation_normalize_email(reply_to) IS NOT NULL),
    sender_binding TEXT NOT NULL CHECK(sender_binding ~ '^[a-f0-9]{64}$'),
    state TEXT NOT NULL CHECK(state IN ('queued','sending','accepted','failed','unknown')),
    reason TEXT CHECK(reason IN ('invalid_email_template','invalid_email_context','unsupported_currency','invalid_email_url','facts_unavailable',
        'sender_unavailable','subscription_required','recipient_changed','recipient_suppressed','lease_expired','budget_exhausted')),
    preparation_id UUID, attempt_id UUID UNIQUE,
    created_at TIMESTAMPTZ NOT NULL CHECK(created_at=reference_time),
    updated_at TIMESTAMPTZ NOT NULL CHECK(private.automation_sender_instant_v1(updated_at) AND updated_at>=created_at),
    settled_at TIMESTAMPTZ CHECK(private.automation_sender_instant_v1(settled_at) AND settled_at>=created_at),
    UNIQUE(studio_id,operation_id), UNIQUE(studio_id,id),
    CHECK((state IN ('queued','sending') AND reason IS NULL AND settled_at IS NULL)
        OR (state IN ('accepted','failed','unknown') AND settled_at IS NOT NULL)),
    CHECK((state IN ('sending','accepted','unknown') AND attempt_id IS NOT NULL) OR state IN ('queued','failed')),
    CHECK(state<>'queued' OR attempt_id IS NULL), CHECK(attempt_id IS NULL OR preparation_id IS NOT NULL)
);
CREATE TABLE private.automation_test_email_payloads (
    scope_id UUID PRIMARY KEY, studio_id UUID NOT NULL,
    selection JSONB NOT NULL CHECK(jsonb_typeof(selection)='object' AND octet_length(selection::TEXT)<=32000),
    rendered JSONB CHECK(rendered IS NULL OR private.automation_test_rendered_valid_v1(rendered)),
    FOREIGN KEY(studio_id,scope_id) REFERENCES private.automation_test_email_scopes(studio_id,id) ON DELETE CASCADE
);
CREATE INDEX automation_test_email_scope_expiry ON private.automation_test_email_scopes(studio_id,execution_expires_at,id) WHERE state='queued';

CREATE FUNCTION private.automation_test_scope_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE actual private.automation_email_attempt_reservations;
BEGIN
    IF (to_jsonb(NEW)-ARRAY['state','reason','preparation_id','attempt_id','updated_at','settled_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason','preparation_id','attempt_id','updated_at','settled_at'])
        OR (OLD.state<>'queued' AND NEW.preparation_id IS DISTINCT FROM OLD.preparation_id)
        OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS DISTINCT FROM OLD.attempt_id)
        OR (OLD.preparation_id IS NOT NULL AND NEW.preparation_id IS DISTINCT FROM OLD.preparation_id)
        OR (OLD.state IN ('accepted','failed','unknown') AND NEW IS DISTINCT FROM OLD)
        OR (OLD.state='sending' AND NEW.state NOT IN ('sending','accepted','failed','unknown'))
        OR NEW.updated_at<OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD'; END IF;
    IF NEW.attempt_id IS NOT NULL THEN
        SELECT * INTO actual FROM private.automation_email_attempt_reservations WHERE id=NEW.attempt_id;
        IF actual.id IS NULL OR ROW(actual.studio_id,actual.scope_kind,actual.scope_id,actual.node_id,actual.owner_token,actual.recipient_email,actual.preparation_id,actual.state)
            IS DISTINCT FROM ROW(NEW.studio_id,'test'::TEXT,NEW.id,NULL::TEXT,NEW.execution_token,NEW.recipient_email,NEW.preparation_id,NEW.state) THEN
            RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION private.automation_test_payload_identity_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes;
BEGIN
    SELECT * INTO scope FROM private.automation_test_email_scopes WHERE studio_id=NEW.studio_id AND id=NEW.scope_id;
    IF scope.id IS NULL OR (TG_OP='INSERT' AND (scope.state<>'queued' OR NEW.rendered IS NOT NULL))
        OR (TG_OP='UPDATE' AND (ROW(NEW.scope_id,NEW.studio_id,NEW.selection) IS DISTINCT FROM ROW(OLD.scope_id,OLD.studio_id,OLD.selection)
            OR OLD.rendered IS NOT NULL OR NEW.rendered IS NULL OR scope.state<>'sending' OR scope.attempt_id IS NULL)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_IMMUTABLE_RECORD'; END IF;
    RETURN NEW;
END $$;
CREATE FUNCTION private.automation_test_clear_owned_v1(p_studio_id UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_catalog.pg_backend_pid()
        AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
        AND l.classid=((pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)>>32)&4294967295)::OID
        AND l.objid=(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)&4294967295)::OID
        AND l.objsubid=1 AND l.mode='ExclusiveLock' AND l.granted)
$$;
CREATE FUNCTION private.automation_test_payload_delete_v1() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.studios WHERE id=OLD.studio_id) THEN RETURN OLD; END IF;
    IF NOT private.automation_test_clear_owned_v1(OLD.studio_id)
        OR EXISTS(SELECT 1 FROM private.automation_test_email_scopes WHERE studio_id=OLD.studio_id AND id=OLD.scope_id AND state='queued') THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_PAYLOAD_CLEAR_REQUIRED'; END IF;
    RETURN OLD;
END $$;
CREATE TRIGGER automation_test_scope_identity BEFORE UPDATE ON private.automation_test_email_scopes FOR EACH ROW EXECUTE FUNCTION private.automation_test_scope_identity_v1();
CREATE TRIGGER automation_test_payload_identity BEFORE INSERT OR UPDATE ON private.automation_test_email_payloads FOR EACH ROW EXECUTE FUNCTION private.automation_test_payload_identity_v1();
CREATE TRIGGER automation_test_payload_delete BEFORE DELETE ON private.automation_test_email_payloads FOR EACH ROW EXECUTE FUNCTION private.automation_test_payload_delete_v1();

-- Only this narrow projection reads Auth. Authority uses current relational roles.
CREATE FUNCTION private.automation_test_verified_email_v1(p_actor_id UUID) RETURNS TEXT
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
    SELECT private.automation_normalize_email(u.email) FROM auth.users u WHERE u.id=p_actor_id AND u.email_confirmed_at IS NOT NULL
$$;
CREATE FUNCTION private.automation_test_actor_v1(p_studio_id UUID,p_actor_id UUID) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED'; END IF;
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
    IF NOT private.workflow_lock_recipient_auth_v1(p_actor_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED'; END IF;
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;
CREATE FUNCTION private.automation_test_result_v1(p_scope private.automation_test_email_scopes) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('operation_id',p_scope.operation_id,'test_delivery_id',p_scope.id,'state',p_scope.state)
$$;
CREATE FUNCTION private.automation_test_allowed_v1(p_allowed TEXT[]) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT p_allowed IS NOT NULL AND cardinality(p_allowed)<=100 AND NOT EXISTS(SELECT 1 FROM unnest(p_allowed) email
        WHERE email IS NULL OR private.automation_normalize_email(email) IS NULL OR private.automation_normalize_email(email)<>email)
        AND p_allowed=ARRAY(SELECT DISTINCT email FROM unnest(p_allowed) email ORDER BY email)
$$;
CREATE FUNCTION private.automation_test_execution_v1(p_scope private.automation_test_email_scopes,p_selection JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
    SELECT jsonb_build_object('execution_token',p_scope.execution_token,'lease_expires_at',private.automation_utc_text_v1(p_scope.execution_expires_at),
        'scope_fingerprint',p_scope.scope_fingerprint,'reference_time',private.automation_utc_text_v1(p_scope.reference_time),
        'event_type',p_selection#>>'{trigger,event_type}','trigger_context',jsonb_build_object('program_id',p_selection#>'{trigger,program_id}',
            'offset_minutes',p_selection#>'{trigger,offset_minutes}'),'email_node_id',p_selection->>'email_node_id',
        'recipient_policy',p_selection#>>'{email,recipient}','subject_template',p_selection#>>'{email,subject_template}',
        'body_template',p_selection#>>'{email,body_template}','recipient_email',p_scope.recipient_email,'reply_to',p_scope.reply_to)
$$;

CREATE FUNCTION public.create_automation_test_email_v1(p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,p_operation_id UUID,
    p_graph JSONB,p_email_node_id TEXT,p_runtime JSONB,p_replay_only BOOLEAN DEFAULT false) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE receipt private.automation_command_operations; scope private.automation_test_email_scopes; fingerprint TEXT; selection JSONB;
    trigger_config JSONB; email_config JSONB; recipient TEXT; reply TEXT; allowed TEXT[]; at TIMESTAMPTZ;
BEGIN
    PERFORM private.automation_test_actor_v1(p_studio_id,p_actor_id);
    IF p_workflow_id IS NULL OR p_operation_id IS NULL OR p_email_node_id IS NULL OR p_email_node_id !~ '^[A-Za-z0-9_-]{1,64}$'
        OR p_graph IS NULL OR p_replay_only IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    fingerprint:=private.workflow_hash_v1(jsonb_build_object('command','test_email.create','studio_id',p_studio_id,'actor_id',p_actor_id,
        'workflow_id',p_workflow_id,'operation_id',p_operation_id,'graph',p_graph,'email_node_id',p_email_node_id));
    IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('automation.operation:'||p_studio_id::TEXT||':'||p_operation_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
    SELECT * INTO receipt FROM private.automation_command_operations WHERE studio_id=p_studio_id AND operation_id=p_operation_id;
    IF receipt.operation_id IS NOT NULL THEN
        IF ROW(receipt.actor_id,receipt.command,receipt.request_fingerprint) IS DISTINCT FROM ROW(p_actor_id,'test_email.create'::TEXT,fingerprint) THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_OPERATION_CONFLICT'; END IF;
        RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'actor_id',p_actor_id,'workflow_id',p_workflow_id,
            'result',receipt.result,'replayed',true,'execution',NULL));
    END IF;
    IF p_replay_only THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
    IF private.workflow_validate_v1(p_graph,'{}',true)<>'[]'::JSONB THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    PERFORM private.workflow_require_graph_tenant_v1(p_studio_id,p_graph);
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=p_workflow_id FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    SELECT value->'config' INTO trigger_config FROM jsonb_array_elements(p_graph->'nodes') WHERE value->>'type'='trigger';
    SELECT value->'config' INTO email_config FROM jsonb_array_elements(p_graph->'nodes') WHERE value->>'id'=p_email_node_id AND value->>'type'='email';
    IF email_config IS NULL OR NOT private.workflow_json_keys_v1(p_runtime,ARRAY['sender_binding','default_reply_to','allowed_recipients'],ARRAY['sender_binding','default_reply_to','allowed_recipients'])
        OR jsonb_typeof(p_runtime->'sender_binding') IS DISTINCT FROM 'string' OR p_runtime->>'sender_binding' !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(p_runtime->'default_reply_to') IS DISTINCT FROM 'string'
        OR private.automation_normalize_email(p_runtime->>'default_reply_to') IS NULL
        OR private.automation_normalize_email(p_runtime->>'default_reply_to')<>p_runtime->>'default_reply_to'
        OR jsonb_typeof(p_runtime->'allowed_recipients') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_runtime->'allowed_recipients') WHERE jsonb_typeof(value)<>'string') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    SELECT ARRAY(SELECT jsonb_array_elements_text(p_runtime->'allowed_recipients')) INTO allowed;
    IF NOT private.automation_test_allowed_v1(allowed) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    recipient:=private.automation_test_verified_email_v1(p_actor_id);
    IF recipient IS NULL OR (cardinality(allowed)>0 AND NOT recipient=ANY(allowed)) THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_ADMIN_REQUIRED'; END IF;
    reply:=coalesce(private.automation_normalize_email(email_config->>'reply_to_email'),p_runtime->>'default_reply_to');
    selection:=jsonb_build_object('trigger',trigger_config,'email_node_id',p_email_node_id,'email',email_config);
    at:=clock_timestamp(); scope.id:=gen_random_uuid(); scope.execution_token:=gen_random_uuid();
    INSERT INTO private.automation_test_email_scopes(id,studio_id,actor_id,workflow_id,operation_id,request_fingerprint,scope_fingerprint,
        execution_token,reference_time,execution_expires_at,recipient_email,reply_to,sender_binding,state,created_at,updated_at)
        VALUES(scope.id,p_studio_id,p_actor_id,p_workflow_id,p_operation_id,fingerprint,private.workflow_hash_v1(jsonb_build_object(
            'test_delivery_id',scope.id,'request_fingerprint',fingerprint,'selection',selection,'recipient_email',recipient,'reply_to',reply,
            'sender_binding',p_runtime->>'sender_binding','reference_time',private.automation_utc_text_v1(at))),scope.execution_token,
            at,at+INTERVAL '60 seconds',recipient,reply,p_runtime->>'sender_binding','queued',at,at) RETURNING * INTO scope;
    INSERT INTO private.automation_test_email_payloads(scope_id,studio_id,selection) VALUES(scope.id,p_studio_id,selection);
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result,committed_at)
        VALUES(p_studio_id,p_operation_id,p_actor_id,'test_email.create',fingerprint,'test_delivery',scope.id,private.automation_test_result_v1(scope),at);
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'actor_id',p_actor_id,'workflow_id',p_workflow_id,
        'result',private.automation_test_result_v1(scope),'replayed',false,'execution',private.automation_test_execution_v1(scope,selection)));
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION private.automation_test_original_v1(p_studio_id UUID,p_scope_id UUID,p_token UUID) RETURNS private.automation_test_email_scopes
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes;
BEGIN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0)) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY'; END IF;
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR KEY SHARE NOWAIT;
    SELECT * INTO scope FROM private.automation_test_email_scopes WHERE studio_id=p_studio_id AND id=p_scope_id FOR UPDATE NOWAIT;
    IF p_token IS NULL OR scope.execution_token IS DISTINCT FROM p_token THEN RETURN NULL; END IF;
    RETURN scope;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;
CREATE FUNCTION private.automation_test_fail_v1(p_scope private.automation_test_email_scopes,p_reason TEXT) RETURNS private.automation_test_email_scopes
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE preparation private.automation_sender_preparations; at TIMESTAMPTZ;
BEGIN
    IF p_scope.state<>'queued' OR p_scope.attempt_id IS NOT NULL THEN RETURN p_scope; END IF;
    PERFORM private.automation_email_scope_lock_v1(p_scope.studio_id,'test',p_scope.id,NULL,p_scope.recipient_email);
    IF p_scope.preparation_id IS NOT NULL THEN
        SELECT * INTO preparation FROM private.automation_sender_preparations WHERE id=p_scope.preparation_id;
        IF preparation.probe_token IS NOT NULL THEN
            PERFORM private.automation_sender_release_probe_v1(preparation.id,preparation.preparation_token,preparation.probe_token);
        END IF;
    END IF;
    at:=clock_timestamp();
    UPDATE private.automation_test_email_scopes SET state='failed',reason=p_reason,settled_at=at,updated_at=at WHERE id=p_scope.id RETURNING * INTO p_scope;
    RETURN p_scope;
END $$;
CREATE FUNCTION private.automation_test_expire_v1(p_scope private.automation_test_email_scopes) RETURNS private.automation_test_email_scopes
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE actual private.automation_email_attempt_reservations; settled JSONB;
BEGIN
    IF p_scope.state='queued' AND p_scope.execution_expires_at<=clock_timestamp() THEN RETURN private.automation_test_fail_v1(p_scope,'lease_expired'); END IF;
    IF p_scope.state='sending' THEN
        SELECT * INTO actual FROM private.automation_email_attempt_reservations WHERE id=p_scope.attempt_id;
        IF actual.lease_expires_at<=clock_timestamp() THEN
            settled:=private.automation_email_attempt_expire_v1(actual.id);
            IF settled->>'outcome' IN ('confirmed','replayed') THEN
                UPDATE private.automation_test_email_scopes SET state=settled->>'state',reason='lease_expired',
                    settled_at=(settled->>'settled_at')::TIMESTAMPTZ,updated_at=(settled->>'settled_at')::TIMESTAMPTZ WHERE id=p_scope.id RETURNING * INTO p_scope;
            END IF;
        END IF;
    END IF;
    RETURN p_scope;
END $$;
CREATE FUNCTION private.automation_test_own_v1(p_studio_id UUID,p_actor_id UUID,p_scope_id UUID,p_token UUID,p_allowed TEXT[]) RETURNS private.automation_test_email_scopes
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes; discovered private.automation_test_email_scopes; email TEXT;
BEGIN
    PERFORM private.automation_test_actor_v1(p_studio_id,p_actor_id);
    IF NOT private.automation_test_allowed_v1(p_allowed) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    SELECT * INTO discovered FROM private.automation_test_email_scopes WHERE studio_id=p_studio_id AND id=p_scope_id;
    IF discovered.id IS NULL OR discovered.actor_id IS DISTINCT FROM p_actor_id OR discovered.execution_token IS DISTINCT FROM p_token OR p_token IS NULL THEN RETURN NULL; END IF;
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=discovered.workflow_id FOR SHARE NOWAIT;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- Every source and workflow precedes the scope, and all common sender locks.
    SELECT * INTO scope FROM private.automation_test_email_scopes WHERE studio_id=p_studio_id AND id=p_scope_id FOR UPDATE NOWAIT;
    scope:=private.automation_test_expire_v1(scope);
    IF scope.state='queued' THEN
        email:=private.automation_test_verified_email_v1(p_actor_id);
        IF email IS DISTINCT FROM scope.recipient_email OR (cardinality(p_allowed)>0 AND NOT email=ANY(p_allowed)) THEN
            RETURN private.automation_test_fail_v1(scope,'recipient_changed'); END IF;
        IF NOT EXISTS(SELECT 1 FROM private.automation_test_email_payloads WHERE scope_id=scope.id) THEN
            RETURN private.automation_test_fail_v1(scope,'sender_unavailable'); END IF;
    END IF;
    RETURN scope;
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION public.claim_automation_test_sender_preparation_v1(p_studio_id UUID,p_actor_id UUID,p_test_delivery_id UUID,p_execution_token UUID,
    p_preparation_id UUID,p_sender_binding TEXT,p_allowed_recipients TEXT[]) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes; reply JSONB; gate private.automation_sender_gate;
BEGIN
    IF p_preparation_id IS NULL OR p_sender_binding IS NULL OR p_sender_binding !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    scope:=private.automation_test_own_v1(p_studio_id,p_actor_id,p_test_delivery_id,p_execution_token,p_allowed_recipients);
    IF scope.id IS NULL OR scope.state<>'queued' OR scope.sender_binding IS DISTINCT FROM p_sender_binding
        OR (scope.preparation_id IS NOT NULL AND scope.preparation_id<>p_preparation_id) THEN
        SELECT * INTO gate FROM private.automation_sender_gate WHERE provider_key='microsoft_graph:primary';
        IF gate.provider_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_SENDER_UNAVAILABLE'; END IF;
        reply:=private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,'claim','preparation_stale');
    ELSE
        PERFORM private.automation_email_scope_lock_v1(scope.studio_id,'test',scope.id,NULL,scope.recipient_email);
        BEGIN
            reply:=private.automation_sender_claim_v1(p_preparation_id,p_sender_binding,'synthetic_recovery',scope.id);
            IF scope.execution_expires_at<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P57L1'; END IF;
            IF (reply#>>'{payload,allowed}')::BOOLEAN THEN
                UPDATE private.automation_test_email_scopes SET preparation_id=p_preparation_id,updated_at=clock_timestamp() WHERE id=scope.id;
            END IF;
        EXCEPTION WHEN SQLSTATE 'P57L1' THEN
            scope:=private.automation_test_fail_v1(scope,'lease_expired');
            SELECT * INTO gate FROM private.automation_sender_gate WHERE provider_key='microsoft_graph:primary';
            reply:=private.automation_sender_preparation_reply_v1(p_preparation_id,gate,NULL,'claim','preparation_stale');
        END;
    END IF;
    RETURN jsonb_build_object('payload',(reply->'payload')||jsonb_build_object('studio_id',p_studio_id,'test_delivery_id',p_test_delivery_id));
END $$;

CREATE FUNCTION public.finish_automation_test_email_preflight_v1(p_studio_id UUID,p_test_delivery_id UUID,p_execution_token UUID,p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes; updated BOOLEAN:=false; replayed BOOLEAN:=false; result JSONB;
BEGIN
    IF p_reason IS NULL OR p_reason NOT IN ('invalid_email_template','invalid_email_context','unsupported_currency','invalid_email_url','facts_unavailable',
        'sender_unavailable','subscription_required','recipient_changed','recipient_suppressed','lease_expired','budget_exhausted') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    scope:=private.automation_test_original_v1(p_studio_id,p_test_delivery_id,p_execution_token);
    IF scope.id IS NOT NULL THEN
        IF scope.state='failed' AND scope.attempt_id IS NULL AND scope.reason=p_reason THEN updated:=true; replayed:=true;
        ELSIF scope.state='queued' THEN
            scope:=private.automation_test_fail_v1(scope,CASE WHEN scope.execution_expires_at<=clock_timestamp() THEN 'lease_expired' ELSE p_reason END); updated:=true;
        END IF;
        IF updated THEN result:=private.automation_test_result_v1(scope); END IF;
    END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'test_delivery_id',p_test_delivery_id,
        'updated',updated,'replayed',replayed,'result',result));
END $$;

CREATE FUNCTION public.begin_automation_test_email_v1(p_studio_id UUID,p_actor_id UUID,p_test_delivery_id UUID,p_execution_token UUID,
    p_preparation_id UUID,p_preparation_token UUID,p_probe_token UUID,p_allowed_recipients TEXT[],p_scope_fingerprint TEXT,p_rendered JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes; admission JSONB; actual private.automation_email_attempt_reservations;
    outcome TEXT:='lease_lost'; result JSONB; attempt JSONB; new_id UUID:=gen_random_uuid(); at TIMESTAMPTZ;
BEGIN
    IF p_preparation_id IS NULL OR p_preparation_token IS NULL OR p_scope_fingerprint IS NULL OR p_scope_fingerprint !~ '^[a-f0-9]{64}$'
        OR private.automation_test_rendered_valid_v1(p_rendered) IS DISTINCT FROM true THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST'; END IF;
    scope:=private.automation_test_own_v1(p_studio_id,p_actor_id,p_test_delivery_id,p_execution_token,p_allowed_recipients);
    IF scope.id IS NOT NULL THEN
        IF scope.attempt_id IS NOT NULL THEN outcome:='already_begun';
        ELSIF scope.state='failed' THEN outcome:='stopped';
        ELSIF scope.state='queued' THEN
            IF scope.scope_fingerprint IS DISTINCT FROM p_scope_fingerprint OR scope.preparation_id IS DISTINCT FROM p_preparation_id THEN
                scope:=private.automation_test_fail_v1(scope,'sender_unavailable'); outcome:='stopped';
            ELSE
                BEGIN
                    admission:=private.automation_email_attempt_begin_v1(p_studio_id,'test',scope.id,NULL,new_id,scope.execution_token,scope.recipient_email,
                        p_preparation_id,p_preparation_token,p_probe_token);
                    at:=clock_timestamp();
                    IF scope.execution_expires_at<=at THEN RAISE EXCEPTION USING ERRCODE='P57L1'; END IF;
                    IF admission->>'outcome'='begun' THEN
                        SELECT * INTO actual FROM private.automation_email_attempt_reservations WHERE id=new_id;
                        UPDATE private.automation_test_email_scopes SET state='sending',attempt_id=actual.id,updated_at=at WHERE id=scope.id RETURNING * INTO scope;
                        UPDATE private.automation_test_email_payloads SET rendered=p_rendered WHERE scope_id=scope.id;
                        IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT'; END IF;
                        attempt:=jsonb_build_object('id',actual.id,'lease_expires_at',private.automation_utc_text_v1(actual.lease_expires_at),
                            'credential_revision',actual.admitted_credential_revision,'sender_binding',actual.sender_binding,
                            'message',p_rendered||jsonb_build_object('attempt_id',actual.id,'to_address',scope.recipient_email,'reply_to',scope.reply_to)); outcome:='begun';
                    ELSE
                        scope:=private.automation_test_fail_v1(scope,CASE admission->>'reason' WHEN 'recipient_suppressed' THEN 'recipient_suppressed' ELSE 'sender_unavailable' END); outcome:='stopped';
                    END IF;
                EXCEPTION WHEN SQLSTATE 'P57L1' THEN scope:=private.automation_test_fail_v1(scope,'lease_expired'); outcome:='stopped';
                END;
            END IF;
        END IF;
        IF outcome<>'lease_lost' THEN result:=private.automation_test_result_v1(scope); END IF;
    END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'test_delivery_id',p_test_delivery_id,
        'outcome',outcome,'result',result,'attempt',attempt));
END $$;

CREATE FUNCTION public.settle_automation_test_email_v1(p_studio_id UUID,p_test_delivery_id UUID,p_attempt_id UUID,p_execution_token UUID,p_result JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes; settled JSONB; updated BOOLEAN:=false; replayed BOOLEAN:=false; v_state TEXT; result JSONB;
BEGIN
    scope:=private.automation_test_original_v1(p_studio_id,p_test_delivery_id,p_execution_token);
    IF scope.id IS NOT NULL AND p_attempt_id IS NOT NULL AND scope.attempt_id=p_attempt_id THEN
        settled:=private.automation_email_attempt_settle_v1(p_attempt_id,p_execution_token,p_result);
        IF settled->>'outcome' IN ('confirmed','replayed') THEN
            replayed:=settled->>'outcome'='replayed'; updated:=true; v_state:=settled->>'state';
            IF scope.state='sending' THEN
                UPDATE private.automation_test_email_scopes SET state=v_state,reason=NULL,
                    settled_at=(settled->>'settled_at')::TIMESTAMPTZ,updated_at=(settled->>'settled_at')::TIMESTAMPTZ WHERE id=scope.id RETURNING * INTO scope;
            END IF;
            result:=private.automation_test_result_v1(scope);
        END IF;
    END IF;
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'test_delivery_id',p_test_delivery_id,'attempt_id',p_attempt_id,
        'updated',updated,'replayed',replayed,'state',v_state,'result',result));
END $$;
CREATE FUNCTION public.get_automation_test_email_v1(p_studio_id UUID,p_actor_id UUID,p_test_delivery_id UUID) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes;
BEGIN
    PERFORM private.automation_test_actor_v1(p_studio_id,p_actor_id);
    SELECT * INTO scope FROM private.automation_test_email_scopes WHERE studio_id=p_studio_id AND id=p_test_delivery_id FOR UPDATE NOWAIT;
    IF scope.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
    scope:=private.automation_test_expire_v1(scope);
    RETURN jsonb_build_object('payload',jsonb_build_object('studio_id',p_studio_id,'workflow_id',scope.workflow_id,'result',private.automation_test_result_v1(scope)));
EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

-- Next clear owner calls this before deleting payloads, under its exclusive gate.
CREATE FUNCTION private.automation_test_invalidate_queued_v1(p_studio_id UUID) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE scope private.automation_test_email_scopes;
BEGIN
    IF NOT private.automation_test_clear_owned_v1(p_studio_id) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='AUTOMATION_PAYLOAD_CLEAR_REQUIRED'; END IF;
    FOR scope IN SELECT * FROM private.automation_test_email_scopes WHERE studio_id=p_studio_id AND state='queued' ORDER BY id FOR UPDATE NOWAIT LOOP
        PERFORM private.automation_test_fail_v1(scope,'sender_unavailable');
    END LOOP;
END $$;

ALTER TABLE private.automation_test_email_scopes OWNER TO postgres;
ALTER TABLE private.automation_test_email_payloads OWNER TO postgres;
ALTER TABLE private.automation_test_email_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.automation_test_email_payloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.automation_test_email_scopes,private.automation_test_email_payloads FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON private.automation_test_email_scopes TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON private.automation_test_email_payloads TO service_role;
CREATE POLICY reject_client_access ON private.automation_test_email_scopes AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
CREATE POLICY reject_client_access ON private.automation_test_email_payloads AS RESTRICTIVE FOR ALL TO anon,authenticated USING(false) WITH CHECK(false);
DO $test_mail_privileges$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::REGPROCEDURE identity,p.prorettype FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_test_rendered_valid_v1','automation_test_scope_identity_v1','automation_test_payload_identity_v1',
            'automation_test_clear_owned_v1','automation_test_payload_delete_v1','automation_test_verified_email_v1','automation_test_actor_v1',
            'automation_test_result_v1','automation_test_allowed_v1','automation_test_execution_v1','automation_test_original_v1','automation_test_fail_v1',
            'automation_test_expire_v1','automation_test_own_v1','automation_test_invalidate_queued_v1'))
        OR (n.nspname='public' AND p.proname IN ('create_automation_test_email_v1','claim_automation_test_sender_preparation_v1',
            'finish_automation_test_email_preflight_v1','begin_automation_test_email_v1','settle_automation_test_email_v1','get_automation_test_email_v1')) LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.identity);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.identity);
        IF r.prorettype<>'trigger'::REGTYPE THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.identity); END IF;
    END LOOP;
END;
$test_mail_privileges$;

-- Operational clear owns cancellation and retention before the retained V44
-- business delete sequence. No provider gate or sender recovery is involved.
CREATE FUNCTION private.automation_clear_statement_fence_v1() RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE keys BIGINT[]; studios UUID[]; marker JSONB;
BEGIN
    -- Inspect this backend's actual bigint exclusive keys before any studio
    -- hash lookup. Ordinary deletes without such locks need no studio scan.
    SELECT array_agg((l.classid::BIGINT<<32)|l.objid::BIGINT)
        INTO keys FROM pg_catalog.pg_locks l
        WHERE l.locktype='advisory' AND l.pid=pg_catalog.pg_backend_pid()
            AND l.database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
            AND l.granted AND l.mode='ExclusiveLock' AND l.objsubid=1;
    IF keys IS NULL THEN RETURN NULL; END IF;
    SELECT array_agg(s.id ORDER BY s.id) INTO studios FROM public.studios s
        WHERE pg_catalog.hashtextextended('koaryu.local-plan-clear:'||s.id::TEXT,0)=ANY(keys);
    IF studios IS NULL THEN RETURN NULL; END IF;
    IF cardinality(studios)<>1 THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    BEGIN
        marker:=nullif(current_setting('koaryu.automation_clear_owner',true),'')::JSONB;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END;
    IF marker IS DISTINCT FROM jsonb_build_object('studio_id',studios[1],
        'backend_pid',pg_catalog.pg_backend_pid(),'transaction_id',pg_catalog.pg_current_xact_id()::TEXT) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
    END IF;
    RETURN NULL;
END $$;
-- The full predecessor always contains billing_disputes. This statement guard
-- fires even for an empty studio in a cached pre-installation V44 body.
CREATE TRIGGER automation_clear_current_owner BEFORE DELETE ON public.billing_disputes
    FOR EACH STATEMENT EXECUTE FUNCTION private.automation_clear_statement_fence_v1();

CREATE FUNCTION private.clear_studio_operational_data_v2(p_studio_id UUID,p_include_platform_rows BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE v_student_ids UUID[]; v_guardian_ids UUID[]; run_ids UUID[]; cancellation JSONB;
    at TIMESTAMPTZ; prior_marker TEXT; effects JSONB;
    workflows_paused INTEGER; attendance_rule_paused BOOLEAN; attendance_deliveries_cancelled INTEGER;
    belt_test_events_deleted INTEGER; belt_test_recipients_deleted INTEGER;
    sending_attempts_preserved INTEGER; unknown_attempts_preserved INTEGER;
BEGIN
    IF p_studio_id IS NULL THEN
        RAISE EXCEPTION 'Studio operational clear requires a studio id.' USING ERRCODE='22023';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('koaryu.local-plan-clear:'||p_studio_id::TEXT,0));
    PERFORM 1 FROM public.studios WHERE id=p_studio_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio not found for operational clear.' USING ERRCODE='P0001';
    END IF;
    -- Own all parent rows before observing common attempts. A callback or a
    -- complete claim/expiry transaction may retain its locks after helper return.
    PERFORM 1 FROM public.automation_workflows WHERE studio_id=p_studio_id ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_rules WHERE studio_id=p_studio_id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_workflow_runs WHERE studio_id=p_studio_id ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM private.automation_test_email_scopes WHERE studio_id=p_studio_id ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.automation_deliveries WHERE studio_id=p_studio_id ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM private.automation_workflow_email_attempts WHERE studio_id=p_studio_id ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM private.automation_email_attempt_reservations WHERE studio_id=p_studio_id
        ORDER BY scope_kind,scope_id,node_id,id FOR UPDATE NOWAIT;
    SELECT count(*) FILTER(WHERE state='sending'),count(*) FILTER(WHERE state='unknown')
        INTO sending_attempts_preserved,unknown_attempts_preserved
        FROM private.automation_email_attempt_reservations WHERE studio_id=p_studio_id;
    at:=clock_timestamp();
    UPDATE public.automation_workflows SET status='paused',revision=revision+1,updated_at=at
        WHERE studio_id=p_studio_id AND status='active';
    GET DIAGNOSTICS workflows_paused=ROW_COUNT;
    UPDATE public.automation_workflow_activations SET retired_at=coalesce(retired_at,at),cancelled_at=at
        WHERE studio_id=p_studio_id AND cancelled_at IS NULL;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::UUID[]) INTO run_ids FROM public.automation_workflow_runs
        WHERE studio_id=p_studio_id AND state IN ('queued','waiting','claimed','running','sending','unknown');
    cancellation:=private.workflow_cancel_runs_v1(p_studio_id,run_ids,at,'operational_clear');
    UPDATE public.automation_rules SET enabled=false,revision=revision+1,updated_at=at
        WHERE studio_id=p_studio_id AND enabled;
    attendance_rule_paused:=FOUND;
    UPDATE public.automation_deliveries SET state='skipped',reason='rule_paused',claim_token=NULL,
        lease_expires_at=NULL,settled_at=at,updated_at=at
        WHERE studio_id=p_studio_id AND state IN ('queued','claimed','retry_wait');
    GET DIAGNOSTICS attendance_deliveries_cancelled=ROW_COUNT;
    PERFORM private.automation_test_invalidate_queued_v1(p_studio_id);
    prior_marker:=current_setting('koaryu.automation_clear_owner',true);
    PERFORM set_config('koaryu.automation_clear_owner',jsonb_build_object('studio_id',p_studio_id,
        'backend_pid',pg_catalog.pg_backend_pid(),'transaction_id',pg_catalog.pg_current_xact_id()::TEXT)::TEXT,true);
    BEGIN
        DELETE FROM private.workflow_email_attempt_payloads WHERE studio_id=p_studio_id;
        DELETE FROM private.workflow_email_unsubscribe_pins WHERE studio_id=p_studio_id;
        DELETE FROM private.automation_test_email_payloads WHERE studio_id=p_studio_id;
        DELETE FROM public.belt_test_recipients WHERE studio_id=p_studio_id;
        GET DIAGNOSTICS belt_test_recipients_deleted=ROW_COUNT;
        DELETE FROM public.belt_test_events WHERE studio_id=p_studio_id;
        GET DIAGNOSTICS belt_test_events_deleted=ROW_COUNT;
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_student_ids
      FROM public.students
     WHERE studio_id = p_studio_id;

    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_guardian_ids
      FROM public.guardians
     WHERE studio_id = p_studio_id;

    IF to_regclass('public.billing_disputes') IS NOT NULL THEN
        DELETE FROM public.billing_disputes WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_refunds') IS NOT NULL THEN
        DELETE FROM public.billing_refunds WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_payments') IS NOT NULL THEN
        DELETE FROM public.billing_payments WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_invoice_items') IS NOT NULL THEN
        DELETE FROM public.billing_invoice_items WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_invoices') IS NOT NULL THEN
        DELETE FROM public.billing_invoices WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.student_billing_enrollments') IS NOT NULL THEN
        DELETE FROM public.student_billing_enrollments WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_subscriptions') IS NOT NULL THEN
        DELETE FROM public.billing_subscriptions WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plan_programs') IS NOT NULL THEN
        DELETE FROM public.billing_plan_programs WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plan_prices') IS NOT NULL THEN
        DELETE FROM public.billing_plan_prices WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plans') IS NOT NULL THEN
        DELETE FROM public.billing_plans WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_payers') IS NOT NULL THEN
        DELETE FROM public.billing_payers WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.email_usage_events') IS NOT NULL THEN
        DELETE FROM public.email_usage_events WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.export_jobs') IS NOT NULL THEN
        DELETE FROM public.export_jobs WHERE studio_id = p_studio_id;
    END IF;

    IF p_include_platform_rows THEN
        IF to_regclass('public.studio_payment_accounts') IS NOT NULL THEN
            DELETE FROM public.studio_payment_accounts WHERE studio_id = p_studio_id;
        END IF;
        IF to_regclass('public.studio_subscriptions') IS NOT NULL THEN
            DELETE FROM public.studio_subscriptions WHERE studio_id = p_studio_id;
        END IF;
    END IF;

    DELETE FROM public.attendance WHERE studio_id = p_studio_id;
    DELETE FROM public.promotions WHERE studio_id = p_studio_id;

    IF to_regclass('public.student_program_memberships') IS NOT NULL THEN
        DELETE FROM public.student_program_memberships WHERE studio_id = p_studio_id;
    END IF;

    DELETE FROM public.lead_activities WHERE studio_id = p_studio_id;
    DELETE FROM public.student_import_runs WHERE studio_id = p_studio_id;
    DELETE FROM public.leads WHERE studio_id = p_studio_id;

    IF cardinality(v_student_ids) > 0 THEN
        DELETE FROM public.student_guardians WHERE student_id = ANY(v_student_ids);
    END IF;
    IF cardinality(v_guardian_ids) > 0 THEN
        DELETE FROM public.student_guardians WHERE guardian_id = ANY(v_guardian_ids);
    END IF;

    DELETE FROM public.class_sessions WHERE studio_id = p_studio_id;
    DELETE FROM public.class_templates WHERE studio_id = p_studio_id;
    DELETE FROM public.students WHERE studio_id = p_studio_id;
    DELETE FROM public.guardians WHERE studio_id = p_studio_id;
    DELETE FROM public.belt_ranks WHERE studio_id = p_studio_id;
    DELETE FROM public.belt_ladders WHERE studio_id = p_studio_id;
    DELETE FROM public.programs WHERE studio_id = p_studio_id;

        effects:=jsonb_build_object('workflows_paused',workflows_paused,
            'workflow_runs_cancelled',(cancellation->>'cancelled_count')::INTEGER,
            'workflow_cancellation_intents_added',(cancellation->>'intent_count')::INTEGER,
            'attendance_rule_paused',attendance_rule_paused,'attendance_deliveries_cancelled',attendance_deliveries_cancelled,
            'belt_test_events_deleted',belt_test_events_deleted,'belt_test_recipients_deleted',belt_test_recipients_deleted,
            'sending_attempts_preserved',sending_attempts_preserved,'unknown_attempts_preserved',unknown_attempts_preserved);
        PERFORM set_config('koaryu.automation_clear_owner',coalesce(prior_marker,''),true);
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('koaryu.automation_clear_owner',coalesce(prior_marker,''),true);
        RAISE;
    END;
    RETURN jsonb_build_object('payload',effects);
EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STUDIO_BUSY';
END $$;

CREATE FUNCTION public.clear_studio_operational_data_v2(p_studio_id UUID,p_include_platform_rows BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    SELECT private.clear_studio_operational_data_v2(p_studio_id,p_include_platform_rows)
$$;
CREATE OR REPLACE FUNCTION public.clear_studio_operational_data_atomic(p_studio_id UUID,p_include_platform_rows BOOLEAN DEFAULT false)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
    PERFORM private.clear_studio_operational_data_v2(p_studio_id,p_include_platform_rows);
END $$;
ALTER FUNCTION private.automation_clear_statement_fence_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.automation_clear_statement_fence_v1() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION private.clear_studio_operational_data_v2(UUID,BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.clear_studio_operational_data_v2(UUID,BOOLEAN) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION private.clear_studio_operational_data_v2(UUID,BOOLEAN) TO service_role;
ALTER FUNCTION public.clear_studio_operational_data_v2(UUID,BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clear_studio_operational_data_v2(UUID,BOOLEAN) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.clear_studio_operational_data_v2(UUID,BOOLEAN) TO service_role;
-- CREATE OR REPLACE preserves the old VOID default, owner and ACL.
GRANT DELETE ON public.belt_test_recipients,public.belt_test_events TO service_role;

-- Complete V57 installed-state attestation. Historical pins remain unchanged.
DO $expectation$
DECLARE changed INTEGER;
BEGIN
    UPDATE private.koaryu_release_v31_expectations
       SET expected_sha256='d01750a441a8ef88ea8c4ebdcdc971ca5c3eae67ea237717b64d60e7016e6c6c'
     WHERE expectation_key='operational_contract_v31'
       AND expected_sha256='783e1a1a99b05067fd86e20165dc43e20d190b331e6ec89f82e48a20dbe625f8';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'V57 requires the exact V56 operational expectation singleton.'; END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v38()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET TimeZone TO 'UTC'
 SET DateStyle TO 'ISO, YMD'
 SET IntervalStyle TO 'postgres'
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
    IF v_count <> 152 OR v_head <> '20261005105341' THEN
        v_failures := array_append(v_failures, 'migration_history_v57');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435','20261005105341'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:35a91b1047142d7cbb926ffad6e9b6f01df7b50d0f2a1032d60030dfeced091e' THEN
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
       <> '0:511be4239175a425530e0b677868ecf41befbeb3b6975d458733b8a6fa169481' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:5806773105d5fd4e56df347410fe8bd56e6480211847082a2cf14cb7fbb5ef4a' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:0034c551164e768b6765a6abb326ad2087396743057e1607b15c7e4363b66f97' THEN
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
       <> 'f179a507209070543c2947a158d00635b8f2ab2a3ad075c8527bb1835991d3ee' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:9f285d9d386666f8b42a6ce9d2c04eac3a6f897f979bb4e8d47c81c318ab5c53' THEN
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
       IS DISTINCT FROM 'f92900f5aebdc2a78b194d31df54df698ac421239b8056e2b1740b89af3607c4' THEN
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
              = 'fd4f3a1e65eef9f113ac8a648b72d45d84c5d9261e6436bd4aabe6c4643221fd'
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
              = 'afb0c874110e03126be86e561bd1c4cac0391c404f5ecd2c5b342799a625b8a7'
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
       IS DISTINCT FROM '4:d34f843175fbf8d24fae0c6e9d80101cf2590d23ac6724e957ba7e04e68eb267' THEN
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
              = '087249d003c83cf7fed72445b36499e3b7e01d492ad9de479d4e7f320ad5661f'
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
              = '3ebf9f8caae2ab42810e78575f4d31318298740299f6f96ff1ca37c056c83202'
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
       IS DISTINCT FROM '7f48d5bbd40e124f0f096110d6a73213b7684d9edaa0b41b2e1bfc4604359e83' THEN
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
              = 'ce9cd28c7191ca26f8a931a79c729bfbafb545527ed0e38a23ce045fe3b0adb8'
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
       IS DISTINCT FROM '2cac874e09752d14ad6ff1ca72bca38b278d9ffb05ad1b15c6e1b2c9c02afe53' THEN
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
       IS DISTINCT FROM 'd158e4eb04d0fb51d06ca16a490f48675a7036b45f4ff1d70f2148a2b1194478' THEN
        v_failures:=array_append(v_failures,'automation_functions_v56');
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
FROM (VALUES ('private.automation_command_operations'),
    ('private.automation_email_attempt_reservations'),
    ('private.automation_email_credentials'),
    ('private.automation_sender_gate'),
    ('private.automation_sender_preparations'),
    ('private.automation_test_email_payloads'),
    ('private.automation_test_email_scopes'),
    ('private.automation_unsubscribe_token_bindings'),
    ('private.automation_workflow_dispatch_cursor'),
    ('private.automation_workflow_email_attempts'),
    ('private.automation_workflow_events'),
    ('private.automation_workflow_follow_up_actions'),
    ('private.automation_workflow_run_steps'),
    ('private.billing_invoice_retry_hash_capture_control_v33'),
    ('private.billing_invoice_retry_hash_ledger_v33'),
    ('private.koaryu_release_v26_expectations'),
    ('private.koaryu_release_v27_expectations'),
    ('private.koaryu_release_v28_expectations'),
    ('private.koaryu_release_v29_expectations'),
    ('private.koaryu_release_v30_expectations'),
    ('private.koaryu_release_v31_expectations'),
    ('private.koaryu_release_v35_expectations'),
    ('private.koaryu_release_v36_expectations'),
    ('private.koaryu_release_v37_expectations'),
    ('private.stripe_connect_account_identity_guards'),
    ('private.student_import_receipts'),
    ('private.studio_creation_requests'),
    ('private.workflow_email_attempt_payloads'),
    ('private.workflow_email_unsubscribe_pins'),
    ('private.workflow_invoice_collection_episodes'),
    ('private.workflow_invoice_episode_pending'),
    ('private.workflow_invoice_episode_state'),
    ('private.workflow_invoice_settlement_authority'),
    ('private.workflow_payment_capture_markers'),
    ('private.workflow_payment_settlement_observations'),
    ('private.workflow_rank_contexts'),
    ('private.workflow_rank_pending_contexts'),
    ('private.workflow_rank_pending_events'),
    ('private.workflow_rank_scopes'),
    ('private.workflow_timer_activations'),
    ('private.workflow_timer_dispatch_cursor'),
    ('public.account_deletion_requests'),
    ('public.attendance'),
    ('public.audit_logs'),
    ('public.automation_deliveries'),
    ('public.automation_rules'),
    ('public.automation_suppressions'),
    ('public.automation_workflow_activations'),
    ('public.automation_workflow_runs'),
    ('public.automation_workflow_versions'),
    ('public.automation_workflows'),
    ('public.belt_ladders'),
    ('public.belt_ranks'),
    ('public.belt_test_events'),
    ('public.belt_test_recipients'),
    ('public.billing_adjustments'),
    ('public.billing_disputes'),
    ('public.billing_enrollment_transition_aliases'),
    ('public.billing_enrollment_transition_intents'),
    ('public.billing_invoice_items'),
    ('public.billing_invoice_mutation_owners'),
    ('public.billing_invoice_retry_operation_aliases'),
    ('public.billing_invoice_retry_operations'),
    ('public.billing_invoices'),
    ('public.billing_payer_payment_consents'),
    ('public.billing_payer_setup_requests'),
    ('public.billing_payers'),
    ('public.billing_payments'),
    ('public.billing_plan_prices'),
    ('public.billing_plan_programs'),
    ('public.billing_plans'),
    ('public.billing_provider_operation_resource_aliases'),
    ('public.billing_provider_operation_resources'),
    ('public.billing_provider_operation_steps'),
    ('public.billing_provider_operations'),
    ('public.billing_refunds'),
    ('public.billing_subscriptions'),
    ('public.class_sessions'),
    ('public.class_templates'),
    ('public.email_usage_events'),
    ('public.export_jobs'),
    ('public.guardians'),
    ('public.lead_activities'),
    ('public.lead_follow_up_operations'),
    ('public.lead_trial_appointments'),
    ('public.leads'),
    ('public.operational_alert_audit_events'),
    ('public.operational_alert_delivery_attempts'),
    ('public.operational_alert_delivery_outcomes'),
    ('public.operational_alert_episodes'),
    ('public.operational_alert_heartbeats'),
    ('public.operational_alert_outbox'),
    ('public.programs'),
    ('public.promotions'),
    ('public.staff_profiles'),
    ('public.staff_roles'),
    ('public.stripe_connect_account_dispositions'),
    ('public.stripe_connect_onboarding_bootstraps'),
    ('public.stripe_events'),
    ('public.stripe_live_billing_reconciliation_account_evidence'),
    ('public.stripe_live_billing_reconciliation_checkpoints'),
    ('public.stripe_live_billing_reconciliation_checkpoints_v3'),
    ('public.student_billing_enrollments'),
    ('public.student_guardians'),
    ('public.student_import_runs'),
    ('public.student_program_memberships'),
    ('public.students'),
    ('public.studio_live_billing_authorizations'),
    ('public.studio_payment_accounts'),
    ('public.studio_subscriptions'),
    ('public.studios'),
    ('public.support_ticket_events'),
    ('public.support_tickets')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       NOT IN ('f9132b81f3965f9e9e7743ea6371c0389b94ca2f9d6f14f45b32d7bbdbab3067','eb5a65863ea250017acdee9d8eeaf6a2c6b3a75db3cddd36047db88756ef1a33','d812e4f5cd823bd9985aab0231a04c88bc46f5d2dac81346c3f09967b8718c57','e0b8a49b9fdd932ab0f1fdc8355ee0126079b0c3121896646a6c2c910e03409d')
       OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C")
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p'))
          IS DISTINCT FROM ARRAY['private.automation_command_operations','private.automation_email_attempt_reservations','private.automation_email_credentials','private.automation_sender_gate','private.automation_sender_preparations','private.automation_test_email_payloads','private.automation_test_email_scopes','private.automation_unsubscribe_token_bindings','private.automation_workflow_dispatch_cursor','private.automation_workflow_email_attempts','private.automation_workflow_events','private.automation_workflow_follow_up_actions','private.automation_workflow_run_steps','private.billing_invoice_retry_hash_capture_control_v33','private.billing_invoice_retry_hash_ledger_v33','private.koaryu_release_v26_expectations','private.koaryu_release_v27_expectations','private.koaryu_release_v28_expectations','private.koaryu_release_v29_expectations','private.koaryu_release_v30_expectations','private.koaryu_release_v31_expectations','private.koaryu_release_v35_expectations','private.koaryu_release_v36_expectations','private.koaryu_release_v37_expectations','private.stripe_connect_account_identity_guards','private.student_import_receipts','private.studio_creation_requests','private.workflow_email_attempt_payloads','private.workflow_email_unsubscribe_pins','private.workflow_invoice_collection_episodes','private.workflow_invoice_episode_pending','private.workflow_invoice_episode_state','private.workflow_invoice_settlement_authority','private.workflow_payment_capture_markers','private.workflow_payment_settlement_observations','private.workflow_rank_contexts','private.workflow_rank_pending_contexts','private.workflow_rank_pending_events','private.workflow_rank_scopes','private.workflow_timer_activations','private.workflow_timer_dispatch_cursor','public.account_deletion_requests','public.attendance','public.audit_logs','public.automation_deliveries','public.automation_rules','public.automation_suppressions','public.automation_workflow_activations','public.automation_workflow_runs','public.automation_workflow_versions','public.automation_workflows','public.belt_ladders','public.belt_ranks','public.belt_test_events','public.belt_test_recipients','public.billing_adjustments','public.billing_disputes','public.billing_enrollment_transition_aliases','public.billing_enrollment_transition_intents','public.billing_invoice_items','public.billing_invoice_mutation_owners','public.billing_invoice_retry_operation_aliases','public.billing_invoice_retry_operations','public.billing_invoices','public.billing_payer_payment_consents','public.billing_payer_setup_requests','public.billing_payers','public.billing_payments','public.billing_plan_prices','public.billing_plan_programs','public.billing_plans','public.billing_provider_operation_resource_aliases','public.billing_provider_operation_resources','public.billing_provider_operation_steps','public.billing_provider_operations','public.billing_refunds','public.billing_subscriptions','public.class_sessions','public.class_templates','public.email_usage_events','public.export_jobs','public.guardians','public.lead_activities','public.lead_follow_up_operations','public.lead_trial_appointments','public.leads','public.operational_alert_audit_events','public.operational_alert_delivery_attempts','public.operational_alert_delivery_outcomes','public.operational_alert_episodes','public.operational_alert_heartbeats','public.operational_alert_outbox','public.programs','public.promotions','public.staff_profiles','public.staff_roles','public.stripe_connect_account_dispositions','public.stripe_connect_onboarding_bootstraps','public.stripe_events','public.stripe_live_billing_reconciliation_account_evidence','public.stripe_live_billing_reconciliation_checkpoints','public.stripe_live_billing_reconciliation_checkpoints_v3','public.student_billing_enrollments','public.student_guardians','public.student_import_runs','public.student_program_memberships','public.students','public.studio_live_billing_authorizations','public.studio_payment_accounts','public.studio_subscriptions','public.studios','public.support_ticket_events','public.support_tickets']::TEXT[] THEN
        v_failures:=array_append(v_failures,'automation_tables_v57');
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
FROM (VALUES ('private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)'),
    ('private.automation_bind_unsubscribe_token_v1(uuid,text,text)'),
    ('private.automation_clear_statement_fence_v1()'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_delivery_immutable()'),
    ('private.automation_delivery_result_v1(jsonb,bigint)'),
    ('private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)'),
    ('private.automation_email_attempt_expire_v1(uuid)'),
    ('private.automation_email_attempt_identity_v1()'),
    ('private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)'),
    ('private.automation_expire_orphaned_legacy_attempts_v1(integer)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.automation_instant_v1(jsonb)'),
    ('private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)'),
    ('private.automation_legacy_delivery_delete_v1()'),
    ('private.automation_legacy_delivery_result_v1(jsonb)'),
    ('private.automation_legacy_delivery_transition_v1()'),
    ('private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)'),
    ('private.automation_legacy_projection_valid_v1(jsonb)'),
    ('private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)'),
    ('private.automation_legacy_terminal_v1(jsonb,integer)'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_sender_claim_v1(uuid,text,text,uuid)'),
    ('private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)'),
    ('private.automation_sender_gate_identity_v1()'),
    ('private.automation_sender_gate_lock_v1()'),
    ('private.automation_sender_instant_v1(timestamp with time zone)'),
    ('private.automation_sender_preparation_identity_v1()'),
    ('private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)'),
    ('private.automation_sender_preparation_result_valid_v1(jsonb)'),
    ('private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_sender_release_orphan_probe_v1()'),
    ('private.automation_sender_release_probe_v1(uuid,uuid,uuid)'),
    ('private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)'),
    ('private.automation_test_actor_v1(uuid,uuid)'),
    ('private.automation_test_allowed_v1(text[])'),
    ('private.automation_test_clear_owned_v1(uuid)'),
    ('private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)'),
    ('private.automation_test_expire_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_fail_v1(private.automation_test_email_scopes,text)'),
    ('private.automation_test_invalidate_queued_v1(uuid)'),
    ('private.automation_test_original_v1(uuid,uuid,uuid)'),
    ('private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])'),
    ('private.automation_test_payload_delete_v1()'),
    ('private.automation_test_payload_identity_v1()'),
    ('private.automation_test_rendered_valid_v1(jsonb)'),
    ('private.automation_test_result_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_scope_identity_v1()'),
    ('private.automation_test_verified_email_v1(uuid)'),
    ('private.automation_timezone_v1(jsonb)'),
    ('private.automation_unsubscribe_binding_identity_v1()'),
    ('private.automation_utc_text_v1(timestamp with time zone)'),
    ('private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)'),
    ('private.belt_test_event_payload_v1(public.belt_test_events)'),
    ('private.belt_test_lock_recipient_runs_v1(uuid,uuid[])'),
    ('private.belt_test_name_v1(jsonb)'),
    ('private.belt_test_recipient_identity_v1()'),
    ('private.belt_test_recipient_payload_v1(public.belt_test_recipients)'),
    ('private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)'),
    ('private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)'),
    ('private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)'),
    ('private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)'),
    ('private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)'),
    ('private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)'),
    ('private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)'),
    ('private.billing_plan_resource_version_v31(public.billing_plans,text,integer)'),
    ('private.billing_provider_operation_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)'),
    ('private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)'),
    ('private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)'),
    ('private.bind_live_billing_authorization_checkpoint()'),
    ('private.can_read_staff_profile(uuid)'),
    ('private.capture_billing_invoice_retry_alias_v33()'),
    ('private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)'),
    ('private.capture_billing_invoice_retry_resource_v33()'),
    ('private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)'),
    ('private.clear_studio_operational_data_v2(uuid,boolean)'),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)'),
    ('private.current_connect_account_generation(jsonb)'),
    ('private.deterministic_import_uuid(uuid,text)'),
    ('private.enforce_billing_payer_connect_identity_v1()'),
    ('private.enforce_billing_payment_refundable_amount_v31()'),
    ('private.enforce_billing_provider_step_parent_v1()'),
    ('private.enforce_live_billing_checkpoint_processed_events()'),
    ('private.enforce_single_studio_membership()'),
    ('private.handle_invoice_retry_consent_change_v33(uuid,uuid)'),
    ('private.has_unambiguous_studio_membership()'),
    ('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'),
    ('private.is_admin_in_studio(uuid)'),
    ('private.is_admin_or_front_desk_in_studio(uuid)'),
    ('private.is_staff_in_studio(uuid)'),
    ('private.koaryu_release_adjustment_trigger_guard_manifest_v37()'),
    ('private.koaryu_release_critical_surface_manifest_v14()'),
    ('private.koaryu_release_critical_surface_manifest_v15()'),
    ('private.koaryu_release_critical_surface_manifest_v16()'),
    ('private.koaryu_release_critical_surface_manifest_v17()'),
    ('private.koaryu_release_critical_surface_manifest_v18()'),
    ('private.koaryu_release_enrollment_transition_manifest_v29()'),
    ('private.koaryu_release_invoice_retry_closeout_manifest_v34()'),
    ('private.koaryu_release_invoice_retry_compatibility_manifest_v33()'),
    ('private.koaryu_release_invoice_retry_preread_manifest_v32()'),
    ('private.koaryu_release_live_billing_v3_manifest_v25()'),
    ('private.koaryu_release_operational_contract_v25()'),
    ('private.koaryu_release_operational_contract_v26()'),
    ('private.koaryu_release_operational_contract_v27()'),
    ('private.koaryu_release_operational_contract_v28()'),
    ('private.koaryu_release_operational_contract_v29()'),
    ('private.koaryu_release_operational_contract_v30()'),
    ('private.koaryu_release_operational_contract_v31()'),
    ('private.koaryu_release_operational_manifest_v10()'),
    ('private.koaryu_release_operational_manifest_v11()'),
    ('private.koaryu_release_operational_manifest_v12()'),
    ('private.koaryu_release_operational_manifest_v2()'),
    ('private.koaryu_release_operational_manifest_v2_base()'),
    ('private.koaryu_release_operational_manifest_v4()'),
    ('private.koaryu_release_operational_manifest_v5()'),
    ('private.koaryu_release_operational_manifest_v6()'),
    ('private.koaryu_release_operational_manifest_v7()'),
    ('private.koaryu_release_operational_manifest_v8()'),
    ('private.koaryu_release_operational_manifest_v9()'),
    ('private.koaryu_release_payer_setup_recovery_manifest_v36()'),
    ('private.koaryu_release_payment_adjustment_manifest_v26()'),
    ('private.koaryu_release_payments_replay_repairs_manifest_v30()'),
    ('private.koaryu_release_provider_operation_steps_manifest_v28()'),
    ('private.koaryu_release_provider_operations_manifest_v27()'),
    ('private.koaryu_release_resource_ownership_manifest_v31()'),
    ('private.koaryu_release_schedule_window_manifest_v1()'),
    ('private.koaryu_release_schema_preflight_v14_snapshot_v34()'),
    ('private.koaryu_release_starting_belt_manifest_v9()'),
    ('private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()'),
    ('private.koaryu_release_student_rank_writer_manifest_v11()'),
    ('private.koaryu_release_student_rank_writer_manifest_v12()'),
    ('private.koaryu_release_student_rank_writer_manifest_v13()'),
    ('private.live_billing_event_is_in_scope(text,text)'),
    ('private.live_billing_operation_set_is_canonical_v1(text,text[])'),
    ('private.lock_student_import_actor(uuid)'),
    ('private.lock_student_import_run(uuid,uuid,text)'),
    ('private.maintain_billing_invoice_mutation_owner_v31()'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('private.preserve_billing_enrollment_transition_identity_v1()'),
    ('private.preserve_billing_invoice_mutation_owner_v31()'),
    ('private.preserve_billing_invoice_retry_hash_ledger_v33()'),
    ('private.preserve_billing_payer_payment_consent_v1()'),
    ('private.preserve_billing_payer_setup_request_v1()'),
    ('private.preserve_billing_provider_operation_identity_v1()'),
    ('private.preserve_billing_provider_operation_resource_alias_v1()'),
    ('private.preserve_billing_provider_operation_resource_v1()'),
    ('private.preserve_billing_provider_operation_step_v1()'),
    ('private.prevent_account_deletion_orphan()'),
    ('private.prevent_staff_admin_orphan()'),
    ('private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'),
    ('private.recompute_billing_payment_adjustment_totals(uuid)'),
    ('private.recompute_payment_after_adjustment_change()'),
    ('private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)'),
    ('private.reject_billing_enrollment_transition_alias_mutation_v1()'),
    ('private.reject_consent_change_during_invoice_retry_v31()'),
    ('private.reject_payer_change_during_invoice_retry_v31()'),
    ('private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)'),
    ('private.set_audit_actor_legal_name()'),
    ('private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)'),
    ('private.sync_connect_identity_exclusion_guard()'),
    ('private.sync_connect_identity_mapping_guard()'),
    ('private.trial_appointment_payload_v1(public.lead_trial_appointments)'),
    ('private.trial_rebooking_marker_v1()'),
    ('private.validate_billing_adjustment_payment_identity()'),
    ('private.validate_billing_payment_identity_change()'),
    ('private.workflow_activation_immutable_v1()'),
    ('private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)'),
    ('private.workflow_blank_v1(jsonb)'),
    ('private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)'),
    ('private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])'),
    ('private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)'),
    ('private.workflow_capture_events_v1(uuid,jsonb,jsonb)'),
    ('private.workflow_capture_payment_failure_v1()'),
    ('private.workflow_catalog_v1()'),
    ('private.workflow_condition_result_v1(text,text,jsonb,jsonb)'),
    ('private.workflow_current_rank_authority_v1(uuid,uuid,uuid)'),
    ('private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])'),
    ('private.workflow_current_staff_recipient_v1(uuid,uuid)'),
    ('private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_delay_due_identity_v1()'),
    ('private.workflow_detail_v1(uuid,uuid)'),
    ('private.workflow_email_attempt_identity_v1()'),
    ('private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)'),
    ('private.workflow_email_fingerprint_v1(jsonb,jsonb)'),
    ('private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)'),
    ('private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('private.workflow_email_parameters_valid_v1(text,text[],text,text)'),
    ('private.workflow_email_payload_delete_v1()'),
    ('private.workflow_email_payload_identity_v1()'),
    ('private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)'),
    ('private.workflow_email_project_settlement_v1(uuid,boolean)'),
    ('private.workflow_email_rendered_valid_v1(jsonb)'),
    ('private.workflow_email_selected_values_v1(jsonb,jsonb)'),
    ('private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)'),
    ('private.workflow_expire_email_attempts_v1(integer)'),
    ('private.workflow_fact_text_v1(text)'),
    ('private.workflow_finalize_invoice_episode_deferred_v1()'),
    ('private.workflow_finalize_invoice_episodes_v1()'),
    ('private.workflow_finalize_rank_deferred_v1()'),
    ('private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)'),
    ('private.workflow_follow_up_receipt_identity_v1()'),
    ('private.workflow_graph_read_issues_v1(uuid,jsonb)'),
    ('private.workflow_hash_v1(jsonb)'),
    ('private.workflow_immutable_record_v1()'),
    ('private.workflow_integer_v1(jsonb,bigint,bigint)'),
    ('private.workflow_invoice_episode_context_valid_v1(jsonb)'),
    ('private.workflow_invoice_episode_identity_v1()'),
    ('private.workflow_invoice_episode_pending_identity_v1()'),
    ('private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)'),
    ('private.workflow_invoice_episode_state_identity_v1()'),
    ('private.workflow_invoice_episode_threshold_v1(date,text)'),
    ('private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_invoice_settlement_identity_v1()'),
    ('private.workflow_invoice_settlement_seed_v1()'),
    ('private.workflow_json_keys_v1(jsonb,text[],text[])'),
    ('private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])'),
    ('private.workflow_lock_lead_assignee_v1(uuid)'),
    ('private.workflow_lock_recipient_auth_v1(uuid)'),
    ('private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)'),
    ('private.workflow_lock_timed_sources_v1(jsonb)'),
    ('private.workflow_mark_invoice_episode_v1()'),
    ('private.workflow_mark_payer_episode_demo_v1()'),
    ('private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)'),
    ('private.workflow_observe_payment_settlement_v1(uuid,uuid)'),
    ('private.workflow_payment_evidence_v1(public.billing_payments)'),
    ('private.workflow_payment_evidence_valid_v1(jsonb)'),
    ('private.workflow_payment_settlement_valid_v1(uuid,uuid)'),
    ('private.workflow_prepare_capture_v1(uuid,uuid[],boolean)'),
    ('private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)'),
    ('private.workflow_rank_compare_pending_v1(uuid,uuid)'),
    ('private.workflow_rank_context_generation_v1(uuid,uuid,uuid)'),
    ('private.workflow_rank_context_identity_v1()'),
    ('private.workflow_rank_finalize_pending_v1(uuid)'),
    ('private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)'),
    ('private.workflow_rank_scope_enter_v1(uuid,uuid,text)'),
    ('private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)'),
    ('private.workflow_rank_tuple_v1(uuid,uuid,uuid)'),
    ('private.workflow_require_actor_v1(uuid,uuid,boolean)'),
    ('private.workflow_require_graph_tenant_v1(uuid,jsonb)'),
    ('private.workflow_run_detail_v1(uuid,uuid)'),
    ('private.workflow_run_identity_v1()'),
    ('private.workflow_run_position_v1(public.automation_workflow_runs)'),
    ('private.workflow_run_step_identity_v1()'),
    ('private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)'),
    ('private.workflow_run_subject_label_v1(private.automation_workflow_events)'),
    ('private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)'),
    ('private.workflow_semantic_graph_v1(jsonb)'),
    ('private.workflow_settlement_observation_identity_v1()'),
    ('private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)'),
    ('private.workflow_staff_auth_email_v1(uuid,uuid)'),
    ('private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)'),
    ('private.workflow_timed_candidates_v1(integer,timestamp with time zone)'),
    ('private.workflow_timer_activation_identity_v1()'),
    ('private.workflow_timer_activation_insert_v1()'),
    ('private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)'),
    ('private.workflow_trigger_event_type_v1(jsonb)'),
    ('private.workflow_typed_value_v1(jsonb,jsonb)'),
    ('private.workflow_validate_v1(jsonb,jsonb,boolean)'),
    ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)'),
    ('public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)'),
    ('public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)'),
    ('public.acknowledge_operational_alert(text,uuid,text,text)'),
    ('public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)'),
    ('public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.archive_students_bulk_atomic(uuid,uuid,uuid[])'),
    ('public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)'),
    ('public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)'),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)'),
    ('public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)'),
    ('public.backfill_starting_belt_after_rank_delete()'),
    ('public.backfill_starting_belt_for_program()'),
    ('public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)'),
    ('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)'),
    ('public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)'),
    ('public.billing_attention_count_v1(uuid,date)'),
    ('public.billing_invoice_collection_facts_v1(uuid,uuid,date)'),
    ('public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_payer_balance_facts_v1(uuid,uuid,date)'),
    ('public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_webhook_health(text,boolean,timestamp with time zone)'),
    ('public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)'),
    ('public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)'),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)'),
    ('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)'),
    ('public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)'),
    ('public.claim_automation_sender_preparation_v1(text,uuid,text)'),
    ('public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])'),
    ('public.claim_automation_workflow_runs_v1(integer)'),
    ('public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)'),
    ('public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)'),
    ('public.claim_due_account_deletion_requests(integer,text,integer)'),
    ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.claim_operational_alert_delivery(text,text,uuid,integer)'),
    ('public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)'),
    ('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)'),
    ('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)'),
    ('public.clear_studio_comp_for_billing_event(uuid,bigint)'),
    ('public.clear_studio_operational_data_atomic(uuid,boolean)'),
    ('public.clear_studio_operational_data_v2(uuid,boolean)'),
    ('public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)'),
    ('public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)'),
    ('public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)'),
    ('public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)'),
    ('public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)'),
    ('public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)'),
    ('public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)'),
    ('public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)'),
    ('public.complete_operational_alert_delivery(uuid,text,text)'),
    ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
    ('public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)'),
    ('public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)'),
    ('public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)'),
    ('public.create_studio_onboarding(uuid,text,text,text)'),
    ('public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)'),
    ('public.dashboard_summary_facts(uuid,text,text,date,text)'),
    ('public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.delete_recurring_class_series_atomic(uuid,uuid,uuid)'),
    ('public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)'),
    ('public.enforce_operational_alert_sent_receipt()'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)'),
    ('public.fail_operational_alert_delivery(uuid,text,text,integer)'),
    ('public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)'),
    ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)'),
    ('public.finish_account_deletion_request(uuid,text,text,text)'),
    ('public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)'),
    ('public.finish_billing_subscription_quantity_sync(uuid,uuid,text)'),
    ('public.finish_stripe_event_processing(uuid,text,text,text)'),
    ('public.finish_stripe_event_processing_v2(uuid,text,text,text,text)'),
    ('public.finish_student_import_run(uuid,text,text,jsonb,text)'),
    ('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.get_automation_operation_v1(uuid,uuid,uuid)'),
    ('public.get_automation_sender_status_v1(text)'),
    ('public.get_automation_test_email_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_run_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)'),
    ('public.get_automation_workflow_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_event_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('public.heartbeat_student_import_run(uuid,text)'),
    ('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'),
    ('public.invalidate_core_checkout_on_comp_grant()'),
    ('public.koaryu_release_schema_preflight()'),
    ('public.koaryu_release_schema_preflight_v10()'),
    ('public.koaryu_release_schema_preflight_v11()'),
    ('public.koaryu_release_schema_preflight_v12()'),
    ('public.koaryu_release_schema_preflight_v13()'),
    ('public.koaryu_release_schema_preflight_v14()'),
    ('public.koaryu_release_schema_preflight_v15()'),
    ('public.koaryu_release_schema_preflight_v16()'),
    ('public.koaryu_release_schema_preflight_v17()'),
    ('public.koaryu_release_schema_preflight_v18()'),
    ('public.koaryu_release_schema_preflight_v19()'),
    ('public.koaryu_release_schema_preflight_v2()'),
    ('public.koaryu_release_schema_preflight_v20()'),
    ('public.koaryu_release_schema_preflight_v21()'),
    ('public.koaryu_release_schema_preflight_v22()'),
    ('public.koaryu_release_schema_preflight_v23()'),
    ('public.koaryu_release_schema_preflight_v24()'),
    ('public.koaryu_release_schema_preflight_v25()'),
    ('public.koaryu_release_schema_preflight_v26()'),
    ('public.koaryu_release_schema_preflight_v27()'),
    ('public.koaryu_release_schema_preflight_v28()'),
    ('public.koaryu_release_schema_preflight_v29()'),
    ('public.koaryu_release_schema_preflight_v3()'),
    ('public.koaryu_release_schema_preflight_v30()'),
    ('public.koaryu_release_schema_preflight_v31()'),
    ('public.koaryu_release_schema_preflight_v32()'),
    ('public.koaryu_release_schema_preflight_v33()'),
    ('public.koaryu_release_schema_preflight_v34()'),
    ('public.koaryu_release_schema_preflight_v35()'),
    ('public.koaryu_release_schema_preflight_v36()'),
    ('public.koaryu_release_schema_preflight_v37()'),
    ('public.koaryu_release_schema_preflight_v4()'),
    ('public.koaryu_release_schema_preflight_v5()'),
    ('public.koaryu_release_schema_preflight_v6()'),
    ('public.koaryu_release_schema_preflight_v7()'),
    ('public.koaryu_release_schema_preflight_v8()'),
    ('public.koaryu_release_schema_preflight_v9()'),
    ('public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])'),
    ('public.list_billing_payers_v1(uuid,uuid,date)'),
    ('public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)'),
    ('public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)'),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)'),
    ('public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)'),
    ('public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.materialize_recurring_class_sessions(uuid,date,date)'),
    ('public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)'),
    ('public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)'),
    ('public.operational_alert_heartbeats(text)'),
    ('public.operational_alert_metric_counts()'),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid,text)'),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid,text)'),
    ('public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)'),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)'),
    ('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)'),
    ('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)'),
    ('public.preserve_billing_invoice_retry_operation_created_at()'),
    ('public.preserve_studio_comp_provenance()'),
    ('public.prevent_operational_alert_append_only_mutation()'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.process_automation_workflow_occurrences_v1(integer)'),
    ('public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)'),
    ('public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)'),
    ('public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)'),
    ('public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)'),
    ('public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)'),
    ('public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)'),
    ('public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)'),
    ('public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])'),
    ('public.reassign_memberships_before_belt_rank_delete()'),
    ('public.recompute_billing_invoice_external_payment_totals(uuid,uuid)'),
    ('public.recompute_billing_payer_balance_v1(uuid,uuid)'),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)'),
    ('public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)'),
    ('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)'),
    ('public.record_operational_alert_heartbeat(text,text,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)'),
    ('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)'),
    ('public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)'),
    ('public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)'),
    ('public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)'),
    ('public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)'),
    ('public.reserve_core_checkout_atomic(uuid)'),
    ('public.reserve_core_checkout_v2_atomic(uuid)'),
    ('public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)'),
    ('public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)'),
    ('public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)'),
    ('public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.schedule_window_read(uuid,date,date,text)'),
    ('public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)'),
    ('public.set_student_is_minor()'),
    ('public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'),
    ('public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)'),
    ('public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)'),
    ('public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)'),
    ('public.snapshot_promotion_rank_identity()'),
    ('public.soft_delete_student_atomic(uuid,uuid,uuid)'),
    ('public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)'),
    ('public.student_business_date(uuid)'),
    ('public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.support_triage_digest(integer)'),
    ('public.support_triage_list_tickets(text[],text[],text[],integer)'),
    ('public.support_triage_update_ticket(uuid,text,text,jsonb)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)'),
    ('public.sync_primary_student_rank_from_membership()'),
    ('public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)'),
    ('public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)'),
    ('public.update_lead_atomic(uuid,uuid,uuid,jsonb)'),
    ('public.update_updated_at_column()'),
    ('public.validate_attendance_program_integrity()'),
    ('public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)'),
    ('public.validate_billing_adjustment_refs()'),
    ('public.validate_billing_dispute_refs()'),
    ('public.validate_billing_invoice_item_refs()'),
    ('public.validate_billing_invoice_refs()'),
    ('public.validate_billing_payer_guardian()'),
    ('public.validate_billing_payment_refs()'),
    ('public.validate_billing_plan_program()'),
    ('public.validate_billing_refund_refs()'),
    ('public.validate_billing_subscription_refs()'),
    ('public.validate_class_session_program_integrity()'),
    ('public.validate_class_template_program_integrity()'),
    ('public.validate_lead_program_integrity()'),
    ('public.validate_student_billing_enrollment()'),
    ('public.validate_student_birth_date()'),
    ('public.validate_student_guardian_tenant_integrity()'),
    ('public.validate_student_profile_tenant_integrity()'),
    ('public.validate_student_program_membership()'),
    ('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])'),
    ('public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '2515e1acbd2466587fbe797ecd6093bdc46c4dfbd742d94dc97e4cc43e315e7d'
       OR (SELECT array_agg(p.oid::REGPROCEDURE::TEXT ORDER BY p.oid::REGPROCEDURE::TEXT COLLATE "C")
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname IN ('public','private') AND p.prokind='f'
             AND p.oid <> pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v38()'))
          IS DISTINCT FROM ARRAY['private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)','private.automation_bind_unsubscribe_token_v1(uuid,text,text)','private.automation_clear_statement_fence_v1()','private.automation_core_entitled(uuid)','private.automation_delivery_immutable()','private.automation_delivery_result_v1(jsonb,bigint)','private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)','private.automation_email_attempt_expire_v1(uuid)','private.automation_email_attempt_identity_v1()','private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)','private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)','private.automation_expire_orphaned_legacy_attempts_v1(integer)','private.automation_has_actionable_work(text[])','private.automation_instant_v1(jsonb)','private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)','private.automation_legacy_delivery_delete_v1()','private.automation_legacy_delivery_result_v1(jsonb)','private.automation_legacy_delivery_transition_v1()','private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)','private.automation_legacy_projection_valid_v1(jsonb)','private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)','private.automation_legacy_terminal_v1(jsonb,integer)','private.automation_normalize_email(text)','private.automation_require_admin(uuid,uuid)','private.automation_sender_claim_v1(uuid,text,text,uuid)','private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)','private.automation_sender_gate_identity_v1()','private.automation_sender_gate_lock_v1()','private.automation_sender_instant_v1(timestamp with time zone)','private.automation_sender_preparation_identity_v1()','private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)','private.automation_sender_preparation_result_valid_v1(jsonb)','private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)','private.automation_sender_release_orphan_probe_v1()','private.automation_sender_release_probe_v1(uuid,uuid,uuid)','private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)','private.automation_test_actor_v1(uuid,uuid)','private.automation_test_allowed_v1(text[])','private.automation_test_clear_owned_v1(uuid)','private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)','private.automation_test_expire_v1(private.automation_test_email_scopes)','private.automation_test_fail_v1(private.automation_test_email_scopes,text)','private.automation_test_invalidate_queued_v1(uuid)','private.automation_test_original_v1(uuid,uuid,uuid)','private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])','private.automation_test_payload_delete_v1()','private.automation_test_payload_identity_v1()','private.automation_test_rendered_valid_v1(jsonb)','private.automation_test_result_v1(private.automation_test_email_scopes)','private.automation_test_scope_identity_v1()','private.automation_test_verified_email_v1(uuid)','private.automation_timezone_v1(jsonb)','private.automation_unsubscribe_binding_identity_v1()','private.automation_utc_text_v1(timestamp with time zone)','private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)','private.belt_test_event_payload_v1(public.belt_test_events)','private.belt_test_lock_recipient_runs_v1(uuid,uuid[])','private.belt_test_name_v1(jsonb)','private.belt_test_recipient_identity_v1()','private.belt_test_recipient_payload_v1(public.belt_test_recipients)','private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)','private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)','private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)','private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)','private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)','private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)','private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)','private.billing_plan_resource_version_v31(public.billing_plans,text,integer)','private.billing_provider_operation_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)','private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)','private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)','private.bind_live_billing_authorization_checkpoint()','private.can_read_staff_profile(uuid)','private.capture_billing_invoice_retry_alias_v33()','private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)','private.capture_billing_invoice_retry_resource_v33()','private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)','private.clear_studio_operational_data_v2(uuid,boolean)','private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)','private.current_connect_account_generation(jsonb)','private.deterministic_import_uuid(uuid,text)','private.enforce_billing_payer_connect_identity_v1()','private.enforce_billing_payment_refundable_amount_v31()','private.enforce_billing_provider_step_parent_v1()','private.enforce_live_billing_checkpoint_processed_events()','private.enforce_single_studio_membership()','private.handle_invoice_retry_consent_change_v33(uuid,uuid)','private.has_unambiguous_studio_membership()','private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','private.is_admin_in_studio(uuid)','private.is_admin_or_front_desk_in_studio(uuid)','private.is_staff_in_studio(uuid)','private.koaryu_release_adjustment_trigger_guard_manifest_v37()','private.koaryu_release_critical_surface_manifest_v14()','private.koaryu_release_critical_surface_manifest_v15()','private.koaryu_release_critical_surface_manifest_v16()','private.koaryu_release_critical_surface_manifest_v17()','private.koaryu_release_critical_surface_manifest_v18()','private.koaryu_release_enrollment_transition_manifest_v29()','private.koaryu_release_invoice_retry_closeout_manifest_v34()','private.koaryu_release_invoice_retry_compatibility_manifest_v33()','private.koaryu_release_invoice_retry_preread_manifest_v32()','private.koaryu_release_live_billing_v3_manifest_v25()','private.koaryu_release_operational_contract_v25()','private.koaryu_release_operational_contract_v26()','private.koaryu_release_operational_contract_v27()','private.koaryu_release_operational_contract_v28()','private.koaryu_release_operational_contract_v29()','private.koaryu_release_operational_contract_v30()','private.koaryu_release_operational_contract_v31()','private.koaryu_release_operational_manifest_v10()','private.koaryu_release_operational_manifest_v11()','private.koaryu_release_operational_manifest_v12()','private.koaryu_release_operational_manifest_v2()','private.koaryu_release_operational_manifest_v2_base()','private.koaryu_release_operational_manifest_v4()','private.koaryu_release_operational_manifest_v5()','private.koaryu_release_operational_manifest_v6()','private.koaryu_release_operational_manifest_v7()','private.koaryu_release_operational_manifest_v8()','private.koaryu_release_operational_manifest_v9()','private.koaryu_release_payer_setup_recovery_manifest_v36()','private.koaryu_release_payment_adjustment_manifest_v26()','private.koaryu_release_payments_replay_repairs_manifest_v30()','private.koaryu_release_provider_operation_steps_manifest_v28()','private.koaryu_release_provider_operations_manifest_v27()','private.koaryu_release_resource_ownership_manifest_v31()','private.koaryu_release_schedule_window_manifest_v1()','private.koaryu_release_schema_preflight_v14_snapshot_v34()','private.koaryu_release_starting_belt_manifest_v9()','private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()','private.koaryu_release_student_rank_writer_manifest_v11()','private.koaryu_release_student_rank_writer_manifest_v12()','private.koaryu_release_student_rank_writer_manifest_v13()','private.live_billing_event_is_in_scope(text,text)','private.live_billing_operation_set_is_canonical_v1(text,text[])','private.lock_student_import_actor(uuid)','private.lock_student_import_run(uuid,uuid,text)','private.maintain_billing_invoice_mutation_owner_v31()','private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)','private.preserve_billing_enrollment_transition_identity_v1()','private.preserve_billing_invoice_mutation_owner_v31()','private.preserve_billing_invoice_retry_hash_ledger_v33()','private.preserve_billing_payer_payment_consent_v1()','private.preserve_billing_payer_setup_request_v1()','private.preserve_billing_provider_operation_identity_v1()','private.preserve_billing_provider_operation_resource_alias_v1()','private.preserve_billing_provider_operation_resource_v1()','private.preserve_billing_provider_operation_step_v1()','private.prevent_account_deletion_orphan()','private.prevent_staff_admin_orphan()','private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','private.recompute_billing_payment_adjustment_totals(uuid)','private.recompute_payment_after_adjustment_change()','private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)','private.reject_billing_enrollment_transition_alias_mutation_v1()','private.reject_consent_change_during_invoice_retry_v31()','private.reject_payer_change_during_invoice_retry_v31()','private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)','private.set_audit_actor_legal_name()','private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)','private.sync_connect_identity_exclusion_guard()','private.sync_connect_identity_mapping_guard()','private.trial_appointment_payload_v1(public.lead_trial_appointments)','private.trial_rebooking_marker_v1()','private.validate_billing_adjustment_payment_identity()','private.validate_billing_payment_identity_change()','private.workflow_activation_immutable_v1()','private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)','private.workflow_blank_v1(jsonb)','private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)','private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])','private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)','private.workflow_capture_events_v1(uuid,jsonb,jsonb)','private.workflow_capture_payment_failure_v1()','private.workflow_catalog_v1()','private.workflow_condition_result_v1(text,text,jsonb,jsonb)','private.workflow_current_rank_authority_v1(uuid,uuid,uuid)','private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])','private.workflow_current_staff_recipient_v1(uuid,uuid)','private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_delay_due_identity_v1()','private.workflow_detail_v1(uuid,uuid)','private.workflow_email_attempt_identity_v1()','private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)','private.workflow_email_fingerprint_v1(jsonb,jsonb)','private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)','private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)','private.workflow_email_parameters_valid_v1(text,text[],text,text)','private.workflow_email_payload_delete_v1()','private.workflow_email_payload_identity_v1()','private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)','private.workflow_email_project_settlement_v1(uuid,boolean)','private.workflow_email_rendered_valid_v1(jsonb)','private.workflow_email_selected_values_v1(jsonb,jsonb)','private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)','private.workflow_expire_email_attempts_v1(integer)','private.workflow_fact_text_v1(text)','private.workflow_finalize_invoice_episode_deferred_v1()','private.workflow_finalize_invoice_episodes_v1()','private.workflow_finalize_rank_deferred_v1()','private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)','private.workflow_follow_up_receipt_identity_v1()','private.workflow_graph_read_issues_v1(uuid,jsonb)','private.workflow_hash_v1(jsonb)','private.workflow_immutable_record_v1()','private.workflow_integer_v1(jsonb,bigint,bigint)','private.workflow_invoice_episode_context_valid_v1(jsonb)','private.workflow_invoice_episode_identity_v1()','private.workflow_invoice_episode_pending_identity_v1()','private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)','private.workflow_invoice_episode_state_identity_v1()','private.workflow_invoice_episode_threshold_v1(date,text)','private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)','private.workflow_invoice_settlement_identity_v1()','private.workflow_invoice_settlement_seed_v1()','private.workflow_json_keys_v1(jsonb,text[],text[])','private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])','private.workflow_lock_lead_assignee_v1(uuid)','private.workflow_lock_recipient_auth_v1(uuid)','private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)','private.workflow_lock_timed_sources_v1(jsonb)','private.workflow_mark_invoice_episode_v1()','private.workflow_mark_payer_episode_demo_v1()','private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)','private.workflow_observe_payment_settlement_v1(uuid,uuid)','private.workflow_payment_evidence_v1(public.billing_payments)','private.workflow_payment_evidence_valid_v1(jsonb)','private.workflow_payment_settlement_valid_v1(uuid,uuid)','private.workflow_prepare_capture_v1(uuid,uuid[],boolean)','private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)','private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)','private.workflow_rank_compare_pending_v1(uuid,uuid)','private.workflow_rank_context_generation_v1(uuid,uuid,uuid)','private.workflow_rank_context_identity_v1()','private.workflow_rank_finalize_pending_v1(uuid)','private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)','private.workflow_rank_scope_enter_v1(uuid,uuid,text)','private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)','private.workflow_rank_tuple_v1(uuid,uuid,uuid)','private.workflow_require_actor_v1(uuid,uuid,boolean)','private.workflow_require_graph_tenant_v1(uuid,jsonb)','private.workflow_run_detail_v1(uuid,uuid)','private.workflow_run_identity_v1()','private.workflow_run_position_v1(public.automation_workflow_runs)','private.workflow_run_step_identity_v1()','private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)','private.workflow_run_subject_label_v1(private.automation_workflow_events)','private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)','private.workflow_semantic_graph_v1(jsonb)','private.workflow_settlement_observation_identity_v1()','private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)','private.workflow_staff_auth_email_v1(uuid,uuid)','private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)','private.workflow_timed_candidates_v1(integer,timestamp with time zone)','private.workflow_timer_activation_identity_v1()','private.workflow_timer_activation_insert_v1()','private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)','private.workflow_trigger_event_type_v1(jsonb)','private.workflow_typed_value_v1(jsonb,jsonb)','private.workflow_validate_v1(jsonb,jsonb,boolean)','private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)','public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)','public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)','public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)','public.acknowledge_operational_alert(text,uuid,text,text)','public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)','public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.archive_students_bulk_atomic(uuid,uuid,uuid[])','public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)','public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)','public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)','public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)','public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)','public.backfill_starting_belt_after_rank_delete()','public.backfill_starting_belt_for_program()','public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)','public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)','public.begin_missed_class_automation_v1(uuid,uuid,text[])','public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)','public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)','public.billing_attention_count_v1(uuid,date)','public.billing_invoice_collection_facts_v1(uuid,uuid,date)','public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)','public.billing_payer_balance_facts_v1(uuid,uuid,date)','public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)','public.billing_webhook_health(text,boolean,timestamp with time zone)','public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)','public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)','public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)','public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)','public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)','public.claim_automation_sender_preparation_v1(text,uuid,text)','public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])','public.claim_automation_workflow_runs_v1(integer)','public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)','public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)','public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)','public.claim_due_account_deletion_requests(integer,text,integer)','public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)','public.claim_missed_class_automations_v1(integer,text[])','public.claim_operational_alert_delivery(text,text,uuid,integer)','public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)','public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)','public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)','public.clear_studio_comp_for_billing_event(uuid,bigint)','public.clear_studio_operational_data_atomic(uuid,boolean)','public.clear_studio_operational_data_v2(uuid,boolean)','public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)','public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)','public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)','public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)','public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)','public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)','public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)','public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)','public.complete_operational_alert_delivery(uuid,text,text)','public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)','public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)','public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)','public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)','public.create_studio_onboarding(uuid,text,text,text)','public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)','public.dashboard_summary_facts(uuid,text,text,date,text)','public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)','public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])','public.delete_recurring_class_series_atomic(uuid,uuid,uuid)','public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)','public.enforce_operational_alert_sent_receipt()','public.enqueue_missed_class_automations_v1(integer,text[])','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)','public.fail_operational_alert_delivery(uuid,text,text,integer)','public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)','public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)','public.finish_account_deletion_request(uuid,text,text,text)','public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)','public.finish_billing_subscription_quantity_sync(uuid,uuid,text)','public.finish_stripe_event_processing(uuid,text,text,text)','public.finish_stripe_event_processing_v2(uuid,text,text,text,text)','public.finish_student_import_run(uuid,text,text,jsonb,text)','public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)','public.get_automation_email_credential_v1(text)','public.get_automation_operation_v1(uuid,uuid,uuid)','public.get_automation_sender_status_v1(text)','public.get_automation_test_email_v1(uuid,uuid,uuid)','public.get_automation_workflow_run_v1(uuid,uuid,uuid)','public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)','public.get_automation_workflow_v1(uuid,uuid,uuid)','public.get_belt_test_event_v1(uuid,uuid,uuid)','public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)','public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)','public.get_missed_class_automation_activity_v1(uuid,uuid,integer)','public.get_missed_class_automation_rule_v1(uuid,uuid)','public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)','public.heartbeat_student_import_run(uuid,text)','public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','public.invalidate_core_checkout_on_comp_grant()','public.koaryu_release_schema_preflight()','public.koaryu_release_schema_preflight_v10()','public.koaryu_release_schema_preflight_v11()','public.koaryu_release_schema_preflight_v12()','public.koaryu_release_schema_preflight_v13()','public.koaryu_release_schema_preflight_v14()','public.koaryu_release_schema_preflight_v15()','public.koaryu_release_schema_preflight_v16()','public.koaryu_release_schema_preflight_v17()','public.koaryu_release_schema_preflight_v18()','public.koaryu_release_schema_preflight_v19()','public.koaryu_release_schema_preflight_v2()','public.koaryu_release_schema_preflight_v20()','public.koaryu_release_schema_preflight_v21()','public.koaryu_release_schema_preflight_v22()','public.koaryu_release_schema_preflight_v23()','public.koaryu_release_schema_preflight_v24()','public.koaryu_release_schema_preflight_v25()','public.koaryu_release_schema_preflight_v26()','public.koaryu_release_schema_preflight_v27()','public.koaryu_release_schema_preflight_v28()','public.koaryu_release_schema_preflight_v29()','public.koaryu_release_schema_preflight_v3()','public.koaryu_release_schema_preflight_v30()','public.koaryu_release_schema_preflight_v31()','public.koaryu_release_schema_preflight_v32()','public.koaryu_release_schema_preflight_v33()','public.koaryu_release_schema_preflight_v34()','public.koaryu_release_schema_preflight_v35()','public.koaryu_release_schema_preflight_v36()','public.koaryu_release_schema_preflight_v37()','public.koaryu_release_schema_preflight_v4()','public.koaryu_release_schema_preflight_v5()','public.koaryu_release_schema_preflight_v6()','public.koaryu_release_schema_preflight_v7()','public.koaryu_release_schema_preflight_v8()','public.koaryu_release_schema_preflight_v9()','public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)','public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)','public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])','public.list_billing_payers_v1(uuid,uuid,date)','public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)','public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)','public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)','public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)','public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)','public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.materialize_recurring_class_sessions(uuid,date,date)','public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)','public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)','public.operational_alert_heartbeats(text)','public.operational_alert_metric_counts()','public.preflight_connect_onboarding_bootstrap_begin(uuid,text)','public.preflight_connect_onboarding_bootstrap_resume(uuid,text)','public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)','public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)','public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)','public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)','public.preserve_billing_invoice_retry_operation_created_at()','public.preserve_studio_comp_provenance()','public.prevent_operational_alert_append_only_mutation()','public.preview_missed_class_automation_v1(uuid,uuid,integer)','public.process_automation_workflow_occurrences_v1(integer)','public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)','public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)','public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)','public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)','public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)','public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)','public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)','public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)','public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])','public.reassign_memberships_before_belt_rank_delete()','public.recompute_billing_invoice_external_payment_totals(uuid,uuid)','public.recompute_billing_payer_balance_v1(uuid,uuid)','public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)','public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)','public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)','public.record_operational_alert_heartbeat(text,text,text)','public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)','public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)','public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)','public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)','public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)','public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)','public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)','public.reserve_core_checkout_atomic(uuid)','public.reserve_core_checkout_v2_atomic(uuid)','public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)','public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)','public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)','public.save_automation_email_credential_v1(text,bigint,text)','public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)','public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)','public.schedule_window_read(uuid,date,date,text)','public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)','public.set_student_is_minor()','public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)','public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)','public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)','public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)','public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)','public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)','public.snapshot_promotion_rank_identity()','public.soft_delete_student_atomic(uuid,uuid,uuid)','public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)','public.student_business_date(uuid)','public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)','public.support_triage_digest(integer)','public.support_triage_list_tickets(text[],text[],text[],integer)','public.support_triage_update_ticket(uuid,text,text,jsonb)','public.suppress_missed_class_automation_v1(text)','public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)','public.sync_primary_student_rank_from_membership()','public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)','public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)','public.update_lead_atomic(uuid,uuid,uuid,jsonb)','public.update_updated_at_column()','public.validate_attendance_program_integrity()','public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)','public.validate_billing_adjustment_refs()','public.validate_billing_dispute_refs()','public.validate_billing_invoice_item_refs()','public.validate_billing_invoice_refs()','public.validate_billing_payer_guardian()','public.validate_billing_payment_refs()','public.validate_billing_plan_program()','public.validate_billing_refund_refs()','public.validate_billing_subscription_refs()','public.validate_class_session_program_integrity()','public.validate_class_template_program_integrity()','public.validate_lead_program_integrity()','public.validate_student_billing_enrollment()','public.validate_student_birth_date()','public.validate_student_guardian_tenant_integrity()','public.validate_student_profile_tenant_integrity()','public.validate_student_program_membership()','public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])','public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)']::TEXT[] THEN
        v_failures:=array_append(v_failures,'automation_functions_v57');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='koaryu_release_schema_preflight_v38') <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v38()')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='s'
          AND p.proretset AND p.proconfig=ARRAY['search_path=pg_catalog','TimeZone=UTC','DateStyle=ISO, YMD','IntervalStyle=postgres']::TEXT[]
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                    a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
             = '[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::JSONB) THEN
        v_failures:=array_append(v_failures,'preflight_security_v57');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v57'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v37()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v38();
    IF v.ready IS TRUE AND v.migration_count = 152 AND v.migration_head = '20261005105341'
       AND v.manifest_version = 'release-db-attestation-v57'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 68
       AND v.pending_versions[cardinality(v.pending_versions)] = '20261005105341' THEN
        RETURN QUERY SELECT TRUE, 151, '20261004220435'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v56'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v56'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v38() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v38() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v38() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v37() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v37() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v37() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v38();
    IF v.migration_count IS DISTINCT FROM 151 OR v.migration_head IS DISTINCT FROM '20261004220435'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v57',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V57 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
