import {
  featurePages,
  getFeaturePage,
  getStudioTypePage,
  getUseCasePage,
  studioTypePages,
  useCasePages,
} from "./marketing-pages";
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
  parentCrumb: { name: "Use Cases", path: "/use-cases" },
  basePath: "/features",
  detailCopy: {
    detailEyebrow: "Operating pattern",
    detailHeading: "A practical workflow for the week the owner is already living.",
    detailDescription:
      "Koaryu connects the records, signals, and next actions around this moment so the studio can respond with less interpretation work.",
    relatedEyebrow: "Relevant product areas",
    relatedHeading: "The Koaryu modules that support this workflow",
    relatedActionLabel: "View features",
  },
} satisfies MarketingDetailRouteConfig;

export const studioTypeMarketingDetailRouteConfig = {
  pages: studioTypePages,
  getPage: getStudioTypePage,
  parentCrumb: { name: "Explore", path: "/explore" },
  leafCrumbName: (page) => page.title,
  basePath: "/explore",
  detailCopy: {
    detailEyebrow: "Studio fit",
    detailHeading:
      "A practical path for schools where families, trials, ranks, and tuition all meet at the front desk.",
    detailDescription:
      "This page connects Koaryu to a familiar studio shape without assuming every family-focused school runs the same way.",
    relatedEyebrow: "Useful next pages",
    relatedHeading: "Keep exploring the workflows behind this studio path",
    relatedActionLabel: "Back to Explore",
  },
} satisfies MarketingDetailRouteConfig;

export const marketingDetailRouteConfigs = [
  featureMarketingDetailRouteConfig,
  useCaseMarketingDetailRouteConfig,
  studioTypeMarketingDetailRouteConfig,
] as const;
