import { InputHTMLAttributes, forwardRef, useId } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className = "", id, "aria-describedby": ariaDescribedBy, "aria-invalid": ariaInvalid, ...props }, ref) => {
    const generatedId = useId();
    const inputId =
      id ||
      `${label?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "input"}-${generatedId.replace(/:/g, "")}`;
    const errorId = error ? `${inputId}-error` : undefined;
    const hintId = hint && !error ? `${inputId}-hint` : undefined;
    const describedBy = [ariaDescribedBy, errorId, hintId].filter(Boolean).join(" ") || undefined;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm text-text-secondary font-medium"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : ariaInvalid}
          aria-describedby={describedBy}
          className={`
            w-full px-3 py-2 text-sm
            bg-surface-raised border border-border rounded-[6px]
            text-text-primary placeholder:text-muted
            focus:border-accent focus:outline-none
            transition-[background-color,border-color,color] duration-150 ease-out
            motion-reduce:transition-none
            disabled:opacity-50 disabled:cursor-not-allowed
            ${error ? "border-danger" : ""}
            ${className}
          `}
          {...props}
        />
        {error && (
          <p id={errorId} className="text-xs text-danger">{error}</p>
        )}
        {hint && !error && (
          <p id={hintId} className="text-xs text-muted">{hint}</p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
