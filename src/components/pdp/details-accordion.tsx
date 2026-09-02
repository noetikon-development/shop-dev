"use client";

import { useState } from "react";
import { Plus, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

type Section = { id: string; title: string; content: React.ReactNode };

export function DetailsAccordion({
  sections,
  defaultOpen,
}: {
  sections: Section[];
  defaultOpen?: string;
}) {
  const [open, setOpen] = useState<string | null>(defaultOpen ?? sections[0]?.id ?? null);

  return (
    <div className="divide-y divide-line border-y border-line">
      {sections.map((s) => {
        const isOpen = open === s.id;
        return (
          <div key={s.id}>
            <button
              onClick={() => setOpen(isOpen ? null : s.id)}
              className="flex w-full items-center justify-between gap-4 py-5 text-left"
              aria-expanded={isOpen}
            >
              <span className="text-body font-medium">{s.title}</span>
              {isOpen ? (
                <Minus size={16} className="shrink-0 text-ink-soft" />
              ) : (
                <Plus size={16} className="shrink-0 text-ink-soft" />
              )}
            </button>
            <div
              className={cn(
                "grid transition-all duration-300",
                isOpen ? "grid-rows-[1fr] pb-6 opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="overflow-hidden text-sm leading-relaxed text-ink-soft">
                {s.content}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
