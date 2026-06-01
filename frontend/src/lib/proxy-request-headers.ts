const FORWARDED_REQUEST_HEADERS = ["authorization", "accept", "idempotency-key"] as const;
const STUDIO_ID_HEADER = "x-studio-id";

function normalizedOptionalValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

export function buildUpstreamProxyRequestHeaders(
  requestHeaders: Headers,
  activeStudioCookieValue: string | null | undefined
) {
  const headers = new Headers();

  for (const headerName of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  const contentType = requestHeaders.get("content-type");
  if (contentType && !contentType.includes("multipart/form-data")) {
    headers.set("content-type", contentType);
  }

  const activeStudioId = normalizedOptionalValue(activeStudioCookieValue);
  if (activeStudioId) {
    headers.set(STUDIO_ID_HEADER, activeStudioId);
  }

  return headers;
}
