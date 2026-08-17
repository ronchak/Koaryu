"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FocusedOperationsSheet } from "@/components/operations/operations-surface";
import { createClient } from "@/lib/supabase/client";
import { clearStoredStudioSessionCookies } from "@/lib/store-session-cookies";

export default function AccountArchivedPage() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState("");

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    setError("");
    try {
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        throw signOutError;
      }

      clearStoredStudioSessionCookies();
      router.replace("/login");
      router.refresh();
    } catch (signOutError) {
      setError(
        signOutError instanceof Error
          ? signOutError.message
          : "Could not sign out. Please try again."
      );
      setIsSigningOut(false);
    }
  }

  return (
    <FocusedOperationsSheet page="account-archived" eyebrow="Account access">
        <div className="flex h-10 w-10 items-center justify-center rounded-[6px] bg-warning/10 text-warning">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-text-primary">Studio access is archived</h1>
        <p className="mt-4 text-sm leading-6 text-text-secondary">
          Your studio access has been archived. This is reversible, and a studio admin or owner can restore access for you.
        </p>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          Contact a studio admin or owner for help. No studio data is loaded on this page.
        </p>

        <p role="alert" aria-live="assertive" className="mt-5 min-h-5 text-sm text-danger">
          {error}
        </p>

        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => void handleSignOut()}
          isLoading={isSigningOut}
          aria-busy={isSigningOut}
          className="mt-2 w-full"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {isSigningOut ? "Signing out..." : "Sign out"}
        </Button>
    </FocusedOperationsSheet>
  );
}
