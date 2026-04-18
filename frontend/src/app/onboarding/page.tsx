"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { APP_TAGLINE } from "@/lib/constants";

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

export default function OnboardingPage() {
  const [studioName, setStudioName] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError("You must be signed in to create a studio.");
        setIsLoading(false);
        return;
      }

      await api.post(
        "/studios",
        { name: studioName, timezone },
        session.access_token
      );

      router.push("/");
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
              onChange={(e) => setStudioName(e.target.value)}
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
                onChange={(e) => setTimezone(e.target.value)}
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
