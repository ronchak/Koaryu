import observations from './v61-rollout-observations.json' with { type: 'json' };
import schema from './preflight-schema.json' with { type: 'json' };
import { automationTableFactsV57, automationFunctionFactsV57 } from './preflight-policy.mjs';
export { V60_OPERATIONAL_READINESS_SQL, EXPECTED_V60_OPERATIONAL_READINESS,
  V61_OPERATIONAL_READINESS_SQL, EXPECTED_V61_OPERATIONAL_READINESS } from './generated-readiness.mjs';
export { V60_AUTOMATION_TABLE_STATE_SQL, EXPECTED_V60_AUTOMATION_TABLE_STATE,
  EXPECTED_V60_RESTORED_AUTOMATION_TABLE_STATE } from './missed-class-v60.mjs';
const context = "WITH context AS MATERIALIZED (SELECT pg_catalog.set_config('search_path','pg_catalog',true),pg_catalog.set_config('TimeZone','UTC',true),pg_catalog.set_config('DateStyle','ISO, YMD',true),pg_catalog.set_config('IntervalStyle','postgres',true))";
function query(facts) {
  return `${context} SELECT encode(extensions.digest(convert_to((${facts.replace('FROM (VALUES', 'FROM context CROSS JOIN (VALUES')})::TEXT,'UTF8'),'sha256'),'hex') FROM context`;
}
export const V61_TABLES_STATE_SQL = query(automationTableFactsV57(schema.checks.student_import_tables_v61));
export const EXPECTED_V61_TABLES_STATE = schema.checks.student_import_tables_v61.expected;
export const EXPECTED_V61_RESTORED_TABLES_STATE = schema.checks.student_import_tables_v61.restoredExpected;
export const V61_FUNCTIONS_STATE_SQL = query(automationFunctionFactsV57(schema.checks.student_import_functions_v61));
export const EXPECTED_V61_FUNCTIONS_STATE = schema.checks.student_import_functions_v61.expected;

// Version-bound rollout observations preserve canonical/restored acceptance tuples.
export const EXPECTED_V61_CATALOG_STATE = observations.canonicalCatalog;
export const EXPECTED_V61_RESTORED_CATALOG_STATE = observations.restoredCatalog;
export const V61_GUARD_ROWS = Object.freeze(observations.guards.map(row => Object.freeze(row)));
export const V61_AUTOMATION_TABLE_STATE_SQL = V61_TABLES_STATE_SQL.replace(/ FROM context$/, ' AS automation_table_state FROM context');
export const V61_AUTOMATION_FUNCTION_STATE_SQL = V61_FUNCTIONS_STATE_SQL.replace(/ FROM context$/, ' AS automation_function_state FROM context');
export const EXPECTED_V61_AUTOMATION_TABLE_STATE = EXPECTED_V61_TABLES_STATE;
export const EXPECTED_V61_RESTORED_AUTOMATION_TABLE_STATE = EXPECTED_V61_RESTORED_TABLES_STATE;
export const EXPECTED_V61_PLATFORM_AUTOMATION_TABLE_STATE = schema.checks.student_import_tables_v61.platformExpected;
export const EXPECTED_V61_RESTORED_PLATFORM_AUTOMATION_TABLE_STATE = schema.checks.student_import_tables_v61.platformRestoredExpected;
export const EXPECTED_V61_AUTOMATION_FUNCTION_STATE = EXPECTED_V61_FUNCTIONS_STATE;
