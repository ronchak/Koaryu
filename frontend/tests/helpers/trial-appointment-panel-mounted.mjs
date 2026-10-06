import { mountLeadCreateFixture, flushLeadCreate } from "./lead-create-mounted.mjs";
import { LEAD, APPT, STUDIO, KEY } from "./trial-appointment-mounted.mjs";
export { LEAD, APPT, STUDIO, KEY };
export const OTHER = "30000000-0000-4000-8000-000000000002";
export const PROGRAM = "50000000-0000-4000-8000-000000000001";
export const flush = flushLeadCreate;

export function installTrialPanelFixture({ LEAD, OTHER, APPT, STUDIO, PROGRAM, rows }) {
  const f = window.f;
  f.rows = [LEAD, OTHER].map((id, index) =>
    f.createdRow({ id, first_name: index ? "Other" : "Sample", program_id: PROGRAM }),
  );
  f.trialRow = (changes = {}) => ({
    id: APPT,
    studio_id: STUDIO,
    lead_id: LEAD,
    program_id: PROGRAM,
    starts_at: "2030-01-01T12:00:00.123456Z",
    ends_at: "2030-01-01T13:00:00.123457Z",
    timezone: "UTC",
    location: "Sample room",
    status: "scheduled",
    revision: 1,
    created_by: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...changes,
  });
  f.appointments = rows.map((row) => f.trialRow(row));
  f.trialReads = [];
  f.trialReceipts = {};
  f.heldReads = [];
  const originalGet = f.api.get;
  f.api.get = async (path, token) => {
    if (path.startsWith("/programs") && f.programError)
      throw new f.ApiError("Private provider detail", 503);
    if (path.startsWith("/programs") && f.holdPrograms)
      return new Promise((resolve) => {
        f.finishPrograms = () => resolve(f.programs);
      });
    if (
      !path.includes("trial-appointments") &&
      !path.startsWith("/automations/operations/") &&
      !/^\/leads\/[^/]+$/.test(path)
    )
      return originalGet(path, token);
    f.trialReads.push({ path, token });
    const read = () => {
      if (path.includes("trial-appointments?")) {
        if (f.listError) throw new f.ApiError("Private provider detail", 503);
        if (f.listOverride) return structuredClone(f.listOverride);
        return {
          items: f.appointments.filter((row) => row.lead_id === path.split("/")[2]),
          has_more: false,
          next_cursor: null,
        };
      }
      if (path.includes("trial-appointments/")) {
        if (f.nullDetail) return null;
        if (f.detailError) throw new f.ApiError("Private provider detail", f.detailError);
        const row = f.appointments.find((row) => row.id === path.split("/").at(-1));
        if (!row) throw new f.ApiError("Not found", 404);
        return structuredClone(row);
      }
      if (path.startsWith("/automations/operations/")) {
        const receipt = f.trialReceipts[path.split("/").at(-1)];
        if (!receipt) throw new f.ApiError("Not found", 404);
        return structuredClone(receipt);
      }
      const row = f.rows.find((row) => row.id === path.split("/")[2]);
      if (!row) throw new f.ApiError("Not found", 404);
      return structuredClone(row);
    };
    if (
      (f.holdLists && path.includes("trial-appointments?")) ||
      (f.holdDetails && path.includes("trial-appointments/")) ||
      (f.holdLead && /^\/leads\/[^/]+$/.test(path))
    )
      return new Promise((resolve, reject) =>
        f.heldReads.push({
          path,
          resolve: () => {
            try {
              resolve(read());
            } catch (error) {
              reject(error);
            }
          },
        }),
      );
    return read();
  };
  f.commitTrial = (index, { lose = false, missing = false } = {}) => {
    const write = f.writes[index],
      body = JSON.parse(write.body),
      creating = write.method === "post";
    const previous = f.appointments.find((row) => row.id === write.path.split("/").at(-1));
    const { operation_id, expected_revision, ...changes } = body;
    const row = f.trialRow({
      ...(previous ?? {}),
      ...changes,
      lead_id: write.path.split("/")[2],
      revision: creating ? 1 : expected_revision + 1,
    });
    f.appointments = missing ? [] : [row, ...f.appointments.filter((item) => item.id !== row.id)];
    f.trialReceipts[operation_id] = {
      operation_id,
      command: creating ? "trial.create" : "trial.update",
      state: "committed",
      entity_type: "trial_appointment",
      entity_id: row.id,
      result: row,
      committed_at: "2026-10-05T00:00:00Z",
    };
    if (lose) write.reject(new f.Unknown());
    else write.resolve(row);
  };
  f.finishReads = () => {
    for (const held of f.heldReads.splice(0)) held.resolve();
  };
  f.trialLead = LEAD;
}

// Capture the accepted fixture's initialization and real component bundle. The
// adapter performs no browser I/O and changes none of its store/auth setup.
export async function buildTrialPanelFixture({ role = "admin", preview = false, rows = [] } = {}) {
  const scripts = [];
  const capture = {
    route: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    evaluate: async (fn, args) => scripts.push(`(${fn.toString()})(${JSON.stringify(args)});`),
    addScriptTag: async ({ content }) => scripts.push(content),
  };
  await mountLeadCreateFixture(
    { newPage: async () => capture },
    {
      role,
      preview,
      realControls: true,
      programs: [{ id: PROGRAM, name: "Sample program", archived_at: null }],
    },
  );
  scripts.push(
    `(${installTrialPanelFixture.toString()})(${JSON.stringify({ LEAD, OTHER, APPT, STUDIO, PROGRAM, rows })});`,
  );
  const source = scripts.join("\n");
  const temporal =
    /const \{ Temporal \} = await Promise.resolve\(\).then\(\(\) => __importStar\(require\((\d+)\)\)\)/.exec(
      source,
    );
  if (!temporal) throw Error("Expected the real lazy Temporal module boundary.");
  return source.replace(
    "function require(id){",
    `function require(id){if(id===${temporal[1]}){window.f.temporalLoads=(window.f.temporalLoads??0)+1;if(window.f.failTimeConversion)throw Error('Synthetic module load failure');}`,
  );
}

export async function mountTrialPanel(browser, { journal, ...options } = {}) {
  const context = await browser.newContext();
  try {
    await context.addInitScript(
      ({ journal, key }) => {
        if (journal !== undefined) sessionStorage.setItem(key, journal);
        window.trialStorageReads = 0;
        const get = Storage.prototype.getItem;
        Storage.prototype.getItem = function (name) {
          if (name === key) window.trialStorageReads++;
          return get.call(this, name);
        };
      },
      { journal, key: KEY },
    );
    const p = await context.newPage(),
      errors = [];
    p.on("pageerror", (error) => errors.push(error.message));
    p.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await p.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
    );
    await p.goto("http://localhost/");
    await p.addScriptTag({ content: await buildTrialPanelFixture(options) });
    await p.waitForFunction(() => window.f.store?.identityReady && window.f.store.leadsLoaded);
    await flush(p);
    return { p, errors, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function selectLead(p, id = LEAD) {
  await p.locator(`[data-lead-id="${id}"]`).click();
  await flush(p);
}
export async function fillSchedule(
  p,
  {
    startDate = "2030-01-02",
    endDate = startDate,
    startTime = "12:00",
    endTime = "13:00",
    timezone = "UTC",
    location = "Sample room",
  } = {},
) {
  for (const [label, value] of Object.entries({
    "Start date": startDate,
    "End date": endDate,
    "Start time": startTime,
    "End time": endTime,
    Timezone: timezone,
    Location: location,
  }))
    await p.getByLabel(label, { exact: true }).fill(value);
  await flush(p);
}
