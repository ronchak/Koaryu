import { sqlLiteral } from "./sql.mjs";

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
