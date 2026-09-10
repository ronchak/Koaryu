// Release identities are authored here. Counts and pending lists come from the
// selected candidate's ordered migration history, never from relative slices.
export const PENDING_HISTORY_START = "20260727100000";
export const CURRENT_RELEASE = "v41";

// id, migration head, full preflight version, public manifest version.
// Schedule V25 and Payments V25 are distinct database states.
const identities = [
  ["v7", "20260801131844", 2, 7],
  ["v8", "20260814043325", 2, 8],
  ["v9", "20260814103046", 2, 9],
  ["v10", "20260814105424", 2, 10],
  ["v11", "20260814114500", 2, 11],
  ["v12", "20260814152000", 2, 12],
  ["v13", "20260814170000", 2, 13],
  ["v14", "20260814183000", 2, 14],
  ["v15", "20260814200000", 2, 15],
  ["v16", "20260814213000", 3, 16],
  ["v17", "20260815220402", 3, 17],
  ["v18", "20260816012723", 3, 18],
  ["v19", "20260820012533", 4, 19],
  ["v20", "20260820025759", 4, 20],
  ["v21", "20260820060216", 4, 21],
  ["v22", "20260822193000", 4, 22],
  ["v23", "20260823193155", 4, 23],
  ["v24", "20260824190500", 4, 24],
  ["schedule-v25", "20260825043911", 5, 25],
  ["v25", "20260826030234", 6, 25],
  ["v26", "20260826030249", 7, 26],
  ["v27", "20260826051527", 8, 27],
  ["v28", "20260826073728", 9, 28],
  ["v29", "20260826102840", 10, 29],
  ["v30", "20260826155911", 11, 30],
  ["v31", "20260826185651", 12, 31],
  ["v32", "20260830065627", 13, 32],
  ["v33", "20260830082610", 14, 33],
  ["v34", "20260830151714", 15, 34],
  ["v35", "20260831022021", 16, 35],
  ["v36", "20260831054918", 17, 36],
  ["v37", "20260902001000", 18, 37],
  ["v38", "20260905022339", 19, 38],
  ["v39", "20260908080420", 20, 39],
  ["v40", "20260908133504", 21, 40],
  ["v41", "20260908183744", 22, 41],
];

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
