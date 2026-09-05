import { Header } from "@/components/header";
import { LeadLedgerLoading } from "@/components/leads/lead-ledger-loading";

export default function Loading() {
  return (
    <>
      <Header title="Leads" />
      <div className="p-4 sm:p-6 lg:p-8"><LeadLedgerLoading /></div>
    </>
  );
}
