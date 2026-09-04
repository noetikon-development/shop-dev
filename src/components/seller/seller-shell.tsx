"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, Store, LogOut, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { sellerNav, sellerBreadcrumbs, type SellerRoute } from "@/lib/seller/navigation";
import { Breadcrumbs } from "@/components/seller/ui";
import { sellerSignOut, switchSellerAction } from "@/lib/seller/auth-actions";

type Membership = { sellerId: string; sellerName: string; sellerStatus: string };

type Props = {
  sellerName: string;
  sellerId: string;
  role: string;
  permissions: string[];
  userEmail: string;
  memberships: Membership[];
  children: React.ReactNode;
};

export function SellerShell({
  sellerName,
  sellerId,
  role,
  permissions,
  userEmail,
  memberships,
  children,
}: Props) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);

  const routes = sellerNav(new Set(permissions), role);
  const crumbs = sellerBreadcrumbs(pathname);
  const switchable = memberships.filter((m) => m.sellerStatus === "APPROVED");

  const isActive = (href: string) =>
    href === "/seller" ? pathname === "/seller" : pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav className="flex flex-col gap-0.5 px-3 py-4">
      {routes.map((r) => (
        <NavLink
          key={r.path}
          route={r}
          active={isActive(r.path)}
          onNavigate={closeNav}
        />
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-line px-5">
          <Link href="/seller" className="inline-flex items-center gap-2">
            <Logo className="h-7" />
            <span className="text-sm font-semibold">Seller</span>
          </Link>
        </div>
        <div className="border-b border-line px-3 py-3">
          <SellerSwitcher current={{ sellerId, sellerName }} options={switchable} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
        <form action={sellerSignOut} className="border-t border-line p-3">
          <button type="submit" className="btn btn-ghost w-full justify-start text-sm text-ink-soft">
            <LogOut size={14} /> Sign out
          </button>
        </form>
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn("fixed inset-0 z-[70] lg:hidden", navOpen ? "pointer-events-auto" : "pointer-events-none")}
        aria-hidden={!navOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-ink/40 backdrop-blur-[2px] transition-opacity",
            navOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={closeNav}
        />
        <aside
          className={cn(
            "absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col bg-surface shadow-pop transition-transform duration-300 ease-[cubic-bezier(.16,1,.3,1)]",
            navOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 items-center justify-between border-b border-line px-5">
            <Link href="/seller" onClick={closeNav} className="inline-flex items-center gap-2">
              <Logo className="h-7" />
              <span className="text-sm font-semibold">Seller</span>
            </Link>
            <button type="button" onClick={closeNav} aria-label="Close menu" className="btn btn-ghost p-1.5">
              <X size={18} />
            </button>
          </div>
          <div className="border-b border-line px-3 py-3">
            <SellerSwitcher current={{ sellerId, sellerName }} options={switchable} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
          <form action={sellerSignOut} className="border-t border-line p-3">
            <button type="submit" className="btn btn-ghost w-full justify-start text-sm text-ink-soft">
              <LogOut size={14} /> Sign out
            </button>
          </form>
        </aside>
      </div>

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
          <span className="hidden text-xs text-ink-faint sm:inline">{userEmail}</span>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function NavLink({
  route,
  active,
  onNavigate,
}: {
  route: SellerRoute;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={route.path}
      onClick={onNavigate}
      className={cn(
        "flex items-center justify-between rounded-sm px-3 py-2 text-sm transition-colors",
        active ? "bg-ink text-paper" : "text-ink-soft hover:bg-surface-sunken hover:text-ink",
      )}
    >
      <span>{route.label}</span>
      {!route.live && (
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

function SellerSwitcher({
  current,
  options,
}: {
  current: { sellerId: string; sellerName: string };
  options: Membership[];
}) {
  const [open, setOpen] = useState(false);
  if (options.length <= 1) {
    return (
      <div className="flex items-center gap-2 rounded-sm bg-surface-sunken px-3 py-2 text-sm">
        <Store size={14} className="text-ink-faint" />
        <span className="truncate font-medium">{current.sellerName}</span>
      </div>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-sm bg-surface-sunken px-3 py-2 text-sm"
      >
        <Store size={14} className="text-ink-faint" />
        <span className="flex-1 truncate text-left font-medium">{current.sellerName}</span>
        <ChevronDown size={14} className="text-ink-faint" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-sm border border-line bg-paper shadow-pop">
          {options.map((m) => (
            <form key={m.sellerId} action={switchSellerAction}>
              <input type="hidden" name="sellerId" value={m.sellerId} />
              <button
                type="submit"
                className={cn(
                  "block w-full px-3 py-2 text-left text-sm hover:bg-surface-sunken",
                  m.sellerId === current.sellerId && "font-semibold",
                )}
              >
                {m.sellerName}
              </button>
            </form>
          ))}
        </div>
      )}
    </div>
  );
}
