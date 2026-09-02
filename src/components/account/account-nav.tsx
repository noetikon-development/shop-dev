"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { User, Package, MapPin, Heart, LogOut, KeyRound, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth-actions";

type NavLink = { href: string; label: string; icon: typeof User; exact?: boolean };

/**
 * Account navigation, grouped by purpose: the overview, then account settings,
 * then order activity, then saved things. On mobile the groups flatten into one
 * horizontal scroll strip; on desktop a hairline separates each group.
 */
const GROUPS: NavLink[][] = [
  [{ href: "/account", label: "Overview", icon: User, exact: true }],
  [
    { href: "/account/profile", label: "Profile", icon: User },
    { href: "/account/password", label: "Password", icon: KeyRound },
  ],
  [
    { href: "/account/orders", label: "Orders", icon: Package },
    { href: "/account/returns", label: "Returns", icon: RotateCcw },
  ],
  [
    { href: "/account/addresses", label: "Addresses", icon: MapPin },
    { href: "/account/wishlist", label: "Wishlist", icon: Heart },
  ],
];

export function AccountNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Account"
      className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0"
    >
      {GROUPS.map((group, gi) => (
        <div
          key={gi}
          className={cn(
            "flex shrink-0 gap-1 lg:flex-col lg:gap-0.5",
            gi > 0 && "lg:mt-2 lg:border-t lg:border-line lg:pt-2",
          )}
        >
          {group.map((l) => {
            const active = l.exact
              ? pathname === l.href
              : pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "tap inline-flex shrink-0 items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-ink text-paper"
                    : "text-ink-soft hover:bg-surface hover:text-ink",
                )}
              >
                <l.icon size={16} aria-hidden="true" />
                {l.label}
              </Link>
            );
          })}
        </div>
      ))}

      <form action={signOut} className="shrink-0 lg:mt-2 lg:border-t lg:border-line lg:pt-2">
        <button
          type="submit"
          className="tap inline-flex w-full shrink-0 items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm text-ink-soft transition-colors hover:bg-surface hover:text-ink"
        >
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </button>
      </form>
    </nav>
  );
}
