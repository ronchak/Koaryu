import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle({ preview, paged }) {
  const { add, modules } = createCommonJsPacker({
    "next/navigation": `const React=require('react'),f=window.fixture,subscribe=cb=>{window.addEventListener('fixture:navigate',cb);return()=>window.removeEventListener('fixture:navigate',cb)},queries=new Map();exports.usePathname=()=>React.useSyncExternalStore(subscribe,()=>f.pathname);exports.useSearchParams=()=>{const query=React.useSyncExternalStore(subscribe,()=>f.search);if(!queries.has(query))queries.set(query,new URLSearchParams(query));return queries.get(query)};const router={push:href=>f.navigate(href),replace:href=>f.navigate(href),prefetch(){}};exports.useRouter=()=>router;`,
    "@/lib/supabase/client": `exports.createClient=()=>window.fixture.supabase;`,
    "@/lib/api": `class ApiError extends Error{};exports.ApiError=ApiError;exports.api=window.fixture.api;exports.isSubscriptionRequiredError=e=>e?.status===402;exports.isStaffArchivedError=()=>false;`,
    "@/lib/performance": `exports.markPerformance=()=>{};exports.measurePerformance=()=>{};exports.startStudentPagePerformanceSpan=()=>({finish(){}});exports.markDashboardReadiness=()=>()=>{};`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    store = add("@/lib/store"),
    billing = add("@/lib/billing-page-controller"),
    navigation = add("next/navigation");
  return `(()=>{const process={env:{NODE_ENV:'production',NEXT_PUBLIC_PREVIEW_MODE:'${preview}',NEXT_PUBLIC_STUDENTS_PAGED_ROSTER:'${paged}'}},modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}const React=require(${react}),{StoreProvider,useStore}=require(${store}),f=window.fixture;
    function Billing(){const store=useStore(),c=require(${billing}).useBillingPageController({config:store,programsStore:store,studentsStore:store,studioStore:store});f.billing=c.contentProps;return c.contentProps.showBillingContent?React.createElement('ul',{'aria-label':'Billing student choices'},c.contentProps.tabContentProps.billingStudentOptions.map(student=>React.createElement('li',{key:student.id,'data-student':student.id},student.name))):React.createElement('p',null,'Loading complete roster');}
    function Observer(){const store=useStore(),path=require(${navigation}).usePathname();f.store=store;return path==='/billing'?React.createElement(Billing):null;}
    f.root=require(${dom}).createRoot(document.getElementById('root'));f.root.render(React.createElement(StoreProvider,null,React.createElement(Observer)));})();`;
}

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mount(t, mode) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.route("**/*", (route) =>
    route.request().url() === "http://localhost/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://localhost/");
  await page.evaluate((mode) => {
    const f = (window.fixture = {
      pathname: "/students",
      search: "",
      requests: [],
      rosterReads: 0,
      holdRoster: false,
      mode,
    });
    const user = {
      id: "owner",
      email: "owner@example.test",
      legal_first_name: "Test",
      legal_last_name: "Owner",
    };
    const session = { access_token: "synthetic-token", user };
    f.auth = {
      user,
      studio_id: "studio",
      membership_status: "active",
      role: "admin",
      staff_profiles_available: true,
    };
    f.supabase = {
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    };
    f.rows = Array.from({ length: 3 }, (_, index) => ({
      id: `student-${index}`,
      studio_id: "studio",
      legal_first_name: `Full ${index}`,
      legal_last_name: "Roster",
      status: "active",
      tags: [],
      guardians: [],
      programs: [],
      program_memberships: [],
      photo_url: null,
    }));
    f.navigate = (href) => {
      const url = new URL(href, location.href);
      f.pathname = url.pathname;
      f.search = url.search;
      history.pushState(null, "", href);
      window.dispatchEvent(new Event("fixture:navigate"));
    };
    f.api = {
      get: async (path) => {
        if (mode === "preview") throw Error("Preview must not read remote data");
        f.requests.push(path);
        if (path === "/dashboard/workspace")
          return { auth: f.auth, studio: { name: "Test", timezone: "UTC" } };
        if (path.startsWith("/dashboard/bootstrap"))
          return {
            auth: f.auth,
            studio_name: "Test",
            programs: [],
            leads: [],
            students: path.endsWith("view=students") ? f.rows : [],
            students_may_be_partial: mode === "partial",
            belt_ladders: [],
            primary_belt_ladder: null,
          };
        if (path.startsWith("/students?")) {
          f.rosterReads++;
          const items = structuredClone(f.rows);
          if (f.holdRoster)
            await new Promise((resolve) => {
              f.releaseRoster = resolve;
            });
          return {
            items,
            total: f.rows.length,
            has_next: false,
            has_previous: false,
            page_ordinal: 1,
            page_size: 200,
          };
        }
        if (path.startsWith("/programs")) return [];
        if (path === "/billing/landing")
          return {
            financial_access: "available",
            system_status: { payment_account: { studio_id: "studio" }, workflow_capabilities: [] },
            platform_status: null,
            aggregates: { active_student_count: f.rows.length },
            errors: [],
          };
        if (path.startsWith("/billing/") && path.includes("/page"))
          return { items: [], next_cursor: null, complete: true };
        if (path.startsWith("/billing/")) return [];
        throw Error(`Unexpected read ${path}`);
      },
      patch: async (path, data) => {
        const row = f.rows.find((row) => path === `/students/${row.id}`);
        Object.assign(row, data);
        return structuredClone(row);
      },
      post: async (path, data) => {
        if (path === "/students") {
          const row = { ...f.rows[0], ...data, id: "student-new" };
          f.rows.push(row);
          return structuredClone(row);
        }
        if (path === "/students/bulk/archive") {
          f.rows = f.rows.filter((row) => !data.student_ids.includes(row.id));
          return { updated: data.student_ids.length };
        }
        throw Error(`Unexpected write ${path}`);
      },
      postForm: async (path) => {
        const row = f.rows.find((row) => path === `/students/${row.id}/photo`);
        row.photo_url = "https://synthetic.invalid/photo.png";
        return structuredClone(row);
      },
    };
  }, mode);
  await page.addScriptTag({
    content: bundle({
      preview: mode === "preview",
      paged: mode === "metadata" || mode === "preview",
    }),
  });
  await page.waitForFunction(() => fixture.store?.identityReady && fixture.store.programsLoaded);
  return page;
}

async function mutate(page, operation) {
  await page.evaluate(async (operation) => {
    const id =
      fixture.store.students.find((row) => row.status === "active")?.id ?? fixture.rows[0].id;
    if (operation === "edit") await fixture.store.updateStudent(id, { legal_first_name: "Edited" });
    if (operation === "create")
      await fixture.store.addStudent({
        legal_first_name: "New",
        legal_last_name: "Student",
        status: "active",
        guardians: [],
        tags: [],
      });
    if (operation === "archive") await fixture.store.deleteStudents([id]);
    if (operation === "photo")
      await fixture.store.uploadStudentPhoto(
        id,
        new File(["synthetic"], "photo.png", { type: "image/png" }),
      );
  }, operation);
}

async function verifyBillingChoices(page) {
  await page.waitForFunction(() => fixture.billing?.showBillingContent);
  const expected = await page.evaluate(() =>
    fixture.store.students
      .filter((row) => row.status === "active")
      .map((row) => row.id)
      .sort(),
  );
  await expect(page.getByRole("list", { name: "Billing student choices" })).toBeVisible();
  assert.deepEqual(
    await page
      .locator("li[data-student]")
      .evaluateAll((rows) => rows.map((row) => row.dataset.student).sort()),
    expected,
  );
}

for (const mode of ["metadata", "partial", "fallback", "preview"]) {
  for (const operation of ["edit", "create", "archive", "photo"]) {
    test(`${mode} roster ${operation} preserves completeness before Billing Enrollments`, async (t) => {
      const page = await mount(t, mode);
      const incomplete = mode === "metadata" || mode === "partial";
      assert.equal(await page.evaluate(() => fixture.store.studentsLoaded), mode !== "metadata");
      await mutate(page, operation);
      assert.equal(await page.evaluate(() => fixture.store.studentsMayBePartial), incomplete);
      assert.equal(await page.evaluate(() => fixture.rosterReads), 0);
      await page.evaluate((incomplete) => {
        fixture.holdRoster = incomplete;
        fixture.navigate("/billing?tab=enrollments");
      }, incomplete);
      if (incomplete) {
        await page.waitForFunction(
          () => fixture.rosterReads === 1 && Boolean(fixture.releaseRoster),
        );
        assert.equal(await page.getByRole("list", { name: "Billing student choices" }).count(), 0);
        await page.evaluate(() => {
          fixture.holdRoster = false;
          fixture.releaseRoster();
        });
        await page.waitForFunction(
          () => fixture.store.studentsLoaded && !fixture.store.studentsMayBePartial,
        );
        assert.equal(
          await page.evaluate(() => fixture.store.students.length === fixture.rows.length),
          true,
        );
      }
      await verifyBillingChoices(page);
      assert.equal(await page.evaluate(() => fixture.rosterReads), incomplete ? 1 : 0);
    });
  }
}

test("an explicit complete load clears mutation partialness and stays complete through the next mutation", async (t) => {
  const page = await mount(t, "metadata");
  await mutate(page, "edit");
  assert.equal(await page.evaluate(() => fixture.store.studentsMayBePartial), true);
  await page.evaluate(() => fixture.store.refreshStudents());
  await page.waitForFunction(
    () => fixture.store.studentsLoaded && !fixture.store.studentsMayBePartial,
  );
  await mutate(page, "create");
  assert.equal(await page.evaluate(() => fixture.store.studentsMayBePartial), false);
  await page.evaluate(() => fixture.navigate("/billing?tab=enrollments"));
  await verifyBillingChoices(page);
  assert.equal(await page.evaluate(() => fixture.rosterReads), 1);
});

test("conversion lets the newest Enrollments roster read retry its stale snapshot", async (t) => {
  const page = await mount(t, "partial");
  await page.evaluate(async () => {
    const f = fixture,
      get = f.api.get;
    f.lead = { id: "lead", first_name: "New", last_name: "Student", stage: "inquiry" };
    f.api.get = (path, ...args) =>
      path === "/leads" ? Promise.resolve([f.lead]) : get(path, ...args);
    await f.store.refreshLeads();
  });
  await page.waitForFunction(() => fixture.store.leads.length === 1);
  await page.evaluate(() => {
    const f = fixture,
      post = f.api.post;
    f.api.post = (path, ...args) =>
      path === "/leads/lead/convert"
        ? new Promise((resolve) => {
            f.finishConversion = () => {
              f.rows.push({ ...f.rows[0], id: "converted", legal_first_name: "Converted" });
              resolve({ ...f.lead, stage: "enrolled", converted_student_id: "converted" });
            };
          })
        : post(path, ...args);
    f.conversion = f.store.convertLeadToStudent("lead");
    f.holdRoster = true;
    f.navigate("/billing?tab=enrollments");
  });
  await page.waitForFunction(
    () => fixture.rosterReads === 1 && fixture.releaseRoster && fixture.finishConversion,
  );
  await page.evaluate(async () => {
    fixture.finishConversion();
    await fixture.conversion;
  });
  assert.equal(await page.evaluate(() => fixture.store.studentsMayBePartial), true);
  assert.equal(await page.evaluate(() => fixture.rosterReads), 1);
  await page.evaluate(() => {
    fixture.holdRoster = false;
    fixture.releaseRoster();
  });
  await page.waitForFunction(
    () => fixture.store.studentsLoaded && !fixture.store.studentsMayBePartial,
  );
  await verifyBillingChoices(page);
  assert.equal(await page.evaluate(() => fixture.rosterReads), 2);
  assert.equal(await page.locator('li[data-student="converted"]').count(), 1);
  t.diagnostic("Enrollments: 1 stale full read + 1 retry; complete roster includes conversion");
});
