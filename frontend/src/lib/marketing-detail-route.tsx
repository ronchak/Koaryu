import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FeatureDetailPage } from "@/components/marketing/feature-pages";
import { WorkflowDetailPage } from "@/components/marketing/workflow-pages";
import { BreadcrumbJsonLd, PageStructuredData } from "@/components/marketing/public-pages";
import { APP_NAME } from "@/lib/constants";
import { getMarketingPageByRef } from "@/lib/marketing-pages";
import {
  buildMarketingDetailMetadata,
  buildMarketingDetailStructuredData,
  publicMarketingUrl,
  relatedMarketingPages,
  type MarketingDetailRouteConfig,
} from "@/lib/marketing-detail-route-model";

export {
  generateMarketingDetailStaticParams,
  type MarketingDetailRouteConfig,
} from "@/lib/marketing-detail-route-model";

interface MarketingDetailRouteProps {
  params: Promise<{ slug: string }>;
}

export async function generateMarketingDetailMetadata(
  { params }: MarketingDetailRouteProps,
  config: MarketingDetailRouteConfig,
): Promise<Metadata> {
  const { slug } = await params;
  const page = config.getPage(slug);

  if (!page) {
    return {};
  }

  return buildMarketingDetailMetadata(page);
}

export async function renderMarketingDetailRoute(
  { params }: MarketingDetailRouteProps,
  config: MarketingDetailRouteConfig,
) {
  const { slug } = await params;
  const page = config.getPage(slug);

  if (!page) {
    notFound();
  }

  const pageUrl = publicMarketingUrl(page.href);
  const relatedPages = relatedMarketingPages(page, getMarketingPageByRef);
  const leafCrumbName = config.leafCrumbName?.(page) ?? page.eyebrow;
  const DetailPage = page.kind === "feature" ? FeatureDetailPage : WorkflowDetailPage;

  return (
    <>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: config.parentCrumb.name, url: publicMarketingUrl(config.parentCrumb.path) },
          { name: leafCrumbName, url: pageUrl },
        ]}
      />
      <PageStructuredData data={buildMarketingDetailStructuredData(page, APP_NAME)} />
      <DetailPage page={page} relatedPages={relatedPages} />
    </>
  );
}
