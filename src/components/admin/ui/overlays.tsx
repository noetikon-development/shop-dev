"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Modal + ConfirmDialog — reusable across the admin panel.
 * ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // `open` is only ever true after a client interaction, so `document` exists
  // by the time we portal.
  if (!open || typeof document === "undefined") return null;

  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-lg";

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelId : undefined}
        tabIndex={-1}
        className={cn(
          "relative w-full rounded-t-lg bg-paper shadow-pop outline-none sm:rounded-lg",
          width,
        )}
      >
        {title != null && (
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h2 id={labelId} className="text-base font-semibold text-ink">
                {title}
              </h2>
              {description && (
                <p className="mt-0.5 text-sm text-ink-soft">{description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn btn-ghost -mr-2 -mt-1 p-2"
            >
              <X size={17} />
            </button>
          </div>
        )}
        {children != null && <div className="px-5 py-4">{children}</div>}
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-surface px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  pending?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {tone === "danger" && <AlertTriangle size={16} className="text-clay" />}
          {title}
        </span>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-outline py-2 text-sm">
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              "btn py-2 text-sm text-paper",
              tone === "danger" ? "btn-clay" : "btn-primary",
            )}
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-soft">{message}</p>
    </Modal>
  );
}
