"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/* Kebab dropdown for row / card actions. */

export type ActionItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
};

export function ActionMenu({
  items,
  label = "Actions",
  align = "right",
}: {
  items: ActionItem[];
  label?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="btn btn-ghost p-1.5"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-40 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-line bg-paper py-1 shadow-pop",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-40",
                item.tone === "danger"
                  ? "text-clay hover:bg-clay-50"
                  : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
