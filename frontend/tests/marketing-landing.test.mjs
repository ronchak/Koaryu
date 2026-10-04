import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { landingPageContent } from "../src/lib/landing-page-content.ts";
import {
  LANDING_HASH_ALIASES,
  LANDING_TARGETS,
  resolveLegacyHash,
} from "../src/components/marketing/landing/legacy-hash.ts";
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
} from "../src/components/marketing/landing/try-model.ts";

const landingDir = new URL("../src/components/marketing/landing/", import.meta.url);
const css = ["landing.module.css", "try.module.css"]
  .map((name) => readFileSync(new URL(name, landingDir), "utf8"))
  .join("\n");
const pageCss = readFileSync(new URL("landing.module.css", landingDir), "utf8");
const sources = Object.fromEntries(
  readdirSync(landingDir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, landingDir), "utf8")]),
);
const allSource = Object.values(sources).join("\n");

const { students, leads, ready, newLead } = landingPageContent.studio;
const reduce = createTryReducer(students, leads);
const start = initialTryState(students, leads);
const cycle = (state, id, times = 1) =>
  Array.from({ length: times }).reduce((current) => reduce(current, { type: "cycle", id }), state);

describe("Try it: attendance and ranks", () => {
  it("cycles attendance the way Koaryu does and counts Present and Late", () => {
    assert.deepEqual([...MARK_CYCLE], ["unmarked", "present", "late", "absent"]);
    assert.equal(nextMark("absent"), "unmarked");
    assert.deepEqual(MARK_CYCLE.map(countsTowardRank), [false, true, true, false]);
    assert.equal(cycle(start, "zara", 4).marks.zara, "unmarked");
  });

  it("starts unmarked, with nobody ready, and leaves the state alone for unknown students", () => {
    assert.equal(Object.keys(start.marks).length, students.length);
    assert.doesNotMatch(sources["try-it.tsx"], /session\.capacity/);
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

describe("Try it: the follow-up queue", () => {
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
    const back = reduce(start, { type: "moveLead", id: "david", direction: -1 });
    assert.equal(back, start, "an inquiry has no earlier stage");
    let state = start;
    for (let step = 0; step < 6; step += 1) {
      state = reduce(state, { type: "moveLead", id: "sarah", direction: 1 });
    }
    const sarah = state.leads.find((lead) => lead.id === "sarah");
    assert.equal(sarah.stage, "enrolled");
    assert.equal(leadBand(sarah), "done");
    assert.equal(leadTotals(state.leads).enrolled, 1);
  });

  it("resets to the sample class and queue", () => {
    const busy = reduce(cycle(start, "maya"), { type: "addLead", lead: newLead });
    assert.deepEqual(reduce(busy, { type: "reset" }), start);
  });
});

describe("Landing links", () => {
  it("leaves current sections and FAQ topics alone", () => {
    for (const target of LANDING_TARGETS) assert.equal(resolveLegacyHash(`#${target}`), null);
    assert.equal(resolveLegacyHash(""), null);
    assert.equal(resolveLegacyHash("#not-a-section"), null);
  });

  it("sends every retired chapter and topic to a section that exists", () => {
    for (const retired of [
      "the-problem",
      "studio-view",
      "use-cases",
      "signals-gather",
      "explore",
      "class-ready",
      "about",
      "stillness",
      "faq-switching",
      "faq-data",
      "faq-roadmap",
    ]) {
      assert.ok(retired in LANDING_HASH_ALIASES, `${retired} has no alias`);
    }
    for (const [from, to] of Object.entries(LANDING_HASH_ALIASES)) {
      assert.ok(LANDING_TARGETS.has(to), `${from} points at missing ${to}`);
      assert.equal(resolveLegacyHash(`#${from}`), to);
    }
  });
});

describe("Landing motion and accessibility", () => {
  it("only animates on scroll where supported and where motion is welcome", () => {
    const motion = pageCss.indexOf("@media (prefers-reduced-motion: no-preference)");
    assert.ok(motion > 0);
    const timelines = [...pageCss.matchAll(/animation-timeline:/g)].map((match) => match.index);
    assert.ok(timelines.length >= 10);
    assert.ok(
      timelines.every((index) => index > motion),
      "every scroll animation is gated",
    );
    assert.match(pageCss, /@supports \(animation-timeline: view\(\)\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  it("never intercepts scrolling or input, and the demo is client state only", () => {
    assert.doesNotMatch(allSource, /addEventListener\("(?:wheel|touchstart|touchmove|keydown)"/);
    assert.doesNotMatch(allSource, /preventDefault\(/);
    assert.doesNotMatch(
      sources["try-it.tsx"] + sources["try-model.ts"],
      /fetch\(|localStorage|sessionStorage/,
    );
    assert.match(sources["try-it.tsx"], /initialTryState\(STUDENTS, LEADS\)/);
  });

  it("announces demo changes and labels decorative art and the real product", () => {
    assert.match(sources["try-it.tsx"], /role="status" aria-live="polite"/);
    assert.match(sources["try-it.tsx"], /role="progressbar"/);
    assert.match(sources["hero.tsx"], /className=\{styles\.art\} aria-hidden="true"/);
    assert.match(sources["product.tsx"], /alt=\{product\.image\.alt\}/);
    assert.match(css, /outline: 2px solid currentColor/);
  });

  it("ships every scene still it references, wide and tall where phones need a different crop", () => {
    const publicDir = new URL("../public/", import.meta.url);
    const referenced = [...allSource.matchAll(/"\/marketing\/scenes\/([\w-]+\.webp)"/g)].map(
      (match) => match[1],
    );
    assert.ok(referenced.length >= 2);
    for (const file of referenced) {
      assert.ok(existsSync(new URL(`marketing/scenes/${file}`, publicDir)), file);
    }
    assert.ok(referenced.includes("class-wide.webp") && referenced.includes("class-tall.webp"));
  });

  it("uses only scoped marketing materials and no external runtime", () => {
    assert.doesNotMatch(
      `${allSource}\n${css}`,
      /from\s+["']https?:|\bsrc=["']https?:|unpkg|<script|@font-face|url\(["']?https?:/i,
    );
  });
});
