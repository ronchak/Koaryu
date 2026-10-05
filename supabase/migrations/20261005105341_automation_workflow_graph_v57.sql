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
    next_due_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(next_due_at)),
    claim_token UUID,
    lease_expires_at TIMESTAMPTZ CHECK (isfinite(lease_expires_at)),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision>0),
    reason TEXT CHECK (length(reason) BETWEEN 1 AND 200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
    FOREIGN KEY(studio_id,workflow_id) REFERENCES public.automation_workflows(studio_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,workflow_id,version_id) REFERENCES public.automation_workflow_versions(studio_id,workflow_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,event_id) REFERENCES private.automation_workflow_events(studio_id,id) ON DELETE CASCADE,
    FOREIGN KEY(studio_id,workflow_id,version_id,epoch,activation_id)
        REFERENCES public.automation_workflow_activations(studio_id,workflow_id,version_id,epoch,id) ON DELETE CASCADE,
    UNIQUE(workflow_id,event_id),
    UNIQUE(studio_id,id),
    CHECK ((claim_token IS NULL)=(lease_expires_at IS NULL)),
    CHECK (state NOT IN ('claimed','running','sending') OR claim_token IS NOT NULL),
    CHECK (state NOT IN ('queued','waiting','completed','cancelled','failed') OR claim_token IS NULL)
);
CREATE INDEX automation_workflow_runs_due ON public.automation_workflow_runs(next_due_at,created_at,id)
    WHERE state IN ('queued','waiting','claimed','running');
CREATE INDEX automation_workflow_runs_workflow ON public.automation_workflow_runs(studio_id,workflow_id,state);
CREATE INDEX automation_workflow_runs_event ON public.automation_workflow_runs(studio_id,event_id);
CREATE INDEX automation_workflow_runs_activation ON public.automation_workflow_runs(activation_id);
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
        AND state IN ('queued','waiting','claimed','running') ORDER BY id FOR UPDATE;
    UPDATE public.automation_workflow_runs SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,
        revision=revision+1,reason=p_reason,updated_at=p_at
        WHERE studio_id=p_studio_id AND workflow_id=p_workflow_id AND state IN ('queued','waiting','claimed','running');
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
            AND e.subject_id=p_subject_id AND r.state IN ('queued','waiting','claimed','running'))
        ORDER BY w.id FOR UPDATE;
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e
        ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind=p_subject_kind AND e.subject_id=p_subject_id
            AND r.state IN ('queued','waiting','claimed','running') ORDER BY r.id FOR UPDATE OF r;
    UPDATE public.automation_workflow_runs r SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,
        revision=r.revision+1,reason=p_reason,updated_at=p_at FROM private.automation_workflow_events e
        WHERE e.studio_id=r.studio_id AND e.id=r.event_id AND r.studio_id=p_studio_id
            AND e.subject_kind=p_subject_kind AND e.subject_id=p_subject_id
            AND r.state IN ('queued','waiting','claimed','running');
END $$;

CREATE FUNCTION public.mutate_lead_trial_appointment_v1(
    p_studio_id UUID,p_actor_id UUID,p_lead_id UUID,p_appointment_id UUID,p_operation_id UUID,p_expected_revision BIGINT,p_request JSONB
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE lead public.leads; old public.lead_trial_appointments; changed public.lead_trial_appointments;
    receipt private.automation_command_operations; program public.programs;
    v_request JSONB:=p_request; v_fingerprint TEXT; v_command TEXT; v_result JSONB; v_at TIMESTAMPTZ;
    targets JSONB; workflow_ids UUID[]; events JSONB:='[]'; activity_id UUID;
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
        changed.program_id:=lead.program_id; changed.created_by:=p_actor_id;
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
        WHERE r.studio_id=p_studio_id AND e.subject_kind='trial' AND e.subject_id=old.id;
    targets:=private.workflow_prepare_capture_v1(p_studio_id,workflow_ids,true);
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='trial' AND e.subject_id=old.id
            AND r.state IN ('queued','waiting','claimed','running') ORDER BY r.id FOR UPDATE OF r;
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
    UPDATE public.automation_workflow_runs r SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,
        revision=r.revision+1,reason='trial_changed',updated_at=v_at FROM private.automation_workflow_events e
        WHERE e.studio_id=r.studio_id AND e.id=r.event_id AND r.studio_id=p_studio_id AND e.subject_kind='trial'
            AND e.subject_id=old.id AND r.state IN ('queued','waiting','claimed','running');
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
    IF NEW.state='revoked' AND ROW(NEW.approved_schedule_revision,NEW.approved_program_id,NEW.approved_current_rank_id,
        NEW.approved_target_rank_id,NEW.approved_by,NEW.approved_at) IS DISTINCT FROM
        ROW(OLD.approved_schedule_revision,OLD.approved_program_id,OLD.approved_current_rank_id,OLD.approved_target_rank_id,OLD.approved_by,OLD.approved_at) THEN
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
                    AND r.state IN ('queued','waiting','claimed','running')) ORDER BY w.id FOR UPDATE;
            PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
                JOIN public.belt_test_recipients b ON b.studio_id=e.studio_id AND b.id=e.subject_id
                WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND b.event_id=old.id
                    AND r.state IN ('queued','waiting','claimed','running') ORDER BY r.id FOR UPDATE OF r;
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
        UPDATE public.automation_workflow_runs r SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,
            revision=r.revision+1,reason='belt_test_changed',updated_at=v_at
            FROM private.automation_workflow_events e JOIN public.belt_test_recipients b ON b.studio_id=e.studio_id AND b.id=e.subject_id
            WHERE e.studio_id=r.studio_id AND e.id=r.event_id AND r.studio_id=p_studio_id AND e.subject_kind='belt_test'
                AND b.event_id=old.id AND r.state IN ('queued','waiting','claimed','running');
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
            AND r.state IN ('queued','waiting','claimed','running')) ORDER BY w.id FOR UPDATE;
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(p_recipient_ids)
            AND r.state IN ('queued','waiting','claimed','running') ORDER BY r.id FOR UPDATE OF r;
END $$;

CREATE FUNCTION private.belt_test_cancel_recipient_runs_v1(p_studio_id UUID,p_recipient_ids UUID[],p_at TIMESTAMPTZ) RETURNS VOID
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path='' AS $$
    UPDATE public.automation_workflow_runs r SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,
        revision=r.revision+1,reason='belt_test_approval_changed',updated_at=p_at
        FROM private.automation_workflow_events e WHERE e.studio_id=r.studio_id AND e.id=r.event_id
            AND r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(p_recipient_ids)
            AND r.state IN ('queued','waiting','claimed','running')
$$;

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
    v_classes BIGINT; v_days NUMERIC; v_timezone TEXT;
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
        prepared:=prepared||jsonb_build_array(item||jsonb_build_object('program_id',v_program,'current_rank_id',v_rank,'target_rank_id',target_rank.id,
            'promotion_at',v_promotion,'anchor_at',v_anchor,'min_classes',target_rank.min_classes,'min_days',target_rank.min_months::BIGINT*30));
    END LOOP;
    PERFORM 1 FROM public.belt_test_recipients b WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND EXISTS(
        SELECT 1 FROM jsonb_array_elements(normalized) n WHERE b.student_id=(n.value->>'student_id')::UUID
            AND b.student_program_membership_id IS NOT DISTINCT FROM (n.value->>'student_program_membership_id')::UUID) ORDER BY b.id FOR UPDATE;
    SELECT coalesce(array_agg(b.id ORDER BY b.id),'{}'::UUID[]) INTO changed_ids FROM public.belt_test_recipients b
        JOIN jsonb_array_elements(prepared) n ON b.student_id=(n.value->>'student_id')::UUID
            AND b.student_program_membership_id IS NOT DISTINCT FROM (n.value->>'student_program_membership_id')::UUID
        WHERE b.studio_id=p_studio_id AND b.event_id=p_event_id AND (b.state<>'approved' OR b.approved_schedule_revision<>event.schedule_revision
            OR b.approved_program_id IS DISTINCT FROM (n.value->>'program_id')::UUID
            OR b.approved_current_rank_id IS DISTINCT FROM (n.value->>'current_rank_id')::UUID OR b.approved_target_rank_id<>(n.value->>'target_rank_id')::UUID);
    IF EXISTS(SELECT 1 FROM public.belt_test_recipients WHERE id=ANY(changed_ids) AND revision=9223372036854775807) THEN
        RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='AUTOMATION_STATE_CONFLICT';
    END IF;
    SELECT coalesce(array_agg(DISTINCT r.workflow_id ORDER BY r.workflow_id),'{}'::UUID[]) INTO workflow_ids
        FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(changed_ids);
    targets:=private.workflow_prepare_capture_v1(p_studio_id,workflow_ids,true);
    PERFORM 1 FROM public.automation_workflow_runs r JOIN private.automation_workflow_events e ON e.studio_id=r.studio_id AND e.id=r.event_id
        WHERE r.studio_id=p_studio_id AND e.subject_kind='belt_test' AND e.subject_id=ANY(changed_ids)
            AND r.state IN ('queued','waiting','claimed','running') ORDER BY r.id FOR UPDATE OF r;
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
            INSERT INTO public.belt_test_recipients(studio_id,event_id,student_id,student_program_membership_id,approved_schedule_revision,approved_program_id,
                approved_current_rank_id,approved_target_rank_id,state,revision,approved_by,approved_at,created_at,updated_at)
                VALUES(p_studio_id,p_event_id,(item->>'student_id')::UUID,(item->>'student_program_membership_id')::UUID,event.schedule_revision,(item->>'program_id')::UUID,
                    (item->>'current_rank_id')::UUID,(item->>'target_rank_id')::UUID,'approved',1,p_actor_id,v_at,v_at,v_at) RETURNING * INTO recipient;
        ELSIF recipient.id=ANY(changed_ids) THEN
            did_change:=true;
            UPDATE public.belt_test_recipients SET approved_schedule_revision=event.schedule_revision,
                approved_program_id=(item->>'program_id')::UUID,
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
                    'approved_schedule_revision',recipient.approved_schedule_revision,'approval_revision',recipient.revision)));
        END IF;
        items:=items||jsonb_build_array(private.belt_test_recipient_payload_v1(recipient));
    END LOOP;
    PERFORM private.belt_test_cancel_recipient_runs_v1(p_studio_id,changed_ids,v_at);
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
        at:=private.automation_instant_v1(item->'occurred_at');
        context:=item->'context'; kind:=item->>'event_type';
        CASE
            WHEN kind='lead.created' THEN fields:=ARRAY['lead_id','program_id','stage']; required:=fields;
            WHEN kind='lead.stage_changed' THEN fields:=ARRAY['lead_id','program_id','activity_id','old_stage','stage']; required:=fields;
            WHEN kind LIKE 'trial.%' THEN fields:=ARRAY['appointment_id','lead_id','program_id','revision','status']; required:=fields;
            WHEN kind='belt_test.approved' THEN fields:=ARRAY['event_id','student_id','student_program_membership_id','approved_program_id',
                'approved_current_rank_id','approved_target_rank_id','approved_schedule_revision','approval_revision']; required:=fields;
            -- Store only matching frozen target filters, never the full membership list.
            WHEN kind='student.enrolled' THEN fields:=ARRAY['student_id','matched_program_ids']; required:=fields;
            WHEN kind='student.promoted' THEN fields:=ARRAY['promotion_id','student_id','student_program_membership_id','program_id','rank_id','from_rank_id']; required:=array_remove(fields,'from_rank_id');
            WHEN kind='invoice.payment_failed' THEN fields:=ARRAY['payment_id','invoice_id','payer_id']; required:=fields;
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
            ELSIF k IN ('revision','approved_schedule_revision','approval_revision') THEN
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
