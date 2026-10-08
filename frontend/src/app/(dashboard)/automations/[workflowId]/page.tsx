import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { OperationsSurface } from "@/components/operations/operations-surface";
import { WorkflowWorkspace } from "@/components/automations/workflow-workspace";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  if (
    typeof workflowId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId)
  )
    notFound();
  return (
    <OperationsSurface page="automations">
      <Header title="Workflow" />
      <WorkflowWorkspace workflowId={workflowId.toLowerCase()} />
    </OperationsSurface>
  );
}
