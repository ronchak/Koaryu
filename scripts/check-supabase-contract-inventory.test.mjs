import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXPECTED_SUPABASE_CONTRACTS,
  compareSupabaseContractInventory,
  readSupabaseContractInventory,
} from "./check-supabase-contract-inventory.mjs";

test("contract inventory exactly matches every verification SQL file", () => {
  const actual = readSupabaseContractInventory();
  assert.deepEqual(actual, [...EXPECTED_SUPABASE_CONTRACTS].sort());
  assert.deepEqual(compareSupabaseContractInventory(actual), {
    missing: [],
    unexpected: [],
    matches: true,
  });
});

test("contract inventory rejects both omitted and unreviewed SQL", () => {
  const missing = EXPECTED_SUPABASE_CONTRACTS.slice(1);
  assert.deepEqual(compareSupabaseContractInventory(missing).missing, [
    EXPECTED_SUPABASE_CONTRACTS[0],
  ]);

  const extra = [...EXPECTED_SUPABASE_CONTRACTS, "unreviewed_contract.sql"];
  assert.deepEqual(compareSupabaseContractInventory(extra).unexpected, [
    "unreviewed_contract.sql",
  ]);
});
