"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<"password" | "magic-link">("password");
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
      setTimeout(() => {
        router.push("/");
        router.refresh();
      }, 500);
      return;
    }

    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setIsLoading(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
      setTimeout(() => {
        setMagicLinkSent(true);
        setIsLoading(false);
      }, 500);
      return;
    }

    const { error: authError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
      },
    });

    if (authError) {
      setError(authError.message);
      setIsLoading(false);
      return;
    }

    setMagicLinkSent(true);
    setIsLoading(false);
  }

  if (magicLinkSent) {
    return (
      <div className="text-center">
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          Check your email
        </h2>
        <p className="text-sm text-text-secondary mb-4">
          We sent a sign-in link to <span className="text-text-primary font-mono text-xs">{email}</span>
        </p>
        <button
          onClick={() => {
            setMagicLinkSent(false);
            setMode("password");
          }}
          className="text-sm text-accent hover:text-accent-hover cursor-pointer"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-text-primary mb-5">
        Sign in to your studio
      </h2>

      {mode === "password" ? (
        <form onSubmit={handlePasswordLogin} className="space-y-4">
          <Input
            label="Email"
            type="email"
            placeholder="you@yourstudio.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <Input
            label="Password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />

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
            Sign in
          </Button>
        </form>
      ) : (
        <form onSubmit={handleMagicLink} className="space-y-4">
          <Input
            label="Email"
            type="email"
            placeholder="you@yourstudio.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />

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
            Send magic link
          </Button>
        </form>
      )}

      {/* Mode toggle */}
      <div className="mt-4 text-center">
        <button
          onClick={() => setMode(mode === "password" ? "magic-link" : "password")}
          className="text-xs text-muted hover:text-text-secondary cursor-pointer"
        >
          {mode === "password" ? "Sign in with magic link instead" : "Sign in with password instead"}
        </button>
      </div>

      {/* Signup link */}
      <div className="mt-5 pt-5 border-t border-border text-center">
        <p className="text-sm text-text-secondary">
          New to Koaryu?{" "}
          <Link href="/signup" className="text-accent hover:text-accent-hover font-medium">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
