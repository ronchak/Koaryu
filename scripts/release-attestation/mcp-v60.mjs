import schema from './preflight-schema.json' with { type: 'json' };
import { automationTableFactsV57, automationFunctionFactsV57 } from './preflight-policy.mjs';

const context = "WITH context AS MATERIALIZED (SELECT pg_catalog.set_config('search_path','pg_catalog',true),pg_catalog.set_config('TimeZone','UTC',true),pg_catalog.set_config('DateStyle','ISO, YMD',true),pg_catalog.set_config('IntervalStyle','postgres',true))";
function query(facts, label) {
  return `${context} SELECT encode(extensions.digest(convert_to((${facts.replace('FROM (VALUES', 'FROM context CROSS JOIN (VALUES')})::TEXT,'UTF8'),'sha256'),'hex') AS ${label} FROM context`;
}
export const V60_MCP_TABLE_STATE_SQL = query(automationTableFactsV57(schema.checks.mcp_tables_v60), "mcp_table_state");
export const EXPECTED_V60_MCP_TABLE_STATE = schema.checks.mcp_tables_v60.expected;
export const EXPECTED_V60_RESTORED_MCP_TABLE_STATE = schema.checks.mcp_tables_v60.restoredExpected;
export const V60_MCP_FUNCTION_STATE_SQL = query(automationFunctionFactsV57(schema.checks.mcp_functions_v60), "mcp_function_state");
export const EXPECTED_V60_MCP_FUNCTION_STATE = schema.checks.mcp_functions_v60.expected;

export const EXPECTED_V60_PLATFORM_MCP_TABLE_STATE = schema.checks.mcp_tables_v60.platformExpected;
export const EXPECTED_V60_RESTORED_PLATFORM_MCP_TABLE_STATE = schema.checks.mcp_tables_v60.platformRestoredExpected;
