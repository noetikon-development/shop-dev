import { getCurrentUser } from "@/lib/auth";
import { getSiteSettings } from "@/lib/site-settings";
import { getResolvedNav } from "@/lib/navigation";
import { Logo } from "@/components/logo";
import { MegaMenu } from "@/components/header/mega-menu";
import { MobileMenu } from "@/components/header/mobile-menu";
import { MenuTrigger } from "@/components/header/menu-trigger";
import { HeaderSearch } from "@/components/header/search";
import { AccountMenu } from "@/components/header/account-menu";
import { CartButton, WishlistButton } from "@/components/header/cart-button";
import { UtilityLinks } from "@/components/header/utility-links";

export async function SiteHeader() {
  const [nav, user, settings] = await Promise.all([
    getResolvedNav(),
    getCurrentUser(),
    getSiteSettings(),
  ]);
  const displayName = user?.name?.split(" ")[0] ?? user?.email?.split("@")[0];
  const announcements = settings.announcements;

  return (
    <>
      {announcements.length > 0 && (
        <div className="bg-ink text-paper">
          <div className="container-page flex h-9 items-center overflow-hidden">
            <div className="flex animate-marquee gap-16 whitespace-nowrap text-[11px] tracking-wide">
              {[...announcements, ...announcements].map((a, i) => (
                <span key={i} className="text-paper/80">
                  {a}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur">
        <div className="container-page">
          <div className="flex h-16 items-center gap-4">
            <MenuTrigger />
            <Logo className="h-10 shrink-0" src={settings.logoUrl} alt={settings.brand} />

            <div className="ml-4 hidden flex-1 md:block lg:ml-8">
              <HeaderSearch />
            </div>

            <div className="ml-auto flex items-center gap-0.5">
              <AccountMenu signedIn={Boolean(user)} name={displayName} />
              <WishlistButton />
              <CartButton />
            </div>
          </div>

          <div className="pb-3 md:hidden">
            <HeaderSearch />
          </div>

          <div className="hidden h-11 items-center justify-between border-t border-line/70 xl:flex">
            <MegaMenu nav={nav} />
            <UtilityLinks links={nav.utility} />
          </div>
        </div>
      </header>

      <MobileMenu nav={nav} signedIn={Boolean(user)} />
    </>
  );
}
