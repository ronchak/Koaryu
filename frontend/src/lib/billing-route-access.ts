import type { BillingSystemStatus, StaffRoleName } from "@/types";

export function isBillingRoute(pathname: string): boolean {
  return pathname === "/billing" || pathname.startsWith("/billing/");
}

export function canAccessBillingRoute(
  pathname: string,
  role: StaffRoleName | null | undefined
): boolean {
  if (!isBillingRoute(pathname)) {
    return false;
  }
  if (
    pathname === "/billing/connect/refresh"
    || pathname.startsWith("/billing/connect/refresh/")
  ) {
    return role === "admin";
  }
  if (pathname === "/billing/connect" || pathname.startsWith("/billing/connect/")) {
    return role === "admin";
  }
  return role === "admin" || role === "front_desk";
}

export function hasConnectOnboardingCapability(
  status: Pick<BillingSystemStatus, "workflow_capabilities"> | null,
): boolean {
  return Boolean(
    status?.workflow_capabilities.some(
      ({ enabled, workflow_id }) => enabled && workflow_id === "connect.onboarding"
    )
  );
}
