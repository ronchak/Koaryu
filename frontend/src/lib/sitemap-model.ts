import type { MetadataRoute } from "next";

type SitemapPage = {
  slug: string;
};

export function buildPublicSitemap({
  baseUrl,
  featurePages,
  publicContentLastModified,
  studioTypePages,
  useCasePages,
}: {
  baseUrl: string;
  featurePages: SitemapPage[];
  publicContentLastModified: Date;
  studioTypePages: SitemapPage[];
  useCasePages: SitemapPage[];
}): MetadataRoute.Sitemap {
  const staticRoutes = ["", "/explore", "/features", "/use-cases", "/about", "/privacy", "/terms"];
  const featureRoutes = featurePages.map((page) => `/features/${page.slug}`);
  const useCaseRoutes = useCasePages.map((page) => `/use-cases/${page.slug}`);
  const studioTypeRoutes = studioTypePages.map((page) => `/studio-types/${page.slug}`);

  return [...staticRoutes, ...featureRoutes, ...useCaseRoutes, ...studioTypeRoutes].map((route) => ({
    url: `${baseUrl}${route || "/"}`,
    lastModified: publicContentLastModified,
    changeFrequency: route === "" ? "weekly" : "monthly",
    priority: route === "" ? 1 : route === "/explore" || route === "/features" || route === "/use-cases" ? 0.8 : 0.7,
  }));
}
