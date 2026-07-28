#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INVENTORY_PATH = resolve(ROOT, "docs/supabase-control-inventory.json");
const MANAGEMENT_API = "https://api.supabase.com";

export const REQUIRED_CONTROL_IDS = [
  "project_health",
  "auth_public_sign_in",
  "auth_password_security",
  "auth_session_tokens",
  "auth_session_limits",
  "auth_revocation",
  "auth_mfa",
  "auth_attack_protection",
  "auth_rate_limits",
  "auth_audit_access",
  "backup_entitlement",
  "backup_inventory",
  "backup_retention",
  "backup_pitr",
  "backup_restore_access",
  "backup_restore_test",
  "backup_logical_copy",
];

const VALID_STATUSES = new Set(["verified", "tested", "gap", "blocked", "not_applicable"]);
const REQUIRED_ENVIRONMENTS = ["production", "staging"];
const REQUIRED_CONTROL_FIELDS = [
  "status",
  "owner",
  "reviewed_at",
  "review_cadence_days",
  "operation_cadence",
  "evidence",
  "current_state",
  "target_state",
  "compensating_controls",
  "next_action",
  "approval_required",
];
const SAFE_AUTH_FIELDS = new Set([
  "disable_signup",
  "external_email_enabled",
  "jwt_exp",
  "mailer_autoconfirm",
  "mailer_otp_exp",
  "mailer_otp_max_frequency",
  "mfa_phone_enroll_enabled",
  "mfa_phone_verify_enabled",
  "mfa_totp_enroll_enabled",
  "mfa_totp_verify_enabled",
  "password_hibp_enabled",
  "password_min_length",
  "password_required_characters",
  "security_captcha_enabled",
  "security_captcha_provider",
  "security_manual_linking_enabled",
  "security_refresh_token_reuse_interval",
  "security_refresh_token_rotation_enabled",
  "security_update_password_require_reauthentication",
  "sessions_inactivity_timeout",
  "sessions_single_per_user",
  "sessions_timebox",
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function ageDays(timestamp, now) {
  return (now.getTime() - Date.parse(timestamp)) / 86_400_000;
}

function controlPrefix(environment, controlId) {
  return `${environment}.controls.${controlId}`;
}

export function validateInventory(inventory, { now = new Date() } = {}) {
  const failures = [];
  if (inventory?.schema_version !== 1) {
    failures.push("schema_version must equal 1");
  }
  if (!isNonEmptyString(inventory?.inventory_id)) {
    failures.push("inventory_id is required");
  }
  if (!isNonEmptyString(inventory?.owner)) {
    failures.push("owner is required");
  }
  if (!isIsoTimestamp(inventory?.reviewed_at)) {
    failures.push("reviewed_at must be an ISO 8601 timestamp");
  }
  if (!isNonEmptyString(inventory?.approval_packet)) {
    failures.push("approval_packet is required");
  }

  for (const environment of REQUIRED_ENVIRONMENTS) {
    const entry = inventory?.environments?.[environment];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      failures.push(`environments.${environment} is required`);
      continue;
    }
    if (!/^[a-z0-9]{20}$/.test(entry.project_ref ?? "")) {
      failures.push(`environments.${environment}.project_ref must be a Supabase project ref`);
    }
    if (!entry.live_baseline || typeof entry.live_baseline !== "object") {
      failures.push(`environments.${environment}.live_baseline is required`);
    } else {
      if (!isNonEmptyString(entry.live_baseline.project_status)) {
        failures.push(
          `environments.${environment}.live_baseline.project_status must be non-empty`,
        );
      }
      if (!isNonEmptyString(entry.live_baseline.region)) {
        failures.push(`environments.${environment}.live_baseline.region must be non-empty`);
      }
      if (
        !Number.isInteger(entry.live_baseline.backup_count)
        || entry.live_baseline.backup_count < 0
      ) {
        failures.push(
          `environments.${environment}.live_baseline.backup_count must be non-negative`,
        );
      }
      for (const field of ["pitr_enabled", "walg_enabled"]) {
        if (typeof entry.live_baseline[field] !== "boolean") {
          failures.push(
            `environments.${environment}.live_baseline.${field} must be boolean`,
          );
        }
      }
    }

    const controls = entry.controls;
    if (!controls || typeof controls !== "object" || Array.isArray(controls)) {
      failures.push(`environments.${environment}.controls is required`);
      continue;
    }
    const unexpected = Object.keys(controls).filter(
      (controlId) => !REQUIRED_CONTROL_IDS.includes(controlId),
    );
    if (unexpected.length > 0) {
      failures.push(
        `environments.${environment}.controls has unexpected control(s): ${unexpected.join(", ")}`,
      );
    }

    for (const controlId of REQUIRED_CONTROL_IDS) {
      const control = controls[controlId];
      const prefix = controlPrefix(environment, controlId);
      if (!control || typeof control !== "object" || Array.isArray(control)) {
        failures.push(`${prefix} is required`);
        continue;
      }
      for (const field of REQUIRED_CONTROL_FIELDS) {
        if (!(field in control)) {
          failures.push(`${prefix}.${field} is required`);
        }
      }
      if (!VALID_STATUSES.has(control.status)) {
        failures.push(`${prefix}.status is invalid`);
      }
      if (!isNonEmptyString(control.owner)) {
        failures.push(`${prefix}.owner must name an owner`);
      }
      if (!isIsoTimestamp(control.reviewed_at)) {
        failures.push(`${prefix}.reviewed_at must be an ISO 8601 timestamp`);
      }
      if (
        !Number.isInteger(control.review_cadence_days)
        || control.review_cadence_days < 1
        || control.review_cadence_days > 365
      ) {
        failures.push(`${prefix}.review_cadence_days must be between 1 and 365`);
      } else if (
        isIsoTimestamp(control.reviewed_at)
        && ageDays(control.reviewed_at, now) > control.review_cadence_days
      ) {
        failures.push(
          `${prefix} is stale (${control.review_cadence_days}-day review cadence)`,
        );
      }
      for (const field of ["operation_cadence", "current_state", "target_state", "next_action"]) {
        if (!isNonEmptyString(control[field])) {
          failures.push(`${prefix}.${field} must be non-empty`);
        }
      }
      for (const field of ["evidence", "compensating_controls"]) {
        if (
          !Array.isArray(control[field])
          || control[field].length === 0
          || control[field].some((value) => !isNonEmptyString(value))
        ) {
          failures.push(`${prefix}.${field} must contain non-empty entries`);
        }
      }
      if (typeof control.approval_required !== "boolean") {
        failures.push(`${prefix}.approval_required must be boolean`);
      }
      if (["gap", "blocked"].includes(control.status) && control.approval_required !== true) {
        failures.push(`${prefix} must remain approval-gated while ${control.status}`);
      }
      if (control.status === "blocked" && !isNonEmptyString(control.blocker)) {
        failures.push(`${prefix}.blocker is required for blocked evidence`);
      }
    }
  }
  const projectRefs = REQUIRED_ENVIRONMENTS
    .map((environment) => inventory?.environments?.[environment]?.project_ref)
    .filter(Boolean);
  if (new Set(projectRefs).size !== projectRefs.length) {
    failures.push("production and staging project refs must be distinct");
  }
  return failures;
}

export function sanitizeAuthConfig(config) {
  const sanitized = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (SAFE_AUTH_FIELDS.has(key) || key.startsWith("rate_limit_")) {
      if (
        value === null
        || ["string", "number", "boolean"].includes(typeof value)
      ) {
        sanitized[key] = value;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(sanitized).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function backupTimestamp(backup) {
  for (const field of ["completed_at", "inserted_at", "created_at", "timestamp"]) {
    if (isIsoTimestamp(backup?.[field])) {
      return backup[field];
    }
  }
  return null;
}

export function sanitizeBackupInventory(response) {
  const backups = Array.isArray(response?.backups) ? response.backups : [];
  const timestamps = backups.map(backupTimestamp).filter(Boolean).sort();
  return {
    backup_count: backups.length,
    earliest_backup_at: timestamps[0] ?? null,
    latest_backup_at: timestamps.at(-1) ?? null,
    pitr_enabled: response?.pitr_enabled === true,
    region: isNonEmptyString(response?.region) ? response.region : null,
    walg_enabled: response?.walg_enabled === true,
  };
}

async function fetchJson(fetchImpl, url, token, label) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function collectLiveInventory(
  inventory,
  {
    token,
    fetchImpl = fetch,
    checkedAt = new Date().toISOString(),
    managementApi = MANAGEMENT_API,
  } = {},
) {
  if (!isNonEmptyString(token)) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required for --live");
  }
  const projectsResponse = await fetchJson(
    fetchImpl,
    `${managementApi}/v1/projects`,
    token,
    "project inventory",
  );
  const projects = Array.isArray(projectsResponse) ? projectsResponse : projectsResponse?.projects;
  if (!Array.isArray(projects)) {
    throw new Error("project inventory returned an unexpected shape");
  }

  const results = [];
  const drift = [];
  for (const environment of REQUIRED_ENVIRONMENTS) {
    const declared = inventory.environments[environment];
    const project = projects.find((candidate) => {
      const ref = candidate?.ref ?? candidate?.id;
      return ref === declared.project_ref;
    });
    if (!project) {
      drift.push(`${environment}: declared project is missing from provider inventory`);
      continue;
    }
    const [authConfig, backupsResponse] = await Promise.all([
      fetchJson(
        fetchImpl,
        `${managementApi}/v1/projects/${declared.project_ref}/config/auth`,
        token,
        `${environment} Auth configuration`,
      ),
      fetchJson(
        fetchImpl,
        `${managementApi}/v1/projects/${declared.project_ref}/database/backups`,
        token,
        `${environment} backup inventory`,
      ),
    ]);
    const backups = sanitizeBackupInventory(backupsResponse);
    const result = {
      environment,
      project_ref: declared.project_ref,
      project_status: project.status ?? null,
      region: project.region ?? backups.region,
      backups,
      auth: sanitizeAuthConfig(authConfig),
    };
    results.push(result);

    for (const [field, actual] of [
      ["project_status", result.project_status],
      ["region", result.region],
      ["pitr_enabled", backups.pitr_enabled],
      ["backup_count", backups.backup_count],
      ["walg_enabled", backups.walg_enabled],
    ]) {
      const expected = declared.live_baseline[field];
      if (actual !== expected) {
        drift.push(
          `${environment}: ${field} drifted (recorded ${JSON.stringify(expected)}, provider ${JSON.stringify(actual)})`,
        );
      }
    }
  }
  return { checked_at: checkedAt, projects: results, drift };
}

function loadInventory() {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

async function main() {
  const inventory = loadInventory();
  const failures = validateInventory(inventory);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`Supabase control inventory check failed: ${failure}`);
    }
    return 1;
  }

  if (process.argv.includes("--live")) {
    let live;
    try {
      live = await collectLiveInventory(inventory, {
        token: process.env.SUPABASE_ACCESS_TOKEN,
      });
    } catch (error) {
      console.error(
        `Supabase live control check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    console.log(JSON.stringify(live, null, 2));
    if (live.drift.length > 0) {
      for (const finding of live.drift) {
        console.error(`Supabase live control drift: ${finding}`);
      }
      return 1;
    }
    console.log("Supabase live control readback matched the recorded safe baseline.");
    return 0;
  }

  console.log(
    `Supabase control inventory is complete and current (${REQUIRED_CONTROL_IDS.length} controls per environment).`,
  );
  return 0;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  process.exitCode = await main();
}
