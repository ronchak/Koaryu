import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { WorkflowWorkspace } from "@/components/automations/workflow-workspace";

export default async function WorkflowPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string | string[] }>;
}) {
  const { draft } = await searchParams;
  if (
    typeof draft !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft)
  )
    notFound();
  return (
    <OperationsSurface page="automations">
      <Header title="Workflow" />
      <WorkflowWorkspace draftId={draft.toLowerCase()} />
    </OperationsSurface>
  );
}
