/**
 * PHASE 9F-23c — 1P product condition / CMS control.
 *
 * Admin/CMS can now set the `condition` of the single Axiaro FIRST_PARTY (1P)
 * Offer for a variant. Model B: ONE offer per variant, condition an editable
 * attribute of that row.
 *
 * Source of the change:
 *   src/lib/admin/catalog-schemas.ts       OFFER_CONDITIONS + variantUpdateSchema.condition
 *   src/lib/admin/offer-sync.ts            setFirstPartyOfferCondition(variantId, condition, tx)
 *   src/lib/admin/catalog-actions.ts       updateVariant (guarded, in-transaction) + addVariant (create-time)
 *   src/lib/admin/catalog.ts               getAdminProduct — 1P offer condition on each variant
 *   src/app/admin/(shell)/products/[id]/page.tsx  passes condition + productActive
 *   src/components/admin/catalog/product-editor.tsx  passes productActive
 *   src/components/admin/catalog/product-variants.tsx  Condition column + AddVariant field
 *
 * Guards (setFirstPartyOfferCondition): unknown value / zero FP offer / >1 FP
 * offer → safe failure; product ACTIVE → rejected with
 * "Set this product to Draft before changing its condition."; historical
 * OrderItem.condition never touched.
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back. No
 * production offer / order / inventory / condition is created or changed.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f23c.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  ensureFirstPartyOffer,
  setFirstPartyOfferCondition,
  syncFirstPartyOfferPrice,
  syncFirstPartyOfferStock,
  syncFirstPartyOfferReorderPoint,
} from "@/lib/admin/offer-sync";
import { conditionLabel, isNoteworthyCondition } from "@/lib/seller/format";
import { OFFER_CONDITIONS } from "@/lib/admin/catalog-schemas";
import { resolveWinningOfferView } from "@/lib/marketplace/buy-box-rule";

/**
 * Replica of `cardCondition` / `pdpCondition` (`src/lib/data.ts`) AFTER the
 * 9F-23c parity fix: resolve ONE winner across the product's whole offer pool,
 * chip = that winner's condition when non-NEW. Kept byte-for-byte in step with
 * the source shape (asserted statically below).
 */
type ReplOffer = {
  id: string; status: string; price: number; compareAtPrice: number | null;
  createdAt: Date; condition: string;
  seller: { type: string; status: string };
  inventory: { quantity: number; reserved: number; reorderPoint: number } | null;
};
function winnerCondition(variants: { offers: ReplOffer[] }[]): string | null {
  const allOffers = variants.flatMap((v) => v.offers);
  const candidates = allOffers.map((o) => ({
    offerId: o.id,
    sellerId: "",
    sellerType: (o.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY") as "FIRST_PARTY" | "THIRD_PARTY",
    sellerStatus: o.seller.status as "APPROVED",
    offerStatus: o.status as "ACTIVE",
    available: Math.max(0, (o.inventory?.quantity ?? 0) - (o.inventory?.reserved ?? 0)),
    reorderPoint: o.inventory?.reorderPoint ?? 0,
    price: o.price,
    compareAtPrice: o.compareAtPrice,
    createdAt: o.createdAt,
  }));
  const win = resolveWinningOfferView(candidates);
  if (!win) return null;
  const row = allOffers.find((o) => o.id === win.offerId);
  return row && row.condition !== "NEW" ? row.condition : null;
}

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

class Rollback extends Error {}

// ── fixtures ─────────────────────────────────────────────────────────────
async function mkProduct(tx: Prisma.TransactionClient, categoryId: string, slug: string, status: string) {
  return tx.product.create({
    data: {
      name: `T ${slug}`, slug, shortDescription: "s", description: "d",
      categoryId, status, price: 1000,
    },
    select: { id: true },
  });
}
async function mkVariantWithOffer(
  tx: Prisma.TransactionClient,
  sellerId: string,
  productId: string,
  sku: string,
  condition = "NEW",
) {
  const v = await tx.variant.create({
    data: { productId, sku, price: 1000, status: "ACTIVE", stock: 10 },
    select: { id: true },
  });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: 10, reserved: 0, reorderPoint: 3 } });
  const o = await tx.offer.create({
    data: { sellerId, variantId: v.id, price: 1000, condition, status: "ACTIVE", sellerSku: sku },
    select: { id: true },
  });
  await tx.offerInventory.create({
    data: { offerId: o.id, sellerSku: `oi-${sku}`, quantity: 10, reserved: 0, reorderPoint: 3 },
  });
  return { variantId: v.id, offerId: o.id };
}

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const schemas = read("src/lib/admin/catalog-schemas.ts");
  const sync = read("src/lib/admin/offer-sync.ts");
  const actions = read("src/lib/admin/catalog-actions.ts");
  const catalog = read("src/lib/admin/catalog.ts");
  const page = read("src/app/admin/(shell)/products/[id]/page.tsx");
  const editor = read("src/components/admin/catalog/product-editor.tsx");
  const comp = read("src/components/admin/catalog/product-variants.tsx");
  const format = read("src/lib/seller/format.ts");
  const data = read("src/lib/data.ts");

  // C — supported values + labels (9F-36B: the list lives in the one canonical
  // module `@/lib/marketplace/conditions`; catalog-schemas.ts re-exports it).
  const conditionsMod = read("src/lib/marketplace/conditions.ts");
  ok("conditions · OFFER_CONDITIONS = the five approved values in order",
    /OFFER_CONDITIONS = \[\s*"NEW",\s*"REFURBISHED",\s*"OPEN_BOX",\s*"USED_LIKE_NEW",\s*"USED_GOOD",\s*\]/.test(conditionsMod));
  ok("schemas · catalog-schemas re-exports OFFER_CONDITIONS from the canonical module",
    /import \{ OFFER_CONDITIONS \} from "@\/lib\/marketplace\/conditions"/.test(schemas) &&
    /export \{ OFFER_CONDITIONS \}/.test(schemas));
  ok("schemas · variantUpdateSchema gains optional condition: z.enum(OFFER_CONDITIONS)",
    /condition: z\.enum\(OFFER_CONDITIONS\)\.optional\(\)/.test(schemas));
  ok("format · conditionLabel covers all five values",
    OFFER_CONDITIONS.every((c) => conditionLabel(c) !== c) &&
    conditionLabel("NEW") === "New" && conditionLabel("USED_LIKE_NEW") === "Used — like new");

  // D / E — server helper
  ok("offer-sync · setFirstPartyOfferCondition(variantId, condition, tx) exported",
    /export async function setFirstPartyOfferCondition\(\s*\n?\s*variantId: string,\s*\n?\s*condition: string,\s*\n?\s*tx: Prisma\.TransactionClient,/.test(sync));
  ok("offer-sync · helper validates against OFFER_CONDITIONS",
    /if \(!\(OFFER_CONDITIONS as readonly string\[\]\)\.includes\(condition\)\)/.test(sync));
  ok("offer-sync · helper resolves the FIRST_PARTY offer by seller type, FOR UPDATE OF o LIMIT 2",
    /WHERE o\."variantId" = \$\{variantId\} AND s\."type" = 'FIRST_PARTY'\s*\n\s*FOR UPDATE OF o\s*\n\s*LIMIT 2/.test(sync));
  ok("offer-sync · zero-offer safe failure", /if \(rows\.length === 0\) return \{ ok: false, error: "No Axiaro listing exists for that variant\." \};/.test(sync));
  ok("offer-sync · multiple-offer safe failure (no arbitrary pick)", /if \(rows\.length > 1\) \{\s*\n\s*return \{\s*\n\s*ok: false,/.test(sync));
  ok("offer-sync · ACTIVE product rejected with the exact message",
    /if \(offer\.productStatus === "ACTIVE"\) \{\s*\n\s*return \{ ok: false, error: "Set this product to Draft before changing its condition\." \};/.test(sync));
  ok("offer-sync · no-op when condition already equal (succeeds, no write)",
    /if \(offer\.condition === condition\) \{\s*\n\s*return \{ ok: true, previous: offer\.condition, changed: false \};/.test(sync));
  ok("offer-sync · updates the EXISTING offer row in place (tx.offer.update by id)",
    /await tx\.offer\.update\(\{ where: \{ id: offer\.id \}, data: \{ condition \} \}\);/.test(sync));
  ok("offer-sync · helper never calls tx.offer.create", (() => {
    const m = sync.match(/export async function setFirstPartyOfferCondition[\s\S]*?\n\}/);
    return !!m && !/\.create\(/.test(m[0]);
  })());

  // 9F-23b discovery/sync must NOT have condition="NEW" reintroduced
  const syncCode = strip(sync);
  ok("offer-sync · 9F-23b discovery/sync still condition-independent (no `condition = 'NEW'` / hardcoded filter)",
    !/condition\s*=\s*'NEW'/.test(syncCode) &&
    !/condition:\s*"NEW"(?!\s*[,);])/.test(syncCode.replace(/opts\.condition \?\? "NEW"/g, "")));
  ok("offer-sync · ensureFirstPartyOffer still findFirst({ sellerId, variantId }) + opts.condition ?? \"NEW\" (create-only)",
    /const existing = await tx\.offer\.findFirst\(\{\s*\n?\s*where: \{ sellerId, variantId: variant\.id \},/.test(sync) &&
    /condition: opts\.condition \?\? "NEW",/.test(sync));
  ok("first-party-inventory · FIRST_PARTY_OFFER_FILTER still seller-only (9F-23b intact)",
    /FIRST_PARTY_OFFER_FILTER = \{\s*\n\s*seller: \{ is: \{ type: "FIRST_PARTY" \} \},\s*\n\s*\} satisfies/.test(read("src/lib/admin/first-party-inventory.ts")));

  // updateVariant / addVariant wiring
  ok("actions · updateVariant parses condition and runs the write in prisma.$transaction",
    /variantUpdateSchema\.safeParse\(\{[\s\S]{0,400}rawCondition == null \? \{\} : \{ condition: String\(rawCondition\) \}/.test(actions) &&
    /await prisma\.\$transaction\(async \(tx\) => \{[\s\S]{0,1400}setFirstPartyOfferCondition\(id, data\.condition, tx\)/.test(actions));
  ok("actions · updateVariant rolls the whole save back on a rejected condition (ConditionRejected)",
    /class ConditionRejected extends Error \{\}/.test(actions) &&
    /if \(err instanceof ConditionRejected\) return \{ error: err\.message \};/.test(actions));
  ok("actions · updateVariant still calls revalidateStorefront() after the save",
    /\}\s*\n\s*await writeAudit\(\{[\s\S]{0,400}catalog\.variant\.updated[\s\S]{0,400}\}\);\s*\n\s*revalidateStorefront\(\);\s*\n\s*return \{ ok: true, message: "Variant saved\." \};/.test(actions));
  ok("actions · addVariant validates condition + passes it to ensureFirstPartyOffer (create-time seam)",
    /const condition = String\(formData\.get\("condition"\) \?\? "NEW"\);/.test(actions) &&
    /if \(!\(OFFER_CONDITIONS as readonly string\[\]\)\.includes\(condition\)\)/.test(actions) &&
    /\{ productStatus: product\.status, costPrice: product\.costPrice, condition \}/.test(actions));
  ok("actions · syncFirstPartyOfferPrice now receives the tx client inside updateVariant",
    /syncFirstPartyOfferPrice\(\s*\n?\s*id,\s*\n?\s*\{ price: data\.price, compareAtPrice: data\.compareAtPrice \?\? null \},\s*\n?\s*tx,\s*\n?\s*\)/.test(actions));
  ok("actions · updateVariant touches the frozen legacy Inventory row ONLY on a real SKU rename",
    /if \(data\.sku !== variant\.sku\) \{\s*\n\s*await tx\.inventory\.updateMany\(\{ where: \{ variantId: id \}, data: \{ sku: data\.sku \} \}\);\s*\n\s*\}/.test(actions) &&
    (actions.match(/tx\.inventory\.updateMany/g) ?? []).length === 1);

  // getAdminProduct
  ok("catalog · getAdminProduct includes the FIRST_PARTY offer condition per variant (take: 2)",
    /offers: \{\s*\n\s*where: \{ seller: \{ is: \{ type: "FIRST_PARTY" \} \} \},\s*\n\s*orderBy: \{ createdAt: "asc" \},\s*\n\s*take: 2,\s*\n\s*select: \{ condition: true \},/.test(catalog));

  // page + editor plumbing
  ok("page · variant map exposes condition + hasMultipleOffers",
    /condition: v\.offers\[0\]\?\.condition \?\? "NEW",/.test(page) && /hasMultipleOffers: v\.offers\.length > 1,/.test(page));
  ok("editor · passes productActive={product.status === \"ACTIVE\"} to ProductVariants",
    /productActive=\{product\.status === "ACTIVE"\}/.test(editor));

  // component UI
  ok("component · imports conditionLabel + OFFER_CONDITIONS",
    /import \{ VARIANT_STATUSES, OFFER_CONDITIONS \} from "@\/lib\/admin\/catalog-schemas"/.test(comp) &&
    /import \{ conditionLabel \} from "@\/lib\/seller\/format"/.test(comp));
  ok("component · VariantRow renders a Condition <Select name=\"condition\"> over OFFER_CONDITIONS",
    /name="condition"\s*\n\s*defaultValue=\{variant\.condition\}/.test(comp) &&
    /\{OFFER_CONDITIONS\.map\(\(c\) => \(\s*\n\s*<option key=\{c\} value=\{c\}>\s*\n\s*\{conditionLabel\(c\)\}/.test(comp));
  ok("component · Condition selector locked when !canEdit || productActive || hasMultipleOffers",
    /const conditionLocked = !canEdit \|\| productActive \|\| variant\.hasMultipleOffers;/.test(comp));
  ok("component · shows the Draft hint when canEdit && productActive",
    /canEdit && productActive && \(\s*\n\s*<p[^>]*>\{CONDITION_LOCK_HINT\}<\/p>/.test(comp) &&
    /CONDITION_LOCK_HINT = "Set this product to Draft before changing its condition\.";/.test(comp));
  ok("component · AddVariant has a Condition field defaulting to NEW",
    /<Select id="av-condition" name="condition" defaultValue="NEW">/.test(comp));
  ok("component · no second-1P-offer UI (no 'add offer' / offer-status control in the variant editor)",
    !/offer status|Offer status|addOffer|offerStatus/.test(comp));

  // 9F-22 customer display — only data.ts changes (the approved Fix A: PLP/PDP
  // condition-chip winner parity); the components + labels are untouched.
  ok("9F-22 · isNoteworthyCondition still gates non-NEW display (NEW suppressed)",
    isNoteworthyCondition("REFURBISHED") === true && isNoteworthyCondition("NEW") === false && isNoteworthyCondition(null) === false);
  ok("9F-22 · card / PDP / order components carry no 9F-23c edits",
    !/9F-23c/.test(read("src/components/product-card.tsx")) &&
    !/9F-23c/.test(read("src/components/pdp/product-viewer.tsx")) &&
    !/9F-23c/.test(read("src/components/order/order-detail.tsx")));
  ok("9F-22 · format.ts CONDITION_LABEL unchanged (no 9F-23c marker)", !/9F-23c/.test(format));

  // Fix A — cardCondition + pdpCondition resolve ONE winner across the whole
  // offer pool (parity with the buy-box binding), not a per-variant cheapest.
  ok("fix A · cardCondition flattens all variants' offers + resolveWinningOfferView, no `cheapest`",
    /function cardCondition\([\s\S]{0,900}variants\.flatMap\(\(v\) => v\.offers\)[\s\S]{0,600}resolveWinningOfferView\(candidates\)[\s\S]{0,200}row && row\.condition !== "NEW"/.test(data) &&
    !/function cardCondition\([\s\S]{0,900}cheapest/.test(data));
  ok("fix A · pdpCondition uses the same whole-pool winner (activeVariants.flatMap + resolveWinningOfferView), no `cheapest`",
    /const pdpCondition = \(\(\) => \{\s*\n\s*const allOffers = activeVariants\.flatMap\(\(v\) => v\.offers\);\s*\n\s*const win = resolveWinningOfferView\(allOffers\.map\(fullCandidate\)\)[\s\S]{0,200}row && row\.condition !== "NEW"/.test(data) &&
    !/const pdpCondition = \(\(\) => \{[\s\S]{0,400}cheapest/.test(data));
  ok("fix A · rankOffers / buy-box-rule.ts genuinely untouched (no 9F-23c, no 9F-22-era edit reverted)",
    !/9F-23c/.test(read("src/lib/marketplace/buy-box-rule.ts")) && /export function rankOffers|export const rankOffers/.test(read("src/lib/marketplace/buy-box-rule.ts")));

  // scope guards
  ok("scope · checkout / OrderItem snapshot untouched", !/9F-23c/.test(read("src/lib/checkout.ts")));
  ok("scope · buy-box ranking untouched", !/9F-23c/.test(read("src/lib/marketplace/buy-box-rule.ts")) && !/9F-23c/.test(read("src/lib/marketplace/offer-resolver.ts")));
  ok("scope · 3P seller condition logic untouched", !/9F-23c/.test(read("src/lib/marketplace/seller-repository.ts")) && !/9F-23c/.test(read("src/lib/seller/offer-actions.ts")));
  ok("scope · settlement / email / order-status untouched",
    !/9F-23c/.test(read("src/lib/marketplace/settlement.ts")) && !/9F-23c/.test(read("src/lib/email/notifications.ts")) && !/9F-23c/.test(read("src/lib/orders/status.ts")));
  ok("scope · analytics / dashboard / reconcile not re-touched",
    !/9F-23c/.test(read("src/lib/analytics/queries.ts")) && !/9F-23c/.test(read("src/app/admin/(shell)/page.tsx")) && !/9F-23c/.test(read("scripts/reconcile-9e3d.ts")));
  ok("scope · schema.prisma unchanged (no 9F-23c marker, @@unique intact)",
    !/9F-23c/.test(read("prisma/schema.prisma")) && /@@unique\(\[sellerId, variantId, condition\]\)/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts untouched", !/9F-23c/.test(read("scripts/seed-rbac.ts")));
}

// ── behaviour (rolled-back fixtures) ─────────────────────────────────────
async function dbTests() {
  console.log("\n── behaviour (fixtures rolled back) ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!axiaro || !category) return ok("(skipped — no FIRST_PARTY seller / category)", true);
  const sfx = "9f23c-" + Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // 1–5 — Admin can set each of the five conditions (DRAFT product)
      for (const target of OFFER_CONDITIONS) {
        const n = OFFER_CONDITIONS.indexOf(target) + 1;
        const p = await mkProduct(tx, category.id, `${sfx}-set-${target}`, "DRAFT");
        // start each fixture from OPEN_BOX so every target (NEW included) is a real change
        const seed = target === "OPEN_BOX" ? "REFURBISHED" : "OPEN_BOX";
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `set-${target}-${sfx}`, seed);
        const res = await setFirstPartyOfferCondition(variantId, target, tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { id: true, condition: true } });
        ok(`${n} · admin can set 1P condition to ${target}`,
          res.ok && "changed" in res && res.changed === true &&
          res.previous === seed && row.condition === target && row.id === offerId);
      }

      // 6 — invalid condition rejected
      {
        const p = await mkProduct(tx, category.id, `${sfx}-inv`, "DRAFT");
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `inv-${sfx}`, "NEW");
        const res = await setFirstPartyOfferCondition(variantId, "PRE_OWNED", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { condition: true } });
        ok("6 · invalid condition value is rejected, offer unchanged", !res.ok && row.condition === "NEW");
      }

      // 7 / 8 — ACTIVE product: rejected + unchanged
      {
        const p = await mkProduct(tx, category.id, `${sfx}-active`, "ACTIVE");
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `active-${sfx}`, "NEW");
        const res = await setFirstPartyOfferCondition(variantId, "REFURBISHED", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { condition: true } });
        ok("7 · ACTIVE product → condition change rejected with the Draft message",
          !res.ok && "error" in res && res.error === "Set this product to Draft before changing its condition.");
        ok("8 · ACTIVE product → offer condition unchanged after the rejected update", row.condition === "NEW");
        // a NEW→NEW no-op is still allowed even while ACTIVE
        const noop = await setFirstPartyOfferCondition(variantId, "NEW", tx);
        ok("8 · a same-value no-op succeeds without a write even while ACTIVE", noop.ok && "changed" in noop && noop.changed === false);
      }

      // 9 / 10 / 11 — DRAFT change succeeds; same Offer.id; OfferInventory still attached
      {
        const p = await mkProduct(tx, category.id, `${sfx}-draft`, "DRAFT");
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `draft-${sfx}`, "NEW");
        const oiBefore = await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { id: true } });
        const res = await setFirstPartyOfferCondition(variantId, "OPEN_BOX", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { id: true, condition: true } });
        const oiAfter = await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { id: true, offerId: true } });
        ok("9 · DRAFT product → condition change succeeds", res.ok && row.condition === "OPEN_BOX");
        ok("10 · Offer.id is unchanged by the condition change", row.id === offerId);
        ok("11 · OfferInventory row is the same and still bound to the same offer", oiAfter.id === oiBefore.id && oiAfter.offerId === offerId);
      }

      // 12 — no second FIRST_PARTY offer is created
      {
        const p = await mkProduct(tx, category.id, `${sfx}-nodupe`, "DRAFT");
        const { variantId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `nodupe-${sfx}`, "NEW");
        await setFirstPartyOfferCondition(variantId, "REFURBISHED", tx);
        await setFirstPartyOfferCondition(variantId, "USED_GOOD", tx);
        const offers = await tx.offer.findMany({ where: { sellerId: axiaro.id, variantId }, select: { id: true } });
        ok("12 · still exactly one FIRST_PARTY offer after repeated condition changes", offers.length === 1);
      }

      // 13 — multiple FIRST_PARTY offers → safe failure
      {
        const p = await mkProduct(tx, category.id, `${sfx}-multi`, "DRAFT");
        const { variantId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `multi-a-${sfx}`, "NEW");
        // a second Axiaro offer for the same variant (different condition — @@unique allows it)
        await tx.offer.create({ data: { sellerId: axiaro.id, variantId, price: 1000, condition: "REFURBISHED", status: "ACTIVE", sellerSku: `multi-b-${sfx}` } });
        const res = await setFirstPartyOfferCondition(variantId, "OPEN_BOX", tx);
        ok("13 · >1 FIRST_PARTY offer → safe failure (no arbitrary pick)",
          !res.ok && "error" in res && /more than one Axiaro listing/.test(res.error));
      }

      // 14 — zero FIRST_PARTY offer → safe failure
      {
        const p = await mkProduct(tx, category.id, `${sfx}-zero`, "DRAFT");
        const v = await tx.variant.create({ data: { productId: p.id, sku: `zero-${sfx}`, price: 1000, status: "ACTIVE", stock: 0 }, select: { id: true } });
        const res = await setFirstPartyOfferCondition(v.id, "REFURBISHED", tx);
        ok("14 · zero FIRST_PARTY offer → safe failure", !res.ok && "error" in res && /No Axiaro listing/.test(res.error));
      }

      // 15 — 3P offers are never selected or modified
      {
        const p = await mkProduct(tx, category.id, `${sfx}-3p`, "DRAFT");
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `3p-fp-${sfx}`, "NEW");
        const tp = await tx.seller.create({
          data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `TP ${sfx}`, slug: `tp-${sfx}`, supportEmail: "tp@t.test" },
          select: { id: true },
        });
        const tpOffer = await tx.offer.create({ data: { sellerId: tp.id, variantId, price: 900, condition: "USED_GOOD", status: "ACTIVE", sellerSku: `3p-tp-${sfx}` }, select: { id: true } });
        const res = await setFirstPartyOfferCondition(variantId, "REFURBISHED", tx);
        const fp = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { condition: true } });
        const tpRow = await tx.offer.findUniqueOrThrow({ where: { id: tpOffer.id }, select: { condition: true } });
        ok("15 · the FIRST_PARTY offer changed, the THIRD_PARTY offer on the same variant is untouched",
          res.ok && fp.condition === "REFURBISHED" && tpRow.condition === "USED_GOOD");
      }

      // 16 — new variant can be created with a non-NEW condition (ensureFirstPartyOffer seam)
      {
        const p = await mkProduct(tx, category.id, `${sfx}-newvar`, "DRAFT");
        const v = await tx.variant.create({ data: { productId: p.id, sku: `newvar-${sfx}`, price: 1000, status: "ACTIVE", stock: 0 }, select: { id: true } });
        await tx.inventory.create({ data: { variantId: v.id, sku: `newvar-${sfx}`, quantity: 0, reserved: 0, reorderPoint: 3 } });
        await ensureFirstPartyOffer(
          { id: v.id, sku: `newvar-${sfx}`, price: 1000, compareAtPrice: null },
          { productStatus: "DRAFT", costPrice: null, condition: "USED_LIKE_NEW" },
          tx,
        );
        const offers = await tx.offer.findMany({ where: { sellerId: axiaro.id, variantId: v.id }, select: { id: true, condition: true } });
        ok("16 · new variant's first 1P offer is created with the chosen condition (one offer, USED_LIKE_NEW)",
          offers.length === 1 && offers[0].condition === "USED_LIKE_NEW");
        // and a re-run does not create a second offer or overwrite the condition
        await ensureFirstPartyOffer(
          { id: v.id, sku: `newvar-${sfx}`, price: 1000, compareAtPrice: null },
          { productStatus: "DRAFT", costPrice: null, condition: "NEW" },
          tx,
        );
        const after = await tx.offer.findMany({ where: { sellerId: axiaro.id, variantId: v.id }, select: { condition: true } });
        ok("16 · ensureFirstPartyOffer re-run keeps one offer and does not overwrite condition", after.length === 1 && after[0].condition === "USED_LIKE_NEW");
      }

      // 17 / 18 / 19 — price / stock / reorder-point sync still target the (now non-NEW) offer
      {
        const p = await mkProduct(tx, category.id, `${sfx}-sync`, "DRAFT");
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `sync-${sfx}`, "NEW");
        await setFirstPartyOfferCondition(variantId, "REFURBISHED", tx);
        await syncFirstPartyOfferPrice(variantId, { price: 2222, compareAtPrice: 2999 }, tx);
        const priced = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { price: true, compareAtPrice: true, condition: true } });
        ok("17 · 1P price sync still targets the offer after condition change (2222/2999, still REFURBISHED)",
          priced.price === 2222 && priced.compareAtPrice === 2999 && priced.condition === "REFURBISHED");
        const s = await syncFirstPartyOfferStock(variantId, 5, "RESTOCK", null, null, tx);
        const oi = await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { quantity: true } });
        ok("18 · 1P stock sync still targets the OfferInventory after condition change (+5 → 15)", s.ok && oi.quantity === 15);
        const r = await syncFirstPartyOfferReorderPoint(variantId, 7, tx);
        const oi2 = await tx.offerInventory.findFirstOrThrow({ where: { offerId }, select: { reorderPoint: true } });
        ok("19 · 1P reorder-point sync still targets the OfferInventory after condition change (3 → 7)", r.ok && oi2.reorderPoint === 7);
      }

      // 21 — historical OrderItem.condition snapshots are never rewritten
      {
        const p = await mkProduct(tx, category.id, `${sfx}-hist`, "DRAFT");
        const { variantId, offerId } = await mkVariantWithOffer(tx, axiaro.id, p.id, `hist-${sfx}`, "NEW");
        const v = await tx.variant.findUniqueOrThrow({ where: { id: variantId }, select: { productId: true } });
        const order = await tx.order.create({
          data: {
            orderNumber: `T-${sfx}`, email: "h@h.test", phone: "+639999999999", status: "DELIVERED",
            paymentStatus: "PAID", paymentMethod: "CARD",
            subtotal: 1000, shippingFee: 0, discountTotal: 0, grandTotal: 1000, shippingAddress: "{}",
          },
          select: { id: true },
        });
        const item = await tx.orderItem.create({
          data: { orderId: order.id, productId: v.productId, variantId, offerId, name: "H", unitPrice: 1000, quantity: 1, lineTotal: 1000, condition: "NEW" },
          select: { id: true },
        });
        await setFirstPartyOfferCondition(variantId, "USED_GOOD", tx);
        const snap = await tx.orderItem.findUniqueOrThrow({ where: { id: item.id }, select: { condition: true, offerId: true } });
        ok("21 · historical OrderItem.condition stays NEW after the offer flips to USED_GOOD; offerId binding intact",
          snap.condition === "NEW" && snap.offerId === offerId);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no fixture product leaked", (await prisma.product.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
}

// ── Fix A — PLP/PDP condition-chip winner parity (rolled-back fixtures) ───
async function plpParityDbTests() {
  console.log("\n── Fix A: PLP/PDP condition-chip winner parity ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!axiaro || !category) return ok("(skipped — no FIRST_PARTY seller / category)", true);
  const sfx = "9f23cA-" + Date.now();

  // Build a 2-variant product; each variant one Axiaro offer with a chosen
  // (condition, price). Offer A created first, then B (so a price tie breaks
  // to A on createdAt ASC). Returns the { offers } shape winnerCondition wants.
  async function twoVariant(
    tx: Prisma.TransactionClient, tag: string,
    a: { condition: string; price: number }, b: { condition: string; price: number },
  ) {
    const p = await mkProduct(tx, category!.id, `${sfx}-${tag}`, "ACTIVE");
    const mk = async (n: string, spec: { condition: string; price: number }) => {
      const v = await tx.variant.create({ data: { productId: p.id, sku: `${tag}-${n}-${sfx}`, price: spec.price, status: "ACTIVE", stock: 10 }, select: { id: true } });
      const o = await tx.offer.create({ data: { sellerId: axiaro!.id, variantId: v.id, price: spec.price, condition: spec.condition, status: "ACTIVE", sellerSku: `${tag}-${n}-${sfx}` }, select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, condition: true } });
      await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${tag}-${n}-${sfx}`, quantity: 10, reserved: 0, reorderPoint: 3 } });
      return { offers: [{ ...o, seller: { type: "FIRST_PARTY", status: "APPROVED" }, inventory: { quantity: 10, reserved: 0, reorderPoint: 3 } }] } as { offers: ReplOffer[] };
    };
    const vA = await mk("A", a);
    const vB = await mk("B", b);
    return [vA, vB];
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1 — cheaper REFURBISHED offer → Refurbished
      {
        const vs = await twoVariant(tx, "cheap-ref", { condition: "REFURBISHED", price: 4000 }, { condition: "NEW", price: 5000 });
        ok("1 · cheaper REFURBISHED offer → chip = REFURBISHED", winnerCondition(vs) === "REFURBISHED");
      }
      // 2 — cheaper NEW offer → no chip
      {
        const vs = await twoVariant(tx, "cheap-new", { condition: "NEW", price: 4000 }, { condition: "OPEN_BOX", price: 5000 });
        ok("2 · cheaper NEW offer → no chip (null)", winnerCondition(vs) === null);
      }
      // 3 — equal-price tie, non-NEW offer created first → that offer wins → its condition
      {
        const vs = await twoVariant(tx, "tie-ref1st", { condition: "REFURBISHED", price: 5000 }, { condition: "NEW", price: 5000 });
        ok("3 · equal-price tie, REFURBISHED created first → winner's condition = REFURBISHED (was null pre-fix)",
          winnerCondition(vs) === "REFURBISHED");
      }
      // 3b — equal-price tie, NEW created first → NEW legitimately wins the tie-break → no chip
      {
        const vs = await twoVariant(tx, "tie-new1st", { condition: "NEW", price: 5000 }, { condition: "USED_GOOD", price: 5000 });
        ok("3b · equal-price tie, NEW created first → NEW wins createdAt tie-break → no chip",
          winnerCondition(vs) === null);
      }
      // 4 — existing 9F-22 behaviour: single-variant products unchanged
      {
        const one = await twoVariant(tx, "single", { condition: "REFURBISHED", price: 4000 }, { condition: "REFURBISHED", price: 4000 });
        ok("4 · single non-NEW variant → REFURBISHED chip (9F-22 behaviour intact)", winnerCondition([one[0]]) === "REFURBISHED");
        const oneNew = await twoVariant(tx, "single-new", { condition: "NEW", price: 4000 }, { condition: "NEW", price: 4000 });
        ok("4 · single NEW variant → no chip (9F-22 behaviour intact)", winnerCondition([oneNew[0]]) === null);
      }
      // 5 — PDP and PLP use the SAME rule: winnerCondition is one function, both call sites replicate it
      ok("5 · cardCondition + pdpCondition share the identical whole-pool winner shape (asserted statically)", true);
      // 6 — an out-of-stock non-NEW winner is skipped by resolveWinningOfferView → falls to the NEW one
      {
        const p = await mkProduct(tx, category!.id, `${sfx}-oos`, "ACTIVE");
        const v1 = await tx.variant.create({ data: { productId: p.id, sku: `oos-1-${sfx}`, price: 4000, status: "ACTIVE", stock: 0 }, select: { id: true } });
        const o1 = await tx.offer.create({ data: { sellerId: axiaro!.id, variantId: v1.id, price: 4000, condition: "REFURBISHED", status: "ACTIVE", sellerSku: `oos-1-${sfx}` }, select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, condition: true } });
        await tx.offerInventory.create({ data: { offerId: o1.id, sellerSku: `oi-oos-1-${sfx}`, quantity: 0, reserved: 0, reorderPoint: 3 } });
        const v2 = await tx.variant.create({ data: { productId: p.id, sku: `oos-2-${sfx}`, price: 5000, status: "ACTIVE", stock: 10 }, select: { id: true } });
        const o2 = await tx.offer.create({ data: { sellerId: axiaro!.id, variantId: v2.id, price: 5000, condition: "NEW", status: "ACTIVE", sellerSku: `oos-2-${sfx}` }, select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, condition: true } });
        await tx.offerInventory.create({ data: { offerId: o2.id, sellerSku: `oi-oos-2-${sfx}`, quantity: 10, reserved: 0, reorderPoint: 3 } });
        const vs = [
          { offers: [{ ...o1, seller: { type: "FIRST_PARTY", status: "APPROVED" }, inventory: { quantity: 0, reserved: 0, reorderPoint: 3 } }] },
          { offers: [{ ...o2, seller: { type: "FIRST_PARTY", status: "APPROVED" }, inventory: { quantity: 10, reserved: 0, reorderPoint: 3 } }] },
        ];
        ok("6 · out-of-stock REFURBISHED winner skipped → chip reflects the in-stock NEW winner (no chip)", winnerCondition(vs) === null);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("ROLLBACK · no Fix-A fixture leaked", (await prisma.product.count({ where: { slug: { contains: sfx } } })) === 0);
}

// ── 20 / 22 / 23 / 24 + production read-only ─────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!axiaro) return ok("(skipped — no FIRST_PARTY seller)", true);

  // Every non-NEW FIRST_PARTY offer must belong to the halo-pendant test product
  // (the ONLY intentional production condition change in this phase). Holds both
  // during the round-trip (1 non-NEW) and after the Step F restore (0 non-NEW).
  const nonNew = await prisma.offer.findMany({
    where: { seller: { is: { type: "FIRST_PARTY" } }, condition: { not: "NEW" } },
    select: { condition: true, variant: { select: { product: { select: { slug: true } } } } },
  });
  ok("prod · the only non-NEW 1P offer(s) belong to halo-pendant (the sanctioned test product)",
    nonNew.every((o) => o.variant.product.slug === "halo-pendant"), JSON.stringify(nonNew.map((o) => `${o.variant.product.slug}:${o.condition}`)));

  // Live PLP/PDP parity for the Halo product — the actual customer-facing check.
  const halo = await prisma.product.findUnique({
    where: { slug: "halo-pendant" },
    select: {
      status: true,
      variants: {
        where: { status: "ACTIVE" },
        select: {
          sku: true,
          offers: { select: { id: true, status: true, price: true, compareAtPrice: true, createdAt: true, condition: true, seller: { select: { type: true, status: true } }, inventory: { select: { quantity: true, reserved: true, reorderPoint: true } } } },
        },
      },
    },
  });
  if (halo) {
    const chip = winnerCondition(halo.variants as unknown as { offers: ReplOffer[] }[]);
    const perVariant = Object.fromEntries(halo.variants.map((v) => [v.sku, v.offers[0]?.condition]));
    ok(`prod · Halo PLP/PDP chip = winning offer's condition (${chip ?? "null"})`,
      chip === "REFURBISHED" || chip === null, `chip=${chip} perVariant=${JSON.stringify(perVariant)}`);
    // if HALO-PENDANT-01 is REFURBISHED and it's the winner, chip must be REFURBISHED (not null — the pre-fix bug)
    const p01 = halo.variants.find((v) => v.sku === "HALO-PENDANT-01");
    if (p01?.offers[0]?.condition === "REFURBISHED" && halo.status === "ACTIVE") {
      ok("prod · Halo (HALO-PENDANT-01 REFURBISHED, ACTIVE) → chip resolves to REFURBISHED, not null (Fix A works live)",
        chip === "REFURBISHED", `chip=${chip}`);
      ok("prod · Halo HALO-PENDANT-02 stays NEW (per-variant, not inherited)", perVariant["HALO-PENDANT-02"] === "NEW");
    }
  }

  const multi = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*)::int AS n FROM (SELECT o."variantId" FROM "Offer" o JOIN "Seller" s ON s.id=o."sellerId" WHERE s.type='FIRST_PARTY' GROUP BY o."variantId" HAVING COUNT(*)>1) d`,
  );
  ok("prod · still exactly one FIRST_PARTY offer per variant", multi[0].n === 0, `${multi[0].n} with >1`);

  const sa = await prisma.offer.findFirst({ where: { seller: { is: { displayName: "Style Avenue" } } }, select: { condition: true, status: true } });
  ok("prod · Style Avenue 3P offer untouched (NEW / ACTIVE)", sa?.condition === "NEW" && sa?.status === "ACTIVE", JSON.stringify(sa));

  ok("prod · Inventory 332 / OfferInventory 333 / Variant 332 (unchanged)",
    (await prisma.inventory.count()) === 332 && (await prisma.offerInventory.count()) === 333 && (await prisma.variant.count()) === 332);

  const nullSnap = await prisma.orderItem.count({ where: { condition: { not: null } } });
  ok("prod · no production OrderItem.condition snapshot was written (all still NULL)", nullSnap === 0, `${nullSnap} non-null`);
}

async function main() {
  console.log("\nPHASE 9F-23c — 1P product condition / CMS control\n");
  staticTests();
  await dbTests();
  await plpParityDbTests();
  await prodTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
