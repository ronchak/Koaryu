"use client";

import { useSearchParams } from "next/navigation";
import { authErrorMessage } from "@/lib/auth-error";
import { authErrorClassName } from "./auth-messages";

export function CallbackError() {
  const params = useSearchParams();
  const message = authErrorMessage(params.get("error"));
  return message ? (
    <p role="alert" className={`mb-4 ${authErrorClassName}`}>
      {message}
    </p>
  ) : null;
}
