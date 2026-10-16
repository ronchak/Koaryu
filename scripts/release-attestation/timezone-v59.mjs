import observations from './v59-rollout-observations.json' with { type: 'json' };
import schema from './preflight-schema.json' with { type: 'json' };
import { automationTableFactsV57, automationFunctionFactsV57 } from './preflight-policy.mjs';

// Version-bound raw observations for the V58-to-V59 canonical/restore proof.
const context = "WITH context AS MATERIALIZED (SELECT pg_catalog.set_config('search_path','pg_catalog',true),pg_catalog.set_config('TimeZone','UTC',true),pg_catalog.set_config('DateStyle','ISO, YMD',true),pg_catalog.set_config('IntervalStyle','postgres',true))";
function query(facts, label) {
  return `${context} SELECT encode(extensions.digest(convert_to((${facts.replace('FROM (VALUES', 'FROM context CROSS JOIN (VALUES')})::TEXT,'UTF8'),'sha256'),'hex') AS ${label} FROM context`;
}
export const V59_TIMEZONE_TABLE_STATE_SQL = query(automationTableFactsV57(schema.checks.timezone_tables_v59), 'timezone_table_state');
export const EXPECTED_V59_TIMEZONE_TABLE_STATE = schema.checks.timezone_tables_v59.expected;
export const EXPECTED_V59_RESTORED_TIMEZONE_TABLE_STATE = schema.checks.timezone_tables_v59.restoredExpected;
export const V59_TIMEZONE_FUNCTION_STATE_SQL = query(automationFunctionFactsV57(schema.checks.timezone_functions_v59), 'timezone_function_state');
export const EXPECTED_V59_TIMEZONE_FUNCTION_STATE = schema.checks.timezone_functions_v59.expected;

export const EXPECTED_V59_CATALOG_STATE = observations.canonicalCatalog;
export const EXPECTED_V59_RESTORED_CATALOG_STATE = observations.restoredCatalog;
export const V59_GUARD_ROWS = Object.freeze(observations.guards.map(row => Object.freeze(row)));
export const V59_AUTOMATION_TABLE_STATE_SQL = V59_TIMEZONE_TABLE_STATE_SQL.replace('AS timezone_table_state', 'AS automation_table_state');
export const EXPECTED_V59_AUTOMATION_TABLE_STATE = EXPECTED_V59_TIMEZONE_TABLE_STATE;
export const EXPECTED_V59_RESTORED_AUTOMATION_TABLE_STATE = EXPECTED_V59_RESTORED_TIMEZONE_TABLE_STATE;
export const EXPECTED_V59_PLATFORM_AUTOMATION_TABLE_STATE = schema.checks.timezone_tables_v59.platformExpected;
export const EXPECTED_V59_RESTORED_PLATFORM_AUTOMATION_TABLE_STATE = schema.checks.timezone_tables_v59.platformRestoredExpected;
export const V59_AUTOMATION_FUNCTION_STATE_SQL = V59_TIMEZONE_FUNCTION_STATE_SQL.replace('AS timezone_function_state', 'AS automation_function_state');
export const EXPECTED_V59_AUTOMATION_FUNCTION_STATE = EXPECTED_V59_TIMEZONE_FUNCTION_STATE;
