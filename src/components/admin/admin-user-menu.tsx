"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, LogOut, Store, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { adminSignOut } from "@/lib/admin/actions";

export function AdminUserMenu({
  name,
  email,
  roles,
}: {
  name: string;
  email: string;
  roles: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

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
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-surface-sunken"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-xs font-semibold text-paper">
          {initials || "A"}
        </span>
        <span className="hidden max-w-[9rem] truncate text-ink-soft sm:block">{name}</span>
        <ChevronDown size={14} className="text-ink-faint" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-60 overflow-hidden rounded-md border border-line bg-paper shadow-pop"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-ink-faint">{email}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {roles.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 rounded-xs bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-soft"
                >
                  {r === "SUPER_ADMIN" && <ShieldCheck size={10} />}
                  {r.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          </div>
          <Link
            href="/"
            className="flex items-center gap-2 px-3 py-2 text-sm text-ink-soft hover:bg-surface-sunken hover:text-ink"
          >
            <Store size={15} />
            Back to store
          </Link>
          <form action={adminSignOut}>
            <button
              type="submit"
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-soft",
                "hover:bg-surface-sunken hover:text-ink",
              )}
            >
              <LogOut size={15} />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
