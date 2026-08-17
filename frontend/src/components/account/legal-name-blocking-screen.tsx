"use client";

import { useState, type FormEvent } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FocusedOperationsSheet } from "@/components/operations/operations-surface";
import { useStudioStore } from "@/lib/store";
import { normalizeLegalNameDraft } from "@/lib/legal-name-model";

interface LegalNameBlockingScreenProps {
  onSignOut: () => void | Promise<void>;
  isSigningOut?: boolean;
}

export function LegalNameBlockingScreen({
  onSignOut,
  isSigningOut = false,
}: LegalNameBlockingScreenProps) {
  const { updateUserLegalName } = useStudioStore();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");

  const normalizedNames = normalizeLegalNameDraft({ firstName, lastName });
  const canSubmit = Boolean(normalizedNames.firstName && normalizedNames.lastName);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    if (!canSubmit) {
      setError("Enter both your legal first and last name.");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      await updateUserLegalName(normalizedNames.firstName, normalizedNames.lastName);
    } catch (submitError: unknown) {
      setError(submitError instanceof Error ? submitError.message : "Could not save your legal name.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <FocusedOperationsSheet page="legal-name" eyebrow="Account setup">
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-text-primary">Add your legal name</h1>
          <p className="text-sm leading-relaxed text-text-secondary">
            Enter your legal first and last name. These names are used for studio records and other official Koaryu records.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Legal first name"
              name="legalFirstName"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              autoComplete="given-name"
              required
            />
            <Input
              label="Legal last name"
              name="legalLastName"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              autoComplete="family-name"
              required
            />
          </div>

          <p aria-live="polite" className="min-h-5 text-sm text-danger">
            {error}
          </p>

          <Button type="submit" variant="primary" size="lg" isLoading={isSubmitting} disabled={!canSubmit}>
            {isSubmitting ? "Saving legal name..." : "Save legal name"}
          </Button>
        </form>

        <div className="mt-6 border-t border-border pt-5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void onSignOut();
            }}
            isLoading={isSigningOut}
          >
            <LogOut className="h-3.5 w-3.5" />
            {isSigningOut ? "Signing out..." : "Sign out"}
          </Button>
        </div>
    </FocusedOperationsSheet>
  );
}
