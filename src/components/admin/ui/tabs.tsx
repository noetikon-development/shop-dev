"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Reusable tab strip. Uncontrolled by default; pass `value` + `onValueChange`
 * to control it (e.g. bind to a URL param). */

export type TabItem = { value: string; label: ReactNode; disabled?: boolean };

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  children,
}: {
  items: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  /** Optional render-prop for the active panel. */
  children?: (active: string) => ReactNode;
}) {
  const [internal, setInternal] = useState(defaultValue ?? items[0]?.value ?? "");
  const active = value ?? internal;
  const setActive = (v: string) => {
    if (onValueChange) onValueChange(v);
    else setInternal(v);
  };

  return (
    <div>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
        {items.map((item) => {
          const selected = item.value === active;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={item.disabled}
              onClick={() => setActive(item.value)}
              className={cn(
                "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40",
                selected
                  ? "border-ink text-ink"
                  : "border-transparent text-ink-faint hover:text-ink-soft",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {children && <div className="pt-4">{children(active)}</div>}
    </div>
  );
}
