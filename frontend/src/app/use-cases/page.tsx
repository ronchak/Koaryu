import type { Metadata } from "next";
import {
  BreadcrumbJsonLd,
  MarketingIndexPage,
  PageStructuredData,
} from "@/components/marketing/public-pages";
import { APP_NAME } from "@/lib/constants";
import { useCasePages } from "@/lib/marketing-pages";

export const metadata: Metadata = {
  title: "Martial Arts Studio Use Cases | Koaryu",
  description:
    "Practical Koaryu use cases for moving from spreadsheets, improving student retention, and running a calmer independent martial arts studio.",
  alternates: { canonical: "https://koaryu.app/use-cases" },
  openGraph: {
    title: "Martial Arts Studio Use Cases | Koaryu",
    description:
      "Practical operating workflows for independent martial arts studios evaluating Koaryu.",
    url: "https://koaryu.app/use-cases",
  },
};

export default function UseCasesPage() {
  return (
    <>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: "Use Cases", url: "https://koaryu.app/use-cases" },
        ]}
      />
      <PageStructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: "Koaryu use cases",
          description:
            "Practical workflows for martial arts studios switching to Koaryu.",
          url: "https://koaryu.app/use-cases",
        }}
      />
      <MarketingIndexPage
        eyebrow="Use cases"
        title="Operating moments where Koaryu earns its place in the studio."
        description="From trial follow-up to tuition cleanup, these are the situations where an owner needs a calmer system before the next class starts."
        pages={useCasePages}
        sectionTitle="Studio workflows"
        basePath="/use-cases"
        listHeading="Start with the pressure point you recognize"
        listDescription="Each workflow is written around a real owner problem: cleaning up records, keeping families engaged, preparing tests, and knowing what needs attention today."
      />
    </>
  );
}
