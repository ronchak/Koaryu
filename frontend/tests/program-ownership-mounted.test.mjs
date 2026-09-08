import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const source = bundle("production");
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function fixturePage({ holdBootstrap = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.route("**/*", route => route.request().url() === "http://fixture.local/"
    ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }) : route.abort());
  await page.goto("http://fixture.local/");
  await page.evaluate(({ holdBootstrap }) => {
    const f = window.fixture = { observations: [], requests: [], reads: [], writes: [], features: [], workspaces: [], holdBootstrap };
    f.session = { access_token: "token-a", user: { id: "user-a", email: "a@example.test", legal_first_name: "Test", legal_last_name: "Owner" } };
    f.auth = { user: f.session.user, studio_id: "studio-a", role: "admin", membership_status: "active", staff_profiles_available: true };
    f.program = (id, name = id) => ({ id, name, studio_id: "studio-a", sort_order: 0, is_system: false, color_hex: "#64748B", description: null, archived_at: null, usage: { student_count: 0, active_student_count: 0, class_count: 0, active_class_count: 0, lead_count: 0, belt_ladder_count: 0 }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    f.rows = [f.program("p1"), f.program("p2")];
    f.feature = () => ({ auth: f.auth, studio_name: "Test Studio", students: [], leads: [], programs: structuredClone(f.rows), belt_ladders: [], primary_belt_ladder: null, summary: { auth: f.auth, students: { total: 0 } } });
    f.supabase = { auth: {
      getSession: async () => ({ data: { session: f.session } }),
      onAuthStateChange: callback => {
        f.emit = (event, session) => { f.session = session; callback(event, session); };
        return { data: { subscription: { unsubscribe() {} } } };
      },
    } };
    f.pendingWrite = (method, path, body, token) => new Promise((resolve, reject) => f.writes.push({ method, path, body, token, resolve, reject }));
    f.api = {
      get: async (path, token) => {
        f.requests.push({ path, token });
        if (path === "/dashboard/workspace") {
          const snapshot = { auth: f.auth, studio: { name: "Test Studio", timezone: "UTC" } };
          if (f.holdWorkspace) return new Promise((resolve, reject) => f.workspaces.push({ snapshot, resolve, reject }));
          return snapshot;
        }
        if (path.startsWith("/dashboard/bootstrap")) {
          const snapshot = f.feature();
          if (f.holdBootstrap) return new Promise((resolve, reject) => f.features.push({ resolve, reject, snapshot }));
          return snapshot;
        }
        if (path.startsWith("/programs?")) {
          const snapshot = structuredClone(f.rows);
          return new Promise((resolve, reject) => f.reads.push({ path, token, snapshot, resolve, reject }));
        }
        if (path.startsWith("/belts/ladders")) return [];
        if (path.startsWith("/students?")) return { items: [], has_next: false, page_ordinal: 1, page_size: 200, total: 0 };
        if (path.startsWith("/dashboard/summary")) return { auth: f.auth, students: { total: 0 } };
        if (path.startsWith("/schedule/window")) return { sessions: [], templates: [], attendance: [] };
        throw new Error(`Unexpected read ${path}`);
      },
      post: (path, body, token) => f.pendingWrite("POST", path, body, token),
      patch: (path, body, token) => f.pendingWrite("PATCH", path, body, token),
      delete: (path, token) => f.pendingWrite("DELETE", path, null, token),
      postForm: (path, body, token) => f.pendingWrite("FORM", path, null, token),
    };
  }, { holdBootstrap });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => fixture.store?.identityReady);
  if (holdBootstrap) await page.waitForFunction(() => fixture.features.length === 1);
  else await page.waitForFunction(() => fixture.store.programsLoaded && fixture.store.programs.length === 2);
  return page;
}

test("program reads cannot replace a confirmed archive or certify data during a pending write", async () => {
  for (const readDuringWrite of [false, true]) {
    const page = await fixturePage();
    try {
      await page.evaluate(() => {
        fixture.oldRead = fixture.store.refreshPrograms({ includeArchived: true }).catch(error => error.message);
        fixture.archive = fixture.store.archiveProgram("p1");
      });
      await page.waitForFunction(() => fixture.reads.length === 1 && fixture.writes.length === 1);
      if (readDuringWrite) {
        await page.evaluate(() => fixture.reads[0].resolve(fixture.reads[0].snapshot));
        await flush(page);
        assert.equal(await page.evaluate(() => fixture.store.programsUsageLoaded), false, "a read overlapping a write cannot certify usage");
      }
      await page.evaluate(() => {
        fixture.rows[0] = { ...fixture.rows[0], archived_at: "2026-09-08T00:00:00Z" };
        fixture.writes[0].resolve(structuredClone(fixture.rows[0]));
      });
      await page.evaluate(() => fixture.archive);
      await flush(page);
      assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p1").archived_at), "2026-09-08T00:00:00Z");
      if (!readDuringWrite) await page.evaluate(() => fixture.reads[0].resolve(fixture.reads[0].snapshot));
      await flush(page);
      assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p1").archived_at), "2026-09-08T00:00:00Z", "old usage must not undo the acknowledged archive");
      await page.waitForFunction(() => fixture.reads.length === 2);
      await page.evaluate(async () => { fixture.reads[1].resolve(fixture.reads[1].snapshot); await fixture.oldRead; });
      assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    } finally { await page.close(); }
  }
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.archive = fixture.store.archiveProgram("p1").catch(error => error.message);
      fixture.refresh = fixture.store.refreshPrograms({ includeArchived: true });
    });
    assert.equal(await page.evaluate(() => fixture.reads.length), 0);
    await page.evaluate(async () => { fixture.writes[0].reject(new Error("Archive denied")); await fixture.archive; });
    await page.waitForFunction(() => fixture.reads.length === 1);
    await page.evaluate(async () => { fixture.reads[0].resolve(fixture.reads[0].snapshot); await fixture.refresh; });
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.store.programsUsageLoaded), true);
    assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p1").archived_at), null);
    assert.equal(await page.evaluate(() => fixture.writes.length), 1);
  } finally { await page.close(); }

});

test("confirmed program writes survive token renewal and simultaneous acknowledgements retain both rows", async () => {
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.archive = fixture.store.archiveProgram("p1");
      fixture.create = fixture.store.createProgram({ name: "Created" });
    });
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() => fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "token-b" }));
    await page.waitForFunction(() => fixture.store.token === "token-b");
    await page.evaluate(async () => {
      fixture.writes[0].resolve({ ...fixture.rows[0], archived_at: "2026-09-08T00:00:00Z" });
      fixture.writes[1].resolve(fixture.program("p3", "Created"));
      await Promise.all([fixture.archive, fixture.create]);
    });
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p1").archived_at), "2026-09-08T00:00:00Z");
    assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p3")?.name), "Created");
    assert.deepEqual(await page.evaluate(() => fixture.writes.map(w => w.token)), ["token-a", "token-a"], "writes are not replayed");
    assert.ok((await page.evaluate(() => fixture.requests.filter(r => r.path.startsWith("/belts/ladders")))).some(r => r.token === "token-b"));
    await page.evaluate(async () => {
      fixture.first = fixture.store.updateProgram("p1", { name: "First changed" });
      fixture.second = fixture.store.updateProgram("p2", { name: "Second changed" });
      fixture.writes[2].resolve({ ...fixture.rows[0], name: "First changed", archived_at: "2026-09-08T00:00:00Z" });
      fixture.writes[3].resolve({ ...fixture.rows[1], name: "Second changed" });
      await Promise.all([fixture.first, fixture.second]);
    });
    await flush(page);
    assert.deepEqual(await page.evaluate(() => fixture.store.programs.filter(p => p.id !== "p3").map(p => p.name).sort()), ["First changed", "Second changed"]);
  } finally { await page.close(); }
});

test("newest program reads own rows and errors while equivalent current reads still share transport", async () => {
  for (const oldFailure of [false, true]) {
    const page = await fixturePage();
    try {
      await page.evaluate(() => {
        fixture.old = fixture.store.refreshPrograms({ includeArchived: true }).catch(error => error.message);
        fixture.shared = fixture.store.refreshPrograms({ includeArchived: true }).catch(error => error.message);
        fixture.newest = fixture.store.refreshPrograms({ includeArchived: false });
      });
      await page.waitForFunction(() => fixture.reads.length === 2);
      await page.evaluate(async () => { fixture.reads[1].resolve([fixture.program("new", "Newest")]); await fixture.newest; });
      await page.evaluate(oldFailure => {
        if (oldFailure) fixture.reads[0].reject(new Error("Obsolete failure"));
        else fixture.reads[0].resolve(fixture.reads[0].snapshot);
      }, oldFailure);
      await page.evaluate(() => Promise.all([fixture.old, fixture.shared]));
      await flush(page);
      assert.deepEqual(await page.evaluate(() => fixture.store.programs.map(p => p.id)), ["new"]);
      assert.equal(await page.evaluate(() => fixture.store.programsUsageLoadError), null);
      assert.equal(await page.evaluate(() => fixture.reads.length), 2);
    } finally { await page.close(); }
  }
});

test("program bootstrap cannot overwrite a later write, usage snapshot, or successful load flags", async () => {
  for (const outcome of ["success", "dataset-error", "transport-error"]) {
    const page = await fixturePage({ holdBootstrap: true });
    try {
      await page.evaluate(() => { fixture.create = fixture.store.createProgram({ name: "Created" }); });
      await page.waitForFunction(() => fixture.writes.length === 1);
      await page.evaluate(async () => {
        fixture.rows.push(fixture.program("p3", "Created"));
        fixture.writes[0].resolve(fixture.rows[2]);
        await fixture.create;
        fixture.usage = fixture.store.refreshPrograms({ includeArchived: true });
      });
      await page.waitForFunction(() => fixture.reads.length === 1);
      await page.evaluate(async () => { fixture.reads[0].resolve(fixture.reads[0].snapshot); await fixture.usage; });
      await page.evaluate(outcome => {
        const old = fixture.features[0];
        if (outcome === "transport-error") old.reject(new Error("Old bootstrap failed"));
        else old.resolve(outcome === "dataset-error" ? { ...old.snapshot, dataset_errors: { programs: "Old program error" } } : old.snapshot);
      }, outcome);
      await flush(page);
      assert.deepEqual(await page.evaluate(() => fixture.store.programs.map(p => p.id).sort()), ["p1", "p2", "p3"]);
      assert.deepEqual(await page.evaluate(() => [fixture.store.programsLoaded, fixture.store.programsUsageLoaded,
        fixture.store.programsLoadError, fixture.store.programsUsageLoadError]), [true, true, null, null]);
    } finally { await page.close(); }
  }
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.create = fixture.store.createProgram({ name: "Saved while retrying" });
      fixture.holdWorkspace = true;
      fixture.store.retryInitialization();
    });
    await page.waitForFunction(() => fixture.workspaces.length === 1 && fixture.writes.length === 1);
    await page.evaluate(async () => {
      fixture.writes[0].resolve(fixture.program("p3", "Saved while retrying"));
      await fixture.create;
    });
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.store.programsLoaded), true);
    await page.evaluate(() => fixture.workspaces[0].reject(new Error("Workspace retry failed")));
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.store.programsLoaded), true, "old workspace failure cannot replace a newer program commit");
    assert.equal(await page.evaluate(() => fixture.store.programsLoadError), null);
    assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p3")?.name), "Saved while retrying");
    assert.equal(await page.evaluate(() => fixture.store.identityReady), false, "workspace identity failure must still close the access gate");
    assert.match(await page.evaluate(() => fixture.store.identityLoadError), /Workspace retry failed/);
  } finally { await page.close(); }

});

test("an acknowledged CSV import gets a program read begun after its receipt", async () => {
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.old = fixture.store.refreshPrograms({ includeArchived: true }).catch(error => error.message);
      fixture.import = fixture.store.importStudents(new File(["first_name\nTest"], "students.csv"), [], {}, {}, { importKey: "test-import" });
    });
    await page.waitForFunction(() => fixture.reads.length === 1 && fixture.writes.length === 1);
    await page.evaluate(() => {
      fixture.rows.push(fixture.program("p3", "Imported"));
      fixture.writes[0].resolve({ imported_count: 0, reused_result: false, created_programs: ["Imported"],
        created_ladders: [], created_belts: [], warnings: [] });
    });
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.reads.length), 2, "an earlier GET cannot stand in for post-import reconciliation");
    await page.evaluate(async () => {
      fixture.reads[0].resolve(fixture.reads[0].snapshot);
      fixture.reads[1].resolve(fixture.reads[1].snapshot);
      await Promise.all([fixture.old, fixture.import]);
    });
    await flush(page);
    assert.equal(await page.evaluate(() => fixture.store.programs.find(p => p.id === "p3")?.name), "Imported");
    assert.equal(await page.evaluate(() => fixture.writes.length), 1);
  } finally { await page.close(); }
});

test("data clear and identity replacement prevent old program reads or write acknowledgements repopulating rows", async () => {
  for (const replaceIdentity of [false, true]) {
    const page = await fixturePage();
    try {
      await page.evaluate(replaceIdentity => {
        if (!replaceIdentity) fixture.old = fixture.store.refreshPrograms({ includeArchived: true }).catch(error => error.message);
        fixture.create = fixture.store.createProgram({ name: "Before clear" });
        if (replaceIdentity) fixture.old = fixture.store.refreshPrograms({ includeArchived: true }).catch(error => error.message);
      }, replaceIdentity);
      await page.waitForFunction(() => fixture.writes.length === 1);
      if (replaceIdentity) {
        await page.evaluate(() => {
          fixture.rows = [];
          fixture.auth = { ...fixture.auth, studio_id: "studio-b" };
          fixture.emit("USER_UPDATED", fixture.session);
        });
        await page.waitForFunction(() => fixture.store.currentStudioId === "studio-b" && fixture.store.programsLoaded);
      } else {
        await page.evaluate(() => { fixture.clear = fixture.store.clearStudioData(); });
        await page.waitForFunction(() => fixture.writes.length === 2);
        await page.evaluate(async () => {
          fixture.rows = [];
          fixture.writes[1].resolve({ studio_name: "Cleared Studio" });
          await fixture.clear;
        });
      }
      await page.evaluate(async () => {
        for (const read of fixture.reads) read.resolve(read.snapshot);
        fixture.writes[0].resolve(fixture.program("old-created", "Before clear"));
        await Promise.all([fixture.old, fixture.create]);
      });
      await flush(page);
      assert.deepEqual(await page.evaluate(() => fixture.store.programs), []);
      assert.equal(await page.evaluate(() => fixture.reads.length), replaceIdentity ? 0 : 1,
        "abandoned reads and mutation waiters must not start a replacement transport");
    } finally { await page.close(); }
  }
});
