import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionStatus, safeAiRedirect } from "../src/lib/mcp-connections.ts";
import { resolveAuthCallbackNextPath } from "../src/lib/auth-callback.ts";

test("OAuth return path preserves only a valid authorization identifier", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(
    resolveAuthCallbackNextPath(
      `/connect/authorize?authorization_id=${id}&redirect=https://evil.example#fragment`,
    ),
    `/connect/authorize?authorization_id=${id}`,
  );
  for (const path of [
    "/connect/authorize",
    "/connect/authorize?authorization_id=javascript:alert(1)",
    "//evil.example/connect/authorize",
    "/connect/authorize/extra",
    "/connect/authorize?authorization_id=<script>",
  ])
    assert.equal(resolveAuthCallbackNextPath(path), "/dashboard");
});

test("assistant callback allows HTTPS and loopback only, with no credentials or script schemes", () => {
  assert.equal(
    safeAiRedirect("https://chatgpt.com/connector/callback?code=synthetic"),
    "https://chatgpt.com/connector/callback?code=synthetic",
  );
  assert.equal(
    safeAiRedirect("http://localhost:3456/callback?code=synthetic"),
    "http://localhost:3456/callback?code=synthetic",
  );
  for (const url of [
    null,
    "javascript:alert(1)",
    "data:text/html,hello",
    "http://evil.example/cb",
    "https://user:password@example.com",
    "https://example.com/\ncallback",
    "//example.com/callback",
  ])
    assert.equal(safeAiRedirect(url), null, String(url));
});

test("connection status prioritizes disconnection and expiry", () => {
  const connection = { revoked_at: null, expires_at: "2026-11-01T00:00:00Z" };
  assert.equal(connectionStatus(connection, Date.parse("2026-10-01")), "Connected");
  assert.equal(connectionStatus(connection, Date.parse("2026-12-01")), "Expired");
  assert.equal(
    connectionStatus({ ...connection, revoked_at: "2026-09-01" }, Date.parse("2026-10-01")),
    "Disconnected",
  );
});
