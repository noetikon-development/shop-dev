"use client";

import { useId } from "react";
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
      <label htmlFor={fieldId} className="block text-sm font-medium text-ink">
        {label}
        {required && (
          <span className="ml-0.5 text-clay" aria-hidden="true">
            *
          </span>
        )}
      </label>

      {children ? (
        children(control)
      ) : (
        <input {...control} required={required} className="field" {...inputProps} />
      )}

      {error ? (
        <p id={errorId} className="text-xs text-clay">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
