"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfigStore, useStudioStore } from "@/lib/store";
import { workflowDraftAddress } from "@/lib/automation-workflow-workspace-state";

/**
 * The page's one primary action: open a fresh local draft. The editor route owns the
 * draft and asks before replacing unsaved work, so this needs no state of its own.
 */
export function NewWorkflowButton() {
  const router = useRouter();
  const { isPreviewMode } = useConfigStore();
  const { identityReady, currentRole } = useStudioStore();
  if (!isPreviewMode && identityReady && currentRole !== "admin") return null;
  return (
    <Button
      type="button"
      size="lg"
      disabled={!isPreviewMode && !identityReady}
      onClick={() => router.push(workflowDraftAddress(crypto.randomUUID()))}
      data-automation-action="new-workflow"
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      New workflow
    </Button>
  );
}
