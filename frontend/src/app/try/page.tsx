import { SOCIAL_PREVIEW_IMAGE } from "@/lib/social-preview";
import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

import { tryPageContent } from "@/components/marketing/try/try-content";
import { TryPage } from "@/components/marketing/try/try-page";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

const { meta } = tryPageContent;
const url = `https://koaryu.app${meta.path}`;

export const metadata: Metadata = {
  title: meta.title,
  description: meta.description,
  alternates: { canonical: url },
  openGraph: {
    images: [SOCIAL_PREVIEW_IMAGE],
    title: meta.title,
    description: meta.description,
    url,
  },
  twitter: {
    card: "summary_large_image",
    images: [SOCIAL_PREVIEW_IMAGE],
    title: meta.title,
    description: meta.description,
  },
};

export default function TryRoute() {
  return (
    <div className={jetbrainsMono.variable}>
      <TryPage />
    </div>
  );
}
