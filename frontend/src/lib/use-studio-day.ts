"use client";
import { useEffect, useState } from "react";
import { studioDateKey } from "@/lib/date";

// Recheck on wake/visibility and each minute. Only the date changes; drafts do not.
export function useStudioDay(timezone: string): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 30_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return studioDateKey(timezone, now);
}
