import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import {
  HOME_COPY,
  homeAgendaMore,
  homeAttentionCopy,
  homeBeltPairLabel,
  homeFollowUpNextStep,
  homeRefreshErrorDetail,
  homeSentenceText,
} from "../src/lib/dashboard/home-copy.ts";
import {
  buildHomeModel,
  HOME_LINKS,
  homeLeadHref,
  homeScheduleHref,
  homeStudentHref,
} from "../src/lib/dashboard/home-model.ts";
import {
  mountHome,
  rejectHome,
  flush,
  until,
  tick,
  homeCount,
} from "./helpers/home-hook-mounted.mjs";
import { homePayload } from "./helpers/home-fixtures.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const root = (page) => page.locator('[data-koaryu-dashboard-home="true"]');
async function mount(options = {}) {
  const result = await mountHome(browser, { homePage: true, ...options });
  await until(result.page, () => window.fixture.homeReads.length === 1);
  assert.deepEqual(result.errors, []);
  return result;
}
async function deliver(page, payload, index = 0) {
  await page.evaluate(({ payload, index }) => window.fixture.homeReads[index].resolve(payload), {
    payload,
    index,
  });
  await until(page, () => document.querySelector('[data-home-status="ready"]'));
  await tick(page, 40);
}
async function marks(page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType("mark")
      .filter((e) => e.name.startsWith("koaryu.visible."))
      .map((e) => ({ name: e.name, startTime: e.startTime })),
  );
}
test("Home loading keeps Header, band titles and one Loading Home status; ready flips together", async () => {
  const { page, errors } = await mount();
  try {
    const home = root(page);
    assert.match(
      await home.getByRole("heading", { level: 1 }).innerText(),
      /^Good (morning|afternoon|evening)/,
    );
    assert.equal(await home.locator("header[data-koaryu-page-header=horizon]").count(), 1);
    assert.equal(await home.locator("[data-reserved=true]").innerText(), "");
    assert.equal(await home.getAttribute("aria-busy"), "true");
    assert.equal(await home.getAttribute("data-koaryu-dashboard-shell-ready"), "true");
    assert.equal(await home.getAttribute("data-koaryu-dashboard-ready"), "true");
    assert.equal(await home.getAttribute("data-koaryu-dashboard-data-ready"), "false");
    assert.equal(await home.getAttribute("data-dashboard-provenance"), "live");
    assert.equal(await home.getByRole("status").count(), 1);
    assert.equal(await home.getByRole("status").innerText(), HOME_COPY.loading.status);
    const placeholderText = await home
      .locator('[data-home-placeholder="attention"],[data-home-placeholder="classes"]')
      .allTextContents();
    assert.deepEqual(placeholderText, [HOME_COPY.attention.title, HOME_COPY.agenda.title]);
    assert.equal(
      await home.locator("[data-home-band],[data-home-row],[data-home-panel]").count(),
      0,
    );
    const bodyText = await home.locator("main,section[aria-label]").allTextContents();
    assert.ok(
      bodyText.every((t) => !/All clear|Nothing needs|No classes today|Nobody/.test(t)),
      JSON.stringify(bodyText),
    );
    await tick(page, 40);
    assert.deepEqual(
      (await marks(page)).map((m) => m.name),
      ["koaryu.visible.identity"],
    );
    const payload = homePayload("admin", { rich: true });
    await deliver(page, payload);
    assert.equal(await home.getAttribute("data-home-status"), "ready");
    assert.equal(await home.getAttribute("aria-busy"), "false");
    assert.equal(await home.getAttribute("data-koaryu-dashboard-data-ready"), "true");
    assert.equal(await home.locator("[data-home-placeholder]").count(), 0);
    assert.equal(await home.getByRole("status").count(), 0);
    assert.equal(await home.locator("[data-home-band]").count(), 3);
    const stages = await marks(page);
    assert.deepEqual(
      stages.map((m) => m.name),
      [
        "koaryu.visible.identity",
        "koaryu.visible.useful",
        "koaryu.visible.complete",
        "koaryu.visible.legacy-complete",
      ],
    );
    assert.ok(stages[0].startTime < stages[1].startTime);
    assert.equal(stages[1].startTime, stages[2].startTime);
    assert.equal(stages[2].startTime, stages[3].startTime);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
for (const retained of [false, true])
  test(`Home error ${retained ? "with retained payload" : "without payload"} uses exact copy and retries in flight`, async () => {
    const { page, errors } = await mount();
    try {
      const payload = homePayload("admin", { rich: true });
      let index = 0;
      if (retained) {
        await deliver(page, payload);
        await page.evaluate(() => window.fixture.home.retry());
        await until(page, () => window.fixture.homeReads.length === 2);
        index = 1;
      }
      await rejectHome(page, index);
      await until(page, () => document.querySelector('[data-home-status="error"]'));
      const notice = root(page).locator("[data-home-error]");
      const copy = retained ? HOME_COPY.error.refresh : HOME_COPY.error.load;
      assert.ok((await notice.innerText()).includes(copy.title));
      assert.ok(
        (await notice.innerText()).includes(
          retained ? homeRefreshErrorDetail(payload.generated_at, "UTC") : copy.detail,
        ),
      );
      assert.equal(await root(page).locator("[data-home-band]").count(), retained ? 3 : 0);
      assert.equal(
        await root(page).getAttribute("data-koaryu-dashboard-data-ready"),
        String(retained),
      );
      if (retained) {
        const model = buildHomeModel({
          state: { status: "ready", payload },
          role: "admin",
          nowMinutes: 720,
        });
        assert.ok(
          (await root(page).locator("header[data-koaryu-page-header]").innerText()).includes(
            homeSentenceText(model.sentence),
          ),
        );
      } else {
        await tick(page, 40);
        assert.ok((await marks(page)).every((m) => m.name === "koaryu.visible.identity"));
        assert.equal(await root(page).locator("[data-reserved=true]").count(), 1);
      }
      await notice.getByRole("button", { name: HOME_COPY.error.retry }).click();
      await until(page, () => window.fixture.home.isRevalidating);
      assert.equal(await notice.getByRole("button").isDisabled(), true);
      assert.equal(await notice.locator("svg.animate-spin").count(), 1);
      await deliver(page, payload, index + 1);
      assert.equal(await root(page).locator("[data-home-error]").count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
for (const [role, ids, panels] of [
  [
    "admin",
    ["followUps", "promotions", "activeStudents", "attendance"],
    ["followUps", "promotions"],
  ],
  ["front_desk", ["followUps", "activeStudents", "attendance"], ["followUps"]],
  ["instructor", ["promotions", "activeStudents", "attendance"], ["promotions"]],
])
  test(`Home ${role} has D1 stats, D4 panels, permitted actions and no repeated attention fact`, async () => {
    const { page, errors } = await mount({ role });
    try {
      await deliver(page, homePayload(role, { rich: true }));
      const home = root(page);
      const stats = home.locator(`section[aria-label="${HOME_COPY.stats.label}"]`);
      assert.deepEqual(
        await stats
          .locator("a")
          .allTextContents()
          .then((texts) => texts.map((text, i) => text.includes(HOME_COPY.stats[ids[i]].label))),
        ids.map(() => true),
      );
      assert.equal(await stats.locator("a").count(), ids.length);
      assert.deepEqual(
        await home
          .locator("[data-home-panel]")
          .evaluateAll((nodes) => nodes.map((n) => n.dataset.homePanel)),
        panels,
      );
      assert.equal(await home.locator('[data-home-panel="newStudents"]').count(), 0);
      assert.equal(
        await home
          .locator("header")
          .getByRole("link", { name: HOME_COPY.header.actions.addStudent })
          .count(),
        role === "instructor" ? 0 : 1,
      );
      assert.equal(
        await home
          .locator("header")
          .getByRole("link", { name: HOME_COPY.header.actions.takeAttendance })
          .getAttribute("href"),
        homeScheduleHref("2026-10-10", "current"),
      );
      const kinds = await home
        .locator('[data-home-band="attention"] [data-home-row]')
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.homeRow));
      for (const kind of kinds) {
        assert.ok(!ids.includes(kind), `${kind} must not repeat as a stat`);
        assert.equal(await stats.locator(`[data-home-row="${kind}"]`).count(), 0);
        const item = homePayload(role, { rich: true }).needs_attention.items.find(
          (item) => item.kind === kind,
        );
        const copy = homeAttentionCopy({ ...item, studentId: item.student_id ?? null });
        assert.ok(!(await stats.innerText()).includes(copy.title));
        assert.equal(await home.locator(`[data-home-row="${kind}"]`).count(), 1);
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
test("Home row, panel and overflow links carry D2-D4 destinations and accessible belt text", async () => {
  const { page, errors } = await mount();
  try {
    await deliver(page, homePayload("admin", { rich: true }));
    const home = root(page);
    for (const [row, href] of [
      ["payments", HOME_LINKS.billingInvoices],
      ["setup", HOME_LINKS.schedule],
      ["away", HOME_LINKS.studentsAway],
      ["contact", homeStudentHref("contact-1")],
      ["current", homeScheduleHref("2026-10-10", "current")],
      ["lead-1", homeLeadHref("lead-1")],
      ["promote-1", homeStudentHref("promote-1")],
    ])
      assert.equal(
        await home.locator(`[data-home-row="${row}"] a`).getAttribute("href"),
        href,
        row,
      );
    for (const [name, href] of [
      [HOME_COPY.agenda.link, HOME_LINKS.schedule],
      [HOME_COPY.followUps.link, HOME_LINKS.leads],
      [HOME_COPY.promotions.link, HOME_LINKS.beltTrackerReady],
      [homeAgendaMore(2), homeScheduleHref("2026-10-10")],
    ])
      assert.equal(await home.getByRole("link", { name, exact: true }).getAttribute("href"), href);
    assert.ok(
      (await home.locator('[data-home-row="promote-1"]').innerText()).includes(
        homeBeltPairLabel({ from: { name: "White" }, to: { name: "Yellow" } }),
      ),
    );
    assert.equal(
      await home.locator('[data-home-row="promote-1"] .beltPair').getAttribute("aria-hidden"),
      "true",
    );
    assert.ok(
      (await home.locator('[data-home-row="lead-1"]').innerText()).includes(
        homeFollowUpNextStep("inquiry"),
      ),
    );
    assert.ok((await home.locator('[data-home-row="ended"]').innerText()).includes("4 checked in"));
    assert.ok(
      (await home.locator('[data-home-row="current"]').innerText()).includes(
        HOME_COPY.agenda.noCheckIns,
      ),
    );
    assert.ok((await home.locator('[data-home-row="next"]').innerText()).includes("12 spots"));
    assert.ok(
      !(await home.locator('[data-home-row="unknown-capacity"]').innerText()).includes("spots"),
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test("Home empty bands and panels retain plain copy and attendance falls back to today's schedule", async () => {
  const { page, errors } = await mount();
  try {
    await deliver(page, homePayload());
    const home = root(page);
    for (const section of [
      HOME_COPY.attention,
      HOME_COPY.agenda,
      HOME_COPY.followUps,
      HOME_COPY.promotions,
    ])
      for (const text of Object.values(section.empty))
        assert.ok((await home.innerText()).includes(text), text);
    assert.equal(
      await home
        .locator("header")
        .getByRole("link", { name: HOME_COPY.header.actions.takeAttendance })
        .getAttribute("href"),
      homeScheduleHref("2026-10-10"),
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test("Home greeting remains stable after payload refresh and a studio clock change", async () => {
  const { page, errors } = await mount();
  try {
    await deliver(page, homePayload());
    const greeting = await root(page).getByRole("heading", { level: 1 }).innerText();
    await page.clock.setSystemTime(new Date("2026-10-10T23:00:00Z"));
    await page.evaluate(() => window.fixture.home.retry());
    await until(page, () => window.fixture.homeReads.length === 2);
    const payload = homePayload("admin", { rich: true });
    payload.viewer.first_name = "Different";
    await deliver(page, payload, 1);
    assert.equal(await root(page).getByRole("heading", { level: 1 }).innerText(), greeting);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test("Home revisit paints retained facts in the first commit and makes one Home request", async () => {
  const { page, errors } = await mount();
  try {
    await deliver(page, homePayload("admin", { rich: true }));
    await page.evaluate(() => window.fixture.unmountHome());
    await flush(page);
    const count = await homeCount(page);
    const offset = await page.evaluate(() => window.fixture.requests.length);
    await page.evaluate(() => window.fixture.mountHome());
    await until(page, () => window.fixture.homeFirstFrames.length === 2);
    assert.deepEqual(await page.evaluate(() => window.fixture.homeFirstFrames[1]), {
      status: "ready",
      placeholders: 0,
    });
    assert.equal(await homeCount(page), count + 1);
    assert.deepEqual(
      await page.evaluate(
        (offset) => window.fixture.requests.slice(offset).map((r) => r.path.split("?")[0]),
        offset,
      ),
      ["/dashboard/home"],
    );
    assert.equal(await root(page).getAttribute("data-koaryu-dashboard-data-ready"), "true");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
test("a command on Home revalidates /dashboard/home without a /dashboard/summary read", async () => {
  const { page, errors } = await mount();
  try {
    await deliver(page, homePayload());
    const offset = await page.evaluate(() => window.fixture.requests.length);
    await page.evaluate(() => {
      window.fixture.api.patch = async () => ({
        id: "student-1",
        legal_first_name: "Saved",
        legal_last_name: "Student",
        status: "active",
        guardians: [],
        programs: [],
        tags: [],
      });
      window.fixture.command = window.fixture.store.updateStudent("student-1", {
        legal_first_name: "Saved",
      });
    });
    await page.evaluate(() => window.fixture.command);
    await flush(page);
    await tick(page, 350);
    await until(page, () => window.fixture.homeReads.length === 2);
    assert.deepEqual(
      await page.evaluate(
        (offset) => window.fixture.requests.slice(offset).map((r) => r.path.split("?")[0]),
        offset,
      ),
      ["/dashboard/home"],
    );
    assert.equal(
      await page.evaluate(
        () => window.fixture.requests.filter((r) => r.path.startsWith("/dashboard/summary")).length,
      ),
      0,
    );
    await deliver(page, homePayload(), 1);
    await page.evaluate(() => window.fixture.command);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
