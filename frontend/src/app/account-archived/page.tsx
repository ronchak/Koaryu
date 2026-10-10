"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  HorizonScene,
  SceneSheet,
  SceneSolo,
  sceneSheetLedeClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";
import { ToneChip } from "@/components/ui/horizon-parts";
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
          : "Could not sign out. Please try again.",
      );
      setIsSigningOut(false);
    }
  }

  return (
    <HorizonScene>
      <SceneSolo>
        <SceneSheet labelledBy="account-archived-title">
          <ToneChip tone="warn">
            <ShieldAlert aria-hidden="true" />
          </ToneChip>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-muted">
            Account access
          </p>
          <h1 id="account-archived-title" className={`mt-2 ${sceneSheetTitleClassName}`}>
            Studio access is archived
          </h1>
          <p className={sceneSheetLedeClassName}>
            Your studio access has been archived. This is reversible, and a studio admin or owner
            can restore access for you.
          </p>
          <p className={sceneSheetLedeClassName}>
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
        </SceneSheet>
      </SceneSolo>
    </HorizonScene>
  );
}
