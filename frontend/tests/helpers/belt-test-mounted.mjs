import { readFileSync } from "node:fs";
import { mountLeadCreateFixture, flushLeadCreate } from "./lead-create-mounted.mjs";
export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/belt-test-contract.json", import.meta.url)),
);
export const USER = "10000000-0000-4000-8000-000000000001";
export const STUDIO = "20000000-0000-4000-8000-000000000001";
export const DRAFT = "abcdefab-cdef-4abc-8def-000000000100";
export const KEY = "koaryu-belt-test-operations-v1";
export const flush = flushLeadCreate;
export const marker = (command = "belt_test.update", changes = {}) => ({
  command,
  operation_id: fixture.ids.operation,
  owner_user_id: USER,
  owner_studio_id: STUDIO,
  target:
    command === "belt_test.create"
      ? { kind: "draft", id: DRAFT }
      : { kind: "event", id: fixture.ids.event },
  ...(command === "belt_test.revoke" ? { recipient_id: fixture.ids.recipient } : {}),
  ...changes,
});
export async function mountBeltFixture(
  browser,
  { role = "admin", preview = false, journal, unverified = false } = {},
) {
  const context = await browser.newContext(),
    errors = [];
  await context.addInitScript(
    ({ KEY, journal }) => {
      if (journal !== undefined) sessionStorage.setItem(KEY, journal);
      window.beltStorageReads = 0;
      window.beltStorageWrites = 0;
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (name) {
        if (name === KEY) window.beltStorageReads++;
        return get.call(this, name);
      };
      Storage.prototype.setItem = function (name, value) {
        if (name === KEY) window.beltStorageWrites++;
        return set.call(this, name, value);
      };
    },
    { KEY, journal },
  );
  let p, releasePage;
  const created = new Promise((resolve) => {
    releasePage = resolve;
  });
  const mounted = mountLeadCreateFixture(
    {
      newPage: async () => {
        p = await context.newPage();
        p.on("pageerror", (error) => errors.push(error.message));
        p.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const add = p.addScriptTag.bind(p);
        p.addScriptTag = async (options) => {
          if (unverified)
            await p.evaluate(() => {
              f.supabase.auth.getSession = () =>
                new Promise((resolve) => {
                  f.finishIdentity = () => resolve({ data: { session: f.session } });
                });
            });
          // Reuse the shared auth/I/O and actual provider without its leads page.
          const needle = "React.createElement(PageMount)";
          if (options.content.split(needle).length !== 2)
            throw Error("Shared fixture mount changed");
          const result = await add({
            ...options,
            content: options.content.replace(needle, "null"),
          });
          releasePage(p);
          return result;
        };
        return p;
      },
    },
    { role, preview },
  );
  // A deferred identity case exposes the same mounted provider before its existing helper wait completes.
  try {
    if (unverified) {
      await created;
      await p.waitForFunction(() => f.store && f.finishIdentity);
    } else await mounted;
    await p.evaluate(
      ({ source, DRAFT, STUDIO }) => {
        const replaceStudio = (value) =>
          Array.isArray(value)
            ? value.map(replaceStudio)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([key, child]) => [
                    key,
                    key === "studio_id" ? STUDIO : replaceStudio(child),
                  ]),
                )
              : value;
        f.beltFixture = replaceStudio(source);
        f.beltReads = [];
        f.draft = { kind: "draft", id: DRAFT };
        f.target = { kind: "event", id: source.ids.event };
        f.beltEvent = (changes) => ({ ...f.beltFixture.events.scheduled, ...changes });
        f.beltRecipient = (changes) => ({ ...f.beltFixture.recipients.approved, ...changes });
        const get = f.api.get;
        f.api.get = (path, token) =>
          path.startsWith("/belt-tests") || path.startsWith("/automations/operations/")
            ? new Promise((resolve, reject) => f.beltReads.push({ path, token, resolve, reject }))
            : get(path, token);
        f.beltFields = {
          name: f.beltFixture.events.create.name,
          ladderId: source.ids.ladder,
          schedule: {
            starts_at: f.beltFixture.events.create.starts_at,
            ends_at: f.beltFixture.events.create.ends_at,
            timezone: f.beltFixture.events.create.timezone,
          },
          location: "",
          status: "draft",
        };
        f.beltView = (target = f.target) =>
          f.store.beltTests.operations.get(`${target.kind}:${target.id}`);
        f.beltRun = (command = "update") => {
          const api = f.store.beltTests;
          const task =
            command === "create"
              ? api.createEvent(DRAFT, f.beltFields)
              : command === "update"
                ? api.updateEvent(f.beltEvent(), { kind: "details", name: "Changed" })
                : command === "approve"
                  ? api.approveRecipients(f.beltEvent(), f.beltFixture.requests.approve.recipients)
                  : api.revokeRecipient(f.beltEvent(), f.beltRecipient());
          f.beltPromise = task.catch((error) => {
            f.beltError = { message: error.message, status: error.status };
          });
        };
        f.beltCheck = (target = f.target) => {
          f.beltPromise = f.store.beltTests.checkResult(target).catch((error) => {
            f.beltError = { message: error.message, status: error.status };
          });
        };
        f.beltResult = (command) =>
          command === "create"
            ? f.beltFixture.events.create
            : command === "update"
              ? f.beltFixture.events.name_update
              : command === "approve"
                ? f.beltFixture.approval
                : f.beltFixture.recipients.revoked;
        f.beltReceipt = (command = "update", operation = source.ids.operation) => ({
          ...f.beltFixture.receipts[`belt_test.${command}`],
          operation_id: operation,
          result: f.beltResult(command),
        });
      },
      { source: fixture, DRAFT, STUDIO },
    );
    return {
      p,
      errors,
      finishIdentity: async () => {
        await p.evaluate(() => f.finishIdentity());
        await mounted;
        await flush(p);
      },
      close: async () => {
        await context.close();
        await mounted.catch(() => {});
      },
    };
  } catch (error) {
    await context.close();
    await mounted.catch(() => {});
    throw error;
  }
}
export async function resolveRead(p, index, kind = "event", changes = {}) {
  await p.waitForFunction((index) => f.beltReads.length > index, index);
  await p.evaluate(
    ({ index, kind, changes }) =>
      f.beltReads[index].resolve(
        kind === "recipient" ? f.beltRecipient(changes) : f.beltEvent(changes),
      ),
    { index, kind, changes },
  );
}
export async function resetStudio(p, action) {
  await p.evaluate(async (action) => {
    if (action === "clear") {
      f.api.delete = async () => ({ studio_name: "Cleared" });
      await f.store.clearStudioData();
    } else {
      f.api.post = async () => ({
        studio_name: "Reset",
        students: [],
        leads: [],
        programs: [],
        belt_ladders: [],
        primary_belt_ladder: null,
        eligibility: [],
        templates: [],
        sessions: [],
        attendance: [],
      });
      await f.store.resetDemoData();
    }
  }, action);
  await flush(p);
}
