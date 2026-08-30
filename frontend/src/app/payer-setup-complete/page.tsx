import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function PayerSetupCompletePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-surface p-8 text-center shadow-sm">
        <p className="text-sm font-medium text-text-secondary">Payment method setup</p>
        <h1 className="mt-2 text-2xl font-semibold text-text-primary">You can close this page</h1>
        <p className="mt-3 text-sm leading-6 text-text-secondary">
          Stripe has returned you to Koaryu. The studio can confirm the payment method status from its billing workspace.
        </p>
        <Button asChild variant="primary" size="sm" className="mt-6">
          <Link href="/">Visit Koaryu</Link>
        </Button>
      </section>
    </main>
  );
}
