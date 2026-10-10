import { Suspense } from "react";
import { BillingPageFallback } from "@/components/billing/billing-page-chrome";
import { BillingPageBody } from "@/components/billing/billing-page-content";
import { getBillingTabFromSearch } from "@/lib/billing-page-state";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { tab } = await searchParams;
  const activeTab = getBillingTabFromSearch(
    new URLSearchParams({ tab: (Array.isArray(tab) ? tab[0] : tab) ?? "" }).toString(),
  );
  return (
    <Suspense fallback={<BillingPageFallback activeTab={activeTab} />}>
      <BillingPageBody />
    </Suspense>
  );
}
