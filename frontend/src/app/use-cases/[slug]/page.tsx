import type { Metadata } from "next";
import {
  generateMarketingDetailMetadata,
  generateMarketingDetailStaticParams,
  renderMarketingDetailRoute,
} from "@/lib/marketing-detail-route";
import { useCaseMarketingDetailRouteConfig } from "@/lib/marketing-detail-route-configs";

export function generateStaticParams() {
  return generateMarketingDetailStaticParams(useCaseMarketingDetailRouteConfig.pages);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  return generateMarketingDetailMetadata({ params }, useCaseMarketingDetailRouteConfig);
}

export default async function UseCaseDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  return renderMarketingDetailRoute({ params }, useCaseMarketingDetailRouteConfig);
}
