"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

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
      setError(updateError instanceof Error ? updateError.message : "Could not update your password.");
    } finally {
      setIsSaving(false);
    }
  }

  if (success) {
    return (
      <div className="text-center">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">Password updated</h2>
        <p className="mb-5 text-sm text-text-secondary">
          Your Koaryu password has been updated. You can continue to the app from here.
        </p>
        <Button type="button" size="lg" className="w-full" onClick={() => router.push("/dashboard")}>
          Continue to Koaryu
        </Button>
      </div>
    );
  }

  if (isCheckingSession) {
    return (
      <div className="text-center">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">Checking reset link</h2>
        <p className="text-sm text-text-secondary">One moment while Koaryu verifies your password reset session.</p>
      </div>
    );
  }

  if (!hasRecoverySession) {
    return (
      <div className="text-center">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">Reset link required</h2>
        <p className="mb-5 text-sm text-text-secondary">
          Open the password reset link from your email, or request a new reset from Account Settings while signed in.
        </p>
        <Link href="/login" className="text-sm font-medium text-accent hover:text-accent-hover">
          Back to sign in
        </Link>
        {error && <p className="mt-4 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-2 text-lg font-semibold text-text-primary">Set a new password</h2>
      <p className="mb-5 text-sm text-text-secondary">
        Choose a password you will use the next time you sign in to Koaryu.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="New password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
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

        {error && <p className="text-xs text-danger">{error}</p>}

        <Button type="submit" size="lg" className="w-full" isLoading={isSaving}>
          {isSaving ? "Updating..." : "Update password"}
        </Button>
      </form>
    </div>
  );
}
