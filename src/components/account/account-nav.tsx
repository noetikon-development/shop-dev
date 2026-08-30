"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { User, Package, MapPin, Heart, LogOut, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth-actions";

const LINKS = [
  { href: "/account", label: "Overview", icon: User, exact: true },
  { href: "/account/profile", label: "Profile", icon: User },
  { href: "/account/password", label: "Password", icon: KeyRound },
  { href: "/account/orders", label: "Orders", icon: Package },
  { href: "/account/addresses", label: "Addresses", icon: MapPin },
  { href: "/account/wishlist", label: "Wishlist", icon: Heart },
];

export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
      {LINKS.map((l) => {
        const active =
          "exact" in l && l.exact
            ? pathname === l.href
            : pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cn(
              "inline-flex shrink-0 items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm transition-colors",
              active ? "bg-ink text-paper" : "text-ink-soft hover:bg-surface hover:text-ink",
            )}
          >
            <l.icon size={16} />
            {l.label}
          </Link>
        );
      })}
      <form action={signOut} className="contents">
        <button
          type="submit"
          className="inline-flex shrink-0 items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm text-ink-soft transition-colors hover:bg-surface hover:text-ink lg:mt-2 lg:border-t lg:border-line lg:pt-4"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </form>
    </nav>
  );
}
