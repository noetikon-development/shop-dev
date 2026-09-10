import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { commitOfferStockForSale } from "@/lib/marketplace/offer-inventory";
import { resolveSellerCommissionBps } from "@/lib/marketplace/commission";
import { loadCart, activeRedemptionCount } from "@/lib/cart";
import { evaluateCoupon, type EvaluableCoupon } from "@/lib/coupons";
import { getCustomerAddresses, type AddressDTO } from "@/lib/addresses";
import { resolveLineImageUrl, colourValueIdOf } from "@/lib/line-image";
import { scheduleEmail } from "@/lib/email/schedule";
import {
  sendOrderConfirmation,
  sendOrderReceivedOps,
  sendSellerOrderReceived,
} from "@/lib/email/notifications";
import { getPaymentsConfig } from "@/lib/payments/config";
import { writeAudit } from "@/lib/admin/audit";
import { shouldAutoConfirmAtCheckout } from "@/lib/orders/status";
import { ORDER_STATUS_META } from "@/lib/constants";
import {
  getActiveShippingMethods,
  getFreeShippingThreshold,
  getSupportedShippingCountries,
  isSupportedShippingCurrency,
  resolveActiveShippingMethod,
  effectiveShippingFee,
  type ShippingMethodDTO,
} from "@/lib/shipping";

/**
 * Checkout + order creation (Step 9, shipping added in Step 11; offer-native
 * writer in Phase 9E-3C-2).
 *
 * The order is created ONLY here, server-side. The browser never sends items,
 * prices, shipping amounts or totals — `createOrderFromCart` re-reads the
 * customer's ACTIVE cart, re-validates every line against the live product /
 * variant / OFFER / OfferInventory / price, LOADS the chosen shipping method
 * and its rate from the database, recalculates the total, and does the whole
 * thing (cart -> CONVERTED, OfferInventory SALE commit, Parent Order + one
 * SellerOrder + OrderItems) inside one transaction. Payment is a later step:
 * orders are created PENDING_PAYMENT and are never marked paid here.
 *
 * Phase 9E-3C-2 — marketplace-native, still single-seller:
 *   - the checkout PRICE is the bound `CartItem.offer.price` (9E-2). It is
 *     NEVER re-picked with `resolveWinningOfferView`; `CartItem.offerId` is
 *     authoritative for this checkout attempt. `Variant.price` is no longer
 *     read for checkout pricing and there is no fallback to it.
 *   - availability is `OfferInventory` (quantity - reserved), never
 *     `Variant.stock`.
 *   - a cart must resolve to exactly ONE distinct Seller. Two sellers ->
 *     the whole checkout aborts before any write. This is a PERMANENT gate,
 *     NOT the `marketplace.multiSellerCheckout` flag: that flag only controls
 *     whether THIRD_PARTY offers may go ACTIVE / appear on the storefront (it
 *     is `"true"` for the 3P pilot). Real multi-seller checkout (multiple
 *     SellerOrders per Order) is a future phase; until it ships, this
 *     `sellerIds.size !== 1` abort is unconditional.
 *   - every new order gets exactly one `SellerOrder`; every `OrderItem` is
 *     linked to it and snapshots `offerId` / `sellerId` / `commissionRate`.
 *
 * Phase 9E-3D-5 — offer-chain inventory: the SALE stock commit is
 * `OfferInventory` ONLY (`commitOfferStockForSale` + `OfferAdjustment(SALE)`).
 * The legacy `Inventory` SALE mirror and its `InventoryAdjustment` row are no
 * longer written. `InventoryAdjustment` is a FROZEN historical ledger from the
 * 9E-3D-5 deploy onward — new SALE / CANCELLATION / RETURN movements live only
 * in `OfferAdjustment`. The admin manual stock edit (`inventory-actions.ts`)
 * stays dual-store until Phase 9E-3D-6.
 */

/** 9E-3B §15 — round to the nearest centavo, halves away from zero. */
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

// ---------------------------------------------------------------------------
// Checkout data for the page (server-calculated — the client only displays it)
// ---------------------------------------------------------------------------

export type CheckoutLine = {
  variantId: string;
  productId: string;
  slug: string;
  name: string;
  optionSummary: string;
  sku: string;
  imageUrl: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  available: number;
  unavailable: boolean;
  overStock: boolean;
  priceChanged: boolean;
};

export type CheckoutShippingMethod = ShippingMethodDTO & {
  /** Rate after the store-wide free-shipping rule for the current subtotal. */
  effectiveRate: number;
  freeApplied: boolean;
};

export type CheckoutCoupon = {
  code: string;
  description: string | null;
  discount: number;
  valid: boolean;
  error: string | null;
};

export type CheckoutSummary = {
  lines: CheckoutLine[];
  itemCount: number;
  subtotal: number;
  freeShippingThreshold: number;
  shippingMethods: CheckoutShippingMethod[];
  coupon: CheckoutCoupon | null;
  discountTotal: number;
  pricesChanged: boolean;
  /** Non-null = checkout can't proceed; the client sends the customer back to the cart. */
  blocked: null | "EMPTY" | "UNAVAILABLE" | "OVERSTOCK";
};

export type CheckoutData = {
  email: string;
  summary: CheckoutSummary;
  addresses: AddressDTO[];
  defaultShippingId: string | null;
  defaultBillingId: string | null;
  /** Payment options at checkout (Phase 6B–6C).
   *  - `cod`     — "Pay on delivery" is offered (`payments.enabledMethods` has COD).
   *  - `online`  — a PayMongo hosted checkout can be started (`methods` = the
   *                lowercased non-COD methods, e.g. ["card","gcash"]).
   *  - `testMode`— the configured PayMongo mode is "test".
   *  When both `cod` and `online` are true the customer chooses one; when only
   *  one is true that path is used with no extra UI. */
  payment: { cod: boolean; online: boolean; methods: string[]; testMode: boolean };
};

function withEffectiveRates(
  methods: ShippingMethodDTO[],
  subtotal: number,
  freeThreshold: number,
): CheckoutShippingMethod[] {
  return methods.map((m) => {
    const effectiveRate = effectiveShippingFee(m.rate, subtotal, freeThreshold);
    return { ...m, effectiveRate, freeApplied: effectiveRate === 0 && m.rate > 0 };
  });
}

export async function getCheckoutData(): Promise<CheckoutData> {
  const user = await getCurrentUser();
  if (!user) {
    // The page also guards with requireUser(); this keeps the type honest.
    return {
      email: "",
      summary: await emptySummary(),
      addresses: [],
      defaultShippingId: null,
      defaultBillingId: null,
      payment: { cod: true, online: false, methods: [], testMode: false },
    };
  }

  const [cart, addresses, methods, freeThreshold, paymentsConfig] = await Promise.all([
    loadCart(),
    getCustomerAddresses(),
    getActiveShippingMethods(),
    getFreeShippingThreshold(),
    getPaymentsConfig(),
  ]);

  const enabledMethods = paymentsConfig.enabledMethods.map((m) => m.toUpperCase());
  const onlineMethods = paymentsConfig.sessionsEnabled
    ? enabledMethods.filter((m) => m !== "COD").map((m) => m.toLowerCase())
    : [];
  const payment = {
    // COD is the default channel; it stays available unless explicitly removed
    // from `payments.enabledMethods`.
    cod: enabledMethods.length === 0 || enabledMethods.includes("COD"),
    online: paymentsConfig.sessionsEnabled && onlineMethods.length > 0,
    methods: onlineMethods,
    testMode: paymentsConfig.mode === "test",
  };

  const lines: CheckoutLine[] = cart.lines.map((l) => ({
    variantId: l.variantId,
    productId: l.productId,
    slug: l.slug,
    name: l.name,
    optionSummary: l.optionSummary,
    sku: l.sku,
    imageUrl: l.imageUrl,
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    lineTotal: l.unavailable ? 0 : l.unitPrice * Math.min(l.quantity, l.available),
    available: l.available,
    unavailable: l.unavailable,
    overStock: l.overStock,
    priceChanged: l.priceChanged,
  }));

  const purchasable = lines.filter((l) => !l.unavailable);
  const subtotal = purchasable.reduce((n, l) => n + l.lineTotal, 0);

  let blocked: CheckoutSummary["blocked"] = null;
  if (purchasable.length === 0) blocked = "EMPTY";
  else if (lines.some((l) => l.unavailable)) blocked = "UNAVAILABLE";
  else if (lines.some((l) => l.overStock)) blocked = "OVERSTOCK";

  // The coupon is server-evaluated by loadCart() against this same subtotal.
  const coupon: CheckoutCoupon | null = cart.coupon
    ? {
        code: cart.coupon.code,
        description: cart.coupon.description,
        discount: cart.coupon.discount,
        valid: cart.coupon.valid,
        error: cart.coupon.error,
      }
    : null;
  const discountTotal = coupon?.valid ? coupon.discount : 0;

  return {
    email: user.email,
    summary: {
      lines,
      itemCount: purchasable.reduce((n, l) => n + Math.min(l.quantity, l.available), 0),
      subtotal,
      freeShippingThreshold: freeThreshold,
      shippingMethods: withEffectiveRates(methods, subtotal, freeThreshold),
      coupon,
      discountTotal,
      pricesChanged: lines.some((l) => l.priceChanged),
      blocked,
    },
    addresses,
    defaultShippingId: addresses.find((a) => a.defaultShipping)?.id ?? addresses[0]?.id ?? null,
    defaultBillingId: addresses.find((a) => a.defaultBilling)?.id ?? addresses[0]?.id ?? null,
    payment,
  };
}

async function emptySummary(): Promise<CheckoutSummary> {
  const [methods, freeThreshold] = await Promise.all([
    getActiveShippingMethods(),
    getFreeShippingThreshold(),
  ]);
  return {
    lines: [],
    itemCount: 0,
    subtotal: 0,
    freeShippingThreshold: freeThreshold,
    shippingMethods: withEffectiveRates(methods, 0, freeThreshold),
    coupon: null,
    discountTotal: 0,
    pricesChanged: false,
    blocked: "EMPTY",
  };
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

export type PlaceOrderInput = {
  shippingAddressId: string;
  billingAddressId: string;
  shippingMethodId: string;
  note?: string;
};

export type PlaceOrderCode =
  | "AUTH"
  | "VALIDATION"
  | "EMPTY"
  | "CART_GONE"
  | "ADDRESS"
  | "SHIPPING"
  | "COUPON"
  | "STOCK"
  | "SELLER" // cart resolves to != 1 distinct seller, or a bound offer/seller is no longer eligible
  | "ALREADY_ORDERED";

export type PlaceOrderResult =
  | { ok: true; orderNumber: string; duplicate: boolean }
  | { ok: false; error: string; code: PlaceOrderCode };

class CheckoutError extends Error {
  code: PlaceOrderCode;
  constructor(code: PlaceOrderCode, message: string) {
    super(message);
    this.code = code;
  }
}

function addressSnapshot(a: {
  label: string;
  firstName: string;
  lastName: string;
  recipient: string;
  company: string | null;
  phone: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  region: string | null;
  postalCode: string;
  country: string;
}) {
  return {
    label: a.label,
    firstName: a.firstName,
    lastName: a.lastName,
    recipient: a.recipient, // kept for the existing order-detail address renderer
    company: a.company,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    barangay: a.barangay,
    city: a.city,
    province: a.province,
    region: a.region,
    postalCode: a.postalCode,
    country: a.country,
  };
}

async function nextOrderNumber(): Promise<string> {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const rows = await prisma.$queryRaw<{ v: bigint }[]>`SELECT nextval('order_number_seq') AS v`;
  // `order_number_seq` is MINVALUE 100001, so `v` is always 6+ digits — the
  // padStart is a historical no-op kept for clarity, never a truncation.
  return `AX-${stamp}-${String(rows[0].v).padStart(5, "0")}`;
}

const cartForOrder = {
  items: {
    orderBy: { createdAt: "asc" },
    include: {
      // Phase 9E-3C-2: the BOUND offer (never re-picked) — the checkout price,
      // its seller and its OfferInventory. Nested so a whole cart costs one
      // offer + one seller + one offer-inventory query, never one per line.
      offer: {
        select: {
          id: true,
          status: true,
          price: true,
          compareAtPrice: true,
          variantId: true,
          // 9F-22: snapshotted onto each OrderItem so order/email records survive
          // a later Offer.condition edit. Never re-picked — this is the bound offer.
          condition: true,
          seller: {
            select: {
              id: true,
              displayName: true,
              type: true,
              status: true,
              supportEmail: true,
              commissionRate: true,
            },
          },
          inventory: { select: { quantity: true, reserved: true } },
        },
      },
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
              // All images, each group ordered so the first row is its primary;
              // the OrderItem snapshot is resolved colour-aware from these.
              images: {
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                select: { url: true, optionValueId: true },
              },
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

export async function createOrderFromCart(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, code: "AUTH", error: "Please sign in to place your order." };

  // Shipping method — loaded fresh from the DB, must exist AND be active. The
  // browser only names an id; the rate always comes from here.
  const method = await resolveActiveShippingMethod(input.shippingMethodId);
  if (!method) {
    return { ok: false, code: "SHIPPING", error: "That delivery method isn’t available. Please choose another." };
  }
  if (!isSupportedShippingCurrency(method.currency)) {
    return { ok: false, code: "SHIPPING", error: "That delivery method can’t be used right now." };
  }
  const note = (input.note ?? "").trim().slice(0, 500);

  // 1. The customer's live ACTIVE cart.
  const cart = await prisma.cart.findFirst({
    where: { userId: user.id, status: "ACTIVE" },
    include: cartForOrder,
  });
  if (!cart) {
    // No ACTIVE cart. If the customer just checked out (e.g. a double-click
    // where the other request already converted the cart), hand back that
    // order instead of an error.
    const recent = await prisma.order.findFirst({
      where: {
        userId: user.id,
        cart: { status: "CONVERTED" },
        placedAt: { gte: new Date(Date.now() - 2 * 60 * 1000) },
      },
      orderBy: { placedAt: "desc" },
      select: { orderNumber: true },
    });
    if (recent) return { ok: true, orderNumber: recent.orderNumber, duplicate: true };
    return {
      ok: false,
      code: "CART_GONE",
      error: "Your cart is empty or has already been checked out.",
    };
  }
  if (cart.items.length === 0) {
    return { ok: false, code: "EMPTY", error: "Your cart is empty." };
  }

  // 2. Both addresses must belong to this customer (no IDOR).
  const [shipAddr, billAddr] = await Promise.all([
    prisma.address.findUnique({ where: { id: input.shippingAddressId } }),
    prisma.address.findUnique({ where: { id: input.billingAddressId } }),
  ]);
  if (!shipAddr || shipAddr.userId !== user.id) {
    return { ok: false, code: "ADDRESS", error: "Choose a valid shipping address." };
  }
  if (!billAddr || billAddr.userId !== user.id) {
    return { ok: false, code: "ADDRESS", error: "Choose a valid billing address." };
  }

  // 2b. The shipping destination must be a country the store delivers to.
  const supportedCountries = await getSupportedShippingCountries();
  if (!supportedCountries.includes((shipAddr.country || "").toUpperCase())) {
    return {
      ok: false,
      code: "SHIPPING",
      error: "We don’t deliver to that address yet. Choose a different shipping address.",
    };
  }

  // 3. Re-validate every line against authoritative data — the BOUND Offer
  //    (`CartItem.offerId`, 9E-2), its Seller and its OfferInventory. The Offer
  //    is NEVER re-picked; `resolveWinningOfferView` is not called here. Build
  //    order lines at the bound Offer's price.
  const GENERIC_SELLER_ERROR =
    "We couldn’t complete your order. Please review your cart and try again.";

  const problems: string[] = [];
  const sellerIds = new Set<string>();
  let seller:
    | {
        id: string;
        displayName: string;
        type: string;
        status: string;
        supportEmail: string;
        commissionRate: number;
      }
    | null = null;
  const lines: {
    productId: string;
    variantId: string;
    offerId: string;
    sellerId: string;
    name: string;
    variantLabel: string | null;
    sku: string;
    imageUrl: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    condition: string;
    // 9F-38B: the bound Offer's compare-at ("was") price snapshot, or null when
    // the Offer has no compare-at. Display/history only — never enters a total.
    originalUnitPrice: number | null;
  }[] = [];

  for (const item of cart.items) {
    const v = item.variant;
    const p = v.product;
    const o = item.offer; // the BOUND offer — authoritative for this checkout attempt

    // Bound-offer integrity. `CartItem.offerId` is NOT NULL (9E-2); the FK
    // guarantees the row exists unless the Offer was deleted mid-checkout.
    if (!o || !item.offerId || o.variantId !== item.variantId) {
      problems.push(`“${p.name}” is no longer available.`);
      continue;
    }

    const catalogEligible = p.status === "ACTIVE" && v.status === "ACTIVE";
    const offerLive = o.status === "ACTIVE" && o.seller.status === "APPROVED";
    if (!catalogEligible || !offerLive) {
      problems.push(`“${p.name}” is no longer available.`);
      continue;
    }

    // Availability from OfferInventory (quantity - reserved) — NEVER Variant.stock.
    const available = o.inventory
      ? Math.max(0, o.inventory.quantity - o.inventory.reserved)
      : 0;
    if (!o.inventory || available < item.quantity) {
      problems.push(
        `“${p.name}” — only ${available} left, but your cart has ${item.quantity}.`,
      );
      continue;
    }

    sellerIds.add(o.seller.id);
    seller = o.seller;

    const optionSummary = v.optionValues
      .slice()
      .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
      .map((ov) => ov.optionValue.value)
      .join(" · ");

    lines.push({
      productId: p.id,
      variantId: v.id,
      offerId: o.id,
      sellerId: o.seller.id,
      name: p.name,
      variantLabel: optionSummary || null,
      sku: v.sku,
      imageUrl: resolveLineImageUrl({
        images: p.images,
        colourValueId: colourValueIdOf(v.optionValues),
        variantImageUrl: v.imageUrl,
        slug: p.slug,
      }),
      unitPrice: o.price, // the BOUND Offer price — the authoritative checkout price
      quantity: item.quantity,
      lineTotal: o.price * item.quantity,
      condition: o.condition, // 9F-22 snapshot — the bound offer's condition
      // 9F-38B snapshot — the bound Offer's compare-at ("was") price at purchase
      // time. Already loaded on `o` (never re-picked). Null when the Offer had no
      // compare-at. Display/history only; never summed into a total.
      originalUnitPrice: o.compareAtPrice ?? null,
    });
  }

  if (problems.length > 0) {
    return {
      ok: false,
      code: "STOCK",
      error: `${problems.join(" ")} Update your cart and try again.`,
    };
  }
  if (lines.length === 0 || !seller) {
    return { ok: false, code: "EMPTY", error: "Your cart has nothing available to order." };
  }

  // 3b. Single-seller gate (9E-3C-2). This is UNCONDITIONAL — it does NOT read
  //     `marketplace.multiSellerCheckout` (that flag only governs 3P offer
  //     visibility, and is `"true"` for the pilot). Real multi-seller checkout
  //     is a future phase; until it ships, a cart MUST resolve to exactly one
  //     distinct Seller or the whole checkout aborts before any write. The
  //     customer-facing message is deliberately generic.
  if (sellerIds.size !== 1) {
    return { ok: false, code: "SELLER", error: GENERIC_SELLER_ERROR };
  }
  // `seller` is non-null here (set for every line; `lines` is non-empty). A
  // `const` alias so the closure below keeps the narrowing.
  const soSeller = seller;

  // 9F-15B: a THIRD_PARTY pay-on-delivery order has no payment step to clear —
  // auto-confirm the parent Order at checkout (PENDING_PAYMENT → PROCESSING) so
  // the seller can Accept it straight away. Every order this function creates is
  // COD (`paymentMethod` "NONE"); a future online order confirms via its payment
  // webhook. FIRST_PARTY orders keep the manual admin "Confirm order" flow.
  const autoConfirmParent = shouldAutoConfirmAtCheckout({
    sellerType: soSeller.type,
    paymentMethod: "NONE",
  });

  // 9F-33A — invariant. `createOrderFromCart` only ever creates a COD
  // (`paymentMethod: "NONE"`) order, so a THIRD_PARTY order MUST auto-confirm:
  // `shouldAutoConfirmAtCheckout({ sellerType: "THIRD_PARTY", paymentMethod: "NONE" })`
  // is `true` by construction. Before 9F-15B, a 3P COD order was created at
  // `PENDING_PAYMENT` (like a 1P COD order) and relied on an admin clicking
  // "Confirm order"; if nobody did, the order had NO forward path — the seller
  // can't Accept while the parent isn't fulfillable (`canTransitionSellerOrder`
  // requires `isParentOrderFulfillable`). That state is now structurally
  // unreachable; this belt-and-braces check (a sibling of the "4c-iv" one-seller
  // safety assert below) keeps it unreachable even if `shouldAutoConfirmAtCheckout`
  // is later changed. It fires BEFORE any write, so a violation is a clean no-op.
  //
  // NOTE: when online payment for 3P sellers lands (PayMongo 6D), a paid-online
  // 3P order legitimately stays `PENDING_PAYMENT` until its verified webhook —
  // this guard must be re-scoped to the COD case then (it already is, implicitly,
  // because this function only creates COD orders).
  if (soSeller.type === "THIRD_PARTY" && !autoConfirmParent) {
    console.error(
      "[checkout] 9F-33A invariant violation: a THIRD_PARTY COD order would be created at PENDING_PAYMENT with no forward path — refusing.",
      { sellerId: soSeller.id },
    );
    return {
      ok: false,
      code: "VALIDATION",
      error: "We couldn’t complete your order. Please try again.",
    };
  }

  // 4. Server-authoritative totals. `subtotal` is Σ (bound Offer.price × qty).
  //    The shipping fee is the ACTIVE method's current DB rate (after the
  //    store-wide free-shipping rule) — never a browser value.
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const freeThreshold = await getFreeShippingThreshold();
  const shippingFee = effectiveShippingFee(method.rate, subtotal, freeThreshold);
  // The per-seller free-shipping result for the SellerOrder snapshot (9E-3B):
  // true only when the store threshold actually zeroed a non-zero method rate.
  const freeShippingApplied =
    freeThreshold > 0 && subtotal >= freeThreshold && method.rate > 0;

  // 4b. Coupon — re-read the code stored on the cart, re-validate against the
  //     recalculated subtotal and the server clock. The browser never sends a
  //     discount. Usage limits are checked under a row lock inside the
  //     transaction below. The discount applies to the merchandise subtotal
  //     only — shipping is untouched (Step 14 §16).
  const now = new Date();
  let coupon: {
    id: string;
    code: string;
    type: string;
    value: number;
    usageLimit: number | null;
    perCustomerLimit: number | null;
  } | null = null;
  let discountTotal = 0;
  if (cart.couponCode) {
    const c = await prisma.coupon.findUnique({
      where: { code: cart.couponCode },
      select: {
        id: true,
        code: true,
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
      },
    });
    if (!c) {
      return { ok: false, code: "COUPON", error: "The coupon on your cart is no longer valid. Remove it and try again." };
    }
    const evaln = evaluateCoupon(c as EvaluableCoupon, subtotal, now);
    if (!evaln.ok) {
      return { ok: false, code: "COUPON", error: `${c.code}: ${evaln.error} Remove it and try again.` };
    }
    coupon = {
      id: c.id,
      code: c.code,
      type: c.type,
      value: c.value,
      usageLimit: c.usageLimit,
      perCustomerLimit: c.perCustomerLimit,
    };
    discountTotal = evaln.discount;
  }

  const grandTotal = Math.max(0, subtotal + shippingFee - discountTotal);

  // SellerOrder money (9E-3B). One seller this phase, so it carries the whole
  // order: merchandise = subtotal, discountAllocated = the full discount,
  // shippingFee = the whole order's shipping. total must equal grandTotal.
  //
  // 9F-39B: resolve the commission rate for THIS new order. FIRST_PARTY → 0;
  // THIRD_PARTY → the seller's own stored `Seller.commissionRate` (unchanged
  // behaviour — the CMS global default only seeds a new seller's rate, it never
  // re-prices an existing seller or a historical order). The resolved value is
  // frozen onto SellerOrder / OrderItem below; nothing here reads the CMS
  // setting, and no historical order is ever revisited.
  const commissionRateBps = resolveSellerCommissionBps(soSeller);
  const sellerCommissionAmount = roundHalfUp((subtotal * commissionRateBps) / 10000);
  const sellerOrderTotal = subtotal - discountTotal + shippingFee;

  const orderNumber = await nextOrderNumber();
  const sameAddress = input.shippingAddressId === input.billingAddressId;
  const shippingJson = JSON.stringify(addressSnapshot(shipAddr));
  const billingJson = sameAddress ? null : JSON.stringify(addressSnapshot(billAddr));

  try {
    const created = await prisma.$transaction(async (tx) => {
      // 4a. Atomic ACTIVE -> CONVERTED. This is the double-submission /
      //     concurrency gate: a second request finds 0 rows and aborts.
      const converted = await tx.$executeRaw`
        UPDATE "Cart" SET "status" = 'CONVERTED', "updatedAt" = now()
        WHERE "id" = ${cart.id} AND "status" = 'ACTIVE'`;
      if (converted === 0) {
        throw new CheckoutError("ALREADY_ORDERED", "This cart has already been checked out.");
      }

      // 4a-ii. Coupon usage limits — race-safe. Lock the Coupon row for the rest
      //   of this transaction, then COUNT redemptions whose order isn't
      //   CANCELLED. Two concurrent checkouts of a last-use coupon serialise
      //   here: the second sees the first's redemption and is rejected.
      if (coupon) {
        await tx.$queryRaw`SELECT "id" FROM "Coupon" WHERE "id" = ${coupon.id} FOR UPDATE`;
        if (coupon.usageLimit != null) {
          const usedGlobal = await activeRedemptionCount(coupon.id, null, tx);
          if (usedGlobal >= coupon.usageLimit) {
            throw new CheckoutError("COUPON", `${coupon.code}: this coupon is no longer available. Remove it and try again.`);
          }
        }
        if (coupon.perCustomerLimit != null) {
          const usedMine = await activeRedemptionCount(coupon.id, user.id, tx);
          if (usedMine >= coupon.perCustomerLimit) {
            throw new CheckoutError("COUPON", `${coupon.code}: you have already used this coupon. Remove it and try again.`);
          }
        }
      }

      // 4b. Commit stock. MVP (9E-3B §11): committed at order creation — online
      //     payment is dormant, so there is no reservation hold.
      //
      //     Phase 9E-3D-5: `OfferInventory` is the ONLY inventory mutation for a
      //     new offer-native order — the row-locked `commitOfferStockForSale`
      //     (guards quantity < 0 / < reserved) plus its `OfferAdjustment(SALE)`.
      //     The legacy `Inventory` SALE mirror + its `InventoryAdjustment` row
      //     are NOT written any more. `InventoryAdjustment` is a frozen archive
      //     of pre-retirement operations from the 9E-3D-5 deploy onward; new
      //     SALEs live only in `OfferAdjustment`.
      //
      //     Any failure rolls the whole transaction back (incl. cart conversion).
      for (const l of lines) {
        const offerRes = await commitOfferStockForSale(
          { offerId: l.offerId, units: l.quantity, note: `Order ${orderNumber}`, actorUserId: user.id },
          tx,
        );
        if (!offerRes.ok) {
          throw new CheckoutError(
            "STOCK",
            `“${l.name}” just sold out. Your order was not placed.`,
          );
        }
      }

      // 4c. The Parent Order — the customer / payment / billing / coupon /
      //     grand-total record. Unchanged from the customer's point of view.
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId: user.id,
          cartId: cart.id,
          email: user.email,
          phone: shipAddr.phone,
          // 9F-15B: THIRD_PARTY COD orders are auto-confirmed at creation so the
          // seller can Accept them immediately. paymentMethod / paymentStatus
          // are NOT touched — COD is still collected on delivery.
          status: autoConfirmParent ? "PROCESSING" : "PENDING_PAYMENT",
          paymentMethod: "NONE",
          paymentStatus: "PENDING",
          subtotal,
          shippingFee,
          discountTotal,
          grandTotal,
          // Coupon: live link + immutable snapshot (Step 14).
          couponId: coupon?.id ?? null,
          couponCode: coupon?.code ?? null,
          discountType: coupon?.type ?? null,
          discountValue: coupon?.value ?? null,
          // Shipping method: live link + immutable snapshot (Step 11).
          shippingMethodId: method.id,
          shippingMethod: method.code,
          shippingMethodCode: method.code,
          shippingMethodName: method.name,
          addressId: shipAddr.id,
          billingAddressId: billAddr.id,
          shippingAddress: shippingJson,
          billingAddress: billingJson,
          note: note || null,
          events: {
            create: [
              {
                status: "PENDING_PAYMENT",
                title: "Order placed",
                detail: "We’ve received your order. Payment is arranged on delivery.",
              },
              // 9F-15B: the auto-confirm milestone — same OrderEvent the admin
              // "Confirm order" action writes (title / detail from ORDER_STATUS_META).
              ...(autoConfirmParent
                ? [
                    {
                      status: "PROCESSING",
                      title: "Preparing your order",
                      detail: ORDER_STATUS_META.PROCESSING?.description ?? null,
                    },
                  ]
                : []),
            ],
          },
        },
        select: { id: true, orderNumber: true },
      });

      // 4c-ii. Exactly ONE SellerOrder (9E-3C-2). Its money comes from THIS
      //     checkout's calculated values — never a recomputation of history.
      const sellerOrder = await tx.sellerOrder.create({
        data: {
          orderId: order.id,
          sellerId: soSeller.id,
          sellerName: soSeller.displayName,
          sellerType: soSeller.type,
          supportEmail: soSeller.supportEmail,
          commissionRate: commissionRateBps, // 9F-39B: the resolved rate, frozen
          shippingMethodCode: method.code,
          shippingMethodName: method.name,
          shippingFee,
          platformShippingSubsidy: 0,
          freeShippingApplied,
          merchandiseSubtotal: subtotal,
          discountAllocated: discountTotal,
          discountFundedBy: "PLATFORM",
          commissionAmount: sellerCommissionAmount,
          total: sellerOrderTotal,
          status: "PENDING_PAYMENT",
          settlementStatus: "PENDING_CAPTURE",
        },
        select: { id: true },
      });

      // 4c-iii. OrderItems — linked to BOTH the Order and its one SellerOrder,
      //     snapshotting the bound Offer / Seller / commission rate. `unitPrice`
      //     is the bound Offer price (set when `lines` was built).
      await tx.orderItem.createMany({
        data: lines.map((l) => ({
          orderId: order.id,
          sellerOrderId: sellerOrder.id,
          productId: l.productId,
          variantId: l.variantId,
          offerId: l.offerId,
          sellerId: l.sellerId,
          commissionRate: commissionRateBps, // 9F-39B: the resolved rate, frozen
          name: l.name,
          variantLabel: l.variantLabel,
          sku: l.sku,
          imageUrl: l.imageUrl,
          unitPrice: l.unitPrice,
          quantity: l.quantity,
          lineTotal: l.lineTotal,
          // 9F-22: faithful snapshot of the bound Offer's condition at purchase
          // time (incl. "NEW"). Display code shows a condition line only when this
          // is a non-NEW value; nothing re-picks the offer.
          condition: l.condition,
          // 9F-38B: the bound Offer's compare-at ("was") price snapshot (null when
          // the Offer had no compare-at). Historical/display only — the customer
          // pays `unitPrice`; this value is never added to any total.
          originalUnitPrice: l.originalUnitPrice,
        })),
      });

      // 4c-iv. One-seller safety (9E-3C-2 §20). Belt-and-braces: we created
      //     exactly one SellerOrder above; assert it and that every line links
      //     to it before the transaction commits.
      const soCount = await tx.sellerOrder.count({ where: { orderId: order.id } });
      const linkedItems = await tx.orderItem.count({
        where: { orderId: order.id, sellerOrderId: sellerOrder.id, sellerId: soSeller.id },
      });
      if (soCount !== 1 || linkedItems !== lines.length) {
        throw new CheckoutError("VALIDATION", "We couldn’t complete your order. Please try again.");
      }

      // 4d. Record the coupon redemption (authoritative for usage limits) and
      //     bump the loose display mirror. The row is written inside the same
      //     locked section, so the count a concurrent checkout sees is correct.
      if (coupon) {
        await tx.couponRedemption.create({
          data: {
            couponId: coupon.id,
            userId: user.id,
            orderId: order.id,
            code: coupon.code,
            amount: discountTotal,
          },
        });
        await tx.coupon.update({
          where: { id: coupon.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      // 4e. Existing behaviour: bump the sold counter.
      for (const l of lines) {
        await tx.product.update({
          where: { id: l.productId },
          data: { soldCount: { increment: l.quantity } },
        });
      }

      return order;
    });

    revalidatePath("/account/orders");
    revalidatePath("/cart");
    revalidatePath("/checkout");
    revalidateTag("products", "max");

    // Order confirmation — after the response, isolated from this transaction.
    // Idempotency key ORDER_CREATED:<orderId> guarantees one send per order.
    scheduleEmail(() => sendOrderConfirmation(created.id));
    // Axiaro Operations companion notice (9F-7b) — same idempotency guarantee,
    // its own key (ORDER_RECEIVED_OPS:<orderId>), goes to the ops inbox only.
    scheduleEmail(() => sendOrderReceivedOps(created.id));
    // Seller new-order notification (9F-14) — for a THIRD_PARTY order only, to
    // the seller's own mailbox(es); a no-op for a FIRST_PARTY (Axiaro) order.
    // Key SELLER_ORDER_RECEIVED:<orderId> → exactly one per order.
    scheduleEmail(() => sendSellerOrderReceived(created.id));

    // 9F-15B: a THIRD_PARTY COD order was auto-confirmed above — record the
    // `order.confirmed` audit row (system actor, best-effort — same posture as
    // confirmOrderAction).
    //
    // 9F-31B (P1): this branch NO LONGER sends the "we're preparing your order"
    // email. `Order.status` is PROCESSING here only so the customer-facing
    // timeline can progress, but the SellerOrder is still PENDING_PAYMENT — the
    // seller has not accepted, nothing is being packed. That email now fires
    // from `advanceSellerOrderAction` when the seller actually accepts
    // (PENDING_PAYMENT → PROCESSING); its `ORDER_PROCESSING:<orderId>` key is
    // unchanged, so it still sends exactly once. The 1P path (admin "Confirm
    // order" / status → PROCESSING) is untouched and still sends it.
    if (autoConfirmParent) {
      await writeAudit({
        actorUserId: null,
        action: "order.confirmed",
        targetType: "order",
        targetId: created.id,
        summary: `Order ${created.orderNumber} auto-confirmed (third-party pay-on-delivery): PENDING_PAYMENT → PROCESSING`,
        meta: {
          orderNumber: created.orderNumber,
          from: "PENDING_PAYMENT",
          to: "PROCESSING",
          paymentMethod: "NONE",
          trigger: "checkout_3p_cod_autoconfirm",
          sellerId: soSeller.id,
        },
      });
    }

    return { ok: true, orderNumber: created.orderNumber, duplicate: false };
  } catch (err) {
    // Cart already converted, or a unique-constraint race — return the order
    // that actually got created for this cart (idempotent from the customer's
    // point of view) rather than a scary error.
    const isUnique =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
    if ((err instanceof CheckoutError && err.code === "ALREADY_ORDERED") || isUnique) {
      const existing = await prisma.order.findFirst({
        where: { cartId: cart.id },
        select: { orderNumber: true },
      });
      if (existing) return { ok: true, orderNumber: existing.orderNumber, duplicate: true };
    }
    if (err instanceof CheckoutError) {
      return { ok: false, code: err.code, error: err.message };
    }
    throw err;
  }
}
