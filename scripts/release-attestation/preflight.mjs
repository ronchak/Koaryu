import schema from "./preflight-schema.json" with { type: "json" };
import * as policies from "./preflight-policy.mjs";
import {
  renderDirectHistory, renderDirectPreflight, renderFunctionHashCheck, renderManifestCheck,
} from "./sql.mjs";

function declaredChecks(id, ancestors = []) {
  if (ancestors.includes(id)) throw new Error(`Preflight inheritance cycle: ${id}`);
  const declaration = schema.states[id];
  if (!declaration) throw new Error(`No declared preflight checks for ${id}`);
  const checks = declaration.extends
    ? declaredChecks(declaration.extends, [...ancestors, id])
    : (declaration.checks ?? []).map(key => {
      if (!Object.hasOwn(schema.checks, key)) throw new Error(`Unknown preflight check: ${key}`);
      return { id: key, ...schema.checks[key] };
    });
  for (const [key, replacement] of Object.entries(declaration.replace ?? {})) {
    const index = checks.findIndex(check => check.id === key);
    if (index < 0) throw new Error(`Cannot replace missing preflight check: ${key}`);
    if (!Object.hasOwn(schema.checks, replacement)) throw new Error(`Unknown replacement preflight check: ${replacement}`);
    checks[index] = { id: replacement, ...schema.checks[replacement] };
  }
  for (const [key, changes] of Object.entries(declaration.overrides ?? {})) {
    const index = checks.findIndex(check => check.id === key);
    if (index < 0) throw new Error(`Cannot override missing preflight check: ${key}`);
    checks[index] = { ...checks[index], ...changes };
  }
  for (const key of declaration.append ?? []) {
    if (!Object.hasOwn(schema.checks, key)) throw new Error(`Unknown preflight check: ${key}`);
    checks.push({ id: key, ...schema.checks[key] });
  }
  if (!checks.length || new Set(checks.map(check => check.id)).size !== checks.length) {
    throw new Error(`Preflight ${id} must have a nonempty set of unique checks`);
  }
  return checks;
}

export function renderPreflight(state) {
  const checks = declaredChecks(state.id).map(check => {
    if (check.kind === "manifest") return renderManifestCheck(check);
    if (check.kind === "function-hash") return renderFunctionHashCheck(check);
    const render = policies[`render_${check.kind}`];
    if (typeof render !== "function") throw new Error(`Unknown preflight policy: ${check.kind}`);
    return render(check);
  });
  let rendered = renderDirectPreflight(state, [
    renderDirectHistory(state, {
      sequenceFailures: ["migration_history_sequence_v31", "migration_history_sequence_v30"],
      pendingLineWidths: [4, 4, 4, 4, 4, 4, 4, 4, 4, 2],
    }),
    ...checks,
  ], { separateTerminator: state.id === "v39" || state.id === "v40" });
  if (state.id === "v57") {
    rendered = rendered.replace(" SET search_path TO 'pg_catalog'\nAS", " SET search_path TO 'pg_catalog'\n SET TimeZone TO 'UTC'\n SET DateStyle TO 'ISO, YMD'\n SET IntervalStyle TO 'postgres'\nAS");
  }
  return ["v52", "v53", "v56", "v57"].includes(state.id) ? rendered.replace(/^[ \t]+$/gm, "") : rendered;
}
