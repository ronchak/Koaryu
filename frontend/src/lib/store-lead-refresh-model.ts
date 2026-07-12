import type { BeginLiveAuthRequest } from "@/lib/store-action-types";
import type { Lead } from "@/types";

export async function refreshLiveLeadDataset({
  beginLiveAuthRequest,
  fetchLeads,
  setLeads,
  setLeadsLoaded,
  setLeadsLoadError,
}: {
  beginLiveAuthRequest: BeginLiveAuthRequest;
  fetchLeads: (token: string) => Promise<Lead[]>;
  setLeads: (leads: Lead[]) => void;
  setLeadsLoaded: (loaded: boolean) => void;
  setLeadsLoadError: (error: string | null) => void;
}): Promise<Lead[]> {
  const request = beginLiveAuthRequest();
  setLeadsLoadError(null);

  try {
    const result = await fetchLeads(request.token);
    if (!request.isCurrent()) {
      return result;
    }
    setLeads(result);
    setLeadsLoaded(true);
    return result;
  } catch (error) {
    if (request.isCurrent()) {
      setLeadsLoadError(error instanceof Error ? error.message : "Leads could not be loaded.");
      setLeadsLoaded(false);
    }
    throw error;
  }
}
