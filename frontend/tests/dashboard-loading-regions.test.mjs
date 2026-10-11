import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function components(fixture = {}) {
  const styles = `module.exports=new Proxy({},{get:(_,key)=>key==='__esModule'?false:key});`;
  const { add, modules } = createCommonJsPacker({
    react: "module.exports=testReact;",
    "react/jsx-runtime": "module.exports=testJsx;",
    "lucide-react": `module.exports=new Proxy({},{get:(_,key)=>key==='createLucideIcon'?()=>()=>null:()=>null});`,
    "@/components/intent-prefetch-link": `exports.IntentPrefetchLink=props=>require('react').createElement('a',{href:props.href},props.children);`,
    "@/lib/performance": `exports.markDashboardReadiness=()=>{};`,
    "@/lib/api": `exports.api={};`,
    "next/navigation": `exports.useRouter=()=>({push(){}});`,
    "@/components/header": `exports.Header=({title,children})=>require('react').createElement('header',null,require('react').createElement('h1',null,title),children);`,
    "@/components/dataset-readiness-panel": `exports.DatasetReadinessErrorPanel=()=>null;`,
    "@/components/programs/program-picker": `exports.ProgramBadge=()=>null;`,
    "@/lib/store": `exports.useConfigStore=exports.useStudioStore=exports.useProgramStore=exports.useLeadStore=()=>fixture;`,
    "./dashboard-home.module.css": styles,
    "./dashboard-horizon.module.css": styles,
    "./belt-tracker.module.css": styles,
    "./leads-ledger.module.css": styles,
    "@/components/leads/leads-ledger.module.css": styles,
  });
  const ids = {
    home: add("@/components/dashboard/home/home-placeholder"),
    eligibility: add("@/components/belt-tracker/eligibility-panel"),
    leads: add("@/components/leads/lead-ledger-loading"),
    leadsPage: add("@/app/(dashboard)/leads/page"),
    detail: add("@/components/leads/lead-detail-modal"),
    programs: add("@/components/settings/programs-section"),
    staff: add("@/components/settings/staff-roles-section"),
  };
  return new Function(
    "testReact",
    "testJsx",
    "fixture",
    `
    const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};
    function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    return Object.fromEntries(Object.entries(${JSON.stringify(ids)}).map(([key,id])=>[key,require(id)]));
  `,
  )(React, jsx, fixture);
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const fixture = {
  currentRole: "admin",
  identityGeneration: 1,
  programs: [],
  staffMembers: [],
  programsLoaded: false,
  staffLoaded: false,
};
const c = components(fixture);

test("Home placeholder reserves role stats and only band titles with one loading status", () => {
  const html = render(c.home.HomePlaceholder, {
    statIds: ["followUps", "promotions", "activeStudents", "attendance"],
  });
  assert.match(html, /aria-label="At a glance"/);
  assert.match(html, /data-home-placeholder="attention"/);
  assert.match(html, /data-home-placeholder="classes"/);
  assert.match(html, /Needs attention/);
  assert.match(html, /Today's classes|Today&#x27;s classes/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /Loading Home/);
  assert.doesNotMatch(html, /All clear|No classes today|Nobody to call today/);
});

test("eligibility placeholder uses the loaded ready tiles, rank ladder and five-column rank group", () => {
  const html = render(c.eligibility.EligibilityLoading, {});
  assert.match(html, /class="readyGrid"/);
  assert.equal((html.match(/class="readyTile"/g) ?? []).length, 3);
  assert.match(html, /class="ladderChart"/);
  assert.match(html, /class="eligibilityTable"/);
  assert.match(html, /class="rankGroupHeader"/);
  assert.match(html, /colSpan="5"|colspan="5"/);
  const rows = html.match(/<tr[^>]*data-readiness="progress"[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  assert.equal(rows.length, 6);
  for (const row of rows) assert.equal((row.match(/data-label=/g) ?? []).length, 5);
  assert.match(html, /koaryu-skeleton-reveal/);
});

test("a loaded empty eligibility result keeps its empty state during refresh", () => {
  const html = render(c.eligibility.EligibilityPanel, {
    hasLoadedEligibility: true,
    eligibilityGroups: [],
    isEligibilityLoading: true,
    collapsedGroups: new Set(),
    rankById: new Map(),
    previousRankByCurrentRankId: new Map(),
  });
  assert.match(html, /No students to evaluate/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /koaryu-skeleton-reveal|Loading eligibility/);
});

test("lead placeholder reserves all five stages and the responsive grouped action queue", () => {
  const html = render(c.leads.LeadLedgerLoading, { canManageLeads: true });
  const rail = html.match(/<ol class="stageRail"[\s\S]*?<\/ol>/)?.[0] ?? "";
  assert.equal((rail.match(/<li>/g) ?? []).length, 5);
  assert.equal((html.match(/class="ageBand"/g) ?? []).length, 2);
  for (const name of ["queueLead", "queueAction", "queueContext", "stageMoves"])
    assert.equal((html.match(new RegExp(`class="${name}"`, "g")) ?? []).length, 6);
  assert.match(html, /koaryu-skeleton-reveal/);
});

test("program and staff placeholders keep responsive row containers and accessible status", () => {
  const programs = render(c.programs.ProgramsSection);
  const staff = render(c.staff.StaffRolesSection);
  assert.match(programs, /flex flex-col gap-3 px-4 py-3 md:min-h-14 md:flex-row/);
  assert.match(
    staff,
    /grid gap-3 p-3 md:min-h-14 md:grid-cols-\[minmax\(0,1fr\)_132px_96px_112px_244px\]/,
  );
  assert.doesNotMatch(staff, /class="grid grid-cols-\[/);
  for (const html of [programs, staff]) {
    assert.match(html, /koaryu-skeleton-reveal/);
    assert.match(html, /role="status" aria-live="polite" aria-busy="true"/);
  }
});

test("lead history remains visible alongside a refresh error", () => {
  const html = render(c.detail.LeadDetailInspector, {
    lead: { id: "lead", first_name: "A", last_name: "Lead", stage: "inquiry", source: "website" },
    activities: [
      { id: "activity", description: "Last loaded history", created_at: "2026-10-09T10:00:00Z" },
    ],
    activityStatus: "error",
    activityError: "History refresh failed",
    activeStaff: [],
    pendingLeadIds: new Set(),
    programById: new Map(),
    today: "2026-10-09",
  });
  assert.match(html, /Last loaded history/);
  assert.match(html, /History refresh failed/);
  assert.match(html, /Retry activity/);
});

test("a failed Leads refresh keeps the loaded board and adds a retry notice", () => {
  const page = components({
    ...fixture,
    identityReady: true,
    businessDate: "2026-10-09",
    programsLoaded: true,
    staffLoaded: true,
    leads: [
      {
        id: "a",
        first_name: "A",
        last_name: "Lead",
        stage: "inquiry",
        source: "website",
        created_at: "2026-10-01T10:00:00Z",
      },
    ],
    leadsLoaded: true,
    leadsLoadError: "Refresh unavailable",
    leadCreate: { isCurrent: () => true, locked: false, status: "idle" },
    leadOperations: { views: new Map() },
    trialAppointments: { trialStorage: { isCurrent: () => false }, trialOperations: new Map() },
  });
  const html = render(page.leadsPage.default);
  assert.match(html, /A Lead/);
  assert.match(html, /class="stageRail"/);
  assert.match(html, /Refresh unavailable/);
  assert.match(html, /Retry lead roster/);
  assert.doesNotMatch(html, /could not be loaded|koaryu-skeleton-reveal/);
});
