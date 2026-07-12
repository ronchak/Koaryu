import { getDeploymentMetadata } from "../../../lib/deployment-metadata.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getDeploymentMetadata(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
