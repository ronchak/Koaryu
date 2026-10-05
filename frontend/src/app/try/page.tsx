import type { Metadata } from "next";

import { tryPageContent } from "@/components/marketing/try/try-content";
import { TryPage } from "@/components/marketing/try/try-page";

const { meta } = tryPageContent;
const url = `https://koaryu.app${meta.path}`;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: url },
  openGraph: {
    title: meta.title,
    description: meta.description,
    url,
  },
  twitter: {
    card: "summary",
    title: meta.title,
    description: meta.description,
  },
};

export default TryPage;
