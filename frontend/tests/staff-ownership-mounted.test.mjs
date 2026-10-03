import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium } from "@playwright/test";
import { bundle } from "./helpers/store-browser-harness.mjs";

const sources = { store: bundle("production"), ui: bundle("production", { staffSection: true }) };
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
const flush = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

async function fixturePage({ ui = false, setup = false } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.route("**/*", (route) =>
    route.request().url() === "http://fixture.local/"
      ? route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
      : route.abort(),
  );
  await page.goto("http://fixture.local/");
  await page.evaluate(
    ({ setup }) => {
      const f = (window.fixture = {
        observations: [],
        requests: [],
        reads: [],
        writes: [],
        workspaces: [],
        sdkWrites: [],
        setup,
      });
      f.session = {
        access_token: "token-a",
        user: {
          id: "actor",
          email: "actor@example.test",
          user_metadata: { full_name: "Actor alias" },
        },
      };
      f.auth = {
        user: {
          ...f.session.user,
          full_name: "Actor alias",
          legal_first_name: setup ? null : "Original",
          legal_last_name: setup ? null : "Actor",
        },
        studio_id: "studio-a",
        role: setup ? "instructor" : "admin",
        membership_status: "active",
        staff_profiles_available: true,
      };
      f.member = (id, userId, role = "instructor", status = "active") => ({
        id,
        user_id: userId,
        studio_id: f.auth.studio_id,
        email: `${userId ?? id}@example.test`,
        full_name: `${id} alias`,
        deletion_confirmation_name: `${id} exact`,
        legal_first_name: "Original",
        legal_last_name: id,
        role,
        status,
        archived_at: status === "archived" ? "2026-01-02T00:00:00Z" : null,
        invited_by: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_sign_in_at: null,
      });
      f.rows = [
        {
          ...f.member("self-row", "actor", f.auth.role),
          full_name: f.auth.user.full_name,
          legal_first_name: f.auth.user.legal_first_name,
          legal_last_name: f.auth.user.legal_last_name,
        },
        f.member("admin-row", "other-admin", "admin"),
        f.member("instructor-row", "other-user"),
        f.member("archived-row", "archived-user", "instructor", "archived"),
        f.member("invite-row", null, "instructor", "pending"),
      ];
      f.workspace = () =>
        structuredClone({ auth: f.auth, studio: { name: "Test Studio", timezone: "UTC" } });
      f.supabase = {
        auth: {
          getSession: async () => ({ data: { session: f.session } }),
          onAuthStateChange: (callback) => {
            f.emit = (event, session) => {
              f.session = session;
              callback(event, session);
            };
            return { data: { subscription: { unsubscribe() {} } } };
          },
          updateUser: (data) => new Promise((resolve) => f.sdkWrites.push({ data, resolve })),
        },
      };
      f.write = (method, path, body, token) =>
        new Promise((resolve, reject) =>
          f.writes.push({ method, path, body, token, resolve, reject }),
        );
      f.api = {
        get: async (path, token) => {
          f.requests.push({ path, token });
          if (path === "/dashboard/workspace") {
            if (f.setup) throw Object.assign(new Error("Subscription required"), { status: 402 });
            const snapshot = f.workspace();
            if (f.holdWorkspace)
              return new Promise((resolve, reject) =>
                f.workspaces.push({ snapshot, token, resolve, reject }),
              );
            return snapshot;
          }
          if (path === "/auth/me") return structuredClone(f.auth);
          if (path.startsWith("/dashboard/bootstrap"))
            return {
              auth: f.auth,
              studio_name: "Test Studio",
              students: [],
              leads: [],
              programs: [],
              belt_ladders: [],
              primary_belt_ladder: null,
              summary: { auth: f.auth, students: { total: 0 } },
            };
          if (path.startsWith("/staff")) {
            const snapshot = structuredClone(
              f.rows.filter(
                (row) => path.includes("include_archived=true") || row.status !== "archived",
              ),
            );
            if (f.holdStaff)
              return new Promise((resolve, reject) =>
                f.reads.push({ path, token, snapshot, resolve, reject }),
              );
            return snapshot;
          }
          if (path.startsWith("/belts/ladders") || path.startsWith("/programs")) return [];
          if (path.startsWith("/schedule/window"))
            return { sessions: [], templates: [], attendance: [] };
          if (path.startsWith("/dashboard/summary"))
            return { auth: f.auth, students: { total: 0 } };
          throw new Error(`Unexpected GET ${path}`);
        },
        post: (path, body, token) => f.write("POST", path, body, token),
        patch: (path, body, token) => f.write("PATCH", path, body, token),
        delete: (path, token) => f.write("DELETE", path, null, token),
      };
    },
    { setup },
  );
  await page.addScriptTag({ content: sources[ui ? "ui" : "store"] });
  if (setup)
    await page.waitForFunction(
      () => fixture.store?.subscriptionRequired && fixture.store.currentUserId === "actor",
    );
  else {
    await page.waitForFunction(() => fixture.store?.identityReady);
    if (!ui) await page.evaluate(() => fixture.store.refreshStaff(true));
    await page.waitForFunction(
      () => fixture.store.staffLoaded && fixture.store.staffMembers.length >= 4,
    );
  }
  return page;
}

test("staff reads preserve confirmed archive and wait for pending or rejected writes", async () => {
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.holdStaff = true;
      fixture.oldRead = fixture.store.refreshStaff(true).catch((error) => error.message);
      fixture.archive = fixture.store.archiveStaff("instructor-row");
    });
    await page.waitForFunction(() => fixture.reads.length === 1 && fixture.writes.length === 1);
    await page.evaluate(async () => {
      fixture.rows[2] = {
        ...fixture.rows[2],
        status: "archived",
        archived_at: "2026-09-08T00:00:00Z",
      };
      fixture.writes[0].resolve(structuredClone(fixture.rows[2]));
      await fixture.archive;
      fixture.reads[0].resolve(fixture.reads[0].snapshot);
    });
    await flush(page);
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.id === "instructor-row").status,
      ),
      "archived",
    );
    await page.waitForFunction(() => fixture.reads.length === 2);
    await page.evaluate(async () => {
      fixture.reads[1].resolve(fixture.reads[1].snapshot);
      await fixture.oldRead;
    });
    await page.evaluate(() => {
      fixture.legal = fixture.store.updateStaffLegalName("other-admin", "Requested", "Names");
      fixture.waiting = fixture.store.refreshStaff(true).catch((error) => error.message);
    });
    assert.equal(
      await page.evaluate(() => fixture.reads.length),
      2,
      "roster must wait for its pending writer",
    );
    await page.evaluate(async () => {
      fixture.writes[1].reject(new Error("Name denied"));
      await fixture.legal.catch(() => {});
    });
    await page.waitForFunction(() => fixture.reads.length === 3);
    await page.evaluate(async () => {
      fixture.reads[2].resolve(fixture.reads[2].snapshot);
      await fixture.waiting;
    });
    assert.equal(await page.evaluate(() => fixture.store.staffLoadError), null);
  } finally {
    await page.close();
  }
});

test("staff and initial self legal-name setup settle once through normal token renewal", async () => {
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.invite = fixture.store.inviteStaff({
        email: "  Invited@Example.test ",
        role: "instructor",
        full_name: " Invite  Alias ",
        legal_first_name: " First  New ",
        legal_last_name: " Last  New ",
      });
      fixture.name = fixture.store.updateStaffLegalName("other-user", "Requested", "Names");
      fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "token-b" });
    });
    await page.waitForFunction(
      () => fixture.writes.length === 2 && fixture.store.token === "token-b",
    );
    assert.deepEqual(await page.evaluate(() => fixture.writes[0].body), {
      email: "invited@example.test",
      role: "instructor",
      full_name: "Invite Alias",
      legal_first_name: "First New",
      legal_last_name: "Last New",
    });
    assert.deepEqual(
      await page.evaluate(() => ({ path: fixture.writes[1].path, body: fixture.writes[1].body })),
      {
        path: "/staff/other-user/legal-name",
        body: { legal_first_name: "Requested", legal_last_name: "Names" },
      },
    );
    await page.evaluate(async () => {
      fixture.writes[0].resolve(fixture.member("new-invite", null, "instructor", "pending"));
      fixture.writes[1].resolve({
        user_id: "other-user",
        legal_first_name: "Normalized",
        legal_last_name: "Result",
      });
      await Promise.all([fixture.invite, fixture.name]);
    });
    await flush(page);
    assert.equal(
      await page.evaluate(() => fixture.store.staffMembers.some((row) => row.id === "new-invite")),
      true,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const row = fixture.store.staffMembers.find((row) => row.user_id === "other-user");
        return [row.legal_first_name, row.legal_last_name, row.full_name, row.role, row.status];
      }),
      ["Normalized", "Result", "instructor-row alias", "instructor", "active"],
    );
    assert.deepEqual(await page.evaluate(() => fixture.writes.map((write) => write.token)), [
      "token-a",
      "token-a",
    ]);
  } finally {
    await page.close();
  }
  const setup = await fixturePage({ setup: true });
  try {
    await setup.evaluate(() => {
      fixture.save = fixture.store.updateUserLegalName("First", "Last");
      fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "token-b" });
    });
    await setup.waitForFunction(() => fixture.writes.length === 1);
    await setup.evaluate(async () => {
      fixture.writes[0].resolve({
        user_id: "actor",
        legal_first_name: "First",
        legal_last_name: "Last",
      });
      await fixture.save;
    });
    await flush(setup);
    assert.deepEqual(
      await setup.evaluate(() => [
        fixture.store.legalFirstName,
        fixture.store.legalLastName,
        fixture.store.currentRole,
        fixture.store.subscriptionRequired,
        fixture.store.staffProfilesAvailable,
      ]),
      ["First", "Last", "instructor", true, true],
    );
    assert.equal(await setup.evaluate(() => fixture.writes[0].path), "/staff/actor/legal-name");
  } finally {
    await setup.close();
  }
});

test("only the latest roster read owns rows and errors", async () => {
  for (const rejectOld of [false, true]) {
    const page = await fixturePage();
    try {
      await page.evaluate(() => {
        fixture.holdStaff = true;
        fixture.old = fixture.store.refreshStaff(true).catch((error) => error.message);
        fixture.newest = fixture.store.refreshStaff(false);
      });
      await page.waitForFunction(() => fixture.reads.length === 2);
      await page.evaluate(async () => {
        fixture.reads[1].resolve([fixture.member("new-row", "new-user")]);
        await fixture.newest;
      });
      await page.evaluate(async (rejectOld) => {
        if (rejectOld) fixture.reads[0].reject(new Error("Obsolete staff failure"));
        else fixture.reads[0].resolve(fixture.reads[0].snapshot);
        await fixture.old;
      }, rejectOld);
      await flush(page);
      assert.deepEqual(await page.evaluate(() => fixture.store.staffMembers.map((row) => row.id)), [
        "new-row",
      ]);
      assert.equal(await page.evaluate(() => fixture.store.staffLoadError), null);
    } finally {
      await page.close();
    }
  }
});

test("staff settings admit one command across rows and action families and preserve drafts on rejection", async () => {
  const page = await fixturePage({ ui: true });
  try {
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("retained@example.test");
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-staff-status]")];
      const first = rows
        .find((row) => row.textContent.includes("other-admin@example.test"))
        .querySelector("select");
      const second = rows
        .find((row) => row.textContent.includes("other-user@example.test"))
        .querySelector("select");
      first.value = "instructor";
      first.dispatchEvent(new Event("change", { bubbles: true }));
      second.value = "front_desk";
      second.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush(page);
    assert.equal(
      await page.evaluate(() => fixture.writes.length),
      1,
      "a second command must be refused before the next render",
    );
    const other = page
      .locator("[data-staff-status]")
      .filter({ hasText: "other-user@example.test" });
    assert.equal(await other.getByRole("combobox").isDisabled(), true);
    assert.equal(
      await other.getByRole("button", { name: "Edit legal name", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await other.getByRole("button", { name: "Archive", exact: true }).isDisabled(),
      true,
    );
    await page.evaluate(() => fixture.writes[0].reject(new Error("Role denied")));
    await flush(page);
    assert.equal(await other.getByRole("combobox").isDisabled(), false);
    assert.equal(
      await page.getByRole("textbox", { name: "Email", exact: true }).inputValue(),
      "retained@example.test",
    );
    assert.equal(await page.getByText("Role denied", { exact: true }).count(), 1);
    await other.getByRole("button", { name: "Edit legal name", exact: true }).click();
    await other
      .getByRole("textbox", { name: "Legal first name", exact: true })
      .fill("Changed   First");
    await other
      .getByRole("textbox", { name: "Legal last name", exact: true })
      .fill("Changed   Last");
    await other.getByRole("button", { name: "Save legal name", exact: true }).click();
    await page.waitForFunction(() => fixture.writes.length === 2);
    assert.deepEqual(await page.evaluate(() => fixture.writes[1].body), {
      legal_first_name: "Changed First",
      legal_last_name: "Changed Last",
    });
    assert.equal(
      await page
        .locator("[data-staff-status]")
        .filter({ hasText: "other-admin@example.test" })
        .getByRole("combobox")
        .isDisabled(),
      true,
    );
    await page.evaluate(() => fixture.writes[1].reject(new Error("Name rejected")));
    await flush(page);
    assert.equal(
      await other.getByRole("textbox", { name: "Legal first name", exact: true }).inputValue(),
      "Changed   First",
    );
    assert.equal(await other.getByText("Name rejected", { exact: true }).count(), 1);
    await other.getByRole("button", { name: "Save legal name", exact: true }).click();
    await page.waitForFunction(() => fixture.writes.length === 3);
    await page.evaluate(() =>
      fixture.writes[2].resolve({
        user_id: "other-user",
        legal_first_name: "Canonical",
        legal_last_name: "Name",
      }),
    );
    await flush(page);
    assert.equal(
      await other.getByRole("textbox", { name: "Legal first name", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.user_id === "other-user").full_name,
      ),
      "instructor-row alias",
    );
    assert.equal(await page.evaluate(() => fixture.store.legalFirstName), "Original");
  } finally {
    await page.close();
  }
});

test("acknowledged self legal names survive older workspace reads while fresh retries stay authoritative", async () => {
  for (const mode of ["initialization", "resume", "renewed-resume"]) {
    const page = await fixturePage();
    try {
      await page.evaluate((mode) => {
        fixture.holdWorkspace = true;
        if (mode === "initialization") {
          fixture.save = fixture.store.updateUserLegalName("Saved", "Name");
          fixture.store.retryInitialization();
        } else
          window.dispatchEvent(
            new CustomEvent("koaryu:resume", { detail: { refreshData: false } }),
          );
      }, mode);
      await page.waitForFunction(() => fixture.workspaces.length === 1);
      if (mode !== "initialization")
        await page.evaluate(() => {
          fixture.save = fixture.store.updateUserLegalName("Saved", "Name");
        });
      await page.waitForFunction(() => fixture.writes.length === 1);
      await page.evaluate(async () => {
        fixture.auth.user = {
          ...fixture.auth.user,
          legal_first_name: "Saved",
          legal_last_name: "Name",
        };
        fixture.writes[0].resolve({
          user_id: "actor",
          legal_first_name: "Saved",
          legal_last_name: "Name",
        });
        await fixture.save;
      });
      await flush(page);
      assert.equal(await page.evaluate(() => fixture.store.legalFirstName), "Saved");
      if (mode === "renewed-resume")
        await page.evaluate(() =>
          fixture.emit("TOKEN_REFRESHED", { ...fixture.session, access_token: "token-b" }),
        );
      await page.evaluate(() => fixture.workspaces[0].resolve(fixture.workspaces[0].snapshot));
      if (mode === "renewed-resume") {
        await page.waitForFunction(() => fixture.workspaces.length === 2);
        await page.evaluate(() =>
          fixture.workspaces[1].resolve({
            ...fixture.workspaces[1].snapshot,
            auth: {
              ...fixture.auth,
              user: {
                ...fixture.auth.user,
                legal_first_name: "Later",
                legal_last_name: "Authority",
              },
            },
          }),
        );
        await page.waitForFunction(() => fixture.store.legalFirstName === "Later");
      } else {
        await flush(page);
        assert.deepEqual(
          await page.evaluate(() => [fixture.store.legalFirstName, fixture.store.legalLastName]),
          ["Saved", "Name"],
        );
      }
      assert.equal(await page.evaluate(() => fixture.store.currentRole), "admin");
      assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    } finally {
      await page.close();
    }
  }
});

test("confirmed self role or archive changes close old access until authoritative revalidation", async () => {
  for (const archive of [false, true]) {
    const page = await fixturePage({ ui: true });
    try {
      await page.evaluate((archive) => {
        fixture.holdWorkspace = true;
        fixture.save = archive
          ? fixture.store.archiveStaff("self-row")
          : fixture.store.updateStaffRole("self-row", "instructor");
      }, archive);
      await page.waitForFunction(() => fixture.writes.length === 1);
      await page.evaluate(async (archive) => {
        const changed = {
          ...fixture.rows[0],
          role: archive ? "admin" : "instructor",
          status: archive ? "archived" : "active",
        };
        fixture.auth = {
          ...fixture.auth,
          role: archive ? null : changed.role,
          studio_id: archive ? null : "studio-a",
          membership_status: changed.status,
        };
        fixture.writes[0].resolve(changed);
        await fixture.save;
      }, archive);
      await flush(page);
      assert.equal(
        await page.evaluate(() => fixture.store.identityReady),
        false,
        "a membership row cannot reauthorize the current actor",
      );
      assert.equal(await page.getByRole("button", { name: "Send invite", exact: true }).count(), 0);
      await page.waitForFunction(() => fixture.workspaces.length === 1);
      if (archive) {
        await page.evaluate(() =>
          fixture.workspaces[0].reject(Object.assign(new Error("Staff archived"), { status: 403 })),
        );
        await flush(page);
        assert.equal(await page.evaluate(() => fixture.store.currentRole), null);
        assert.equal(await page.evaluate(() => fixture.store.currentStudioId), null);
        assert.deepEqual(await page.evaluate(() => fixture.store.staffMembers), []);
        assert.equal(
          await page.evaluate(() => fixture.redirects.includes("/account-archived")),
          true,
        );
        assert.equal(
          await page.getByRole("button", { name: "Send invite", exact: true }).count(),
          0,
        );
      } else {
        await page.evaluate(() => fixture.workspaces[0].resolve(fixture.workspaces[0].snapshot));
        await page.waitForFunction(
          () => fixture.store.identityReady && fixture.store.currentRole === "instructor",
        );
        assert.equal(
          await page.getByRole("button", { name: "Send invite", exact: true }).count(),
          0,
        );
      }
      assert.equal(await page.evaluate(() => fixture.writes.length), 1);
    } finally {
      await page.close();
    }
  }
});

test("new staff identity owns its draft and old commands or mutation waiters cannot affect it", async () => {
  for (const rejectOld of [false, true]) {
    const page = await fixturePage({ ui: true });
    try {
      await page
        .getByRole("textbox", { name: "Email", exact: true })
        .fill("old-invite@example.test");
      await page.getByRole("textbox", { name: "Display name", exact: true }).fill("Old invite");
      await page.getByRole("textbox", { name: "Legal first name", exact: true }).fill("Old");
      await page.getByRole("textbox", { name: "Legal last name", exact: true }).fill("Invite");
      await page.evaluate(() => {
        fixture.holdStaff = true;
      });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.waitForFunction(() => fixture.reads.length === 1);
      await page.getByRole("button", { name: "Send invite", exact: true }).click();
      await page.waitForFunction(() => fixture.writes.length === 1);
      assert.deepEqual(await page.evaluate(() => fixture.writes[0].body), {
        email: "old-invite@example.test",
        role: "instructor",
        full_name: "Old invite",
        legal_first_name: "Old",
        legal_last_name: "Invite",
      });
      await page.evaluate(() => {
        fixture.oldResult = fixture.member("old-result", null, "instructor", "pending");
        fixture.holdStaff = true;
        fixture.waiter = fixture.store.refreshStaff(true).catch((error) => error.message);
        const session = {
          access_token: "token-b",
          user: {
            id: "actor-b",
            email: "b@example.test",
            user_metadata: { full_name: "Second actor" },
          },
        };
        fixture.auth = {
          ...fixture.auth,
          user: {
            ...session.user,
            full_name: "Second actor",
            legal_first_name: "Second",
            legal_last_name: "Actor",
          },
          studio_id: "studio-b",
        };
        fixture.rows = [
          fixture.member("new-self", "actor-b", "admin"),
          fixture.member("new-other", "new-other", "admin"),
        ];
        fixture.holdStaff = false;
        fixture.emit("USER_UPDATED", session);
      });
      await page.waitForFunction(
        () => fixture.store.currentStudioId === "studio-b" && fixture.store.identityReady,
      );
      await flush(page);
      assert.equal(
        await page.evaluate(() => fixture.store.staffLoaded),
        true,
        "old UI refresh must not absorb the new identity's roster load",
      );
      assert.equal(
        await page.getByRole("textbox", { name: "Email", exact: true }).isDisabled(),
        false,
      );
      await page
        .getByRole("textbox", { name: "Email", exact: true })
        .fill("new-draft@example.test");
      await page.evaluate(async (rejectOld) => {
        for (const read of fixture.reads) read.reject(new Error("Old roster failure"));
        if (rejectOld) fixture.writes[0].reject(new Error("Old invite failure"));
        else fixture.writes[0].resolve(fixture.oldResult);
        await fixture.waiter;
      }, rejectOld);
      await flush(page);
      assert.equal(
        await page.getByRole("textbox", { name: "Email", exact: true }).inputValue(),
        "new-draft@example.test",
      );
      assert.equal(
        await page
          .getByText(/Old roster failure|Old invite failure|Invite sent to old-invite/)
          .count(),
        0,
      );
      assert.equal(
        await page.evaluate(() =>
          fixture.store.staffMembers.some((row) => row.id === "old-result"),
        ),
        false,
      );
      assert.equal(
        await page.evaluate(() => fixture.reads.length),
        1,
        "only the pre-command refresh may have started an old roster transport",
      );
    } finally {
      await page.close();
    }
  }
});

test("display-name SDK success preserves USER_UPDATED access revalidation instead of restoring an old roster", async () => {
  for (const workspaceFails of [false, true]) {
    const page = await fixturePage();
    try {
      await page.evaluate(() => {
        fixture.save = fixture.store.updateUserName("New alias");
        fixture.holdStaff = true;
        fixture.waiter = fixture.store.refreshStaff(true).catch((error) => error.message);
      });
      await page.waitForFunction(() => fixture.sdkWrites.length === 1);
      await page.evaluate(() => {
        fixture.auth.user = { ...fixture.auth.user, full_name: "New alias" };
        fixture.rows[0] = { ...fixture.rows[0], full_name: "New alias" };
        fixture.holdWorkspace = true;
        fixture.holdStaff = false;
        fixture.emit("USER_UPDATED", {
          ...fixture.session,
          user: { ...fixture.session.user, user_metadata: { full_name: "New alias" } },
        });
      });
      await page.waitForFunction(
        () => fixture.workspaces.length === 1 && fixture.store.staffMembers.length === 0,
      );
      await page.evaluate(async () => {
        fixture.sdkWrites[0].resolve({ error: null });
        for (const read of fixture.reads) read.resolve(read.snapshot);
        await Promise.all([fixture.save, fixture.waiter]);
      });
      assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
      assert.deepEqual(await page.evaluate(() => fixture.store.staffMembers), []);
      assert.equal(await page.evaluate(() => fixture.reads.length), 0);
      if (workspaceFails) {
        await page.evaluate(() => fixture.workspaces[0].reject(new Error("Workspace unavailable")));
        await flush(page);
        assert.equal(await page.evaluate(() => fixture.store.identityReady), false);
      } else {
        await page.evaluate(() => fixture.workspaces[0].resolve(fixture.workspaces[0].snapshot));
        await page.waitForFunction(() => fixture.store.identityReady);
        await page.evaluate(() => fixture.store.refreshStaff(true));
        await flush(page);
        assert.equal(await page.evaluate(() => fixture.store.userName), "New alias");
        assert.equal(
          await page.evaluate(
            () => fixture.store.staffMembers.find((row) => row.user_id === "actor").full_name,
          ),
          "New alias",
        );
      }
      assert.deepEqual(await page.evaluate(() => fixture.sdkWrites.map((write) => write.data)), [
        { data: { full_name: "New alias" } },
      ]);
    } finally {
      await page.close();
    }
  }
});

test("deletion scheduling preserves the archived row, invite revoke removes its row, and live clear preserves pending staff work", async () => {
  const page = await fixturePage();
  try {
    await page.evaluate(() => {
      fixture.invalidRevoke = fixture.store.removeStaff("instructor-row").then(
        () => "accepted",
        (error) => error.message,
      );
    });
    await flush(page);
    assert.equal(
      await page.evaluate(() => fixture.writes.length),
      0,
      "active staff cannot be sent to invitation DELETE",
    );
    assert.match(await page.evaluate(() => fixture.invalidRevoke), /pending/i);
    await page.evaluate(() => {
      fixture.schedule = fixture.store.scheduleStaffDeletion(
        "archived-row",
        " archived-row   exact ",
        " note ",
      );
    });
    await page.waitForFunction(() => fixture.writes.length === 1);
    assert.deepEqual(
      await page.evaluate(() => ({
        method: fixture.writes[0].method,
        path: fixture.writes[0].path,
        body: fixture.writes[0].body,
      })),
      {
        method: "POST",
        path: "/staff/archived-row/deletion-request",
        body: { confirmation_name: "archived-row exact", reason: "note" },
      },
    );
    await page.evaluate(async () => {
      fixture.scheduled = {
        id: "request-1",
        user_id: "archived-user",
        studio_id: "studio-a",
        requester_email: "actor@example.test",
        status: "scheduled",
        requested_at: "2026-09-08T00:00:00Z",
        scheduled_for: "2026-10-08T00:00:00Z",
        canceled_at: null,
        completed_at: null,
        reason: "note",
      };
      fixture.writes[0].resolve(fixture.scheduled);
      await fixture.schedule;
    });
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.id === "archived-row").status,
      ),
      "archived",
    );
    await page.evaluate(() => {
      fixture.revoke = fixture.store.removeStaff("invite-row");
    });
    await page.waitForFunction(() => fixture.writes.length === 2);
    assert.equal(await page.evaluate(() => fixture.writes[1].method), "DELETE");
    assert.equal(await page.evaluate(() => fixture.writes[1].path), "/staff/invite-row");
    await page.evaluate(async () => {
      fixture.writes[1].resolve();
      await fixture.revoke;
    });
    await flush(page);
    assert.equal(
      await page.evaluate(() => fixture.store.staffMembers.some((row) => row.id === "invite-row")),
      false,
    );
    await page.evaluate(() => {
      fixture.change = fixture.store.updateStaffRole("instructor-row", "front_desk");
      fixture.clear = fixture.store.clearStudioData();
    });
    await page.waitForFunction(() => fixture.writes.length === 4);
    await page.evaluate(async () => {
      fixture.writes[3].resolve({ studio_name: "Cleared studio" });
      await fixture.clear;
      fixture.writes[2].resolve({ ...fixture.rows[2], role: "front_desk" });
      await fixture.change;
    });
    await flush(page);
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.id === "instructor-row").role,
      ),
      "front_desk",
    );
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.id === "archived-row").status,
      ),
      "archived",
    );
    assert.equal(await page.evaluate(() => fixture.scheduled.status), "scheduled");
    await page.evaluate(() => {
      fixture.restore = fixture.store.unarchiveStaff("archived-row");
    });
    await page.waitForFunction(() => fixture.writes.length === 5);
    assert.deepEqual(
      await page.evaluate(() => ({
        method: fixture.writes[4].method,
        path: fixture.writes[4].path,
        body: fixture.writes[4].body,
      })),
      { method: "POST", path: "/staff/archived-row/unarchive", body: {} },
    );
    await page.evaluate(async () => {
      fixture.writes[4].resolve({ ...fixture.rows[3], status: "active", archived_at: null });
      await fixture.restore;
    });
    await flush(page);
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.id === "archived-row").status,
      ),
      "active",
    );
    assert.equal(await page.evaluate(() => fixture.scheduled.status), "scheduled");
  } finally {
    await page.close();
  }
});

test("staff deletion confirmation retains its target on failure and clears only its accepted request", async () => {
  const page = await fixturePage({ ui: true });
  try {
    assert.equal(await page.locator('[data-staff-status="archived"]').count(), 0);
    await page.getByRole("checkbox", { name: "Show archived staff", exact: true }).check();
    const archived = page
      .locator('[data-staff-status="archived"]')
      .filter({ hasText: "archived-user@example.test" });
    await archived.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "Schedule permanent deletion?",
      exact: true,
    });
    const confirm = dialog.getByRole("textbox");
    await confirm.fill("ARCHIVED-row exact");
    assert.equal(
      await dialog.getByRole("button", { name: "Schedule deletion", exact: true }).isDisabled(),
      true,
    );
    await confirm.fill(" archived-row   exact ");
    await dialog.getByRole("button", { name: "Schedule deletion", exact: true }).click();
    await page.waitForFunction(() => fixture.writes.length === 1);
    assert.equal(
      await page.evaluate(() => fixture.writes[0].body.confirmation_name),
      "archived-row exact",
    );
    assert.equal(await confirm.isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 1);
    await page.evaluate(() => fixture.writes[0].reject(new Error("Schedule denied")));
    await flush(page);
    assert.equal(await confirm.inputValue(), " archived-row   exact ");
    assert.equal(await dialog.getByText("Schedule denied", { exact: true }).count(), 1);
    await dialog.getByRole("button", { name: "Schedule deletion", exact: true }).click();
    await page.waitForFunction(() => fixture.writes.length === 2);
    await page.evaluate(() =>
      fixture.writes[1].resolve({
        id: "request-2",
        user_id: "archived-user",
        studio_id: "studio-a",
        requester_email: "actor@example.test",
        status: "scheduled",
        requested_at: "2026-09-08T00:00:00Z",
        scheduled_for: "2026-10-08T00:00:00Z",
        canceled_at: null,
        completed_at: null,
        reason: null,
      }),
    );
    await flush(page);
    assert.equal(await dialog.count(), 0);
    assert.equal(await archived.count(), 1);
    assert.equal(
      await page.evaluate(
        () => fixture.store.staffMembers.find((row) => row.id === "archived-row").status,
      ),
      "archived",
    );
  } finally {
    await page.close();
  }
});

test("staff controls retain last-admin protection and legal-profile capability behavior", async () => {
  const page = await fixturePage({ ui: true });
  try {
    await page.evaluate(async () => {
      fixture.rows[1] = { ...fixture.rows[1], role: "instructor" };
      fixture.rows[2] = { ...fixture.rows[2], legal_first_name: null, legal_last_name: null };
      await fixture.store.refreshStaff(false);
    });
    await flush(page);
    const self = page.locator("[data-staff-status]").filter({ hasText: "actor@example.test" });
    assert.equal(await self.getByRole("combobox").isDisabled(), true);
    assert.equal(
      await self.getByRole("button", { name: "Archive", exact: true }).isDisabled(),
      true,
    );
    const other = page
      .locator("[data-staff-status]")
      .filter({ hasText: "other-user@example.test" });
    assert.match(await other.textContent(), /Legal: Not provided/);
    assert.equal(
      await other.getByRole("button", { name: "Edit legal name", exact: true }).isDisabled(),
      false,
    );
    await page.evaluate(() => {
      fixture.auth = { ...fixture.auth, staff_profiles_available: false };
      fixture.emit("USER_UPDATED", fixture.session);
    });
    await page.waitForFunction(
      () =>
        fixture.store.staffLoaded &&
        fixture.store.currentRole === "admin" &&
        !fixture.store.staffProfilesAvailable,
    );
    assert.equal(
      await page.getByRole("button", { name: "Edit legal name", exact: true }).count(),
      0,
    );
    assert.equal(
      await page
        .locator("[data-staff-status]")
        .getByText(/Legal:/)
        .count(),
      0,
    );
  } finally {
    await page.close();
  }
});
