import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle(mode = "production") {
  if (mode !== "production" && mode !== "development") {
    throw new TypeError("Unsupported React mode");
  }
  const modeSource = mode === "development" ? "'development'" : "'production'";
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `const React=require('react');exports.useConfigStore=exports.useStudioStore=()=>React.useSyncExternalStore(window.f.subscribe,window.f.getState);`,
    "@/lib/api": `class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}exports.ApiError=window.f.ApiError=ApiError;exports.CommandOutcomeUnknown=window.f.Unknown=require('@/lib/command-outcome').CommandOutcomeUnknown;exports.api=window.f.api;`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add("@/components/automations/missed-class-automation");
  const retained = add("@/lib/retained-state");
  return `(()=>{const process={env:{NODE_ENV:${modeSource}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}window.f.root=require(${dom}).createRoot(document.getElementById('root'));const React=require(${react});function Fixture(){const state=React.useSyncExternalStore(window.f.subscribe,window.f.getState);const[shown,setShown]=React.useState(true);window.f.show=setShown;return React.createElement(require(${retained}).RetainedStateProvider,{scope:JSON.stringify([state.isPreviewMode,state.currentUserId,state.currentStudioId,state.identityGeneration])},shown?React.createElement(require(${subject}).MissedClassAutomation):null)}window.f.root.render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));})();`;
}

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

async function mount(t, options = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
  });
  await page.setContent('<div id="root"></div>');
  await page.evaluate((options) => {
    const f = (window.f = {
      calls: [],
      previews: [],
      saves: [],
      reads: [],
      activityReads: [],
      ...options,
    });
    const listeners = new Set();
    f.state = {
      token: "token-one",
      isPreviewMode: false,
      currentRole: "admin",
      currentStudioId: "studio-one",
      currentUserId: "owner-one",
      identityGeneration: 1,
      identityReady: true,
      ...options.state,
    };
    f.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    f.getState = () => f.state;
    f.setState = (patch) => {
      f.state = { ...f.state, ...patch };
      listeners.forEach((listener) => listener());
    };
    f.settings = {
      rule: {
        enabled: !!options.enabled,
        inactivity_days: 14,
        subject_template: "Hello {{student_first_name}}",
        body_template: "Welcome back to {{studio_name}} after {{days_absent}} days.",
        reply_to_email: "studio@example.test",
        revision: 7,
        updated_at: null,
      },
      delivery_status: {
        mode: options.mode ?? "test",
        configured: true,
        can_enable: options.canEnable ?? true,
        sender: "sample@example.test",
        test_recipient: "approved@example.test",
        reason: options.canEnable === false ? "setup_required" : null,
      },
    };
    f.activity = {
      items: [
        {
          id: "activity-one",
          student_id: "alex",
          student_name: "Activity Alex",
          recipient_email: "guardian@example.test",
          state: "accepted",
          created_at: "2026-10-04T10:00:00Z",
          attempted_at: null,
          settled_at: null,
          attempts: 1,
          reason: null,
        },
        {
          id: "activity-two",
          student_id: "sam",
          student_name: "Activity Sam",
          recipient_email: "sam@example.test",
          state: "unknown",
          created_at: "2026-10-04T10:00:00Z",
          attempted_at: null,
          settled_at: null,
          attempts: 1,
          reason: "provider_unknown",
        },
      ],
      has_more: true,
    };
    f.previewResult = (draft, name = "Preview Alex") => ({
      reference_date: "2026-10-04",
      eligible_count: 101,
      skipped_count: 2,
      truncated: true,
      recipients: [
        {
          student_id: "alex",
          student_name: name,
          last_attendance_date: "2026-09-18",
          days_absent: 16,
          recipient_name: "Guardian Alex",
          recipient_email: "guardian@example.test",
          recipient_kind: "guardian",
          skip_reason: null,
          rendered_subject: draft.subject_template.replaceAll("{{student_first_name}}", "Alex"),
          rendered_body: draft.body_template
            .replaceAll("{{studio_name}}", "Sample studio")
            .replaceAll("{{days_absent}}", "16"),
        },
        {
          student_id: "skip",
          student_name: "No Contact",
          last_attendance_date: null,
          days_absent: null,
          recipient_name: null,
          recipient_email: null,
          recipient_kind: null,
          skip_reason: "guardian_ambiguous",
          rendered_subject: null,
          rendered_body: null,
        },
      ],
    });
    f.api = {
      get: (path, token, options) => {
        f.calls.push({ method: "GET", path, token });
        if (path.includes("activity") && f.holdActivity)
          return new Promise((resolve, reject) =>
            f.activityReads.push({ resolve, reject, signal: options.signal }),
          );
        if (path.includes("activity"))
          return f.failActivity
            ? Promise.reject(new Error("Activity unavailable"))
            : Promise.resolve(structuredClone(f.activity));
        if (f.holdSettings)
          return new Promise((resolve, reject) =>
            f.reads.push({ resolve, reject, signal: options.signal }),
          );
        return Promise.resolve(structuredClone(f.settings));
      },
      post: (path, body, token, options) => {
        f.calls.push({ method: "POST", path, token, body });
        return new Promise((resolve, reject) =>
          f.previews.push({ body, resolve, reject, signal: options.signal }),
        );
      },
      put: (path, body, token, options) => {
        f.calls.push({ method: "PUT", path, token, body });
        return new Promise((resolve, reject) =>
          f.saves.push({ body, resolve, reject, signal: options.signal }),
        );
      },
    };
  }, options);
  await page.addScriptTag({ content: bundle(options.modeEnvironment) });
  return page;
}

async function loaded(page) {
  await page.getByLabel("Subject", { exact: true }).waitFor();
}
async function preview(page) {
  const count = await page.evaluate(() => window.f.previews.length);
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await page.waitForFunction((count) => window.f.previews.length === count + 1, count);
  await page.evaluate((count) => {
    const p = window.f.previews[count];
    p.resolve(window.f.previewResult(p.body));
  }, count);
  await page.getByText("101 eligible", { exact: false }).waitFor();
}

test("development StrictMode demo remains interactive after effect replay and parent updates", async (t) => {
  const page = await mount(t, { state: { isPreviewMode: true }, modeEnvironment: "development" });
  await loaded(page);
  await page.getByLabel("Days without attendance").fill("30");
  await page.evaluate(() => window.f.setState({ token: null }));
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await page.getByText("1 eligible · 1 skipped · Sample date 2026-10-04").waitFor();
  assert.equal(await page.getByLabel("Days without attendance").inputValue(), "30");
  assert.deepEqual(await page.evaluate(() => window.f.calls), []);
});

test("demo permits safe experimentation, makes zero API calls and cannot save or enable", async (t) => {
  const page = await mount(t, { state: { isPreviewMode: true } });
  await loaded(page);
  await page
    .getByLabel("Subject", { exact: true })
    .fill("<script>window.bad=true</script> Hello {{student_first_name}}");
  await page.getByLabel("Days without attendance").fill("30");
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await page.getByText("1 eligible · 1 skipped · Sample date 2026-10-04").waitFor();
  assert.match(
    await page.getByRole("article", { name: "Email preview" }).innerText(),
    /<script>window.bad=true<\/script> Hello Alex/,
  );
  assert.equal(await page.locator("#root script").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Enable automation" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save paused rule" }).isDisabled(), true);
  assert.match(
    await page.locator("#root").innerText(),
    /32 days absent · Last attendance 2026-09-02/,
  );
  assert.deepEqual(await page.evaluate(() => window.f.calls), []);
});

for (const state of [
  { currentRole: "instructor" },
  { currentRole: "front_desk" },
  { identityReady: false },
]) {
  test(`protected data is never fetched for ${JSON.stringify(state)}`, async (t) => {
    const page = await mount(t, { state });
    await page
      .getByText(
        state.identityReady === false
          ? "Checking studio access..."
          : "An Admin can set up missed-class emails and view recipients.",
      )
      .waitFor();
    assert.deepEqual(await page.evaluate(() => window.f.calls), []);
    assert.equal(await page.getByLabel("Subject", { exact: true }).count(), 0);
  });
}

test("preview binds every editable field and rejects an old response even after A to B to A edits", async (t) => {
  const page = await mount(t);
  await loaded(page);
  assert.match(
    await page.getByLabel("Email delivery status").innerText(),
    /Only the approved test recipient/,
  );
  for (const [field, value] of [
    ["Subject", "Updated subject"],
    ["Message", "Updated message"],
    ["Days without attendance", "20"],
    ["Reply-to email", "reply@example.test"],
  ]) {
    await preview(page);
    assert.equal(await page.getByRole("button", { name: "Enable automation" }).isEnabled(), true);
    await page.getByLabel(field, { exact: true }).fill(value);
    assert.equal(await page.getByRole("article", { name: "Email preview" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Enable automation" }).isDisabled(), true);
  }
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await page.getByLabel("Subject", { exact: true }).fill("Draft B");
  await page.getByLabel("Subject", { exact: true }).fill("Updated subject");
  await page.evaluate(() => {
    const p = window.f.previews.at(-1);
    p.resolve(window.f.previewResult(p.body, "STALE PERSON"));
  });
  assert.equal(await page.getByText("STALE PERSON", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Enable automation" }).isDisabled(), true);
  await preview(page);
  assert.match(await page.locator("#root").innerText(), /101 eligible · 2 skipped/);
  assert.match(await page.locator("#root").innerText(), /Showing up to 100/);
  assert.match(await page.locator("#root").innerText(), /Skipped: guardian ambiguous/);
});

test("PUT owns its draft, suppresses double clicks and retains edits through rejection and token renewal", async (t) => {
  const page = await mount(t);
  await loaded(page);
  await page.getByLabel("Subject", { exact: true }).fill("Saved subject");
  await preview(page);
  await page.getByRole("button", { name: "Enable automation" }).evaluate((button) => {
    button.click();
    button.click();
  });
  await page.getByRole("button", { name: "Saving..." }).waitFor();
  assert.equal(await page.getByLabel("Subject", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByLabel("Reply-to email").isDisabled(), true);
  await page.evaluate(() => window.f.setState({ token: "token-two" }));
  assert.equal(await page.getByLabel("Subject", { exact: true }).inputValue(), "Saved subject");
  assert.equal(await page.getByLabel("Subject", { exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.f.saves.length), 1);
  assert.deepEqual(await page.evaluate(() => window.f.saves[0].body), {
    enabled: true,
    expected_revision: 7,
    inactivity_days: 14,
    subject_template: "Saved subject",
    body_template: "Welcome back to {{studio_name}} after {{days_absent}} days.",
    reply_to_email: "studio@example.test",
  });
  await page.evaluate(() =>
    window.f.saves[0].reject(new window.f.ApiError("Invalid template", 422)),
  );
  await page.getByText("Invalid template", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Subject", { exact: true }).inputValue(), "Saved subject");
  assert.equal(await page.getByLabel("Subject", { exact: true }).isEnabled(), true);
  await page.getByRole("button", { name: "Save paused rule" }).click();
  assert.equal(
    await page.evaluate(() => window.f.calls.filter((call) => call.method === "PUT")[1].token),
    "token-two",
  );
  await page.evaluate(() => {
    const p = window.f.saves[1];
    p.resolve({ ...window.f.settings, rule: { ...p.body, revision: 8, updated_at: null } });
  });
  await page.getByText("Paused rule saved.", { exact: false }).waitFor();
});

for (const kind of ["unknown", "stale"]) {
  test(`${kind} save needs a successful new readback, preserving draft until explicit Reload`, async (t) => {
    const page = await mount(t);
    await loaded(page);
    await page.getByLabel("Subject", { exact: true }).fill("Keep this draft");
    await page.getByRole("button", { name: "Save paused rule" }).click();
    await page.evaluate(
      (kind) =>
        window.f.saves[0].reject(
          kind === "unknown" ? new window.f.Unknown() : new window.f.ApiError("Stale", 409),
        ),
      kind,
    );
    await page.getByRole("button", { name: "Check saved rule" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save paused rule" }).isDisabled(), true);
    await page.getByLabel("Subject", { exact: true }).fill("Newer local draft");
    await page.evaluate(() => {
      window.f.holdSettings = true;
    });
    await page.getByRole("button", { name: "Check saved rule" }).click();
    await page.evaluate(() => window.f.reads[0].reject(new Error("Readback failed")));
    await page.getByText("Readback failed", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Save paused rule" }).isDisabled(), true);
    await page.getByRole("button", { name: "Check saved rule" }).click();
    await page.evaluate(() => {
      window.f.settings.rule = {
        ...window.f.settings.rule,
        subject_template: "Saved elsewhere",
        revision: 10,
      };
      window.f.reads[1].resolve(structuredClone(window.f.settings));
    });
    await page.getByText("Saved rule checked.", { exact: false }).waitFor();
    assert.equal(
      await page.getByLabel("Subject", { exact: true }).inputValue(),
      "Newer local draft",
    );
    assert.equal(await page.getByRole("button", { name: "Enable automation" }).isDisabled(), true);
    await page.getByRole("button", { name: "Save paused rule" }).click();
    assert.equal(await page.evaluate(() => window.f.saves[1].body.expected_revision), 10);
    await page.evaluate(() => window.f.saves[1].reject(new window.f.ApiError("Rejected", 422)));
    await page.getByText("Rejected", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Reload saved rule and discard edits" }).click();
    assert.equal(await page.getByLabel("Subject", { exact: true }).isDisabled(), true);
    await page.evaluate(() => window.f.reads[2].resolve(structuredClone(window.f.settings)));
    await page.waitForFunction(
      () => document.querySelector('input[maxlength="200"]').value === "Saved elsewhere",
    );
  });
}

test("refresh keeps newer edits, preview network failure does not require saved-rule readback", async (t) => {
  const page = await mount(t);
  await loaded(page);
  await page.evaluate(() => {
    window.f.holdSettings = true;
  });
  await page.getByRole("button", { name: "Refresh settings" }).click();
  await page.getByLabel("Subject", { exact: true }).fill("While refreshing");
  await page.evaluate(() => window.f.reads[0].resolve(structuredClone(window.f.settings)));
  assert.equal(await page.getByLabel("Subject", { exact: true }).inputValue(), "While refreshing");
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await page.evaluate(() => window.f.previews[0].reject(new window.f.Unknown()));
  await page.getByText("No email was sent.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save paused rule" }).isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Check saved rule" }).count(), 0);
  await page.getByRole("button", { name: "Preview recipients" }).click();
  await page.evaluate(() =>
    window.f.previews[1].reject(
      new window.f.ApiError("Unsupported placeholder {{fullname}}.", 422),
    ),
  );
  await page
    .getByText("Unsupported placeholder {{fullname}}. No email was sent.", { exact: true })
    .waitFor();
});

test("sender readiness blocks enabling while paused saves and independent activity still work", async (t) => {
  const page = await mount(t, { canEnable: false, mode: "disabled", failActivity: true });
  await loaded(page);
  await preview(page);
  assert.equal(await page.getByRole("button", { name: "Enable automation" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save paused rule" }).isEnabled(), true);
  await page.getByText("Activity unavailable", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.f.failActivity = false;
  });
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await page.getByText("Accepted by email provider", { exact: true }).waitFor();
  await page.getByText("Outcome unknown", { exact: true }).waitFor();
  assert.match(await page.locator("#root").innerText(), /Showing the latest 50 entries/);
  assert.match(await page.locator("#root").innerText(), /does not confirm inbox delivery/);
  assert.equal(await page.getByRole("button", { name: /retry/i }).count(), 0);
});

test("enabled edits require a new preview, but pausing uses the saved message and preserves invalid edits", async (t) => {
  const page = await mount(t, { enabled: true });
  await loaded(page);
  assert.equal(await page.getByRole("button", { name: "Save enabled rule" }).isDisabled(), true);
  await preview(page);
  assert.equal(await page.getByRole("button", { name: "Save enabled rule" }).isEnabled(), true);
  await page.getByLabel("Subject", { exact: true }).fill("");
  await page.getByRole("button", { name: "Pause automation" }).click();
  assert.equal(await page.evaluate(() => window.f.saves[0].body.enabled), false);
  assert.equal(
    await page.evaluate(() => window.f.saves[0].body.subject_template),
    "Hello {{student_first_name}}",
  );
  await page.evaluate(() =>
    window.f.saves[0].resolve({
      ...window.f.settings,
      rule: { ...window.f.settings.rule, enabled: false, revision: 8 },
    }),
  );
  await page.getByText("Automation paused.", { exact: false }).waitFor();
  assert.equal(await page.getByLabel("Subject", { exact: true }).inputValue(), "");
});

for (const phase of ["load", "preview", "save"]) {
  test(`late ${phase} from an old identity cannot restore protected data or overwrite the next studio`, async (t) => {
    const page = await mount(t, { holdSettings: phase === "load" });
    if (phase === "load") await page.waitForFunction(() => window.f.reads.length === 1);
    else {
      await loaded(page);
      await page.getByLabel("Subject", { exact: true }).fill("Old studio draft");
      await page
        .getByRole("button", {
          name: phase === "preview" ? "Preview recipients" : "Save paused rule",
        })
        .click();
    }
    await page.evaluate(() => window.f.setState({ identityReady: false }));
    await page.getByText("Checking studio access...").waitFor();
    assert.equal(await page.getByText("Activity Alex", { exact: true }).count(), 0);
    const count = await page.evaluate(() => window.f.calls.length);
    await page.evaluate((phase) => {
      const old = structuredClone(window.f.settings);
      old.rule.subject_template = "LATE OLD STUDIO";
      if (phase === "load") window.f.reads[0].resolve(old);
      if (phase === "preview")
        window.f.previews[0].resolve(
          window.f.previewResult(window.f.previews[0].body, "LATE OLD STUDENT"),
        );
      if (phase === "save") window.f.saves[0].resolve(old);
      window.f.holdSettings = false;
      window.f.settings.rule.subject_template = "New studio message";
      window.f.activity = { items: [], has_more: false };
    }, phase);
    assert.equal(await page.evaluate(() => window.f.calls.length), count);
    await page.evaluate(() =>
      window.f.setState({
        currentStudioId: "studio-two",
        currentUserId: "owner-two",
        identityGeneration: 2,
        identityReady: true,
      }),
    );
    await loaded(page);
    assert.equal(
      await page.getByLabel("Subject", { exact: true }).inputValue(),
      "New studio message",
    );
    assert.doesNotMatch(await page.locator("#root").innerText(), /LATE OLD|Activity Alex/);
    assert.equal(await page.getByRole("button", { name: "Save paused rule" }).isEnabled(), true);
  });
}

test("role revocation hides existing preview and activity without another request", async (t) => {
  const page = await mount(t);
  await loaded(page);
  await preview(page);
  const count = await page.evaluate(() => window.f.calls.length);
  await page.evaluate(() => window.f.setState({ currentRole: "front_desk" }));
  await page.getByText("An Admin can set up missed-class emails and view recipients.").waitFor();
  assert.equal(await page.getByText("guardian@example.test", { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => window.f.calls.length), count);
});

test("retained saved rule and activity render on revisit while reads are pending", async (t) => {
  const page = await mount(t);
  await loaded(page);
  await page.getByText("Activity Alex", { exact: true }).waitFor();
  await page.getByLabel("Subject", { exact: true }).fill("Unsaved local subject");
  await page.evaluate(() => {
    f.show(false);
  });
  await page.locator("[data-missed-class-editor]").waitFor({ state: "detached" });
  await page.evaluate(() => {
    f.holdSettings = true;
    f.holdActivity = true;
    f.show(true);
  });
  await page.waitForFunction(() => f.reads.length === 1 && f.activityReads.length === 1);
  assert.equal(
    await page.getByLabel("Subject", { exact: true }).inputValue(),
    "Hello {{student_first_name}}",
  );
  assert.equal(await page.getByText("Activity Alex", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("status", { name: "Loading settings" }).count(), 0);
  assert.equal(await page.getByRole("status", { name: "Loading activity" }).count(), 0);
  await page.evaluate(() => {
    f.reads[0].reject(new Error("Settings unavailable"));
    f.activityReads[0].reject(new Error("Activity unavailable"));
  });
  await page.getByText("Settings unavailable", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Subject", { exact: true }).inputValue(),
    "Hello {{student_first_name}}",
  );
  assert.equal(await page.getByText("Activity Alex", { exact: true }).count(), 1);
});

test("cold rule and activity placeholders wait for data in the loaded layout", async (t) => {
  const page = await mount(t, { holdSettings: true, holdActivity: true });
  await page.getByRole("status", { name: "Loading settings" }).waitFor();
  assert.equal(await page.locator(".koaryu-skeleton-reveal .lg\\:grid-cols-2").count(), 1);
  assert.equal(
    await page.getByRole("status", { name: "Loading activity" }).locator("li").count(),
    3,
  );
  await page.evaluate(() => {
    f.reads[0].resolve(f.settings);
    f.activityReads[0].resolve(f.activity);
  });
  await loaded(page);
  assert.equal(await page.getByRole("status", { name: "Loading settings" }).count(), 0);
});
