import { sqlLiteral } from "./sql.mjs";

export function render_subscription_terms_v49(check) {
  return `    IF (SELECT count(*) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.billing_subscriptions'::REGCLASS
          AND a.attname IN ('currency','billing_interval') AND NOT a.attisdropped
          AND a.atttypid='text'::REGTYPE AND NOT a.attnotnull AND d.oid IS NULL
          AND a.attidentity='' AND a.attgenerated='') IS DISTINCT FROM 2 THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}

// Named catalog and semantic policies shared by release declarations.
// Business assertions remain explicit; the generator does not infer them.

export function render_operational_contract_v31(check) {
  return `    SELECT expected_sha256 INTO v_expected
    FROM ${check.table}
    WHERE expectation_key = ${sqlLiteral(check.expectationKey)};
    IF NOT FOUND
       OR (SELECT count(*) FROM ${check.table}) <> 1
       OR ${check.signature}
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_operational_contract_v31_expectation_acl(check) {
  return `    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname=${sqlLiteral(check.tableName)}
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role',${sqlLiteral(check.table)},
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated',${sqlLiteral(check.table)},
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon',${sqlLiteral(check.table)},
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid=${sqlLiteral(check.table)}::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_inherited_operational_contract_expectation_acl(check) {
  return `    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
${check.tables.map(name => `                (${sqlLiteral(name)})`).join(",\n")}
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
            ${sqlLiteral(check.id)}
        );
    END IF;`;
}

export function render_operational_contract_v30_expectation(check) {
  return `    SELECT expected_sha256 INTO v_expected
    FROM ${check.table}
    WHERE expectation_key = ${sqlLiteral(check.expectationKey)};
    IF NOT FOUND
       OR (SELECT count(*) FROM ${check.table}) <> 1
       OR v_expected <> ${sqlLiteral(check.expected)} THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_operational_contract_v26_expectation(check) {
  return `    SELECT expected_sha256 INTO v_expected
    FROM ${check.table}
    WHERE expectation_key = ${sqlLiteral(check.expectationKey)};
    IF NOT FOUND
       OR (SELECT count(*) FROM ${check.table}) <> 1
       OR v_expected <> ${sqlLiteral(check.expected)}
       OR has_table_privilege('service_role', '${check.table}', 'SELECT')
       OR has_table_privilege('authenticated', '${check.table}', 'SELECT')
       OR has_table_privilege('anon', '${check.table}', 'SELECT') THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_legacy_authorization_scope_execute(check) {
  return `    IF has_function_privilege(
        'service_role',
        ${sqlLiteral(check.signature)},
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_operation_allowlist_constraint(check) {
  return `    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = ${sqlLiteral(check.table)}::REGCLASS
          AND conname = ${sqlLiteral(check.constraint)}
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_operation_allowlist_column(check) {
  return `    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = ${sqlLiteral(check.table)}::REGCLASS
          AND attribute.attname = ${sqlLiteral(check.column)}
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = ${sqlLiteral(check.type)}
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = ${sqlLiteral(check.defaultExpression)}
    ) THEN
        v_failures := array_append(v_failures, ${sqlLiteral(check.id)});
    END IF;`;
}

export function render_operation_allowlist_schedule_semantics(check) {
  return `    IF ${check.function}(
            ${sqlLiteral(check.scope)},ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.release',
                'connected_subscription_schedule.update'
            ]::TEXT[]
       ) IS DISTINCT FROM true
       OR ${check.function}(
            ${sqlLiteral(check.scope)},ARRAY[
                'connected_subscription_schedule.update',
                'connected_subscription_schedule.create'
            ]::TEXT[]
       ) IS DISTINCT FROM false
       OR ${check.function}(
            ${sqlLiteral(check.scope)},ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.unknown'
            ]::TEXT[]
       ) IS DISTINCT FROM false THEN
        v_failures := array_append(
            v_failures,${sqlLiteral(check.id)}
        );
    END IF;`;
}

export function render_stripe_rehearsal_evidence_manifest_v35(check) {
  return `    IF ${check.signature}
       IS DISTINCT FROM (SELECT ${check.field} FROM ${check.table}
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}

export function render_stripe_rehearsal_evidence_acl_v35(check) {
  return `    IF has_function_privilege('anon',
      ${sqlLiteral(check.signature)},'EXECUTE')
       OR has_function_privilege('authenticated',
      ${sqlLiteral(check.signature)},'EXECUTE')
       OR NOT has_function_privilege('service_role',
      ${sqlLiteral(check.signature)},'EXECUTE') THEN
      v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}

export function render_payer_setup_recovery_manifest_v36(check) {
  return `    IF ${check.signature}
    IS DISTINCT FROM (SELECT ${check.field} FROM ${check.table} WHERE singleton) THEN
   v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
 END IF;`;
}

export function render_adjustment_trigger_guard_manifest_v37(check) {
  return ` IF ${check.signature}
      IS DISTINCT FROM (
        SELECT ${check.field}
        FROM ${check.table}
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
   END IF;`;
}

export function render_billing_landing_reads_v38(check) {
  return `${"   "}
 IF EXISTS (
  SELECT 1 FROM (VALUES
${check.functions.map(row => `  (${sqlLiteral(row.signature)},${sqlLiteral(row.bodyHash)})`).join(",\n")}
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,${sqlLiteral(check.id)}); END IF;`;
}

export function render_billing_history_indexes_v38(check) {
  return ` IF EXISTS (
  SELECT 1 FROM (VALUES
${check.indexes.map(row => `   (${sqlLiteral(row.name)},${sqlLiteral(row.table)},${sqlLiteral(row.definition)})`).join(",\n")}
  ) expected(index_name,table_name,definition)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(expected.index_name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.oid IS NULL OR c.relkind<>'i' OR c.relowner<>'postgres'::regrole
   OR i.indrelid IS DISTINCT FROM to_regclass(expected.table_name)
   OR i.indisvalid IS DISTINCT FROM true OR i.indisready IS DISTINCT FROM true
   OR i.indislive IS DISTINCT FROM true OR i.indisunique IS DISTINCT FROM false
   OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM expected.definition
 ) THEN v_failures:=array_append(v_failures,${sqlLiteral(check.id)}); END IF;`;
}

export function render_rank_command_manifest_v40_definition(check) {
  return ` IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid=${sqlLiteral(check.signature)}::REGPROCEDURE
    AND (p.proowner <> 'postgres'::REGROLE OR p.prosecdef OR p.provolatile <> 's'
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
         IS DISTINCT FROM ${sqlLiteral(check.expected)}
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee <> p.proowner))
 ) THEN v_failures:=array_append(v_failures,${sqlLiteral(check.id)}); END IF;`;
}

export function render_function_contract(check) {
  if (typeof check.securityDefiner !== "boolean" || typeof check.returnsSet !== "boolean"
      || !["i", "s", "v"].includes(check.volatility) || !check.configuration?.length) {
    throw new Error(`Incomplete function contract: ${check.id}`);
  }
  return `    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=${sqlLiteral(check.namespace)} AND p.proname=${sqlLiteral(check.functionName)}) <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure(${sqlLiteral(check.signature)})
          AND p.proowner='postgres'::REGROLE AND ${check.securityDefiner ? "" : "NOT "}p.prosecdef AND p.provolatile=${sqlLiteral(check.volatility)}
          AND p.prorettype=${sqlLiteral(check.returnType)}::REGTYPE AND ${check.returnsSet ? "" : "NOT "}p.proretset
          AND p.proconfig=ARRAY[${check.configuration.map(sqlLiteral).join(",")}]::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = ${sqlLiteral(check.expected)}
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = ${sqlLiteral(`[ ${check.acl.map(row => JSON.stringify(row)).join(", ")} ]`)}::JSONB
       ) THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}

export function render_import_receipts_v45(check) {
  if (!check.receiptState || !check.runFlag) throw new Error("Import receipt schema must be declared");
  return `    IF (SELECT jsonb_build_object(
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
          AND relation.relkind='r') IS DISTINCT FROM ${sqlLiteral(JSON.stringify(check.receiptState))}::JSONB
       OR (SELECT jsonb_build_array(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
                attribute.attnotnull,pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL)
            FROM pg_catalog.pg_attribute attribute LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=pg_catalog.to_regclass('public.student_import_runs')
              AND attribute.attname='receipts_enabled' AND NOT attribute.attisdropped)
          IS DISTINCT FROM ${sqlLiteral(JSON.stringify(check.runFlag))}::JSONB THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}

// The receipt schema is independently pinned, including column grants and policies.
export const LEAD_RECEIPT_FACTS_SQL = `SELECT jsonb_build_object(
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
          AND relation.relkind='r'`;

export function render_lead_follow_up_receipts_v52(check) {
  return `    IF (SELECT encode(extensions.digest(convert_to((${LEAD_RECEIPT_FACTS_SQL})::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM ${sqlLiteral(check.expected)} THEN
        v_failures:=array_append(v_failures,'lead_follow_up_operations_v52');
    END IF;`;
}

// Pin the full installed student write/age contract, including all named ACLs
// and trigger bindings. Independent callers hash the same raw JSON expression.
export const STUDENT_PROFILE_FACTS_V54_SQL = `SELECT jsonb_build_object(
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
    )`;

export function render_student_profile_facts_v54(check) {
  return `    IF (SELECT encode(extensions.digest(convert_to((${STUDENT_PROFILE_FACTS_V54_SQL})::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM ${sqlLiteral(check.expected)} THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}

// V55 retains the student write/age inventory while pinning the new conversion
// definition independently of the historical V54 declaration.
export const STUDENT_PROFILE_FACTS_V55_SQL = STUDENT_PROFILE_FACTS_V54_SQL;
export const render_student_profile_facts_v55 = render_student_profile_facts_v54;


// V56 automation state includes complete effective ACLs. Raw facts remain
// available independently of the preflight's reviewed expected digest.
export const AUTOMATION_TABLE_FACTS_V56_SQL = `SELECT jsonb_agg(jsonb_build_object(
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
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name)`;

export const AUTOMATION_FUNCTION_FACTS_V56_SQL = `SELECT jsonb_agg(jsonb_build_object(
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
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang`;

function renderAutomationFacts(check, sql) {
  return `    IF (SELECT encode(extensions.digest(convert_to((${sql})::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM ${sqlLiteral(check.expected)} THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
}
export const render_automation_tables_v56 = check => renderAutomationFacts(check, AUTOMATION_TABLE_FACTS_V56_SQL);
export const render_automation_functions_v56 = check => renderAutomationFacts(check, AUTOMATION_FUNCTION_FACTS_V56_SQL);

// V57 binds the complete installed public/private catalog. The identities are
// declared inputs; unexpected names fail just as missing names do. Reuse the
// V56 raw metadata shape rather than reducing ownership to function bodies.
export function automationTableFactsV57(check) {
  const start = AUTOMATION_TABLE_FACTS_V56_SQL.indexOf('FROM (VALUES');
  const end = AUTOMATION_TABLE_FACTS_V56_SQL.indexOf(' required(name)', start);
  return AUTOMATION_TABLE_FACTS_V56_SQL.slice(0, start)
    + `FROM (VALUES ${check.tables.map(name => `(${sqlLiteral(name)})`).join(',\n    ')})`
    + AUTOMATION_TABLE_FACTS_V56_SQL.slice(end);
}
export function automationFunctionFactsV57(check) {
  const start = AUTOMATION_FUNCTION_FACTS_V56_SQL.indexOf('FROM (VALUES');
  const end = AUTOMATION_FUNCTION_FACTS_V56_SQL.indexOf(' required(signature)', start);
  return AUTOMATION_FUNCTION_FACTS_V56_SQL.slice(0, start)
    + `FROM (VALUES ${check.signatures.map(name => `(${sqlLiteral(name)})`).join(',\n    ')})`
    + AUTOMATION_FUNCTION_FACTS_V56_SQL.slice(end);
}
export const render_automation_tables_v57 = check => {
  const facts = automationTableFactsV57(check);
  if (Boolean(check.platformExpected) !== Boolean(check.platformRestoredExpected)) {
    throw new Error("V57 platform catalog profiles require both canonical and restored pins");
  }
  const expected = [check.expected, ...(check.restoredExpected ? [check.restoredExpected] : []),
    ...(check.platformExpected ? [check.platformExpected, check.platformRestoredExpected] : [])];
  if (expected.some(value => !/^[0-9a-f]{64}$/.test(value)) || new Set(expected).size !== expected.length) {
    throw new Error("V57 table catalog profiles require distinct exact SHA-256 pins");
  }
  return `    IF (SELECT encode(extensions.digest(convert_to((${facts})::TEXT,'UTF8'),'sha256'),'hex'))
       NOT IN (${expected.map(sqlLiteral).join(',')})
       OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C")
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p'))
          IS DISTINCT FROM ARRAY[${check.tables.map(sqlLiteral).join(',')}]::TEXT[] THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
};
export const render_automation_functions_v57 = check => {
  const facts = automationFunctionFactsV57(check);
  return `    IF (SELECT encode(extensions.digest(convert_to((${facts})::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM ${sqlLiteral(check.expected)}
       OR (SELECT array_agg(p.oid::REGPROCEDURE::TEXT ORDER BY p.oid::REGPROCEDURE::TEXT COLLATE "C")
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname IN ('public','private') AND p.prokind='f'
             AND p.oid <> pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v38()'))
          IS DISTINCT FROM ARRAY[${check.signatures.map(sqlLiteral).join(',')}]::TEXT[] THEN
        v_failures:=array_append(v_failures,${sqlLiteral(check.id)});
    END IF;`;
};
export const render_preflight_security_v57 = () => `    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
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
    END IF;`;
