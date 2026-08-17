import Link from "next/link";

import { Button } from "@/components/ui/button";
import { FocusedOperationsSheet } from "@/components/operations/operations-surface";

export default function AccessDeniedPage() {
  return (
    <FocusedOperationsSheet page="access-denied" eyebrow="Access denied">
        <div className="text-center">
        <h1 className="mt-2 text-lg font-semibold text-text-primary">
          This area is not available for your role
        </h1>
        <p className="mt-2 text-sm text-text-secondary">
          No protected billing information was loaded. Contact a studio admin if you need help.
        </p>
        <Button asChild variant="primary" size="sm" className="mt-5">
          <Link href="/dashboard">Return to dashboard</Link>
        </Button>
        </div>
    </FocusedOperationsSheet>
  );
}
