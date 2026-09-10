import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function mountBundle(entry, fixtureSource) {
  const modules = [];
  const ids = new Map();

  function add(request, importer = frontend) {
    const path = request.startsWith("@/")
      ? resolve(frontend, "src", request.slice(2))
      : request.startsWith(".")
        ? resolve(dirname(importer), request)
        : require.resolve(request, { paths: [frontend] });
    const candidates = [path, `${path}.ts`, `${path}.tsx`, `${path}.js`];
    const key = candidates.find((candidate) => {
      try {
        readFileSync(candidate);
        return true;
      } catch {
        return false;
      }
    }) ?? path;
    if (ids.has(key)) return ids.get(key);

    const id = modules.length;
    ids.set(key, id);
    modules.push("");
    let source = readFileSync(key, "utf8");
    if (/\.[cm]?[jt]sx?$/.test(key)) {
      source = ts.transpileModule(source, {
        fileName: key,
        compilerOptions: {
          esModuleInterop: true,
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
    }
    source = source.replace(/require\(["']([^"']+)["']\)/g, (_, dependency) =>
      `require(${add(dependency, key)})`
    );
    modules[id] = `function(module,exports,require){${source}\n}`;
    return id;
  }

  const react = add("react");
  const dom = add("react-dom/client");
  const component = add(entry);
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const createRoot=require(${dom}).createRoot;const Subject=require(${component});${fixtureSource}})();`;
}

async function openFixture(browser) {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.request().url() === "http://localhost/"
    ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
    : route.abort());
  await page.goto("http://localhost/");
  return page;
}

test("Button asChild forwards attributes and ref while composing click handlers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser);
    await page.addScriptTag({ content: mountBundle("@/components/ui/button", `
      const {Button}=Subject;
      const root=createRoot(document.getElementById('root'));
      window.fixture={childClicks:0,wrapperClicks:0,childCleanups:0,wrapperCleanups:0,refTag:null};
      const childRef=node=>{window.fixture.refTag=node?.tagName??null;return ()=>window.fixture.childCleanups++;};
      const wrapperRef=node=>{window.fixture.refTag=node?.tagName??null;return ()=>window.fixture.wrapperCleanups++;};
      function render(disabled=false){root.render(React.createElement(Button,{
        asChild:true,disabled,tabIndex:7,'aria-disabled':false,title:'Account export','aria-label':'Open export','data-contract':'forwarded',
        ref:wrapperRef,
        onClick:()=>window.fixture.wrapperClicks++,
      },React.createElement('a',{href:'#export',tabIndex:3,'aria-disabled':true,ref:childRef,onClick:event=>{window.fixture.childClicks++;event.preventDefault();}},'Export')));}
      window.fixture.childObject={current:null};
      window.fixture.legacyRefCalls=[];
      window.fixture.renderLegacy=()=>root.render(React.createElement(Button,{asChild:true,ref:node=>window.fixture.legacyRefCalls.push(node?.tagName??null)},React.createElement('a',{href:'#legacy',ref:window.fixture.childObject},'Legacy refs')));
      window.fixture.clearRefs=()=>root.render(React.createElement('p',null,'Cleared'));
      window.fixture.render=render;render();
    `) });

    const link = page.getByRole("link", { name: "Open export" });
    await link.click();
    assert.deepEqual(await page.evaluate(() => ({
      childClicks: window.fixture.childClicks,
      wrapperClicks: window.fixture.wrapperClicks,
      refTag: window.fixture.refTag,
      data: document.querySelector("a")?.dataset.contract,
      title: document.querySelector("a")?.title,
      tabIndex: document.querySelector("a")?.tabIndex,
      disabled: document.querySelector("a")?.getAttribute("aria-disabled"),
      hash: location.hash,
    })), {
      childClicks: 1,
      wrapperClicks: 1,
      refTag: "A",
      data: "forwarded",
      title: "Account export",
      tabIndex: 7,
      disabled: "false",
      hash: "",
    });

    await page.evaluate(() => {
      history.replaceState(null, "", location.pathname);
      window.fixture.render(true);
    });
    await link.click({ force: true });
    assert.deepEqual(await page.evaluate(() => ({
      childClicks: window.fixture.childClicks,
      wrapperClicks: window.fixture.wrapperClicks,
      disabled: document.querySelector("a")?.getAttribute("aria-disabled"),
      tabIndex: document.querySelector("a")?.tabIndex,
      hash: location.hash,
    })), { childClicks: 1, wrapperClicks: 1, disabled: "true", tabIndex: -1, hash: "" });

    await page.evaluate(() => window.fixture.renderLegacy());
    await page.getByRole("link", { name: "Legacy refs" }).waitFor();
    assert.deepEqual(await page.evaluate(() => ({
      childCleanups: window.fixture.childCleanups,
      wrapperCleanups: window.fixture.wrapperCleanups,
      childObjectTag: window.fixture.childObject.current?.tagName,
      legacyRefCalls: window.fixture.legacyRefCalls,
    })), { childCleanups: 2, wrapperCleanups: 2, childObjectTag: "A", legacyRefCalls: ["A"] });
    await page.evaluate(() => window.fixture.clearRefs());
    await page.getByText("Cleared").waitFor();
    assert.deepEqual(await page.evaluate(() => ({
      childObject: window.fixture.childObject.current,
      legacyRefCalls: window.fixture.legacyRefCalls,
    })), { childObject: null, legacyRefCalls: ["A", null] });
  } finally {
    await browser.close();
  }
});

test("System theme follows media changes when storage throws", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await openFixture(browser);
    await page.evaluate(() => {
      const listeners = new Set();
      window.fixture = { media: { matches: false } };
      window.matchMedia = () => ({
        get matches() { return window.fixture.media.matches; },
        addEventListener: (_name, listener) => listeners.add(listener),
        removeEventListener: (_name, listener) => listeners.delete(listener),
      });
      window.fixture.dispatchMedia = () => listeners.forEach((listener) => listener());
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } },
      });
    });
    await page.addScriptTag({ content: mountBundle("@/components/theme-provider", `
      const {ThemeProvider,useTheme}=Subject;
      function Observer(){const theme=useTheme();window.fixture.theme=theme;return React.createElement('output',null,theme.preference+':'+theme.resolvedTheme);}
      createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(Observer)));
    `) });
    await page.waitForFunction(() => window.fixture.theme);
    await page.evaluate(() => window.fixture.theme.setTheme("system"));
    await page.getByText("system:dark").waitFor();
    await page.evaluate(() => {
      window.fixture.media.matches = true;
      window.fixture.dispatchMedia();
    });
    await page.getByText("system:light").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  } finally {
    await browser.close();
  }
});
