import { featurePages, getFeaturePage, getUseCasePage, useCasePages } from "./marketing-pages";
import type { MarketingDetailRouteConfig } from "./marketing-detail-route-model";

export const featureMarketingDetailRouteConfig = {
  pages: featurePages,
  getPage: getFeaturePage,
  parentCrumb: { name: "Features", path: "/features" },
  basePath: "/features",
} satisfies MarketingDetailRouteConfig;

export const useCaseMarketingDetailRouteConfig = {
  pages: useCasePages,
  getPage: getUseCasePage,
  parentCrumb: { name: "Workflows", path: "/use-cases" },
  basePath: "/use-cases",
} satisfies MarketingDetailRouteConfig;
