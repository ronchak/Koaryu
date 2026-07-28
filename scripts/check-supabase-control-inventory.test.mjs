import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  collectLiveInventory,
  sanitizeAuthConfig,
  sanitizeBackupInventory,
  validateInventory,
} from "./check-supabase-control-inventory.mjs";

const inventory = JSON.parse(
  readFileSync(new URL("../docs/supabase-control-inventory.json", import.meta.url), "utf8"),
);
const verificationTime = new Date("2026-07-28T03:05:00Z");

function clonedInventory() {
  return structuredClone(inventory);
}

describe("Supabase control inventory", () => {
  it("accepts the complete current inventory", () => {
    assert.deepEqual(validateInventory(inventory, { now: verificationTime }), []);
  });

  it("fails closed when a required control disappears", () => {
    const changed = clonedInventory();
    delete changed.environments.production.controls.auth_revocation;

    assert.match(
      validateInventory(changed, { now: verificationTime }).join("\n"),
      /production\.controls\.auth_revocation is required/,
    );
  });

  it("requires distinct projects and a typed live baseline", () => {
    const changed = clonedInventory();
    changed.environments.staging.project_ref =
      changed.environments.production.project_ref;
    changed.environments.production.live_baseline.walg_enabled = "true";

    const failures = validateInventory(changed, { now: verificationTime }).join("\n");
    assert.match(failures, /walg_enabled must be boolean/);
    assert.match(failures, /project refs must be distinct/);
  });

  it("requires blockers and approvals for unresolved evidence", () => {
    const changed = clonedInventory();
    changed.environments.production.controls.auth_session_limits.blocker = "";
    changed.environments.production.controls.auth_session_limits.approval_required = false;

    const failures = validateInventory(changed, { now: verificationTime }).join("\n");
    assert.match(failures, /blocker is required/);
    assert.match(failures, /must remain approval-gated/);
  });

  it("rejects stale review evidence", () => {
    const changed = clonedInventory();
    changed.environments.staging.controls.backup_inventory.reviewed_at =
      "2026-07-01T00:00:00Z";

    assert.match(
      validateInventory(changed, { now: verificationTime }).join("\n"),
      /staging\.controls\.backup_inventory is stale/,
    );
  });

  it("allowlists non-secret Auth settings", () => {
    assert.deepEqual(
      sanitizeAuthConfig({
        disable_signup: false,
        jwt_exp: 3600,
        rate_limit_token_refresh: 1800,
        smtp_pass: "must-not-escape",
        smtp_user: "must-not-escape",
        hook_secret: "must-not-escape",
      }),
      {
        disable_signup: false,
        jwt_exp: 3600,
        rate_limit_token_refresh: 1800,
      },
    );
  });

  it("reduces backup metadata to bounded aggregate evidence", () => {
    assert.deepEqual(
      sanitizeBackupInventory({
        backups: [
          { id: "private-id", inserted_at: "2026-07-25T00:00:00Z" },
          { id: "private-id-2", completed_at: "2026-07-26T00:00:00Z" },
        ],
        physical_backup_data: { private: "omitted" },
        pitr_enabled: true,
        region: "us-west-1",
        walg_enabled: true,
      }),
      {
        backup_count: 2,
        earliest_backup_at: "2026-07-25T00:00:00Z",
        latest_backup_at: "2026-07-26T00:00:00Z",
        pitr_enabled: true,
        region: "us-west-1",
        walg_enabled: true,
      },
    );
  });

  it("detects provider drift without returning sensitive Auth fields", async () => {
    const changed = clonedInventory();
    const responses = new Map([
      [
        "https://api.supabase.com/v1/projects",
        [
          {
            ref: changed.environments.production.project_ref,
            status: "ACTIVE_HEALTHY",
            region: "us-west-2",
          },
          {
            ref: changed.environments.staging.project_ref,
            status: "ACTIVE_HEALTHY",
            region: "us-west-1",
          },
        ],
      ],
    ]);
    for (const environment of ["production", "staging"]) {
      const ref = changed.environments[environment].project_ref;
      responses.set(
        `https://api.supabase.com/v1/projects/${ref}/config/auth`,
        { jwt_exp: 3600, smtp_pass: "must-not-escape" },
      );
      responses.set(
        `https://api.supabase.com/v1/projects/${ref}/database/backups`,
        {
          backups: environment === "production" ? [{ inserted_at: "2026-07-27T00:00:00Z" }] : [],
          pitr_enabled: false,
          region: environment === "production" ? "us-west-2" : "us-west-1",
          walg_enabled: true,
        },
      );
    }
    const fakeFetch = async (url) => {
      const body = responses.get(url);
      return new Response(JSON.stringify(body), {
        status: body === undefined ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    };

    const live = await collectLiveInventory(changed, {
      token: "deliberate-test-token",
      fetchImpl: fakeFetch,
      checkedAt: "2026-07-28T03:05:00Z",
    });

    assert.match(live.drift.join("\n"), /production: backup_count drifted/);
    assert.equal(live.projects[0].auth.jwt_exp, 3600);
    assert.equal("smtp_pass" in live.projects[0].auth, false);
  });

  it("detects physical-backup plumbing drift without treating it as entitlement", async () => {
    const responses = new Map([
      [
        "https://api.supabase.com/v1/projects",
        Object.values(inventory.environments).map((environment) => ({
          ref: environment.project_ref,
          status: environment.live_baseline.project_status,
          region: environment.live_baseline.region,
        })),
      ],
    ]);
    for (const environment of Object.values(inventory.environments)) {
      responses.set(
        `https://api.supabase.com/v1/projects/${environment.project_ref}/config/auth`,
        {},
      );
      responses.set(
        `https://api.supabase.com/v1/projects/${environment.project_ref}/database/backups`,
        {
          backups: [],
          pitr_enabled: false,
          region: environment.live_baseline.region,
          walg_enabled: false,
        },
      );
    }
    const fakeFetch = async (url) =>
      Response.json(responses.get(url), { status: responses.has(url) ? 200 : 404 });

    const live = await collectLiveInventory(inventory, {
      token: "deliberate-test-token",
      fetchImpl: fakeFetch,
      checkedAt: "2026-07-28T03:05:00Z",
    });

    assert.equal(live.drift.filter((finding) => finding.includes("walg_enabled")).length, 2);
  });
});
