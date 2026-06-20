import type { Metadata, MetadataRoute } from "next";

export const AUTH_NOINDEX_METADATA: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export const PRIVATE_ROUTE_DISALLOW_PATHS = [
  "/api",
  "/account",
  "/automations",
  "/belt-tracker",
  "/billing",
  "/dashboard",
  "/help",
  "/leads",
  "/login",
  "/onboarding",
  "/reports",
  "/reset-password",
  "/schedule",
  "/settings",
  "/signup",
  "/students",
  "/subscription-required",
] as const;

export function buildRobotsMetadata(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...PRIVATE_ROUTE_DISALLOW_PATHS],
    },
    sitemap: "https://koaryu.app/sitemap.xml",
  };
}
