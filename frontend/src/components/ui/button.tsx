import {
  cloneElement,
  forwardRef,
  isValidElement,
  useMemo,
  type AriaAttributes,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type MouseEvent,
  type ReactElement,
  type Ref,
} from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "outline";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

// Horizon: one ink call to action per view (amber at night), paper secondaries.
const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--hz-cta,var(--accent))] text-[var(--hz-cta-ink,var(--accent-contrast))] font-semibold shadow-[0_8px_22px_rgb(45_34_18/16%)] hover:-translate-y-px hover:shadow-[0_12px_28px_rgb(45_34_18/20%)]",
  secondary:
    "bg-surface text-text-primary border border-[var(--product-rule,var(--border))] hover:bg-surface-raised",
  danger: "bg-[var(--hz-alert-wash)] text-danger border border-danger/25 hover:border-danger/45",
  ghost: "bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-raised",
  outline:
    "bg-transparent text-text-primary border border-[var(--product-rule,var(--border))] hover:bg-surface-raised",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "min-h-10 px-3 py-1.5 text-xs",
  md: "min-h-10 px-4 py-2 text-sm",
  lg: "min-h-11 px-5 py-2.5 text-sm",
};

const baseStyles = `
  inline-flex items-center justify-center gap-2
  rounded-[10px] font-semibold whitespace-nowrap
  transition-[background-color,border-color,color,opacity,box-shadow,transform] duration-150 ease-out
  motion-reduce:transition-none motion-reduce:hover:translate-y-0
  disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0
  cursor-pointer
`;

type ChildElement = ReactElement<{
  className?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  tabIndex?: number;
  "aria-disabled"?: AriaAttributes["aria-disabled"];
  ref?: Ref<HTMLElement>;
}>;

function setRef<T>(ref: Ref<T> | undefined, value: T | null): (() => void) | undefined {
  if (typeof ref === "function") {
    const cleanup = ref(value);
    return typeof cleanup === "function" ? cleanup : () => ref(null);
  } else if (ref) {
    ref.current = value;
    return () => {
      ref.current = null;
    };
  }
}

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
      onClick,
      ...props
    },
    ref,
  ) => {
    const composedClassName = `
      ${baseStyles}
      ${variantStyles[variant]}
      ${sizeStyles[size]}
      ${className}
    `;
    const child = isValidElement(children) ? (children as ChildElement) : null;
    const childRef = child?.props.ref;
    const composedRef = useMemo(() => {
      if (!childRef && !ref) return undefined;

      return (node: HTMLElement | null) => {
        const childCleanup = setRef(childRef, node);
        const wrapperCleanup = setRef(ref as ForwardedRef<HTMLElement>, node);
        return () => {
          childCleanup?.();
          wrapperCleanup?.();
        };
      };
    }, [childRef, ref]);

    if (asChild && child) {
      const shouldHandleClick = disabled || isLoading || child.props.onClick || onClick;
      const childProps: Partial<ChildElement["props"]> = {
        ...props,
        className: `${composedClassName} ${child.props.className ?? ""}`,
        "aria-disabled":
          disabled || isLoading ? true : (props["aria-disabled"] ?? child.props["aria-disabled"]),
        tabIndex: disabled || isLoading ? -1 : (props.tabIndex ?? child.props.tabIndex),
      };

      if (composedRef) {
        childProps.ref = composedRef;
      }

      if (shouldHandleClick) {
        childProps.onClick = (event: MouseEvent<HTMLElement>) => {
          if (disabled || isLoading) {
            event.preventDefault();
            return;
          }
          child.props.onClick?.(event);
          onClick?.(event as unknown as MouseEvent<HTMLButtonElement>);
        };
      }

      return cloneElement(child, childProps);
    }

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={composedClassName}
        onClick={onClick}
        {...props}
      >
        {isLoading && (
          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
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
  },
);

Button.displayName = "Button";
