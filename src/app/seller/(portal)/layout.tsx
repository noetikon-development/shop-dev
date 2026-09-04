import { redirect, forbidden } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getSellerSession } from "@/lib/seller/session";
import { SellerShell } from "@/components/seller/seller-shell";

export default async function SellerPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Unauthenticated → sign-in (proxy.ts already does this; backstop).
  const user = await getCurrentUser();
  if (!user) redirect("/seller/login");

  // Signed in but has no usable seller membership → real HTTP 403.
  const session = await getSellerSession();
  if (!session) {
    // Distinguish "no membership" from "membership exists but seller not APPROVED"
    // only in copy on the 403 page later; for now a plain forbidden().
    forbidden();
  }

  const { ctx, memberships } = session;

  return (
    <SellerShell
      sellerName={ctx.sellerName}
      sellerId={ctx.sellerId}
      role={ctx.role}
      permissions={[...ctx.permissions]}
      userEmail={user.email}
      memberships={memberships.map((m) => ({
        sellerId: m.sellerId,
        sellerName: m.sellerName,
        sellerStatus: m.sellerStatus,
      }))}
    >
      {children}
    </SellerShell>
  );
}
