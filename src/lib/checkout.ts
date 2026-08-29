import "server-only";
import { revalidatePath, revalidateTag } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { adjustStock } from "@/lib/inventory";
import { loadCart } from "@/lib/cart";
import { getCustomerAddresses, type AddressDTO } from "@/lib/addresses";
import { SHIPPING_METHODS, FREE_SHIPPING_THRESHOLD } from "@/lib/constants";

/**
 * Checkout + order creation (Step 9).
 *
 * The order is created ONLY here, server-side. The browser never sends items,
 * prices or totals — `createOrderFromCart` re-reads the customer's ACTIVE cart
 * from the database, re-validates every line against the live product / variant
 * / inventory / price, recalculates the total, and does the whole thing
 * (cart -> CONVERTED, inventory SALE deduction, Order + OrderItems) inside one
 * transaction. Payment is a later step: orders are created PENDING_PAYMENT and
 * are never marked paid here.
 */

export type ShippingMethodId = "standard" | "express";

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

export type ShippingOption = {
  id: ShippingMethodId;
  label: string;
  detail: string;
  fee: number;
  effectiveFee: number;
};

export type CheckoutSummary = {
  lines: CheckoutLine[];
  itemCount: number;
  subtotal: number;
  freeShippingThreshold: number;
  freeShippingApplied: boolean;
  shippingOptions: ShippingOption[];
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
};

function shippingOptionsFor(subtotal: number): ShippingOption[] {
  const free = subtotal >= FREE_SHIPPING_THRESHOLD;
  return SHIPPING_METHODS.map((m) => ({
    id: m.id as ShippingMethodId,
    label: m.label,
    detail: m.detail,
    fee: m.fee,
    effectiveFee: free ? 0 : m.fee,
  }));
}

export async function getCheckoutData(): Promise<CheckoutData> {
  const user = await getCurrentUser();
  if (!user) {
    // The page also guards with requireUser(); this keeps the type honest.
    return {
      email: "",
      summary: emptySummary(),
      addresses: [],
      defaultShippingId: null,
      defaultBillingId: null,
    };
  }

  const [cart, addresses] = await Promise.all([loadCart(), getCustomerAddresses()]);

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

  return {
    email: user.email,
    summary: {
      lines,
      itemCount: purchasable.reduce((n, l) => n + Math.min(l.quantity, l.available), 0),
      subtotal,
      freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
      freeShippingApplied: subtotal >= FREE_SHIPPING_THRESHOLD,
      shippingOptions: shippingOptionsFor(subtotal),
      pricesChanged: lines.some((l) => l.priceChanged),
      blocked,
    },
    addresses,
    defaultShippingId: addresses.find((a) => a.defaultShipping)?.id ?? addresses[0]?.id ?? null,
    defaultBillingId: addresses.find((a) => a.defaultBilling)?.id ?? addresses[0]?.id ?? null,
  };
}

function emptySummary(): CheckoutSummary {
  return {
    lines: [],
    itemCount: 0,
    subtotal: 0,
    freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
    freeShippingApplied: false,
    shippingOptions: shippingOptionsFor(0),
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
  shippingMethod: ShippingMethodId;
  note?: string;
};

export type PlaceOrderCode =
  | "AUTH"
  | "VALIDATION"
  | "EMPTY"
  | "CART_GONE"
  | "ADDRESS"
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
              images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true } },
            },
          },
          inventory: { select: { quantity: true, reserved: true } },
          optionValues: {
            select: {
              optionValue: {
                select: { value: true, option: { select: { sortOrder: true } } },
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

  const method = SHIPPING_METHODS.find((m) => m.id === input.shippingMethod);
  if (!method) return { ok: false, code: "VALIDATION", error: "Choose a delivery method." };
  const note = (input.note ?? "").trim().slice(0, 500);

  // 1. The customer's live ACTIVE cart.
  const cart = await prisma.cart.findFirst({
    where: { userId: user.id, status: "ACTIVE" },
    include: cartForOrder,
  });
  if (!cart) {
    return {
      ok: false,
      code: "CART_GONE",
      error: "Your bag is empty or has already been checked out.",
    };
  }
  if (cart.items.length === 0) {
    return { ok: false, code: "EMPTY", error: "Your bag is empty." };
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
        `“${p.name}” — only ${available} left, but your bag has ${item.quantity}.`,
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
      imageUrl: v.imageUrl || p.images[0]?.url || `art:accessory:${p.slug}`,
      unitPrice: v.price,
      quantity: item.quantity,
      lineTotal: v.price * item.quantity,
    });
  }

  if (problems.length > 0) {
    return {
      ok: false,
      code: "STOCK",
      error: `${problems.join(" ")} Update your bag and try again.`,
    };
  }
  if (lines.length === 0) {
    return { ok: false, code: "EMPTY", error: "Your bag has nothing available to order." };
  }

  // 4. Server-authoritative totals. (Coupons/tax are deferred — Step 9 §26/§27.)
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : method.fee;
  const discountTotal = 0;
  const grandTotal = subtotal + shippingFee - discountTotal;

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
        throw new CheckoutError("ALREADY_ORDERED", "This bag has already been checked out.");
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
          shippingMethod: input.shippingMethod,
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
                detail: "Your order is placed and is awaiting payment.",
              },
            ],
          },
        },
        select: { orderNumber: true },
      });

      // 4d. Existing behaviour: bump the sold counter.
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
