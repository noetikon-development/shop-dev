/**
 * `quoteSellerShipment()` — quote-only backend layer (Phase 9F-48 step 6).
 * Exercises the REAL repository function against a FAKE/STUB
 * `ShippingProvider` (via the same test-only `providerOverride` seam used by
 * `test-shipment-provider-wiring.ts`) — no real Lalamove sandbox call.
 *
 * Everything runs inside ONE `prisma.$transaction` that always ends by
 * throwing `Rollback`; `quoteSellerShipment()` is called with that SAME `tx`
 * as `externalTx`, so its own pre-check reads see this transaction's own
 * uncommitted writes.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-shipment-quote-action.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { quoteSellerShipment, saveSellerShipment, type ShipmentInput } from "@/lib/marketplace/seller-order-repository";
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
  console.log("\nquoteSellerShipment() — quote-only backend layer\n");

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
            type: "THIRD_PARTY", status: "APPROVED", displayName: `Quote ${tag} ${sfx}`, slug: `quote-${tag}-${sfx}`,
            supportEmail: "s@t.test", contentStatus: "APPROVED",
            originAddress: origin === null ? Prisma.JsonNull : (origin as object),
          },
          select: { id: true },
        });

      const mkFullOrder = async (sellerId: string, opts: { withItem?: boolean; soStatus?: string } = {}) => {
        const order = await tx.order.create({
          data: {
            orderNumber: `AX-QUOTE-${sfx}-${Math.random().toString(36).slice(2, 6)}`, email: "b@e.test", phone: "+630", status: "PROCESSING",
            paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 1000, grandTotal: 1000, shippingFee: 0,
            shippingAddress: JSON.stringify({ recipient: "Jane Buyer", phone: "+639170000009", line1: "1 Customer St", line2: null, barangay: "Poblacion", city: "Manila", province: "Metro Manila", postalCode: "1000", country: "PH" }),
            userId: buyer?.id,
          },
          select: { id: true },
        });
        const so = await tx.sellerOrder.create({
          data: { orderId: order.id, sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, total: 1000, commissionRate: 1500, commissionAmount: 150, status: opts.soStatus ?? "PROCESSING" },
          select: { id: true, status: true },
        });
        if (opts.withItem !== false) {
          const product = await tx.product.create({
            data: { name: `Quote Test ${sfx}`, slug: `quote-test-${sfx}-${Math.random().toString(36).slice(2, 6)}`, shortDescription: "s", description: "d", categoryId: category.id, status: "DRAFT", price: 1000, weightGrams: 600, lengthCm: 40, widthCm: 30, heightCm: 20 },
            select: { id: true },
          });
          const variant = await tx.variant.create({ data: { productId: product.id, sku: `QUOTE-${sfx}-${Math.random().toString(36).slice(2, 6)}`, price: 1000 }, select: { id: true } });
          await tx.orderItem.create({
            data: { orderId: order.id, productId: "snapshot-unused", variantId: variant.id, sellerOrderId: so.id, name: "line", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
          });
        }
        return so;
      };

      const sellerGood = await mkSeller("good", VALID_ORIGIN);
      const sellerNoOrigin = await mkSeller("noorigin", null);

      // ── A. Successful quote ──────────────────────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, stub);
        ok("A · quote succeeds", res.ok, JSON.stringify(res));
        ok("A · quote() called exactly once", stub.quoteCalls.length === 1);
        ok("A · createShipment() never called", stub.createCalls.length === 0);
        if (res.ok) {
          ok("A · returned Quote[] is the provider's own value, unchanged", res.quotes.length === 1 && res.quotes[0].amount === 15000 && res.quotes[0].currency === "PHP" && res.quotes[0].service === "SEDAN");
        }
        ok("A · no Shipment row created", (await tx.shipment.count({ where: { sellerOrderId: so.id } })) === 0);
      }

      // ── B. Missing origin coordinates ────────────────────────────────────
      {
        const so = await mkFullOrder(sellerNoOrigin.id);
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerNoOrigin.id), so.id, input, tx, stub);
        ok("B · missing seller origin coordinates → clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /pickup address coordinates/i.test(res.error), JSON.stringify(res));
        ok("B · quote() never called", stub.quoteCalls.length === 0);
      }

      // ── C. Missing destination coordinates ───────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN" };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, stub);
        ok("C · missing destination coordinates → clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /destination coordinates/i.test(res.error), JSON.stringify(res));
        ok("C · quote() never called", stub.quoteCalls.length === 0);
      }

      // ── D. Missing serviceType ───────────────────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, stub);
        ok("D · missing serviceType → clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /service type/i.test(res.error), JSON.stringify(res));
        ok("D · quote() never called", stub.quoteCalls.length === 0);
      }

      // ── E. Package derivation failure (no items) ─────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id, { withItem: false });
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, stub);
        ok("E · package-derivation failure propagates as a clean VALIDATION error", !res.ok && res.code === "VALIDATION" && /no shippable items/i.test(res.error), JSON.stringify(res));
        ok("E · quote() never called", stub.quoteCalls.length === 0);
      }

      // ── F. Existing Shipment — conflict, provider not called ────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        await tx.shipment.create({ data: { sellerOrderId: so.id, carrier: "JT_EXPRESS", trackingNumber: "TRK1", status: "PENDING" } });
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, stub);
        ok("F · an existing Shipment → CONFLICT, no quote attempted", !res.ok && res.code === "CONFLICT", JSON.stringify(res));
        ok("F · quote() never called", stub.quoteCalls.length === 0);
      }

      // ── G. CANCELLED / DELIVERED SellerOrder — rejected, provider not called ──
      {
        const soCancelled = await mkFullOrder(sellerGood.id, { soStatus: "CANCELLED" });
        const stubC = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const resC = await quoteSellerShipment(ctxFor(sellerGood.id), soCancelled.id, input, tx, stubC);
        ok("G · CANCELLED SellerOrder → clean VALIDATION error, no quote attempted", !resC.ok && resC.code === "VALIDATION" && /can no longer be edited/i.test(resC.error) && stubC.quoteCalls.length === 0, JSON.stringify(resC));

        const soDelivered = await mkFullOrder(sellerGood.id, { soStatus: "DELIVERED" });
        const stubD = makeStub();
        const resD = await quoteSellerShipment(ctxFor(sellerGood.id), soDelivered.id, input, tx, stubD);
        ok("G · DELIVERED SellerOrder → clean VALIDATION error, no quote attempted", !resD.ok && resD.code === "VALIDATION" && /can no longer be edited/i.test(resD.error) && stubD.quoteCalls.length === 0, JSON.stringify(resD));
      }

      // ── H. Ownership / not-found ─────────────────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        // Wrong seller context — same NOT_FOUND convention as saveSellerShipment.
        const res = await quoteSellerShipment(ctxFor(sellerNoOrigin.id), so.id, input, tx, stub);
        ok("H · a seller context that doesn't own the SellerOrder → NOT_FOUND, matching the existing repository convention", !res.ok && res.code === "NOT_FOUND", JSON.stringify(res));
        ok("H · quote() never called", stub.quoteCalls.length === 0);

        const resMissing = await quoteSellerShipment(ctxFor(sellerGood.id), "does-not-exist-" + sfx, input, tx, stub);
        ok("H · a nonexistent sellerOrderId → NOT_FOUND", !resMissing.ok && resMissing.code === "NOT_FOUND");
      }

      // ── I. MANUAL provider — quote path does not call MANUAL, clean non-provider result ──
      {
        const so = await mkFullOrder(sellerGood.id);
        const manualStub = makeStub({ code: "MANUAL" });
        const input = { carrier: "JT_EXPRESS", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, manualStub);
        ok("I · MANUAL provider → clean VALIDATION result, quoting not applicable", !res.ok && res.code === "VALIDATION" && /does not support rate quoting/i.test(res.error), JSON.stringify(res));
        ok("I · MANUAL's quote() was never called (it doesn't even implement one, and this proves the code path never reaches a call)", manualStub.quoteCalls.length === 0);
        ok("I · MANUAL's createShipment() was never called", manualStub.createCalls.length === 0);
      }

      // ── J. Draft correctness ─────────────────────────────────────────────
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input = { carrier: "LALAMOVE", serviceType: "SEDAN", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await quoteSellerShipment(ctxFor(sellerGood.id), so.id, input, tx, stub);
        ok("J · quote succeeds", res.ok, JSON.stringify(res));
        const draft = stub.quoteCalls[0];
        ok("J · draft.origin came from Seller.originAddress (city/lat/lng match the fixture)", draft.origin?.city === "Batangas City" && draft.origin?.lat === "13.7565" && draft.origin?.lng === "121.0583", JSON.stringify(draft.origin));
        ok("J · draft.destination merges the Order.shippingAddress snapshot with the supplied coordinates", draft.destination?.city === "Manila" && draft.destination?.recipient === "Jane Buyer" && draft.destination?.lat === "14.5995" && draft.destination?.lng === "120.9842", JSON.stringify(draft.destination));
        ok("J · draft.package came from deriveShipmentPackage() (matches the product's own weight/dimensions)", draft.package?.weightGrams === 600 && draft.package?.lengthCm === 40 && draft.package?.widthCm === 30 && draft.package?.heightCm === 20, JSON.stringify(draft.package));
        ok("J · draft.serviceType is the selected service type", draft.serviceType === "SEDAN");
        ok("J · direction defaults to FORWARD when not supplied", draft.direction === "FORWARD");
      }

      // ── K. Booking regression — saveSellerShipment still quotes then books exactly as before ──
      {
        const so = await mkFullOrder(sellerGood.id);
        const stub = makeStub();
        const input: ShipmentInput = { carrier: "LALAMOVE", serviceType: "SEDAN", note: "leave at guardhouse", destination: { lat: "14.5995", lng: "120.9842" } };
        const res = await saveSellerShipment(ctxFor(sellerGood.id), so.id, input, undefined, tx, stub);
        ok("K · saveSellerShipment still succeeds for a non-MANUAL booking after the extraction", res.ok, JSON.stringify(res));
        ok("K · quote() then createShipment(), each exactly once (unchanged ordering)", stub.quoteCalls.length === 1 && stub.createCalls.length === 1);
        if (res.ok) {
          const row = await tx.shipment.findUniqueOrThrow({ where: { id: res.shipmentId }, select: { provider: true, externalShipmentId: true, shippingCostAmount: true } });
          ok("K · successful booking persistence remains unchanged (full ShipmentResult fields)", row.provider === "LALAMOVE" && row.externalShipmentId === "STUB-ORDER-1" && row.shippingCostAmount === 15000);
        }

        // MANUAL regression, same component.
        const soManual = await mkFullOrder(sellerGood.id);
        const manualStub = makeStub({ code: "MANUAL" });
        const manualInput: ShipmentInput = { carrier: "JT_EXPRESS", trackingNumber: "TRK999999999" };
        const resManual = await saveSellerShipment(ctxFor(sellerGood.id), soManual.id, manualInput, undefined, tx, manualStub);
        ok("K · MANUAL booking behaviour remains unchanged after the extraction", resManual.ok, JSON.stringify(resManual));
        ok("K · MANUAL never calls quote()", manualStub.quoteCalls.length === 0);
        ok("K · MANUAL createShipment() called with only the 5 legacy fields", manualStub.createCalls.length === 1 && manualStub.createCalls[0].origin === undefined && manualStub.createCalls[0].destination === undefined);
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
  ok("L · rollback — no fixture row leaked (all counts unchanged)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
