import { sqlLiteral } from "./sql.mjs";

function manifestHeader(signature, language, format) {
  if (!["catalog", "authored"].includes(format)) throw new Error(`Unknown manifest format: ${format}`);
  return format === "catalog"
    ? `CREATE OR REPLACE FUNCTION ${signature}
 RETURNS text
 LANGUAGE ${language}
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$`
    : `CREATE FUNCTION ${signature}
RETURNS TEXT
LANGUAGE ${language}
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$`;
}

function manifestTerminator(format) {
  return format === "catalog" ? "$function$\n;" : "$$;";
}

export function renderRankReturnManifest(specification) {
  const { signature, functions, parent, expectedParent, format = "authored" } = specification;
  if (!functions.length) throw new Error("A rank return manifest requires functions");
  const header = manifestHeader(signature, "sql", format);
  return `${header}
WITH required_functions(signature, expected_result) AS (
    VALUES
${functions.map(row => `        (
            ${sqlLiteral(row.signature)},
            ${sqlLiteral(row.result)}
        )`).join(",\n")}
),
function_actual AS (
    SELECT
        format(
            '%I.%I(%s)',
            namespace.nspname,
            function.proname,
            oidvectortypes(function.proargtypes)
        ) AS signature,
        replace(pg_get_function_result(function.oid), 'public.', '') AS result_contract
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)',
          namespace.nspname,
          function.proname,
          oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.signature,
        required.expected_result,
        actual.result_contract
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
manifest_state AS (
    SELECT ${parent} AS v11_manifest
),
invalid AS (
    SELECT
        count(*) FILTER (
            WHERE function.result_contract IS DISTINCT FROM function.expected_result
        ) +
        count(*) FILTER (
            WHERE manifest.v11_manifest IS DISTINCT FROM
              ${sqlLiteral(expectedParent)}
        ) AS invalid_count
    FROM function_compared function
    CROSS JOIN manifest_state manifest
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            manifest.v11_manifest || '|' || COALESCE(string_agg(
                function.signature || ':' ||
                function.expected_result || ':' ||
                COALESCE(function.result_contract, ''),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN manifest_state manifest
CROSS JOIN invalid
GROUP BY invalid.invalid_count, manifest.v11_manifest;
${manifestTerminator(format)}`;
}

export function renderRankReceiptManifest(specification) {
  const format = specification.format ?? "authored";
  const header = manifestHeader(specification.signature, "plpgsql", format);
  return `${header}
DECLARE
    v_v15 TEXT;
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    v_v15 := ${specification.parent};
    v_invalid := COALESCE(NULLIF(split_part(v_v15, ':', 1), '')::INTEGER, 1);

    WITH required_functions(signature) AS (
        VALUES
${specification.functions.map(value => `          (${sqlLiteral(value)})`).join(",\n")}
    ), function_state AS (
        SELECT required.signature,
               procedure.oid,
               COALESCE(pg_get_functiondef(procedure.oid), '') AS definition,
               COALESCE(pg_get_function_result(procedure.oid), '') AS result_contract,
               COALESCE(owner.rolname, '') AS owner_name,
               COALESCE(procedure.prosecdef::TEXT, '') AS security_definer,
               COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
               COALESCE(array_to_string(procedure.proacl, ','), '') AS acl
        FROM required_functions required
        LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles owner ON owner.oid = procedure.proowner
    -- The rank-transition receipt is a schema guarantee, not only a function
    -- body: the columns carry the receipt, the partial unique index is what
    -- makes the replay lookup safe under concurrency, and the check constraint
    -- is what keeps transition_kind a closed set. V15 cannot cover any of them
    -- because they did not exist yet, so readiness has to attest them here or a
    -- hosted database missing one still reports ready while the RPC silently
    -- loses idempotency.
    ), required_columns(table_name, column_name) AS (
        VALUES
${specification.columns.map(value => `          (${sqlLiteral("promotions")}, ${sqlLiteral(value)})`).join(",\n")}
    ), column_state AS (
        SELECT required.table_name,
               required.column_name,
               attribute.attnum AS oid,
               COALESCE(format_type(attribute.atttypid, attribute.atttypmod), '') AS type_name,
               COALESCE(attribute.attnotnull::TEXT, '') AS not_null${specification.includeDefaults ? `,\n               COALESCE(pg_get_expr(default_row.adbin, default_row.adrelid), '') AS default_expression` : ""}
        FROM required_columns required
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = 'public.promotions'::regclass
         AND attribute.attname = required.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped${specification.includeDefaults ? `
        LEFT JOIN pg_attrdef default_row ON default_row.adrelid = attribute.attrelid
          AND default_row.adnum = attribute.attnum` : ""}
    ), required_indexes(name) AS (
        VALUES ${specification.indexes.map(value => `(${sqlLiteral(value)})`).join(", ")}
    ), index_state AS (
        SELECT required.name,
               index_row.indexrelid AS oid,
               COALESCE(pg_get_indexdef(index_row.indexrelid), '') AS definition,
               COALESCE(index_row.indisunique::TEXT, '') AS is_unique,
               COALESCE(index_row.indisvalid::TEXT, '') AS is_valid
        FROM required_indexes required
        LEFT JOIN pg_class index_class ON index_class.relname = required.name
        LEFT JOIN pg_index index_row
          ON index_row.indexrelid = index_class.oid
         AND index_row.indrelid = 'public.promotions'::regclass
    ), required_constraints(name) AS (
        VALUES ${specification.constraints.map(value => `(${sqlLiteral(value)})`).join(", ")}
    ), constraint_state AS (
        SELECT required.name,
               constraint_row.oid,
               COALESCE(pg_get_constraintdef(constraint_row.oid, TRUE), '') AS definition,
               COALESCE(constraint_row.convalidated::TEXT, '') AS validated
        FROM required_constraints required
        LEFT JOIN pg_constraint constraint_row ON constraint_row.conname = required.name
          AND constraint_row.conrelid = 'public.promotions'::regclass
${specification.includeForeignKeys ? `    ), foreign_key_state AS (
        SELECT conname AS name, pg_get_constraintdef(oid, TRUE) AS definition,
               convalidated AS validated
        FROM pg_constraint
        WHERE conrelid = 'public.promotions'::REGCLASS AND contype = 'f'
` : ""}    ), serialized AS (
        SELECT 'f:' || signature || ':' || definition || ':' || result_contract || ':' ||
               owner_name || ':' || security_definer || ':' || configuration || ':' ||
               acl AS value,
               (oid IS NULL)::INTEGER AS invalid
        FROM function_state
        UNION ALL
        SELECT 'a:' || table_name || ':' || column_name || ':' || type_name || ':' || not_null${specification.includeDefaults ? " || ':' || default_expression" : ""},
               (oid IS NULL)::INTEGER
        FROM column_state
        UNION ALL
        SELECT 'i:' || name || ':' || definition || ':' || is_unique || ':' || is_valid,
               (oid IS NULL OR is_unique <> 'true' OR is_valid <> 'true')::INTEGER
        FROM index_state
        UNION ALL
        SELECT 'c:' || name || ':' || definition || ':' || validated,
               (oid IS NULL OR validated <> 'true')::INTEGER
        FROM constraint_state
${specification.includeForeignKeys ? `        UNION ALL
        -- These are the complete deletion relationships. Adding an FK to the
        -- immutable command UUIDs must change readiness, just like dropping one.
        SELECT 'fk:' || name || ':' || definition || ':' || validated::TEXT,
               (validated IS DISTINCT FROM TRUE)::INTEGER
        FROM foreign_key_state
` : ""}    )
    SELECT v_invalid + COALESCE(sum(invalid), 0)::INTEGER,
           'v15:' || COALESCE(v_v15, '') || '|' ||
           string_agg(value, '|' ORDER BY value COLLATE "C")
    INTO v_invalid, v_serialized
    FROM serialized;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
${manifestTerminator(format)}`;
}
