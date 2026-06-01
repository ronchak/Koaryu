const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "vary",
  "server-timing",
] as const;

const DEFAULT_PRIVATE_VARY = ["Authorization", "Cookie"] as const;
export const PRIVATE_PROXY_CACHE_CONTROL = "no-store, private";

export function buildPrivateProxyHeaders(upstreamHeaders: Headers): Headers {
  const responseHeaders = new Headers();

  for (const headerName of SAFE_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(headerName);
    if (value) {
      responseHeaders.set(headerName, value);
    }
  }

  responseHeaders.set("cache-control", PRIVATE_PROXY_CACHE_CONTROL);

  const varyValues = new Set(
    (responseHeaders.get("vary") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const varyKeys = new Set([...varyValues].map((value) => value.toLowerCase()));
  for (const value of DEFAULT_PRIVATE_VARY) {
    if (!varyKeys.has(value.toLowerCase())) {
      varyValues.add(value);
    }
  }
  responseHeaders.set("vary", [...varyValues].join(", "));

  return responseHeaders;
}

export function buildPrivateProxyJsonHeaders(): Headers {
  return buildPrivateProxyHeaders(new Headers({
    "content-type": "application/json",
  }));
}
