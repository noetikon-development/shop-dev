import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  evaluateCoupon,
  isValidCouponCode,
  normalizeCouponCode,
  type EvaluableCoupon,
} from "@/lib/coupons";
import { resolveLineImageUrl, colourValueIdOf } from "@/lib/line-image";
import {
  isEligibleForDisplayPrice,
  resolveWinningOfferView,
} from "@/lib/marketplace/buy-box-rule";
import type { FullOfferCandidate } from "@/lib/marketplace/types";

/**
 * Server-authoritative shopping cart.
 *
 * Ownership is resolved here, server-side, on every call:
 *   - a signed-in customer  -> the one ACTIVE Cart with their userId
 *   - a guest               -> the Cart whose opaque token matches the
 *                              httpOnly `axiaro_cart` cookie
 * The browser never sends a cart id / item id / price — it can only name a
 * variant and a quantity. Every mutation re-validates the variant, the product
 * and variant status, and the live commercial terms.
 *
 * Phase 9D-E: the live line price, compare-at and availability come from the
 * winning `Offer` + `OfferInventory` for the line's `Variant` (the SAME offer
 * for all three — `resolveWinningOfferView`), NOT `Variant.price` /
 * `Inventory`. `CartItem` is still keyed by `variantId` only — the winning
 * offer is resolved dynamically on every read/mutation; there is no
 * `CartItem.offerId`. When no offer is eligible the line is explicitly
 * unavailable — it never falls back to a stale `Variant` value.
 *
 * A cart is NOT a stock reservation: nothing here ever touches inventory
 * reserved counts. Checkout keeps its own independent `Inventory` row-locked
 * reservation authority (unchanged).
 */

export const GUEST_COOKIE = "axiaro_cart";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days
export const MAX_QTY_PER_LINE = 99;

// ---------------------------------------------------------------------------
// DTOs returned to the client
// ---------------------------------------------------------------------------

export type CartLineDTO = {
  key: string; // === variantId; stable per line
  productId: string;
  slug: string;
  name: string;
  variantId: string;
  sku: string;
  variantLabel: string;
  optionSummary: string;
  imageUrl: string;
  unitPrice: number; // authoritative live price — winning Offer.price (centavos)
  compareAtPrice: number | null; // winning Offer.compareAtPrice (same offer)
  priceSnapshot: number; // stored display cache — may be stale
  priceChanged: boolean; // snapshot !== live price
  quantity: number;
  available: number; // max(0, OfferInventory.quantity - OfferInventory.reserved) of the winning offer
  maxStock: number; // alias of `available` (storefront compatibility)
  lineTotal: number; // unitPrice * min(quantity, available); 0 when unavailable
  freeShipping: boolean;
  unavailable: boolean; // product/variant not purchasable at all
  overStock: boolean; // quantity > available (still fixable)
};

/**
 * The applied promo code, evaluated server-side against the current subtotal.
 * `discount` is 0 and `valid` is false when the code exists on the cart but no
 * longer applies (expired, minimum not met, …). The browser never sends this —
 * it comes from `Cart.couponCode` + `evaluateCoupon`.
 */
export type CartCouponDTO = {
  code: string;
  description: string | null;
  type: string;
  discount: number;
  valid: boolean;
  error: string | null;
};

export type CartDTO = {
  lines: CartLineDTO[];
  subtotal: number; // purchasable lines only
  itemCount: number; // sum of purchasable, buyable quantities
  hasIssues: boolean; // any line unavailable or over stock
  coupon: CartCouponDTO | null;
};

export const EMPTY_CART: CartDTO = {
  lines: [],
  subtotal: 0,
  itemCount: 0,
  hasIssues: false,
  coupon: null,
};

// ---------------------------------------------------------------------------
// Ownership resolution
// ---------------------------------------------------------------------------

type Owner =
  | { kind: "user"; userId: string }
  | { kind: "guest"; token: string }
  | null;

async function resolveOwner(): Promise<Owner> {
  const user = await getCurrentUser();
  if (user) return { kind: "user", userId: user.id };
  const token = (await cookies()).get(GUEST_COOKIE)?.value;
  if (token) return { kind: "guest", token };
  return null;
}

const cartInclude = {
  items: {
    orderBy: { createdAt: "asc" },
    include: {
      variant: {
        select: {
          id: true,
          sku: true,
          status: true,
          imageUrl: true,
          productId: true,
          product: {
            select: {
              id: true,
              slug: true,
              name: true,
              status: true,
              freeShipping: true,
              // All images, each group ordered so the first row is its primary.
              // The line image is resolved colour-aware from these (line-image.ts).
              images: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                select: { url: true, optionValueId: true },
              },
            },
          },
          // Phase 9D-E: the winning Offer supplies price / compare-at /
          // availability. Nested here so a whole cart costs ONE offers query
          // (Prisma loads it via `WHERE variantId IN (...)`), not one per line.
          offers: {
            select: {
              id: true,
              status: true,
              price: true,
              compareAtPrice: true,
              createdAt: true,
              seller: { select: { type: true, status: true } },
              inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
            },
          },
          optionValues: {
            select: {
              optionValue: {
                select: {
                  id: true,
                  value: true,
                  option: { select: { name: true, sortOrder: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;

type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>;
type CartItemRow = CartWithItems["items"][number];

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

type OfferRowForCart = {
  id: string;
  status: string;
  price: number;
  compareAtPrice: number | null;
  createdAt: Date;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};

/** Map a nested cart offer row onto the pure winning-offer input shape. */
function toOfferCandidate(o: OfferRowForCart): FullOfferCandidate {
  return {
    offerId: o.id,
    sellerId: "",
    sellerType: o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
    sellerStatus: o.seller.status as FullOfferCandidate["sellerStatus"],
    offerStatus: o.status as FullOfferCandidate["offerStatus"],
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price,
    compareAtPrice: o.compareAtPrice,
    createdAt: o.createdAt,
  };
}

function lineDTO(item: CartItemRow): CartLineDTO {
  const v = item.variant;
  const p = v.product;

  // Phase 9D-E: price / compare-at / availability all come from ONE winning
  // offer. `null` → no eligible in-stock offer → the line is unavailable; we
  // never read `Variant.price` / `Inventory` here.
  const win = resolveWinningOfferView(v.offers.map(toOfferCandidate));
  const catalogEligible = p.status === "ACTIVE" && v.status === "ACTIVE";
  const available = win?.available ?? 0;
  const unavailable = !catalogEligible || win === null || available <= 0;

  const optionSummary = v.optionValues
    .slice()
    .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
    .map((ov) => ov.optionValue.value)
    .join(" · ");

  // Struck / displayed price. Live winning-offer price when there is one;
  // otherwise the cart-local `priceSnapshot` (never `Variant.price`) so an
  // already-unavailable line never renders ₱0.
  const unitPrice = win?.price ?? item.priceSnapshot;
  const compareAtPrice = win?.compareAtPrice ?? null;
  const buyable = Math.min(item.quantity, available);

  return {
    key: v.id,
    productId: p.id,
    slug: p.slug,
    name: p.name,
    variantId: v.id,
    sku: v.sku,
    variantLabel: optionSummary,
    optionSummary,
    imageUrl: resolveLineImageUrl({
      images: p.images,
      colourValueId: colourValueIdOf(v.optionValues),
      variantImageUrl: v.imageUrl,
      slug: p.slug,
    }),
    unitPrice,
    compareAtPrice,
    priceSnapshot: item.priceSnapshot,
    priceChanged: win !== null && item.priceSnapshot !== unitPrice,
    quantity: item.quantity,
    available,
    maxStock: available,
    lineTotal: unavailable ? 0 : unitPrice * buyable,
    freeShipping: p.freeShipping,
    unavailable,
    overStock: !unavailable && item.quantity > available,
  };
}

function buildDTO(cart: CartWithItems | null, coupon: CartCouponDTO | null = null): CartDTO {
  if (!cart) return EMPTY_CART;
  const lines = cart.items.map(lineDTO);
  const purchasable = lines.filter((l) => !l.unavailable);
  return {
    lines,
    subtotal: purchasable.reduce((n, l) => n + l.lineTotal, 0),
    itemCount: purchasable.reduce((n, l) => n + Math.min(l.quantity, l.available), 0),
    hasIssues: lines.some((l) => l.unavailable || l.overStock),
    coupon,
  };
}

// ---------------------------------------------------------------------------
// Coupon evaluation for the cart / checkout display (NOT the usage-limit check —
// that happens under a row lock inside the checkout transaction).
// ---------------------------------------------------------------------------

const COUPON_EVAL_SELECT = {
  id: true,
  code: true,
  description: true,
  type: true,
  value: true,
  minSubtotal: true,
  maxDiscount: true,
  startsAt: true,
  expiresAt: true,
  active: true,
  archivedAt: true,
  usageLimit: true,
  perCustomerLimit: true,
} as const;

/** Count redemptions of a coupon that still "count" — the order is not cancelled. */
export async function activeRedemptionCount(
  couponId: string,
  userId: string | null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  return client.couponRedemption.count({
    where: {
      couponId,
      ...(userId ? { userId } : {}),
      order: { status: { not: "CANCELLED" } },
    },
  });
}

export async function evaluateCartCoupon(
  couponCode: string | null,
  subtotal: number,
): Promise<CartCouponDTO | null> {
  if (!couponCode) return null;
  const coupon = await prisma.coupon.findUnique({
    where: { code: couponCode },
    select: COUPON_EVAL_SELECT,
  });
  if (!coupon) {
    return { code: couponCode, description: null, type: "", discount: 0, valid: false, error: "Invalid coupon code." };
  }

  const evaln = evaluateCoupon(coupon as EvaluableCoupon, subtotal);
  const base = { code: coupon.code, description: coupon.description, type: coupon.type };
  if (!evaln.ok) {
    return { ...base, discount: 0, valid: false, error: evaln.error };
  }

  // Best-effort usage check for the display (the authoritative, race-safe check
  // is at checkout). Only surfaces an obvious "already used / gone" state.
  if (coupon.usageLimit != null) {
    const used = await activeRedemptionCount(coupon.id, null);
    if (used >= coupon.usageLimit) {
      return { ...base, discount: 0, valid: false, error: "This coupon is no longer available." };
    }
  }
  const user = await getCurrentUser();
  if (user && coupon.perCustomerLimit != null) {
    const mine = await activeRedemptionCount(coupon.id, user.id);
    if (mine >= coupon.perCustomerLimit) {
      return { ...base, discount: 0, valid: false, error: "You have already used this coupon." };
    }
  }

  return { ...base, discount: evaln.discount, valid: true, error: null };
}

// ---------------------------------------------------------------------------
// Read (never creates a cart or sets a cookie)
// ---------------------------------------------------------------------------

export async function loadCart(): Promise<CartDTO> {
  const owner = await resolveOwner();
  if (!owner) return EMPTY_CART;
  const where: Prisma.CartWhereInput =
    owner.kind === "user"
      ? { userId: owner.userId, status: "ACTIVE" }
      : { token: owner.token, status: "ACTIVE" };
  const cart = await prisma.cart.findFirst({ where, include: cartInclude });
  if (!cart) return EMPTY_CART;
  const dto = buildDTO(cart);
  const coupon = await evaluateCartCoupon(cart.couponCode, dto.subtotal);
  return { ...dto, coupon };
}

// ---------------------------------------------------------------------------
// Get-or-create (mutations only). Sets the guest cookie when a guest cart is
// first created — safe because this only runs inside a Server Action.
// ---------------------------------------------------------------------------

async function getOrCreateCartId(): Promise<string> {
  const user = await getCurrentUser();
  if (user) {
    const existing = await prisma.cart.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
      select: { id: true },
    });
    if (existing) return existing.id;
    try {
      const created = await prisma.cart.create({
        data: { userId: user.id, status: "ACTIVE" },
        select: { id: true },
      });
      return created.id;
    } catch {
      // Lost a race on the partial unique index — read it back.
      const again = await prisma.cart.findFirst({
        where: { userId: user.id, status: "ACTIVE" },
        select: { id: true },
      });
      if (again) return again.id;
      throw new Error("Could not open a cart");
    }
  }

  const store = await cookies();
  const token = store.get(GUEST_COOKIE)?.value;
  if (token) {
    const existing = await prisma.cart.findFirst({
      where: { token, status: "ACTIVE" },
      select: { id: true },
    });
    if (existing) return existing.id;
  }

  const newToken = randomBytes(32).toString("base64url");
  const created = await prisma.cart.create({
    data: { token: newToken, status: "ACTIVE" },
    select: { id: true },
  });
  store.set(GUEST_COOKIE, newToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE,
  });
  return created.id;
}

function clearGuestCookie(store: Awaited<ReturnType<typeof cookies>>) {
  store.set(GUEST_COOKIE, "", { path: "/", maxAge: 0 });
}

// ---------------------------------------------------------------------------
// Variant validation — the single gate every mutation passes through
// ---------------------------------------------------------------------------

type ValidatedVariant = {
  id: string;
  price: number;
  productId: string;
  productName: string;
  productSlug: string;
  available: number;
};

type ValidationResult =
  | { ok: true; variant: ValidatedVariant }
  | { ok: false; code: string; message: string };

async function validateVariant(
  variantId: string,
  expectedProductId: string | undefined,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ValidationResult> {
  const v = await client.variant.findUnique({
    where: { id: variantId },
    select: {
      id: true,
      status: true,
      productId: true,
      product: { select: { id: true, name: true, slug: true, status: true } },
      // Phase 9D-E: eligibility + price + availability from the winning Offer,
      // not `Variant.price` / `Inventory`.
      offers: {
        select: {
          id: true,
          status: true,
          price: true,
          compareAtPrice: true,
          createdAt: true,
          seller: { select: { type: true, status: true } },
          inventory: { select: { quantity: true, reserved: true, reorderPoint: true } },
        },
      },
    },
  });

  if (!v) return { ok: false, code: "NOT_FOUND", message: "That item is no longer available." };
  if (expectedProductId && v.productId !== expectedProductId) {
    return { ok: false, code: "WRONG_PRODUCT", message: "That option doesn’t belong to this product." };
  }
  if (v.product.status !== "ACTIVE") {
    return { ok: false, code: "INACTIVE_PRODUCT", message: "That product isn’t available right now." };
  }
  if (v.status !== "ACTIVE") {
    return { ok: false, code: "INACTIVE_VARIANT", message: "That option isn’t available right now." };
  }

  const candidates = v.offers.map(toOfferCandidate);
  // No ACTIVE offer from an APPROVED seller — structurally not for sale. Mirrors
  // the old "no Inventory row" branch (same customer-facing wording).
  if (!candidates.some(isEligibleForDisplayPrice)) {
    return { ok: false, code: "NO_OFFER", message: "That item isn’t available right now." };
  }

  // A sellable offer exists; `available` is 0 when every such offer is out of
  // stock → the caller returns the existing OUT_OF_STOCK message, exactly as the
  // pre-9D-E `available <= 0` path did.
  const win = resolveWinningOfferView(candidates);
  return {
    ok: true,
    variant: {
      id: v.id,
      price: win?.price ?? 0,
      productId: v.productId,
      productName: v.product.name,
      productSlug: v.product.slug,
      available: win?.available ?? 0,
    },
  };
}

/** Resolve a bare productId to its single ACTIVE variant, or null if ambiguous. */
async function soleActiveVariant(productId: string): Promise<string | null> {
  const variants = await prisma.variant.findMany({
    where: { productId, status: "ACTIVE" },
    select: { id: true },
    take: 2,
  });
  return variants.length === 1 ? variants[0].id : null;
}

async function touchCart(client: Prisma.TransactionClient | typeof prisma, cartId: string) {
  await client.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type MutationResult =
  | { ok: true; capped: boolean; finalQty: number; requestedQty: number }
  | { ok: false; code: string; error: string };

export async function addToCartCore(input: {
  productId: string;
  variantId?: string;
  quantity: number;
}): Promise<MutationResult> {
  const quantity = Math.floor(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { ok: false, code: "BAD_QUANTITY", error: "Choose a quantity of at least 1." };
  }
  const addQty = Math.min(quantity, MAX_QTY_PER_LINE);

  let variantId = input.variantId;
  if (!variantId) {
    variantId = (await soleActiveVariant(input.productId)) ?? undefined;
    if (!variantId) {
      return { ok: false, code: "NEEDS_OPTIONS", error: "Choose the options first." };
    }
  }

  const check = await validateVariant(variantId, input.productId);
  if (!check.ok) return { ok: false, code: check.code, error: check.message };
  if (check.variant.available <= 0) {
    return { ok: false, code: "OUT_OF_STOCK", error: "That item is out of stock." };
  }

  const cartId = await getOrCreateCartId();
  const cap = Math.min(check.variant.available, MAX_QTY_PER_LINE);

  const prior = await prisma.cartItem.findUnique({
    where: { cartId_variantId: { cartId, variantId } },
    select: { quantity: true },
  });
  const requestedQty = (prior?.quantity ?? 0) + addQty;

  // Atomic upsert with the cap applied inside the statement, so two concurrent
  // adds of the same variant can't push quantity past what's available.
  const rows = await prisma.$queryRaw<{ quantity: number }[]>`
    INSERT INTO "CartItem" ("id", "cartId", "variantId", "quantity", "priceSnapshot", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${cartId}, ${variantId}, LEAST(${addQty}, ${cap}), ${check.variant.price}, now(), now())
    ON CONFLICT ("cartId", "variantId") DO UPDATE
      SET "quantity" = LEAST("CartItem"."quantity" + ${addQty}, ${cap}),
          "priceSnapshot" = ${check.variant.price},
          "updatedAt" = now()
    RETURNING "quantity"`;
  await touchCart(prisma, cartId);

  const finalQty = rows[0]?.quantity ?? Math.min(addQty, cap);
  return { ok: true, capped: finalQty < requestedQty, finalQty, requestedQty };
}

export async function updateCartItemCore(input: {
  variantId: string;
  quantity: number;
}): Promise<MutationResult> {
  const quantity = Math.floor(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { ok: false, code: "BAD_QUANTITY", error: "Choose a quantity of at least 1." };
  }
  if (quantity > MAX_QTY_PER_LINE) {
    return { ok: false, code: "BAD_QUANTITY", error: `Maximum ${MAX_QTY_PER_LINE} per item.` };
  }

  const owner = await resolveOwner();
  if (!owner) return { ok: false, code: "NO_CART", error: "Your cart is empty." };
  const cart = await prisma.cart.findFirst({
    where:
      owner.kind === "user"
        ? { userId: owner.userId, status: "ACTIVE" }
        : { token: owner.token, status: "ACTIVE" },
    select: { id: true },
  });
  if (!cart) return { ok: false, code: "NO_CART", error: "Your cart is empty." };

  const check = await validateVariant(input.variantId, undefined);
  if (!check.ok) return { ok: false, code: check.code, error: check.message };
  if (check.variant.available <= 0) {
    return { ok: false, code: "OUT_OF_STOCK", error: "That item is out of stock." };
  }

  const finalQty = Math.min(quantity, check.variant.available, MAX_QTY_PER_LINE);
  const updated = await prisma.cartItem.updateMany({
    where: { cartId: cart.id, variantId: input.variantId },
    data: { quantity: finalQty, priceSnapshot: check.variant.price, updatedAt: new Date() },
  });
  if (updated.count === 0) {
    return { ok: false, code: "NOT_IN_CART", error: "That item isn’t in your cart." };
  }
  await touchCart(prisma, cart.id);

  return { ok: true, capped: finalQty < quantity, finalQty, requestedQty: quantity };
}

export async function removeCartItemCore(variantId: string): Promise<void> {
  const owner = await resolveOwner();
  if (!owner) return;
  const cart = await prisma.cart.findFirst({
    where:
      owner.kind === "user"
        ? { userId: owner.userId, status: "ACTIVE" }
        : { token: owner.token, status: "ACTIVE" },
    select: { id: true },
  });
  if (!cart) return;
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
  await touchCart(prisma, cart.id);
}

export async function clearCartCore(): Promise<void> {
  const owner = await resolveOwner();
  if (!owner) return;
  const cart = await prisma.cart.findFirst({
    where:
      owner.kind === "user"
        ? { userId: owner.userId, status: "ACTIVE" }
        : { token: owner.token, status: "ACTIVE" },
    select: { id: true },
  });
  if (!cart) return;
  await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  await prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null, updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Coupon apply / remove (Step 14)
// ---------------------------------------------------------------------------

export type CouponMutationResult =
  | { ok: true; cart: CartDTO; message: string }
  | { ok: false; error: string };

async function activeCartFor(owner: Owner): Promise<{ id: string } | null> {
  if (!owner) return null;
  return prisma.cart.findFirst({
    where:
      owner.kind === "user"
        ? { userId: owner.userId, status: "ACTIVE" }
        : { token: owner.token, status: "ACTIVE" },
    select: { id: true },
  });
}

export async function applyCartCouponCore(rawCode: string): Promise<CouponMutationResult> {
  const code = normalizeCouponCode(rawCode);
  if (!isValidCouponCode(code)) return { ok: false, error: "Invalid coupon code." };

  const owner = await resolveOwner();
  const cart = await activeCartFor(owner);
  if (!cart) return { ok: false, error: "Add items to your cart before applying a coupon." };

  // Evaluate against the CURRENT purchasable subtotal, server-side.
  const current = await prisma.cart.findUnique({ where: { id: cart.id }, include: cartInclude });
  const subtotal = buildDTO(current).subtotal;
  if (subtotal <= 0) return { ok: false, error: "Add items to your cart before applying a coupon." };

  const coupon = await prisma.coupon.findUnique({
    where: { code },
    select: COUPON_EVAL_SELECT,
  });
  if (!coupon) return { ok: false, error: "Invalid coupon code." };

  const evaln = evaluateCoupon(coupon as EvaluableCoupon, subtotal);
  if (!evaln.ok) return { ok: false, error: evaln.error };

  // Best-effort usage check (checkout re-checks under a lock).
  if (coupon.usageLimit != null && (await activeRedemptionCount(coupon.id, null)) >= coupon.usageLimit) {
    return { ok: false, error: "This coupon is no longer available." };
  }
  const user = await getCurrentUser();
  if (
    user &&
    coupon.perCustomerLimit != null &&
    (await activeRedemptionCount(coupon.id, user.id)) >= coupon.perCustomerLimit
  ) {
    return { ok: false, error: "You have already used this coupon." };
  }

  await prisma.cart.update({
    where: { id: cart.id },
    data: { couponCode: code, updatedAt: new Date() },
  });

  return { ok: true, cart: await loadCart(), message: coupon.description ?? "Coupon applied" };
}

export async function removeCartCouponCore(): Promise<CartDTO> {
  const owner = await resolveOwner();
  const cart = await activeCartFor(owner);
  if (cart) {
    await prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: null, updatedAt: new Date() },
    });
  }
  return loadCart();
}

// ---------------------------------------------------------------------------
// Guest -> customer merge
// ---------------------------------------------------------------------------

export type MergeNotice =
  | { kind: "capped"; name: string; requested: number; finalQty: number }
  | { kind: "removed"; name: string; reason: string };

export type MergeResult = { merged: boolean; notices: MergeNotice[] };

export async function mergeGuestCartCore(): Promise<MergeResult> {
  const user = await getCurrentUser();
  const store = await cookies();
  const token = store.get(GUEST_COOKIE)?.value;

  if (!user || !token) return { merged: false, notices: [] };

  const guest = await prisma.cart.findFirst({
    where: { token, status: "ACTIVE" },
    include: { items: { select: { variantId: true, quantity: true } } },
  });

  // The guest cookie has served its purpose — drop it either way.
  clearGuestCookie(store);

  if (!guest) return { merged: false, notices: [] };
  if (guest.items.length === 0) {
    await prisma.cart.delete({ where: { id: guest.id } }).catch(() => {});
    return { merged: false, notices: [] };
  }

  const targetId = await getOrCreateCartId(); // resolves to the user's ACTIVE cart
  const notices: MergeNotice[] = [];

  await prisma.$transaction(async (tx) => {
    for (const gi of guest.items) {
      const check = await validateVariant(gi.variantId, undefined, tx);
      if (!check.ok) {
        notices.push({ kind: "removed", name: "An item", reason: check.message });
        continue;
      }
      if (check.variant.available <= 0) {
        notices.push({
          kind: "removed",
          name: check.variant.productName,
          reason: "out of stock",
        });
        continue;
      }
      const existing = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId: targetId, variantId: gi.variantId } },
        select: { quantity: true },
      });
      const requested = (existing?.quantity ?? 0) + gi.quantity;
      const finalQty = Math.min(requested, check.variant.available, MAX_QTY_PER_LINE);

      await tx.cartItem.upsert({
        where: { cartId_variantId: { cartId: targetId, variantId: gi.variantId } },
        create: {
          cartId: targetId,
          variantId: gi.variantId,
          quantity: finalQty,
          priceSnapshot: check.variant.price,
        },
        update: { quantity: finalQty, priceSnapshot: check.variant.price },
      });

      if (finalQty < requested) {
        notices.push({
          kind: "capped",
          name: check.variant.productName,
          requested,
          finalQty,
        });
      }
    }

    await tx.cart.delete({ where: { id: guest.id } });
    await tx.cart.update({ where: { id: targetId }, data: { updatedAt: new Date() } });
  });

  return { merged: true, notices };
}
