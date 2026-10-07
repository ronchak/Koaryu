import { ImageResponse } from "next/og";

export const alt = "Koaryu — Martial Arts Studio OS";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-static";

// Rendered once at build time with Next.js's bundled font. No remote assets,
// credentials, request data, or runtime image-generation service are needed.
export default function SocialPreviewImage() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background: "#F7F3E9",
        color: "#2D2212",
        padding: 48,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          border: "1px solid #C6B183",
          borderRadius: 8,
          padding: 32,
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ width: 100, height: 5, background: "#9B7E4F", marginBottom: 28 }} />
          <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 9 }}>KOARYU</div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 66,
              fontWeight: 700,
              lineHeight: 1.2,
              marginTop: 32,
              marginBottom: 62,
            }}
          >
            <div>Martial Arts</div>
            <div>Studio OS</div>
          </div>
          <div style={{ color: "#56431F", fontSize: 26, letterSpacing: 2 }}>koaryu.app</div>
        </div>
        {/* The existing Koaryu vector mark from icon.svg. */}
        <svg width="282" height="282" viewBox="0 0 64 64" fill="none">
          <rect x="3" y="3" width="58" height="58" rx="14" fill="#2D2212" />
          <rect x="16" y="16" width="32" height="32" fill="#F7F3E9" />
          <path d="M48 16H38L48 26V16Z" fill="#56431F" />
          <path d="M38 16H26L48 38V26L38 16Z" fill="#CFAE60" />
          <path d="M26 16H16V24L40 48H48V38L26 16Z" fill="#9B7E4F" />
          <path d="M16 24V34L30 48H40L16 24Z" fill="#F7F3E9" />
          <path d="M16 34V42L22 48H30L16 34Z" fill="#C6B183" />
          <path d="M16 42V48H22L16 42Z" fill="#CFAE60" />
          <path
            d="M38 16L48 26M26 16L48 38M16 24L40 48M16 34L30 48M16 42L22 48"
            stroke="#2D2212"
            strokeWidth="1"
          />
        </svg>
      </div>
    </div>,
    size,
  );
}
