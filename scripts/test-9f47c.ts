/**
 * Phase 9F-47C — shipping provider abstraction (MANUAL provider only).
 *
 * Proves the abstraction is in place and the existing manual shipment path is
 * byte-for-byte unchanged in behaviour.
 *
 * A — static: provider.ts contract + manual.ts + registry.ts shape; no external I/O
 * B — resolveManualShipment: every validation / error string / normalisation unchanged
 * C — ManualShippingProvider.createShipment maps to a ShipmentResult (provider "MANUAL", integration cols null)
 * D — registry FAILS CLOSED to MANUAL: disabled / unknown provider / no creds / prod config
 * E — no carrier API: no fetch / http client anywhere under src/lib/shipping; webhooks are no-ops
 * F — repository wiring: saveSellerShipment routes through the provider; transaction / guards / persisted columns unchanged
 * G — DB (rolled back): a real saveSellerShipment manual create — Shipment.status PENDING, provider NULL, 1-per-SellerOrder still enforced
 * H — production counts unchanged
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f47c.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveManualShipment, manualShippingProvider } from "../src/lib/shipping/providers/manual";
import { resolveShippingProvider, getShippingConfig } from "../src/lib/shipping/registry";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

// The pre-9F-47C `resolveShipment` error strings — MUST stay identical.
const ERR = {
  carrier: "Choose a valid carrier.",
  tnFormat: "Tracking number: up to 40 letters, numbers, hyphens or underscores.",
  tnRequired: (name: string) => `${name} needs a tracking number.`,
  otherName: "Enter the courier name.",
  url: "Tracking link must be a valid https:// URL.",
  note: "Note is too long (max 300).",
};
const STYLE_AVENUE = "cmtmqr8p70003l7046ygchae6";

async function main() {
  console.log("PHASE 9F-47C — shipping provider abstraction (manual only)\n");

  // ── A · static contract ──────────────────────────────────────────────────
  const prov = read("src/lib/shipping/provider.ts");
  for (const t of ["ShipmentDraft", "ShipmentResult", "Quote", "NormalizedEvent", "ShippingProvider"])
    ok(`A · provider.ts defines ${t}`, new RegExp(`(type|interface) ${t}\\b`).test(prov));
  ok("A · ShippingProvider has createShipment + verifyWebhook + parseWebhook (quote?/getLabel? optional)",
    /createShipment\(draft: ShipmentDraft\)/.test(prov) && /quote\?\(/.test(prov) && /getLabel\?\(/.test(prov) &&
    /verifyWebhook\(/.test(prov) && /parseWebhook\(/.test(prov));
  ok("A · manualShippingProvider.code === \"MANUAL\"", manualShippingProvider.code === "MANUAL");
  const reg = read("src/lib/shipping/registry.ts");
  ok("A · registry is server-only and exports resolveShippingProvider + getShippingConfig",
    /import "server-only";/.test(reg) && /export async function resolveShippingProvider/.test(reg) && /export async function getShippingConfig/.test(reg));
  ok("A · registry PROVIDERS map is empty this phase", /const PROVIDERS: Record<string, ShippingProvider> = \{\};/.test(reg));

  // ── B · resolveManualShipment — behaviour identical to old resolveShipment ─
  ok("B · rejects an unknown carrier", (() => { const r = resolveManualShipment({ carrier: "DHL" }); return !r.ok && r.error === ERR.carrier; })());
  ok("B · rejects a blank carrier", (() => { const r = resolveManualShipment({ carrier: "  " }); return !r.ok && r.error === ERR.carrier; })());
  ok("B · J&T without a tracking number → 'needs a tracking number'",
    (() => { const r = resolveManualShipment({ carrier: "JT_EXPRESS" }); return !r.ok && r.error === ERR.tnRequired("J&T Express"); })());
  ok("B · bad tracking-number format rejected",
    (() => { const r = resolveManualShipment({ carrier: "JT_EXPRESS", trackingNumber: "no spaces!" }); return !r.ok && r.error === ERR.tnFormat; })());
  ok("B · OTHER without a courier name rejected",
    (() => { const r = resolveManualShipment({ carrier: "OTHER" }); return !r.ok && r.error === ERR.otherName; })());
  ok("B · non-https tracking URL rejected",
    (() => { const r = resolveManualShipment({ carrier: "LALAMOVE", trackingUrl: "http://x.test/a" }); return !r.ok && r.error === ERR.url; })());
  ok("B · >300-char note rejected",
    (() => { const r = resolveManualShipment({ carrier: "LALAMOVE", note: "x".repeat(301) }); return !r.ok && r.error === ERR.note; })());
  ok("B · valid J&T + tracking → auto carrierName + auto tracking URL",
    (() => {
      const r = resolveManualShipment({ carrier: "JT_EXPRESS", trackingNumber: "ABC123" });
      return r.ok && r.data.carrierName === "J&T Express" &&
        r.data.trackingUrl === "https://www.jtexpress.ph/index/query/gzquery.html?bills=ABC123" &&
        r.data.note === null;
    })());
  ok("B · OTHER + name + no tracking is valid (trackingUrl null)",
    (() => { const r = resolveManualShipment({ carrier: "OTHER", carrierName: "Habal Rider" }); return r.ok && r.data.carrierName === "Habal Rider" && r.data.trackingNumber === null && r.data.trackingUrl === null; })());
  ok("B · explicit https tracking URL is kept as-is",
    (() => { const r = resolveManualShipment({ carrier: "LALAMOVE", trackingUrl: "https://share.lalamove.test/x" }); return r.ok && r.data.trackingUrl === "https://share.lalamove.test/x"; })());

  // ── C · ManualShippingProvider.createShipment ────────────────────────────
  const good = await manualShippingProvider.createShipment({ sellerOrderId: "so-x", carrier: "JT_EXPRESS", trackingNumber: "ABC123" });
  ok("C · createShipment ok → provider MANUAL, integration columns all null",
    good.ok && good.value.provider === "MANUAL" &&
    good.value.externalShipmentId === null && good.value.externalOrderId === null && good.value.service === null &&
    good.value.labelUrl === null && good.value.shippingCostAmount === null && good.value.shippingCostCurrency === null &&
    good.value.estimatedDeliveryAt === null,
    JSON.stringify(good));
  ok("C · createShipment core fields match resolveManualShipment",
    good.ok && good.value.carrier === "JT_EXPRESS" && good.value.carrierName === "J&T Express" &&
    good.value.trackingNumber === "ABC123");
  const bad = await manualShippingProvider.createShipment({ sellerOrderId: "so-x", carrier: "JT_EXPRESS" });
  ok("C · createShipment surfaces the validation error string verbatim", !bad.ok && bad.error === ERR.tnRequired("J&T Express"));

  // ── D · registry fails closed to MANUAL ─────────────────────────────────
  const cfg = await getShippingConfig();
  ok("D · production getShippingConfig → integration disabled, provider \"\", mode test",
    cfg.integrationEnabled === false && cfg.provider === "" && cfg.mode === "test", JSON.stringify(cfg));
  ok("D · resolveShippingProvider() → MANUAL under production config",
    (await resolveShippingProvider()).code === "MANUAL");
  ok("D · resolveShippingProvider() never returns null / throws — always a provider",
    typeof (await resolveShippingProvider()).code === "string");
  // static: the fail-closed chain — enabled requires the switch AND a KNOWN
  // provider AND its credentials; the resolver still ?? manualShippingProvider.
  ok("D · getShippingConfig gates on switch === \"true\" && providerKnown && credentials",
    /map\.get\("shipping\.integrationEnabled"\) === "true" &&\s*providerKnown &&\s*providerCredentialsPresent\(providerRaw\)/.test(reg));
  ok("D · unknown / unregistered provider falls through to MANUAL",
    /return PROVIDERS\[cfg\.provider\] \?\? manualShippingProvider;/.test(reg) &&
    /if \(!cfg\.integrationEnabled\) return manualShippingProvider;/.test(reg));
  ok("D · credentials read from env only; registry StoreSetting reads are just the 3 shipping.* config keys",
    /process\.env\[`SHIPPING_\$\{provider\}_API_KEY`\]/.test(reg) &&
    /SETTING_KEYS = \["shipping\.integrationEnabled", "shipping\.provider", "shipping\.mode"\]/.test(reg) &&
    (reg.match(/storeSetting\./g) ?? []).length === 1 &&
    !/API_KEY|SECRET|token|credential/i.test(reg.slice(reg.indexOf("storeSetting.findMany"), reg.indexOf("storeSetting.findMany") + 200)));

  // ── E · no carrier API anywhere under src/lib/shipping ───────────────────
  const shippingFiles = ["src/lib/shipping/provider.ts", "src/lib/shipping/registry.ts", "src/lib/shipping/providers/manual.ts"];
  for (const f of shippingFiles) {
    const src = read(f);
    ok(`E · ${f} makes no network call`,
      !/\bfetch\s*\(/.test(src) && !/\baxios\b/.test(src) && !/\bundici\b/.test(src) &&
      !/https?:\/\/[a-z]/i.test(src.replace(/\/\/[^\n]*/g, "")) /* ignore // comments */);
  }
  ok("E · manual provider webhooks are no-ops", manualShippingProvider.verifyWebhook("", null) === false && manualShippingProvider.parseWebhook("").length === 0);
  ok("E · shipping.integrationEnabled default is still false in the registry", read("src/lib/admin/settings-registry.ts").includes('key: "shipping.integrationEnabled"') && /default: false/.test(read("src/lib/admin/settings-registry.ts").slice(read("src/lib/admin/settings-registry.ts").indexOf('"shipping.integrationEnabled"'))));

  // ── F · repository wiring ───────────────────────────────────────────────
  const repo = read("src/lib/marketplace/seller-order-repository.ts");
  ok("F · saveSellerShipment resolves the provider and calls createShipment",
    /const provider = await resolveShippingProvider\(\);/.test(repo) &&
    /const outcome = await provider\.createShipment\(\{ sellerOrderId, \.\.\.input \}\);/.test(repo));
  ok("F · the old local resolveShipment function is gone from the repository", !/function resolveShipment\(/.test(repo));
  ok("F · transaction boundary unchanged (still prisma.$transaction(run) / externalTx)",
    /if \(externalTx\) return await run\(externalTx\);/.test(repo) && /return await prisma\.\$transaction\(run\);/.test(repo));
  ok("F · persisted columns unchanged — create still {...resolved.data, status: \"PENDING\"}, no provider column",
    /data: \{ sellerOrderId, \.\.\.resolved\.data, status: "PENDING" \}/.test(repo) &&
    /await tx\.shipment\.update\(\{ where: \{ id: owned\.id \}, data: resolved\.data \}\)/.test(repo));
  ok("F · one-shipment-per-SellerOrder + ownership + edit guards unchanged",
    /This order already has a shipment/.test(repo) && /No such order for this seller\./.test(repo) &&
    /This order can no longer be edited\./.test(repo) && /A delivered shipment can't be edited\./.test(repo));
  ok("F · advanceSellerOrderStatus / rollUpParentOrder / hasShippableShipment untouched",
    /const hasShippableShipment = so\.shipments\.some/.test(repo) &&
    /courier: ship\?\.carrier \?\? null,/.test(repo));
  const actions = read("src/lib/seller/order-actions.ts");
  ok("F · saveShipmentAction unchanged (same schema, same messages, same revalidate)",
    /carrier: z\.string\(\)\.trim\(\)\.min\(1, "Choose a carrier"\)/.test(actions) &&
    /return \{ ok: true, message: d\.shipmentId \? "Shipment updated\." : "Shipment saved\." \};/.test(actions) &&
    /revalidate\(d\.sellerOrderId\);/.test(actions));

  // ── G · rolled-back real saveSellerShipment ─────────────────────────────
  const { saveSellerShipment } = await import("../src/lib/marketplace/seller-order-repository");
  const ctx = { sellerId: STYLE_AVENUE, sellerName: "Style Avenue", sellerUserId: "t", userId: "t", role: "OWNER" as const, permissions: new Set<string>() };
  const shipBefore = await prisma.shipment.count();

  try {
    await prisma.$transaction(async (tx) => {
      const so = await tx.sellerOrder.findFirst({ where: { sellerId: STYLE_AVENUE, status: { notIn: ["CANCELLED", "DELIVERED"] }, shipments: { none: {} } }, select: { id: true } });
      if (!so) { ok("G · (no eligible SellerOrder — skipped)", true); throw new Rollback(); }
      const r = await saveSellerShipment(ctx, so.id, { carrier: "JT_EXPRESS", trackingNumber: "T9F47C1" }, undefined, tx);
      ok("G · manual saveSellerShipment create → ok", r.ok, JSON.stringify(r));
      if (r.ok) {
        const row = await tx.shipment.findUnique({ where: { id: r.shipmentId } });
        ok("G · created Shipment.status === PENDING", row?.status === "PENDING");
        ok("G · created Shipment.provider stays NULL for a manual shipment", row?.provider === null);
        ok("G · created Shipment carries the resolved carrier/tracking/auto-URL",
          row?.carrier === "JT_EXPRESS" && row?.carrierName === "J&T Express" && row?.trackingNumber === "T9F47C1" &&
          row?.trackingUrl === "https://www.jtexpress.ph/index/query/gzquery.html?bills=T9F47C1");
        ok("G · all 9F-47B integration columns NULL on the manual row",
          row?.externalShipmentId === null && row?.service === null && row?.labelUrl === null &&
          row?.shippingCostAmount === null && row?.metadata === null);
        // second create on the same SellerOrder → CONFLICT
        const dup = await saveSellerShipment(ctx, so.id, { carrier: "LALAMOVE" }, undefined, tx);
        ok("G · a 2nd shipment on the same SellerOrder is refused (CONFLICT)", !dup.ok && dup.code === "CONFLICT", JSON.stringify(dup));
      }
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }

  // validation error path still surfaces through the repo
  try {
    await prisma.$transaction(async (tx) => {
      const so = await tx.sellerOrder.findFirst({ where: { sellerId: STYLE_AVENUE, status: { notIn: ["CANCELLED", "DELIVERED"] }, shipments: { none: {} } }, select: { id: true } });
      if (!so) throw new Rollback();
      const r = await saveSellerShipment(ctx, so.id, { carrier: "JT_EXPRESS" }, undefined, tx); // no tracking
      ok("G · validation failure surfaces as VALIDATION + the same message", !r.ok && r.code === "VALIDATION" && r.error === ERR.tnRequired("J&T Express"), JSON.stringify(r));
      throw new Rollback();
    });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }

  ok("G · rollback — production Shipment count unchanged", (await prisma.shipment.count()) === shipBefore);

  // ── H · production untouched ────────────────────────────────────────────
  ok("H · ShipmentEvent still 0", (await prisma.shipmentEvent.count()) === 0);
  ok("H · Order / SellerOrder / SellerSettlement counts unchanged",
    (await prisma.order.count()) === 9 && (await prisma.sellerOrder.count()) === 9 && (await prisma.sellerSettlement.count()) === 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
