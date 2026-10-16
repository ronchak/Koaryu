"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBeltStore, useProgramStore } from "@/lib/store";
import type { WorkflowWorkspace as Owner } from "@/lib/automation-workflow-workspace-controller";
import { workflowPreviewReferences } from "@/lib/automation-workflow-preview";
import type { WorkflowReferenceChoices } from "@/lib/automation-workflow-catalog";

/**
 * Program and rank choices for the step settings. Preview uses the sample references; live
 * reads go through the stores, stay owned by this owner, and can be retried one at a time.
 */
export function useWorkflowReferences(owner: Owner, preview: boolean) {
  const { programs, programsLoaded, programsLoadError, programsUsageLoadError, refreshPrograms } =
    useProgramStore();
  const { refreshBeltLadders } = useBeltStore();
  const [ranks, setRanks] = useState<NonNullable<WorkflowReferenceChoices["promotion.rank_id"]>>({
    status: "loading",
    choices: [],
  });
  const [programRead, setProgramRead] = useState<"idle" | "loading" | "unavailable">("idle");
  const requestedPrograms = useRef(false);
  const sequence = useRef(0);
  const loadRanks = useCallback(() => {
    if (!owner.isCurrent()) return Promise.resolve();
    const request = ++sequence.current;
    return refreshBeltLadders()
      .then((result) => {
        if (request !== sequence.current || !owner.isCurrent()) return;
        setRanks({
          status: "ready",
          choices: result.ladders.flatMap((ladder) =>
            ladder.ranks.map((rank) => ({ id: rank.id, label: `${ladder.name}: ${rank.name}` })),
          ),
        });
      })
      .catch(() => {
        if (request === sequence.current && owner.isCurrent())
          setRanks((previous) => ({ ...previous, status: "unavailable" }));
      });
  }, [owner, refreshBeltLadders]);
  useEffect(() => {
    if (!preview) void loadRanks();
    return () => {
      sequence.current += 1;
    };
  }, [preview, loadRanks]);
  const programLifetime = useRef(0);
  useEffect(() => {
    programLifetime.current += 1;
    return () => {
      programLifetime.current += 1;
    };
  }, []);
  const loadPrograms = useCallback(async () => {
    if (!owner.isCurrent()) return;
    const generation = programLifetime.current;
    setProgramRead("loading");
    try {
      await refreshPrograms({ includeArchived: true, force: true });
      if (generation === programLifetime.current && owner.isCurrent()) setProgramRead("idle");
    } catch {
      if (generation === programLifetime.current && owner.isCurrent())
        setProgramRead("unavailable");
    }
  }, [owner, refreshPrograms]);
  useEffect(() => {
    if (!preview && !programsLoaded && !programsLoadError && !requestedPrograms.current) {
      requestedPrograms.current = true;
      void loadPrograms();
    }
    return () => {
      requestedPrograms.current = false;
    };
  }, [preview, programsLoaded, programsLoadError, loadPrograms]);
  const references: WorkflowReferenceChoices = preview
    ? workflowPreviewReferences
    : {
        "program.id": {
          status:
            programRead === "loading"
              ? "loading"
              : programsLoadError || programsUsageLoadError || programRead === "unavailable"
                ? "unavailable"
                : programsLoaded
                  ? "ready"
                  : "loading",
          choices: programs
            .filter((program) => !program.archived_at)
            .map((program) => ({ id: program.id, label: program.name })),
        },
        "promotion.rank_id": ranks,
      };
  const reloadRanks = useCallback(() => {
    setRanks((previous) => ({ ...previous, status: "loading" }));
    void loadRanks();
  }, [loadRanks]);
  const reloadPrograms = useCallback(() => {
    void loadPrograms();
  }, [loadPrograms]);
  return { references, reloadRanks, reloadPrograms };
}
