import type { BeginLiveAuthRequest, StoreRef } from "@/lib/store-action-types";
import type { ResourceScope } from "@/lib/store-resource-scope";
import type { Lead } from "@/types";

export async function refreshLiveLeadDataset({
  beginLiveAuthRequest,
  scopeRef,
  fetchLeads,
  setLeads,
  setLeadsLoaded,
  setLeadsLoadError,
}: {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  scopeRef: StoreRef<ResourceScope>;
  fetchLeads: (token: string) => Promise<Lead[]>;
  setLeads: (leads: Lead[]) => void;
  setLeadsLoaded: (loaded: boolean) => void;
  setLeadsLoadError: (error: string | null) => void;
}): Promise<Lead[]> {
  const scope = scopeRef.current;
  const sequence = ++scope.sequence;
  const ownsRead = () => scopeRef.current === scope && scope.sequence === sequence;
  setLeadsLoadError(null);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (scope.pending) await scope.settled;
    if (!ownsRead()) return [];
    const request = beginLiveAuthRequest();
    const revision = scope.revision;
    try {
      const result = await fetchLeads(request.token);
      if (!ownsRead()) return result;
      if (request.canRetryAfterTokenChange?.()) continue;
      if (!request.isCurrent()) return result;
      if (revision !== scope.revision || scope.pending) continue;
      setLeads(result);
      setLeadsLoaded(true);
      return result;
    } catch (error) {
      if (ownsRead() && request.canRetryAfterTokenChange?.()) continue;
      if (ownsRead() && request.isCurrent()) {
        if (revision !== scope.revision || scope.pending) continue;
        setLeadsLoadError(error instanceof Error ? error.message : "Leads could not be loaded.");
        // A failed refresh does not erase previously loaded records.
      }
      throw error;
    }
  }
  const error = new Error("Leads changed while loading. Refresh to see the latest records.");
  if (ownsRead()) setLeadsLoadError(error.message);
  throw error;
}
