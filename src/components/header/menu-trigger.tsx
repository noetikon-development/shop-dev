"use client";

import { Menu } from "lucide-react";
import { useUI } from "@/lib/ui-store";

export function MenuTrigger() {
  const toggleMenu = useUI((s) => s.toggleMenu);
  return (
    <button
      onClick={() => toggleMenu(true)}
      className="grid h-10 w-10 place-items-center rounded-full text-ink-soft hover:bg-surface hover:text-ink xl:hidden"
      aria-label="Open menu"
    >
      <Menu size={20} strokeWidth={1.6} />
    </button>
  );
}
