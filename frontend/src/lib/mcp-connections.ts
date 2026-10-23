export type AiConnection = {
  id: string;
  client_id: string;
  client_name: string;
  permissions: string[];
  authorized_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  last_tool: string | null;
  last_dataset: string | null;
  last_row_count: number | null;
  session_ready?: boolean;
};

export type AiConnections = {
  enabled: boolean;
  connections: AiConnection[];
  permissions: Record<string, string>;
  default_permissions: string[];
  server_url: string | null;
};

export type AiAuthorization = {
  authorization_id: string;
  client_name: string;
  redirect_uri: string;
  identity_scope: string;
  permissions: Record<string, string>;
  default_permissions: string[];
};

export function connectionStatus(connection: AiConnection, now = Date.now()) {
  if (connection.revoked_at) return "Disconnected";
  if (Date.parse(connection.expires_at) <= now) return "Expired";
  return connection.session_ready === false ? "Awaiting assistant" : "Connected";
}

export function safeAiRedirect(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020]/.test(value))
    return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return url.href;
  } catch {
    /* Invalid callback. */
  }
  return null;
}

// Supabase exposes an opaque browser request ID, separate from its database UUID.
export function isAiAuthorizationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 128 &&
    !/[^A-Za-z0-9_-]/.test(value)
  );
}
