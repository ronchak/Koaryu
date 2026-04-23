import type { MetadataRoute } from "next";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/constants";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${APP_NAME} — Martial Arts Studio OS`,
    short_name: APP_NAME,
    description:
      `${APP_DESCRIPTION} Student CRM, belt progression, scheduling, billing, and more.`,
    start_url: "/",
    display: "standalone",
    background_color: "#0B0D10",
    theme_color: "#0B0D10",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
