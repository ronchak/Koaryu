import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// Reuse the CSS/alias packer, keeping React and Lucide in Node's module cache.
// Only routing is replaced; no browser, server, or hosted service is needed.
const { add, modules } = createCommonJsPacker({
  react: 'module.exports = externalRequire("react");',
  "react/jsx-runtime": 'module.exports = externalRequire("react/jsx-runtime");',
  "lucide-react": 'module.exports = externalRequire("lucide-react");',
  "@/components/intent-prefetch-link": `exports.IntentPrefetchLink = ({ children, ...props }) => require("react").createElement("a", props, children);`,
});
const entries = [
  "@/components/header",
  "@/components/ui/horizon",
  "@/components/ui/horizon-work-row",
  "@/components/ui/horizon-ridges",
].map((entry) => add(entry));
const [header, kit, workRows, ridges] = new Function(
  "externalRequire",
  `const modules = [${modules.join(",")}], cache = {};
   function require(id) {
     if (cache[id]) return cache[id].exports;
     const module = cache[id] = { exports: {} };
     modules[id](module, module.exports, require);
     return module.exports;
   }
   return [${entries.join(",")}].map(require);`,
)(require);
const { Header } = header;
const { HorizonWorkList, HorizonWorkRow, HorizonPanelLink, ToneChip } = kit;
const render = (component, props, ...children) =>
  renderToStaticMarkup(React.createElement(component, props, ...children));
const textContent = (html) => html.replace(/<[^>]*>/g, "");
const forbidden = /--product-cobalt|[\u2192\u2197\u203a]/u;

test("Header defaults to band hills and supports hero hills", () => {
  for (const [props, variant] of [
    [{}, "band"],
    [{ hills: "hero" }, "hero"],
  ]) {
    const html = render(Header, { title: "Home", ...props });
    assert.match(html, new RegExp(`<div[^>]*data-hills="${variant}"`));
    assert.match(html, new RegExp(`<svg[^>]*data-variant="${variant}"`));
  }
});

test("Header reserves one empty hidden description only when requested and absent", () => {
  for (const description of [undefined, null, ""]) {
    const html = render(Header, { title: "Home", reserveDescription: true, description });
    const paragraphs = [...html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)];
    assert.equal(paragraphs.length, 1, "Only the reserved description should render");
    assert.match(paragraphs[0][1], /data-reserved="true"/);
    assert.match(paragraphs[0][1], /aria-hidden="true"/);
    assert.equal(paragraphs[0][2], "", "The reserved line must contain no text or markup");
  }
  assert.doesNotMatch(render(Header, { title: "Home" }), /<p\b|data-reserved/);
  assert.match(
    source("../src/components/header.module.css"),
    /\.description\[data-reserved="true"\]\s*\{[^}]*min-height:\s*1\.5em;/,
    "The empty description must still reserve one line of height",
  );
});

test("Header replaces its reserved description with visible text", () => {
  for (const reserveDescription of [false, true]) {
    const html = render(Header, {
      title: "Home",
      reserveDescription,
      description: "Two classes today.",
    });
    assert.match(html, /<p[^>]*>Two classes today\.<\/p>/);
    assert.equal([...html.matchAll(/<p\b/g)].length, 1);
    assert.doesNotMatch(html, /data-reserved|<p[^>]*aria-hidden/);
  }
});

test("Header puts titleId on the h1 and preserves eyebrow and children", () => {
  const html = render(
    Header,
    { title: "Good morning.", titleId: "home-title", eyebrow: "Saturday, October 10" },
    React.createElement("button", { type: "button" }, "Add student"),
  );
  assert.match(html, /<h1[^>]*id="home-title"[^>]*>Good morning\.<\/h1>/);
  assert.match(html, /<p[^>]*>Saturday, October 10<\/p>/);
  assert.match(html, /<button[^>]*>Add student<\/button>/);
});

test("HorizonWorkList renders a ul with children, optional label, and className", () => {
  const child = React.createElement(HorizonWorkRow, { title: "Two follow-ups" });
  const labeled = render(
    HorizonWorkList,
    { label: "Needs attention", className: "custom-list" },
    child,
  );
  assert.match(labeled, /^<ul\b[^>]*aria-label="Needs attention"/);
  assert.match(labeled, /class="workList custom-list"/);
  assert.match(labeled, /<li\b[^>]*>[\s\S]*Two follow-ups[\s\S]*<\/li><\/ul>$/);
  assert.doesNotMatch(render(HorizonWorkList, {}, child), /aria-label/);
});

test("HorizonWorkRow with href has exactly one link containing title, meta, and action", () => {
  const html = render(HorizonWorkRow, {
    href: "/dashboard/leads?focus=due_today",
    leading: "4:00 PM",
    title: "Two follow-ups",
    meta: "Oldest 2 days overdue",
    action: "Open follow-ups",
  });
  assert.match(html, /^<li\b[^>]*><a\b/);
  assert.equal([...html.matchAll(/<a\b/g)].length, 1, "The whole row must be exactly one link");
  assert.equal([...html.matchAll(/<\/a>/g)].length, 1);
  assert.doesNotMatch(html, /<button\b/, "The row action must not create a nested button");
  const link = html.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
  assert.match(link[1], /href="\/dashboard\/leads\?focus=due_today"/);
  assert.doesNotMatch(link[2], /<a\b|<button\b/);
  for (const text of ["4:00 PM", "Two follow-ups", "Oldest 2 days overdue", "Open follow-ups"]) {
    assert.ok(textContent(link[2]).includes(text), `${text} must be inside the row link`);
  }
});

test("HorizonWorkRow without href uses a plain div and no interactive action", () => {
  const html = render(HorizonWorkRow, { title: "No classes today", action: "The mat is quiet" });
  assert.match(html, /^<li\b[^>]*><div\b[^>]*class="workRow"/);
  assert.match(html, /<\/div><\/li>$/);
  assert.doesNotMatch(html, /<a\b|<button\b|role="(?:link|button)"/);
  assert.ok(textContent(html).includes("The mat is quiet"));
});

test("HorizonWorkRow marks only an emphasized action", () => {
  const props = { href: "/dashboard/schedule", title: "Kids class", action: "Take attendance" };
  assert.match(
    render(HorizonWorkRow, { ...props, emphasized: true }),
    /<span[^>]*class="workAction"[^>]*data-emphasized="true"[^>]*>Take attendance<\/span>/,
  );
  for (const emphasized of [undefined, false]) {
    assert.doesNotMatch(render(HorizonWorkRow, { ...props, emphasized }), /data-emphasized/);
  }
});

test("HorizonWorkRow renders a ToneTag pill with its label and tone", () => {
  for (const tone of ["alert", "warn", "calm", "neutral"]) {
    const html = render(HorizonWorkRow, { title: "Follow-ups", tag: { label: "Due today", tone } });
    assert.match(
      html,
      new RegExp(
        `<span[^>]*class="tag"[^>]*data-tone="${tone}"[^>]*data-dot="true"[^>]*>Due today</span>`,
      ),
    );
  }
  assert.match(
    source("../src/components/ui/horizon.module.css"),
    /\.tag\s*\{[^}]*border-radius:\s*999px;/,
  );
});

test("HorizonWorkRow passes data attributes and className to the li only", () => {
  const html = render(HorizonWorkRow, {
    href: "/dashboard/billing",
    title: "One failed payment",
    className: "custom-row",
    "data-kind": "billing",
    "data-count": 1,
    "data-ready": true,
  });
  const item = html.match(/^<li\b([^>]*)>/)[1];
  assert.match(item, /class="workItem custom-row"/);
  for (const attribute of ['data-kind="billing"', 'data-count="1"', 'data-ready="true"']) {
    assert.ok(item.includes(attribute));
    assert.equal(html.split(attribute).length - 1, 1, `${attribute} belongs only on the li`);
  }
});

test("HorizonWorkRow treats strings, numbers, and time elements as text leading", () => {
  for (const leading of [
    "4:00 PM",
    0,
    React.createElement("time", { dateTime: "16:00" }, "4:00 PM"),
  ]) {
    const html = render(HorizonWorkRow, { title: "Kids class", leading });
    assert.match(html, /<span[^>]*class="workLeading"[^>]*data-leading="text"/);
    assert.doesNotMatch(html, /data-leading="slot"/);
    if (typeof leading === "number") assert.match(html, /data-leading="text">0<\/span>/);
    if (React.isValidElement(leading)) assert.match(html, /<time dateTime="16:00">4:00 PM<\/time>/);
  }
});

test("HorizonWorkRow treats a ToneChip as a leading slot and omits absent leading", () => {
  const html = render(HorizonWorkRow, {
    title: "Follow-ups",
    leading: React.createElement(ToneChip, { tone: "alert" }, "!"),
  });
  assert.match(html, /data-leading="slot"><span[^>]*class="chip"[^>]*data-tone="alert"/);
  for (const leading of [undefined, null, false]) {
    assert.doesNotMatch(render(HorizonWorkRow, { title: "Follow-ups", leading }), /data-leading/);
  }
});

test("HorizonPanelLink renders text and a real aria-hidden ArrowRight svg without unicode arrows", () => {
  const html = render(HorizonPanelLink, { href: "/dashboard/leads" }, "All follow-ups");
  assert.equal([...html.matchAll(/<a\b/g)].length, 1);
  assert.match(html, /href="\/dashboard\/leads"/);
  assert.match(html, /<span>All follow-ups<\/span>/);
  assert.equal(textContent(html), "All follow-ups");
  assert.equal([...html.matchAll(/<svg\b/g)].length, 1);
  const svg = html.match(/<svg\b([^>]*)>/)[1];
  assert.match(svg, /class="[^"]*lucide-arrow-right\b/);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(svg, /focusable="false"/);
  assert.doesNotMatch(html, forbidden);
});

test("horizon exports the shared work-list, row, and panel-link implementations", () => {
  for (const name of ["HorizonWorkList", "HorizonWorkRow", "HorizonPanelLink"]) {
    assert.equal(kit[name], workRows[name], `${name} must be a re-export`);
  }
});

test("draws five closed ridges, far to near", () => {
  assert.equal(ridges.HORIZON_RIDGE_PATHS.length, 5);
  for (const path of ridges.HORIZON_RIDGE_PATHS) {
    assert.match(path, /^M-120\.0 /);
    assert.match(path, /Z$/);
  }
});

test("horizon CSS spans the third stat inside the max-width 1023px block", () => {
  const css = source("../src/components/ui/horizon.module.css");
  const phone = css.match(/@media\s*\(max-width:\s*1023px\)\s*\{([\s\S]*?)^\}/m);
  assert.ok(phone, "The 1023px media block must exist");
  assert.match(
    phone[1],
    /\.stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/,
  );
  assert.match(
    phone[1],
    /\.stat:last-child:nth-child\(odd\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/,
    "The odd last stat must span both phone columns within this media block",
  );
});

test("Header CSS contains no grain or noise rules", () => {
  assert.doesNotMatch(source("../src/components/header.module.css"), /grain|noise/i);
});

test("kit sources and rendered markup contain no cobalt token or unicode arrows", () => {
  const paths = [
    "../src/components/header.tsx",
    "../src/components/header.module.css",
    ...readdirSync(new URL("../src/components/ui/", import.meta.url))
      .filter((name) => /^horizon(?:-|\.)/.test(name) && /\.(?:tsx?|css)$/.test(name))
      .map((name) => `../src/components/ui/${name}`),
  ];
  for (const path of paths) assert.doesNotMatch(source(path), forbidden, path);
  const html = render(
    React.Fragment,
    null,
    React.createElement(Header, { title: "Home", hills: "hero", reserveDescription: true }),
    React.createElement(
      kit.HorizonPage,
      null,
      React.createElement(kit.HorizonStats, {
        label: "Today",
        items: [{ id: "classes", label: "Classes", value: 3, href: "/dashboard/schedule" }],
      }),
      React.createElement(
        kit.HorizonPanel,
        {
          title: "Needs attention",
          actions: React.createElement(
            HorizonPanelLink,
            { href: "/dashboard/leads" },
            "All follow-ups",
          ),
        },
        React.createElement(
          HorizonWorkList,
          null,
          React.createElement(HorizonWorkRow, {
            title: "Two follow-ups",
            href: "/dashboard/leads",
            leading: React.createElement(ToneChip, { tone: "warn" }, "!"),
            tag: { label: "Due today", tone: "warn" },
            action: "Open follow-ups",
          }),
        ),
        React.createElement(kit.CalmState, { title: "All clear" }),
        React.createElement(kit.HorizonToolbar, { label: "Filters" }, "Today"),
      ),
    ),
  );
  assert.doesNotMatch(html, forbidden);
});
