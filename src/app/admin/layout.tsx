import type { Metadata } from "next";

// The admin area never renders the storefront header/footer (those belong to
// the (shop) route group). Authentication for everything except /admin/login is
// enforced in proxy.ts (unauthenticated → /admin/login) and the role check for
// signed-in users lives in (shell)/layout.tsx.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Admin · Axiaro", template: "%s · Axiaro Admin" },
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-surface-sunken text-ink">{children}</div>;
}
