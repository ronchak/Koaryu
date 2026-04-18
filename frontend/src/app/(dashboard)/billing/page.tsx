import { Header } from "@/components/header";
import { EmptyState } from "@/components/ui/empty-state";

export default function BillingPage() {
  return (
    <>
      <Header title="Billing" description="Subscriptions, payments, and invoices." />
      <div className="flex-1">
        <EmptyState
          message="Billing is not configured yet. Connect Stripe to start collecting tuition."
          actionLabel="Connect Stripe"
        />
      </div>
    </>
  );
}
