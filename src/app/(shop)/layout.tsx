import { SiteHeader } from "@/components/header/site-header";
import { SiteFooter } from "@/components/footer/site-footer";
import { CartDrawer } from "@/components/cart/cart-drawer";

// This section is user- and database-driven; never prerender it at build time
// (so the deploy build doesn't depend on the database being reachable).
export const dynamic = "force-dynamic";

export default function ShopLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <CartDrawer />
    </>
  );
}
