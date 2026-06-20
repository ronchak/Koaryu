const API_PREFIX = "/api/v1";

export function buildApiUrl(
  path: string,
  options: {
    serverApiBase: string;
    useApiProxy: boolean;
    isBrowser: boolean;
    browserApiBase?: string;
  },
) {
  const {
    serverApiBase,
    useApiProxy,
    isBrowser,
    browserApiBase = "/api/proxy",
  } = options;

  if (!isBrowser || !useApiProxy) {
    return `${serverApiBase}${path}`;
  }

  const normalizedPath = path.startsWith(API_PREFIX)
    ? path.slice(API_PREFIX.length)
    : path;
  const proxyPath = normalizedPath.startsWith("/")
    ? normalizedPath
    : `/${normalizedPath}`;

  return `${browserApiBase}${proxyPath}`;
}
