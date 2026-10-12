import type { Metadata } from "next";
import { HorizonScene } from "@/components/auth/horizon-scene";
import { AUTH_NOINDEX_METADATA } from "@/lib/auth-indexing";

export const metadata: Metadata = AUTH_NOINDEX_METADATA;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <HorizonScene>{children}</HorizonScene>;
}
