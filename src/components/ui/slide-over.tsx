"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function SlideOver({
  open,
  onClose,
  title,
  side = "right",
  width = "max-w-md",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  side?: "right" | "left";
  width?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] transition-opacity duration-300",
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute inset-y-0 flex w-full flex-col bg-paper shadow-pop transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)]",
          width,
          side === "right"
            ? cn("right-0", open ? "translate-x-0" : "translate-x-full")
            : cn("left-0", open ? "translate-x-0" : "-translate-x-full"),
        )}
      >
        {title != null && (
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <div className="text-sm font-semibold uppercase tracking-wider">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn-ghost -mr-2 !p-2"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-line bg-surface px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}
