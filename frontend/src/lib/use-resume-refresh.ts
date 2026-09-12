"use client";
import { useEffect, useEffectEvent } from "react";
import { APP_DATA_REFRESH_EVENT } from "./app-resume";

/** Runs only after the workspace has revalidated access, using the current route's callback. */
export function useResumeRefresh(refresh: () => void | Promise<unknown>) {
  const onRefresh = useEffectEvent(refresh);
  useEffect(() => {
    const onResume = () => {
      void Promise.resolve(onRefresh()).catch(() => {});
    };
    window.addEventListener(APP_DATA_REFRESH_EVENT, onResume);
    return () => window.removeEventListener(APP_DATA_REFRESH_EVENT, onResume);
  }, []);
}
