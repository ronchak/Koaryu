import releaseIdentity from "../../../backend/release.json" with { type: "json" };

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!SEMANTIC_VERSION_PATTERN.test(releaseIdentity.product_version)) {
  throw new Error("backend/release.json must contain a semantic product_version.");
}

export const PRODUCT_RELEASE_VERSION = releaseIdentity.product_version;
