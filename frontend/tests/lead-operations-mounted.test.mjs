import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Mount the real StoreProvider and the real leads page, board and inspector in
// Chromium. Only auth, HTTP, navigation, icons and styles are synthetic. The page
// can be unmounted and remounted while the provider and its rows stay mounted.
function bundle() {
  const stubs = {
    "next/navigation": `const router={replace(p){window.f.redirects.push(p)},push(p){window.f.redirects.push(p)}};exports.useRouter=()=>router;exports.usePathname=()=>'/leads';exports.useParams=()=>({});exports.useSearchParams=()=>new URLSearchParams();`,
    "@/lib/supabase/client": `exports.createClient=()=>window.f.supabase;`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status,detail){super(message);this.status=status;this.detail=detail;}}exports.ApiError=ApiError;window.f.ApiError=ApiError;exports.CommandOutcomeUnknown=require("@/lib/command-outcome").CommandOutcomeUnknown;window.f.Unknown=exports.CommandOutcomeUnknown;exports.api=window.f.api;exports.isSubscriptionRequiredError=e=>e?.status===402;exports.isStaffArchivedError=()=>false;`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.startStudentPagePerformanceSpan=()=>({finish(){}});exports.markDashboardReadiness=()=>()=>{};`,
    "@/components/header": `exports.Header=({children})=>require('react').createElement('header',null,children);`,
    "@/components/programs/program-picker": `exports.ProgramBadge=()=>null;exports.ProgramPicker=()=>null;`,
    "@/components/ui/modal-frame": `exports.ModalFrame=({children})=>children;`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "./leads-ledger.module.css": `module.exports={};`,
    "@/components/leads/leads-ledger.module.css": `module.exports={};`,
  };
  const { add, modules } = createCommonJsPacker(stubs);
  const react = add("react");
  const dom = add("react-dom/client");
  const store = add("@/lib/store");
  const page = add("@/app/(dashboard)/leads/page");
  return `(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_PREVIEW_MODE:'false'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
const React=require(${react});const {StoreProvider,useStore}=require(${store});const LeadsPage=require(${page}).default;
function Observer(){window.f.store=useStore();return null;}
function PageMount(){const [shown,setShown]=React.useState(true);window.f.showPage=setShown;return shown?React.createElement(LeadsPage):null;}
window.f.root=require(${dom}).createRoot(document.getElementById('root'));
window.f.root.render(React.createElement(StoreProvider,null,React.createElement(Observer),React.createElement(PageMount)));})();`;
}

let browser;
let source;
before(async () => {
  browser = await chromium.launch();
  source = bundle();
});
after(async () => {
  await browser?.close();
});

const flush = (p) =>
  p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function mount({ stage = "inquiry" } = {}) {
  const p = await browser.newPage();
  await p.route("**/*", (route) =>
    route.request().url() === "http://localhost/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await p.goto("http://localhost/");
  await p.evaluate((stage) => {
    const f = (window.f = { redirects: [], reads: [], writes: [], rowReads: [] });
    f.rows = ["a", "b"].map((id) => ({
      id,
      studio_id: "studio-a",
      first_name: id.toUpperCase(),
      last_name: "Lead",
      stage,
      source: "website",
      follow_up_date: "2020-01-01",
      assigned_staff_id: null,
      converted_student_id: null,
      created_at: "2020-01-01T00:00:00Z",
      is_minor: false,
    }));
    f.session = { access_token: "token-1", user: { id: "user-a", email: "a@example.test" } };
    f.auth = {
      user: {
        id: "user-a",
        email: "a@example.test",
        legal_first_name: "A",
        legal_last_name: "Owner",
      },
      studio_id: "studio-a",
      membership_status: "active",
      role: "admin",
      staff_profiles_available: true,
    };
    f.summary = {
      auth: f.auth,
      generated_at: "2020-01-01T00:00:00Z",
      students: {
        total_students: 0,
        active_students: 0,
        trialing_students: 0,
        on_hold_students: 0,
      },
      leads: { active_leads: 2, enrolled_leads: 0, due_today_leads: 0 },
      schedule: { today_sessions: 0 },
      belts: { belt_count: 0, tip_count: 0 },
      inactivity: { watch_14: 0, watch_30: 0, watch_90: 0 },
      new_students: { new_14: 0, new_30: 0, new_90: 0, new_year_to_date: 0 },
      operational: {
        attendance_with_capacity: 0,
        total_capacity: 0,
        sessions_tracked: 0,
        sessions_with_capacity: 0,
        average_attendance: 0,
      },
      churn: { inactive_students: 0, canceled_students: 0, churn_marked_students: 0 },
      test_readiness: { available: false },
      billing: { can_view_billing: true },
      setup: {
        has_programs: false,
        has_students: false,
        has_belt_system: false,
        has_weekly_classes: false,
      },
      recent_students: [],
      actions: [],
    };
    f.supabase = {
      auth: {
        getSession: async () => ({ data: { session: f.session } }),
        onAuthStateChange: (cb) => {
          f.emit = (event, session) => {
            f.session = session;
            cb(event, session);
          };
          return { data: { subscription: { unsubscribe() {} } } };
        },
      },
    };
    const copy = () => f.rows.map((row) => ({ ...row }));
    f.api = {
      get: async (path, token) => {
        f.reads.push({ path, token });
        if (path === "/dashboard/workspace")
          return { auth: f.auth, studio: { name: "Synthetic Studio", timezone: "UTC" } };
        if (path.startsWith("/dashboard/bootstrap"))
          return {
            auth: f.auth,
            studio_name: "Synthetic Studio",
            students: [],
            students_may_be_partial: false,
            leads: copy(),
            programs: [],
            belt_ladders: [],
            primary_belt_ladder: null,
            summary: f.summary,
          };
        if (path.startsWith("/dashboard/summary")) return f.summary;
        if (path.startsWith("/programs") || path.startsWith("/staff")) return [];
        if (path === "/leads") return copy();
        if (/^\/leads\/[^/]+\/activities$/.test(path)) return [];
        if (/^\/leads\/[^/]+$/.test(path))
          return new Promise((resolve, reject) =>
            f.rowReads.push({ path, token, resolve, reject }),
          );
        throw Error(`Unexpected read ${path}`);
      },
      post: (path, body, token) =>
        path.startsWith("/schedule/window")
          ? Promise.resolve({ sessions: [], attendance: [], templates: [] })
          : f.write("post", path, body, token),
      patch: (path, body, token) => f.write("patch", path, body, token),
    };
    // Bodies are recorded as sent so retries can be compared byte for byte.
    f.write = (method, path, body, token) =>
      new Promise((resolve, reject) =>
        f.writes.push({ method, path, body: JSON.stringify(body), token, resolve, reject }),
      );
    // The synthetic server applies a command once, then replays its receipt.
    f.receipts = {};
    f.confirm = (index, overrides = {}) => {
      const w = f.writes[index];
      const id = w.path.split("/")[2];
      const body = JSON.parse(w.body);
      let row;
      if (w.path.endsWith("/follow-up")) {
        row = f.receipts[body.operation_id];
        if (!row) {
          const current = f.rows.find((item) => item.id === id);
          row = { ...current, stage: body.next_stage ?? current.stage, follow_up_date: null };
          if (row.stage === "enrolled") row.converted_student_id = `student-${id}`;
          f.receipts[body.operation_id] = row;
          f.rows = f.rows.map((item) => (item.id === id ? row : item));
        }
      } else if (w.path.endsWith("/convert")) {
        row = {
          ...f.rows.find((item) => item.id === id),
          stage: "enrolled",
          converted_student_id: `student-${id}`,
        };
        f.rows = f.rows.map((item) => (item.id === id ? row : item));
      } else {
        row = { ...f.rows.find((item) => item.id === id), ...body };
        f.rows = f.rows.map((item) => (item.id === id ? row : item));
      }
      w.resolve({ ...row, ...overrides });
    };
    f.lose = (index) => f.writes[index].reject(new f.Unknown());
    f.refuse = (index) =>
      f.writes[index].reject(new f.ApiError("The studio is being updated.", 409));
    f.readRow = (index) => {
      const r = f.rowReads[index];
      const row = f.rows.find((item) => `/leads/${item.id}` === r.path);
      if (row) r.resolve({ ...row });
      else r.reject(new f.ApiError("Lead not found", 404));
    };
    f.failRowRead = (index) => f.rowReads[index].reject(new f.ApiError("Upstream failed", 503));
    f.stored = (id) => f.store.leads.find((lead) => lead.id === id) ?? null;
  }, stage);
  await p.addScriptTag({ content: source });
  await p.waitForFunction(() => window.f.store?.identityReady && window.f.store.leadsLoaded);
  await p.locator('[data-lead-id="a"]').waitFor();
  return p;
}

const button = (p, name) => p.getByRole("button", { name, exact: true });
const inspector = (p) => p.getByRole("complementary");
const writes = (p) =>
  p.evaluate(() =>
    f.writes.map(({ method, path, body, token }) => ({ method, path, body, token })),
  );

async function remountPage(p) {
  await p.evaluate(() => f.showPage(false));
  await flush(p);
  assert.equal(await p.locator('[data-lead-id="a"]').count(), 0);
  await p.evaluate(() => f.showPage(true));
  await flush(p);
}

async function open(p, id) {
  await p.locator(`[data-lead-id="${id}"]`).click();
  await p.getByRole("heading", { name: `${id.toUpperCase()} Lead`, exact: true }).waitFor();
}

// Every lead command control for one row, as rendered.
async function rowControls(p, name) {
  const panel = inspector(p);
  return {
    next: await button(p, `Move ${name} Lead to the next stage`).isDisabled(),
    stage: await panel.locator("#lead-detail-stage").isDisabled(),
    assignee: await panel.locator("#lead-detail-assignee").isDisabled(),
    contacted: await button(panel, "Mark contacted").isDisabled(),
    convert: await button(panel, "Convert to student").isDisabled(),
    lost: await button(panel, "Mark lost").isDisabled(),
    reschedule: await button(panel, "Reschedule").isDisabled(),
  };
}

const allDisabled = {
  next: true,
  stage: true,
  assignee: true,
  contacted: true,
  convert: true,
  lost: true,
  reschedule: true,
};
const allEnabled = Object.fromEntries(Object.keys(allDisabled).map((key) => [key, false]));

// Fire every conflicting row action even where the rendered control is disabled.
async function attemptConflicts(p, name) {
  const panel = inspector(p);
  await button(p, `Move ${name} Lead to the next stage`).click({ force: true });
  for (const label of ["Mark contacted", "Convert to student", "Mark lost", "Reschedule"])
    await button(panel, label).click({ force: true });
  await panel.locator("#lead-detail-stage").evaluate((select) => {
    select.value = "closed_lost";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await panel.locator("#lead-detail-assignee").evaluate((select) => {
    select.add(new Option("Synthetic staff", "staff-9"));
    select.value = "staff-9";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(p);
}

test("an unknown follow-up keeps its reservation and exact command across a page remount", async () => {
  const p = await mount();
  try {
    await open(p, "a");
    await button(p, "Move to Trial Scheduled").click();
    const [first] = await writes(p);
    assert.equal(first.method, "post");
    assert.equal(first.path, "/leads/a/follow-up");
    const sent = JSON.parse(first.body);
    assert.deepEqual(Object.keys(sent).sort(), ["next_stage", "operation_id"]);
    assert.equal(sent.next_stage, "trial_scheduled");
    assert.match(
      sent.operation_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await p.evaluate(() => f.lose(0));
    await flush(p);
    await remountPage(p);

    // The provider still holds the old row, and the remounted page shows it reserved.
    assert.equal(await p.evaluate(() => f.stored("a").stage), "inquiry");
    assert.equal(await p.locator('[data-lead-id="a"]').isDisabled(), false);
    await open(p, "a");
    assert.equal(await button(p, "Retry follow-up").isVisible(), true);
    assert.deepEqual(await rowControls(p, "A"), allDisabled);
    await attemptConflicts(p, "A");
    assert.equal((await writes(p)).length, 1);

    // B remains independently actionable while A is unresolved.
    assert.equal(await button(p, "Move B Lead to the next stage").isDisabled(), false);

    // Retry replays the exact original command bytes.
    await button(p, "Retry follow-up").click();
    await flush(p);
    let sentWrites = await writes(p);
    assert.equal(sentWrites.length, 2);
    assert.equal(sentWrites[1].path, first.path);
    assert.equal(sentWrites[1].body, first.body);

    // A rejected retry is not proof the original was not applied.
    await p.evaluate(() => f.refuse(1));
    await flush(p);
    assert.deepEqual(await rowControls(p, "A"), allDisabled);
    assert.equal(await button(p, "Retry follow-up").isVisible(), true);
    await attemptConflicts(p, "A");
    assert.equal((await writes(p)).length, 2);

    // Confirmation arrives, but the current-row read fails: stay reserved.
    await button(p, "Retry follow-up").click();
    await p.waitForFunction(() => f.writes.length === 3);
    sentWrites = await writes(p);
    assert.equal(sentWrites[2].body, first.body);
    await p.evaluate(() => f.confirm(2));
    await p.waitForFunction(() => f.rowReads.length === 1);
    assert.equal(await p.evaluate(() => f.rowReads[0].path), "/leads/a");
    await p.evaluate(() => f.failRowRead(0));
    await flush(p);
    // A historical receipt is never published as the current row.
    assert.equal(await p.evaluate(() => f.stored("a").stage), "inquiry");
    assert.equal(await button(p, "Refresh lead details").isVisible(), true);
    assert.deepEqual(await rowControls(p, "A"), allDisabled);

    // The confirmed-but-unreconciled state also survives a page remount.
    await remountPage(p);
    await open(p, "a");
    assert.deepEqual(await rowControls(p, "A"), allDisabled);
    await attemptConflicts(p, "A");
    assert.equal((await writes(p)).length, 3);

    // Another writer moved the row after the receipt; reconciliation shows it.
    await p.evaluate(() => {
      f.rows = f.rows.map((row) => (row.id === "a" ? { ...row, stage: "trial_completed" } : row));
    });
    await button(p, "Refresh lead details").click();
    await p.waitForFunction(() => f.writes.length === 4);
    sentWrites = await writes(p);
    assert.equal(sentWrites[3].body, first.body);
    await p.evaluate(() => f.confirm(3));
    await p.waitForFunction(() => f.rowReads.length === 2);
    await p.evaluate(() => f.readRow(1));
    await flush(p);
    assert.equal(await p.evaluate(() => f.stored("a").stage), "trial_completed");
    assert.equal(await button(p, "Refresh lead details").count(), 0);
    assert.deepEqual(await rowControls(p, "A"), allEnabled);
    assert.equal((await writes(p)).length, 4);
  } finally {
    await p.close();
  }
});

test("an actual 404 current-row read removes the stale row and releases only that row", async () => {
  const p = await mount();
  try {
    await open(p, "a");
    await button(p, "Mark contacted").click();
    await p.evaluate(() => f.lose(0));
    await remountPage(p);
    await open(p, "a");
    await button(p, "Retry follow-up").click();
    await p.waitForFunction(() => f.writes.length === 2);
    await p.evaluate(() => {
      f.confirm(1);
      f.rows = f.rows.filter((row) => row.id !== "a");
    });
    await p.waitForFunction(() => f.rowReads.length === 1);
    await p.evaluate(() => f.readRow(0));
    await flush(p);
    assert.equal(await p.evaluate(() => f.stored("a")), null);
    assert.equal(await p.locator('[data-lead-id="a"]').count(), 0);
    assert.equal(await button(p, "Move B Lead to the next stage").isDisabled(), false);
    assert.deepEqual(await p.evaluate(() => f.redirects), []);
  } finally {
    await p.close();
  }
});

for (const order of [
  ["a", "b"],
  ["b", "a"],
])
  test(`A and B act concurrently and settle independently (${order.join(" then ")})`, async () => {
    const p = await mount();
    try {
      await open(p, "a");
      await button(p, "Move to Trial Scheduled").click();
      await button(p, "Move B Lead to the next stage").click();
      const sent = await writes(p);
      assert.deepEqual(
        sent.map((w) => [w.method, w.path]),
        [
          ["post", "/leads/a/follow-up"],
          ["patch", "/leads/b"],
        ],
      );
      assert.equal(await button(p, "Move A Lead to the next stage").isDisabled(), true);
      assert.equal(await button(p, "Move B Lead to the next stage").isDisabled(), true);
      for (const id of order) {
        // A's outcome is lost; B's PATCH is confirmed.
        await p.evaluate((id) => (id === "a" ? f.lose(0) : f.confirm(1)), id);
        await flush(p);
        if (id === "a")
          assert.equal(
            await button(p, "Move B Lead to the next stage").isDisabled(),
            order[0] === "a",
          );
        else assert.equal(await button(p, "Move A Lead to the next stage").isDisabled(), true);
      }
      assert.equal(await button(p, "Move A Lead to the next stage").isDisabled(), true);
      assert.equal(await button(p, "Move B Lead to the next stage").isDisabled(), false);
      assert.equal(await p.evaluate(() => f.stored("b").stage), "trial_scheduled");
      await remountPage(p);
      assert.equal(await button(p, "Move A Lead to the next stage").isDisabled(), true);
      assert.equal(await button(p, "Move B Lead to the next stage").isDisabled(), false);
    } finally {
      await p.close();
    }
  });

test("same-turn duplicate and cross-control attempts send one request for the row", async () => {
  const p = await mount();
  try {
    await open(p, "a");
    // Both clicks are dispatched before React can render the disabled state.
    await p.evaluate(() => {
      const byText = (text) =>
        [...document.querySelectorAll("button")].find((node) => node.textContent === text);
      byText("Mark contacted").click();
      byText("Mark contacted").click();
      byText("Move to Trial Scheduled").click();
      byText("Convert to student").click();
      byText("Mark lost").click();
      document.querySelector('[aria-label="Move A Lead to the next stage"]').click();
    });
    await flush(p);
    const sent = await writes(p);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, "/leads/a/follow-up");
    assert.equal(JSON.parse(sent[0].body).next_stage, null);
    await p.evaluate(() => f.confirm(0));
    await flush(p);
    assert.deepEqual(await rowControls(p, "A"), allEnabled);
    assert.equal(await p.evaluate(() => f.stored("a").follow_up_date), null);
  } finally {
    await p.close();
  }
});

test("token renewal keeps the reservation and a fresh-token current read reconciles it", async () => {
  const p = await mount();
  try {
    await open(p, "a");
    await button(p, "Move to Trial Scheduled").click();
    const [first] = await writes(p);
    assert.equal(first.token, "token-1");
    await p.evaluate(() => f.emit("TOKEN_REFRESHED", { ...f.session, access_token: "token-2" }));
    await flush(p);
    await p.evaluate(() => f.lose(0));
    await remountPage(p);
    await open(p, "a");
    assert.deepEqual(await rowControls(p, "A"), allDisabled);
    await button(p, "Retry follow-up").click();
    await p.waitForFunction(() => f.writes.length === 2);
    const retry = (await writes(p))[1];
    assert.equal(retry.token, "token-2");
    assert.equal(retry.body, first.body);
    await p.evaluate(() => f.confirm(1));
    await p.waitForFunction(() => f.rowReads.length === 1);
    assert.equal(await p.evaluate(() => f.rowReads[0].token), "token-2");
    // Renewal while the current-row read is held repeats that read with the new token.
    await p.evaluate(() => f.emit("TOKEN_REFRESHED", { ...f.session, access_token: "token-3" }));
    await flush(p);
    await p.evaluate(() => f.readRow(0));
    await p.waitForFunction(() => f.rowReads.length === 2);
    assert.equal(await p.evaluate(() => f.rowReads[1].token), "token-3");
    assert.deepEqual(await rowControls(p, "A"), allDisabled);
    await p.evaluate(() => f.readRow(1));
    await flush(p);
    assert.equal(await p.evaluate(() => f.stored("a").stage), "trial_scheduled");
    assert.deepEqual(await rowControls(p, "A"), allEnabled);
    assert.equal((await writes(p)).length, 2);
  } finally {
    await p.close();
  }
});

test("authoritative role replacement fences old work from the new access scope", async () => {
  const p = await mount({ stage: "offer_sent" });
  try {
    await open(p, "a");
    await button(p, "Convert now").click();
    assert.equal((await writes(p))[0].path, "/leads/a/follow-up");
    await p.evaluate(() => {
      f.auth = { ...f.auth, role: "front_desk" };
      window.dispatchEvent(new Event("koaryu:resume"));
    });
    await p.waitForFunction(() => f.store.currentRole === "front_desk");
    await flush(p);
    // The replacement scope starts without the old owner's reservation or selection.
    assert.equal(await p.getByRole("complementary").count(), 0);
    assert.equal(await button(p, "Move A Lead to the next stage").isDisabled(), false);
    await open(p, "a");
    await inspector(p)
      .locator("#lead-detail-assignee")
      .evaluate((select) => {
        select.add(new Option("Synthetic staff", "staff-2"));
        select.value = "staff-2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    await flush(p);
    assert.deepEqual(
      (await writes(p)).map((w) => [w.method, w.path, w.token]),
      [
        ["post", "/leads/a/follow-up", "token-1"],
        ["patch", "/leads/a", "token-1"],
      ],
    );
    // The old enrollment settles: no row, notice, navigation or release reaches B's owner.
    await p.evaluate(() => f.confirm(0));
    await flush(p);
    assert.deepEqual(await p.evaluate(() => f.redirects), []);
    assert.equal(await p.evaluate(() => f.stored("a").stage), "offer_sent");
    assert.equal(await p.getByRole("status").filter({ hasText: "enrolled" }).count(), 0);
    assert.equal(await inspector(p).locator("#lead-detail-assignee").isDisabled(), true);
    await p.evaluate(() => f.confirm(1));
    await flush(p);
    assert.equal(await p.evaluate(() => f.stored("a").assigned_staff_id), "staff-2");
    assert.equal(await inspector(p).locator("#lead-detail-assignee").isDisabled(), false);
  } finally {
    await p.close();
  }
});

test("sign-out fences an unknown follow-up; signing back in cannot retry it", async () => {
  const p = await mount();
  try {
    await open(p, "a");
    await button(p, "Mark contacted").click();
    await p.evaluate(() => f.lose(0));
    await flush(p);
    await p.evaluate(() => f.emit("SIGNED_OUT", null));
    await p.waitForFunction(() => !f.store.identityReady);
    await p.evaluate(() => f.emit("SIGNED_IN", { access_token: "token-9", user: f.auth.user }));
    await p.waitForFunction(() => f.store.identityReady && f.store.leadsLoaded);
    await p.locator('[data-lead-id="a"]').waitFor();
    await open(p, "a");
    assert.equal(await button(p, "Retry follow-up").count(), 0);
    assert.deepEqual(await rowControls(p, "A"), allEnabled);
  } finally {
    await p.close();
  }
});

test("a held enrollment that settles after the page unmounts does not navigate", async () => {
  const p = await mount({ stage: "offer_sent" });
  try {
    await open(p, "a");
    await button(p, "Convert now").click();
    await p.evaluate(() => f.showPage(false));
    await flush(p);
    await p.evaluate(() => f.confirm(0));
    await flush(p);
    assert.deepEqual(await p.evaluate(() => f.redirects), []);
    assert.equal(await p.evaluate(() => f.stored("a").stage), "enrolled");
    await p.evaluate(() => f.showPage(true));
    await flush(p);
    assert.equal(await button(p, "Move B Lead to the next stage").isDisabled(), false);
  } finally {
    await p.close();
  }
});
