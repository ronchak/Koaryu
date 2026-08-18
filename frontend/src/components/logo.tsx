import Link from "next/link";
import { APP_NAME } from "@/lib/constants";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
}

interface LogoLinkProps extends LogoProps {
  href?: string;
  label?: string;
  className?: string;
}

const sizes = {
  sm: "text-base",
  md: "text-xl",
  lg: "text-3xl",
};

const markSizes = {
  sm: "w-5 h-5",
  md: "w-6 h-6",
  lg: "w-8 h-8",
};

export function KoaryuMark({ size = "md" }: Pick<LogoProps, "size">) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={markSizes[size]}
    >
      <rect x="3" y="3" width="58" height="58" rx="14" fill="#2D2212" />
      <g>
        <rect x="16" y="16" width="32" height="32" fill="#F7F3E9" />
        <path d="M48 16H38L48 26V16Z" fill="#56431F" />
        <path d="M38 16H26L48 38V26L38 16Z" fill="#CFAE60" />
        <path d="M26 16H16V24L40 48H48V38L26 16Z" fill="#9B7E4F" />
        <path d="M16 24V34L30 48H40L16 24Z" fill="#F7F3E9" />
        <path d="M16 34V42L22 48H30L16 34Z" fill="#C6B183" />
        <path d="M16 42V48H22L16 42Z" fill="#CFAE60" />
        <path
          d="M38 16L48 26M26 16L48 38M16 24L40 48M16 34L30 48M16 42L22 48"
          stroke="#2D2212"
          strokeWidth="1"
        />
      </g>
    </svg>
  );
}

export function Logo({ size = "md", showText = true }: LogoProps) {
  return (
    <div className="flex items-center">
      {showText ? (
        <span
          className={`${sizes[size]} uppercase tracking-[0.32em]`}
          style={{
            color: "var(--text-primary)",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Inter, "Segoe UI", Roboto, sans-serif',
            fontWeight: 760,
          }}
        >
          {APP_NAME}
        </span>
      ) : (
        <KoaryuMark size={size} />
      )}
    </div>
  );
}

export function LogoLink({
  href = "/",
  label = "Return to Koaryu home",
  className = "",
  ...logoProps
}: LogoLinkProps) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={`inline-flex items-center rounded-[6px] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`}
    >
      <Logo {...logoProps} />
    </Link>
  );
}
