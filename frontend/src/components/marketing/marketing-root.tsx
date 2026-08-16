import type { HTMLAttributes, ReactNode } from "react";

import styles from "./marketing-foundation.module.css";

export type MarketingLayoutMode = "document" | "viewport";

export interface MarketingRootProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  layout?: MarketingLayoutMode;
}

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

export function MarketingRoot({
  children,
  className,
  layout = "document",
  ...props
}: MarketingRootProps) {
  return (
    <div
      {...props}
      data-koaryu-marketing=""
      data-layout={layout}
      className={joinClassNames(styles.root, styles[layout], className)}
    >
      {children}
    </div>
  );
}
