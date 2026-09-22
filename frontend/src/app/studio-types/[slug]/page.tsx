import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { buildMarketingDetailMetadata } from "@/lib/marketing-detail-route-model";
import { getFeaturePage, getStudioTypePage, studioTypePages } from "@/lib/marketing-pages";

export function generateStaticParams() {
  return studioTypePages.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!getStudioTypePage(slug)) return {};
  return buildMarketingDetailMetadata(getFeaturePage("student-management")!);
}

export default async function StudioTypeDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!getStudioTypePage(slug)) notFound();
  permanentRedirect("/features/student-management#families");
}
