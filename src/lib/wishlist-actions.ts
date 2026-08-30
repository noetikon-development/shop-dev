"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import {
  getWishlistProductIds,
  loadWishlist,
  toggleWishlist as toggleWishlistCore,
  removeFromWishlist,
  type WishlistCard,
} from "@/lib/wishlist";

/**
 * Wishlist server actions (Step 15). Every action resolves the user server-side;
 * an unauthenticated caller gets `{ needsAuth: true }` and the UI prompts a
 * sign-in. No action accepts a userId from the client.
 */

export type WishlistResult =
  | { ok: true; wished: boolean; ids: string[] }
  | { ok: false; needsAuth?: boolean; error?: string };

const productIdSchema = z.object({ productId: z.string().min(1).max(64) });

export async function getWishlistIds(): Promise<string[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  return getWishlistProductIds(user.id);
}

export async function getWishlist(): Promise<WishlistCard[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  return loadWishlist(user.id);
}

export async function toggleWishlistItem(input: unknown): Promise<WishlistResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, needsAuth: true };

  const parsed = productIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const { wished } = await toggleWishlistCore(user.id, parsed.data.productId);
  const ids = await getWishlistProductIds(user.id);
  revalidatePath("/account/wishlist");
  return { ok: true, wished, ids };
}

export async function removeWishlistItem(input: unknown): Promise<WishlistResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, needsAuth: true };

  const parsed = productIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  await removeFromWishlist(user.id, parsed.data.productId);
  const ids = await getWishlistProductIds(user.id);
  revalidatePath("/account/wishlist");
  return { ok: true, wished: false, ids };
}
