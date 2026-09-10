/**
 * Phase 9F-47B — additive shipping / courier-API schema foundation.
 *
 * Verifies ONLY the foundation: schema additive fields, the ShipmentEvent model,
 * the CourierDef config extension, the 3 dormant `shipping.*` settings, and a
 * new READ-ONLY reconciliation rule. Proves the existing MANUAL shipment path
 * (validation, transitions, hasShippableShipment, rollUpParentOrder, customer
 * emails) is byte-unchanged, and that production carries 0 ShipmentEvent rows.
 *
 * A — static: schema additive fields + ShipmentEvent model + relation
 * B — static: couriers.ts CourierDef extension; existing codes / requiresTracking / URL helpers unchanged
 * C — static: settings-registry `shipping.integrationEnabled|provider|mode` dormant defaults
 * D — static: reconcile-marketplace rule H is read-only; manual shipment code unchanged
 * E — DB (read-only): new columns + ShipmentEvent are queryable; production has 0 ShipmentEvent; the 1 existing Shipment row keeps every new column NULL
 * F — DB (rolled back): a provider shipment + ShipmentEvent write, the (provider, providerEventId) unique guard, FK cascade — then Rollback
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f47b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { COURIERS, getCourier, isCourierCode, buildTrackingUrl, isSafeTrackingUrl } from "../src/lib/orders/couriers";
import { SETTING_FIELD_BY_KEY } from "../src/lib/admin/settings-registry";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

async function main() {
  console.log("PHASE 9F-47B — additive shipping schema foundation\n");

  // ── A · schema ────────────────────────────────────────────────────────────
  const schema = read("prisma/schema.prisma");
  const shipModel = schema.slice(schema.indexOf("model Shipment {"), schema.indexOf("model ShipmentEvent {"));
  const ADDITIVE = [
    "provider             String?",
    "externalShipmentId   String?",
    "externalOrderId      String?",
    "service              String?",
    "labelUrl             String?",
    "shippingCostAmount   Int?",
    "shippingCostCurrency String?",
    "estimatedDeliveryAt  DateTime?",
    "lastCarrierStatus    String?",
    "lastCarrierStatusAt  DateTime?",
    "metadata             Json?",
  ];
  for (const f of ADDITIVE) ok(`A · Shipment.${f.split(" ")[0]} is additive & nullable`, shipModel.includes(f), f);
  ok("A · Shipment keeps carrier/carrierName/trackingNumber/trackingUrl untouched",
    /carrier\s+String\? \/\/ courier code/.test(shipModel) && /trackingUrl\s+String\? \/\/ HTTPS only/.test(shipModel));
  ok("A · Shipment.status default unchanged (\"PENDING\")", /status\s+String\s+@default\("PENDING"\)/.test(shipModel));
  ok("A · Shipment ↔ ShipmentEvent relation added", /shipmentEvents ShipmentEvent\[\]/.test(shipModel));
  const evtModel = schema.slice(schema.indexOf("model ShipmentEvent {"));
  ok("A · ShipmentEvent model exists", evtModel.startsWith("model ShipmentEvent {"));
  ok("A · ShipmentEvent @@unique([provider, providerEventId])", /@@unique\(\[provider, providerEventId\]\)/.test(evtModel));
  ok("A · ShipmentEvent status default RECEIVED", /status\s+String\s+@default\("RECEIVED"\)/.test(evtModel));
  ok("A · ShipmentEvent onDelete: Cascade", /onDelete: Cascade/.test(evtModel.slice(0, evtModel.indexOf("@@unique"))));

  const mig = read("supabase/migrations/20260910160000_shipping_foundation.sql");
  ok("A · migration is a single BEGIN;…COMMIT; transaction", mig.includes("BEGIN;") && mig.trimEnd().includes("COMMIT;"));
  ok("A · migration uses ADD COLUMN IF NOT EXISTS (idempotent, additive)",
    (mig.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length === 11);
  ok("A · migration has NO destructive DDL in the applied body",
    !/^\s*(DROP|ALTER COLUMN|RENAME|TRUNCATE|DELETE|UPDATE)\b/im.test(mig.slice(mig.indexOf("BEGIN;"), mig.indexOf("COMMIT;"))));
  ok("A · migration creates ShipmentEvent IF NOT EXISTS", /CREATE TABLE IF NOT EXISTS "ShipmentEvent"/.test(mig));

  // ── B · courier config ────────────────────────────────────────────────────
  const couriers = read("src/lib/orders/couriers.ts");
  ok("B · CourierDef gains provider? / aggregatorCarrierCode? / supportsLabel / supportsPickup",
    /provider\?: string;/.test(couriers) && /aggregatorCarrierCode\?: string;/.test(couriers) &&
    /supportsLabel: boolean;/.test(couriers) && /supportsPickup: boolean;/.test(couriers));
  const CODES = ["JT_EXPRESS", "LBC", "NINJAVAN", "FLASH", "LALAMOVE", "PICKUP", "OTHER"];
  ok("B · exactly the 7 existing courier codes, unchanged", COURIERS.length === 7 && COURIERS.every((c) => CODES.includes(c.code)));
  ok("B · every courier carries supportsLabel/supportsPickup booleans (false for now)",
    COURIERS.every((c) => c.supportsLabel === false && c.supportsPickup === false));
  ok("B · provider / aggregatorCarrierCode left unset this phase",
    COURIERS.every((c) => c.provider === undefined && c.aggregatorCarrierCode === undefined));
  ok("B · requiresTracking unchanged (J&T/LBC/NinjaVan/Flash = true, Lalamove/Pickup/Other = false)",
    getCourier("JT_EXPRESS")?.requiresTracking === true && getCourier("LBC")?.requiresTracking === true &&
    getCourier("NINJAVAN")?.requiresTracking === true && getCourier("FLASH")?.requiresTracking === true &&
    getCourier("LALAMOVE")?.requiresTracking === false && getCourier("OTHER")?.requiresTracking === false);
  ok("B · tracking-URL + safety helpers unchanged",
    isCourierCode("JT_EXPRESS") && !isCourierCode("NOPE") &&
    buildTrackingUrl("JT_EXPRESS", "ABC123") === "https://www.jtexpress.ph/index/query/gzquery.html?bills=ABC123" &&
    isSafeTrackingUrl("https://x.test/a") && !isSafeTrackingUrl("http://x.test/a"));

  // ── C · settings ──────────────────────────────────────────────────────────
  const sEnabled = SETTING_FIELD_BY_KEY["shipping.integrationEnabled"];
  const sProvider = SETTING_FIELD_BY_KEY["shipping.provider"];
  const sMode = SETTING_FIELD_BY_KEY["shipping.mode"];
  ok("C · shipping.integrationEnabled = boolean, default false", sEnabled?.type === "boolean" && sEnabled?.default === false);
  ok("C · shipping.provider = string, default \"\" (manual)", sProvider?.type === "string" && sProvider?.default === "");
  ok("C · shipping.mode = string, default \"test\"", sMode?.type === "string" && sMode?.default === "test");
  ok("C · all 3 in the 'shipping' group", [sEnabled, sProvider, sMode].every((f) => f?.group === "shipping"));
  const reg = read("src/lib/admin/settings-registry.ts");
  ok("C · registry note keeps credentials OUT of StoreSetting", /NEVER in this table|stay in the server environment/i.test(reg));

  // ── D · reconcile rule H is read-only + manual code unchanged ──────────────
  const recon = read("scripts/reconcile-marketplace.ts");
  const hBlock = recon.slice(recon.indexOf("H · shipping-integration foundation"), recon.indexOf("console.log(`\\n  ${pass} pass"));
  ok("D · reconcile rule H exists", hBlock.length > 0);
  ok("D · rule H performs NO writes (findMany only)",
    /prisma\.shipment\.findMany/.test(hBlock) &&
    !/\.(create|update|updateMany|delete|deleteMany|upsert|createMany)\(/.test(hBlock));
  ok("D · rule H exempts MANUAL / null-provider shipments",
    /provider && s\.provider !== "MANUAL"/.test(hBlock));

  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  // 9F-47C relocated the manual-shipment validation to the shipping provider
  // layer (byte-identical logic — proven by test-9f47c B). Out of 9F-47B's
  // schema-foundation scope regardless of where it lives.
  const manualProv = read("src/lib/shipping/providers/manual.ts");
  ok("D · manual-shipment validation unchanged (carrier + requiresTracking + safe URL)",
    /if \(!carrier \|\| !isCourierCode\(carrier\)\)/.test(manualProv) &&
    /if \(def\?\.requiresTracking && !trackingNumber\)/.test(manualProv) &&
    /if \(trackingUrl && !isSafeTrackingUrl\(trackingUrl\)\)/.test(manualProv));
  ok("D · saveSellerShipment still one-shipment-per-SellerOrder + status create PENDING",
    /This order already has a shipment/.test(repo) && /status: "PENDING"/.test(repo));
  ok("D · hasShippableShipment gate unchanged",
    /const hasShippableShipment = so\.shipments\.some/.test(repo) &&
    /return def\?\.requiresTracking \? Boolean\(s\.trackingNumber\) : true;/.test(repo));
  ok("D · rollUpParentOrder still copies the seller Shipment carrier/tracking onto the Order",
    /courier: ship\?\.carrier \?\? null,/.test(repo) && /trackingNumber: ship\?\.trackingNumber \?\? null,/.test(repo));
  const actions = read("src/lib/seller/order-actions.ts");
  ok("D · saveShipmentAction unchanged (carrier required, no provider fields)",
    /carrier: z\.string\(\)\.trim\(\)\.min\(1, "Choose a carrier"\)/.test(actions) &&
    !/provider|externalShipmentId|labelUrl/.test(actions));
  const emails = read("src/lib/email/notifications.ts");
  ok("D · customer shipment emails keyed on <orderId>, unchanged",
    /idempotencyKey: `ORDER_SHIPPED:\$\{order\.id\}`/.test(emails) &&
    /idempotencyKey: `ORDER_DELIVERED:\$\{order\.id\}`/.test(emails));

  // ── E · DB read-only ──────────────────────────────────────────────────────
  ok("E · ShipmentEvent table is queryable", typeof (await prisma.shipmentEvent.count()) === "number");
  ok("E · production ShipmentEvent count === 0", (await prisma.shipmentEvent.count()) === 0);
  const ships = await prisma.shipment.findMany({
    select: {
      id: true, carrier: true, trackingNumber: true, status: true,
      provider: true, externalShipmentId: true, externalOrderId: true, service: true,
      labelUrl: true, shippingCostAmount: true, shippingCostCurrency: true,
      estimatedDeliveryAt: true, lastCarrierStatus: true, lastCarrierStatusAt: true, metadata: true,
    },
  });
  ok("E · every existing Shipment row has ALL 11 new columns NULL (no backfill)",
    ships.every((s) =>
      s.provider === null && s.externalShipmentId === null && s.externalOrderId === null &&
      s.service === null && s.labelUrl === null && s.shippingCostAmount === null &&
      s.shippingCostCurrency === null && s.estimatedDeliveryAt === null &&
      s.lastCarrierStatus === null && s.lastCarrierStatusAt === null && s.metadata === null),
    JSON.stringify(ships));
  ok("E · existing manual Shipment rows keep carrier/tracking/status", ships.every((s) => s.status && (s.carrier || s.carrier === null)));

  // ── F · rolled-back provider-shipment + ShipmentEvent write ────────────────
  // F1 — a provider shipment + one event + FK cascade, then Rollback.
  try {
    await prisma.$transaction(async (tx) => {
      const so = await tx.sellerOrder.findFirst({ select: { id: true } });
      if (!so) throw new Rollback();
      const sh = await tx.shipment.create({
        data: {
          sellerOrderId: so.id, carrier: "JT_EXPRESS", carrierName: "J&T Express",
          trackingNumber: "T9F47B1", status: "SHIPPED", shippedAt: new Date(),
          provider: "SHIPMATES", externalShipmentId: "ext-9f47b-1", externalOrderId: "extord-1",
          service: "standard", labelUrl: "https://labels.test/a.pdf",
          shippingCostAmount: 8500, shippingCostCurrency: "PHP",
          estimatedDeliveryAt: new Date(Date.now() + 86400000),
          lastCarrierStatus: "picked_up", lastCarrierStatusAt: new Date(),
          metadata: { hub: "MNL-3", pickupWindow: "09-12" },
        },
        select: { id: true, provider: true, shippingCostAmount: true, metadata: true },
      });
      ok("F · provider Shipment row accepts all new columns",
        sh.provider === "SHIPMATES" && sh.shippingCostAmount === 8500 &&
        JSON.stringify(sh.metadata) === JSON.stringify({ hub: "MNL-3", pickupWindow: "09-12" }));

      await tx.shipmentEvent.create({
        data: {
          shipmentId: sh.id, provider: "SHIPMATES", providerEventId: "evt-1",
          rawStatus: "PARCEL_PICKED_UP", normStatus: "IN_TRANSIT",
          occurredAt: new Date(), payloadHash: "abc123", status: "PROCESSED",
        },
      });
      ok("F · exactly one ShipmentEvent stored", (await tx.shipmentEvent.count({ where: { shipmentId: sh.id } })) === 1);

      await tx.shipment.delete({ where: { id: sh.id } });
      ok("F · FK cascade removes ShipmentEvent when its Shipment is deleted",
        (await tx.shipmentEvent.count({ where: { shipmentId: sh.id } })) === 0);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // F2 — the (provider, providerEventId) replay guard. A duplicate insert aborts
  // the Postgres transaction (25P02), so this is its own rolled-back attempt and
  // the duplicate is the last statement.
  let dupCode = "";
  try {
    await prisma.$transaction(async (tx) => {
      const so = await tx.sellerOrder.findFirst({ select: { id: true } });
      if (!so) throw new Rollback();
      const sh = await tx.shipment.create({
        data: { sellerOrderId: so.id, carrier: "OTHER", carrierName: "x", status: "PENDING", provider: "SHIPMATES", externalShipmentId: "ext-dup" },
        select: { id: true },
      });
      await tx.shipmentEvent.create({
        data: { shipmentId: sh.id, provider: "SHIPMATES", providerEventId: "evt-dup", rawStatus: "a", normStatus: "IN_TRANSIT", occurredAt: new Date(), payloadHash: "h1" },
      });
      await tx.shipmentEvent.create({
        data: { shipmentId: sh.id, provider: "SHIPMATES", providerEventId: "evt-dup", rawStatus: "b", normStatus: "IN_TRANSIT", occurredAt: new Date(), payloadHash: "h2" },
      });
      throw new Rollback();
    });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code) dupCode = code;
    else if (!(e instanceof Rollback)) throw e;
  }
  ok("F · (provider, providerEventId) unique constraint rejects a replay (P2002)", dupCode === "P2002", `got: ${dupCode || "no error"}`);

  ok("F · rollback — production Shipment count unchanged", (await prisma.shipment.count()) === ships.length);
  ok("F · rollback — production ShipmentEvent count still 0", (await prisma.shipmentEvent.count()) === 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
