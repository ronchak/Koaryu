"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { api } from "@/lib/api";
import { isAiAuthorizationId, safeAiRedirect, type AiAuthorization } from "@/lib/mcp-connections";
import { Button } from "@/components/ui/button";

type ConsentOperation = { token: string; authorizationId: string };

export function AiConsent({ authorizationId }: { authorizationId: string | null }) {
  const [token, setToken] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [loaded, setLoaded] = useState<{
    token: string;
    authorizationId: string;
    details: AiAuthorization;
  } | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<(ConsentOperation & { message: string }) | null>(null);
  const [operation, setOperation] = useState<ConsentOperation | null>(null);
  const pending = useRef<ConsentOperation | null>(null);
  const generation = useRef(0);
  const details =
    loaded?.token === token && loaded.authorizationId === authorizationId ? loaded.details : null;
  const valid = isAiAuthorizationId(authorizationId);
  const busy = operation?.token === token && operation.authorizationId === authorizationId;
  const message =
    error?.token === token && error.authorizationId === authorizationId ? error.message : "";

  useEffect(() => {
    let active = true;
    let authEventSeen = false;
    const supabase = createClient();
    void supabase.auth.getSession().then(({ data }) => {
      if (active && !authEventSeen) {
        setToken(data.session?.access_token ?? null);
        setSessionReady(true);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventSeen = true;
      if (active) {
        setToken(session?.access_token ?? null);
        setSessionReady(true);
      }
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    if (token && authorizationId && valid) {
      void api
        .get<AiAuthorization | { redirect_url: string }>(
          `/mcp/authorizations/${authorizationId}`,
          token,
          { signal: abort.signal, omitStudioHeader: true },
        )
        .then((result) => {
          if (generation.current !== current) return;
          if ("redirect_url" in result) {
            leave(result.redirect_url);
            return;
          }
          setLoaded({ token, authorizationId, details: result });
          setPermissions(result.default_permissions);
          setError(null);
        })
        .catch((err) => {
          if (!abort.signal.aborted && generation.current === current)
            setError({
              token,
              authorizationId,
              message:
                err instanceof Error ? err.message : "Could not load this connection request.",
            });
        });
    }
    return () => {
      generation.current = current + 1;
      abort.abort();
    };
  }, [token, authorizationId, valid]);

  function leave(raw: string) {
    const url = safeAiRedirect(raw);
    if (!url) throw new Error("The assistant returned an unsupported callback address.");
    window.location.assign(url);
  }

  async function decide(approve: boolean) {
    if (
      !token ||
      !authorizationId ||
      !details ||
      (pending.current?.token === token && pending.current.authorizationId === authorizationId)
    )
      return;
    const currentOperation = { token, authorizationId };
    pending.current = currentOperation;
    setOperation(currentOperation);
    setError(null);
    const current = generation.current;
    try {
      const result = await api.post<{ redirect_url: string }>(
        `/mcp/authorizations/${authorizationId}/${approve ? "approve" : "deny"}`,
        approve ? { permissions, expires_days: days } : {},
        token,
        { omitStudioHeader: true },
      );
      if (generation.current === current) leave(result.redirect_url);
    } catch (err) {
      if (generation.current === current)
        setError({
          ...currentOperation,
          message:
            err instanceof Error
              ? err.message
              : "Could not complete authorization. Start the connection again in your assistant.",
        });
    } finally {
      if (pending.current === currentOperation) pending.current = null;
      if (generation.current === current) setOperation(null);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <Link href="/" className="text-sm font-medium">
        Koaryu
      </Link>
      <h1 className="mt-8 text-3xl font-medium">Connect your assistant</h1>
      {!valid ? (
        <p role="alert" className="mt-5">
          This connection link is invalid. Start again from your assistant.
        </p>
      ) : (
        <>
          {!sessionReady && <p className="mt-5">Checking sign-in…</p>}
          {sessionReady && !token && (
            <div className="mt-6 space-y-4">
              <p>Sign in to choose which studio information this assistant can read.</p>
              <Link
                className="underline"
                href={`/login?next=${encodeURIComponent(`/connect/authorize?authorization_id=${authorizationId}`)}`}
              >
                Sign in to Koaryu
              </Link>
            </div>
          )}
          {token && !details && !message && <p className="mt-5">Loading connection request…</p>}
          {message && (
            <p role="alert" className="mt-5 text-danger">
              {message}
            </p>
          )}
          {details && (
            <div className="mt-6 space-y-6">
              <p className="[overflow-wrap:anywhere]">
                <strong>
                  <bdi>{details.client_name}</bdi>
                </strong>{" "}
                is requesting read access to your studio.
              </p>
              <p className="text-sm text-text-secondary">
                The assistant supplied this name. Check that it matches the connection you started.
                Return address: <span className="break-all">{details.redirect_uri}</span>
              </p>
              {details.identity_scope && (
                <p className="text-sm text-text-secondary">
                  Connection scope: {details.identity_scope}. This lets the assistant renew its read
                  connection until it expires or you disconnect.
                </p>
              )}
              <fieldset disabled={busy} className="space-y-3">
                <legend className="mb-3 font-medium">Choose information to share</legend>
                {Object.entries(details.permissions).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-start gap-3 rounded-lg border border-border p-3"
                  >
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={permissions.includes(key)}
                      onChange={(event) =>
                        setPermissions((previous) =>
                          event.target.checked
                            ? [...previous, key]
                            : previous.filter((p) => p !== key),
                        )
                      }
                    />
                    <span className="text-sm">{label}</span>
                  </label>
                ))}
              </fieldset>
              <label className="block text-sm">
                Access expires after
                <select
                  className="ml-3 rounded border border-border bg-surface-raised p-2"
                  value={days}
                  disabled={busy}
                  onChange={(event) => setDays(Number(event.target.value))}
                >
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={90}>90 days</option>
                </select>
              </label>
              <p className="text-sm text-text-secondary">
                Selected information will be sent to your chosen AI service when it requests it.
                Notes can contain sensitive personal information. Your assistant cannot change
                studio records, send messages, or collect payments. Disconnect any time in Settings.
                Disconnecting cannot remove information the assistant has already received.
              </p>
              <div className="flex gap-3">
                <Button
                  disabled={busy || permissions.length === 0}
                  isLoading={busy}
                  onClick={() => void decide(true)}
                >
                  Allow selected reads
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
                  Decline
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
