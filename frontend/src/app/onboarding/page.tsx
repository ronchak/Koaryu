"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { APP_TAGLINE } from "@/lib/constants";
import { setActiveStudioIdCookie, setStudioStateCookie } from "@/lib/studio-state-cookie";
import type { Studio } from "@/types";

const PREVIEW_STUDIO_ID = "preview-studio";

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Australia/Sydney",
  "Australia/Melbourne",
];
const TIMEZONE_OPTIONS = new Set(TIMEZONES);
const ONBOARDING_IDEMPOTENCY_STORAGE_KEY = "koaryu:studio-onboarding:idempotency";

function createIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `studio-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createIdempotencyPayload(name: string, timezone: string) {
  return JSON.stringify({ name, timezone });
}

function getStoredIdempotencyKey(payload: string) {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.sessionStorage.getItem(ONBOARDING_IDEMPOTENCY_STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as {
      payload?: unknown;
      requestKey?: unknown;
    };

    return parsed.payload === payload && typeof parsed.requestKey === "string"
      ? parsed.requestKey
      : null;
  } catch {
    return null;
  }
}

function storeIdempotencyKey(payload: string, requestKey: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      ONBOARDING_IDEMPOTENCY_STORAGE_KEY,
      JSON.stringify({ payload, requestKey })
    );
  } catch {
    // Same-page retries still reuse the in-memory key when sessionStorage is unavailable.
  }
}

function clearStoredIdempotencyKey() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(ONBOARDING_IDEMPOTENCY_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures; the payload check prevents stale-key reuse.
  }
}

export default function OnboardingPage() {
  const [studioName, setStudioName] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const normalizedStudioName = studioName.trim();
      if (!normalizedStudioName) {
        setError("Enter your studio name.");
        setIsLoading(false);
        return;
      }

      if (!TIMEZONE_OPTIONS.has(timezone)) {
        setError("Choose a valid timezone.");
        setIsLoading(false);
        return;
      }

      if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
        const previewUserId =
          typeof window !== "undefined"
            ? window.localStorage.getItem("koaryu:previewSignupEmail") || "preview-user"
            : "preview-user";
        setStudioStateCookie(previewUserId, true);
        setActiveStudioIdCookie(PREVIEW_STUDIO_ID);
        if (typeof window !== "undefined") {
          window.localStorage.setItem("koaryu:studioName", normalizedStudioName);
        }
        router.push("/dashboard");
        router.refresh();
        return;
      }

      const idempotencyPayload = createIdempotencyPayload(normalizedStudioName, timezone);
      const requestKey =
        idempotencyKeyRef.current ??
        getStoredIdempotencyKey(idempotencyPayload) ??
        createIdempotencyKey();
      idempotencyKeyRef.current = requestKey;
      storeIdempotencyKey(idempotencyPayload, requestKey);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError("You must be signed in to create a studio.");
        setIsLoading(false);
        return;
      }

      const studio = await api.post<Studio>(
        "/studios",
        { name: normalizedStudioName, timezone },
        session.access_token,
        {
          headers: {
            "Idempotency-Key": requestKey,
          },
        }
      );
      idempotencyKeyRef.current = null;
      clearStoredIdempotencyKey();
      setStudioStateCookie(session.user.id, true);
      setActiveStudioIdCookie(studio.id);

      router.push("/subscription-required");
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create studio";
      setError(message);
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-bg">
      {/* Accent line */}
      <div className="fixed top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-accent/30 to-transparent" />

      <div className="w-full max-w-[440px]">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-3">
            <Logo size="lg" />
          </div>
          <p className="text-sm text-muted">{APP_TAGLINE}</p>
        </div>

        {/* Onboarding card */}
        <div className="bg-surface border border-border rounded-[6px] p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-1">
            Set up your studio
          </h2>
          <p className="text-sm text-text-secondary mb-6">
            Tell us about your dojo and you&apos;ll be ready to go.
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <Input
              label="Studio name"
              type="text"
              placeholder="Pacific Coast Karate"
              value={studioName}
              onChange={(e) => {
                idempotencyKeyRef.current = null;
                clearStoredIdempotencyKey();
                setStudioName(e.target.value);
              }}
              required
            />

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="timezone"
                className="text-sm text-text-secondary font-medium"
              >
                Timezone
              </label>
              <select
                id="timezone"
                value={timezone}
                onChange={(e) => {
                  idempotencyKeyRef.current = null;
                  clearStoredIdempotencyKey();
                  setTimezone(e.target.value);
                }}
                className="w-full px-3 py-2 text-sm bg-surface-raised border border-border rounded-[6px] text-text-primary focus:border-accent focus:outline-none"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <p className="text-xs text-danger">{error}</p>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              isLoading={isLoading}
              className="w-full"
            >
              Launch your dojo
            </Button>
          </form>
        </div>

        <p className="text-xs text-muted text-center mt-4">
          You can update these settings anytime.
        </p>
      </div>
    </div>
  );
}
