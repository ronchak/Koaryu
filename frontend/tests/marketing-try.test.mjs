import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { formatPublicPlatformPrice } from "../src/lib/constants.ts";
import { tryPageContent } from "../src/components/marketing/try/try-content.ts";
import {
  CREST_PATHS,
  GROUND_PATHS,
  RIDGE_PATHS,
  STARS,
  closedRidgePath,
  ridgeLine,
} from "../src/components/marketing/try/try-hills.ts";
import {
  MARK_CYCLE,
  beltRegister,
  countsTowardRank,
  createTryReducer,
  describeChange,
  followUpLabel,
  initialTryState,
  leadBand,
  leadTotals,
  nextAction,
  nextMark,
  sessionSummary,
  stageCounts,
  studentProgress,
  tasksDone,
} from "../src/components/marketing/try/try-model.ts";

const tryDir = new URL("../src/components/marketing/try/", import.meta.url);
const sources = Object.fromEntries(
  readdirSync(tryDir)
    .filter((name) => /\.(tsx?|css)$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, tryDir), "utf8")]),
);
const route = readFileSync(new URL("../src/app/try/page.tsx", import.meta.url), "utf8");
const allSource = Object.values(sources).join("\n");

const { students, leads, ready, newLead } = tryPageContent.studio;
const reduce = createTryReducer(students, leads);
const start = initialTryState(students, leads);
const cycle = (state, id, times = 1) =>
  Array.from({ length: times }).reduce((current) => reduce(current, { type: "cycle", id }), state);

describe("Try: attendance and ranks", () => {
  it("cycles attendance the way Koaryu does and counts Present and Late", () => {
    assert.deepEqual([...MARK_CYCLE], ["unmarked", "present", "late", "absent"]);
    assert.equal(nextMark("absent"), "unmarked");
    assert.deepEqual(MARK_CYCLE.map(countsTowardRank), [false, true, true, false]);
    assert.equal(cycle(start, "zara", 4).marks.zara, "unmarked");
  });

  it("starts unmarked against tonight's six-student roster, with nobody ready", () => {
    assert.equal(Object.keys(start.marks).length, students.length);
    assert.deepEqual(sessionSummary(start.marks), { present: 0, absent: 0, unmarked: 6 });
    assert.equal(beltRegister(students, start.marks).ready, 0);
    assert.equal(reduce(start, { type: "cycle", id: "nobody" }), start);
  });

  it("makes Maya ready to test on her eighth class, Present or Late, and not when Absent", () => {
    const maya = students.find((student) => student.id === ready.student);
    assert.equal(studentProgress(maya, "unmarked").standing, "progress");
    assert.equal(studentProgress(maya, "present").standing, "ready");
    assert.equal(studentProgress(maya, "late").standing, "ready");
    assert.equal(studentProgress(maya, "absent").standing, "progress");
    const marked = cycle(start, "maya");
    assert.equal(beltRegister(students, marked.marks).ready, 1);
    assert.match(
      describeChange(start, marked, { type: "cycle", id: "maya" }, students),
      /Ready to test for Yellow Belt/,
    );
    assert.deepEqual(sessionSummary(cycle(marked, "liam", 3).marks), {
      present: 1,
      absent: 1,
      unmarked: 4,
    });
  });

  it("never makes anyone else ready tonight, and holds approval-gated ranks for sign-off", () => {
    for (const student of students) {
      if (student.id === ready.student) continue;
      for (const mark of MARK_CYCLE) {
        assert.notEqual(studentProgress(student, mark).standing, "ready", student.name);
      }
    }
    const hana = students.find((student) => student.id === "hana");
    assert.equal(
      studentProgress({ ...hana, attended: 11, daysAtRank: 90 }, "present").standing,
      "approval",
    );
  });
});

describe("Try: the follow-up queue", () => {
  it("queues leads by how overdue they are, with Koaryu's next actions", () => {
    assert.deepEqual(leads.map(leadBand), ["overdue-1", "overdue-1", "today", "upcoming"]);
    assert.deepEqual(leadTotals(leads), {
      overdue: 2,
      dueToday: 1,
      unassigned: 2,
      active: 4,
      enrolled: 0,
    });
    assert.equal(nextAction("trial_scheduled"), "Confirm trial attendance");
    assert.equal(followUpLabel(leads[0]), "2d overdue · Sun");
    assert.equal(followUpLabel(leads[3]), "Due Thu");
  });

  it("adds a trial lead as an inquiry, trimmed, and ignores a blank name", () => {
    const added = reduce(start, {
      type: "addLead",
      lead: { ...newLead, name: "  Jordan   Rivera " },
    });
    const lead = added.leads.at(-1);
    assert.equal(lead.name, "Jordan Rivera");
    assert.equal(lead.stage, "inquiry");
    assert.equal(leadBand(lead), "upcoming");
    assert.equal(added.touchedLead, lead.id);
    assert.equal(stageCounts(added.leads).inquiry, 2);
    assert.equal(reduce(start, { type: "addLead", lead: { ...newLead, name: "  " } }), start);
    assert.deepEqual(tasksDone(added, students), { mark: false, ready: false, lead: true });
  });

  it("moves leads one stage at a time within the pipeline", () => {
    assert.equal(reduce(start, { type: "moveLead", id: "david", direction: -1 }), start);
    let state = start;
    for (let step = 0; step < 6; step += 1) {
      state = reduce(state, { type: "moveLead", id: "sarah", direction: 1 });
    }
    const sarah = state.leads.find((lead) => lead.id === "sarah");
    assert.equal(sarah.stage, "enrolled");
    assert.equal(leadBand(sarah), "done");
    assert.equal(leadTotals(state.leads).enrolled, 1);
  });

  it("completes the three guided tasks and resets to the sample class", () => {
    const busy = reduce(cycle(start, "maya"), { type: "addLead", lead: newLead });
    assert.deepEqual(tasksDone(busy, students), { mark: true, ready: true, lead: true });
    assert.deepEqual(reduce(busy, { type: "reset" }), start);
    assert.deepEqual(
      tryPageContent.studio.tasks.map((task) => task.id),
      ["mark", "ready", "lead"],
    );
  });
});

describe("Try: page content and route", () => {
  it("prices from the constants helper and labels every sample", () => {
    assert.match(tryPageContent.real.price, new RegExp(`^\\${formatPublicPlatformPrice()} per`));
    assert.doesNotMatch(allSource, /\$27|\b2700\b|(["'])27\1/);
    assert.match(tryPageContent.studio.caption, /sample students/i);
    assert.match(tryPageContent.real.caption, /sample studio data/);
    assert.match(sources["try-demo.tsx"], /Sample data/);
  });

  it("points to sign-up and back home, with real alt text on the product images", () => {
    assert.deepEqual(
      tryPageContent.real.actions.map((action) => action.href),
      ["/signup", "/"],
    );
    assert.equal(tryPageContent.guide.action.href, "/signup");
    assert.ok(tryPageContent.real.image.alt.length > 40);
    assert.ok(tryPageContent.real.image.mobile.alt.length > 20);
    for (const image of [tryPageContent.real.image, tryPageContent.real.image.mobile]) {
      assert.ok(existsSync(new URL(`../public${image.src}`, import.meta.url)), image.src);
    }
  });

  it("gives /try its own title, description and canonical URL", () => {
    assert.match(tryPageContent.meta.title, /Try Koaryu/);
    assert.ok(tryPageContent.meta.description.length > 80);
    assert.ok(tryPageContent.meta.description.length < 260);
    assert.equal(tryPageContent.meta.path, "/try");
    assert.match(route, /alternates: \{ canonical: url \}/);
    assert.match(route, /export default TryPage/);
  });

  it("has one h1, the shared masthead and footer, and decorative art hidden", () => {
    assert.equal((sources["try-page.tsx"].match(/<h1\b/g) ?? []).length, 1);
    assert.doesNotMatch(sources["try-demo.tsx"], /<h1\b/);
    assert.match(sources["try-page.tsx"], /<MarketingHeader \/>/);
    assert.match(sources["try-page.tsx"], /<MarketingFooter \/>/);
    assert.match(sources["try-page.tsx"], /className=\{styles\.sky\} aria-hidden="true"/);
    assert.match(sources["try-page.tsx"], /className=\{styles\.landscape\} aria-hidden="true"/);
    assert.match(sources["try-page.tsx"], /href="#main-content"/);
  });
});

describe("Try: hills, night and motion", () => {
  it("draws the landing hero's five ridges, closed far below any crop", () => {
    assert.equal(RIDGE_PATHS.length, 5);
    assert.equal(CREST_PATHS.length, 5);
    assert.equal(GROUND_PATHS.length, 2);
    assert.match(
      closedRidgePath({ baseY: 100, amplitude: 10, frequency: 1, phase: 0 }),
      / 6400 Z$/,
    );
    const line = ridgeLine({ baseY: 552, amplitude: 74, frequency: 0.9, phase: 0.4 });
    assert.equal(line.length, 47);
    assert.ok(line.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  });

  it("places the same stars on every render", () => {
    assert.equal(STARS.length, 46);
    assert.ok(STARS.every((star) => star.x >= 0 && star.x <= 100 && star.y >= 0 && star.y <= 62));
  });

  it("styles its own surfaces at night", () => {
    const page = sources["try-page.module.css"];
    const demo = sources["try-demo.module.css"];
    for (const selector of [".root", ".sky", ".moon", ".stars", ".ridge:nth-child(1)", ".real"]) {
      assert.ok(page.includes(`:global(html[data-scene="night"]) ${selector}`), selector);
    }
    for (const selector of [".guide", ".frame", ".caption"]) {
      assert.ok(demo.includes(`:global(html[data-scene="night"]) ${selector}`), selector);
    }
  });

  it("only animates on scroll where supported and where motion is welcome", () => {
    for (const css of [sources["try-page.module.css"], sources["try-demo.module.css"]]) {
      const motion = css.indexOf("@media (prefers-reduced-motion: no-preference)");
      const timelines = [...css.matchAll(/animation-timeline:/g)].map((match) => match.index);
      assert.ok(
        timelines.every((index) => motion > 0 && index > motion),
        "gated timelines",
      );
    }
    assert.match(sources["try-page.module.css"], /@supports \(animation-timeline: scroll\(\)\)/);
    assert.match(sources["try-demo.module.css"], /@media \(prefers-reduced-motion: reduce\)/);
  });

  it("never intercepts input, saves nothing and calls no network", () => {
    assert.doesNotMatch(allSource, /addEventListener\("(?:wheel|touchstart|touchmove|keydown)"/);
    assert.doesNotMatch(allSource, /preventDefault\(/);
    assert.doesNotMatch(allSource, /fetch\(|localStorage|sessionStorage|XMLHttpRequest/);
    assert.match(sources["try-demo.tsx"], /initialTryState\(STUDENTS, LEADS\)/);
  });

  it("announces changes, exposes progress and uses real modal dialogs", () => {
    const demo = sources["try-demo.tsx"];
    assert.match(demo, /role="status" aria-live="polite"/);
    assert.match(demo, /role="progressbar"/);
    assert.match(demo, /<dialog\b/);
    assert.match(demo, /showModal\(\)/);
    assert.match(demo, /onClose=\{onSheetClosed\}/);
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    assert.doesNotMatch(
      allSource,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i,
    );
  });
});
