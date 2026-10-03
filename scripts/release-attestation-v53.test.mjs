import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { releaseState } from './release-attestation/states.mjs';
import { MIGRATION_VERSIONS } from './release-attestation/generated-history.mjs';
import { renderPreflight } from './release-attestation/preflight.mjs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260929152445_dashboard_roster_inactivity_v53.sql', import.meta.url), 'utf8');

test('V53 follows the exact V52 history and guards the dashboard definition', () => {
  assert.equal(releaseState('v53', MIGRATION_VERSIONS).id, 'v53');
  const state = releaseState('v53', MIGRATION_VERSIONS);
  assert.equal(state.predecessor, 'v52');
  assert.equal(state.count, 148);
  assert.equal(state.preflight, 'public.koaryu_release_schema_preflight_v34()');
  assert.equal(state.pending.length, 64);
  const sql = renderPreflight(state);
  for (const guard of ['dashboard_summary_facts_v53', 'resource_ownership_manifest_v31', 'operational_manifest_v12']) {
    assert.ok(sql.includes(guard), guard);
  }
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.dashboard_summary_facts(');
  const end = migration.indexOf('$function$;', start) + '$function$;'.length;
  assert.ok(start > 0 && end > start);
  assert.equal(createHash('sha256').update(migration.slice(start, end)).digest('hex'),
    '945534c5891f9cf91596cffdad9624b3bd28085a0c48ffc3c76f4aee66aeadae');
});

test('V53 restore uses both local copies and checks retained participation rows', () => {
  const script = fs.readFileSync(new URL('./verify-v52-v53-restore-contract.py', import.meta.url), 'utf8');
  for (const text of ['canonical', 'restored', 'normalization_plan', 'snapshot(database) == before',
    'V53 dashboard/roster inactivity', 'V52 source no longer reproduces']) assert.ok(script.includes(text), text);
});
