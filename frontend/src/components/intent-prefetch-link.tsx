"use client";
import Link from "next/link";
import { useSyncExternalStore, type ComponentProps } from "react";
import { canPrefetchOnConnection, getPrefetchConnection } from "@/lib/intent-prefetch";
import { crmLinkPrefetch } from "@/lib/constants";

function subscribeToConnection(listener: () => void) {
  const connection = getPrefetchConnection() as EventTarget | undefined;
  connection?.addEventListener?.("change", listener);
  return () => connection?.removeEventListener?.("change", listener);
}
const connectionAllowsPrefetch = () => canPrefetchOnConnection(getPrefetchConnection());
const serverAllowsPrefetch = () => false;

export function IntentPrefetchLink({
  prefetch: explicitPrefetch,
  ...props
}: ComponentProps<typeof Link>) {
  // Keep speculative requests disabled until hydration has checked the connection.
  const allowed = useSyncExternalStore(
    subscribeToConnection,
    connectionAllowsPrefetch,
    serverAllowsPrefetch,
  );
  const href = typeof props.href === "string" ? props.href : (props.href.pathname ?? "");
  const prefetch = allowed
    ? explicitPrefetch === undefined
      ? crmLinkPrefetch(href)
      : explicitPrefetch
    : false;
  return <Link {...props} prefetch={prefetch} />;
}
