import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle() {
  const stubs = {
    "next/navigation": `exports.useRouter=()=>({push:p=>window.f.navigation.push(p)});`,
    "@/lib/api": `exports.api={get:async(path)=>path==='/leads'?[...window.f.leads]:[],post:(...args)=>window.f.request('post',...args),patch:(...args)=>window.f.request('patch',...args)};exports.CommandOutcomeUnknown=require('@/lib/command-outcome').CommandOutcomeUnknown;window.f.Unknown=exports.CommandOutcomeUnknown;`,
    "@/components/programs/program-picker": `exports.ProgramBadge=()=>null;`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "./leads-ledger.module.css": `module.exports={};`,
  };
  const { add, modules } = createCommonJsPacker(stubs);
  const react = add("react"),
    dom = add("react-dom/client");
  const resource = add("@/lib/store-resource-scope");
  const hook = add("@/lib/leads-page-controller"),
    actions = add("@/lib/store-lead-actions");
  const board = add("@/components/leads/lead-pipeline-board"),
    detail = add("@/components/leads/lead-detail-modal");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
  const React=require(${react}),f=window.f;
  function App(){
    const [leads,setLeads]=React.useState(f.initialLeads), [scope,setScope]=React.useState(1),[token,setToken]=React.useState('token-1');
    f.setScope=setScope;f.setToken=setToken;f.setLeads=setLeads; f.scope=scope;
    const leadsRef=React.useRef(leads);leadsRef.current=leads;
    const studentsRef=React.useRef([]), scopeRef=React.useRef(require(${resource}).createResourceScope());
    const a=require(${actions}).useStoreLeadActions({leadsRef,studentsRef,leadMutationScopeRef:scopeRef,businessDateRef:{current:'2026-09-26'},beginLeadMutation:()=>require(${resource}).beginResourceMutation(scopeRef.current),beginLiveAuthRequest:()=>({token,isCurrent:()=>f.scope===scope,isSameIdentity:()=>f.scope===scope}),beltLaddersRef:{current:[]},beltRanksRef:{current:[]},isPreviewMode:f.preview,programsRef:{current:[]},persistLeads:setLeads,persistStudents:v=>{studentsRef.current=v;f.students=v;},onStudentMutation:()=>f.studentMutations++,refreshStudents:async()=>{f.refreshes++;if(f.failRefresh)throw Error('refresh failed');return [];},setLeads,setLeadsLoaded:()=>{},setLeadsLoadError:()=>{}});
    const c=require(${hook}).useLeadsPageController({...a,baseLeads:leads,currentRole:'admin',identityGeneration:scope,identityReady:true,isPreviewMode:f.preview,programs:[],today:'2026-09-26',token});f.c=c;f.actions=a;f.leads=leads;
    const selected=c.model.selectedLead;
    return React.createElement(React.Fragment,null,
      React.createElement(require(${board}).LeadPipelineBoard,{canManageLeads:true,canConvertLeads:true,leads:c.model.leads??leads,pendingLeadIds:c.pendingLeadIds,unknownFollowUpLeadIds:c.unknownFollowUpLeadIds,programById:new Map(),staffById:new Map(),today:'2026-09-26',onAddLead:c.openAddLeadModal,onKeyboardMoveLead:c.handleKeyboardMoveLead,onSelectLead:c.selectLead}),
      selected?React.createElement(require(${detail}).LeadDetailInspector,{lead:selected,activities:c.selectedLeadActivities,activityError:null,activityStatus:'ready',activeStaff:[],currentAssignedStaff:null,canManageLeads:true,canConvertLeads:true,followUpValue:c.getFollowUpInputValue(selected),leadActionError:c.leadActionError,leadActionMessage:c.actionMessage,pendingLeadIds:c.pendingLeadIds,followUpOutcomeUnknown:c.unknownFollowUpLeadIds?.has(selected.id),onRetryFollowUp:c.handleRetryFollowUp,programById:new Map(),today:'2026-09-26',onAssignStaff:c.handleAssignedStaff,onClose:c.clearSelectedLead,onConvertLead:c.handleConvertLead,onDismissError:c.dismissLeadActionError,onDismissMessage:c.dismissActionMessage,onFollowUpValueChange:c.setFollowUpInputValue,onMarkContacted:c.handleMarkContacted,onMarkLost:c.handleMarkLost,onRetryActivities:c.retrySelectedLeadActivities,onRescheduleLead:c.handleRescheduleLead,onStageSelection:c.handleStageSelection}):null);
  }f.root=require(${dom}).createRoot(document.getElementById('root'));f.root.render(React.createElement(App));})();`;
}
const flush = (p) =>
  p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function mount(browser, { preview = false, stage = "inquiry" } = {}) {
  const p = await browser.newPage();
  await p.route("**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await p.goto("http://localhost/");
  await p.evaluate(
    ({ preview, stage }) => {
      window.f = {
        preview,
        navigation: [],
        writes: [],
        refreshes: 0,
        studentMutations: 0,
        initialLeads: ["a", "b"].map((id) => ({
          id,
          first_name: id.toUpperCase(),
          last_name: "Lead",
          stage,
          source: "website",
          follow_up_date: "2026-09-26",
          created_at: "2026-09-01T00:00:00Z",
          is_minor: false,
        })),
        request(method, path, body, token) {
          return new Promise((resolve, reject) =>
            this.writes.push({ method, path, body, token, resolve, reject }),
          );
        },
      };
    },
    { preview, stage },
  );
  await p.addScriptTag({ content: bundle() });
  await p.waitForFunction(() => window.f.c);
  return p;
}
async function settle(p, index, { unknown = false, fail = false } = {}) {
  await p.evaluate(
    ({ index, unknown, fail }) => {
      const f = window.f,
        w = f.writes[index];
      if (unknown) w.reject(new f.Unknown());
      else if (fail) w.reject(Error("Confirmed command rejection"));
      else {
        const id = w.path.split("/")[2],
          lead = f.leads.find((l) => l.id === id),
          stage = w.body.next_stage ?? w.body.stage ?? lead.stage;
        w.resolve({
          ...lead,
          ...w.body,
          stage,
          follow_up_date: null,
          converted_student_id: stage === "enrolled" ? "student-" + id : null,
        });
      }
    },
    { index, unknown, fail },
  );
  await flush(p);
}

for (const order of [
  [0, 1],
  [1, 0],
])
  test(`row controls remain owned with A/B settling ${order}`, async () => {
    const browser = await chromium.launch();
    try {
      const p = await mount(browser);
      await p.getByRole("button", { name: "Move A Lead to the next stage", exact: true }).click();
      await p.getByRole("button", { name: "Move B Lead to the next stage", exact: true }).click();
      assert.equal(await p.evaluate(() => f.writes.length), 2);
      for (const name of ["A", "B"])
        assert.equal(
          await p
            .getByRole("button", { name: `Move ${name} Lead to the next stage`, exact: true })
            .isDisabled(),
          true,
        );
      await settle(p, order[0]);
      assert.equal(
        await p
          .getByRole("button", {
            name: `Move ${order[1] === 0 ? "A" : "B"} Lead to the next stage`,
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await settle(p, order[1]);
      assert.equal(
        await p
          .getByRole("button", { name: "Move A Lead to the next stage", exact: true })
          .isDisabled(),
        false,
      );
    } finally {
      await browser.close();
    }
  });

test("same-turn and cross-control actions share one synchronous lead owner", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser);
    await p.locator('[data-lead-id="a"]').click();
    await p.evaluate(() => {
      const c = f.c,
        a = f.leads[0];
      void c.handleMarkContacted(a, true);
      void c.handleMarkContacted(a, true);
      void c.handleAssignedStaff(a, null);
      void c.handleMarkLost(a, "other");
      void c.handleRescheduleLead(a);
      void c.handleKeyboardMoveLead(a, 1);
      void c.handleConvertLead(a);
    });
    assert.equal(await p.evaluate(() => f.writes.length), 1);
    assert.equal(await p.evaluate(() => f.writes[0].path), "/leads/a/follow-up");
    await settle(p, 0, { fail: true });
    assert.equal(
      await p.getByRole("button", { name: "Mark contacted", exact: true }).isDisabled(),
      false,
    );
    assert.equal(await p.evaluate(() => f.leads[0].stage), "inquiry");
    assert.equal(await p.evaluate(() => f.writes.length), 1);
  } finally {
    await browser.close();
  }
});

test("lost-response retry keeps the original key and displayed target and blocks conflicting actions", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser);
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Move to Trial Scheduled", exact: true }).click();
    const body = await p.evaluate(() => f.writes[0].body);
    assert.equal(body.next_stage, "trial_scheduled");
    assert.match(body.operation_id, /^[0-9a-f-]{36}$/);
    await settle(p, 0, { unknown: true });
    await p.evaluate(() => {
      f.setLeads(f.leads.map((l) => (l.id === "a" ? { ...l, stage: "trial_completed" } : l)));
    });
    await flush(p);
    await p.evaluate(() => {
      void f.c.handleAssignedStaff(f.leads[0], null);
      void f.c.handleMarkContacted(f.leads[0], false);
    });
    assert.equal(await p.evaluate(() => f.writes.length), 1);
    await p.getByRole("button", { name: "Retry follow-up", exact: true }).click();
    assert.deepEqual(await p.evaluate(() => f.writes[1].body), body);
    await settle(p, 1);
    assert.equal(await p.evaluate(() => f.leads[0].stage), "trial_completed");
    assert.equal(
      await p.getByRole("button", { name: "Mark contacted", exact: true }).isDisabled(),
      false,
    );
  } finally {
    await browser.close();
  }
});

test("old access completion cannot clear a new owner, show notices or navigate", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser, { stage: "offer_sent" });
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Convert now", exact: true }).click();
    await p.evaluate(() => f.setScope(2));
    await flush(p);
    await p.evaluate(() => {
      f.c.selectLead("a");
      void f.c.handleAssignedStaff(f.leads[0], "staff-2");
    });
    await flush(p);
    await settle(p, 0);
    assert.deepEqual(await p.evaluate(() => f.navigation), []);
    assert.equal(await p.evaluate(() => f.c.pendingLeadIds.has("a")), true);
    assert.equal(await p.evaluate(() => f.c.actionMessage), null);
    assert.equal(await p.evaluate(() => f.c.model.selectedLead.assigned_staff_id), "staff-2");
    assert.equal(await p.evaluate(() => f.leads[0].stage), "offer_sent");
    await settle(p, 1);
  } finally {
    await browser.close();
  }
});

test("completion for A does not close selected B and renewal preserves confirmed enrollment despite refresh failure", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser, { stage: "offer_sent" });
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Convert now", exact: true }).click();
    await p.locator('[data-lead-id="b"]').click();
    await p.evaluate(() => {
      f.failRefresh = true;
      f.setToken("renewed");
    });
    await flush(p);
    await settle(p, 0);
    assert.equal(await p.evaluate(() => f.c.model.selectedLead.id), "b");
    assert.deepEqual(await p.evaluate(() => f.navigation), []);
    assert.equal(await p.evaluate(() => f.leads[0].stage), "enrolled");
    assert.equal(await p.evaluate(() => f.refreshes), 1);
    assert.equal(await p.evaluate(() => f.c.leadActionError), null);
  } finally {
    await browser.close();
  }
});

test("preview follow-up uses the same action without HTTP", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser, { preview: true });
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Move to Trial Scheduled", exact: true }).click();
    await flush(p);
    assert.equal(await p.evaluate(() => f.writes.length), 0);
    assert.equal(await p.evaluate(() => f.leads[0].stage), "trial_scheduled");
    assert.equal(await p.evaluate(() => f.leads[0].follow_up_date), null);
  } finally {
    await browser.close();
  }
});

test("an unknown follow-up can be reopened and remains reserved after a rejected retry", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser);
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Mark contacted", exact: true }).click();
    const body = await p.evaluate(() => f.writes[0].body);
    assert.equal(body.next_stage, null);
    await settle(p, 0, { unknown: true });
    await p.getByRole("button", { name: "Close lead details", exact: true }).click();
    await flush(p);
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Retry follow-up", exact: true }).click();
    await settle(p, 1, { fail: true });
    assert.equal(
      await p.getByRole("button", { name: "Mark contacted", exact: true }).isDisabled(),
      true,
    );
    await p.getByRole("button", { name: "Retry follow-up", exact: true }).click();
    assert.deepEqual(await p.evaluate(() => f.writes[2].body), body);
    await settle(p, 2);
  } finally {
    await browser.close();
  }
});

test("direct conversion shares row ownership and stale failure cannot overwrite current notices", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser);
    await p.locator('[data-lead-id="a"]').click();
    await p.evaluate(() => {
      void f.c.handleConvertLead(f.leads[0]);
      void f.c.handleMarkContacted(f.leads[0], true);
      void f.c.handleAssignedStaff(f.leads[1], null);
    });
    await flush(p);
    assert.deepEqual(await p.evaluate(() => f.writes.map((w) => w.path)), [
      "/leads/a/convert",
      "/leads/b",
    ]);
    await p.evaluate(() => f.setScope(2));
    await flush(p);
    await p.evaluate(() => void f.c.handleAssignedStaff(f.leads[0], null));
    await flush(p);
    await settle(p, 2);
    const message = await p.evaluate(() => f.c.actionMessage);
    await settle(p, 0, { fail: true });
    assert.equal(await p.evaluate(() => f.c.actionMessage), message);
    assert.equal(await p.evaluate(() => f.c.leadActionError), null);
  } finally {
    await browser.close();
  }
});

test("preview enrollment uses existing student conversion defaults without HTTP", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser, { preview: true, stage: "offer_sent" });
    await p.locator('[data-lead-id="a"]').click();
    await p.getByRole("button", { name: "Convert now", exact: true }).click();
    await flush(p);
    assert.equal(await p.evaluate(() => f.writes.length), 0);
    assert.equal(await p.evaluate(() => f.leads[0].stage), "enrolled");
    assert.equal(await p.evaluate(() => f.students.length), 1);
    assert.equal(await p.evaluate(() => f.navigation.length), 1);
  } finally {
    await browser.close();
  }
});

test("board conversion still opens the new student when no inspector is selected", async () => {
  const browser = await chromium.launch();
  try {
    const p = await mount(browser, { stage: "offer_sent" });
    await p.getByRole("button", { name: "Move A Lead to the next stage", exact: true }).click();
    assert.equal(await p.evaluate(() => f.writes[0].path), "/leads/a/convert");
    await p.evaluate(() =>
      f.writes[0].resolve({ ...f.leads[0], stage: "enrolled", converted_student_id: "student-a" }),
    );
    await flush(p);
    assert.deepEqual(await p.evaluate(() => f.navigation), ["/students/student-a"]);
  } finally {
    await browser.close();
  }
});
