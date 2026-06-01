export function serializeJsonRequestBody(body: unknown) {
  return body === undefined ? undefined : JSON.stringify(body);
}
