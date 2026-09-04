import type { Metadata } from "next";

// The seller portal never renders the storefront header/footer (those belong to
// the (shop) route group) nor the admin chrome. Authentication for everything
// except /seller/login is enforced in proxy.ts (unauthenticated → /seller/login);
// the seller-membership check for signed-in users lives in (portal)/layout.tsx.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Seller · Axiaro", template: "%s · Axiaro Seller" },
  robots: { index: false, follow: false },
};

export default function SellerRootLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-surface-sunken text-ink">{children}</div>;
}
