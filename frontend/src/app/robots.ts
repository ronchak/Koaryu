import type { MetadataRoute } from "next";
import { buildRobotsMetadata } from "@/lib/auth-indexing";

export default function robots(): MetadataRoute.Robots {
  return buildRobotsMetadata();
}
