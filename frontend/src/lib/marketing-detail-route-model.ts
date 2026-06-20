import type { Metadata } from "next";
import type { MarketingPage, MarketingPageRef } from "./marketing-pages";

export type MarketingPageResolver = (ref: MarketingPageRef) => MarketingPage | undefined;
export type MarketingDetailBasePath = "/features" | "/use-cases" | "/explore";

export interface MarketingDetailCopy {
  detailEyebrow?: string;
  detailHeading?: string;
  detailDescription?: string;
  relatedEyebrow?: string;
  relatedHeading?: string;
  relatedActionLabel?: string;
}

export interface MarketingDetailRouteConfig {
  pages: MarketingPage[];
  getPage: (slug: string) => MarketingPage | undefined;
  parentCrumb: {
    name: string;
    path: string;
  };
  basePath: MarketingDetailBasePath;
  leafCrumbName?: (page: MarketingPage) => string;
  detailCopy?: MarketingDetailCopy;
}

export function publicMarketingUrl(path: string) {
  return `https://koaryu.app${path}`;
}

export function relatedMarketingPages(page: MarketingPage, resolvePage: MarketingPageResolver) {
  return page.related
    .map(resolvePage)
    .filter((candidate): candidate is MarketingPage => Boolean(candidate));
}

export function generateMarketingDetailStaticParams(pages: MarketingPage[]) {
  return pages.map((page) => ({ slug: page.slug }));
}

export function buildMarketingDetailMetadata(page: MarketingPage): Metadata {
  const url = publicMarketingUrl(page.href);

  return {
    title: page.metaTitle,
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      title: page.metaTitle,
      description: page.description,
      url,
    },
  };
}

export function buildMarketingDetailStructuredData(page: MarketingPage, appName: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: page.title,
    description: page.description,
    url: publicMarketingUrl(page.href),
    isPartOf: {
      "@type": "WebSite",
      name: appName,
      url: "https://koaryu.app/",
    },
  };
}
