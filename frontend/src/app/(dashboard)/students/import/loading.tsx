import { RecordsLoading } from "@/components/records/records-loading";

export default function Loading() {
  return (
    <RecordsLoading
      title="Import Students"
      description="Loading the import worksheet and reconciliation steps."
      variant="import"
    />
  );
}
