export type DatasetLoadStatus = "idle" | "loading" | "ready" | "error";

export type RequiredDataset = {
  error: string | null;
  label: string;
  status: DatasetLoadStatus;
};

export type PageDatasetReadiness = {
  error: string | null;
  status: "loading" | "ready" | "error";
};

export async function loadIndependentDataset<T>({
  context,
  fallback,
  load,
  onError,
  onLoaded,
}: {
  context: Promise<unknown>;
  fallback: T;
  load: Promise<T>;
  onError: (error: unknown) => void;
  onLoaded: (value: T) => void;
}) {
  try {
    const [, value] = await Promise.all([context, load]);
    onLoaded(value);
    return value;
  } catch (error) {
    onError(error);
    return fallback;
  }
}

export function loadedDataset({
  error,
  label,
  loaded,
}: {
  error: string | null;
  label: string;
  loaded: boolean;
}): RequiredDataset {
  if (error) {
    return { error, label, status: "error" };
  }

  return {
    error: null,
    label,
    status: loaded ? "ready" : "loading",
  };
}

export function resolvePageDatasetReadiness(
  requiredDatasets: RequiredDataset[]
): PageDatasetReadiness {
  const failedDataset = requiredDatasets.find((dataset) => dataset.status === "error");
  if (failedDataset) {
    return {
      error: `${failedDataset.label}: ${failedDataset.error || "could not be loaded"}`,
      status: "error",
    };
  }

  if (requiredDatasets.some((dataset) => dataset.status !== "ready")) {
    return { error: null, status: "loading" };
  }

  return { error: null, status: "ready" };
}

export function dashboardSummaryDataset({
  hasSummary,
  isPreviewMode,
  loaded,
}: {
  hasSummary: boolean;
  isPreviewMode: boolean;
  loaded: boolean;
}): RequiredDataset {
  if (isPreviewMode || hasSummary) {
    return { error: null, label: "Dashboard summary", status: "ready" };
  }

  if (loaded) {
    return {
      error: "could not be loaded. Reload the page to retry.",
      label: "Dashboard summary",
      status: "error",
    };
  }

  return { error: null, label: "Dashboard summary", status: "loading" };
}

export function eligibilityDataset({
  currentLadderId,
  error,
  loadedLadderId,
  pendingLadderId,
}: {
  currentLadderId: string | null;
  error: string | null;
  loadedLadderId: string | null;
  pendingLadderId: string | null;
}): RequiredDataset {
  if (error) {
    return { error, label: "Belt eligibility", status: "error" };
  }
  if (!currentLadderId) {
    return { error: null, label: "Belt eligibility", status: "ready" };
  }
  if (loadedLadderId === currentLadderId && pendingLadderId === null) {
    return { error: null, label: "Belt eligibility", status: "ready" };
  }
  return { error: null, label: "Belt eligibility", status: "loading" };
}
