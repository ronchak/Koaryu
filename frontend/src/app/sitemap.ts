import type { MetadataRoute } from "next";
import { featurePages, useCasePages } from "@/lib/marketing-pages";
import { buildPublicSitemap } from "@/lib/sitemap-model";

const baseUrl = "https://koaryu.app";
const publicContentLastModified = new Date("2026-09-22T00:00:00.000Z");

export default function sitemap(): MetadataRoute.Sitemap {
  return buildPublicSitemap({
    baseUrl,
    featurePages,
    publicContentLastModified,
    useCasePages,
  });
}
