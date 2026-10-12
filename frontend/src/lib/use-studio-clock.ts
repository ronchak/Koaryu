"use client";
import { useCallback, useSyncExternalStore } from "react";

/** Minutes since midnight on the studio's clock, or null when the timezone is unreadable. */
export function studioClockMinutes(timezone: string, now: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

// Recheck on wake/visibility and each minute, as `useStudioDay` does.
function subscribe(onTick: () => void) {
  const timer = window.setInterval(onTick, 60_000);
  window.addEventListener("focus", onTick);
  document.addEventListener("visibilitychange", onTick);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onTick);
    document.removeEventListener("visibilitychange", onTick);
  };
}

const serverClock = () => null;

/**
 * The studio's time of day in minutes, for the calendar's now line. Null without a
 * timezone and on the server, so the first paint never guesses at the time.
 */
export function useStudioClock(timezone: string | undefined): number | null {
  const read = useCallback(
    () => (timezone ? studioClockMinutes(timezone, new Date()) : null),
    [timezone],
  );
  return useSyncExternalStore(subscribe, read, serverClock);
}
