import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AccessDeniedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg px-4">
      <section className="w-full max-w-md border border-border bg-surface p-6 text-center">
        <p className="text-xs font-medium uppercase tracking-widest text-muted">Access denied</p>
        <h1 className="mt-2 text-lg font-semibold text-text-primary">
          This area is not available for your role
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          No protected billing information was loaded. Contact a studio admin if you need help.
        </p>
        <Button asChild variant="primary" size="sm" className="mt-5">
          <Link href="/dashboard">Return to dashboard</Link>
        </Button>
      </section>
    </main>
  );
}
