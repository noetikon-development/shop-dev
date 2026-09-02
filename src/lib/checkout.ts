import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { adjustStock } from "@/lib/inventory";
import { loadCart, activeRedemptionCount } from "@/lib/cart";
import { evaluateCoupon, type EvaluableCoupon } from "@/lib/coupons";
import { getCustomerAddresses, type AddressDTO } from "@/lib/addresses";
import { resolveLineImageUrl, colourValueIdOf } from "@/lib/line-image";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendOrderConfirmation } from "@/lib/email/notifications";
import { getPaymentsConfig } from "@/lib/payments/config";
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
 * Checkout + order creation (Step 9, shipping added in Step 11).
 *
 * The order is created ONLY here, server-side. The browser never sends items,
 * prices, shipping amounts or totals — `createOrderFromCart` re-reads the
 * customer's ACTIVE cart, re-validates every line against the live product /
 * variant / inventory / price, LOADS the chosen shipping method and its rate
 * from the database, recalculates the total, and does the whole thing
 * (cart -> CONVERTED, inventory SALE deduction, Order + OrderItems) inside one
 * transaction. Payment is a later step: orders are created PENDING_PAYMENT and
 * are never marked paid here.
 */

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
  return `AX-${stamp}-${String(rows[0].v).padStart(5, "0")}`;
}

const cartForOrder = {
  items: {
    orderBy: { createdAt: "asc" },
    include: {
      variant: {
        select: {
          id: true,
          sku: true,
          status: true,
          price: true,
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
          inventory: { select: { quantity: true, reserved: true } },
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

  // 3. Re-validate every line against authoritative data; build order lines.
  const problems: string[] = [];
  const lines: {
    productId: string;
    variantId: string;
    name: string;
    variantLabel: string | null;
    sku: string;
    imageUrl: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }[] = [];

  for (const item of cart.items) {
    const v = item.variant;
    const p = v.product;
    const available = Math.max(0, (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0));

    if (p.status !== "ACTIVE" || v.status !== "ACTIVE" || !v.inventory) {
      problems.push(`“${p.name}” is no longer available.`);
      continue;
    }
    if (available < item.quantity) {
      problems.push(
        `“${p.name}” — only ${available} left, but your cart has ${item.quantity}.`,
      );
      continue;
    }

    const optionSummary = v.optionValues
      .slice()
      .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
      .map((ov) => ov.optionValue.value)
      .join(" · ");

    lines.push({
      productId: p.id,
      variantId: v.id,
      name: p.name,
      variantLabel: optionSummary || null,
      sku: v.sku,
      imageUrl: resolveLineImageUrl({
        images: p.images,
        colourValueId: colourValueIdOf(v.optionValues),
        variantImageUrl: v.imageUrl,
        slug: p.slug,
      }),
      unitPrice: v.price,
      quantity: item.quantity,
      lineTotal: v.price * item.quantity,
    });
  }

  if (problems.length > 0) {
    return {
      ok: false,
      code: "STOCK",
      error: `${problems.join(" ")} Update your cart and try again.`,
    };
  }
  if (lines.length === 0) {
    return { ok: false, code: "EMPTY", error: "Your cart has nothing available to order." };
  }

  // 4. Server-authoritative totals. The shipping fee is the ACTIVE method's
  //    current DB rate (after the store-wide free-shipping rule) — never a
  //    browser value.
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const freeThreshold = await getFreeShippingThreshold();
  const shippingFee = effectiveShippingFee(method.rate, subtotal, freeThreshold);

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

      // 4b. Deduct inventory through the Step 6 primitive: records a SALE
      //     InventoryAdjustment, keeps the Variant.stock mirror in sync, and is
      //     row-locked so it can't oversell. Any failure rolls the whole
      //     transaction back (including the cart conversion).
      for (const l of lines) {
        const res = await adjustStock(
          {
            variantId: l.variantId,
            delta: -l.quantity,
            reason: "SALE",
            note: `Order ${orderNumber}`,
            actorUserId: user.id,
          },
          tx,
        );
        if (!res.ok) {
          throw new CheckoutError(
            "STOCK",
            `“${l.name}” just sold out. Your order was not placed.`,
          );
        }
      }

      // 4c. The order itself.
      const order = await tx.order.create({
        data: {
          orderNumber,
          userId: user.id,
          cartId: cart.id,
          email: user.email,
          phone: shipAddr.phone,
          status: "PENDING_PAYMENT",
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
          items: { create: lines },
          events: {
            create: [
              {
                status: "PENDING_PAYMENT",
                title: "Order placed",
                detail: "We’ve received your order. Payment is arranged on delivery.",
              },
            ],
          },
        },
        select: { id: true, orderNumber: true },
      });

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
