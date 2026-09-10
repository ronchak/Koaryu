import declarations from "./release-states.json" with { type: "json" };

// Release identities are authored here. Counts and pending lists come from the
// selected candidate's ordered migration history, never from relative slices.
export const PENDING_HISTORY_START = "20260727100000";
export const CURRENT_RELEASE = declarations.current;

// id, migration head, full preflight version, public manifest version.
// Schedule V25 and Payments V25 are distinct database states.
const identities = declarations.identities;

export const RELEASE_STATES = Object.freeze(Object.fromEntries(
  identities.map(([id, head, preflight, manifest], index) => [id, Object.freeze({
    id,
    head,
    predecessor: identities[index - 1]?.[0] ?? null,
    preflight: `public.koaryu_release_schema_preflight_v${preflight}()`,
    manifestVersion: `release-db-attestation-v${manifest}`,
  })]),
));

export function migrationVersions(filenames) {
  const versions = filenames.map(filename => {
    const match = /^(\d{14})_[a-zA-Z0-9_]+\.sql$/.exec(filename);
    if (!match) throw new Error(`Invalid migration filename: ${filename}`);
    return match[1];
  }).sort();
  if (new Set(versions).size !== versions.length) {
    throw new Error("Migration history contains duplicate versions");
  }
  return versions;
}

export function releaseState(id, versions) {
  const declared = RELEASE_STATES[id];
  if (!declared) throw new Error(`Unknown release state: ${id}`);
  const index = versions.indexOf(declared.head);
  if (index < 0) throw new Error(`Missing release head: ${declared.head}`);
  if (!versions.includes(PENDING_HISTORY_START)) {
    throw new Error("Missing release pending-history boundary");
  }
  if (versions.some((value, offset) => !/^\d{14}$/.test(value)
      || (offset > 0 && versions[offset - 1] >= value))) {
    throw new Error("Release history must contain unique ordered versions");
  }
  const history = versions.slice(0, index + 1);
  return Object.freeze({
    ...declared,
    count: history.length,
    history: Object.freeze(history),
    pending: Object.freeze(history.filter(version => version >= PENDING_HISTORY_START)),
  });
}

export function readinessTuple(state, failures = []) {
  return [
    failures.length === 0 ? "true" : "false", state.count, state.head,
    state.pending.join(","), failures.length, failures.join(","), state.manifestVersion,
  ].join("|");
}
