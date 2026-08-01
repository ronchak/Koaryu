export type KoaryuDeploymentEnvironment =
  | "development"
  | "test"
  | "staging"
  | "production";

const STAGING_BACKEND_API = "https://koaryu-staging.onrender.com/api/v1";
const PRODUCTION_BACKEND_API = "https://koaryu.onrender.com/api/v1";
const LOCAL_BACKEND_APIS = new Set([
  "http://127.0.0.1:8001/api/v1",
  "http://localhost:8001/api/v1",
]);
const EXACT_ASCII_WITHOUT_WHITESPACE = /^[\x21-\x7e]+$/;

export function configuredBackendApiBase(environment: string) {
  const raw = process.env.BACKEND_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!raw || !EXACT_ASCII_WITHOUT_WHITESPACE.test(raw)) {
    return null;
  }

  let expected: string | Set<string>;
  if (environment === "staging") {
    expected = STAGING_BACKEND_API;
  } else if (environment === "production") {
    expected = PRODUCTION_BACKEND_API;
  } else if (environment === "development" || environment === "test") {
    expected = LOCAL_BACKEND_APIS;
  } else {
    return null;
  }

  if (
    (typeof expected === "string" && raw !== expected)
    || (expected instanceof Set && !expected.has(raw))
  ) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (
      parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.href !== raw
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return raw;
}
