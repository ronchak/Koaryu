export class UnsafeProxyPathError extends Error {
  constructor(message = "Invalid API proxy path.") {
    super(message);
    this.name = "UnsafeProxyPathError";
  }
}

function encodeProxyPathSegment(segment: string) {
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new UnsafeProxyPathError();
  }

  return encodeURIComponent(segment);
}

export function buildProxyTargetUrl(
  backendApiBase: string,
  requestUrl: string | URL,
  path: string[],
) {
  const sourceUrl = new URL(requestUrl);
  const normalizedBase = backendApiBase.replace(/\/$/, "");
  const encodedPath = path.map(encodeProxyPathSegment).join("/");
  const targetUrl = new URL(`${normalizedBase}/${encodedPath}`);
  targetUrl.search = sourceUrl.search;
  return targetUrl;
}
