import type { Metadata } from "next";
import {
  BreadcrumbJsonLd,
  MarketingIndexPage,
  PageStructuredData,
} from "@/components/marketing/public-pages";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";
import { featurePages } from "@/lib/marketing-pages";

export const metadata: Metadata = {
  title: "Martial Arts Studio Software Features | Koaryu",
  description:
    "Explore Koaryu features for martial arts student management, belt tracking, attendance, leads, billing, and retention workflows.",
  alternates: { canonical: "https://koaryu.app/features" },
  openGraph: {
    title: "Martial Arts Studio Software Features | Koaryu",
    description:
      "Feature pages for Koaryu's martial-arts-native studio operating system.",
    url: "https://koaryu.app/features",
  },
};

export default function FeaturesPage() {
  return (
    <>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: "Features", url: "https://koaryu.app/features" },
        ]}
      />
      <PageStructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: APP_NAME,
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          description: APP_DESCRIPTION,
          offers: {
            "@type": "Offer",
            price: "27",
            priceCurrency: "USD",
            category: "Subscription",
          },
        }}
      />
      <MarketingIndexPage
        eyebrow="Koaryu features"
        title="The operating pieces behind a calmer martial arts studio."
        description="Explore the Koaryu workflows owners actually compare: student CRM, belt progression, attendance, and billing visibility."
        pages={featurePages}
        sectionTitle="Feature map"
        basePath="/features"
        listHeading="Product areas owners can compare"
        listDescription="Each feature is specific, internally linked, and grounded in a real studio workflow rather than generic software claims."
      />
    </>
  );
}
