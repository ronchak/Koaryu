import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const require = createRequire(import.meta.url);

function loadBillingOverviewTab() {
  globalThis.__billingTestReact = React;
  globalThis.__billingTestJsxRuntime = require("react/jsx-runtime");
  const { add, modules } = createCommonJsPacker({
    react: "module.exports=globalThis.__billingTestReact;",
    "react/jsx-runtime": "module.exports=globalThis.__billingTestJsxRuntime;",
    "lucide-react": "module.exports=new Proxy({},{get:()=>()=>null});",
    "@/components/ui/button":
      'const React=require("react");exports.Button=({children,disabled})=>React.createElement("button",{disabled},children);',
    "@/components/ui/modal-frame":
      'const React=require("react");exports.ModalFrame=({children})=>React.createElement("div",null,children);',
  });
  const componentId = add("@/components/billing/billing-page-sections");
  const factories = Function(`return [${modules.join(",")}];`)();
  const cache = {};
  const packedRequire = (id) => {
    if (cache[id]) return cache[id].exports;
    const packedModule = (cache[id] = { exports: {} });
    factories[id](packedModule, packedModule.exports, packedRequire);
    return packedModule.exports;
  };

  const component = packedRequire(componentId).BillingOverviewTab;
  delete globalThis.__billingTestReact;
  delete globalThis.__billingTestJsxRuntime;
  return component;
}

const platform = {
  studio_id: "studio-1",
  plan_name: "Koaryu Core",
  monthly_price_cents: 2700,
  currency: "usd",
  status: "active",
  comped: false,
  can_start_checkout: false,
  cancel_at_period_end: false,
  email_usage: {
    included: 500,
    sent: 0,
    overage_count: 0,
    overage_rate_cents: 0.2,
    estimated_overage_cents: 0,
    period_start: "2026-09-01",
    period_end: "2026-10-01",
  },
};

function renderOverview({
  billingPlatform = platform,
  externalPaymentTotal = 0,
  paidRevenue = 0,
  paymentCohortAvailable = true,
  stripePaymentTotal = 0,
} = {}) {
  const BillingOverviewTab = loadBillingOverviewTab();
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(BillingOverviewTab, {
      activeStudents: 0,
      activeSubscriptionCount: 0,
      billingConnect: null,
      billingObservedAt: null,
      currentMonthPaymentCount: 0,
      billingPeriod: { label: "Billing period", value: "Unavailable" },
      billingPlatform,
      billingProviderCopy: {
        boundary: "Unavailable",
        coreSubscription: "Unavailable",
        connectOnboarding: "Unavailable",
        connectPayments: "Unavailable",
      },
      canManageKoaryuSubscription: false,
      canOpenCustomerPortal: false,
      canOpenStripeDashboard: false,
      canResetConnect: false,
      connectActionLabel: "Connect Stripe",
      connectRequirementItems: [],
      externalPaymentTotal,
      failedInvoiceCount: 0,
      hasStripeConnectedAccount: false,
      isActionLoading: false,
      isLoadingAction: () => false,
      onConnectClick: noop,
      onConnectReset: async () => {},
      openBillingLink: async () => {},
      openInvoiceTotal: 0,
      paidRevenue,
      paymentCohortAvailable,
      stripePaymentTotal,
      studentsLoaded: true,
      coreCheckoutEnabled: false,
      corePortalEnabled: false,
      connectDashboardEnabled: false,
      connectOnboardingEnabled: false,
    }),
  );
}

describe("billing overview availability", () => {
  it("renders unavailable, zero, nonzero, and zero-allowance facts truthfully", () => {
    const scenarios = [
      {
        name: "unavailable",
        props: { billingPlatform: null, paymentCohortAvailable: false },
        verify(html) {
          assert.match(html, /UTC-month Stripe payment cohort<\/p><p[^>]*>Unavailable<\/p>/);
          assert.match(html, /UTC-month external payment cohort<\/p><p[^>]*>Unavailable<\/p>/);
          assert.match(
            html,
            /Message usage[\s\S]*Unavailable[\s\S]*Unavailable<\/p><p[^>]*>Estimated overage/,
          );
          assert.doesNotMatch(html, /style="width:/);
        },
      },
      {
        name: "known zero",
        props: {},
        verify(html) {
          assert.match(html, /Collected this UTC month<\/p><p[^>]*>\$0<\/p>/);
          assert.match(html, /UTC-month Stripe payment cohort<\/p><p[^>]*>\$0<\/p>/);
          assert.match(html, /UTC-month external payment cohort<\/p><p[^>]*>\$0<\/p>/);
          assert.match(html, /0 of 500 emails used this month/);
          assert.match(html, /\$0<\/p><p[^>]*>Estimated overage/);
          assert.match(html, /style="width:0%"/);
        },
      },
      {
        name: "known nonzero",
        props: {
          billingPlatform: {
            ...platform,
            email_usage: {
              ...platform.email_usage,
              estimated_overage_cents: 25,
              sent: 125,
            },
          },
          externalPaymentTotal: 3400,
          paidRevenue: 4600,
          stripePaymentTotal: 1200,
        },
        verify(html) {
          assert.match(html, /Collected this UTC month<\/p><p[^>]*>\$46<\/p>/);
          assert.match(html, /UTC-month Stripe payment cohort<\/p><p[^>]*>\$12<\/p>/);
          assert.match(html, /UTC-month external payment cohort<\/p><p[^>]*>\$34<\/p>/);
          assert.match(html, /125 of 500 emails used this month/);
          assert.match(html, /\$0\.25<\/p><p[^>]*>Estimated overage/);
          assert.match(html, /style="width:25%"/);
          const labels = [
            "Needs attention",
            "Open receivables",
            "Collected this UTC month",
            "Student coverage",
          ];
          const positions = labels.map((label) => html.indexOf(label));
          assert.equal(
            positions.every((position) => position >= 0),
            true,
          );
          assert.deepEqual(
            positions,
            [...positions].sort((left, right) => left - right),
          );
        },
      },
      {
        name: "zero allowance",
        props: {
          billingPlatform: {
            ...platform,
            email_usage: {
              ...platform.email_usage,
              estimated_overage_cents: 14,
              included: 0,
              sent: 7,
            },
          },
        },
        verify(html) {
          assert.match(html, /7 of 0 emails used this month/);
          assert.match(html, /\$0\.14<\/p><p[^>]*>Estimated overage/);
          assert.doesNotMatch(html, /style="width:/);
        },
      },
    ];

    for (const scenario of scenarios) {
      assert.doesNotThrow(() => scenario.verify(renderOverview(scenario.props)), scenario.name);
    }
  });
});
