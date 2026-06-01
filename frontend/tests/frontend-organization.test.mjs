import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRankFamilyIndex,
} from "../src/lib/dashboard-kpi-breakdowns.ts";
import {
  formatMoney,
  requirementGroupItems,
  statusTone,
} from "../src/lib/billing-page-utils.ts";
import { buildBillingPageModel } from "../src/lib/billing-page-model.ts";
import {
  clearPreviewStorage,
  KEYS,
  load,
  localId,
  save,
} from "../src/lib/store-storage.ts";
import { buildPreviewStudentListPage } from "../src/lib/student-list-page.ts";

function withMockStorage(callback) {
  const storage = {};
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;

  globalThis.window = {};
  globalThis.localStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
    },
    setItem(key, value) {
      storage[key] = String(value);
      this[key] = String(value);
    },
    removeItem(key) {
      delete storage[key];
      delete this[key];
    },
  };

  try {
    return callback(storage);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }

    if (previousLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousLocalStorage;
    }
  }
}

describe("frontend extracted helper behavior", () => {
  it("preserves preview student page filtering and sorting", () => {
    const result = buildPreviewStudentListPage(
      [
        {
          id: "student-b",
          legal_first_name: "Bea",
          legal_last_name: "Stone",
          preferred_name: "Bee",
          status: "active",
          email: "bea@example.test",
          phone: "",
          created_at: "2026-01-02T00:00:00Z",
          membership_start_date: "2026-01-02",
          program_id: "program-a",
          program_memberships: [],
        },
        {
          id: "student-a",
          legal_first_name: "Ari",
          legal_last_name: "Lane",
          status: "paused",
          email: "",
          phone: "555",
          created_at: "2026-01-01T00:00:00Z",
          membership_start_date: "2026-01-01",
          program_id: "program-b",
          program_memberships: [
            {
              program_id: "program-b",
              program_name: "Adults",
              status: "active",
            },
          ],
        },
      ],
      { programId: "program-b", sortKey: "name" }
    );

    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, "student-a");
  });

  it("preserves billing metric, lookup, and formatting helper behavior", () => {
    assert.equal(formatMoney(12900), "$129");
    assert.match(statusTone("past_due"), /text-danger/);
    assert.deepEqual(
      requirementGroupItems(["company.tax_id"])[1],
      {
        id: "business-details",
        label: "Business or legal details",
        description: "Studio legal address, phone, tax ID, and ownership confirmation.",
        matches: ["company.", "individual.address.", "individual.phone", "individual.id_number"],
        dueFields: ["company.tax_id"],
        complete: false,
      }
    );

    const model = buildBillingPageModel({
      billingConnect: {
        studio_id: "studio_1",
        status: "charges_enabled",
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements_due: [],
        platform_fee_bps: 50,
      },
      billingEnrollments: [
        {
          id: "enrollment_1",
          studio_id: "studio_1",
          student_id: "student_1",
          payer_id: "payer_1",
          billing_plan_id: "plan_1",
          collection_mode: "autopay",
          status: "active",
          billing_status: "current",
          start_date: "2026-01-01",
        },
      ],
      billingInvoices: [
        {
          id: "invoice_1",
          studio_id: "studio_1",
          payer_id: "payer_1",
          status: "open",
          amount_due_cents: 2000,
          amount_paid_cents: 0,
          amount_remaining_cents: 2000,
          currency: "usd",
        },
      ],
      billingPayers: [{ id: "payer_1", studio_id: "studio_1", display_name: "Lane Family" }],
      billingPayments: [
        {
          id: "payment_1",
          studio_id: "studio_1",
          payer_id: "payer_1",
          amount_cents: 12900,
          currency: "usd",
          payment_method: "card",
          status: "succeeded",
        },
      ],
      billingPlans: [{ id: "plan_1", studio_id: "studio_1", name: "Monthly", amount_cents: 12900, programs: [] }],
      billingSubscriptions: [{ id: "sub_1", studio_id: "studio_1", payer_id: "payer_1", status: "active" }],
      isPreviewMode: false,
      previewEnrollments: [],
      programs: [],
      students: [{ id: "student_1", legal_first_name: "Ari", legal_last_name: "Lane", status: "active" }],
    });

    assert.equal(model.paidRevenue, 12900);
    assert.equal(model.openInvoiceTotal, 2000);
    assert.equal(model.payerNameById.get("payer_1"), "Lane Family");
    assert.equal(model.studentNameById.get("student_1"), "Ari Lane");
    assert.equal(model.paymentsReady, true);
  });

  it("preserves dashboard belt-family indexing outside the route", () => {
    const rankFamilyById = buildRankFamilyIndex([
      {
        id: "ladder_1",
        name: "Adults",
        program_id: "program_1",
        ranks: [
          { id: "white", name: "White Belt", is_tip: false, display_order: 1 },
          { id: "tip-1", name: "White Tip", is_tip: true, display_order: 2 },
        ],
      },
    ], new Map([["program_1", { id: "program_1", name: "Adults", color_hex: "#335577", sort_order: 1 }]]));

    assert.deepEqual(
      {
        sectionLabel: rankFamilyById.get("tip-1")?.sectionLabel,
        groupLabel: rankFamilyById.get("tip-1")?.groupLabel,
        exactLabel: rankFamilyById.get("tip-1")?.exactLabel,
      },
      {
        sectionLabel: "Adults",
        groupLabel: "White Belt",
        exactLabel: "White Tip",
      }
    );
  });

  it("preserves preview storage behavior without touching non-Koaryu keys", () => {
    withMockStorage((storage) => {
      save(KEYS.students, [{ id: "student_1" }]);
      save("other:key", "keep");

      assert.deepEqual(load(KEYS.students, []), [{ id: "student_1" }]);
      assert.equal(load("missing", "fallback"), "fallback");

      localStorage.setItem("koaryu:stale", JSON.stringify(true));
      clearPreviewStorage();

      assert.equal(Object.prototype.hasOwnProperty.call(storage, KEYS.students), false);
      assert.equal(Object.prototype.hasOwnProperty.call(storage, "koaryu:stale"), false);
      assert.equal(load("other:key", null), "keep");
    });
  });

  it("keeps local preview ids unique and locally scoped", () => {
    const first = localId();
    const second = localId();

    assert.match(first, /^s-/);
    assert.match(second, /^s-/);
    assert.notEqual(first, second);
  });
});
