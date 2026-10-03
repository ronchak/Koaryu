import type { Metadata } from "next";
import { BreadcrumbJsonLd, PageStructuredData } from "@/components/marketing/public-pages";
import { WorkflowIndexPage } from "@/components/marketing/workflow-pages";
import { APP_NAME } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Studio Workflow Guides | Koaryu",
  description:
    "Prepare a roster CSV, review an attendance gap, follow up on a trial, check tuition records, or build a belt-test shortlist with worked Koaryu guides.",
  alternates: { canonical: "https://koaryu.app/use-cases" },
  openGraph: {
    title: "Studio Workflow Guides | Koaryu",
    description:
      "Worked guides for student imports, attendance-gap reviews, trial follow-up, tuition records, and belt-test preparation.",
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
            "Worked guides for roster imports, attendance gaps, lead conversion, tuition records, and belt-test reviews.",
          url: "https://koaryu.app/use-cases",
        }}
      />
      <WorkflowIndexPage />
    </>
  );
}
