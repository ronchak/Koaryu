import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Real AccountNameSection and Button. The store is a synthetic external store
// whose updateUserName settles only when the test says so; no auth or network.
function bundle() {
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `const React=require("react");exports.useStudioStore=()=>React.useSyncExternalStore(window.fixture.subscribe,window.fixture.getState);`,
    "@/components/account-page-shell": `const React=require("react");exports.AccountSection=({title,children})=>React.createElement("section",null,React.createElement("h2",null,title),children);`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add("@/components/account/account-name-section");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}require(${dom}).createRoot(document.getElementById('root')).render(require(${react}).createElement(require(${subject}).AccountNameSection));})();`;
}

async function mountSection(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    const listeners = new Set();
    const f = (window.fixture = { calls: [], pending: null });
    f.setState = (patch) => {
      f.state = { ...f.state, ...patch };
      listeners.forEach((listener) => listener());
    };
    f.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    f.getState = () => f.state;
    f.state = {
      legalFirstName: "Avery",
      legalLastName: "Stone",
      staffProfilesAvailable: true,
      userEmail: "owner@example.test",
      userName: "Owner Name",
      updateUserName: (name) => {
        f.calls.push(name);
        return new Promise((resolve, reject) => {
          f.pending = {
            succeed: () => {
              f.setState({ userName: name });
              resolve();
            },
            fail: (message) => reject(new Error(message)),
          };
        });
      },
    };
  });
  await page.addScriptTag({ content: bundle() });
  const input = page.getByLabel("Display name");
  await input.waitFor();
  return { errors, input, page };
}

test("display name is locked while saving so newer typing cannot be discarded on success", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { errors, input, page } = await mountSection(browser);
    assert.equal(await input.inputValue(), "Owner Name");

    await input.fill("Ari Lane");
    await page.getByRole("button", { name: "Save display name" }).click();
    await page.getByRole("button", { name: "Saving..." }).waitFor();

    assert.equal(await input.isDisabled(), true);
    await assert.rejects(input.fill("Ari Lane Newer", { timeout: 300 }));
    assert.equal(await input.inputValue(), "Ari Lane");

    await page.evaluate(() => window.fixture.pending.succeed());
    await page.getByText("Display name updated.", { exact: true }).waitFor();

    assert.equal(await input.isEnabled(), true);
    assert.equal(await input.inputValue(), "Ari Lane");
    assert.equal(await page.getByRole("button", { name: "Save display name" }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ["Ari Lane"]);
    assert.deepEqual(
      await page.evaluate(() => [
        window.fixture.state.legalFirstName,
        window.fixture.state.legalLastName,
      ]),
      ["Avery", "Stone"],
    );
    assert.equal(await page.getByLabel("Legal first name").inputValue(), "Avery");
    assert.equal(await page.getByLabel("Legal last name").inputValue(), "Stone");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("a failed display-name save keeps the submitted draft editable and retryable", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { errors, input, page } = await mountSection(browser);

    await input.fill("  Ari Lane  ");
    await page.getByRole("button", { name: "Save display name" }).click();
    await page.getByRole("button", { name: "Saving..." }).waitFor();
    assert.equal(await input.isDisabled(), true);

    await page.evaluate(() => window.fixture.pending.fail("Profile service unavailable"));
    await page.getByText("Profile service unavailable", { exact: true }).waitFor();

    assert.equal(await input.isEnabled(), true);
    assert.equal(await input.inputValue(), "  Ari Lane  ");
    assert.equal(await page.evaluate(() => window.fixture.state.userName), "Owner Name");
    assert.equal(await page.getByRole("button", { name: "Save display name" }).isEnabled(), true);

    await input.fill("Ari Lane Jr");
    await page.getByRole("button", { name: "Save display name" }).click();
    await page.evaluate(() => window.fixture.pending.succeed());
    await page.getByText("Display name updated.", { exact: true }).waitFor();

    assert.equal(await input.inputValue(), "Ari Lane Jr");
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), ["Ari Lane", "Ari Lane Jr"]);
    assert.equal(await page.getByText("Profile service unavailable").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
