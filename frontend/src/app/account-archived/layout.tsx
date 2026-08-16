import type { Metadata } from "next";
import { AUTH_NOINDEX_METADATA } from "@/lib/auth-indexing";

export const metadata: Metadata = AUTH_NOINDEX_METADATA;

export default function ArchivedAccountLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
