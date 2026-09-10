// These emitters produce standalone SQL. They never inspect a database or read
// the historical output being reproduced.
export function sqlLiteral(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("SQL text values must be strings without NUL bytes");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderCompatibility(source, target, { expandedCondition = false } = {}) {
  const omitted = source.count - target.count;
  if (source.preflight === target.preflight || omitted < 1
      || source.pending.length - target.pending.length !== omitted
      || source.pending.slice(0, target.pending.length).join(",")
      !== target.pending.join(",")) {
    throw new Error("Compatibility requires a strict predecessor history");
  }
  const conjunction = expandedCondition ? "\n       AND " : " AND ";
  const historyCondition = [
    "v.ready IS TRUE", `v.migration_count = ${source.count}`,
    `v.migration_head = ${sqlLiteral(source.head)}`,
  ].join(conjunction);
  const failureCondition = [
    "cardinality(v.security_failures) = 0",
    `cardinality(v.pending_versions) = ${source.pending.length}`,
  ].join(conjunction);
  return `CREATE OR REPLACE FUNCTION ${target.preflight}
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM ${source.preflight};
    IF ${historyCondition}
       AND v.manifest_version = ${sqlLiteral(source.manifestVersion)}
       AND ${failureCondition}
       AND v.pending_versions[cardinality(v.pending_versions)] = ${sqlLiteral(source.head)} THEN
        RETURN QUERY SELECT TRUE, ${target.count}, ${sqlLiteral(target.head)}::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-${omitted}],
            ARRAY[]::TEXT[], ${sqlLiteral(target.manifestVersion)}::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, ${sqlLiteral(target.manifestVersion)}::TEXT;
END;
$function$;`;
}

export function renderServicePrivileges(signature) {
  return `ALTER FUNCTION ${signature} OWNER TO postgres;
REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`;
}

const comparisonFormats = Object.freeze({
  standard: { start: 4, comparison: 7, failure: 8, end: 4 },
  compact: { start: 4, comparison: 7, failure: 8, end: 4, compact: true },
  "legacy-preread": { start: 4, comparison: 11, failure: 12, end: 8, wrapped: true },
  "legacy-compatibility": { start: 8, comparison: 7, failure: 6, end: 4, compact: true },
  "legacy-closeout": { start: 4, comparison: 7, failure: 6, end: 4, compact: true },
});

function comparisonFormat(name = "standard") {
  const format = comparisonFormats[name];
  if (!format) throw new Error(`Unknown historical comparison format: ${name}`);
  return format;
}

function failureStatements(failures, format) {
  if (!Array.isArray(failures) || failures.length === 0) {
    throw new Error("An attestation check must identify its failure");
  }
  const indent = " ".repeat(format.failure);
  return failures.map(failure => {
    if (format.wrapped) {
      return `${indent}v_failures := array_append(\n${indent}    v_failures,${sqlLiteral(failure)}\n${indent});`;
    }
    return format.compact
      ? `${indent}v_failures:=array_append(v_failures,${sqlLiteral(failure)});`
      : `${indent}v_failures := array_append(v_failures, ${sqlLiteral(failure)});`;
  }).join("\n");
}

export function renderManifestCheck(check) {
  const format = comparisonFormat(check.format);
  const operator = check.comparison ?? "IS DISTINCT FROM";
  if (!["<>", "IS DISTINCT FROM"].includes(operator)) {
    throw new Error(`Unsupported manifest comparison: ${operator}`);
  }
  return `${" ".repeat(format.start)}IF ${check.signature}
${" ".repeat(format.comparison)}${operator} ${sqlLiteral(check.expected)} THEN
${failureStatements(check.failures, format)}
${" ".repeat(format.end)}END IF;`;
}

export function renderFunctionHashCheck(check) {
  const format = comparisonFormat(check.format);
  if (!/^[a-f0-9]{64}$/.test(check.expected)) throw new Error("Invalid function SHA256");
  let expression;
  if (check.hashSource === "definition") {
    expression = `encode(extensions.digest(convert_to(pg_get_functiondef(
        ${sqlLiteral(check.signature)}::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')`;
  } else if (check.hashSource === "body") {
    expression = `encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = ${sqlLiteral(check.signature)}::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')`;
  } else {
    throw new Error(`Unknown function hash representation: ${check.hashSource}`);
  }
  return `${" ".repeat(format.start)}IF ${expression}
${" ".repeat(format.comparison)}<> ${sqlLiteral(check.expected)} THEN
${failureStatements(check.failures, format)}
${" ".repeat(format.end)}END IF;`;
}

export function renderDirectHistory(state, { sequenceFailures, pendingLineWidths }) {
  let offset = 0;
  const pendingLines = [...pendingLineWidths, state.pending.length].flatMap(width => {
    const values = state.pending.slice(offset, offset + width);
    offset += values.length;
    return values.length ? [`        ${values.map(sqlLiteral).join(",")}`] : [];
  }).join(",\n");
  return `    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> ${state.count} OR v_head <> ${sqlLiteral(state.head)} THEN
        v_failures := array_append(v_failures, ${sqlLiteral(`migration_history_${state.id}`)});
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
${pendingLines}
    ]::TEXT[] THEN
${failureStatements(sequenceFailures, comparisonFormats.standard)}
    END IF;`;
}

export function renderDirectPreflight(state, checks, { separateTerminator = false } = {}) {
  return `CREATE FUNCTION ${state.preflight}
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
${checks.join("\n")}
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        ${sqlLiteral(state.manifestVersion)}::TEXT;
END;
$function$${separateTerminator ? "\n" : ""};`;
}
