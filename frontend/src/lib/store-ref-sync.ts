"use client";

import { useEffect } from "react";

type WritableRef<T> = {
  current: T;
};

export function useSyncedRefValue<T>(ref: WritableRef<T>, value: T) {
  useEffect(() => {
    ref.current = value;
  }, [ref, value]);
}
