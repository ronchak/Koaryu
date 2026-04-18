import { Header } from "@/components/header";
import { EmptyState } from "@/components/ui/empty-state";

export default function ReportsPage() {
  return (
    <>
      <Header title="Reports" description="Studio performance and operational metrics." />
      <div className="flex-1">
        <EmptyState
          message="No data to report yet. Reports will populate as you track students, attendance, and revenue."
        />
      </div>
    </>
  );
}
