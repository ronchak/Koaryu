import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { canAccessSettings } from "../src/app/(dashboard)/settings/access-policy.ts";

const pageSource = readFileSync(
  new URL("../src/app/(dashboard)/settings/page.tsx", import.meta.url),
  "utf8"
);

describe("settings access policy", () => {
  it("allows only admins, including a fail-closed null role", () => {
    for (const [role, expected] of [
      ["admin", true],
      ["instructor", false],
      ["front_desk", false],
      [null, false],
    ]) {
      assert.equal(canAccessSettings(role), expected, `role ${String(role)}`);
    }
  });
});

describe("settings route access boundary", () => {
  it("uses the policy, keeps the notice local, and mounts settings content only for admins", () => {
    assert.match(pageSource, /import \{ canAccessSettings \} from "\.\/access-policy";/);
    assert.match(pageSource, /const \{ currentRole \} = useStudioStore\(\);/);
    assert.match(
      pageSource,
      /canAccessSettings\(currentRole\) \? <AdminSettingsContent \/> : <SettingsAccessNotice \/>/
    );

    const noticeStart = pageSource.indexOf("function SettingsAccessNotice()");
    const adminContentStart = pageSource.indexOf("function AdminSettingsContent()");
    assert.ok(noticeStart >= 0 && noticeStart < adminContentStart);

    const noticeSource = pageSource.slice(noticeStart, adminContentStart);
    assert.match(noticeSource, /<h2[^>]*>\s*Admin access required\s*<\/h2>/);
    assert.match(
      noticeSource,
      /Only studio admins can view and manage studio settings\. Ask a studio admin if you need access\./
    );
    assert.doesNotMatch(noticeSource, /<button\b|onDismiss|DismissibleNotice/);

    const adminContentSource = pageSource.slice(adminContentStart);
    for (const marker of [
      "useEffect(",
      "<ProgramsSection />",
      "<StaffRolesSection />",
      "<ModalFrame",
      '"/demo/capabilities"',
    ]) {
      assert.match(adminContentSource, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    assert.doesNotMatch(pageSource, /\buseRouter\b|\brouter\.(?:push|replace|back|refresh)\b|\bredirect\s*\(/);
  });
});
