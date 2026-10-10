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
    "./belt-tracker.module.css": styles,
    "./leads-ledger.module.css": styles,
    "@/components/leads/leads-ledger.module.css": styles,
  });
  const ids = {
    home: add("@/components/dashboard/dashboard-page-content"),
    retained: add("@/lib/retained-state"),
    catalog: add("@/lib/dashboard-widget-catalog"),
    loading: add("@/components/dashboard/dashboard-overview-sections"),
    layout: add("@/lib/dashboard-layout-store"),
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

test("Home cold rendering is SSR safe and keeps its real heading outside the widget placeholder", () => {
  const html = render(c.home.DashboardPageContent, {
    currentRole: "admin",
    currentUserId: "user",
    currentStudioId: "studio",
    identityGeneration: 1,
    isDashboardIdentityReady: false,
    isDashboardDataReady: false,
    isPreviewMode: false,
    widgetViewModels: {},
    onVisibleWidgetsChange: () => {},
    retryDashboardDatasets: () => {},
  });
  assert.match(html, /<h1 id="dashboard-home-heading">Dashboard<\/h1>/);
  assert.equal((html.match(/koaryu-skeleton-reveal/g) ?? []).length, 1);
  assert.match(html, /class="sequence"/);
  assert.doesNotMatch(html, /Arranging this studio|Loading Dashboard<\//);
});

test("Home placeholder uses the saved widget footprints and tablet packing", () => {
  const layout = c.layout.buildDefaultDashboardLayout("admin");
  layout.items = c.layout.resizeDashboardLayoutItem(layout.items, layout.items[1].widget_id, "2x2");
  const html = render(c.loading.DashboardLoadingPanel, { layout });
  const articles = html.match(/<article\b[^>]*>/g) ?? [];
  assert.equal(articles.length, layout.items.length);
  for (const [index, item] of layout.items.entries()) {
    const footprint = c.layout.getDashboardWidgetFootprint(item.size);
    assert.ok(articles[index].includes(`data-widget-id="${item.widget_id}"`));
    assert.ok(articles[index].includes(`--dashboard-column:${item.column + 1}`));
    assert.ok(articles[index].includes(`--dashboard-row-span:${footprint.rows}`));
    assert.ok(articles[index].includes("--dashboard-tablet-column:"));
  }
});

test("eligibility placeholder uses the loaded seven-column table, summary rail and rank group", () => {
  const html = render(c.eligibility.EligibilityLoading, {});
  assert.match(html, /class="decisionRegister"/);
  assert.match(html, /class="eligibilityTable"/);
  assert.match(html, /class="rankGroupHeader"/);
  assert.match(html, /colSpan="7"|colspan="7"/);
  const rows = html.match(/<tr[^>]*data-readiness="progress"[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  assert.equal(rows.length, 6);
  for (const row of rows) assert.equal((row.match(/data-label=/g) ?? []).length, 7);
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
    /grid gap-3 p-3 md:min-h-14 md:grid-cols-\[minmax\(0,1fr\)_140px_100px_120px_180px\]/,
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

test("retained Home renders the saved arrangement immediately while current identity still gates content", () => {
  const scope = "user\u0000studio\u0000admin";
  const saved = c.layout.buildDefaultDashboardLayout("admin");
  saved.items = c.layout.resizeDashboardLayoutItem(saved.items, saved.items[1].widget_id, "2x2");
  const models = Object.fromEntries(
    c.catalog.DASHBOARD_WIDGET_CATALOG.map((widget) => [
      widget.id,
      {
        id: widget.id,
        state: "unavailable",
        detail: "No data",
        rows: [],
        actions: [],
        provenanceLabel: "Live",
      },
    ]),
  );
  function Seed({ ready }) {
    const store = c.retained.useRetainedStore();
    store.set(`dashboard:layout:${scope}`, saved);
    store.set(`dashboard:layout-resolved:${scope}`, scope);
    return React.createElement(c.home.DashboardPageContent, {
      currentRole: "admin",
      currentUserId: "user",
      currentStudioId: "studio",
      identityGeneration: 1,
      isDashboardIdentityReady: ready,
      isDashboardDataReady: false,
      isPreviewMode: false,
      widgetViewModels: models,
      onVisibleWidgetsChange: () => {},
      retryDashboardDatasets: () => {},
    });
  }
  const html = (ready) =>
    renderToStaticMarkup(
      React.createElement(
        c.retained.RetainedStateProvider,
        { scope: "identity" },
        React.createElement(Seed, { ready }),
      ),
    );
  const ready = html(true);
  assert.match(ready, /data-layout-resolved="true"/);
  assert.doesNotMatch(ready, /id="dashboard-layout-status"/);
  assert.match(ready, /data-size="2x2"/);
  assert.match(html(false), /data-layout-resolved="false"/);
  assert.match(html(false), /id="dashboard-layout-status"/);
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
