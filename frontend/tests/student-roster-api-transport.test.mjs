import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { register } from "node:module";

register("./helpers/path-alias-loader.mjs", import.meta.url);

const { ApiError, api } = await import("../src/lib/api.ts");
const {
  fetchStudentPage,
  StudentRosterCursorError,
} = await import("../src/lib/store-student-pages.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockJsonResponse(status, body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("student roster API transport", () => {
  it("preserves a FastAPI cursor detail through api.get and fetchStudentPage", async () => {
    mockJsonResponse(409, {
      detail: {
        code: "stale_cursor",
        message: "The roster cursor is stale.",
        recover_to: "nearest_prior",
      },
    });

    await assert.rejects(
      fetchStudentPage("token", { page: 2, cursor: "opaque" }),
      (error) => {
        assert.ok(error instanceof StudentRosterCursorError);
        assert.equal(error.code, "stale_cursor");
        assert.equal(error.message, "The roster cursor is stale.");
        assert.equal(error.recoverTo, "nearest_prior");
        return true;
      },
    );

    mockJsonResponse(409, {
      detail: {
        code: "required_cursor",
        message: "A cursor is required.",
        recover_to: "first",
      },
    });
    await assert.rejects(
      api.get("/students?page=2", "token"),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.deepEqual(error.detail, {
          code: "required_cursor",
          message: "A cursor is required.",
          recover_to: "first",
        });
        assert.equal(error.message, "A cursor is required.");
        return true;
      },
    );
  });

  it("rejects malformed or non-409 cursor details without changing ordinary messages", async () => {
    mockJsonResponse(409, {
      detail: {
        code: "stale_cursor",
        message: "Malformed recovery.",
        recover_to: "later",
      },
    });
    await assert.rejects(
      fetchStudentPage("token"),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, "Malformed recovery.");
        assert.equal(error.detail, undefined);
        return true;
      },
    );

    mockJsonResponse(400, {
      detail: {
        code: "stale_cursor",
        message: "Wrong status.",
        recover_to: "first",
      },
    });
    await assert.rejects(
      fetchStudentPage("token"),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, "Wrong status.");
        assert.deepEqual(error.detail, {
          code: "stale_cursor",
          message: "Wrong status.",
          recover_to: "first",
        });
        return true;
      },
    );

    mockJsonResponse(400, { detail: { message: "Human-readable failure." } });
    await assert.rejects(
      fetchStudentPage("token"),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, "Human-readable failure.");
        assert.equal(error.detail, undefined);
        return true;
      },
    );
  });
});
