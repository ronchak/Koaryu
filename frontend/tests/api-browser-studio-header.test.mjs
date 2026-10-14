import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register("./helpers/path-alias-loader.mjs", import.meta.url);

for (const useApiProxy of [false, true]) {
  test(`browser studio cookies are read only for direct selected requests, proxy=${useApiProxy}`, async (t) => {
    const original = {
      fetch: globalThis.fetch,
      window: Object.getOwnPropertyDescriptor(globalThis, "window"),
      document: Object.getOwnPropertyDescriptor(globalThis, "document"),
      proxy: process.env.NEXT_PUBLIC_USE_API_PROXY,
    };
    t.after(() => {
      globalThis.fetch = original.fetch;
      for (const key of ["window", "document"]) {
        if (original[key]) Object.defineProperty(globalThis, key, original[key]);
        else delete globalThis[key];
      }
      if (original.proxy === undefined) delete process.env.NEXT_PUBLIC_USE_API_PROXY;
      else process.env.NEXT_PUBLIC_USE_API_PROXY = original.proxy;
    });
    process.env.NEXT_PUBLIC_USE_API_PROXY = String(useApiProxy);
    const { api } = await import(`../src/lib/api.ts?browser-studio-proxy=${useApiProxy}`);
    let cookieReads = 0;
    let cookie = "koaryu-active-studio=studio-1";
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get cookie() {
          cookieReads++;
          return cookie;
        },
      },
    });
    let sentHeaders;
    globalThis.fetch = async (_url, init) => {
      sentHeaders = new Headers(init.headers);
      return Response.json({ ok: true });
    };
    const headers = { "x-STUDIO-id": "caller-studio", Accept: "application/json" };
    await api.get("/students", "token", { headers, omitStudioHeader: true });
    assert.equal(cookieReads, 0);
    assert.equal(sentHeaders.has("x-studio-id"), false);
    assert.equal(sentHeaders.get("authorization"), "Bearer token");
    assert.equal(sentHeaders.get("accept"), "application/json");

    await api.get("/students", "token", { headers });
    assert.equal(cookieReads, useApiProxy ? 0 : 1);
    assert.equal(sentHeaders.get("x-studio-id"), useApiProxy ? null : "studio-1");
    cookie = "koaryu-active-studio=studio-2";
    await api.get("/students", "token", { headers });
    assert.equal(cookieReads, useApiProxy ? 0 : 2);
    assert.equal(sentHeaders.get("x-studio-id"), useApiProxy ? null : "studio-2");
    cookie = "";
    await api.get("/students", "token", { headers });
    assert.equal(cookieReads, useApiProxy ? 0 : 3);
    assert.equal(sentHeaders.has("x-studio-id"), false);
  });
}
