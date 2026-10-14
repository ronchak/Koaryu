import type { previewAdapter } from "./preview-adapter";

export type PreviewAdapter = typeof previewAdapter;
let adapter: PreviewAdapter | undefined;
let pending: Promise<PreviewAdapter> | undefined;

export function loadPreviewAdapter(): Promise<PreviewAdapter> {
  // Keep the literal build-time flag around import(): live builds omit the chunk.
  if (process.env.NEXT_PUBLIC_PREVIEW_MODE === "true") {
    return (pending ??= import("./preview-adapter").then((module) => {
      adapter = module.previewAdapter;
      return adapter;
    }));
  }
  throw new Error("Preview data is unavailable in live mode.");
}

export function getPreviewAdapter(): PreviewAdapter {
  if (!adapter) throw new Error("Preview data must load before preview initialization.");
  return adapter;
}
