import { RecordsLoading } from "@/components/records/records-loading";

export default function Loading() {
  return (
    <RecordsLoading
      title="Students"
      description="Loading roster, filters, and student actions."
      variant="roster"
    />
  );
}
