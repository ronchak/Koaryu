import type { StaffRoleName } from "@/types";

export const BILLING_BOUNDARY_MESSAGE =
  "Koaryu supports external-only student billing attachments, payer-level external payments, and read-based invoice reconciliation. Live Stripe writes are currently disabled.";

export function canManageRoutineBilling(
  role: StaffRoleName | null | undefined
): boolean {
  return role === "admin" || role === "front_desk";
}

export function areProviderMutationsEnabled(isPreviewMode: boolean): boolean {
  return isPreviewMode;
}
