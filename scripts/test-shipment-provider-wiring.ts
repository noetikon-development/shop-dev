/**
 * `saveSellerShipment()` — backend provider-shipment-creation wiring (Phase
 * 9F-48 backend wiring, steps 2/3). Exercises the REAL repository function
 * against a FAKE/STUB `ShippingProvider` (via the new, test-only
 * `providerOverride` parameter) — no real Lalamove sandbox call anywhere in
 * this file.
 *
 * Everything runs inside ONE `prisma.$transaction` that always ends by
 * throwing `Rollback` — every fixture (Seller/Product/Variant/Order/
 * SellerOrder/OrderItem/Shipment) this file creates is rolled back, nothing
 * persists. `saveSellerShipment()` is called with that SAME `tx` passed as
 * `externalTx`, so its own pre-check reads (ownership, Seller.originAddress,
 * `deriveShipmentPackage()`) see this transaction's own uncommitted writes.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-shipment-provider-wiring.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { saveSellerShipment, type ShipmentInput } from "@/lib/marketplace/seller-order-repository";
import type { ShipmentDraft, ShipmentResult, Quote, ProviderOutcome, ShippingProvider } from "@/lib/shipping/provider";
import type { SellerContext } from "@/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

const ctxFor = (sellerId: string): SellerContext => ({
  sellerId, sellerName: "S", sellerUserId: "su-" + sellerId, userId: "u-" + sellerId, role: "OWNER", permissions: new Set(),
});

// ── stub ShippingProvider — records every call, no network, no Lalamove ────
function makeStub(opts: {
  code?: string;
  quoteResult?: ProviderOutcome<Quote[]>;
  createResult?: ProviderOutcome<ShipmentResult>;
  noQuote?: boolean;
} = {}) {
  const quoteCalls: ShipmentDraft[] = [];
  const createCalls: ShipmentDraft[] = [];
  const provider: ShippingProvider & { quoteCalls: ShipmentDraft[]; createCalls: ShipmentDraft[] } = {
    code: opts.code ?? "LALAMOVE",
    quoteCalls,
    createCalls,
    ...(opts.noQuote ? {} : {
      quote: async (draft: ShipmentDraft) => {
        quoteCalls.push(draft);
        return opts.quoteResult ?? {
          ok: true,
          value: [{ provider: "LALAMOVE", service: draft.serviceType ?? "SEDAN", amount: 15000, currency: "PHP", estimatedDeliveryAt: null }],
        };
      },
    }),
    createShipment: async (draft: ShipmentDraft) => {
      createCalls.push(draft);
      if (opts.createResult) return opts.createResult;
      if ((opts.code ?? "LALAMOVE") === "MANUAL") {
        return {
          ok: true,
          value: {
            carrier: draft.carrier, carrierName: draft.carrierName ?? null, trackingNumber: draft.trackingNumber ?? null,
            trackingUrl: draft.trackingUrl ?? null, note: draft.note ?? null, provider: "MANUAL", externalShipmentId: null,
            externalOrderId: null, service: null, labelUrl: null, shippingCostAmount: null, shippingCostCurrency: null,
            estimatedDeliveryAt: null,
          },
        };
      }
      return {
        ok: true,
        value: {
          carrier: "LALAMOVE", carrierName: "Lalamove", trackingNumber: "STUB-ORDER-1",
          trackingUrl: "https://stub.example/track/1", note: draft.note ?? null, provider: "LALAMOVE",
          externalShipmentId: "STUB-ORDER-1", externalOrderId: "STUB-ORDER-1", service: draft.serviceType ?? null,
          labelUrl: null, shippingCostAmount: 15000, shippingCostCurrency: "PHP", estimatedDeliveryAt: null,
        },
      };
    },
    verifyWebhook: () => false,
    parseWebhook: () => [],
  };
  return provider;
}

const VALID_ORIGIN = { recipient: "Warehouse", line1: "45 Industrial Ave", barangay: "San Isidro", city: "Batangas City", province: "Batangas", postalCode: "4200", country: "PH", phone: "+639175550199", lat: "13.7565", lng: "121.0583" };

async function main() {
  console.log("\nsaveSellerShipment() — provider-shipment-creation wiring\n");

  const before = {
    sellers: await prisma.seller.count(),
    products: await prisma.product.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    shipments: await prisma.shipment.count(),
  };

  try {
    await prisma.$transaction(async (tx: Tx) => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const category = await tx.category.findFirst({ select: { id: true } });
      if (!category) throw new Rollback();
      const buyer = await tx.user.findFirst({ select: { id: true } });

      const mkSeller = async (tag: string, origin: object | null) =>
        tx.seller.create({
          data: {
            type: "THIRD_PARTY", status: "APPROVED", displayName: `Wiring ${tag} ${sfx}`, slug: `wiring-${tag}-${sfx}`,
            supportEmail: "s@t.test", contentStatus: "APPROVED",
            originAddress: origin === null ? Prisma.JsonNull : (origin as object),
          },
          select: { id: true },
        });

      const mkFullOrder = async (sellerId: string) => {
        const product = await tx.product.create({
          data: { name: `Wire Test ${sfx}`, slug: `wire-test-${sfx}-${Math.random().toString(36).slice(2, 6)}`, shortDescription: "s", description: "d", categoryId: category.id, status: "DRAFT", price: 1000, weightGrams: 600, lengthCm: 40, widthCm: 30, heightCm: 20 },
          select: { id: true },
        });
        const variant = await tx.variant.create({ data: { productId: product.id, sku: `WIRE-${sfx}-${Math.random().toString(36).slice(2, 6)}`, price: 1000 }, select: { id: true } });
        const order = await tx.order.create({
          data: {
            orderNumber: `AX-WIRE-${sfx}-${Math.random().toString(36).slice(2, 6)}`, email: "b@e.test", phone: "+630", status: "PROCESSING",
            paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 1000, grandTotal: 1000, shippingFee: 0,
            shippingAddress: JSON.stringify({ recipient: "Jane Buyer", phone: "+639170000009", line1: "1 Customer St", line2: null, barangay: "Poblacion", city: "Manila", province: "Metro Manila", postalCode: "1000", country: "PH" }),
            userId: buyer?.id,
          },
          select: { id: true },
        });
        const so = await tx.sellerOrder.create({
          data: { orderId: order.id, sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "PROCESSING" },
          select: { id: true, status: true },
        });
        await tx.orderItem.create({
          data: { orderId: order.id, productId: "snapshot-unused", variantId: variant.id, sellerOrderId: so.id, name: "line", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
        });
        return so;
      };

      const sellerGood = await mkSeller("good", VALID_ORIGIN);
      const sellerNoOrigin = await mkSeller("noorigin", null);

      // ── A. MANUAL — unchanged legacy behaviour, no quote() call ─────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub({ code: "MANUAL" });
        const input: ShipmentInput = { carrier: "JT_EXPRESS", carrierName: null, trackingNumber: "TRK123456789", trackingUrl: null, note: "manual note" };
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("A · MANUAL create succeeds", res.ok, JSON.stringify(res));
        ok("A · MANUAL never calls quote()", stub.quoteCalls.length === 0);
        ok("A · MANUAL createShipment() called exactly once, with only the 5 legacy fields (no origin/destination/package)", stub.createCalls.length === 1 && stub.createCalls[0].origin === undefined && stub.createCalls[0].destination === undefined && stub.createCalls[0].package === undefined);
        if (res.ok) {
          const row = await tx.shipment.findUniqueOrThrow({ where: { id: res.shipmentId }, select: { carrier: true, trackingNumber: true, provider: true, externalShipmentId: true } });
          ok("A · persisted Shipment has the legacy fields, provider/externalShipmentId stay NULL", row.carrier === "JT_EXPRESS" && row.trackingNumber === "TRK123456789" && row.provider === null && row.externalShipmentId === null);
        }
      }

      // ── B. non-MANUAL — missing origin coordinates ──────────────────────
      {
        const so = await mkFullOrder(sellerNoOrigin.id);
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await saveSellerShipment(ctxFor(sellerNoOrigin.id), so.id, input, undefined, tx, stub);
        ok("B · missing seller origin coordinates → clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /pickup address coordinates/i.test(res.error), JSON.stringify(res));
        ok("B · quote() never called", stub.quoteCalls.length === 0);
        ok("B · createShipment() never called", stub.createCalls.length === 0);
        ok("B · no Shipment row created", (await tx.shipment.count({ where: { sellerOrderId: so.id } })) === 0);
      }

      // ── C. non-MANUAL — missing destination coordinates ─────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN" }; // no destination at all
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("C · missing destination coordinates → clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /destination coordinates/i.test(res.error), JSON.stringify(res));
        ok("C · quote()/createShipment() never called, no Shipment row", stub.quoteCalls.length === 0 && stub.createCalls.length === 0 && (await tx.shipment.count({ where: { sellerOrderId: so.id } })) === 0);
      }

      // ── D. non-MANUAL — missing serviceType ──────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", destination: { lat: "14.5995", lng: "120.9842" } }; // no serviceType
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("D · missing serviceType → clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /service type/i.test(res.error), JSON.stringify(res));
        ok("D · quote()/createShipment() never called", stub.quoteCalls.length === 0 && stub.createCalls.length === 0);
      }

      // ── E. non-MANUAL — package derivation failure (no line items) ──────
      {
        // A SellerOrder with NO items — built by hand (not mkFullOrder) so it has zero OrderItem rows.
        const order = await tx.order.create({
          data: { orderNumber: `AX-WIRE-EMPTY-${sfx}`, email: "b@e.test", phone: "+630", status: "PROCESSING", paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 0, grandTotal: 0, shippingFee: 0, shippingAddress: "{}", userId: buyer?.id },
          select: { id: true },
        });
        const so = await tx.sellerOrder.create({
          data: { orderId: order.id, sellerId: sellerGood.id, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 0, total: 0, commissionRate: 1500, commissionAmount: 0, status: "PROCESSING" },
          select: { id: true },
        });
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("E · package-derivation failure (no items) propagates as a clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /no shippable items/i.test(res.error), JSON.stringify(res));
        ok("E · quote()/createShipment() never called", stub.quoteCalls.length === 0 && stub.createCalls.length === 0);
      }

      // ── F. non-MANUAL — quote() failure ─────────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub({ quoteResult: { ok: false, error: "stub quote failure" } });
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("F · quote() failure surfaces the exact provider error", !res.ok && res.code === "VALIDATION" && res.error === "stub quote failure", JSON.stringify(res));
        ok("F · quote() WAS called, createShipment() was NOT (proves quote-before-book ordering)", stub.quoteCalls.length === 1 && stub.createCalls.length === 0);
        ok("F · no Shipment row created on quote failure", (await tx.shipment.count({ where: { sellerOrderId: so.id } })) === 0);
      }

      // ── G. non-MANUAL — createShipment() failure (after a successful quote) ──
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub({ createResult: { ok: false, error: "stub booking failure" } });
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("G · createShipment() failure surfaces the exact provider error", !res.ok && res.code === "VALIDATION" && res.error === "stub booking failure", JSON.stringify(res));
        ok("G · BOTH quote() and createShipment() were called exactly once", stub.quoteCalls.length === 1 && stub.createCalls.length === 1);
        ok("G · no Shipment row created on booking failure", (await tx.shipment.count({ where: { sellerOrderId: so.id } })) === 0);
      }

      // ── H/I/J. non-MANUAL — successful booking: full persistence + draft correctness + direction default ──
      let successSoId = "";
      {
        const so = await mkFullOrder(sellerGood.id);
        successSoId = so.id;
        const soBefore = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.id }, select: { status: true } });
        const orderBefore = await tx.order.findFirst({ where: { sellerOrders: { some: { id: so.id } } }, select: { status: true } });
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", note: "leave at guardhouse", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("H · successful non-MANUAL booking → ok:true", res.ok, JSON.stringify(res));
        ok("H · quote() called before createShipment(), each exactly once", stub.quoteCalls.length === 1 && stub.createCalls.length === 1);

        const draft = stub.createCalls[0];
        ok("I · draft.package came from deriveShipmentPackage() — matches the product's own weight/dimensions (600g/40/30/20)", draft.package?.weightGrams === 600 && draft.package?.lengthCm === 40 && draft.package?.widthCm === 30 && draft.package?.heightCm === 20, JSON.stringify(draft.package));
        ok("I · draft.origin came from Seller.originAddress (city/lat/lng match the fixture)", draft.origin?.city === "Batangas City" && draft.origin?.lat === "13.7565" && draft.origin?.lng === "121.0583", JSON.stringify(draft.origin));
        ok("I · draft.destination merges the Order.shippingAddress snapshot with the supplied coordinates", draft.destination?.city === "Manila" && draft.destination?.recipient === "Jane Buyer" && draft.destination?.lat === "14.5995" && draft.destination?.lng === "120.9842", JSON.stringify(draft.destination));
        ok("J · direction defaults to FORWARD when not supplied", draft.direction === "FORWARD");

        if (res.ok) {
          const row = await tx.shipment.findUniqueOrThrow({
            where: { id: res.shipmentId },
            select: { provider: true, externalShipmentId: true, externalOrderId: true, service: true, labelUrl: true, shippingCostAmount: true, shippingCostCurrency: true, estimatedDeliveryAt: true, trackingUrl: true, metadata: true, direction: true, status: true },
          });
          ok("H · persisted Shipment carries the FULL ShipmentResult fields", row.provider === "LALAMOVE" && row.externalShipmentId === "STUB-ORDER-1" && row.externalOrderId === "STUB-ORDER-1" && row.service === "SEDAN" && row.shippingCostAmount === 15000 && row.shippingCostCurrency === "PHP" && row.trackingUrl === "https://stub.example/track/1" && row.direction === "FORWARD", JSON.stringify(row));
          ok("H · Shipment.status is still PENDING immediately after creation", row.status === "PENDING");
        }

        const soAfter = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.id }, select: { status: true } });
        const orderAfter = await tx.order.findFirst({ where: { sellerOrders: { some: { id: so.id } } }, select: { status: true } });
        ok("no SellerOrder status transition occurred during creation", soAfter.status === soBefore.status);
        ok("no parent Order status transition occurred during creation", orderAfter?.status === orderBefore?.status);
      }

      // ── K. direction explicitly RETURN passes through unchanged ─────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", direction: "RETURN", destination: { lat: "14.5995", lng: "120.9842" } };
        await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("K · an explicitly-supplied direction is passed through to the draft unchanged", stub.createCalls[0]?.direction === "RETURN");
      }

      // ── L. one-shipment-per-SellerOrder guard still works for non-MANUAL ──
      {
        const stub2 = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res2 = await saveSellerShipment(ctxFor(sellerGood.id), successSoId, input, undefined, tx, stub2);
        ok("L · a second CREATE on the same SellerOrder → CONFLICT", !res2.ok && res2.code === "CONFLICT", JSON.stringify(res2));
        ok("L · the guard short-circuits BEFORE calling the provider again (no wasted/orphaned real booking)", stub2.quoteCalls.length === 0 && stub2.createCalls.length === 0);
      }

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = {
    sellers: await prisma.seller.count(),
    products: await prisma.product.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    shipments: await prisma.shipment.count(),
  };
  ok("rollback · no fixture row leaked (all counts unchanged)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
