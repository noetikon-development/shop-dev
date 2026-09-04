"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { syncAppUser } from "@/lib/auth";
import { SELLER_COOKIE } from "@/lib/seller/session";

/**
 * `/seller/login` — Supabase password sign-in, then a SELLER-plane membership
 * check. Mirrors `adminLogin` in src/lib/admin/actions.ts:
 *   - a valid Supabase credential that has no ACTIVE `SellerUser` row gets its
 *     freshly-minted session dropped on this surface, with a generic message;
 *   - being an admin grants nothing here — the planes are independent.
 * No RBAC (`UserRole`) is read or written.
 */

export type SellerLoginState = { error?: string };

export async function sellerLogin(
  _prev: SellerLoginState,
  formData: FormData,
): Promise<SellerLoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const redirectToRaw = String(formData.get("redirectTo") ?? "/seller");
  const redirectTo = redirectToRaw.startsWith("/seller") ? redirectToRaw : "/seller";

  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    return { error: "That email and password don’t match an account." };
  }

  const appUser = await syncAppUser(data.user);

  const membership = await prisma.sellerUser.findFirst({
    where: { userId: appUser.id, status: "ACTIVE" },
    select: { sellerId: true, seller: { select: { status: true } } },
  });
  if (!membership) {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "This account isn’t linked to a seller." };
  }
  if (membership.seller.status !== "APPROVED") {
    await supabase.auth.signOut({ scope: "local" });
    return { error: "Your seller account isn’t active yet. We’ll be in touch." };
  }

  // Default the seller switcher to this membership.
  const jar = await cookies();
  jar.set(SELLER_COOKIE, membership.sellerId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });

  revalidatePath("/", "layout");
  redirect(redirectTo);
}

export async function sellerSignOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const jar = await cookies();
  jar.delete(SELLER_COOKIE);
  revalidatePath("/", "layout");
  redirect("/seller/login");
}

/** Switch the active seller (only among the user's own ACTIVE, APPROVED memberships). */
export async function switchSellerAction(formData: FormData): Promise<void> {
  const sellerId = String(formData.get("sellerId") ?? "");
  if (!sellerId) return;
  const { listSellerMemberships } = await import("@/lib/seller/session");
  const memberships = await listSellerMemberships();
  const target = memberships.find(
    (m) => m.sellerId === sellerId && m.sellerStatus === "APPROVED",
  );
  if (!target) return;

  const jar = await cookies();
  jar.set(SELLER_COOKIE, sellerId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  });
  revalidatePath("/seller", "layout");
}
