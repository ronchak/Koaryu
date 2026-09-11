import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { verifyAuthenticatedRestoreEvidence } from "./verify-authenticated-restore.mjs";

const FIXTURE_URL = new URL("./fixtures/authenticated-restore/synthetic-evidence.json", import.meta.url);

function fixture() {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
}

function applicationCheck(evidence, id) {
  return evidence.application_checks.find((check) => check.id === id);
}

function storageCheck(evidence, id) {
  return evidence.storage.synthetic_probe.checks.find((check) => check.id === id);
}

function relation(evidence, name) {
  return evidence.integrity.relations.find((item) => item.name === name);
}

describe("authenticated restore evidence verifier", () => {
  it("accepts the complete synthetic contract and labels it as a fixture", () => {
    const result = verifyAuthenticatedRestoreEvidence(fixture());
    assert.equal(result.mode, "synthetic_fixture");
    assert.equal(result.finalState, "destroyed");
    assert.equal(result.applicationCheckCount, 20);
    assert.equal(result.relationCount, 13);
    assert.equal(result.elapsedSeconds, 1800);
  });

  it("cannot use synthetic evidence to satisfy live acceptance", () => {
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(fixture(), { requireProductionDerived: true }),
      /synthetic fixtures cannot close the gate/,
    );
  });

  it("rejects production, staging, and prior restore project refs", () => {
    for (const projectRef of [
      "mimguepumzsgmcaycdsh",
      "nxgsektqsgrtyfhawxbc",
      "zmmacdleiaohvxdubrav",
    ]) {
      const evidence = fixture();
      evidence.target.supabase_ref = projectRef;
      assert.throws(
        () => verifyAuthenticatedRestoreEvidence(evidence),
        /durable or previously used target/,
      );
    }
  });

  it("rejects durable application destinations", () => {
    const evidence = fixture();
    evidence.target.backend_api = "https://api.koaryu.app/api/v1";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(evidence), /durable Koaryu destination/);
  });

  it("requires a short-lived disposable, operator-restricted target", () => {
    const nonDisposable = fixture();
    nonDisposable.target.disposable = false;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(nonDisposable), /disposable must be true/);

    const broadAccess = fixture();
    broadAccess.target.named_operator_access_only = false;
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(broadAccess),
      /named_operator_access_only must be true/,
    );

    const longLived = fixture();
    longLived.target.destroy_by = "2026-07-28T18:30:00Z";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(longLived), /must not exceed eight hours/);
  });

  it("requires target-only Auth, migration, Realtime, and Storage configuration", () => {
    for (const [name, value, pattern] of [
      ["target_specific_keys", false, /Target-specific keys/],
      ["source_credentials_reused", true, /Source credentials must never be reused/],
      [
        "source_sessions_cleared_before_exposure",
        false,
        /source sessions must be cleared/,
      ],
      ["migration_history_restored", false, /migration_history_restored/],
      ["auth_semantics_compared", false, /auth_semantics_compared/],
      ["realtime_semantics_compared", false, /realtime_semantics_compared/],
      ["storage_semantics_compared", false, /storage_semantics_compared/],
    ]) {
      const evidence = fixture();
      evidence.target.configuration[name] = value;
      assert.throws(() => verifyAuthenticatedRestoreEvidence(evidence), pattern);
    }
  });

  it("requires the exact deny-by-default outbound channel set", () => {
    const missingChannel = fixture();
    missingChannel.outbound.channels.pop();
    assert.throws(() => verifyAuthenticatedRestoreEvidence(missingChannel), /missing: telemetry/);

    const enabledWebhook = fixture();
    const webhook = enabledWebhook.outbound.channels.find(
      (channel) => channel.id === "platform_webhook",
    );
    webhook.mode = "sink";
    webhook.destination = "https://webhook-sink.example.invalid";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(enabledWebhook), /must be blocked/);
  });

  it("requires test Stripe posture with all outbound mutation blocked", () => {
    const liveMode = fixture();
    liveMode.outbound.stripe_mode = "live";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(liveMode), /stripe_mode must be test/);

    const billingEnabled = fixture();
    billingEnabled.outbound.live_billing_enabled = true;
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(billingEnabled),
      /live_billing_enabled must be false/,
    );

    const stripeMutation = fixture();
    const stripe = stripeMutation.outbound.channels.find(
      (channel) => channel.id === "stripe_mutation",
    );
    stripe.mode = "sink";
    stripe.destination = "https://stripe-sink.example.invalid";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(stripeMutation), /must be blocked/);
  });

  it("requires the exact five-state lifecycle and monotonic timing", () => {
    const missingDestroyed = fixture();
    missingDestroyed.state_history.pop();
    assert.throws(() => verifyAuthenticatedRestoreEvidence(missingDestroyed), /all five states/);

    const outOfOrder = fixture();
    outOfOrder.state_history[2].at = "2026-07-27T18:07:00Z";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(outOfOrder), /must be monotonic/);
  });

  it("requires exact elapsed time inside the four-hour RTO", () => {
    const wrongElapsed = fixture();
    wrongElapsed.exercise.elapsed_seconds = 1799;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(wrongElapsed), /exactly match/);

    const overRto = fixture();
    overRto.exercise.rto_limit_seconds = 1200;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(overRto), /exceeded its recorded RTO/);
  });

  it("requires the complete encrypted artifact set with exact digests and sizes", () => {
    const missingArtifact = fixture();
    missingArtifact.identity.artifacts.pop();
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(missingArtifact),
      /restore-integrity-manifest\.json\.gpg/,
    );

    const badDigest = fixture();
    badDigest.identity.artifacts[0].observed_sha256 =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(badDigest), /digest does not match/);

    const badSize = fixture();
    badSize.identity.artifacts[0].observed_size_bytes += 1;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(badSize), /byte size does not match/);
  });

  it("requires provider and application readbacks to match the exact candidate SHA", () => {
    const evidence = fixture();
    evidence.identity.application.backend_reported_sha =
      "fedcba9876543210fedcba9876543210fedcba98";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(evidence), /does not match expected_sha/);
  });

  it("requires exact migration head and full-history digest", () => {
    const wrongHead = fixture();
    wrongHead.identity.migration.actual_head =
      "20260727100000_atomic_studio_comp_management.sql";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(wrongHead), /Migration head does not match/);

    const wrongHistory = fixture();
    wrongHistory.identity.migration.actual_history_sha256 =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(wrongHistory),
      /Migration-history digest does not match/,
    );
  });

  it("requires all controlled synthetic actor aliases and exact roles", () => {
    const missingActor = fixture();
    missingActor.actors.pop();
    assert.throws(() => verifyAuthenticatedRestoreEvidence(missingActor), /missing: revoked_a/);

    const wrongRole = fixture();
    wrongRole.actors.find((actor) => actor.alias === "instructor_a").role = "admin";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(wrongRole), /wrong role/);
  });

  it("requires the complete authentication and application path matrix", () => {
    const evidence = fixture();
    evidence.application_checks = evidence.application_checks.filter(
      (check) => check.id !== "auth.admin_a.me.frontend",
    );
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(evidence),
      /missing: auth\.admin_a\.me\.frontend/,
    );
  });

  it("requires exact allow and deny status semantics", () => {
    const crossTenant = fixture();
    applicationCheck(crossTenant, "tenant.admin_a.cross_tenant.read").actual_status = 403;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(crossTenant), /returned the wrong status/);

    const roleDenied = fixture();
    applicationCheck(roleDenied, "role.instructor_a.manage_roster.denied").actual_outcome =
      "allow";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(roleDenied), /produced the wrong outcome/);
  });

  it("requires denied requests to be non-disclosing and non-mutating", () => {
    const mutation = fixture();
    applicationCheck(mutation, "tenant.admin_a.cross_tenant.write").mutation_after_sha256 =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(mutation), /unexpectedly mutated/);

    const audit = fixture();
    applicationCheck(audit, "role.front_desk_a.manage_staff.denied").audit_rows_after = 1;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(audit), /wrong audit-row delta/);

    const disclosure = fixture();
    applicationCheck(disclosure, "tenant.admin_a.cross_tenant.read").foreign_existence_disclosed =
      true;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(disclosure), /disclosed foreign existence/);
  });

  it("requires the allowed attendance probe to mutate and audit exactly once", () => {
    const unchanged = fixture();
    const attendance = applicationCheck(unchanged, "role.instructor_a.take_attendance");
    attendance.mutation_after_sha256 = attendance.mutation_before_sha256;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(unchanged), /did not perform/);

    const noAudit = fixture();
    applicationCheck(noAudit, "role.instructor_a.take_attendance").audit_rows_after = 0;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(noAudit), /wrong audit-row delta/);
  });

  it("rejects raw PII, credentials, JWTs, and captured response data", () => {
    const email = fixture();
    email.exercise.operator_alias = "person@example.com";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(email), /email address/);

    const credential = fixture();
    credential.fixture_secret = "not-allowed";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(credential), /fixture_secret|not part/);

    const response = fixture();
    applicationCheck(response, "auth.admin_a.me.direct").response_body_captured = true;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(response), /must not capture response bodies/);
  });

  it("requires an exact private Storage inventory and byte comparison", () => {
    const publicBucket = fixture();
    publicBucket.storage.private = false;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(publicBucket), /must remain private/);

    const bucketDrift = fixture();
    bucketDrift.storage.restored_inventory.observed_bucket_configuration_sha256 =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(bucketDrift), /configuration does not match/);

    const byteDrift = fixture();
    byteDrift.storage.synthetic_probe.downloaded_sha256 =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(byteDrift), /not recovered byte-for-byte/);
  });

  it("requires same-tenant allow plus anonymous and cross-tenant Storage denials", () => {
    const missingDeny = fixture();
    missingDeny.storage.synthetic_probe.checks = missingDeny.storage.synthetic_probe.checks.filter(
      (check) => check.id !== "storage.synthetic.cross_tenant.read",
    );
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(missingDeny),
      /missing: storage\.synthetic\.cross_tenant\.read/,
    );

    const wrongStatus = fixture();
    storageCheck(wrongStatus, "storage.synthetic.anonymous.read").actual_status = 200;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(wrongStatus), /returned the wrong status/);
  });

  it("requires complete relation counts and primary-key digests", () => {
    const countDrift = fixture();
    relation(countDrift, "public.students").actual_rows += 1;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(countDrift), /row count does not match/);

    const digestDrift = fixture();
    relation(digestDrift, "auth.users").actual_pk_set_sha256 =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(digestDrift),
      /primary-key-set digest does not match/,
    );

    const missingCritical = fixture();
    relation(missingCritical, "auth.sessions").name = "public.extra_fixture_relation";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(missingCritical), /missing auth\.sessions/);
  });

  it("requires exact structure and zero relationship violations", () => {
    const policyDrift = fixture();
    policyDrift.integrity.structural_digests.find(
      (item) => item.id === "rls_policies",
    ).actual_sha256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(policyDrift), /structural digest does not match/);

    const orphan = fixture();
    orphan.integrity.relationship_checks.find(
      (item) => item.id === "attendance_students_sessions",
    ).actual_violations = 1;
    assert.throws(() => verifyAuthenticatedRestoreEvidence(orphan), /relationship violations/);
  });

  it("requires provider readback for every declared resource", () => {
    const missingReadback = fixture();
    missingReadback.cleanup.provider_readbacks.pop();
    assert.throws(() => verifyAuthenticatedRestoreEvidence(missingReadback), /cover every declared/);

    const resourcePresent = fixture();
    resourcePresent.cleanup.provider_readbacks[0].observed_state = "active";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(resourcePresent), /still exists after cleanup/);
  });

  it("requires all synthetic mutations and local plaintext to be absent", () => {
    const missingMutation = fixture();
    missingMutation.cleanup.temporary_mutations.pop();
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(missingMutation),
      /storage\.synthetic_probe/,
    );

    const plaintextPresent = fixture();
    plaintextPresent.cleanup.local_artifacts.find(
      (item) => item.id === "plaintext_restore_directory",
    ).observed_state = "present";
    assert.throws(() => verifyAuthenticatedRestoreEvidence(plaintextPresent), /cleanup state is not complete/);
  });

  it("requires credential, session, callback, staging, and log cleanup", () => {
    for (const [name, value, pattern] of [
      ["credentials_revoked", false, /credentials must be revoked/i],
      ["sessions_revoked", false, /sessions must be revoked/i],
      ["callback_removed", false, /callback must be removed/i],
      ["ordinary_staging_production_rows_delta", 1, /must not gain production-derived rows/],
      ["logs_pii_scan", "failed", /PII scan must pass/],
    ]) {
      const evidence = fixture();
      evidence.cleanup[name] = value;
      assert.throws(() => verifyAuthenticatedRestoreEvidence(evidence), pattern);
    }
  });

  it("requires production-derived approvals, provider-origin input, and provider API cleanup", () => {
    const missingApprovals = fixture();
    missingApprovals.exercise.mode = "approved_production_derived";
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(missingApprovals),
      /offsite-artifact-access/,
    );

    const productionDerived = fixture();
    productionDerived.exercise.mode = "approved_production_derived";
    productionDerived.exercise.approval_refs = [
      "offsite-artifact-access",
      "production-derived-restore",
      "disposable-provider-resources",
    ];
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(productionDerived),
      /provider-origin download/,
    );

    productionDerived.identity.provider_origin_download = true;
    assert.throws(
      () => verifyAuthenticatedRestoreEvidence(productionDerived),
      /must use provider_api cleanup evidence/,
    );

    for (const readback of productionDerived.cleanup.provider_readbacks) {
      readback.method = "provider_api";
    }
    const result = verifyAuthenticatedRestoreEvidence(productionDerived, {
      requireProductionDerived: true,
    });
    assert.equal(result.mode, "approved_production_derived");
  });
});
