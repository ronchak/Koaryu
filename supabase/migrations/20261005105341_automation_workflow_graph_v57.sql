-- Partial V57 workflow-management pilot. No history registration or readiness closure.
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
LOCK TABLE public.students,public.student_program_memberships,public.belt_ranks IN ACCESS EXCLUSIVE MODE;

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

-- V57 catalog/readiness/history closure is pending later core tasks. This pilot
-- must be applied transactionally only to a disposable clone of exact V56.

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
LOCK TABLE public.studio_payment_accounts,public.billing_payers,public.billing_invoices,public.billing_payments
    IN SHARE ROW EXCLUSIVE MODE NOWAIT;
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
