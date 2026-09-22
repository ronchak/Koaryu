import type { Metadata } from "next";
import { BreadcrumbJsonLd, PageStructuredData } from "@/components/marketing/public-pages";
import { WorkflowIndexPage } from "@/components/marketing/workflow-pages";
import { APP_NAME } from "@/lib/constants";

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
          description: "Practical workflows for martial arts studios switching to Koaryu.",
          url: "https://koaryu.app/use-cases",
        }}
      />
      <WorkflowIndexPage />
    </>
  );
}
