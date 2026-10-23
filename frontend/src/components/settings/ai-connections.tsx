"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import { connectionStatus, type AiConnections } from "@/lib/mcp-connections";
import { Button } from "@/components/ui/button";
import { HorizonPanel } from "@/components/ui/horizon-parts";

export function AiConnectionsSection() {
  const { token, isPreviewMode } = useConfigStore();
  const [state, setState] = useState<AiConnections | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    if (!isPreviewMode && token) {
      void api
        .get<AiConnections>("/mcp/connections", token, { signal: abort.signal })
        .then((data) => {
          if (generation.current === current) {
            setState(data);
            setError("");
          }
        })
        .catch((err) => {
          if (!abort.signal.aborted && generation.current === current)
            setError(err instanceof Error ? err.message : "Could not load AI connections.");
        });
    }
    return () => {
      generation.current = current + 1;
      abort.abort();
    };
  }, [token, isPreviewMode]);

  async function disconnect(id: string) {
    if (busy || !token) return;
    const current = generation.current;
    setBusy(id);
    setError("");
    try {
      const result = await api.delete<{ native_consent_removed: boolean }>(
        `/mcp/connections/${id}`,
        token,
      );
      if (generation.current !== current) return;
      const updated = await api.get<AiConnections>("/mcp/connections", token);
      if (generation.current !== current) return;
      setState(updated);
      if (!result.native_consent_removed)
        setError(
          "Data access is disconnected. Click Disconnect again to finish resetting sign-in before reconnecting.",
        );
    } catch (err) {
      if (generation.current === current)
        setError(
          err instanceof Error
            ? err.message
            : "Could not disconnect. Check the connection before trying again.",
        );
    } finally {
      if (generation.current === current) setBusy(null);
    }
  }

  return (
    <HorizonPanel
      title="AI connections"
      titleId="ai-connections-title"
      description="Let your assistant read the studio information you choose."
    >
      {isPreviewMode ? (
        <p className="text-sm text-text-secondary">
          Connect an assistant from your signed-in studio. Demo mode does not share data.
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          )}
          {!state && !error && <p className="text-sm text-text-secondary">Loading connections…</p>}
          {state && !state.enabled && (
            <p className="text-sm text-text-secondary">
              AI connections are not enabled for this server yet.
            </p>
          )}
          {state?.enabled && (
            <div className="space-y-5">
              <p className="text-sm text-text-secondary">
                Add this server in your assistant, then sign in to Koaryu and choose what it can
                read.{" "}
                <Link className="underline" href="/help/ai-connections">
                  Setup instructions
                </Link>
              </p>
              <label className="block text-sm">
                Server address
                <input
                  aria-label="MCP server address"
                  className="mt-2 w-full rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs"
                  value={state.server_url ?? ""}
                  readOnly
                  onFocus={(event) => event.target.select()}
                />
              </label>
              <p className="text-sm text-text-secondary">
                Your assistant can retain information it has already received. Disconnecting stops
                future access. These connections cannot change studio records or send messages.
              </p>
              {state.connections.length === 0 && (
                <p className="text-sm">No assistants connected yet.</p>
              )}
              {state.connections.map((connection) => (
                <div key={connection.id} className="border-t border-border pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{connection.client_name}</p>
                      <p className="text-xs text-text-secondary">
                        {connectionStatus(connection)} · Expires{" "}
                        {new Date(connection.expires_at).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      isLoading={busy === connection.id}
                      onClick={() => void disconnect(connection.id)}
                    >
                      Disconnect
                    </Button>
                  </div>
                  <p className="mt-2 text-sm">
                    {connection.permissions.map((p) => state.permissions[p] ?? p).join("; ")}
                  </p>
                  <p className="mt-2 text-xs text-text-secondary">
                    {connection.last_used_at
                      ? `Last access: ${new Date(connection.last_used_at).toLocaleString()}${connection.last_dataset ? ` · ${connection.last_dataset}` : ""}`
                      : "No data access recorded yet."}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </HorizonPanel>
  );
}
