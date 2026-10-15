import * as records from "./mock-data.ts";
import * as studio from "./preview-studio-data.ts";
import * as billing from "./billing-preview-data.ts";
import { buildPreviewHomePayload } from "./dashboard/preview-home-payload.ts";

// This module and its fixtures are reachable only through the preview build gate.
export const previewAdapter = {
  ...records,
  ...studio,
  ...billing,
  currentUser: { id: "preview-user", email: "demo@koaryu.local", full_name: "Demo User" },
  buildPreviewHomePayload: (input: Parameters<typeof buildPreviewHomePayload>[0]) =>
    buildPreviewHomePayload(input, { ...records, ...studio }),
};
