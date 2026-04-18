import { Header } from "@/components/header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AutomationsPage() {
  return (
    <>
      <Header title="Automations" description="Rules-based email workflows." />
      <div className="flex-1">
        <EmptyState
          message="No automations set up yet. Create triggers to automate follow-ups and reminders."
          actionLabel="Create automation"
        />
      </div>
    </>
  );
}
