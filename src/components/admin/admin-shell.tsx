"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, LogOut, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { ADMIN_SECTIONS, sectionVisibleFor } from "@/lib/admin/sections";
import { adminSignOut } from "@/lib/admin/actions";

type Props = {
  name: string;
  email: string;
  roles: string[];
  permissions: string[];
  isSuperAdmin: boolean;
  children: React.ReactNode;
};

export function AdminShell({ name, email, roles, permissions, isSuperAdmin, children }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const permSet = new Set(permissions);
  const visible = ADMIN_SECTIONS.filter(
    (s) => isSuperAdmin || sectionVisibleFor(s, permSet),
  );

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {visible.map((s) => {
        const href = s.slug ? `/admin/${s.slug}` : "/admin";
        const active = s.slug
          ? pathname === href || pathname.startsWith(`${href}/`)
          : pathname === "/admin";
        return (
          <Link
            key={s.slug || "dashboard"}
            href={href}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center justify-between rounded-sm px-3 py-2 text-sm transition-colors",
              active
                ? "bg-ink text-paper"
                : "text-ink-soft hover:bg-surface hover:text-ink",
            )}
          >
            <span>{s.label}</span>
            {!s.live && (
              <span
                className={cn(
                  "text-[10px] uppercase tracking-wide",
                  active ? "text-paper/60" : "text-ink-faint",
                )}
              >
                Soon
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="lg:grid lg:grid-cols-[248px_1fr]">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
        <Link href="/admin" className="inline-flex items-center gap-2">
          <Logo className="h-7" />
          <span className="text-sm font-medium">Admin</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Toggle menu"
          className="btn btn-ghost px-2"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {/* Sidebar */}
      <aside
        className={cn(
          "border-r border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col",
          open ? "block" : "hidden lg:flex",
        )}
      >
        <div className="hidden items-center gap-2 border-b border-line px-5 py-4 lg:flex">
          <Logo className="h-8" />
          <span className="text-sm font-medium">Admin</span>
        </div>

        <div className="flex-1 overflow-y-auto p-3">{nav}</div>

        <div className="border-t border-line p-3">
          <div className="rounded-sm bg-surface-sunken px-3 py-2.5">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-ink-faint">{email}</p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {roles.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 rounded-xs bg-ink px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-paper"
                >
                  {r === "SUPER_ADMIN" && <ShieldCheck size={10} />}
                  {r.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          </div>
          <form action={adminSignOut} className="mt-2">
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <LogOut size={15} />
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Content */}
      <main className="min-w-0 px-5 py-8 sm:px-8 lg:px-10">{children}</main>
    </div>
  );
}
