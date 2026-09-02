"use client";

import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Canonical storefront form field (Phase 5B).
 *
 * Renders a labelled control with helper text, an error slot, a required
 * marker, and the accessible wiring (id ↔ label, aria-describedby,
 * aria-invalid, aria-required). It does not change validation — the caller
 * still owns `name`, `required`, `minLength`, server actions, etc.
 *
 * Plain input:   <Field label="Email" name="email" type="email" required />
 * Custom control: <Field label="Message" error={e}>
 *                   {(p) => <textarea {...p} name="message" rows={6} className="field" />}
 *                 </Field>
 *
 * `type="password"` fields automatically get a show/hide toggle. It only swaps
 * the input's `type` between "password" and "text" — the value, `name`,
 * `autoComplete`, `minLength`, `required` and form submission are untouched.
 */

type ControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
};

type FieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "id" | "className" | "children"
> & {
  label: React.ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
  id?: string;
  /** Wrapper class (the control keeps `.field`). */
  className?: string;
  /** Override the default <input> for a textarea / select / custom control. */
  children?: (control: ControlProps) => React.ReactNode;
};

export function Field({
  label,
  hint,
  error,
  required,
  id,
  className,
  children,
  ...inputProps
}: FieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const [revealPassword, setRevealPassword] = useState(false);
  const isPassword = inputProps.type === "password";
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const control: ControlProps = {
    id: fieldId,
    "aria-describedby": describedBy,
    ...(error ? { "aria-invalid": true } : {}),
    ...(required ? { "aria-required": true } : {}),
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={fieldId} className="block text-body font-medium text-ink">
        {label}
        {required && (
          <span className="ml-0.5 text-clay" aria-hidden="true">
            *
          </span>
        )}
      </label>

      {children ? (
        children(control)
      ) : isPassword ? (
        <div className="relative">
          <input
            {...control}
            required={required}
            {...inputProps}
            type={revealPassword ? "text" : "password"}
            className="field pr-12"
          />
          <button
            type="button"
            onClick={() => setRevealPassword((v) => !v)}
            aria-label={revealPassword ? "Hide password" : "Show password"}
            aria-pressed={revealPassword}
            className="tap absolute inset-y-0 right-0 grid place-items-center px-3 text-ink-soft transition-colors hover:text-ink"
          >
            {revealPassword ? (
              <EyeOff size={18} aria-hidden="true" />
            ) : (
              <Eye size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      ) : (
        <input {...control} required={required} className="field" {...inputProps} />
      )}

      {error ? (
        <p id={errorId} className="text-meta text-clay">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-meta text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
