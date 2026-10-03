import { RecordsLoading } from "@/components/records/records-loading";

export default function Loading() {
  return (
    <RecordsLoading
      title="Student record"
      description="Loading identity, training, guardian, and promotion history."
      variant="folio"
    />
  );
}
