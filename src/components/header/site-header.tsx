import Link from "next/link";
import { auth } from "@/auth";
import { getCategoryTree } from "@/lib/data";
import { Logo } from "@/components/logo";
import { MegaMenu } from "@/components/header/mega-menu";
import { MobileMenu } from "@/components/header/mobile-menu";
import { MenuTrigger } from "@/components/header/menu-trigger";
import { HeaderSearch } from "@/components/header/search";
import { AccountMenu } from "@/components/header/account-menu";
import { CartButton, WishlistButton } from "@/components/header/cart-button";

const ANNOUNCEMENTS = [
  "Free shipping on orders over ₱2,500",
  "New: Autumn textiles collection",
  "30-day returns, always",
  "Use WELCOME10 for 10% off your first order",
];

export async function SiteHeader() {
  const [tree, session] = await Promise.all([getCategoryTree(), auth()]);
  const featured = tree.filter((c) => c.featured);

  return (
    <>
      <div className="bg-ink text-paper">
        <div className="container-page flex h-9 items-center overflow-hidden">
          <div className="flex animate-marquee gap-16 whitespace-nowrap text-[11px] tracking-wide">
            {[...ANNOUNCEMENTS, ...ANNOUNCEMENTS].map((a, i) => (
              <span key={i} className="text-paper/80">
                {a}
              </span>
            ))}
          </div>
        </div>
      </div>

      <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur">
        <div className="container-page">
          <div className="flex h-16 items-center gap-4">
            <MenuTrigger />
            <Logo className="h-10 shrink-0" />

            <div className="ml-4 hidden flex-1 md:block lg:ml-8">
              <HeaderSearch />
            </div>

            <div className="ml-auto flex items-center gap-0.5">
              <AccountMenu
                signedIn={Boolean(session?.user)}
                name={session?.user?.name?.split(" ")[0]}
              />
              <WishlistButton />
              <CartButton />
            </div>
          </div>

          <div className="pb-3 md:hidden">
            <HeaderSearch />
          </div>

          <div className="hidden h-11 items-center justify-between xl:flex">
            <MegaMenu tree={featured} />
            <div className="flex items-center gap-5 text-xs text-ink-faint">
              <Link href="/track" className="hover:text-ink">
                Track order
              </Link>
              <Link href="/promotions" className="hover:text-ink">
                Promotions
              </Link>
              <Link href="/c/all" className="hover:text-ink">
                All categories
              </Link>
            </div>
          </div>
        </div>
      </header>

      <MobileMenu tree={tree} signedIn={Boolean(session?.user)} />
    </>
  );
}
