import type { Metadata } from "next";
import { BreadcrumbJsonLd, PageStructuredData } from "@/components/marketing/public-pages";
import { FeatureIndexPage } from "@/components/marketing/feature-pages";
import {
  APP_NAME,
  PUBLIC_PLATFORM_PRICE,
  formatPublicPlatformPrice,
  publicPlatformPriceAmount,
} from "@/lib/constants";

const description =
  "Compare Koaryu's student records, leads, schedules, rank tracking, staff access, and billing limits for an independent martial arts studio.";

export const metadata: Metadata = {
  title: "Martial Arts Studio Software Features | Koaryu",
  description,
  alternates: { canonical: "https://koaryu.app/features" },
  openGraph: {
    title: "Martial Arts Studio Software Features | Koaryu",
    description,
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
          description,
          offers: {
            "@type": "Offer",
            price: publicPlatformPriceAmount(),
            priceCurrency: PUBLIC_PLATFORM_PRICE.currency,
            category: "Subscription",
            description: `${formatPublicPlatformPrice()} USD per month per studio for the Koaryu platform. Tuition collection requires separate studio activation and is not generally available.`,
          },
        }}
      />
      <FeatureIndexPage />
    </>
  );
}
