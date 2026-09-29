import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { releaseState } from './release-attestation/states.mjs';
import { MIGRATION_VERSIONS } from './release-attestation/generated-history.mjs';
import { renderPreflight } from './release-attestation/preflight.mjs';

test('V52 binds the full lead commands preflight after V51', () => {
  const state = releaseState('v52', MIGRATION_VERSIONS);
  assert.equal(state.predecessor, 'v51');
  assert.equal(state.count, 147);
  assert.equal(state.preflight, 'public.koaryu_release_schema_preflight_v33()');
  const sql = renderPreflight(state);
  for (const guard of ['update_lead_atomic', 'follow_up_lead_atomic', 'lead_follow_up_operations', 'resource_ownership_manifest_v31', 'invoice_retry_closeout_manifest_v34']) {
    assert.ok(sql.includes(guard), guard);
  }
});

test('V52 restore retains historical rows and proves keyed command replay on both copies', () => {
  const script = fs.readFileSync(new URL('./verify-v51-v52-restore-contract.py', import.meta.url), 'utf8');
  for (const text of ['canonical', 'restored', 'follow_up_lead_atomic', 'update_lead_atomic', 'lead_follow_up_operations', 'snapshot(database) == before']) assert.ok(script.includes(text), text);
});
