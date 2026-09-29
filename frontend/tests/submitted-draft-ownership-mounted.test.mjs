import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle(moduleName) {
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `exports.useConfigStore=()=>window.fixture.config;exports.useStudioStore=()=>window.fixture.studio;exports.useProgramStore=()=>window.fixture.programs;`,
    "@/lib/api": `exports.api=window.fixture.api;`,
    "@/lib/use-resume-refresh": `exports.useResumeRefresh=()=>{};`,
    "@/lib/performance": `exports.markDashboardReadiness=()=>()=>{};`,
    "next/navigation": `exports.useSearchParams=()=>new URLSearchParams('');`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
    "@/components/header": `exports.Header=()=>null;`,
    "@/components/operations/operations-surface": `exports.OperationsSurface=({children})=>children;exports.OperationsIndex=()=>null;`,
    "@/components/settings/programs-section": `exports.ProgramsSection=()=>null;`,
    "@/components/settings/staff-roles-section": `exports.StaffRolesSection=()=>null;`,
    "@/components/ui/modal-frame": `exports.ModalFrame=()=>null;`,
    "@/components/ui/button": `const React=require('react');exports.Button=({children,onClick,type,disabled,isLoading,asChild})=>asChild?children:React.createElement('button',{onClick,type,disabled:disabled||isLoading},children);`,
    "@/components/account-page-shell": `const React=require('react');exports.AccountPageShell=({children})=>React.createElement('main',null,children);exports.AccountSection=({children,title})=>React.createElement('section',null,React.createElement('h2',null,title),children);exports.AccountNotice=({children})=>React.createElement('div',null,children);`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add(moduleName);
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}require(${dom}).createRoot(document.getElementById('root')).render(require(${react}).createElement(require(${subject}).default));})();`;
}

const sources = {
  settings: bundle("@/app/(dashboard)/settings/page"),
  support: bundle("@/app/(dashboard)/help/contact/page"),
};
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function mount(source) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    const f = (window.fixture = { writes: [] });
    f.config = { token: "fixture-token", isPreviewMode: true };
    f.studio = {
      currentRole: "admin",
      identityGeneration: 1,
      identityReady: true,
      staffLoaded: true,
      staffLoadError: null,
      refreshStaff: async () => {},
      studioName: "Original Studio",
      userEmail: "owner@example.test",
      userName: "Owner",
      setStudioName: (name) =>
        new Promise((resolve, reject) =>
          f.writes.push({
            name,
            resolve: () => {
              f.studio.studioName = name;
              resolve();
            },
            reject,
          }),
        ),
    };
    f.programs = {
      programsLoaded: true,
      programsUsageLoaded: true,
      programsLoadError: null,
      programsUsageLoadError: null,
      refreshPrograms: async () => {},
    };
    f.api = {
      get: () => new Promise(() => {}),
      post: (path, body, token) =>
        new Promise((resolve, reject) => f.writes.push({ path, body, token, resolve, reject })),
    };
  });
  await page.addScriptTag({ content: source });
  return { page, errors };
}

async function repeatClickInOneTick(page, name) {
  await page.getByRole("button", { name }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.waitForFunction(() => fixture.writes.length > 0);
  assert.equal(await page.evaluate(() => fixture.writes.length), 1);
}

test("studio name belongs to its pending save and survives rejection", async () => {
  const { page, errors } = await mount(sources.settings);
  const name = page.getByLabel("Studio Name");
  await name.fill("  Submitted Studio  ");
  await repeatClickInOneTick(page, "Save");
  assert.equal(await page.evaluate(() => fixture.writes[0].name), "Submitted Studio");
  assert.equal(await name.isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Saving..." }).isDisabled(), true);
  await name.press("X");
  assert.equal(await name.inputValue(), "  Submitted Studio  ");
  await page.evaluate(() => fixture.writes[0].reject(new Error("Save failed")));
  await page.getByText("Save failed").waitFor();
  assert.equal(await name.isDisabled(), false);
  assert.equal(await name.inputValue(), "  Submitted Studio  ");
  await name.fill("  Final Studio  ");
  await page.getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => fixture.writes.length === 2);
  await page.evaluate(() => fixture.writes[1].resolve());
  await page.getByText("Settings updated").waitFor();
  assert.equal(await name.inputValue(), "Final Studio");
  assert.deepEqual(errors, []);
  await page.close();
});

test("support draft freezes on send, survives failure, and clears on success", async () => {
  const { page, errors } = await mount(sources.support);
  const labels = [
    "Topic",
    "Priority",
    "Subject",
    "Details",
    "Current page",
    "Expected result",
    "Actual result",
  ];
  const draft = {
    Topic: "bug_report",
    Priority: "high",
    Subject: "Printer jam",
    Details: "The printer jams every morning.",
    "Current page": "https://app.example.test/schedule",
    "Expected result": "Receipt prints",
    "Actual result": "Paper jams",
  };
  for (const [label, value] of Object.entries(draft)) {
    if (label === "Topic" || label === "Priority") await page.getByLabel(label).selectOption(value);
    else await page.getByLabel(label).fill(value);
  }
  await repeatClickInOneTick(page, "Send request");
  assert.equal(await page.evaluate(() => fixture.writes[0].body.subject), "Printer jam");
  for (const label of labels) assert.equal(await page.getByLabel(label).isDisabled(), true, label);
  assert.equal(await page.getByRole("button", { name: "Sending..." }).isDisabled(), true);
  await page.getByLabel("Subject").press("X");
  assert.equal(await page.getByLabel("Subject").inputValue(), "Printer jam");
  await page.evaluate(() => fixture.writes[0].reject(new Error("Support unavailable")));
  await page.getByText("Support unavailable").waitFor();
  for (const [label, value] of Object.entries(draft)) {
    assert.equal(await page.getByLabel(label).isDisabled(), false, label);
    assert.equal(await page.getByLabel(label).inputValue(), value, label);
  }
  const mailto = await page.getByRole("link", { name: "Open email draft" }).getAttribute("href");
  assert.ok(mailto?.startsWith("mailto:support@koaryu.app?"));
  assert.ok(decodeURIComponent(mailto).includes("The printer jams every morning."));
  await page.getByRole("button", { name: "Send request" }).click();
  await page.waitForFunction(() => fixture.writes.length === 2);
  await page.evaluate(() =>
    fixture.writes[1].resolve({
      id: "ticket-12345678",
      subject: "Printer jam",
      topic: "bug_report",
      severity: "high",
      status: "open",
      created_at: "2026-09-29T00:00:00Z",
    }),
  );
  await page.getByText(/Support request sent/).waitFor();
  for (const label of ["Subject", "Details", "Current page", "Expected result", "Actual result"]) {
    assert.equal(await page.getByLabel(label).inputValue(), "", label);
    assert.equal(await page.getByLabel(label).isDisabled(), false, label);
  }
  assert.deepEqual(errors, []);
  await page.close();
});
