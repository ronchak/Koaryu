import assert from "node:assert/strict";
import { test } from "node:test";
import { expect } from "@playwright/test";
import {
  mountTools,
  flush,
  selectEmail,
  emailNode,
  ids,
} from "./helpers/workflow-tools-fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const simulation = (page) => page.getByRole("region", { name: "Workflow simulation", exact: true });
const sample = (page) => page.getByRole("region", { name: "Workflow sample email", exact: true });
const history = (page) => page.getByRole("region", { name: "Workflow run history", exact: true });
const calls = (page, part) =>
  page.evaluate((part) => window.fixture.reads.filter((row) => row.path.includes(part)), part);
async function readableTimes(region, expected) {
  const times = await region.locator("time").evaluateAll((nodes) =>
    nodes.map((node) => ({
      iso: node.getAttribute("datetime"),
      title: node.title,
      label: node.textContent,
    })),
  );
  assert.deepEqual(
    times.map((time) => time.iso),
    expected,
  );
  assert.ok(
    times.every((time) => time.title === time.iso && /Oct 5, 2026.*12:00:00.*UTC/.test(time.label)),
  );
  await expect(region).not.toContainText("2026-10-05T12:00:00");
}
async function startSample(page) {
  await selectEmail(page);
  await button(page, "Send sample email").click();
  await button(page, "Confirm sample").click();
  await expect.poll(() => page.evaluate(() => window.fixture.requests.length)).toBe(1);
}
async function openRun(page) {
  await button(page, "Load history").click();
  await button(page, `View run ${ids.run.slice(0, 8)}`).click();
  await expect(page.getByRole("article", { name: "Selected run detail" })).toBeVisible();
}
async function changeEmail(page, subject) {
  await page.evaluate((subject) => {
    const f = window.fixture,
      node = f
        .owner()
        .getSnapshot()
        .editor.history.present.graph.nodes.find((row) => row.type === "email");
    f.edit({
      kind: "update_config",
      node_id: node.id,
      update: { type: "email", config: { ...node.config, subject_template: subject } },
    });
  }, subject);
}

test("preview tools explain live-only actions with zero API, source, auth or journal I/O", () =>
  mountTools(
    async (page) => {
      await expect(simulation(page)).toContainText("available in your live studio");
      await expect(history(page)).toContainText("available in your live studio");
      await expect(sample(page)).toContainText("Preview sends nothing");
      assert.deepEqual(
        await page.evaluate(() => ({
          reads: window.fixture.reads.length,
          sources: window.fixture.sources.length,
          requests: window.fixture.requests.length,
          auth: window.fixture.auth.size,
          readsStorage: window.fixture.storageReads,
          writes: window.fixture.storageWrites,
        })),
        { reads: 0, sources: 0, requests: 0, auth: 0, readsStorage: 0, writes: 0 },
      );
    },
    { preview: true },
  ));

test("synthetic is default, loads no records, and displays the exact ordered trace and next actions", () =>
  mountTools(async (page) => {
    await expect(simulation(page)).toContainText("Context: Synthetic sample");
    assert.equal(await page.evaluate(() => window.fixture.sources.length), 0);
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    assert.equal(await simulation(page).locator("ol > li").count(), 6);
    assert.equal(await simulation(page).locator("ul").last().locator("li").count(), 2);
    await expect(simulation(page)).toContainText("Selected branch: yes");
    const request = await page.evaluate(() => window.fixture.simulations[0]);
    assert.equal(request.path, `/automations/workflows/${ids.workflow}/simulate`);
    assert.deepEqual(request.body.context, { kind: "synthetic" });
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    await simulation(page).getByRole("button", { name: "email · would send", exact: true }).click();
    await expect(sample(page)).toContainText("Selected email: Hi");
  }));

test("semantic-invalid dirty graph reaches the server and shows valid=false issues", () =>
  mountTools(async (page) => {
    await page.evaluate(() => {
      const f = window.fixture,
        graph = f.owner().getSnapshot().editor.history.present.graph;
      f.edit({ kind: "disconnect", edge_id: graph.edges[0].id });
      f.simulationIndex = 8;
    });
    await button(page, "Simulate").click();
    await expect(simulation(page)).toContainText("needs changes");
    assert.equal(await page.evaluate(() => window.fixture.simulations.length), 1);
    assert.equal(await simulation(page).locator("ol > li").count(), 0);
  }));

test("waiting stops at the returned step and rendered subject/body remain escaped text", () =>
  mountTools(async (page) => {
    await page.evaluate(() => {
      window.fixture.simulationIndex = 3;
    });
    await button(page, "Simulate").click();
    await expect(simulation(page)).toContainText("trace stops at the first wait");
    assert.equal(await simulation(page).locator("ol > li").count(), 3);
    await readableTimes(simulation(page), [
      "2026-10-05T12:00:00.123456Z",
      "2026-10-05T12:00:00.123457Z",
      "2026-10-05T12:00:00.123457Z",
    ]);
    await expect(simulation(page)).toContainText("Reason: facts unavailable");
    await page.evaluate(() => {
      const f = window.fixture;
      f.simulationOverride = structuredClone(f.spec.simulations[0].response);
      const email = f.simulationOverride.trace.find((step) => step.action_kind === "email");
      email.rendered_subject = '<img src=x onerror="window.injected=true">';
      email.rendered_body = "<script>window.injected=true</script>\nBody & more";
    });
    await button(page, "Simulate").click();
    await expect(simulation(page).locator("pre")).toContainText("<script>");
    assert.equal(await simulation(page).locator("img,script").count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  }));

test("metadata/layout preserve a valid trace while semantic edit and undo cannot revive it", () =>
  mountTools(async (page) => {
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    await page.evaluate(() => {
      const f = window.fixture;
      f.owner().edit({ kind: "metadata", name: "Changed title" });
      f.edit({ kind: "commit_position", node_id: "hasOwnProperty", position: { x: 140, y: 200 } });
    });
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    await changeEmail(page, "Changed subject");
    await expect(simulation(page)).toContainText("no longer current");
    await page.evaluate(() => window.fixture.owner().edit({ kind: "undo" }));
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toHaveCount(0);
  }));

test("context change fences held simulation and a later synthetic choice does not revive it", () =>
  mountTools(async (page) => {
    await page.evaluate(() => {
      window.fixture.hold.simulation = true;
    });
    await button(page, "Simulate").click();
    await button(page, "Choose real record").click();
    await button(page, "Use synthetic sample").click();
    await page.evaluate(() => window.fixture.release("simulation"));
    await flush(page);
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
  }));

for (const status of [404, 503])
  test(`simulation ${status} is a read error with no receipt recovery`, () =>
    mountTools(async (page) => {
      await page.evaluate((status) => {
        window.fixture.errors.simulation = status;
      }, status);
      await button(page, "Simulate").click();
      await expect(simulation(page).getByRole("alert")).toBeVisible();
      await expect(simulation(page)).not.toContainText("PRIVATE");
      assert.equal((await calls(page, "/operations/")).length, 0);
      assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    }));

test("history loads explicit pages, preserves rows on failed refresh and reads exact current detail", () =>
  mountTools(async (page) => {
    assert.equal((await calls(page, "/runs?")).length, 0);
    await openRun(page);
    assert.equal(
      (await calls(page, "/runs?"))[0].path,
      `/automations/workflows/${ids.workflow}/runs?limit=50`,
    );
    assert.equal((await calls(page, `/runs/${ids.run}`)).length, 1);
    await expect(history(page)).toContainText("Version 7");
    await expect(history(page)).toContainText("Submission evidence: Unavailable");
    await page.evaluate(() => {
      window.fixture.errors.runs = 422;
    });
    await button(page, "Next runs").click();
    await expect(history(page)).toContainText("previous page is still shown");
    await expect(button(page, `View run ${ids.run.slice(0, 8)}`)).toBeDisabled();
    await expect(history(page)).not.toContainText("invalid cursor");
    await page.evaluate(() => {
      delete window.fixture.errors.runs;
    });
    await button(page, "Retry history").click();
    await button(page, "Next runs").click();
    await expect(history(page)).toContainText("No runs on this page");
    const pages = await calls(page, "/runs?");
    assert.ok(pages.at(-1).path.includes("cursor=opaque%2B%2F+%3Dcursor"));
    await button(page, "Previous runs").click();
    await expect(button(page, `View run ${ids.run.slice(0, 8)}`)).toBeEnabled();
  }));

test("recent records use catalog event mapping and exact subject without parent discovery", () =>
  mountTools(async (page) => {
    await button(page, "Load history").click();
    await button(page, "Use this recent record").click();
    await expect(simulation(page)).toContainText("Synthetic 🥋 lead");
    assert.equal(await page.evaluate(() => window.fixture.sources.length), 0);
    await button(page, "Simulate").click();
    assert.deepEqual(await page.evaluate(() => window.fixture.simulations[0].body.context), {
      kind: "entity",
      entity_type: "lead",
      entity_id: ids.subject,
    });
    await page.evaluate(() => window.fixture.setType("payment"));
    await expect(button(page, "Use this recent record")).toHaveCount(0);
    await expect(simulation(page)).toContainText("Context: Synthetic sample");
  }));

test("history pending cancellation survives off-page, lost response, and confirmed current 404", () =>
  mountTools(async (page) => {
    await openRun(page);
    await button(page, "Cancel this run").click();
    await button(page, "Confirm cancellation").click();
    await expect.poll(() => page.evaluate(() => window.fixture.requests.length)).toBe(1);
    await page.evaluate(() => window.fixture.fail());
    await expect(button(page, "Check cancellation result")).toBeEnabled();
    await button(page, "Next runs").click();
    await expect(history(page)).toContainText("No runs on this page");
    await page.evaluate(() => {
      window.fixture.errors.run = 404;
    });
    await button(page, "Check cancellation result").click();
    await expect(history(page)).toContainText("Its current run is unavailable");
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
    assert.equal((await calls(page, "/operations/")).length, 1);
  }));

test("cancellation current sending state is displayed without claiming stopped delivery", () =>
  mountTools(async (page) => {
    await openRun(page);
    await button(page, "Cancel this run").click();
    await button(page, "Confirm cancellation").click();
    await page.evaluate(() => window.fixture.complete("sending"));
    await expect(history(page)).toContainText("Current run state: sending");
    await expect(history(page)).toContainText("An email already sending may still be accepted");
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
  }));

for (const close of ["Escape", "Keep reviewing", "backdrop"])
  test(`cancel confirmation restores identical opener through ${close}`, () =>
    mountTools(async (page) => {
      await openRun(page);
      await button(page, "Cancel this run").click();
      await page.evaluate(() => {
        window.openerProbe = [...document.querySelectorAll("button")].find(
          (node) => node.textContent === "Cancel this run",
        );
      });
      await expect(page.getByRole("dialog", { name: "Cancel this run?" })).toBeVisible();
      if (close === "Escape") await page.keyboard.press("Escape");
      else if (close === "backdrop")
        await page.locator(".koaryu-modal-backdrop").click({ position: { x: 2, y: 2 } });
      else await button(page, close).click();
      assert.equal(
        await page.evaluate(
          () => document.activeElement === window.openerProbe && window.openerProbe.isConnected,
        ),
        true,
      );
      assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    }));

test("sample captures graph synchronously, rejects later graph edits, and contains synchronous failures", () =>
  mountTools(async (page) => {
    await selectEmail(page);
    await button(page, "Send sample email").click();
    await changeEmail(page, "Changed before confirm");
    await button(page, "Confirm sample").click();
    await expect(sample(page).getByRole("alert")).toBeVisible();
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    await button(page, "Send sample email").click();
    await button(page, "Confirm sample").click();
    await expect.poll(() => page.evaluate(() => window.fixture.requests.length)).toBe(1);
  }));

test("duplicate activation reserves a sample and unknown response recovers after reload without a new send", () =>
  mountTools(async (page) => {
    await startSample(page);
    await page.evaluate(() => {
      const f = window.fixture,
        editor = f.owner().getSnapshot().editor;
      void f
        .owner()
        .activity.createTest(editor.workflowId, editor.history.present.graph, "hasOwnProperty");
      f.fail();
    });
    await expect(button(page, "Check sample result")).toBeEnabled();
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
    await page.reload();
    await expect(button(page, "Check sample result")).toBeEnabled();
    await button(page, "Check sample result").click();
    await expect(sample(page)).toContainText("provider accepted this sample");
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    await expect(button(page, "Dismiss sample result")).toBeEnabled();
  }));

for (const state of ["accepted", "failed", "unknown"])
  test(`known terminal ${state} exposes Dismiss and requires a separate new intent`, () =>
    mountTools(async (page) => {
      await startSample(page);
      await page.evaluate((state) => window.fixture.complete(state), state);
      await expect(button(page, "Create another sample")).toBeEnabled();
      if (state === "unknown") {
        const warning = "The previous sample may have been accepted and will not be retried.";
        await expect(sample(page).getByText(warning, { exact: true })).toHaveCount(1);
        await page.evaluate(() => {
          window.fixture.errors.delivery = 503;
        });
        await button(page, "Check sample result").click();
        await expect(sample(page)).toContainText("Check again to load its current state.");
        await expect(sample(page).locator("p").filter({ hasText: warning })).toHaveCount(1);
        await page.evaluate(() => {
          delete window.fixture.errors.delivery;
        });
      }
      const first = await page.evaluate(() => window.fixture.requests[0].body.operation_id);
      await button(page, "Create another sample").click();
      await button(page, "Keep reviewing").click();
      assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
      await button(page, "Create another sample").click();
      await button(page, "Confirm sample").click();
      await expect.poll(() => page.evaluate(() => window.fixture.requests.length)).toBe(2);
      assert.notEqual(
        await page.evaluate(() => window.fixture.requests[1].body.operation_id),
        first,
      );
      await page.evaluate(() => window.fixture.complete("accepted"));
      await button(page, "Dismiss sample result").click();
      await expect(button(page, "Check sample result")).toHaveCount(0);
    }));

test("removed email node and disabled new-send capability preserve existing recovery controls", () =>
  mountTools(async (page) => {
    await startSample(page);
    await page.evaluate(() => {
      const f = window.fixture;
      f.fail();
      f.edit({ kind: "remove_node", node_id: "hasOwnProperty" });
      f.catalog.capabilities.can_test_email = false;
      void f.owner().loadCatalog();
    });
    await expect(button(page, "Check sample result")).toBeEnabled();
    await button(page, "Check sample result").click();
    await expect(button(page, "Dismiss sample result")).toBeEnabled();
    await expect(button(page, "Create another sample")).toBeDisabled();
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
  }));

test("storage block is explicit and Check storage repairs before a separate dismissal", () =>
  mountTools(async (page) => {
    await startSample(page);
    await page.evaluate(() => window.fixture.complete("accepted"));
    await page.evaluate(() => {
      window.fixture.storageBlocked = true;
    });
    await button(page, "Dismiss sample result").click();
    await expect(button(page, "Check storage")).toBeVisible();
    await page.evaluate(() => {
      window.fixture.storageBlocked = false;
    });
    await button(page, "Check storage").click();
    await expect(button(page, "Check sample result")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
  }));

test("first-sample confirmation permanently closes when a different pending intent appears and is dismissed", () =>
  mountTools(async (page) => {
    await selectEmail(page);
    await button(page, "Send sample email").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.evaluate(() => {
      const f = window.fixture,
        editor = f.owner().getSnapshot().editor;
      void f
        .owner()
        .activity.createTest(editor.workflowId, editor.history.present.graph, "hasOwnProperty");
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() => window.fixture.complete("accepted"));
    await button(page, "Dismiss sample result").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await flush(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }));

for (const transition of ["role", "workflow"])
  test(`held activity reads and confirmations cannot publish after ${transition} replacement`, () =>
    mountTools(async (page) => {
      await selectEmail(page);
      await page.evaluate(() => {
        window.fixture.hold.simulation = true;
      });
      await button(page, "Simulate").click();
      await button(page, "Send sample email").click();
      await page.evaluate((transition) => {
        const f = window.fixture;
        if (transition === "role") f.change({ role: "staff" });
        else {
          f.routeWorkflow = "99999999-0000-4000-8000-000000000001";
          f.current = { ...f.current, id: f.routeWorkflow };
          f.notify();
        }
        f.release("simulation");
      }, transition);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Visited path" })).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    }));

test("320px tools and sample modal fit without overflow and keep 44px controls", () =>
  mountTools(async (page) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await selectEmail(page);
    await button(page, "Send sample email").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const small = await page
      .locator(
        '[aria-label="Workflow simulation"] button,[aria-label="Workflow run history"] button,[aria-label="Workflow sample email"] button,[role="dialog"] button',
      )
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getBoundingClientRect().height < 44)
          .map((node) => node.textContent),
      );
    assert.deepEqual(small, []);
    await page.keyboard.press("Escape");
    assert.equal(
      await button(page, "Send sample email").evaluate((node) => document.activeElement === node),
      true,
    );
  }));

for (const state of ["queued", "sending"])
  test(`sample ${state} stays reserved without new-intent or dismissal controls`, () =>
    mountTools(async (page) => {
      await startSample(page);
      await page.evaluate((state) => window.fixture.complete(state), state);
      await expect(sample(page)).toContainText(`Sample result: ${state}`);
      await expect(button(page, "Create another sample")).toHaveCount(0);
      await expect(button(page, "Dismiss sample result")).toHaveCount(0);
      await expect(button(page, "Send sample email")).toHaveCount(0);
      await expect(button(page, "Check sample result")).toBeEnabled();
    }));

test("missing sample receipt keeps recovery reserved without a new-send bypass", () =>
  mountTools(async (page) => {
    await startSample(page);
    await page.evaluate(() => {
      window.fixture.fail();
      window.fixture.errors.receipt = 404;
    });
    await button(page, "Check sample result").click();
    await expect(sample(page)).toContainText("request remains reserved");
    await expect(button(page, "Send sample email")).toHaveCount(0);
    await expect(button(page, "Create another sample")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
  }));

for (const close of ["Escape", "Keep reviewing", "backdrop"])
  test(`sample confirmation returns focus to identical connected opener through ${close}`, () =>
    mountTools(async (page) => {
      await selectEmail(page);
      await button(page, "Send sample email").click();
      await page.evaluate(() => {
        window.openerProbe = [...document.querySelectorAll("button")].find(
          (node) => node.textContent === "Send sample email",
        );
      });
      if (close === "Escape") await page.keyboard.press("Escape");
      else if (close === "backdrop")
        await page.locator(".koaryu-modal-backdrop").click({ position: { x: 2, y: 2 } });
      else await button(page, close).click();
      assert.equal(
        await page.evaluate(
          () => document.activeElement === window.openerProbe && window.openerProbe.isConnected,
        ),
        true,
      );
      assert.equal(await page.evaluate(() => window.fixture.requests.length), 0);
    }));

test("held current run read keeps opener focusable and prevents duplicate native activation", () =>
  mountTools(async (page) => {
    await button(page, "Load history").click();
    await page.evaluate(() => {
      window.fixture.hold.run = true;
    });
    const opener = button(page, `View run ${ids.run.slice(0, 8)}`);
    await opener.click();
    await expect(opener).toBeEnabled();
    await expect(opener).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Enter");
    await opener.click();
    assert.equal((await calls(page, `/runs/${ids.run}`)).length, 1);
    await page.evaluate(() => window.fixture.release("run"));
    await expect(page.getByRole("article", { name: "Selected run detail" })).toBeVisible();
    assert.equal(await opener.evaluate((node) => document.activeElement === node), true);
  }));

test("multiple trigger draft retains synthetic simulation but offers no real-context inference", () =>
  mountTools(async (page) => {
    await page.evaluate(async () => {
      const f = window.fixture;
      f.current.draft_graph = structuredClone(f.owner().getSnapshot().editor.history.present.graph);
      const trigger = f.current.draft_graph.nodes.find((row) => row.type === "trigger");
      f.current.draft_graph.nodes.push({ ...trigger, id: "second_trigger" });
      await f.owner().openWorkflow(f.current.id, true);
      f.simulationIndex = 8;
    });
    await expect(button(page, "Choose real record")).toBeDisabled();
    await expect(button(page, "Simulate")).toBeEnabled();
    await button(page, "Simulate").click();
    await expect(simulation(page)).toContainText("needs changes");
    assert.equal(await page.evaluate(() => window.fixture.simulations.length), 1);
  }));

test("history only offers a payment recent record through the event's exact simulation entity mapping", () =>
  mountTools(async (page) => {
    await page.evaluate(() => {
      const f = window.fixture;
      f.runPage.items[0] = {
        ...f.runPage.items[0],
        event_type: "invoice.payment_failed",
        subject_kind: "invoice",
      };
      f.setType("payment");
    });
    await button(page, "Load history").click();
    await button(page, "Use this recent record").click();
    await button(page, "Simulate").click();
    assert.deepEqual(await page.evaluate(() => window.fixture.simulations[0].body.context), {
      kind: "entity",
      entity_type: "payment",
      entity_id: ids.subject,
    });
    assert.equal(await page.evaluate(() => window.fixture.sources.length), 0);
    assert.equal((await calls(page, "/billing/")).length, 0);
  }));

test("readable UTC history preserves exact instants, plain evidence, and cancellation inputs", () =>
  mountTools(async (page) => {
    const iso = "2026-10-05T12:00:00.123456Z",
      later = "2026-10-05T12:00:00.123457Z";
    await page.evaluate(() => {
      const run = window.fixture.currentRun;
      run.steps[0].scheduled_at = run.steps[0].entered_at;
      run.attempts[0].state = "failed";
      run.attempts[0].submission_evidence = "not_submitted";
      run.attempts[0].failure_scope = "sender_auth";
    });
    const before = await page.evaluate(() => window.fixture.currentRun);
    await openRun(page);
    await readableTimes(history(page), [iso, iso, iso, iso, iso, iso, later]);
    await expect(history(page)).toContainText("published version it started with");
    await expect(history(page)).toContainText("historical reason");
    await expect(history(page)).toContainText("Submission evidence: not submitted");
    await expect(history(page)).toContainText("Failure scope: sender auth");
    assert.deepEqual(await page.evaluate(() => window.fixture.currentRun), before);
    await button(page, "Cancel this run").click();
    await button(page, "Confirm cancellation").click();
    const request = await page.evaluate(() => window.fixture.requests[0]);
    assert.equal(request.body.expected_revision, before.run.revision);
    assert.equal(request.path, `/automations/runs/${before.run.id}/cancel`);
    await page.evaluate(() => window.fixture.complete("sending"));
    await expect(history(page)).toContainText("Current run state: sending");
    await readableTimes(history(page), [iso, later]);
    await button(page, "Refresh selected run").click();
    await expect(history(page)).toContainText("Cancellation reason: operator cancelled");
    await expect(history(page)).toContainText("Next due: Unavailable");
    assert.equal(await page.evaluate(() => window.fixture.requests.length), 1);
  }));

test("local lead filtering preserves a current simulation until the selected record changes", () =>
  mountTools(async (page) => {
    await page.evaluate(() => {
      window.fixture.resources.leads = Array.from({ length: 75 }, (_, index) => ({
        id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000001`,
        first_name: `Person ${String(index).padStart(2, "0")}`,
        last_name: "Lead",
        stage: "inquiry",
      }));
    });
    await button(page, "Choose real record").click();
    await button(page, "Load lead records").click();
    await expect(simulation(page)).toContainText("Showing 50 of 75 loaded matches");
    await page.getByRole("textbox", { name: "Search loaded records" }).fill("Person 74");
    await page.getByRole("button", { name: /^Person 74/ }).click();
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    await page.getByRole("textbox", { name: "Search loaded records" }).fill("");
    await expect(page.getByRole("button", { name: /^Person 74/ })).toHaveCount(0);
    await expect(simulation(page).getByText(/^Context: Person 74 Lead/)).toBeVisible();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.fixture.sources.length), 1);
    assert.equal(await page.evaluate(() => window.fixture.simulations.length), 1);
    await page.getByRole("button", { name: /^Person 00/ }).click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toHaveCount(0);
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    const contexts = await page.evaluate(() =>
      window.fixture.simulations.map((row) => row.body.context),
    );
    assert.equal(contexts[0].entity_id, "00000074-0000-4000-8000-000000000001");
    assert.equal(contexts[1].entity_id, "00000000-0000-4000-8000-000000000001");
    assert.equal(await page.evaluate(() => window.fixture.sources.length), 1);
  }));

test("external failed lead refresh clears the composed selection and trace before any metadata rerender", () =>
  mountTools(async (page) => {
    await button(page, "Choose real record").click();
    await button(page, "Load lead records").click();
    const row = page.getByRole("button", { name: /^Casey Lead/ });
    await row.click();
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    await page.evaluate(async () => {
      const f = window.fixture;
      f.errors.leads = 503;
      await f.refreshLeads().catch(() => {});
    });
    await expect(row).toBeDisabled();
    await expect(button(page, "Simulate")).toBeDisabled();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toHaveCount(0);
    await page.evaluate(() => {
      const f = window.fixture;
      delete f.errors.leads;
      f.hold.leads = true;
      f.externalRefresh = f.refreshLeads();
    });
    await flush(page);
    await expect(row).toBeDisabled();
    await expect(button(page, "Simulate")).toBeDisabled();
    await page.evaluate(() =>
      window.fixture.owner().edit({ kind: "metadata", name: "During held external retry" }),
    );
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toHaveCount(0);
    assert.deepEqual(
      await page.evaluate(() => ({
        held: window.fixture.held.filter((row) => !row.done).length,
        sources: window.fixture.sources.length,
        simulations: window.fixture.simulations.length,
      })),
      { held: 1, sources: 3, simulations: 1 },
    );
    await page.evaluate(async () => {
      const f = window.fixture;
      f.hold.leads = false;
      f.release("leads");
      await f.externalRefresh;
    });
    await expect(row).toBeEnabled();
    await expect(button(page, "Simulate")).toBeDisabled();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toHaveCount(0);
    await row.click();
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    assert.equal(await page.evaluate(() => window.fixture.simulations.length), 2);
    assert.equal(await page.evaluate(() => window.fixture.sources.length), 3);
  }));

test("an unrelated lead-cache failure preserves a valid recent-history selection and its trace", () =>
  mountTools(async (page) => {
    await button(page, "Choose real record").click();
    await button(page, "Load lead records").click();
    await expect(page.getByRole("button", { name: /^Casey Lead/ })).toBeEnabled();
    await button(page, "Load history").click();
    await button(page, "Use this recent record").click();
    await button(page, "Simulate").click();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    await page.evaluate(async () => {
      const f = window.fixture;
      f.errors.leads = 503;
      await f.refreshLeads().catch(() => {});
    });
    await expect(page.getByRole("button", { name: /^Casey Lead/ })).toBeDisabled();
    await expect(button(page, "Simulate")).toBeEnabled();
    await expect(simulation(page).getByRole("heading", { name: "Visited path" })).toBeVisible();
    await expect(simulation(page)).toContainText("Context: Synthetic 🥋 lead");
    assert.equal(await page.evaluate(() => window.fixture.simulations.length), 1);
  }));
