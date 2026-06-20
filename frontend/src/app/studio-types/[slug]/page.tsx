import type { Metadata } from "next";
import {
  generateMarketingDetailMetadata,
  generateMarketingDetailStaticParams,
  renderMarketingDetailRoute,
} from "@/lib/marketing-detail-route";
import { studioTypeMarketingDetailRouteConfig } from "@/lib/marketing-detail-route-configs";

export function generateStaticParams() {
  return generateMarketingDetailStaticParams(studioTypeMarketingDetailRouteConfig.pages);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return generateMarketingDetailMetadata({ params }, studioTypeMarketingDetailRouteConfig);
}

export default async function StudioTypeDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  return renderMarketingDetailRoute({ params }, studioTypeMarketingDetailRouteConfig);
}
