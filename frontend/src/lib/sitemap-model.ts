import type { MetadataRoute } from "next";

type SitemapPage = {
  slug: string;
};

export function buildPublicSitemap({
  baseUrl,
  featurePages,
  publicContentLastModified,
  useCasePages,
}: {
  baseUrl: string;
  featurePages: SitemapPage[];
  publicContentLastModified: Date;
  useCasePages: SitemapPage[];
}): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/features", "/use-cases", "/privacy", "/terms"];
  const featureRoutes = featurePages.map((page) => `/features/${page.slug}`);
  const useCaseRoutes = useCasePages.map((page) => `/use-cases/${page.slug}`);

  return [...staticRoutes, ...featureRoutes, ...useCaseRoutes].map((route) => ({
    url: `${baseUrl}${route || "/"}`,
    lastModified: publicContentLastModified,
    changeFrequency: route === "" ? "weekly" : "monthly",
    priority: route === "" ? 1 : route === "/features" || route === "/use-cases" ? 0.8 : 0.7,
  }));
}
