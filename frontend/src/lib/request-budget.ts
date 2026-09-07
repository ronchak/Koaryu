export function isBulkRequest(path: string, method: string): boolean {
  const pathname = path.split("?")[0];
  return ["/students/import/", "/students/bulk/", "/reports/exports/", "/internal/", "/demo/"].some(prefix => pathname.startsWith(prefix))
    || (method === "POST" && ["/schedule/window/materialize", "/schedule/sessions/materialize", "/schedule/sessions/generate-week", "/schedule/attendance/bulk"].includes(pathname));
}

/** Backend: 30/120 seconds total; proxy: 34/125; browser: 35/130. */
export function apiRequestTimeout(path: string, method = "GET") {
  return isBulkRequest(path, method) ? 130_000 : 35_000;
}
export function proxyRequestTimeout(path: string, method = "GET") {
  return isBulkRequest(path, method) ? 125_000 : 34_000;
}
