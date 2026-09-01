"use client";

import Link from "next/link";
import { User, Package, Heart, MapPin, LogOut, KeyRound } from "lucide-react";
import { signOut } from "@/lib/auth-actions";
import { buttonClasses } from "@/components/ui/button";
import { useDisclosure } from "@/lib/use-disclosure";

export function AccountMenu({
  signedIn,
  name,
}: {
  signedIn: boolean;
  name?: string | null;
}) {
  const { open, setOpen, toggle, triggerRef, contentRef } = useDisclosure<
    HTMLButtonElement,
    HTMLDivElement
  >();

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={toggle}
        className="grid h-10 w-10 tap place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface hover:text-ink"
        aria-label="Account"
        aria-expanded={open}
      >
        <User size={19} strokeWidth={1.6} />
      </button>

      {open && (
        <div
          ref={contentRef}
          className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-md border border-line bg-paper py-1.5 shadow-pop"
        >
          {signedIn ? (
            <>
              <p className="px-3.5 py-2 text-xs text-ink-faint">
                Signed in{name ? ` as ${name}` : ""}
              </p>
              <MenuLink href="/account" icon={<User size={15} />} onClick={() => setOpen(false)}>
                Account overview
              </MenuLink>
              <MenuLink
                href="/account/profile"
                icon={<User size={15} />}
                onClick={() => setOpen(false)}
              >
                Profile
              </MenuLink>
              <MenuLink
                href="/account/password"
                icon={<KeyRound size={15} />}
                onClick={() => setOpen(false)}
              >
                Change password
              </MenuLink>
              <MenuLink
                href="/account/orders"
                icon={<Package size={15} />}
                onClick={() => setOpen(false)}
              >
                Orders
              </MenuLink>
              <MenuLink
                href="/account/wishlist"
                icon={<Heart size={15} />}
                onClick={() => setOpen(false)}
              >
                Wishlist
              </MenuLink>
              <MenuLink
                href="/account/addresses"
                icon={<MapPin size={15} />}
                onClick={() => setOpen(false)}
              >
                Addresses
              </MenuLink>
              <form action={signOut}>
                <button
                  type="submit"
                  className="flex w-full items-center gap-2.5 border-t border-line px-3.5 py-2.5 text-left text-sm text-ink-soft hover:bg-surface hover:text-ink"
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="px-3.5 py-2">
                <Link
                  href="/login"
                  onClick={() => setOpen(false)}
                  className={buttonClasses({ size: "sm", className: "w-full" })}
                >
                  Sign in
                </Link>
                <p className="mt-2 text-center text-xs text-ink-faint">
                  New here?{" "}
                  <Link
                    href="/register"
                    onClick={() => setOpen(false)}
                    className="font-medium text-ink underline underline-offset-2"
                  >
                    Create an account
                  </Link>
                </p>
              </div>
              <MenuLink
                href="/track"
                icon={<Package size={15} />}
                onClick={() => setOpen(false)}
              >
                Track an order
              </MenuLink>
              <MenuLink
                href="/account/wishlist"
                icon={<Heart size={15} />}
                onClick={() => setOpen(false)}
              >
                Wishlist
              </MenuLink>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  icon,
  children,
  onClick,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-ink-soft transition-colors hover:bg-surface hover:text-ink"
    >
      <span className="text-ink-faint">{icon}</span>
      {children}
    </Link>
  );
}
