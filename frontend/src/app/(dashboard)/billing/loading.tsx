import { OperationsLoading } from "@/components/operations/operations-surface";

export default function Loading() {
  return (
    <OperationsLoading
      page="billing"
      title="Billing"
      description="Loading tuition plans, family payers, invoices, and payment readiness."
    />
  );
}
