import { expect, test } from "@playwright/test";
import { featurePages, useCasePages } from "../src/lib/marketing-pages";
import { SOCIAL_PREVIEW_IMAGE } from "../src/lib/social-preview";

const origin = process.env.KOARYU_E2E_FRONTEND_URL || "http://127.0.0.1:4000";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Social preview checks may run only against loopback.");
}

const routes = [
  "/",
  "/features",
  "/use-cases",
  "/privacy",
  "/terms",
  ...[...featurePages, ...useCasePages].map((page) => page.href),
];

function metadataValues(head: string, name: string) {
  return [...head.matchAll(/<meta\s[^>]*>/gi)]
    .map(([tag]) =>
      Object.fromEntries(
        [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
      ),
    )
    .filter((attributes) => attributes.name === name || attributes.property === name)
    .map((attributes) => attributes.content);
}

for (const userAgent of ["LinkedInBot/1.0", "Twitterbot/1.0", "facebookexternalhit/1.1"]) {
  test(`${userAgent} receives complete social images in the initial HTML head`, async ({
    request,
  }) => {
    const advertisedImages = new Set<string>();
    for (const path of routes) {
      // Read the HTTP response directly: no hydration, browser JavaScript, or sign-in.
      const response = await request.get(`${origin}${path}`, {
        headers: { "User-Agent": userAgent },
        maxRedirects: 0,
      });
      expect(response.status(), path).toBe(200);
      const html = await response.text();
      const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1];
      expect(head, `${path} has an initial head`).toBeTruthy();
      for (const name of ["og:image", "twitter:image"]) {
        const images = metadataValues(head!, name);
        expect(images, `${path}: ${name}`).toHaveLength(1);
        const image = new URL(images[0]);
        expect(`${image.origin}${image.pathname}`, `${path}: ${name}`).toBe(
          SOCIAL_PREVIEW_IMAGE.url,
        );
        // File-based metadata adds Next.js's content hash on the root route.
        expect(image.search).toMatch(/^(\?[a-f0-9]+)?$/);
        advertisedImages.add(`${image.pathname}${image.search}`);
      }
      expect(metadataValues(head!, "og:image:width"), path).toEqual(["1200"]);
      expect(metadataValues(head!, "og:image:height"), path).toEqual(["630"]);
      expect(metadataValues(head!, "og:image:type"), path).toEqual(["image/png"]);
      expect(metadataValues(head!, "og:image:alt"), path).toEqual([SOCIAL_PREVIEW_IMAGE.alt]);
      expect(metadataValues(head!, "twitter:image:alt"), path).toEqual([SOCIAL_PREVIEW_IMAGE.alt]);
      expect(metadataValues(head!, "twitter:card"), path).toEqual(["summary_large_image"]);
    }
    for (const imagePath of advertisedImages) {
      const response = await request.get(`${origin}${imagePath}`, {
        headers: { "User-Agent": userAgent },
        maxRedirects: 0,
      });
      expect(response.status(), imagePath).toBe(200);
      expect(response.headers()["content-type"], imagePath).toContain("image/png");
      const png = await response.body();
      expect(png.readUInt32BE(16), imagePath).toBe(1200);
      expect(png.readUInt32BE(20), imagePath).toBe(630);
    }
  });
}

test("the social PNG is publicly readable without auth or redirects", async ({ request }) => {
  const path = new URL(SOCIAL_PREVIEW_IMAGE.url).pathname;
  const response = await request.get(`${origin}${path}`, {
    headers: { "User-Agent": "LinkedInBot/1.0" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
  const png = await response.body();
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
});
