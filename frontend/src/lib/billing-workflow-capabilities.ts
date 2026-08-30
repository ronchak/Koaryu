import type { BillingSystemStatus } from "@/types";

export function enabledBillingWorkflowIds(
  status: BillingSystemStatus | null,
  role: string | null,
  isPreviewMode: boolean,
) {
  if (role !== "admin" && role !== "front_desk") return new Set<string>();
  if (isPreviewMode) return new Set(status?.workflow_capabilities.map(({ workflow_id }) => workflow_id) ?? []);
  return new Set(
    status?.workflow_capabilities
      .filter(({ enabled }) => enabled)
      .map(({ workflow_id }) => workflow_id) ?? [],
  );
}

export function billingWorkflowEnabled(
  enabledWorkflows: ReadonlySet<string>,
  workflowId: string,
  isPreviewMode: boolean,
) {
  return isPreviewMode || enabledWorkflows.has(workflowId);
}
