"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { crmLinkPrefetch } from "@/lib/constants";

export function PanelHeader({
  title,
  subtitle,
  href,
  linkLabel = "View all",
}: {
  title: string;
  subtitle?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {subtitle && (
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>
      {href && (
        <Link
          href={href}
          prefetch={crmLinkPrefetch(href)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover shrink-0 transition-colors"
        >
          {linkLabel}
          <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}
