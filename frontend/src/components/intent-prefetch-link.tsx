"use client";
import Link from "next/link";
import { useEffect, useState, type ComponentProps } from "react";
import { createIntentPrefetchPolicy } from "@/lib/intent-prefetch";

const allowPrefetch = createIntentPrefetchPolicy();
export function IntentPrefetchLink({ prefetch, ...props }: ComponentProps<typeof Link>) {
  const [armed, setArmed] = useState(false);
  const arm = () => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (prefetch === false && typeof props.href === "string" && allowPrefetch(props.href, connection)) setArmed(true);
  };
  useEffect(() => {
    if (!armed) return;
    const timeout = setTimeout(() => setArmed(false), 3_000);
    return () => clearTimeout(timeout);
  }, [armed]);
  return <Link {...props} prefetch={prefetch === false ? (armed ? undefined : false) : prefetch}
    onMouseEnter={event => { props.onMouseEnter?.(event); arm(); }}
    onFocus={event => { props.onFocus?.(event); arm(); }} />;
}
