import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

// Mount the real invoice and payment tabs with synthetic rows and a synthetic refund controller.
function bundle() {
  const { add, modules } = createCommonJsPacker({
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const invoices = add("@/components/billing/billing-invoices-tab");
  const reports = add("@/components/billing/billing-reports-tab");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.renderInvoices=(props)=>root.render(React.createElement(require(${invoices}).BillingInvoicesTab,props));window.fixture.renderReports=(props)=>root.render(React.createElement(require(${reports}).BillingReportsTab,props));})();`;
}

// Two families share a display name and a price; the third row's payer is not loaded.
const payers = [
  { id: "payer-a", display_name: "Lee Family", billing_status: "current", balance_cents: 0 },
  { id: "payer-b", display_name: "Lee Family", billing_status: "current", balance_cents: 0 },
];
const invoiceRows = [
  ["1a2b3c4d-0000-4000-8000-000000000001", "payer-a", "INV-0001"],
  ["5e6f7a8b-0000-4000-8000-000000000002", "payer-b", null],
  ["9c0d1e2f-0000-4000-8000-000000000003", "payer-missing", null],
];
const paymentRows = [
  ["aa11bb22-0000-4000-8000-000000000001", "payer-a"],
  ["cc33dd44-0000-4000-8000-000000000002", "payer-b"],
  ["ee55ff66-0000-4000-8000-000000000003", null],
];
const expectedInvoices = [
  { id: invoiceRows[0][0], payer: "Lee Family", reference: "Invoice INV-0001 · Ref 1a2b3c4d" },
  { id: invoiceRows[1][0], payer: "Lee Family", reference: "Invoice Ref 5e6f7a8b" },
  { id: invoiceRows[2][0], payer: "Unknown payer", reference: "Invoice Ref 9c0d1e2f" },
];
const expectedPayments = [
  { id: paymentRows[0][0], payer: "Lee Family", reference: "Payment Ref aa11bb22" },
  { id: paymentRows[1][0], payer: "Lee Family", reference: "Payment Ref cc33dd44" },
  { id: paymentRows[2][0], payer: "Unknown payer", reference: "Payment Ref ee55ff66" },
];

async function mount(browser) {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  await page.evaluate(
    ({ payers, invoiceRows, paymentRows }) => {
      const f = (window.fixture = { actions: [], confirmations: [], confirmResult: true });
      window.confirm = (message) => {
        f.confirmations.push(message);
        return f.confirmResult;
      };
      f.payers = payers;
      f.invoices = invoiceRows.map(([id, payer_id, number]) => ({
        id,
        studio_id: "studio",
        payer_id,
        number,
        invoice_type: "subscription",
        status: "open",
        amount_due_cents: 5000,
        amount_paid_cents: 0,
        amount_remaining_cents: 5000,
        invoice_receivable_amount_cents: 5000,
        currency: "usd",
        application_fee_amount_cents: 0,
        external: false,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      }));
      f.payments = paymentRows.map(([id, payer_id]) => ({
        id,
        studio_id: "studio",
        payer_id,
        stripe_charge_id: "synthetic-charge",
        status: "succeeded",
        amount_cents: 5000,
        gross_paid_amount_cents: 5000,
        currency: "usd",
        payment_method_type: "card",
        application_fee_amount_cents: 0,
        refunded_amount_cents: 0,
        disputed_amount_cents: 0,
        net_collected_amount_cents: 5000,
        refundable_amount_cents: 5000,
        adjustment_reconciliation_required: false,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      }));
      f.refundController = {
        activePaymentId: null,
        canRefundPayments: true,
        refundActionReady: true,
        refundStorageReady: true,
        isPaymentRefundBlocked: () => false,
        getPaymentRefundRecovery: (id) => (f.recoveryIds?.includes(id) ? "retry" : null),
        refundPayment: async (payment, amount, reason) => {
          f.actions.push({ kind: "refund", id: payment.id, amount, reason });
        },
        recoverRefund: async (payment) => {
          f.actions.push({ kind: "recover", id: payment.id });
        },
      };
      f.showInvoices = () =>
        f.renderInvoices({
          billingInvoices: f.invoices,
          billingPayers: f.payers,
          canReconcileInvoices: false,
          canUseWorkflow: () => true,
          isActionLoading: false,
          isLoadingAction: () => false,
          isPreviewMode: false,
          onInvoiceAction: (id, action) => f.actions.push({ kind: action, id }),
        });
      f.showReports = () =>
        f.renderReports({
          billingPayers: f.payers,
          billingPayments: f.payments,
          refundController: f.refundController,
          canManageRoutineBilling: false,
          externalAmount: "",
          externalMethod: "",
          externalNote: "",
          externalPayerId: "",
          externalPaymentReady: false,
          externalPaymentFormLocked: true,
          externalPaymentRecoveryMessage: "",
          externalPaymentIsRetry: false,
          externalPaymentTotal: 0,
          isActionLoading: false,
          isLoadingAction: () => false,
          onExternalAmountChange: () => {},
          onExternalMethodChange: () => {},
          onExternalNoteChange: () => {},
          onExternalPayerChange: () => {},
          onRecordExternalPayment: () => {},
          paymentCohortAvailable: true,
          stripePaymentTotal: 0,
        });
    },
    { payers, invoiceRows, paymentRows },
  );
  await page.addScriptTag({ content: bundle() });
  return page;
}

function rowFor(page, buttonName, index) {
  return page
    .getByRole("button", { name: buttonName, exact: true })
    .nth(index)
    .locator("xpath=ancestor::div[contains(@class,'grid')][1]");
}

test("invoice rows and void confirmations name the payer and keep the original invoice", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await mount(browser);
    await page.evaluate(() => fixture.showInvoices());
    await page.getByRole("button", { name: "Void", exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Void", exact: true }).count(), 3);

    for (const [index, expected] of expectedInvoices.entries()) {
      const text = await rowFor(page, "Void", index).innerText();
      assert.ok(text.includes(expected.payer), `row ${index} names ${expected.payer}`);
      assert.ok(text.includes(expected.reference), `row ${index} shows ${expected.reference}`);
    }

    await page.evaluate(() => {
      fixture.confirmResult = false;
    });
    await page.getByRole("button", { name: "Void", exact: true }).nth(1).click();
    assert.deepEqual(await page.evaluate(() => fixture.actions), []);

    await page.evaluate(() => {
      fixture.confirmResult = true;
      fixture.confirmations = [];
    });
    for (const index of [2, 0, 1]) {
      await page.getByRole("button", { name: "Void", exact: true }).nth(index).click();
    }
    const { actions, confirmations } = await page.evaluate(() => fixture);
    assert.deepEqual(
      actions,
      [2, 0, 1].map((index) => ({ kind: "void", id: expectedInvoices[index].id })),
    );
    for (const [position, index] of [2, 0, 1].entries()) {
      const message = confirmations[position];
      assert.match(message, /^Void this invoice\?/);
      assert.ok(message.includes(expectedInvoices[index].payer), message);
      assert.ok(message.includes(expectedInvoices[index].reference), message);
      assert.match(message, /cannot be undone/);
    }
    await page.close();
  } finally {
    await browser.close();
  }
});

test("payment rows, refund and refund-recovery confirmations name the payer and keep the original payment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await mount(browser);
    await page.evaluate(() => fixture.showReports());
    await page.getByRole("button", { name: "Issue refund", exact: true }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Issue refund", exact: true }).count(), 3);

    for (const [index, expected] of expectedPayments.entries()) {
      const text = await rowFor(page, "Issue refund", index).innerText();
      assert.ok(text.includes(expected.payer), `row ${index} names ${expected.payer}`);
      assert.ok(text.includes(expected.reference), `row ${index} shows ${expected.reference}`);
    }

    await page.getByLabel("Refund amount").nth(1).fill("12.50");
    await page.evaluate(() => {
      fixture.confirmResult = false;
    });
    await page.getByRole("button", { name: "Issue refund", exact: true }).nth(1).click();
    assert.deepEqual(await page.evaluate(() => fixture.actions), []);

    await page.evaluate(() => {
      fixture.confirmResult = true;
      fixture.confirmations = [];
    });
    await page.getByRole("button", { name: "Issue refund", exact: true }).nth(1).click();
    await page.getByRole("button", { name: "Issue refund", exact: true }).nth(2).click();
    let state = await page.evaluate(() => fixture);
    assert.deepEqual(state.actions, [
      {
        kind: "refund",
        id: expectedPayments[1].id,
        amount: "12.50",
        reason: "requested_by_customer",
      },
      {
        kind: "refund",
        id: expectedPayments[2].id,
        amount: "50.00",
        reason: "requested_by_customer",
      },
    ]);
    assert.match(state.confirmations[0], /^Refund \$12\.50 /);
    assert.match(state.confirmations[1], /^Refund \$50 /);
    for (const [position, index] of [1, 2].entries()) {
      const message = state.confirmations[position];
      assert.ok(message.includes(expectedPayments[index].payer), message);
      assert.ok(message.includes(expectedPayments[index].reference), message);
      assert.match(message, /provider will receive this request immediately/);
    }

    await page.evaluate(
      (ids) => {
        fixture.actions = [];
        fixture.confirmations = [];
        fixture.recoveryIds = ids;
        fixture.showReports();
      },
      [expectedPayments[0].id, expectedPayments[2].id],
    );
    const retry = page.getByRole("button", { name: "Retry original refund", exact: true });
    await retry.first().waitFor();
    assert.equal(await retry.count(), 2);
    await retry.nth(1).click();
    await retry.nth(0).click();
    state = await page.evaluate(() => fixture);
    assert.deepEqual(state.actions, [
      { kind: "recover", id: expectedPayments[2].id },
      { kind: "recover", id: expectedPayments[0].id },
    ]);
    for (const [position, index] of [2, 0].entries()) {
      const message = state.confirmations[position];
      assert.match(message, /^Check the original refund request for /);
      assert.ok(message.includes(expectedPayments[index].payer), message);
      assert.ok(message.includes(expectedPayments[index].reference), message);
    }
    await page.close();
  } finally {
    await browser.close();
  }
});
