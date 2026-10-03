export function isBulkRequest(path: string, method: string): boolean {
  const pathname = path.split("?")[0];
  return (
    ["/students/import/", "/students/bulk/", "/reports/exports/", "/internal/", "/demo/"].some(
      (prefix) => pathname.startsWith(prefix),
    ) ||
    (method === "POST" &&
      ([
        "/schedule/window/materialize",
        "/schedule/sessions/materialize",
        "/schedule/sessions/generate-week",
        "/schedule/attendance/bulk",
      ].includes(pathname) ||
        /^\/students\/[^/]+\/photo$/.test(pathname)))
  );
}

export const PROXY_BODY_TIMEOUT_MS = 60_000;
/** Allow proxy buffering before its upstream clock starts, as well as the server budget. */
export function apiRequestTimeout(path: string, method = "GET") {
  return (
    (isBulkRequest(path, method) ? 130_000 : 35_000) +
    (["GET", "HEAD", "OPTIONS"].includes(method) ? 0 : PROXY_BODY_TIMEOUT_MS)
  );
}
export function proxyRequestTimeout(path: string, method = "GET") {
  return isBulkRequest(path, method) ? 125_000 : 34_000;
}
