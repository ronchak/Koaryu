import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const rootSource = readFileSync(
  new URL("../src/components/marketing/marketing-root.tsx", import.meta.url),
  "utf8"
);
const primitivesSource = readFileSync(
  new URL("../src/components/marketing/marketing-primitives.tsx", import.meta.url),
  "utf8"
);
const foundationCss = readFileSync(
  new URL(
    "../src/components/marketing/marketing-foundation.module.css",
    import.meta.url
  ),
  "utf8"
);
const globalsCss = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8"
);

const canonicalTokens = new Map([
  ["paper", "#f7f3e9"],
  ["ink", "#3b2f1c"],
  ["ink-light", "#f4eee1"],
  ["sheet", "#f2e9d8"],
  ["sheet-raised", "#fbf7ee"],
  ["sheet-warm", "#e9ddc8"],
  ["deep-brown", "#493718"],
  ["beam", "#56431f"],
  ["beam-light", "#6b5230"],
  ["wood", "#9b7e4f"],
  ["wood-pale", "#c6b183"],
  ["line", "rgb(59 47 28 / 18%)"],
  ["rule", "rgb(59 47 28 / 28%)"],
  ["rule-soft", "rgb(59 47 28 / 14%)"],
]);

describe("marketing foundation", () => {
  it("owns an explicit route scope and both server-renderable layout modes", () => {
    assert.match(rootSource, /data-koaryu-marketing=""/);
    assert.match(rootSource, /type MarketingLayoutMode = "document" \| "viewport"/);
    assert.match(rootSource, /layout = "document"/);
    assert.match(rootSource, /data-layout=\{layout\}/);
    assert.match(foundationCss, /\.document\s*\{[^}]*min-height:\s*100dvh/s);
    assert.match(
      foundationCss,
      /\.viewport\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden/s
    );
    assert.doesNotMatch(
      `${rootSource}\n${primitivesSource}`,
      /["']use client["']|\b(?:window|document|navigator)\s*\.|requestAnimationFrame|use(?:State|Effect|Ref)\s*\(/
    );
  });

  it("defines the complete canonical palette only on the marketing root", () => {
    const rootRule = foundationCss.match(
      /\[data-koaryu-marketing\]\.root\s*\{(?<body>[\s\S]*?)\n\}/
    );
    assert.ok(rootRule?.groups?.body, "marketing root rule must own the tokens");

    for (const [name, value] of canonicalTokens) {
      assert.match(
        rootRule.groups.body,
        new RegExp(`--koaryu-${name}:\\s*${value.replace(/[()/%]/g, "\\$&")};`),
        `missing --koaryu-${name}`
      );
      assert.equal(
        foundationCss.match(new RegExp(`--koaryu-${name}:`, "g"))?.length,
        1,
        `--koaryu-${name} must have one scoped definition`
      );
    }

    assert.doesNotMatch(
      foundationCss,
      /--(?:bg|surface(?:-[\w-]+)?|border|text-[\w-]+|accent(?:-[\w-]+)?):/
    );
  });

  it("keeps the exact inert, scoped fibre recipe", () => {
    const fibreRule = foundationCss.match(
      /\[data-koaryu-marketing\]\.root::after\s*\{(?<body>[\s\S]*?)\n\}/
    );
    assert.ok(fibreRule?.groups?.body, "fibre must belong to the marketing root");

    for (const contract of [
      "viewBox='0 0 180 180'",
      "baseFrequency='.035 .72'",
      "numOctaves='3'",
      "seed='41'",
      "type='saturate'",
      "values='0'",
      "opacity='.42'",
    ]) {
      assert.ok(fibreRule.groups.body.includes(contract), `missing fibre ${contract}`);
    }

    assert.match(fibreRule.groups.body, /pointer-events:\s*none/);
    assert.match(fibreRule.groups.body, /opacity:\s*0\.095/);
    assert.match(fibreRule.groups.body, /mix-blend-mode:\s*multiply/);
    assert.doesNotMatch(foundationCss, /@keyframes|animation:/);
  });

  it("keeps product tokens in globals and marketing ownership out of globals", () => {
    assert.match(globalsCss, /:root,\s*\n\[data-theme="dark"\]\s*\{/);
    for (const token of ["bg", "surface", "border", "text-primary", "accent"]) {
      assert.match(globalsCss, new RegExp(`--${token}:`));
    }
    assert.doesNotMatch(globalsCss, /data-koaryu-marketing|--koaryu-/);
  });

  it("exports paper-native links and a stateless native menu button", () => {
    for (const component of [
      "MarketingBrandLink",
      "MarketingNavLink",
      "MarketingActionLink",
      "MarketingMenuButton",
    ]) {
      assert.match(primitivesSource, new RegExp(`export function ${component}\\b`));
    }

    assert.match(primitivesSource, /ComponentPropsWithoutRef<typeof Link>/);
    assert.match(primitivesSource, /ButtonHTMLAttributes<HTMLButtonElement>/);
    assert.match(primitivesSource, /variant\?: "primary" \| "secondary"/);
    assert.match(primitivesSource, /className=\{joinClassNames\(/);
    assert.match(primitivesSource, /<button/);
    assert.match(primitivesSource, /aria-expanded=\{ariaExpanded\}/);
    assert.match(primitivesSource, /aria-hidden="true"/);
  });

  it("uses the 44px, current-color, radius, focus, and hover contracts", () => {
    assert.match(
      foundationCss,
      /\.actionLink\s*\{[^}]*min-height:\s*44px;[^}]*border:\s*1px solid currentColor;[^}]*border-radius:\s*7px/s
    );
    assert.match(foundationCss, /\.primaryAction\s*\{[^}]*background:\s*currentColor/s);
    assert.match(foundationCss, /\.secondaryAction\s*\{[^}]*background:\s*transparent/s);
    assert.match(foundationCss, /\.actionLink:hover\s*\{[^}]*translateY\(-2px\)/s);
    assert.match(
      foundationCss,
      /\.menuButton\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*border-radius:\s*50%;[^}]*color:\s*inherit/s
    );
    assert.match(
      foundationCss,
      /\.menuButton:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor;[^}]*outline-offset:\s*4px/s
    );
    assert.doesNotMatch(
      foundationCss,
      /var\(--(?:bg|surface|border|text-[\w-]+|accent)/
    );
  });
});
