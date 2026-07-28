#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = 1;
const MAX_RTO_SECONDS = 4 * 60 * 60;
const MAX_TARGET_LIFETIME_SECONDS = 8 * 60 * 60;

const FORBIDDEN_PROJECT_REFS = new Set([
  "mimguepumzsgmcaycdsh",
  "nxgsektqsgrtyfhawxbc",
  "zmmacdleiaohvxdubrav",
]);
const FORBIDDEN_HOSTS = new Set([
  "koaryu.app",
  "www.koaryu.app",
  "koaryu.onrender.com",
  "koaryu-staging.onrender.com",
  "koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app",
]);
const REQUIRED_APPROVAL_REFS = new Set([
  "offsite-artifact-access",
  "production-derived-restore",
  "disposable-provider-resources",
]);
const REQUIRED_OUTBOUND_CHANNELS = new Set([
  "email",
  "sms",
  "stripe_mutation",
  "platform_webhook",
  "connect_webhook",
  "telemetry",
]);
const REQUIRED_ARTIFACTS = new Set([
  "roles.sql.gpg",
  "schema.sql.gpg",
  "data.sql.gpg",
  "record-classification-manifest.json.gpg",
  "migration-history.sql.gpg",
  "storage-objects.tar.gpg",
  "backup-manifest.json.gpg",
  "restore-integrity-manifest.json.gpg",
]);
const REQUIRED_ACTORS = new Map([
  ["admin_a", { tenant: "tenant_a", role: "admin" }],
  ["admin_b", { tenant: "tenant_b", role: "admin" }],
  ["front_desk_a", { tenant: "tenant_a", role: "front_desk" }],
  ["instructor_a", { tenant: "tenant_a", role: "instructor" }],
  ["no_membership", { tenant: null, role: null }],
  ["revoked_a", { tenant: "tenant_a", role: "instructor" }],
]);
const REQUIRED_RELATIONS = new Set([
  "public.studios",
  "public.staff_roles",
  "public.students",
  "public.guardians",
  "public.attendance",
  "public.class_sessions",
  "public.leads",
  "auth.users",
  "auth.identities",
  "auth.sessions",
  "storage.buckets",
  "storage.objects",
  "supabase_migrations.schema_migrations",
]);
const REQUIRED_STRUCTURAL_DIGESTS = new Set([
  "schema_inventory",
  "function_definitions_acl",
  "triggers",
  "rls_policies",
  "extensions",
  "realtime_publications",
  "migration_history",
]);
const REQUIRED_RELATIONSHIP_CHECKS = new Set([
  "staff_roles_users",
  "students_studios",
  "attendance_students_sessions",
  "storage_objects_buckets",
]);
const REQUIRED_TEMPORARY_MUTATIONS = new Set([
  "auth.admin_a",
  "auth.admin_b",
  "auth.front_desk_a",
  "auth.instructor_a",
  "auth.no_membership",
  "auth.revoked_a",
  "public.tenant_a",
  "public.tenant_b",
  "public.attendance_probe",
  "storage.synthetic_probe",
]);
const REQUIRED_LOCAL_CLEANUP = new Map([
  ["plaintext_restore_directory", "absent"],
  ["provider_download_directory", "absent"],
  ["temporary_cli_workdir", "absent"],
  ["credential_environment", "cleared"],
]);

const APPLICATION_CHECK_CONTRACT = new Map(
  Object.entries({
    "auth.anonymous.me.direct": {
      actor: null,
      status: 401,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.anonymous.me.proxy": {
      actor: null,
      status: 401,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.admin_a.sign_in": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.admin_a.me.direct": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.admin_a.me.proxy": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.admin_a.me.frontend": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.source_access_token.rejected": {
      actor: null,
      status: 401,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.source_refresh_token.rejected": {
      actor: null,
      status: 400,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "auth.revoked_a.sign_in.rejected": {
      actor: "revoked_a",
      status: 400,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "tenant.admin_a.same_tenant.read.direct": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "tenant.admin_a.same_tenant.read.proxy": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "tenant.admin_a.same_tenant.read.frontend": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "tenant.admin_a.cross_tenant.read": {
      actor: "admin_a",
      status: 404,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "tenant.admin_a.cross_tenant.write": {
      actor: "admin_a",
      status: 404,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "role.admin_a.manage_staff": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "role.front_desk_a.read_roster": {
      actor: "front_desk_a",
      status: 200,
      outcome: "allow",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "role.front_desk_a.manage_staff.denied": {
      actor: "front_desk_a",
      status: 403,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "role.instructor_a.take_attendance": {
      actor: "instructor_a",
      status: 200,
      outcome: "allow",
      mutation: "changed",
      auditDelta: 1,
    },
    "role.instructor_a.manage_roster.denied": {
      actor: "instructor_a",
      status: 403,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
    "role.no_membership.read.denied": {
      actor: "no_membership",
      status: 404,
      outcome: "deny",
      mutation: "unchanged",
      auditDelta: 0,
    },
  }),
);

const STORAGE_CHECK_CONTRACT = new Map(
  Object.entries({
    "storage.synthetic.same_tenant.read": {
      actor: "admin_a",
      status: 200,
      outcome: "allow",
    },
    "storage.synthetic.anonymous.read": {
      actor: null,
      status: 401,
      outcome: "deny",
    },
    "storage.synthetic.cross_tenant.read": {
      actor: "admin_b",
      status: 404,
      outcome: "deny",
    },
  }),
);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectObject(value, path) {
  assert(isPlainObject(value), `${path} must be an object.`);
  return value;
}

function expectArray(value, path) {
  assert(Array.isArray(value), `${path} must be an array.`);
  return value;
}

function expectKeys(value, path, required, optional = []) {
  expectObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    assert(Object.hasOwn(value, key), `${path}.${key} is required.`);
  }
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${path}.${key} is not part of schema version ${SCHEMA_VERSION}.`);
  }
}

function expectString(value, path) {
  assert(typeof value === "string" && value.length > 0, `${path} must be a non-empty string.`);
  assert(value === value.trim(), `${path} must not contain surrounding whitespace.`);
  return value;
}

function expectNullableString(value, path) {
  if (value === null) {
    return null;
  }
  return expectString(value, path);
}

function expectBoolean(value, path) {
  assert(typeof value === "boolean", `${path} must be a boolean.`);
  return value;
}

function expectInteger(value, path, { minimum = 0 } = {}) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${path} must be an integer >= ${minimum}.`);
  return value;
}

function expectHash(value, path) {
  expectString(value, path);
  assert(/^[a-f0-9]{64}$/.test(value), `${path} must be a lowercase SHA-256 digest.`);
  return value;
}

function expectGitSha(value, path) {
  expectString(value, path);
  assert(/^[a-f0-9]{40}$/.test(value), `${path} must be a full lowercase 40-character Git SHA.`);
  return value;
}

function expectIsoTimestamp(value, path) {
  expectString(value, path);
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value),
    `${path} must be an ISO 8601 UTC timestamp with second precision.`,
  );
  const milliseconds = Date.parse(value);
  assert(Number.isFinite(milliseconds), `${path} must be a valid timestamp.`);
  return milliseconds;
}

function expectUrl(value, path, { api = false, origin = false } = {}) {
  expectString(value, path);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${path} must be a valid URL.`);
  }
  assert(parsed.protocol === "https:", `${path} must use HTTPS.`);
  assert(!parsed.username && !parsed.password, `${path} must not contain credentials.`);
  assert(!parsed.search && !parsed.hash, `${path} must not contain a query or fragment.`);
  const canonical = parsed.toString().replace(/\/$/, "");
  assert(value === canonical, `${path} must use canonical form without a trailing slash.`);
  if (api) {
    assert(parsed.pathname === "/api/v1", `${path} must end exactly at /api/v1.`);
  }
  if (origin) {
    assert(parsed.pathname === "/", `${path} must be an origin without a path.`);
  }
  assert(
    ![...FORBIDDEN_HOSTS].some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    ),
    `${path} resolves to a durable Koaryu destination.`,
  );
  for (const projectRef of FORBIDDEN_PROJECT_REFS) {
    assert(!value.includes(projectRef), `${path} contains a forbidden Supabase project ref.`);
  }
  return parsed;
}

function expectSetEquality(actualValues, expectedSet, path) {
  const actualSet = new Set(actualValues);
  assert(actualSet.size === actualValues.length, `${path} must not contain duplicates.`);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  assert(missing.length === 0, `${path} is missing: ${missing.join(", ")}.`);
  assert(extra.length === 0, `${path} contains unsupported values: ${extra.join(", ")}.`);
}

function rejectSensitiveEvidence(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveEvidence(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase();
      assert(
        normalized === "signed_url_captured" ||
        !/(^|_)(password|secret|credential|signed_url|token_value|raw_name|raw_email|raw_path|raw_row|raw_body)(_|$)/.test(
          normalized,
        ),
        `${path}.${key} is forbidden because restore evidence must not contain secrets or raw data.`,
      );
      rejectSensitiveEvidence(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  assert(
    !/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value),
    `${path} appears to contain an email address.`,
  );
  assert(
    !/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9_]+\b|\bwhsec_[A-Za-z0-9_]+\b|\bsb_secret_[A-Za-z0-9_]+\b/.test(
      value,
    ),
    `${path} appears to contain a provider credential.`,
  );
  assert(
    !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value),
    `${path} appears to contain a JWT.`,
  );
  assert(!/^Bearer\s+/i.test(value), `${path} appears to contain an authorization header.`);
}

function verifyExercise(evidence) {
  const exercise = evidence.exercise;
  expectKeys(exercise, "exercise", [
    "id",
    "mode",
    "operator_alias",
    "approval_refs",
    "started_at",
    "finished_at",
    "elapsed_seconds",
    "rto_limit_seconds",
  ]);
  const exerciseId = expectString(exercise.id, "exercise.id");
  assert(/^[a-z0-9][a-z0-9-]{7,63}$/.test(exerciseId), "exercise.id must be a safe opaque alias.");
  const mode = expectString(exercise.mode, "exercise.mode");
  assert(
    mode === "synthetic_fixture" || mode === "approved_production_derived",
    "exercise.mode must be synthetic_fixture or approved_production_derived.",
  );
  expectString(exercise.operator_alias, "exercise.operator_alias");
  const approvalRefs = expectArray(exercise.approval_refs, "exercise.approval_refs").map((value, index) =>
    expectString(value, `exercise.approval_refs[${index}]`),
  );
  assert(new Set(approvalRefs).size === approvalRefs.length, "exercise.approval_refs must be unique.");
  if (mode === "approved_production_derived") {
    for (const approval of REQUIRED_APPROVAL_REFS) {
      assert(
        approvalRefs.includes(approval),
        `exercise.approval_refs must include ${approval} for production-derived recovery.`,
      );
    }
  } else {
    assert(
      approvalRefs.every((approval) => approval.startsWith("fixture:")),
      "Synthetic fixture approval refs must be fixture-scoped.",
    );
  }

  const startedAt = expectIsoTimestamp(exercise.started_at, "exercise.started_at");
  const finishedAt = expectIsoTimestamp(exercise.finished_at, "exercise.finished_at");
  assert(finishedAt > startedAt, "exercise.finished_at must be after exercise.started_at.");
  const elapsedSeconds = expectInteger(exercise.elapsed_seconds, "exercise.elapsed_seconds", {
    minimum: 1,
  });
  assert(
    elapsedSeconds === (finishedAt - startedAt) / 1000,
    "exercise.elapsed_seconds must exactly match the recorded timestamps.",
  );
  const rtoLimit = expectInteger(exercise.rto_limit_seconds, "exercise.rto_limit_seconds", {
    minimum: 1,
  });
  assert(rtoLimit <= MAX_RTO_SECONDS, "exercise.rto_limit_seconds must not exceed four hours.");
  assert(elapsedSeconds <= rtoLimit, "The exercise exceeded its recorded RTO limit.");

  return { exerciseId, mode, startedAt, finishedAt, elapsedSeconds };
}

function verifyStateHistory(evidence, timing) {
  const expectedStates = ["prepared", "restored", "verified", "app_tested", "destroyed"];
  const stateHistory = expectArray(evidence.state_history, "state_history");
  assert(stateHistory.length === expectedStates.length, "state_history must contain all five states.");
  let priorAt = timing.startedAt;
  stateHistory.forEach((entry, index) => {
    expectKeys(entry, `state_history[${index}]`, ["state", "at", "outcome"]);
    assert(entry.state === expectedStates[index], `state_history[${index}].state must be ${expectedStates[index]}.`);
    assert(entry.outcome === "passed", `state_history[${index}].outcome must be passed.`);
    const at = expectIsoTimestamp(entry.at, `state_history[${index}].at`);
    assert(at >= priorAt, "state_history timestamps must be monotonic.");
    assert(at <= timing.finishedAt, "state_history timestamps must not exceed exercise.finished_at.");
    priorAt = at;
  });
}

function verifyTarget(evidence, timing) {
  const target = evidence.target;
  expectKeys(target, "target", [
    "classification",
    "disposable",
    "named_operator_access_only",
    "supabase_ref",
    "frontend_origin",
    "backend_api",
    "auth_site_url",
    "auth_redirect_allowlist",
    "created_at",
    "destroy_by",
    "provider_resources",
    "configuration",
  ]);
  assert(target.classification === "ephemeral_recovery", "target.classification must be ephemeral_recovery.");
  assert(expectBoolean(target.disposable, "target.disposable"), "target.disposable must be true.");
  assert(
    expectBoolean(target.named_operator_access_only, "target.named_operator_access_only"),
    "target.named_operator_access_only must be true.",
  );
  const projectRef = expectString(target.supabase_ref, "target.supabase_ref");
  assert(/^[a-z0-9]{20}$/.test(projectRef), "target.supabase_ref must be a 20-character project ref.");
  assert(!FORBIDDEN_PROJECT_REFS.has(projectRef), "target.supabase_ref is a durable or previously used target.");

  const frontend = expectUrl(target.frontend_origin, "target.frontend_origin", { origin: true });
  const backend = expectUrl(target.backend_api, "target.backend_api", { api: true });
  assert(frontend.hostname !== backend.hostname, "Frontend and backend must use separate target identities.");
  expectUrl(target.auth_site_url, "target.auth_site_url", { origin: true });
  assert(target.auth_site_url === target.frontend_origin, "target.auth_site_url must equal target.frontend_origin.");
  const redirects = expectArray(target.auth_redirect_allowlist, "target.auth_redirect_allowlist");
  assert(redirects.length === 1, "target.auth_redirect_allowlist must contain exactly one callback.");
  assert(
    redirects[0] === `${target.frontend_origin}/auth/callback`,
    "target.auth_redirect_allowlist must contain only the target callback.",
  );

  const createdAt = expectIsoTimestamp(target.created_at, "target.created_at");
  const destroyBy = expectIsoTimestamp(target.destroy_by, "target.destroy_by");
  assert(createdAt <= timing.startedAt, "target.created_at must not be after the exercise starts.");
  assert(destroyBy >= timing.finishedAt, "target.destroy_by must cover the full exercise.");
  assert(
    (destroyBy - createdAt) / 1000 <= MAX_TARGET_LIFETIME_SECONDS,
    "The disposable target lifetime must not exceed eight hours.",
  );

  const resources = expectArray(target.provider_resources, "target.provider_resources");
  assert(resources.length >= 3, "target.provider_resources must include Supabase, frontend, and backend.");
  const resourceKinds = [];
  const resourceIds = new Set();
  for (const [index, resource] of resources.entries()) {
    expectKeys(resource, `target.provider_resources[${index}]`, ["kind", "id", "ephemeral"]);
    const kind = expectString(resource.kind, `target.provider_resources[${index}].kind`);
    const id = expectString(resource.id, `target.provider_resources[${index}].id`);
    assert(!resourceIds.has(id), "target.provider_resources ids must be unique.");
    assert(resource.ephemeral === true, `target.provider_resources[${index}].ephemeral must be true.`);
    resourceKinds.push(kind);
    resourceIds.add(id);
  }
  for (const requiredKind of ["supabase_project", "frontend_deployment", "backend_deployment"]) {
    assert(resourceKinds.includes(requiredKind), `target.provider_resources must include ${requiredKind}.`);
  }

  const configuration = target.configuration;
  expectKeys(configuration, "target.configuration", [
    "target_specific_keys",
    "source_credentials_reused",
    "source_sessions_cleared_before_exposure",
    "migration_history_restored",
    "auth_semantics_compared",
    "realtime_semantics_compared",
    "storage_semantics_compared",
  ]);
  assert(configuration.target_specific_keys === true, "Target-specific keys are required.");
  assert(configuration.source_credentials_reused === false, "Source credentials must never be reused.");
  assert(
    configuration.source_sessions_cleared_before_exposure === true,
    "Restored source sessions must be cleared before application exposure.",
  );
  for (const name of [
    "migration_history_restored",
    "auth_semantics_compared",
    "realtime_semantics_compared",
    "storage_semantics_compared",
  ]) {
    assert(configuration[name] === true, `target.configuration.${name} must be true.`);
  }

  return { resources };
}

function verifyOutbound(evidence) {
  const outbound = evidence.outbound;
  expectKeys(outbound, "outbound", [
    "network_policy",
    "stripe_mode",
    "live_billing_enabled",
    "channels",
  ]);
  assert(outbound.network_policy === "deny_by_default", "outbound.network_policy must be deny_by_default.");
  assert(outbound.stripe_mode === "test", "outbound.stripe_mode must be test.");
  assert(outbound.live_billing_enabled === false, "outbound.live_billing_enabled must be false.");

  const channels = expectArray(outbound.channels, "outbound.channels");
  expectSetEquality(
    channels.map((channel) => channel.id),
    REQUIRED_OUTBOUND_CHANNELS,
    "outbound.channels",
  );
  for (const [index, channel] of channels.entries()) {
    expectKeys(channel, `outbound.channels[${index}]`, [
      "id",
      "mode",
      "destination",
      "target_scoped",
    ]);
    assert(channel.mode === "blocked" || channel.mode === "sink", `${channel.id} must be blocked or sink.`);
    assert(channel.target_scoped === true, `${channel.id} must be target-scoped.`);
    if (channel.mode === "blocked") {
      assert(channel.destination === null, `${channel.id} must not have a destination when blocked.`);
    } else {
      expectUrl(channel.destination, `outbound.channels[${index}].destination`);
    }
    if (["stripe_mutation", "platform_webhook", "connect_webhook"].includes(channel.id)) {
      assert(channel.mode === "blocked", `${channel.id} must be blocked for the recovery exercise.`);
    }
  }
}

function verifyIdentity(evidence, timing) {
  const identity = evidence.identity;
  expectKeys(identity, "identity", [
    "backup_set_id",
    "provider_origin_download",
    "provider_download_receipt_sha256",
    "downloaded_at",
    "artifacts",
    "application",
    "migration",
  ]);
  expectString(identity.backup_set_id, "identity.backup_set_id");
  const providerOrigin = expectBoolean(identity.provider_origin_download, "identity.provider_origin_download");
  if (timing.mode === "approved_production_derived") {
    assert(providerOrigin, "Production-derived recovery must use a provider-origin download.");
  } else {
    assert(!providerOrigin, "Synthetic fixtures must not claim a provider-origin production download.");
  }
  expectHash(identity.provider_download_receipt_sha256, "identity.provider_download_receipt_sha256");
  const downloadedAt = expectIsoTimestamp(identity.downloaded_at, "identity.downloaded_at");
  assert(downloadedAt <= timing.startedAt, "identity.downloaded_at must not be after the exercise starts.");

  const artifacts = expectArray(identity.artifacts, "identity.artifacts");
  expectSetEquality(
    artifacts.map((artifact) => artifact.name),
    REQUIRED_ARTIFACTS,
    "identity.artifacts",
  );
  for (const [index, artifact] of artifacts.entries()) {
    expectKeys(artifact, `identity.artifacts[${index}]`, [
      "name",
      "expected_sha256",
      "observed_sha256",
      "size_bytes",
      "observed_size_bytes",
    ]);
    assert(!artifact.name.includes("/"), `identity.artifacts[${index}].name must be a basename.`);
    expectHash(artifact.expected_sha256, `identity.artifacts[${index}].expected_sha256`);
    expectHash(artifact.observed_sha256, `identity.artifacts[${index}].observed_sha256`);
    assert(
      artifact.expected_sha256 === artifact.observed_sha256,
      `Artifact ${artifact.name} digest does not match.`,
    );
    expectInteger(artifact.size_bytes, `identity.artifacts[${index}].size_bytes`, { minimum: 1 });
    expectInteger(artifact.observed_size_bytes, `identity.artifacts[${index}].observed_size_bytes`, {
      minimum: 1,
    });
    assert(
      artifact.size_bytes === artifact.observed_size_bytes,
      `Artifact ${artifact.name} byte size does not match.`,
    );
  }

  const application = identity.application;
  expectKeys(application, "identity.application", [
    "expected_sha",
    "frontend_provider_sha",
    "frontend_reported_sha",
    "backend_provider_sha",
    "backend_reported_sha",
  ]);
  const expectedSha = expectGitSha(application.expected_sha, "identity.application.expected_sha");
  for (const name of [
    "frontend_provider_sha",
    "frontend_reported_sha",
    "backend_provider_sha",
    "backend_reported_sha",
  ]) {
    expectGitSha(application[name], `identity.application.${name}`);
    assert(application[name] === expectedSha, `identity.application.${name} does not match expected_sha.`);
  }

  const migration = identity.migration;
  expectKeys(migration, "identity.migration", [
    "expected_head",
    "actual_head",
    "expected_history_sha256",
    "actual_history_sha256",
  ]);
  expectString(migration.expected_head, "identity.migration.expected_head");
  assert(
    /^\d{14}_[a-z0-9_]+\.sql$/.test(migration.expected_head),
    "identity.migration.expected_head must be a timestamped migration filename.",
  );
  assert(migration.actual_head === migration.expected_head, "Migration head does not match.");
  expectHash(migration.expected_history_sha256, "identity.migration.expected_history_sha256");
  expectHash(migration.actual_history_sha256, "identity.migration.actual_history_sha256");
  assert(
    migration.expected_history_sha256 === migration.actual_history_sha256,
    "Migration-history digest does not match.",
  );
}

function verifyActors(evidence) {
  const actors = expectArray(evidence.actors, "actors");
  expectSetEquality(
    actors.map((actor) => actor.alias),
    new Set(REQUIRED_ACTORS.keys()),
    "actors",
  );
  for (const [index, actor] of actors.entries()) {
    expectKeys(actor, `actors[${index}]`, ["alias", "synthetic", "tenant_alias", "role"]);
    assert(actor.synthetic === true, `actors[${index}] must be synthetic.`);
    const expected = REQUIRED_ACTORS.get(actor.alias);
    assert(actor.tenant_alias === expected.tenant, `${actor.alias} has the wrong tenant alias.`);
    assert(actor.role === expected.role, `${actor.alias} has the wrong role.`);
  }
}

function verifyApplicationChecks(evidence) {
  const checks = expectArray(evidence.application_checks, "application_checks");
  expectSetEquality(
    checks.map((check) => check.id),
    new Set(APPLICATION_CHECK_CONTRACT.keys()),
    "application_checks",
  );
  for (const [index, check] of checks.entries()) {
    const path = `application_checks[${index}]`;
    expectKeys(check, path, [
      "id",
      "actor_alias",
      "expected_status",
      "actual_status",
      "expected_outcome",
      "actual_outcome",
      "response_body_captured",
      "pii_captured",
      "foreign_existence_disclosed",
      "mutation_before_sha256",
      "mutation_after_sha256",
      "audit_rows_before",
      "audit_rows_after",
    ]);
    const contract = APPLICATION_CHECK_CONTRACT.get(check.id);
    assert(check.actor_alias === contract.actor, `${check.id} has the wrong actor.`);
    assert(check.expected_status === contract.status, `${check.id} has the wrong expected status.`);
    assert(check.actual_status === contract.status, `${check.id} returned the wrong status.`);
    assert(check.expected_outcome === contract.outcome, `${check.id} has the wrong expected outcome.`);
    assert(check.actual_outcome === contract.outcome, `${check.id} produced the wrong outcome.`);
    assert(check.response_body_captured === false, `${check.id} must not capture response bodies.`);
    assert(check.pii_captured === false, `${check.id} must not capture PII.`);
    assert(check.foreign_existence_disclosed === false, `${check.id} disclosed foreign existence.`);
    expectHash(check.mutation_before_sha256, `${path}.mutation_before_sha256`);
    expectHash(check.mutation_after_sha256, `${path}.mutation_after_sha256`);
    if (contract.mutation === "unchanged") {
      assert(
        check.mutation_before_sha256 === check.mutation_after_sha256,
        `${check.id} unexpectedly mutated application data.`,
      );
    } else {
      assert(
        check.mutation_before_sha256 !== check.mutation_after_sha256,
        `${check.id} did not perform its required synthetic mutation.`,
      );
    }
    expectInteger(check.audit_rows_before, `${path}.audit_rows_before`);
    expectInteger(check.audit_rows_after, `${path}.audit_rows_after`);
    assert(
      check.audit_rows_after - check.audit_rows_before === contract.auditDelta,
      `${check.id} has the wrong audit-row delta.`,
    );
  }
}

function normalizeObjectInventory(objects, path) {
  const inventory = new Map();
  for (const [index, object] of expectArray(objects, path).entries()) {
    const itemPath = `${path}[${index}]`;
    expectKeys(object, itemPath, ["path_sha256", "content_sha256", "size_bytes"]);
    const pathHash = expectHash(object.path_sha256, `${itemPath}.path_sha256`);
    expectHash(object.content_sha256, `${itemPath}.content_sha256`);
    expectInteger(object.size_bytes, `${itemPath}.size_bytes`, { minimum: 1 });
    assert(!inventory.has(pathHash), `${path} contains a duplicate path digest.`);
    inventory.set(pathHash, `${object.content_sha256}:${object.size_bytes}`);
  }
  return inventory;
}

function verifyStorage(evidence) {
  const storage = evidence.storage;
  expectKeys(storage, "storage", ["bucket", "private", "restored_inventory", "synthetic_probe"]);
  assert(storage.bucket === "student-photos", "storage.bucket must be student-photos.");
  assert(storage.private === true, "The student-photos bucket must remain private.");

  const restored = storage.restored_inventory;
  expectKeys(restored, "storage.restored_inventory", [
    "expected_bucket_configuration_sha256",
    "observed_bucket_configuration_sha256",
    "expected_objects",
    "observed_objects",
  ]);
  expectHash(
    restored.expected_bucket_configuration_sha256,
    "storage.restored_inventory.expected_bucket_configuration_sha256",
  );
  expectHash(
    restored.observed_bucket_configuration_sha256,
    "storage.restored_inventory.observed_bucket_configuration_sha256",
  );
  assert(
    restored.expected_bucket_configuration_sha256 === restored.observed_bucket_configuration_sha256,
    "Storage bucket configuration does not match.",
  );
  const expectedObjects = normalizeObjectInventory(
    restored.expected_objects,
    "storage.restored_inventory.expected_objects",
  );
  const observedObjects = normalizeObjectInventory(
    restored.observed_objects,
    "storage.restored_inventory.observed_objects",
  );
  assert(expectedObjects.size === observedObjects.size, "Storage object counts do not match.");
  for (const [pathHash, identity] of expectedObjects) {
    assert(observedObjects.get(pathHash) === identity, "A restored Storage object does not match.");
  }

  const probe = storage.synthetic_probe;
  expectKeys(probe, "storage.synthetic_probe", [
    "actor_alias",
    "tenant_alias",
    "path_sha256",
    "uploaded_sha256",
    "downloaded_sha256",
    "size_bytes",
    "checks",
  ]);
  assert(probe.actor_alias === "admin_a", "storage.synthetic_probe must use admin_a.");
  assert(probe.tenant_alias === "tenant_a", "storage.synthetic_probe must stay in tenant_a.");
  expectHash(probe.path_sha256, "storage.synthetic_probe.path_sha256");
  expectHash(probe.uploaded_sha256, "storage.synthetic_probe.uploaded_sha256");
  expectHash(probe.downloaded_sha256, "storage.synthetic_probe.downloaded_sha256");
  assert(
    probe.uploaded_sha256 === probe.downloaded_sha256,
    "The synthetic Storage probe was not recovered byte-for-byte.",
  );
  expectInteger(probe.size_bytes, "storage.synthetic_probe.size_bytes", { minimum: 1 });

  const checks = expectArray(probe.checks, "storage.synthetic_probe.checks");
  expectSetEquality(
    checks.map((check) => check.id),
    new Set(STORAGE_CHECK_CONTRACT.keys()),
    "storage.synthetic_probe.checks",
  );
  for (const [index, check] of checks.entries()) {
    const path = `storage.synthetic_probe.checks[${index}]`;
    expectKeys(check, path, [
      "id",
      "actor_alias",
      "expected_status",
      "actual_status",
      "expected_outcome",
      "actual_outcome",
      "object_sha256",
      "signed_url_captured",
      "pii_captured",
    ]);
    const contract = STORAGE_CHECK_CONTRACT.get(check.id);
    assert(check.actor_alias === contract.actor, `${check.id} has the wrong actor.`);
    assert(check.expected_status === contract.status, `${check.id} has the wrong expected status.`);
    assert(check.actual_status === contract.status, `${check.id} returned the wrong status.`);
    assert(check.expected_outcome === contract.outcome, `${check.id} has the wrong expected outcome.`);
    assert(check.actual_outcome === contract.outcome, `${check.id} produced the wrong outcome.`);
    expectHash(check.object_sha256, `${path}.object_sha256`);
    assert(check.object_sha256 === probe.downloaded_sha256, `${check.id} checked the wrong object bytes.`);
    assert(check.signed_url_captured === false, `${check.id} must not capture a signed URL.`);
    assert(check.pii_captured === false, `${check.id} must not capture PII.`);
  }
}

function verifyIntegrity(evidence) {
  const integrity = evidence.integrity;
  expectKeys(integrity, "integrity", [
    "relation_inventory_expected_count",
    "relation_inventory_actual_count",
    "relations",
    "structural_digests",
    "relationship_checks",
  ]);
  const expectedCount = expectInteger(
    integrity.relation_inventory_expected_count,
    "integrity.relation_inventory_expected_count",
    { minimum: REQUIRED_RELATIONS.size },
  );
  const actualCount = expectInteger(
    integrity.relation_inventory_actual_count,
    "integrity.relation_inventory_actual_count",
    { minimum: REQUIRED_RELATIONS.size },
  );
  assert(expectedCount === actualCount, "Relation inventory counts do not match.");
  const relations = expectArray(integrity.relations, "integrity.relations");
  assert(relations.length === expectedCount, "integrity.relations must cover the full relation inventory.");
  const relationNames = new Set();
  for (const [index, relation] of relations.entries()) {
    const path = `integrity.relations[${index}]`;
    expectKeys(relation, path, [
      "name",
      "expected_rows",
      "actual_rows",
      "expected_pk_set_sha256",
      "actual_pk_set_sha256",
    ]);
    const name = expectString(relation.name, `${path}.name`);
    assert(!relationNames.has(name), "integrity.relations contains a duplicate relation.");
    relationNames.add(name);
    expectInteger(relation.expected_rows, `${path}.expected_rows`);
    expectInteger(relation.actual_rows, `${path}.actual_rows`);
    assert(relation.expected_rows === relation.actual_rows, `${name} row count does not match.`);
    expectHash(relation.expected_pk_set_sha256, `${path}.expected_pk_set_sha256`);
    expectHash(relation.actual_pk_set_sha256, `${path}.actual_pk_set_sha256`);
    assert(
      relation.expected_pk_set_sha256 === relation.actual_pk_set_sha256,
      `${name} primary-key-set digest does not match.`,
    );
  }
  for (const requiredRelation of REQUIRED_RELATIONS) {
    assert(relationNames.has(requiredRelation), `integrity.relations is missing ${requiredRelation}.`);
  }

  const structural = expectArray(integrity.structural_digests, "integrity.structural_digests");
  expectSetEquality(
    structural.map((item) => item.id),
    REQUIRED_STRUCTURAL_DIGESTS,
    "integrity.structural_digests",
  );
  for (const [index, item] of structural.entries()) {
    const path = `integrity.structural_digests[${index}]`;
    expectKeys(item, path, ["id", "expected_sha256", "actual_sha256"]);
    expectHash(item.expected_sha256, `${path}.expected_sha256`);
    expectHash(item.actual_sha256, `${path}.actual_sha256`);
    assert(item.expected_sha256 === item.actual_sha256, `${item.id} structural digest does not match.`);
  }

  const relationshipChecks = expectArray(integrity.relationship_checks, "integrity.relationship_checks");
  expectSetEquality(
    relationshipChecks.map((item) => item.id),
    REQUIRED_RELATIONSHIP_CHECKS,
    "integrity.relationship_checks",
  );
  for (const [index, item] of relationshipChecks.entries()) {
    const path = `integrity.relationship_checks[${index}]`;
    expectKeys(item, path, ["id", "expected_violations", "actual_violations"]);
    assert(item.expected_violations === 0, `${item.id} must expect zero violations.`);
    assert(item.actual_violations === 0, `${item.id} reported relationship violations.`);
  }
}

function verifyCleanup(evidence, timing, targetContext) {
  const cleanup = evidence.cleanup;
  expectKeys(cleanup, "cleanup", [
    "checked_at",
    "provider_readbacks",
    "temporary_mutations",
    "local_artifacts",
    "credentials_revoked",
    "sessions_revoked",
    "callback_removed",
    "ordinary_staging_production_rows_delta",
    "logs_pii_scan",
  ]);
  const checkedAt = expectIsoTimestamp(cleanup.checked_at, "cleanup.checked_at");
  assert(checkedAt <= timing.finishedAt, "cleanup.checked_at must not be after exercise.finished_at.");

  const readbacks = expectArray(cleanup.provider_readbacks, "cleanup.provider_readbacks");
  assert(
    readbacks.length === targetContext.resources.length,
    "cleanup.provider_readbacks must cover every declared provider resource.",
  );
  const readbacksById = new Map();
  for (const [index, readback] of readbacks.entries()) {
    const path = `cleanup.provider_readbacks[${index}]`;
    expectKeys(readback, path, [
      "kind",
      "id",
      "method",
      "observed_state",
      "observed_at",
      "evidence_sha256",
    ]);
    assert(!readbacksById.has(readback.id), "cleanup.provider_readbacks contains duplicate ids.");
    assert(readback.observed_state === "absent", `${readback.id} still exists after cleanup.`);
    const observedAt = expectIsoTimestamp(readback.observed_at, `${path}.observed_at`);
    assert(observedAt <= timing.finishedAt, `${readback.id} cleanup readback exceeds finished_at.`);
    expectHash(readback.evidence_sha256, `${path}.evidence_sha256`);
    const expectedMethod = timing.mode === "synthetic_fixture" ? "fixture_assertion" : "provider_api";
    assert(readback.method === expectedMethod, `${readback.id} must use ${expectedMethod} cleanup evidence.`);
    readbacksById.set(readback.id, readback);
  }
  for (const resource of targetContext.resources) {
    const readback = readbacksById.get(resource.id);
    assert(readback, `cleanup.provider_readbacks is missing ${resource.id}.`);
    assert(readback.kind === resource.kind, `${resource.id} cleanup kind does not match its declaration.`);
  }

  const temporaryMutations = expectArray(cleanup.temporary_mutations, "cleanup.temporary_mutations");
  expectSetEquality(
    temporaryMutations.map((item) => item.id),
    REQUIRED_TEMPORARY_MUTATIONS,
    "cleanup.temporary_mutations",
  );
  for (const [index, item] of temporaryMutations.entries()) {
    const path = `cleanup.temporary_mutations[${index}]`;
    expectKeys(item, path, ["id", "observed_state", "observed_at", "evidence_sha256"]);
    assert(item.observed_state === "absent", `${item.id} remains after synthetic-fixture cleanup.`);
    expectIsoTimestamp(item.observed_at, `${path}.observed_at`);
    expectHash(item.evidence_sha256, `${path}.evidence_sha256`);
  }

  const localArtifacts = expectArray(cleanup.local_artifacts, "cleanup.local_artifacts");
  expectSetEquality(
    localArtifacts.map((item) => item.id),
    new Set(REQUIRED_LOCAL_CLEANUP.keys()),
    "cleanup.local_artifacts",
  );
  for (const [index, item] of localArtifacts.entries()) {
    const path = `cleanup.local_artifacts[${index}]`;
    expectKeys(item, path, ["id", "observed_state", "observed_at", "evidence_sha256"]);
    assert(
      item.observed_state === REQUIRED_LOCAL_CLEANUP.get(item.id),
      `${item.id} cleanup state is not complete.`,
    );
    const observedAt = expectIsoTimestamp(item.observed_at, `${path}.observed_at`);
    assert(observedAt <= timing.finishedAt, `${item.id} cleanup readback exceeds finished_at.`);
    expectHash(item.evidence_sha256, `${path}.evidence_sha256`);
  }

  assert(cleanup.credentials_revoked === true, "Temporary credentials must be revoked.");
  assert(cleanup.sessions_revoked === true, "Temporary sessions must be revoked.");
  assert(cleanup.callback_removed === true, "The temporary Auth callback must be removed.");
  assert(
    cleanup.ordinary_staging_production_rows_delta === 0,
    "Ordinary staging must not gain production-derived rows.",
  );
  assert(cleanup.logs_pii_scan === "passed", "The sanitized log PII scan must pass.");
}

export function verifyAuthenticatedRestoreEvidence(evidence, { requireProductionDerived = false } = {}) {
  expectKeys(evidence, "evidence", [
    "schema_version",
    "exercise",
    "state_history",
    "target",
    "outbound",
    "identity",
    "actors",
    "application_checks",
    "storage",
    "integrity",
    "cleanup",
  ]);
  assert(evidence.schema_version === SCHEMA_VERSION, `schema_version must be ${SCHEMA_VERSION}.`);
  rejectSensitiveEvidence(evidence);

  const timing = verifyExercise(evidence);
  if (requireProductionDerived) {
    assert(
      timing.mode === "approved_production_derived",
      "Live acceptance requires approved_production_derived evidence; synthetic fixtures cannot close the gate.",
    );
  }
  verifyStateHistory(evidence, timing);
  const targetContext = verifyTarget(evidence, timing);
  verifyOutbound(evidence);
  verifyIdentity(evidence, timing);
  verifyActors(evidence);
  verifyApplicationChecks(evidence);
  verifyStorage(evidence);
  verifyIntegrity(evidence);
  verifyCleanup(evidence, timing, targetContext);

  return {
    schemaVersion: SCHEMA_VERSION,
    exerciseId: timing.exerciseId,
    mode: timing.mode,
    elapsedSeconds: timing.elapsedSeconds,
    applicationCheckCount: evidence.application_checks.length,
    relationCount: evidence.integrity.relations.length,
    cleanupReadbackCount: evidence.cleanup.provider_readbacks.length,
    finalState: evidence.state_history.at(-1).state,
  };
}

function parseArguments(argv) {
  let evidencePath = null;
  let requireProductionDerived = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") {
      evidencePath = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--require-production-derived") {
      requireProductionDerived = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  assert(evidencePath, "--evidence is required.");
  assert(isAbsolute(evidencePath), "--evidence must use an absolute path.");
  return { evidencePath, requireProductionDerived };
}

function main() {
  try {
    const { evidencePath, requireProductionDerived } = parseArguments(process.argv.slice(2));
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    const result = verifyAuthenticatedRestoreEvidence(evidence, { requireProductionDerived });
    if (result.mode === "synthetic_fixture") {
      console.log(
        `Synthetic restore contract verified (${result.applicationCheckCount} application checks, ` +
          `${result.relationCount} relations, ${result.cleanupReadbackCount} cleanup readbacks, ` +
          `${result.elapsedSeconds}s). This is not live recovery evidence.`,
      );
    } else {
      console.log(
        `Authenticated restore evidence verified for ${result.exerciseId} ` +
          `(${result.elapsedSeconds}s; final state ${result.finalState}).`,
      );
    }
  } catch (error) {
    console.error(`Authenticated restore verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
