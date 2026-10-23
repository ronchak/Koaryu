"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useConfigStore } from "@/lib/store";
import { connectionStatus, type AiConnection, type AiConnections } from "@/lib/mcp-connections";
import { Button } from "@/components/ui/button";
import { HorizonPanel } from "@/components/ui/horizon-parts";
import { AiConnectionAccessEditor } from "./ai-connection-access-editor";

type Operation = { token: string; id: string };

export function AiConnectionsSection() {
  const { token, isPreviewMode } = useConfigStore();
  const [loaded, setLoaded] = useState<{ token: string; data: AiConnections } | null>(null);
  const [error, setError] = useState<{ token: string; message: string } | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [editing, setEditing] = useState<Operation | null>(null);
  const pending = useRef<Operation | null>(null);
  const generation = useRef(0);
  const listSequence = useRef(0);
  const state = loaded?.token === token ? loaded.data : null;
  const busyId = busy?.token === token ? busy.id : null;
  const editingId = editing?.token === token ? editing.id : null;
  const message = error?.token === token ? error.message : "";

  useEffect(() => {
    const current = ++generation.current;
    const request = ++listSequence.current;
    const abort = new AbortController();
    if (!isPreviewMode && token) {
      void api
        .get<AiConnections>("/mcp/connections", token, {
          signal: abort.signal,
          omitStudioHeader: true,
        })
        .then((data) => {
          if (generation.current === current && listSequence.current === request) {
            setLoaded({ token, data });
            setError(null);
          }
        })
        .catch((err) => {
          if (
            !abort.signal.aborted &&
            generation.current === current &&
            listSequence.current === request
          )
            setError({
              token,
              message: err instanceof Error ? err.message : "Could not load AI connections.",
            });
        });
    }
    return () => {
      generation.current = current + 1;
      abort.abort();
    };
  }, [token, isPreviewMode]);

  async function change(
    connection: AiConnection,
    access?: { permissions: string[]; days: number | null },
  ) {
    if (!token || pending.current?.token === token) return;
    const operation = { token, id: connection.id };
    const current = generation.current;
    pending.current = operation;
    ++listSequence.current;
    setBusy(operation);
    setError(null);
    try {
      let nativeConsentRemoved = true;
      if (access) {
        await api.post(
          `/mcp/connections/${connection.id}/access`,
          {
            permissions: access.permissions,
            expected_authorized_at: connection.authorized_at,
            ...(access.days === null ? {} : { expires_days: access.days }),
          },
          token,
          { omitStudioHeader: true },
        );
      } else {
        const result = await api.delete<{ native_consent_removed: boolean }>(
          `/mcp/connections/${connection.id}`,
          token,
          { omitStudioHeader: true },
        );
        nativeConsentRemoved = result.native_consent_removed;
      }
      if (generation.current !== current) return;
      setEditing(null);
      const request = ++listSequence.current;
      const data = await api.get<AiConnections>("/mcp/connections", token, {
        omitStudioHeader: true,
      });
      if (generation.current !== current || listSequence.current !== request) return;
      setLoaded({ token, data });
      if (!nativeConsentRemoved)
        setError({
          token,
          message:
            "Data access is disconnected. Click Disconnect again to finish resetting sign-in before reconnecting.",
        });
    } catch (err) {
      if (generation.current === current)
        setError({
          token,
          message:
            err instanceof Error
              ? err.message
              : "Could not change access. Refresh and review the connection before trying again.",
        });
    } finally {
      if (pending.current === operation) pending.current = null;
      if (generation.current === current) setBusy(null);
    }
  }

  async function copyAddress() {
    if (!token || !state?.server_url) return;
    try {
      await navigator.clipboard.writeText(state.server_url);
    } catch {
      setError({ token, message: "Select the connection address and copy it using your browser." });
    }
  }

  async function refresh() {
    if (!token || pending.current?.token === token) return;
    const current = generation.current;
    const request = ++listSequence.current;
    try {
      const data = await api.get<AiConnections>("/mcp/connections", token, {
        omitStudioHeader: true,
      });
      if (generation.current === current && listSequence.current === request) {
        setLoaded({ token, data });
        setError(null);
      }
    } catch (err) {
      if (generation.current === current && listSequence.current === request)
        setError({
          token,
          message: err instanceof Error ? err.message : "Could not refresh connections.",
        });
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
          {message && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {message}
            </p>
          )}
          {!state && !message && (
            <p className="text-sm text-text-secondary">Loading connections…</p>
          )}
          {state && !state.enabled && (
            <p className="text-sm text-text-secondary">
              AI connections are not enabled for this server yet.
            </p>
          )}
          {state?.enabled && (
            <div className="space-y-5">
              <p className="text-sm text-text-secondary">
                Add this address in your assistant, then sign in to Koaryu and choose what it can
                read.{" "}
                <Link className="underline" href="/help/ai-connections">
                  Setup instructions
                </Link>
              </p>
              <div className="space-y-3">
                <label className="block text-sm">
                  Connection address
                  <input
                    aria-label="MCP server address"
                    className="mt-2 w-full rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs"
                    value={state.server_url ?? ""}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void copyAddress()}>
                    Copy connection address
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busyId !== null}
                    onClick={() => void refresh()}
                  >
                    Refresh connections
                  </Button>
                </div>
              </div>
              <p className="text-sm text-text-secondary">
                Your assistant can retain information it has already received. Changes apply to
                future reads. These connections cannot change studio records or send messages.
              </p>
              {state.connections.length === 0 && (
                <p className="text-sm">No assistants connected yet.</p>
              )}
              {state.connections.map((connection) => {
                const status = connectionStatus(connection);
                const canEdit = !connection.revoked_at && connection.session_ready !== false;
                return (
                  <div
                    key={connection.id}
                    data-ai-connection={connection.id}
                    className="border-t border-border pt-4"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium [overflow-wrap:anywhere]">
                          <bdi>{connection.client_name}</bdi>
                        </p>
                        <p className="text-xs text-text-secondary">
                          {status} · Expires {new Date(connection.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {canEdit && (
                          <Button
                            variant="secondary"
                            disabled={busyId !== null}
                            onClick={() => token && setEditing({ token, id: connection.id })}
                          >
                            {status === "Expired" ? "Renew access" : "Edit access"}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          disabled={busyId !== null}
                          isLoading={busyId === connection.id && editingId !== connection.id}
                          onClick={() => void change(connection)}
                        >
                          Disconnect
                        </Button>
                      </div>
                    </div>
                    <p className="mt-2 text-sm">
                      {connection.permissions.map((p) => state.permissions[p] ?? p).join("; ")}
                    </p>
                    {status === "Awaiting assistant" && (
                      <p className="mt-2 text-sm text-text-secondary">
                        Finish signing in through your assistant. Disconnect to reset an unfinished
                        connection.
                      </p>
                    )}
                    <p className="mt-2 text-xs text-text-secondary">
                      {connection.last_used_at
                        ? `Last access: ${new Date(connection.last_used_at).toLocaleString()}${connection.last_dataset ? ` · ${connection.last_dataset}` : ""}`
                        : "No data access recorded yet."}
                    </p>
                    {canEdit && editingId === connection.id && (
                      <AiConnectionAccessEditor
                        key={connection.id + connection.authorized_at}
                        connection={connection}
                        permissions={state.permissions}
                        busy={busyId === connection.id}
                        onSave={(permissions, days) =>
                          void change(connection, { permissions, days })
                        }
                        onCancel={() => setEditing(null)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </HorizonPanel>
  );
}
