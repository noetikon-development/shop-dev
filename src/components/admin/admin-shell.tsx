"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { Breadcrumbs } from "@/components/admin/ui";
import { buildSidebar } from "@/lib/admin/navigation";
import { breadcrumbsFor } from "@/lib/admin/navigation";
import { AdminUserMenu } from "@/components/admin/admin-user-menu";

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
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  const entries = buildSidebar(isSuperAdmin, new Set(permissions));
  const crumbs = breadcrumbsFor(pathname);

  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav className="flex flex-col gap-4 px-3 py-4">
      {entries.map((entry) => {
        if (entry.kind === "item") {
          return (
            <NavLink
              key={entry.route.path}
              href={entry.route.path}
              label={entry.route.label}
              active={isActive(entry.route.path)}
              soon={!entry.route.live}
              onNavigate={closeNav}
            />
          );
        }
        return (
          <div key={entry.key} className="flex flex-col gap-0.5">
            <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              {entry.label}
            </p>
            {entry.items.map((route) => (
              <NavLink
                key={route.path}
                href={route.path}
                label={route.label}
                active={isActive(route.path)}
                soon={!route.live}
                onNavigate={closeNav}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-line px-5">
          <Link href="/admin" className="inline-flex items-center gap-2">
            <Logo className="h-7" />
            <span className="text-sm font-semibold">Admin</span>
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-[70] lg:hidden",
          navOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!navOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-ink/40 backdrop-blur-[2px] transition-opacity",
            navOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setNavOpen(false)}
        />
        <aside
          className={cn(
            "absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col bg-surface shadow-pop transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)]",
            navOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 items-center justify-between border-b border-line px-5">
            <Link href="/admin" onClick={closeNav} className="inline-flex items-center gap-2">
              <Logo className="h-7" />
              <span className="text-sm font-semibold">Admin</span>
            </Link>
            <button
              type="button"
              onClick={closeNav}
              aria-label="Close menu"
              className="btn btn-ghost p-1.5"
            >
              <X size={18} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
        </aside>
      </div>

      {/* Main column */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-paper/95 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            className="btn btn-ghost -ml-2 p-2 lg:hidden"
          >
            <Menu size={18} />
          </button>
          <Breadcrumbs items={crumbs} className="flex-1" />
          <AdminUserMenu name={name} email={email} roles={roles} />
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  href,
  label,
  active,
  soon,
  onNavigate,
}: {
  href: string;
  label: string;
  active: boolean;
  soon?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className={cn(
        "flex items-center justify-between rounded-sm px-3 py-2 text-sm transition-colors",
        active ? "bg-ink text-paper" : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
      )}
    >
      <span>{label}</span>
      {soon && (
        <span
          className={cn(
            "text-[9px] font-semibold uppercase tracking-wide",
            active ? "text-paper/60" : "text-ink-faint",
          )}
        >
          Soon
        </span>
      )}
    </Link>
  );
}
