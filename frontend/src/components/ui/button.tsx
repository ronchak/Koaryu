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

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-contrast hover:bg-accent-hover font-medium",
  secondary:
    "bg-surface-raised text-text-primary border border-border hover:bg-surface-hover",
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
  transition-[background-color,border-color,color,opacity,box-shadow,transform] duration-150 ease-out
  motion-reduce:transition-none
  disabled:opacity-50 disabled:cursor-not-allowed
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
    ref
  ) => {
    const composedClassName = `
      ${baseStyles}
      ${variantStyles[variant]}
      ${sizeStyles[size]}
      ${className}
    `;
    const child = isValidElement(children) ? children as ChildElement : null;
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
        "aria-disabled": disabled || isLoading
          ? true
          : props["aria-disabled"] ?? child.props["aria-disabled"],
        tabIndex: disabled || isLoading ? -1 : props.tabIndex ?? child.props.tabIndex,
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
