import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeJsonRequestBody } from "../src/lib/api-body.ts";

describe("serializeJsonRequestBody", () => {
  it("omits only undefined request bodies", () => {
    assert.equal(serializeJsonRequestBody(undefined), undefined);
  });

  it("serializes falsy JSON request bodies", () => {
    assert.equal(serializeJsonRequestBody(null), "null");
    assert.equal(serializeJsonRequestBody(false), "false");
    assert.equal(serializeJsonRequestBody(0), "0");
    assert.equal(serializeJsonRequestBody(""), "\"\"");
  });

  it("keeps object and array request bodies unchanged semantically", () => {
    assert.equal(serializeJsonRequestBody({ ok: true }), "{\"ok\":true}");
    assert.equal(serializeJsonRequestBody([]), "[]");
  });
});
