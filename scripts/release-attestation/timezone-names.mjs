// Enumerate names only during release inspection, never routine readiness.
export const TIMEZONE_NAMES_PARITY_SQL = `SELECT jsonb_build_object(
  'missing', COALESCE((SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM
    (SELECT name FROM pg_catalog.pg_timezone_names EXCEPT SELECT name FROM private.timezone_names) missing), '[]'::jsonb),
  'surplus', COALESCE((SELECT jsonb_agg(name ORDER BY name COLLATE "C") FROM
    (SELECT name FROM private.timezone_names EXCEPT SELECT name FROM pg_catalog.pg_timezone_names) surplus), '[]'::jsonb)
)::text AS timezone_names_parity`;
export const EXPECTED_TIMEZONE_NAMES_PARITY = '{"missing": [], "surplus": []}';

export function validateTimezoneNameParity(raw) {
  const state = JSON.parse(raw);
  if (!state || Object.keys(state).sort().join(',') !== 'missing,surplus'
      || !Array.isArray(state.missing) || !Array.isArray(state.surplus)
      || [...state.missing, ...state.surplus].some(name => typeof name !== 'string')) {
    throw new Error('Malformed timezone names parity evidence');
  }
  if (state.missing.length || state.surplus.length) {
    throw new Error(`TIMEZONE_NAMES_DRIFT missing=${JSON.stringify(state.missing)} surplus=${JSON.stringify(state.surplus)}`);
  }
  return raw;
}
