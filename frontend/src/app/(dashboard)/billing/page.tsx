import { Suspense } from "react";
import { BillingPageFallback } from "@/components/billing/billing-page-chrome";
import { BillingPageBody } from "@/components/billing/billing-page-content";

export default function BillingPage() {
  return (
    <Suspense fallback={<BillingPageFallback />}>
      <BillingPageBody />
    </Suspense>
  );
}
