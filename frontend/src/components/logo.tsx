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

export function Logo({ size = "md", showText = true }: LogoProps) {
  return (
    <div className="flex items-center gap-2.5">
      {/* Koaryu mark — stylized K with accent */}
      <div
        className={`${sizes[size]} font-bold tracking-tight`}
        style={{ color: "var(--accent)" }}
      >
        <svg
          viewBox="0 0 28 28"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={size === "sm" ? "w-5 h-5" : size === "md" ? "w-6 h-6" : "w-8 h-8"}
        >
          <rect
            width="28"
            height="28"
            rx="6"
            fill="currentColor"
          />
          <path
            d="M8 7h3v6l5.5-6H20l-6 6.5L20.5 21H17l-4.5-5.5L10 18v3H8V7z"
            fill="var(--bg)"
          />
        </svg>
      </div>
      {showText && (
        <span
          className={`${sizes[size]} font-semibold tracking-tight`}
          style={{ color: "var(--text-primary)" }}
        >
          {APP_NAME}
        </span>
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
