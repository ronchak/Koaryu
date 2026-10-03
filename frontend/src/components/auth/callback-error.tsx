"use client";

import { useSearchParams } from "next/navigation";
import { authErrorMessage } from "@/lib/auth-error";

export function CallbackError() {
  const params = useSearchParams();
  const message = authErrorMessage(params.get("error"));
  return message ? (
    <p role="alert" className="mb-4 text-sm text-danger">
      {message}
    </p>
  ) : null;
}
