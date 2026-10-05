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
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND length(name)<=120),
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
            IF kind='program.id' THEN
                PERFORM 1 FROM public.programs WHERE studio_id=p_studio_id AND id=(v#>>'{}')::UUID FOR KEY SHARE;
            ELSE
                PERFORM 1 FROM public.belt_ranks WHERE studio_id=p_studio_id AND id=(v#>>'{}')::UUID FOR KEY SHARE;
            END IF;
            IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND'; END IF;
        END LOOP;
    END LOOP;
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
    p_action TEXT,p_name TEXT,p_description TEXT,p_graph JSONB,p_layout JSONB,p_cancel_pending BOOLEAN
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
DECLARE w public.automation_workflows; receipt private.automation_command_operations;
    v_fingerprint TEXT; v_request JSONB; v_result JSONB; v_at TIMESTAMPTZ; v_version UUID;
    v_number BIGINT; v_graph JSONB; v_issues JSONB; v_epoch BIGINT; v_target UUID:=p_workflow_id;
BEGIN
    PERFORM private.workflow_require_actor_v1(p_studio_id,p_actor_id);
    IF p_operation_id IS NULL OR p_action IS NULL OR p_action NOT IN ('create','save','publish','start','pause','archive')
        OR p_cancel_pending IS NULL OR (p_cancel_pending AND p_action<>'publish')
        OR (p_action='create' AND (p_workflow_id IS NOT NULL OR p_expected_revision IS NOT NULL))
        OR (p_action<>'create' AND (p_workflow_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1)) THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    IF p_action<>'create' AND NOT EXISTS(SELECT 1 FROM public.automation_workflows WHERE studio_id=p_studio_id AND id=p_workflow_id) THEN
        RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='AUTOMATION_NOT_FOUND';
    END IF;
    v_request:=jsonb_build_object('command','workflow.'||p_action,'studio_id',p_studio_id,'actor_id',p_actor_id,
        'workflow_id',p_workflow_id,'expected_revision',p_expected_revision,'cancel_pending',p_cancel_pending);
    IF p_action IN ('create','save') THEN
        IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 120 OR length(p_name)>120
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
CREATE FUNCTION public.command_automation_workflow_v1(p_studio_id UUID,p_actor_id UUID,p_workflow_id UUID,p_operation_id UUID,p_expected_revision BIGINT,p_action TEXT,p_cancel_pending BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF p_action IS NULL OR p_action NOT IN ('publish','start','pause','archive') THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='AUTOMATION_INVALID_REQUEST';
    END IF;
    RETURN private.workflow_mutate_v1(p_studio_id,p_actor_id,p_workflow_id,p_operation_id,p_expected_revision,p_action,NULL,NULL,NULL,NULL,p_cancel_pending);
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
            'command_automation_workflow_v1','get_automation_workflow_v1','list_automation_workflows_v1','get_automation_operation_v1')) LOOP
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
