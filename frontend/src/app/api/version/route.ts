import { getDeploymentMetadata } from "../../../lib/deployment-metadata.ts";
import { PRODUCT_RELEASE_VERSION } from "../../../lib/release-identity.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    product_version: PRODUCT_RELEASE_VERSION,
    ...getDeploymentMetadata(),
  }, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
