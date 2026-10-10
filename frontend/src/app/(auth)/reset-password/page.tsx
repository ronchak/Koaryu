"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { authErrorClassName } from "@/components/auth/auth-messages";
import {
  SceneSheet,
  SceneSolo,
  sceneSheetLedeClassName,
  sceneSheetTitleClassName,
} from "@/components/auth/horizon-scene";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [supabase] = useState(() => createClient());
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void supabase.auth.getSession().then(({ data, error: sessionError }) => {
        if (sessionError) {
          setError(sessionError.message);
          setHasRecoverySession(false);
        } else {
          setHasRecoverySession(Boolean(data.session));
        }
        setIsCheckingSession(false);
      });
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [supabase]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSaving(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        throw updateError;
      }
      setSuccess(true);
    } catch (updateError) {
      setError(
        updateError instanceof Error ? updateError.message : "Could not update your password.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (success) {
    return (
      <SceneSolo>
        <SceneSheet labelledBy="reset-title">
          <h1 id="reset-title" className={sceneSheetTitleClassName}>
            Password updated
          </h1>
          <p className={sceneSheetLedeClassName}>
            Your Koaryu password has been updated. You can continue to the app from here.
          </p>
          <Button
            type="button"
            size="lg"
            className="mt-6 w-full"
            onClick={() => router.push("/dashboard")}
          >
            Continue to Koaryu
          </Button>
        </SceneSheet>
      </SceneSolo>
    );
  }

  if (isCheckingSession) {
    return (
      <SceneSolo>
        <SceneSheet labelledBy="reset-title">
          <div role="status" aria-live="polite">
            <h1 id="reset-title" className={sceneSheetTitleClassName}>
              Checking reset link
            </h1>
            <p className={sceneSheetLedeClassName}>
              One moment while Koaryu verifies your password reset session.
            </p>
          </div>
        </SceneSheet>
      </SceneSolo>
    );
  }

  if (!hasRecoverySession) {
    return (
      <SceneSolo>
        <SceneSheet labelledBy="reset-title">
          <h1 id="reset-title" className={sceneSheetTitleClassName}>
            Reset link required
          </h1>
          <p className={sceneSheetLedeClassName}>
            At sign in, choose &quot;Sign in with magic link instead,&quot; then select &quot;Send
            magic link.&quot; Once signed in, request another password reset from Account Settings.
          </p>
          {error && <p className={`mt-4 ${authErrorClassName}`}>{error}</p>}
          <Button asChild variant="primary" size="lg" className="mt-6 w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </SceneSheet>
      </SceneSolo>
    );
  }

  return (
    <SceneSolo>
      <SceneSheet labelledBy="reset-title">
        <h1 id="reset-title" className={sceneSheetTitleClassName}>
          Set a new password
        </h1>
        <p className={sceneSheetLedeClassName}>
          Choose a password you will use the next time you sign in to Koaryu.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <Input
            label="New password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            hint="At least 8 characters."
          />
          <Input
            label="Confirm password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />

          {error && <p className={authErrorClassName}>{error}</p>}

          <Button type="submit" size="lg" className="w-full" isLoading={isSaving}>
            {isSaving ? "Updating..." : "Update password"}
          </Button>
        </form>
      </SceneSheet>
    </SceneSolo>
  );
}
