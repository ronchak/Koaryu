import type { EligibilityEntry } from "@/types";

type WritableRef<T> = { current: T };

export function invalidateEligibilityAfterStudentMutation({
  clearCurrentEligibility,
  currentLadderIdRef,
  eligibilityCacheRef,
  onRefreshError,
  refreshEligibility,
}: {
  clearCurrentEligibility: () => void;
  currentLadderIdRef: WritableRef<string | null>;
  eligibilityCacheRef: WritableRef<Record<string, EligibilityEntry[]>>;
  onRefreshError: (error: unknown) => void;
  refreshEligibility: (
    ladderId: string,
    options: { force: boolean }
  ) => Promise<EligibilityEntry[]>;
}) {
  eligibilityCacheRef.current = {};
  clearCurrentEligibility();

  const ladderId = currentLadderIdRef.current;
  if (!ladderId) return;

  void refreshEligibility(ladderId, { force: true }).catch(onRefreshError);
}
