"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { adjustStock } from "@/lib/inventory";
import { getCurrentUser } from "@/lib/auth";
import { computeTotals, type CouponInput } from "@/lib/pricing";
import { ORDER_STATUS_META } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

export type CouponResult =
  | { ok: true; coupon: CouponInput; message: string }
  | { ok: false; error: string };

export async function validateCoupon(code: string, subtotal: number): Promise<CouponResult> {
  const clean = code.trim().toUpperCase();
  if (!clean) return { ok: false, error: "Enter a code" };

  const coupon = await prisma.coupon.findUnique({ where: { code: clean } });
  if (!coupon || !coupon.active) return { ok: false, error: "That code isn’t valid" };

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return { ok: false, error: "This code isn’t active yet" };
  if (coupon.expiresAt && coupon.expiresAt < now) return { ok: false, error: "This code has expired" };
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, error: "This code has reached its limit" };
  }
  if (subtotal < coupon.minSubtotal) {
    return {
      ok: false,
      error: `Spend at least ₱${(coupon.minSubtotal / 100).toLocaleString()} to use ${clean}`,
    };
  }

  return {
    ok: true,
    message: coupon.description ?? "Discount applied",
    coupon: {
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      minSubtotal: coupon.minSubtotal,
      maxDiscount: coupon.maxDiscount,
    },
  };
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

const checkoutItemSchema = z.object({
  productId: z.string(),
  variantId: z.string(),
  quantity: z.number().int().min(1).max(20),
});

const addressSchema = z.object({
  recipient: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(6).max(30),
  line1: z.string().trim().min(3).max(120),
  line2: z.string().trim().max(120).optional().or(z.literal("")),
  barangay: z.string().trim().max(80).optional().or(z.literal("")),
  city: z.string().trim().min(2).max(80),
  province: z.string().trim().min(2).max(80),
  region: z.string().trim().max(80).optional().or(z.literal("")),
  postalCode: z.string().trim().min(3).max(12),
});

const checkoutSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(6).max(30),
  items: z.array(checkoutItemSchema).min(1),
  address: addressSchema,
  shippingMethod: z.enum(["standard", "express"]),
  paymentMethod: z.enum(["COD", "CARD", "GCASH"]),
  couponCode: z.string().trim().optional().or(z.literal("")),
  note: z.string().trim().max(500).optional().or(z.literal("")),
  saveAddress: z.boolean().optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export type CheckoutResult =
  | { ok: true; orderNumber: string }
  | { ok: false; error: string };

function orderNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear().toString().slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `AX-${stamp}-${rand}`;
}

export async function placeOrder(input: CheckoutInput): Promise<CheckoutResult> {
  const parsed = checkoutSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Some details are missing or invalid. Please review the form." };
  }
  const data = parsed.data;
  const appUser = await getCurrentUser();

  // Re-price against the database — never trust client prices.
  const variantIds = data.items.map((i) => i.variantId);
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds } },
    include: {
      product: { select: { id: true, name: true, slug: true, freeShipping: true } },
      optionValues: { include: { optionValue: true } },
    },
  });

  const variantMap = new Map(variants.map((v) => [v.id, v]));
  const lineItems: {
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

  for (const item of data.items) {
    const v = variantMap.get(item.variantId);
    if (!v) return { ok: false, error: "One of your items is no longer available." };
    if (v.stock < item.quantity) {
      return { ok: false, error: `“${v.product.name}” only has ${v.stock} left in that option.` };
    }
    const label =
      v.optionValues.map((ov) => ov.optionValue.value).join(" · ") || null;
    lineItems.push({
      productId: v.product.id,
      variantId: v.id,
      name: v.product.name,
      variantLabel: label,
      sku: v.sku,
      imageUrl: v.imageUrl,
      unitPrice: v.price,
      quantity: item.quantity,
      lineTotal: v.price * item.quantity,
    });
  }

  const pricedLines = lineItems.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity }));

  let coupon: CouponInput | null = null;
  if (data.couponCode) {
    const subtotalNow = pricedLines.reduce((n, l) => n + l.unitPrice * l.quantity, 0);
    const res = await validateCoupon(data.couponCode, subtotalNow);
    if (res.ok) coupon = res.coupon;
  }

  const totals = computeTotals({
    lines: pricedLines,
    shippingMethodId: data.shippingMethod,
    coupon,
  });

  const num = orderNumber();

  try {
    const created = await prisma.$transaction(async (tx) => {
      const couponRow = coupon
        ? await tx.coupon.findUnique({ where: { code: coupon.code } })
        : null;

      let addressId: string | undefined;
      if (appUser && data.saveAddress) {
        const recipient = data.address.recipient.trim();
        const firstSpace = recipient.indexOf(" ");
        const firstName = firstSpace > 0 ? recipient.slice(0, firstSpace) : recipient;
        const lastName = firstSpace > 0 ? recipient.slice(firstSpace + 1).trim() || "-" : "-";
        const addr = await tx.address.create({
          data: {
            userId: appUser.id,
            firstName,
            lastName,
            recipient,
            phone: data.address.phone,
            line1: data.address.line1,
            line2: data.address.line2 || null,
            barangay: data.address.barangay || null,
            city: data.address.city,
            province: data.address.province,
            region: data.address.region || null,
            postalCode: data.address.postalCode,
            country: "PH",
          },
        });
        addressId = addr.id;
      }

      const order = await tx.order.create({
        data: {
          orderNumber: num,
          userId: appUser?.id ?? null,
          email: data.email,
          phone: data.phone,
          status: "PENDING",
          subtotal: totals.subtotal,
          shippingFee: totals.shippingFee,
          discountTotal: totals.discountTotal,
          grandTotal: totals.grandTotal,
          couponId: couponRow?.id ?? null,
          couponCode: totals.couponApplied,
          paymentMethod: data.paymentMethod,
          paymentStatus: data.paymentMethod === "CARD" || data.paymentMethod === "GCASH" ? "PAID" : "UNPAID",
          addressId: addressId ?? null,
          shippingAddress: JSON.stringify(data.address),
          shippingMethod: data.shippingMethod,
          note: data.note || null,
          items: { create: lineItems },
          events: {
            create: [
              {
                status: "PENDING",
                title: ORDER_STATUS_META.PENDING.label,
                detail: "We’ve received your order and will start preparing it shortly.",
              },
            ],
          },
        },
      });

      // Decrement stock through the inventory system so Inventory stays the
      // source of truth (records a SALE adjustment + keeps the Variant mirror
      // in sync). Atomic + row-locked, so a race between the check above and
      // here can't oversell. Falls back to the legacy mirror decrement only if
      // a variant has no inventory record yet.
      for (const item of data.items) {
        const res = await adjustStock(
          {
            variantId: item.variantId,
            delta: -item.quantity,
            reason: "SALE",
            note: `Order ${num}`,
            actorUserId: appUser?.id ?? null,
          },
          tx,
        );
        if (!res.ok) {
          if (res.error === "No inventory record for that variant.") {
            await tx.variant.update({
              where: { id: item.variantId },
              data: { stock: { decrement: item.quantity } },
            });
          } else {
            throw new Error(`STOCK:${item.variantId}:${res.error ?? "unavailable"}`);
          }
        }
      }
      for (const l of lineItems) {
        await tx.product.update({
          where: { id: l.productId },
          data: { soldCount: { increment: l.quantity } },
        });
      }

      if (couponRow) {
        await tx.coupon.update({
          where: { id: couponRow.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      return order;
    });

    revalidatePath("/account/orders");
    revalidateTag("products", "max"); // stock changed
    return { ok: true, orderNumber: created.orderNumber };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("STOCK:")) {
      const v = variantMap.get(msg.split(":")[1]);
      return {
        ok: false,
        error: v
          ? `“${v.product.name}” just sold out in that option. Your order was not placed.`
          : "One of your items just sold out. Your order was not placed.",
      };
    }
    throw err;
  }
}

// Address management lives in src/lib/addresses.ts + src/lib/address-actions.ts
// (Step 8). The checkout "save this address" path below writes an Address row
// directly from the order form's shape.
