import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "outline";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[#0B0D10] hover:bg-accent-hover font-medium",
  secondary:
    "bg-surface-raised text-text-primary border border-border hover:bg-[#1E2329]",
  danger:
    "bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20",
  ghost:
    "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-raised",
  outline:
    "bg-transparent text-text-primary border border-border hover:bg-surface-raised",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3.5 py-1.5 text-sm",
  lg: "px-5 py-2.5 text-sm",
};

const baseStyles = `
  inline-flex items-center justify-center gap-2
  rounded-[6px] font-medium
  transition-colors duration-150
  disabled:opacity-50 disabled:cursor-not-allowed
  cursor-pointer
`;

type ChildElement = ReactElement<{ className?: string }>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      asChild = false,
      variant = "primary",
      size = "md",
      isLoading = false,
      className = "",
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const composedClassName = `
      ${baseStyles}
      ${variantStyles[variant]}
      ${sizeStyles[size]}
      ${className}
    `;

    if (asChild && isValidElement(children)) {
      const child = children as ChildElement;

      return cloneElement(child, {
        className: `${composedClassName} ${child.props.className ?? ""}`,
      });
    }

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={composedClassName}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
