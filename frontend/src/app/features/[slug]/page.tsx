import type { Metadata } from "next";
import {
  generateMarketingDetailMetadata,
  generateMarketingDetailStaticParams,
  renderMarketingDetailRoute,
} from "@/lib/marketing-detail-route";
import { featureMarketingDetailRouteConfig } from "@/lib/marketing-detail-route-configs";

export function generateStaticParams() {
  return generateMarketingDetailStaticParams(featureMarketingDetailRouteConfig.pages);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return generateMarketingDetailMetadata({ params }, featureMarketingDetailRouteConfig);
}

export default async function FeatureDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  return renderMarketingDetailRoute({ params }, featureMarketingDetailRouteConfig);
}
