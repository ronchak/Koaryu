export const STUDIO_ID_HEADER = "X-Studio-Id";

function withoutHeader(headers: Record<string, string>, headerName: string) {
  const normalizedHeaderName = headerName.toLowerCase();
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== normalizedHeaderName)
  );
}

export function applyBrowserStudioHeader(
  headers: Record<string, string>,
  activeStudioId: string | null,
  options: { omitStudioHeader?: boolean; useApiProxy?: boolean } = {}
) {
  const nextHeaders = withoutHeader(headers, STUDIO_ID_HEADER);

  if (options.omitStudioHeader || options.useApiProxy || !activeStudioId) {
    return nextHeaders;
  }

  nextHeaders[STUDIO_ID_HEADER] = activeStudioId;
  return nextHeaders;
}
