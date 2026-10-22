import observations from './v60-rollout-observations.json' with { type: 'json' };
import schema from './preflight-schema.json' with { type: 'json' };
import { automationFunctionFactsV57 } from './preflight-policy.mjs';
import {
  V59_AUTOMATION_TABLE_STATE_SQL, EXPECTED_V59_AUTOMATION_TABLE_STATE, EXPECTED_V59_RESTORED_AUTOMATION_TABLE_STATE,
  EXPECTED_V59_PLATFORM_AUTOMATION_TABLE_STATE, EXPECTED_V59_RESTORED_PLATFORM_AUTOMATION_TABLE_STATE,
} from './timezone-v59.mjs';

// Version-bound raw observations for the V59-to-V60 canonical/restore proof.
// V60 replaces one function body and the preflight guards; table facts stay V59's.
const context = "WITH context AS MATERIALIZED (SELECT pg_catalog.set_config('search_path','pg_catalog',true),pg_catalog.set_config('TimeZone','UTC',true),pg_catalog.set_config('DateStyle','ISO, YMD',true),pg_catalog.set_config('IntervalStyle','postgres',true))";
function query(facts, label) {
  return `${context} SELECT encode(extensions.digest(convert_to((${facts.replace('FROM (VALUES', 'FROM context CROSS JOIN (VALUES')})::TEXT,'UTF8'),'sha256'),'hex') AS ${label} FROM context`;
}
export const V60_AUTOMATION_FUNCTION_STATE_SQL = query(automationFunctionFactsV57(schema.checks.missed_class_functions_v60), 'automation_function_state');
export const EXPECTED_V60_AUTOMATION_FUNCTION_STATE = schema.checks.missed_class_functions_v60.expected;
export const V60_AUTOMATION_TABLE_STATE_SQL = V59_AUTOMATION_TABLE_STATE_SQL;
export const EXPECTED_V60_AUTOMATION_TABLE_STATE = EXPECTED_V59_AUTOMATION_TABLE_STATE;
export const EXPECTED_V60_RESTORED_AUTOMATION_TABLE_STATE = EXPECTED_V59_RESTORED_AUTOMATION_TABLE_STATE;
export const EXPECTED_V60_PLATFORM_AUTOMATION_TABLE_STATE = EXPECTED_V59_PLATFORM_AUTOMATION_TABLE_STATE;
export const EXPECTED_V60_RESTORED_PLATFORM_AUTOMATION_TABLE_STATE = EXPECTED_V59_RESTORED_PLATFORM_AUTOMATION_TABLE_STATE;

export const EXPECTED_V60_CATALOG_STATE = observations.canonicalCatalog;
export const EXPECTED_V60_RESTORED_CATALOG_STATE = observations.restoredCatalog;
export const V60_GUARD_ROWS = Object.freeze(observations.guards.map(row => Object.freeze(row)));
