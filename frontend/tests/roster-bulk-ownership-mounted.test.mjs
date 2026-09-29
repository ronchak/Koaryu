import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Mount the real roster controller and page content. Only store I/O is replaced.
function bundle() {
  const cssModule = `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`;
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `const router={replace(){},push(){}};exports.useRouter=()=>router;exports.useSearchParams=()=>new URLSearchParams(window.location.search);`,
    "next/dynamic": `exports.__esModule=true;exports.default=()=>()=>null;`,
    "next/link": `exports.__esModule=true;exports.default=({children,href,prefetch,...props})=>require('react').createElement('a',{href:typeof href==='string'?href:href.pathname,...props},children);`,
    "@/lib/use-resume-refresh": `exports.useResumeRefresh=()=>{};`,
    "@/components/icons/martial-arts-belt": `exports.MartialArtsBelt=()=>null;`,
    "@/components/header": `exports.Header=({title})=>require('react').createElement('header',null,title);`,
    "@/components/programs/program-picker": `exports.ProgramBadge=({program,name})=>require('react').createElement('span',null,program?.name??name);`,
    "@/components/students/status-badge": `exports.StatusBadge=({status})=>require('react').createElement('span',null,status);`,
    "@/components/students/student-avatar": `exports.StudentAvatar=()=>null;`,
    "./belt-tracker.module.css": cssModule,
    "./records-loading.module.css": cssModule,
    "./sliding-segmented-control.module.css": cssModule,
    "./student-records.module.css": cssModule,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const controller = add("@/lib/students-page-controller");
  const content = add("@/components/students/student-roster-page-content");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react});const f=window.fixture;function Roster(){const c=require(${controller}).useStudentsPageController({config:f.config,programsStore:f.programsStore,scheduleStore:f.scheduleStore,studentsStore:f.studentsStore,studioStore:f.studioStore});f.roster=c.contentProps;return React.createElement(require(${content}).StudentRosterPageContent,c.contentProps);}const root=require(${dom}).createRoot(document.getElementById('root'));f.rerender=()=>root.render(React.createElement(Roster));f.rerender();})();`;
}

const source = bundle();
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

async function mount() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/students"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/students");
  await page.evaluate(() => {
    const student = (id, first) => ({
      id,
      studio_id: "studio-a",
      legal_first_name: first,
      legal_last_name: "Lane",
      status: "active",
      guardians: [],
      photo_url: null,
      programs: [],
      tags: [],
      created_at: "2026-01-01T00:00:00Z",
    });
    const f = (window.fixture = { writes: [], pageReads: 0 });
    const deferredWrite = (kind, payload) =>
      new Promise((resolve, reject) => f.writes.push({ kind, ...payload, resolve, reject }));
    f.config = {
      businessDate: "2026-09-29",
      currentRole: "admin",
      isPreviewMode: false,
      token: "synthetic-token",
    };
    f.programsStore = {
      programs: [],
      programsLoadError: null,
      programsLoaded: true,
      refreshPrograms: async () => {},
    };
    f.scheduleStore = { attendance: [], sessions: [], refreshScheduleRange: async () => {} };
    f.studioStore = { currentStudioId: "studio-a", identityGeneration: 1, currentUserId: "user-a" };
    f.studentsStore = {
      addStudent: async () => {},
      bulkAddTagsToStudents: (ids, tags) => deferredWrite("tags", { ids, tags }),
      bulkUpdateStudentStatus: (ids, status) => deferredWrite("status", { ids, status }),
      deleteStudents: (ids) => deferredWrite("delete", { ids }),
      listStudentsPage: async () => {
        f.pageReads += 1;
        return {
          items: [student("student-a", "Ari"), student("student-b", "Bo")],
          total: 2,
          page_ordinal: 1,
          has_next: false,
          has_previous: false,
          next_cursor: null,
          previous_cursor: null,
        };
      },
      refreshStudents: async () => {},
      students: [],
      studentsLastLoadedAt: null,
      studentsLoadError: null,
      studentsLoaded: true,
      studentsMayBePartial: false,
    };
  });
  await page.addScriptTag({ content: source });
  await page.waitForFunction(() => fixture.roster?.filtered.length === 2);
  return { page, errors };
}

const snapshot = (page) =>
  page.evaluate(() => {
    const r = fixture.roster;
    return {
      selected: [...r.selectedIds],
      panel: r.activeBulkPanel,
      tagInput: r.tagInput,
      bulkStatus: r.bulkStatus,
      pending: r.isBulkCommandPending,
      bulkActionError: r.bulkActionError,
      deleteError: r.deleteError,
      actionMessage: r.actionMessage,
      writes: fixture.writes.map(({ kind, ids, tags, status }) => ({ kind, ids, tags, status })),
    };
  });

test("a pending bulk tag write owns selection, panel and payload until it settles", async () => {
  const { page, errors } = await mount();
  try {
    await page.evaluate(() => fixture.roster.onToggleSelect("student-a"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("tags"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onTagInputChange("vip"));
    await flush(page);

    // Same tick: every competing call uses the props captured before the owner rendered.
    await page.evaluate(() => {
      const r = fixture.roster;
      void r.onAddTags();
      r.onToggleSelect("student-b");
      r.onToggleSelectAll();
      r.onToggleBulkPanel("status");
      r.onBulkStatusChange("paused");
      void r.onBulkStatusUpdate();
      void r.onDeleteSelected();
      void r.onAddTags();
      r.onTagInputChange("other");
      r.onCancelTags();
      r.onSearchChange("Bo");
    });
    await flush(page);
    // Later ticks: competing calls from the rendered, busy props.
    await page.evaluate(() => {
      const r = fixture.roster;
      r.onToggleSelect("student-b");
      r.onToggleSelectAll();
      r.onToggleBulkPanel("delete");
      r.onCancelDelete();
      r.onCancelStatus();
      void r.onBulkStatusUpdate();
      void r.onDeleteSelected();
    });
    await flush(page);

    assert.deepEqual(await snapshot(page), {
      selected: ["student-a"],
      panel: "tags",
      tagInput: "vip",
      bulkStatus: "active",
      pending: true,
      bulkActionError: null,
      deleteError: null,
      actionMessage: null,
      writes: [{ kind: "tags", ids: ["student-a"], tags: ["vip"], status: undefined }],
    });
    assert.equal(await page.evaluate(() => fixture.roster.isAddingTags), true);
    assert.equal(await page.getByRole("button", { name: "Cancel" }).isDisabled(), true);
    assert.equal(await page.getByLabel("Tags to add").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Change status" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Archive" }).isDisabled(), true);
    assert.equal(await page.getByLabel("Search students").isDisabled(), true);

    const readsBeforeSettlement = await page.evaluate(() => fixture.pageReads);
    await page.evaluate(() => fixture.writes[0].resolve({ updated: 1 }));
    await page.waitForFunction(() => !fixture.roster.isBulkCommandPending);
    const settled = await snapshot(page);
    assert.equal(settled.actionMessage, "Tags added to 1 student.");
    assert.deepEqual(settled.selected, ["student-a"]);
    assert.equal(settled.panel, null);
    assert.equal(settled.tagInput, "");
    assert.equal(settled.writes.length, 1);
    await page.waitForFunction((reads) => fixture.pageReads > reads, readsBeforeSettlement);
    assert.equal(await page.getByLabel("Search students").isDisabled(), false);

    // A later command after settlement is accepted.
    await page.evaluate(() => fixture.roster.onToggleSelect("student-b"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("delete"));
    await flush(page);
    await page.evaluate(() => void fixture.roster.onDeleteSelected());
    await page.waitForFunction(() => fixture.writes.length === 2);
    assert.deepEqual((await snapshot(page)).writes[1].ids, ["student-a", "student-b"]);
    await page.evaluate(() => fixture.writes[1].resolve());
    await page.waitForFunction(() => !fixture.roster.isBulkCommandPending);
    const archived = await snapshot(page);
    assert.equal(archived.actionMessage, "2 students were removed from the active roster.");
    assert.deepEqual(archived.selected, []);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("partial and rejected bulk writes keep their captured retry context", async () => {
  const { page, errors } = await mount();
  try {
    await page.evaluate(() => fixture.roster.onToggleSelect("student-b"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("status"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onBulkStatusChange("paused"));
    await flush(page);

    await page.evaluate(() => {
      const r = fixture.roster;
      void r.onBulkStatusUpdate();
      r.onBulkStatusChange("canceled");
      r.onToggleSelect("student-a");
    });
    await flush(page);
    await page.evaluate(() => fixture.writes[0].resolve({ updated: 0 }));
    await page.waitForFunction(() => !fixture.roster.isBulkCommandPending);
    let state = await snapshot(page);
    assert.equal(
      state.bulkActionError,
      "Updated 0 of 1 selected students. Some students may no longer be available.",
    );
    assert.deepEqual(state.selected, ["student-b"]);
    assert.equal(state.panel, "status");
    assert.equal(state.bulkStatus, "paused");
    assert.deepEqual(state.writes, [
      { kind: "status", ids: ["student-b"], tags: undefined, status: "paused" },
    ]);

    // Retry from the retained context, then reject it.
    await page.evaluate(() => void fixture.roster.onBulkStatusUpdate());
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() => fixture.writes[1].reject(new Error("Synthetic status failure")));
    await page.waitForFunction(() => !fixture.roster.isBulkCommandPending);
    state = await snapshot(page);
    assert.equal(state.bulkActionError, "Synthetic status failure");
    assert.deepEqual(state.selected, ["student-b"]);
    assert.equal(state.panel, "status");
    assert.equal(state.writes[1].status, "paused");

    // A new archive after settlement starts, and its failure keeps the selection and panel.
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("delete"));
    await flush(page);
    await page.evaluate(() => void fixture.roster.onDeleteSelected());
    await page.waitForFunction(() => fixture.writes.length === 3);
    await page.evaluate(() => fixture.writes[2].reject(new Error("Synthetic archive failure")));
    await page.waitForFunction(() => !fixture.roster.isBulkCommandPending);
    state = await snapshot(page);
    assert.equal(state.deleteError, "Synthetic archive failure");
    assert.deepEqual(state.selected, ["student-b"]);
    assert.equal(state.panel, "delete");
    assert.deepEqual(state.writes[2], {
      kind: "delete",
      ids: ["student-b"],
      tags: undefined,
      status: undefined,
    });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("a replaced studio can own its roster while the old bulk write settles", async () => {
  const { page, errors } = await mount();
  try {
    await page.evaluate(() => fixture.roster.onToggleSelect("student-a"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("tags"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onTagInputChange("old"));
    await flush(page);
    await page.evaluate(() => {
      fixture.oldBulk = fixture.roster.onAddTags();
    });
    await page.waitForFunction(() => fixture.writes.length === 1);

    await page.evaluate(() => {
      fixture.studioStore = {
        ...fixture.studioStore,
        currentStudioId: "studio-b",
        currentUserId: "user-b",
        identityGeneration: 2,
      };
      fixture.rerender();
    });
    await page.waitForFunction(
      () => fixture.roster.selectedIds.size === 0 && !fixture.roster.isBulkCommandPending,
    );
    assert.equal(await page.evaluate(() => fixture.roster.activeBulkPanel), null);
    await page.evaluate(() => fixture.roster.onToggleSelect("student-a"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("tags"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onTagInputChange("new"));
    await flush(page);
    await page.evaluate(() => {
      fixture.newBulk = fixture.roster.onAddTags();
    });
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() => fixture.writes[0].resolve({ updated: 1 }));
    await page.evaluate(() => fixture.oldBulk);
    await flush(page);
    let state = await snapshot(page);
    assert.equal(state.pending, true, "A's settlement cannot release B's owner");
    assert.deepEqual(state.selected, ["student-a"]);
    assert.equal(state.panel, "tags");
    assert.equal(state.tagInput, "new");
    assert.equal(state.actionMessage, null);

    await page.evaluate(() => fixture.writes[1].resolve({ updated: 1 }));
    await page.evaluate(() => fixture.newBulk);
    await page.waitForFunction(() => !fixture.roster.isBulkCommandPending);
    state = await snapshot(page);
    assert.equal(state.actionMessage, "Tags added to 1 student.");
    assert.equal(state.panel, null);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("same-studio history cannot erase a partial bulk command's retry context", async () => {
  const { page, errors } = await mount();
  try {
    await page.evaluate(() => fixture.roster.onToggleSelect("student-a"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onToggleBulkPanel("tags"));
    await flush(page);
    await page.evaluate(() => fixture.roster.onTagInputChange("vip"));
    await flush(page);
    await page.evaluate(() => {
      fixture.bulk = fixture.roster.onAddTags();
    });
    await page.waitForFunction(() => fixture.writes.length === 1);

    await page.evaluate(() => {
      window.history.pushState({}, "", "/students?q=Bo");
      fixture.rerender();
    });
    await flush(page);
    let state = await snapshot(page);
    assert.deepEqual(state.selected, ["student-a"]);
    assert.equal(state.panel, "tags");
    assert.equal(state.tagInput, "vip");
    assert.equal(state.pending, true);
    assert.equal(await page.evaluate(() => window.location.search), "");

    await page.evaluate(() => fixture.writes[0].resolve({ updated: 0 }));
    await page.evaluate(() => fixture.bulk);
    await flush(page);
    state = await snapshot(page);
    assert.deepEqual(state.selected, ["student-a"]);
    assert.equal(state.panel, "tags");
    assert.equal(state.tagInput, "vip");
    assert.equal(
      state.bulkActionError,
      "Added tags to 0 of 1 selected students. Some students may no longer be available.",
    );
    assert.equal(await page.evaluate(() => window.location.search), "");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
