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
  requiredDatasets: RequiredDataset[],
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
