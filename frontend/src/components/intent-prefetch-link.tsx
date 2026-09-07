"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { createIntentPrefetchPolicy } from "@/lib/intent-prefetch";
import { crmLinkPrefetch } from "@/lib/constants";

const allowPrefetch = createIntentPrefetchPolicy();
export function IntentPrefetchLink({ prefetch: explicitPrefetch, ...props }: ComponentProps<typeof Link>) {
  const router = useRouter();
  const href = typeof props.href === "string" ? props.href : props.href.pathname ?? "";
  const prefetch = explicitPrefetch === undefined ? crmLinkPrefetch(href) : explicitPrefetch;
  const arm = () => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (prefetch === false && typeof props.href === "string" && crmLinkPrefetch(props.href) === false
      && allowPrefetch(props.href, connection)) router.prefetch(props.href);
  };
  // Keep Link's registration stable while navigation is pending. Changing its
  // prefetch prop during a click can detach useLinkStatus from that navigation.
  return <Link {...props} prefetch={prefetch}
    onMouseEnter={event => { props.onMouseEnter?.(event); arm(); }}
    onFocus={event => { props.onFocus?.(event); arm(); }} />;
}
