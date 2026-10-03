import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

const require = createRequire(import.meta.url);

function loadBillingComponents() {
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
  const sectionsId = add("@/components/billing/billing-page-sections");
  const familiesId = add("@/components/billing/billing-families-tab");
  const invoicesId = add("@/components/billing/billing-invoices-tab");
  const factories = Function(`return [${modules.join(",")}];`)();
  const cache = {};
  const packedRequire = (id) => {
    if (cache[id]) return cache[id].exports;
    const packedModule = (cache[id] = { exports: {} });
    factories[id](packedModule, packedModule.exports, packedRequire);
    return packedModule.exports;
  };

  const sections = packedRequire(sectionsId);
  const components = {
    BillingOverviewTab: sections.BillingOverviewTab,
    BillingFamiliesTab: packedRequire(familiesId).BillingFamiliesTab,
    BillingInvoicesTab: packedRequire(invoicesId).BillingInvoicesTab,
  };
  delete globalThis.__billingTestReact;
  delete globalThis.__billingTestJsxRuntime;
  return components;
}

const { BillingFamiliesTab, BillingInvoicesTab, BillingOverviewTab } = loadBillingComponents();

function payer(overrides) {
  return {
    id: "payer-1",
    studio_id: "studio-1",
    display_name: "Payer",
    email: null,
    phone: null,
    stripe_customer_id: null,
    stripe_payment_method_id: null,
    stripe_payment_method_type: null,
    stripe_payment_method_brand: null,
    stripe_payment_method_last4: null,
    autopay_status: "not_configured",
    billing_status: "current",
    balance_cents: 0,
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    ...overrides,
  };
}

function renderedText(markup) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

describe("payer collection facts", () => {
  const payers = [
    payer({
      id: "missing",
      display_name: "Missing Facts",
      billing_status: "past_due",
      balance_cents: 9000,
    }),
    payer({
      id: "zero",
      display_name: "Known Zero",
      billing_status: "failed",
      overdue_balance_cents: 0,
      uncollectible_balance_cents: 0,
    }),
    payer({
      id: "split",
      display_name: "Split Balance",
      billing_status: "past_due",
      balance_cents: 6000,
      overdue_balance_cents: 4000,
      uncollectible_balance_cents: 2000,
    }),
    payer({
      id: "not-queued",
      display_name: "Uncollectible Only",
      billing_status: "uncollectible",
      balance_cents: 2000,
      overdue_balance_cents: 0,
      uncollectible_balance_cents: 2000,
    }),
  ];

  it("keeps queue membership status-based and renders each amount independently", () => {
    const text = renderedText(
      renderToStaticMarkup(
        React.createElement(BillingInvoicesTab, {
          billingInvoices: [],
          billingPayers: payers,
          canReconcileInvoices: false,
          canUseWorkflow: () => false,
          isActionLoading: false,
          isLoadingAction: () => false,
          isPreviewMode: false,
          onInvoiceAction: () => {},
        }),
      ),
    );

    assert.match(
      text,
      /Missing Facts .* Outstanding \$90 Overdue Unavailable Uncollectible Unavailable/,
    );
    assert.match(text, /Known Zero .* Outstanding \$0 Overdue \$0 Uncollectible \$0/);
    assert.match(text, /Split Balance .* Outstanding \$60 Overdue \$40 Uncollectible \$20/);
    assert.doesNotMatch(text, /Uncollectible Only/);
  });

  it("labels family totals as outstanding without inventing missing facts", () => {
    const text = renderedText(
      renderToStaticMarkup(
        React.createElement(BillingFamiliesTab, {
          billingPayers: payers,
          canUseWorkflow: () => false,
          isActionLoading: false,
          isLoadingAction: () => false,
          onAutopayDisable: () => {},
          onAutopaySetup: () => {},
          onPayerSync: () => {},
        }),
      ),
    );

    assert.match(
      text,
      /Missing Facts past due Outstanding \$90 Overdue Unavailable Uncollectible Unavailable/,
    );
    assert.match(text, /Known Zero failed Outstanding \$0 Overdue \$0 Uncollectible \$0/);
    assert.match(text, /Split Balance past due Outstanding \$60 Overdue \$40 Uncollectible \$20/);
    assert.match(
      text,
      /Uncollectible Only uncollectible Outstanding \$20 Overdue \$0 Uncollectible \$20/,
    );
  });
});
