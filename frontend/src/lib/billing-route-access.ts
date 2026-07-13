import type { StaffRoleName } from "@/types";

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
  if (pathname === "/billing/connect" || pathname.startsWith("/billing/connect/")) {
    return role === "admin";
  }
  return role === "admin" || role === "front_desk";
}
