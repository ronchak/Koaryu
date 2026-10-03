import { useCallback, useMemo, useRef, useState } from "react";

import {
  canCommitLiveMutation,
  type BeginLiveAuthRequest,
  type StoreRef,
} from "@/lib/store-action-types";
import type { ResourceScope } from "@/lib/store-resource-scope";
import type { LeadStage } from "@/types";

export interface LeadFollowUpCommand {
  operation_id: string;
  next_stage: LeadStage | null;
}

export type LeadFollowUpRecovery = "unknown" | "confirmed";

// A handle for one attempt. Only the handle currently stored for its row may
// hold or release that row; a retry replaces the handle but keeps the command.
export interface LeadOperation {
  readonly leadId: string;
  readonly followUp: LeadFollowUpCommand | null;
  readonly previousRecovery: LeadFollowUpRecovery | null;
}

export interface LeadOperationView {
  followUp: LeadFollowUpCommand | null;
  recovery: LeadFollowUpRecovery | null;
  isCurrent: () => boolean;
}

export interface LeadOperations {
  views: ReadonlyMap<string, LeadOperationView>;
  reserve: (leadId: string, followUp?: LeadFollowUpCommand) => LeadOperation | null;
  resumeFollowUp: (leadId: string) => LeadOperation | null;
  current: (leadId: string) => LeadOperation | null;
  hold: (operation: LeadOperation, recovery: LeadFollowUpRecovery) => boolean;
  release: (operation: LeadOperation) => boolean;
}

interface Reservation {
  operation: LeadOperation;
  recovery: LeadFollowUpRecovery | null;
  isCurrent: () => boolean;
}

interface UseLeadOperationReservationsOptions {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  isPreviewMode: boolean;
  leadMutationScopeRef: StoreRef<ResourceScope>;
}

// One reservation per lead row for the provider's lifetime. The leads page may
// unmount and remount while an outcome is unknown; the reservation and its exact
// follow-up command stay here. Token renewal keeps a reservation, while sign-out,
// user/studio/role replacement or a studio data reset fences it.
export function useLeadOperationReservations({
  beginLiveAuthRequest,
  isPreviewMode,
  leadMutationScopeRef,
}: UseLeadOperationReservationsOptions): LeadOperations {
  const reservationsRef = useRef(new Map<string, Reservation>());
  const [views, setViews] = useState<ReadonlyMap<string, LeadOperationView>>(() => new Map());

  const publish = useCallback(() => {
    const next = new Map<string, LeadOperationView>();
    for (const [leadId, reservation] of reservationsRef.current) {
      if (!reservation.isCurrent()) {
        reservationsRef.current.delete(leadId);
        continue;
      }
      next.set(leadId, {
        followUp: reservation.operation.followUp,
        recovery: reservation.recovery,
        isCurrent: reservation.isCurrent,
      });
    }
    setViews(next);
  }, []);

  const currentReservation = useCallback((leadId: string) => {
    const reservation = reservationsRef.current.get(leadId);
    return reservation?.isCurrent() ? reservation : null;
  }, []);

  const reserve = useCallback(
    (leadId: string, followUp?: LeadFollowUpCommand) => {
      if (currentReservation(leadId)) return null;
      const scope = leadMutationScopeRef.current;
      let isCurrent = () => leadMutationScopeRef.current === scope;
      if (!isPreviewMode) {
        let request;
        try {
          request = beginLiveAuthRequest();
        } catch {
          return null;
        }
        isCurrent = () => leadMutationScopeRef.current === scope && canCommitLiveMutation(request);
        if (!isCurrent()) return null;
      }
      const operation: LeadOperation = {
        leadId,
        followUp: followUp ?? null,
        previousRecovery: null,
      };
      reservationsRef.current.set(leadId, { operation, recovery: null, isCurrent });
      publish();
      return operation;
    },
    [beginLiveAuthRequest, currentReservation, isPreviewMode, leadMutationScopeRef, publish],
  );

  // A retry keeps the original owner scope and exact command. Only a settled
  // recovery can be resumed, so concurrent retries cannot both dispatch.
  const resumeFollowUp = useCallback(
    (leadId: string) => {
      const reservation = currentReservation(leadId);
      const followUp = reservation?.operation.followUp;
      if (!reservation?.recovery || !followUp) return null;
      const operation: LeadOperation = {
        leadId,
        followUp,
        previousRecovery: reservation.recovery,
      };
      reservationsRef.current.set(leadId, { ...reservation, operation, recovery: null });
      publish();
      return operation;
    },
    [currentReservation, publish],
  );

  const current = useCallback(
    (leadId: string) => currentReservation(leadId)?.operation ?? null,
    [currentReservation],
  );

  const hold = useCallback(
    (operation: LeadOperation, recovery: LeadFollowUpRecovery) => {
      const reservation = currentReservation(operation.leadId);
      if (reservation?.operation !== operation || !operation.followUp) return false;
      reservation.recovery = recovery;
      publish();
      return true;
    },
    [currentReservation, publish],
  );

  const release = useCallback(
    (operation: LeadOperation) => {
      if (currentReservation(operation.leadId)?.operation !== operation) return false;
      reservationsRef.current.delete(operation.leadId);
      publish();
      return true;
    },
    [currentReservation, publish],
  );

  return useMemo(
    () => ({ views, reserve, resumeFollowUp, current, hold, release }),
    [views, reserve, resumeFollowUp, current, hold, release],
  );
}
