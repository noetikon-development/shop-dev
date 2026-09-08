/**
 * PHASE 9F-25A — G5: 1P Product/Offer status sync.
 *
 * `syncFirstPartyOfferStatusToProduct(productId, productStatus, tx?)` aligns
 * every Axiaro FIRST_PARTY `Offer.status` with the catalog `Product.status`
 * (ACTIVE→ACTIVE, DRAFT→DRAFT, ARCHIVED→ARCHIVED) across ALL of the product's
 * variants. `setProductStatus` + `updateProduct` call it (in a transaction with
 * the product write) whenever the product status changes.
 *
 * Preserves Offer.id / OfferInventory.id / quantity / price / condition /
 * relationships. Never touches a THIRD_PARTY offer. Never creates an offer.
 * Idempotent (`status: { not: target }`).
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back. Only one
 * FIRST_PARTY seller may exist (partial unique index) so fixtures reuse the real
 * Axiaro seller.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f25a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { syncFirstPartyOfferStatusToProduct } from "@/lib/admin/offer-sync";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const sync = read("src/lib/admin/offer-sync.ts");
  const actions = read("src/lib/admin/catalog-actions.ts");

  ok("offer-sync · exports syncFirstPartyOfferStatusToProduct(productId, productStatus, tx?)",
    /export async function syncFirstPartyOfferStatusToProduct\(\s*\n\s*productId: string,\s*\n\s*productStatus: string,\s*\n\s*tx: Tx = prisma,\s*\n\s*\): Promise<number>/.test(sync));
  ok("offer-sync · status map ACTIVE→ACTIVE, ARCHIVED→ARCHIVED, else DRAFT",
    /productStatus === "ACTIVE" \? "ACTIVE" : productStatus === "ARCHIVED" \? "ARCHIVED" : "DRAFT"/.test(sync));
  ok("offer-sync · scoped to FIRST_PARTY seller + the product's variants",
    /variant: \{ is: \{ productId \} \},\s*\n\s*seller: \{ is: \{ type: "FIRST_PARTY" \} \},/.test(sync));
  ok("offer-sync · idempotent — only rewrites offers not already at target",
    /status: \{ not: target \},/.test(sync));
  ok("offer-sync · uses updateMany (status only), never creates an offer",
    /await tx\.offer\.updateMany\(\{[\s\S]{0,220}data: \{ status: target \},/.test(sync) &&
    !/syncFirstPartyOfferStatusToProduct[\s\S]{0,500}\.create\(/.test(sync));
  ok("offer-sync · does not touch OfferInventory / price / condition in the sync",
    (() => {
      const m = sync.match(/export async function syncFirstPartyOfferStatusToProduct[\s\S]*?\n\}/);
      return !!m && !/offerInventory|price|condition|costPrice/i.test(m[0]);
    })());

  ok("catalog-actions · imports syncFirstPartyOfferStatusToProduct", /syncFirstPartyOfferStatusToProduct,/.test(actions));
  ok("catalog-actions · setProductStatus syncs inside a prisma.$transaction with the product write, guarded on a real change",
    /await prisma\.\$transaction\(async \(tx\) => \{\s*\n\s*await tx\.product\.update\(\{ where: \{ id \}, data: \{ status \} \}\);\s*\n\s*if \(product\.status !== status\) \{\s*\n\s*firstPartyOffersSynced = await syncFirstPartyOfferStatusToProduct\(id, status, tx\);/.test(actions));
  ok("catalog-actions · setProductStatus now selects the current status to guard",
    /prisma\.product\.findUnique\(\{ where: \{ id \}, select: \{ name: true, status: true \} \}\)/.test(actions));
  ok("catalog-actions · updateProduct runs the product write + status sync in one transaction",
    /export async function updateProduct[\s\S]*?await prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?await tx\.product\.update\(\{[\s\S]*?if \(existing\.status !== data\.status\) \{\s*\n\s*await syncFirstPartyOfferStatusToProduct\(id, data\.status, tx\);/.test(actions));
  ok("catalog-actions · updateProduct still price-syncs a single-variant product inside the same tx",
    /await syncFirstPartyOfferPrice\(\s*\n\s*existing\.variants\[0\]\.id,\s*\n\s*\{ price: data\.price, compareAtPrice: data\.compareAtPrice \?\? null \},\s*\n\s*tx,\s*\n\s*\);/.test(actions));

  // scope
  ok("scope · no schema change", !/9F-25A/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts not marked / touched", !/9F-25A/.test(read("scripts/seed-rbac.ts")));
  ok("scope · checkout / cart / buy-box / seller 3P repo untouched",
    !/9F-25A/.test(read("src/lib/checkout.ts")) && !/9F-25A/.test(read("src/lib/cart.ts")) &&
    !/9F-25A/.test(read("src/lib/marketplace/buy-box-rule.ts")) &&
    !/9F-25A/.test(read("src/lib/marketplace/seller-repository.ts")));
  ok("scope · ensureFirstPartyOffer create path unchanged (still status from productStatus at create)",
    /status: opts\.productStatus === "ACTIVE" \? "ACTIVE" : "DRAFT",/.test(sync));
}

// ── DB behaviour (rolled back) ───────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!category || !axiaro) return ok("(skipped — no category / 1P seller)", true);
  const sfx = "9f25a-" + Date.now();
  const rnd = () => Math.random().toString(36).slice(2, 7);

  async function seedProduct(
    tx: Prisma.TransactionClient,
    opts: { productStatus?: string; offerStatus?: string; variants?: number; qty?: number },
  ) {
    const product = await tx.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}-${rnd()}`, shortDescription: "s", description: "d", categoryId: category!.id, status: opts.productStatus ?? "DRAFT", price: 1000 },
      select: { id: true },
    });
    const rows: { variantId: string; offerId: string; offerInventoryId: string }[] = [];
    for (let i = 0; i < (opts.variants ?? 1); i++) {
      const variant = await tx.variant.create({
        data: { productId: product.id, sku: `v-${sfx}-${rnd()}`, price: 1000, status: "ACTIVE", stock: 0 },
        select: { id: true },
      });
      const offer = await tx.offer.create({
        data: { sellerId: axiaro!.id, variantId: variant.id, price: 1000, condition: "NEW", status: opts.offerStatus ?? "DRAFT", sellerSku: `os-${sfx}-${rnd()}` },
        select: { id: true },
      });
      const inv = await tx.offerInventory.create({
        data: { offerId: offer.id, sellerSku: null, quantity: opts.qty ?? 7, reserved: 0, reorderPoint: 3 },
        select: { id: true },
      });
      rows.push({ variantId: variant.id, offerId: offer.id, offerInventoryId: inv.id });
    }
    return { productId: product.id, rows };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1 — DRAFT product + DRAFT 1P offer → sync(DRAFT) = no-op
      {
        const f = await seedProduct(tx, { productStatus: "DRAFT", offerStatus: "DRAFT" });
        const n = await syncFirstPartyOfferStatusToProduct(f.productId, "DRAFT", tx);
        const o = await tx.offer.findUniqueOrThrow({ where: { id: f.rows[0].offerId }, select: { status: true } });
        ok("1 · DRAFT product / DRAFT 1P offer → sync(DRAFT) moves 0, offer stays DRAFT", n === 0 && o.status === "DRAFT");
      }
      // 2 — DRAFT → ACTIVE, identifiers + inventory + price preserved
      {
        const f = await seedProduct(tx, { productStatus: "DRAFT", offerStatus: "DRAFT", qty: 12 });
        const before = await tx.offer.findUniqueOrThrow({ where: { id: f.rows[0].offerId }, select: { id: true, price: true, condition: true, inventory: { select: { id: true, quantity: true, reserved: true } } } });
        const n = await syncFirstPartyOfferStatusToProduct(f.productId, "ACTIVE", tx);
        const after = await tx.offer.findUniqueOrThrow({ where: { id: f.rows[0].offerId }, select: { id: true, status: true, price: true, condition: true, inventory: { select: { id: true, quantity: true, reserved: true } } } });
        ok("2 · DRAFT → ACTIVE moves 1, offer ACTIVE",
          n === 1 && after.status === "ACTIVE");
        ok("2 · Offer.id + OfferInventory.id + quantity + reserved + price + condition all preserved",
          after.id === before.id &&
          after.inventory?.id === before.inventory?.id &&
          after.inventory?.quantity === 12 && after.inventory?.reserved === 0 &&
          after.price === before.price && after.condition === before.condition,
          JSON.stringify({ before, after }));
      }
      // 3 — ACTIVE → DRAFT
      {
        const f = await seedProduct(tx, { productStatus: "ACTIVE", offerStatus: "ACTIVE" });
        const n = await syncFirstPartyOfferStatusToProduct(f.productId, "DRAFT", tx);
        const o = await tx.offer.findUniqueOrThrow({ where: { id: f.rows[0].offerId }, select: { status: true } });
        ok("3 · ACTIVE → DRAFT moves 1, offer DRAFT", n === 1 && o.status === "DRAFT");
      }
      // 4 — ACTIVE → ARCHIVED
      {
        const f = await seedProduct(tx, { productStatus: "ACTIVE", offerStatus: "ACTIVE" });
        const n = await syncFirstPartyOfferStatusToProduct(f.productId, "ARCHIVED", tx);
        const o = await tx.offer.findUniqueOrThrow({ where: { id: f.rows[0].offerId }, select: { status: true } });
        ok("4 · ACTIVE → ARCHIVED moves 1, offer ARCHIVED", n === 1 && o.status === "ARCHIVED");
      }
      // 5 — multi-variant: every 1P offer follows
      {
        const f = await seedProduct(tx, { productStatus: "DRAFT", offerStatus: "DRAFT", variants: 3 });
        const n = await syncFirstPartyOfferStatusToProduct(f.productId, "ACTIVE", tx);
        const offers = await tx.offer.findMany({ where: { id: { in: f.rows.map((r) => r.offerId) } }, select: { status: true } });
        ok("5 · multi-variant DRAFT → ACTIVE moves all 3, every 1P offer ACTIVE",
          n === 3 && offers.length === 3 && offers.every((o) => o.status === "ACTIVE"));
      }
      // 6 — a THIRD_PARTY offer on the same variant is never touched
      {
        const f = await seedProduct(tx, { productStatus: "ACTIVE", offerStatus: "ACTIVE" });
        const seller3p = await tx.seller.create({
          data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `T3P ${sfx}`, slug: `t3p-${sfx}-${rnd()}`, supportEmail: "t@t.test" },
          select: { id: true },
        });
        const offer3p = await tx.offer.create({
          data: { sellerId: seller3p.id, variantId: f.rows[0].variantId, price: 900, condition: "NEW", status: "ACTIVE", sellerSku: `t3p-os-${sfx}-${rnd()}` },
          select: { id: true },
        });
        await tx.offerInventory.create({ data: { offerId: offer3p.id, sellerSku: null, quantity: 5, reserved: 0, reorderPoint: 3 } });
        const n = await syncFirstPartyOfferStatusToProduct(f.productId, "DRAFT", tx);
        const oneP = await tx.offer.findUniqueOrThrow({ where: { id: f.rows[0].offerId }, select: { status: true } });
        const threeP = await tx.offer.findUniqueOrThrow({ where: { id: offer3p.id }, select: { status: true } });
        ok("6 · sync moves only the 1P offer; the 3P offer on the same variant stays ACTIVE",
          n === 1 && oneP.status === "DRAFT" && threeP.status === "ACTIVE");
      }
      // 7 — no duplicate 1P offer created
      {
        const f = await seedProduct(tx, { productStatus: "DRAFT", offerStatus: "DRAFT", variants: 2 });
        const before = await tx.offer.count({ where: { variant: { productId: f.productId }, seller: { is: { type: "FIRST_PARTY" } } } });
        await syncFirstPartyOfferStatusToProduct(f.productId, "ACTIVE", tx);
        await syncFirstPartyOfferStatusToProduct(f.productId, "ARCHIVED", tx);
        const after = await tx.offer.count({ where: { variant: { productId: f.productId }, seller: { is: { type: "FIRST_PARTY" } } } });
        ok("7 · FIRST_PARTY offer count unchanged after two syncs (no duplicate created)", before === 2 && after === 2);
      }
      // 8 — idempotent
      {
        const f = await seedProduct(tx, { productStatus: "DRAFT", offerStatus: "DRAFT" });
        const first = await syncFirstPartyOfferStatusToProduct(f.productId, "ACTIVE", tx);
        const second = await syncFirstPartyOfferStatusToProduct(f.productId, "ACTIVE", tx);
        ok("8 · re-running the same sync is a zero-row no-op", first === 1 && second === 0);
      }
      // 9 — OfferInventory row untouched (id, quantity, reserved, reorderPoint)
      {
        const f = await seedProduct(tx, { productStatus: "ACTIVE", offerStatus: "ACTIVE", qty: 9 });
        const inv0 = await tx.offerInventory.findUniqueOrThrow({ where: { id: f.rows[0].offerInventoryId }, select: { quantity: true, reserved: true, reorderPoint: true, updatedAt: true } });
        await syncFirstPartyOfferStatusToProduct(f.productId, "ARCHIVED", tx);
        const inv1 = await tx.offerInventory.findUniqueOrThrow({ where: { id: f.rows[0].offerInventoryId }, select: { quantity: true, reserved: true, reorderPoint: true, updatedAt: true } });
        ok("9 · OfferInventory quantity / reserved / reorderPoint / updatedAt unchanged by a status sync",
          inv1.quantity === inv0.quantity && inv1.reserved === inv0.reserved &&
          inv1.reorderPoint === inv0.reorderPoint && inv1.updatedAt.getTime() === inv0.updatedAt.getTime());
      }
      // 10 — no OfferAdjustment written by a status sync
      {
        const f = await seedProduct(tx, { productStatus: "DRAFT", offerStatus: "DRAFT" });
        const adjBefore = await tx.offerAdjustment.count({ where: { offerInventory: { offerId: f.rows[0].offerId } } });
        await syncFirstPartyOfferStatusToProduct(f.productId, "ACTIVE", tx);
        const adjAfter = await tx.offerAdjustment.count({ where: { offerInventory: { offerId: f.rows[0].offerId } } });
        ok("10 · a status sync writes no OfferAdjustment", adjBefore === adjAfter);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no fixture product leaked", (await prisma.product.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture offer leaked", (await prisma.offer.count({ where: { sellerSku: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture 3P seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
}

// ── production read-only ─────────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const sa = await prisma.offer.findFirst({
    where: { seller: { is: { displayName: "Style Avenue" } } },
    select: { status: true, condition: true, price: true, seller: { select: { status: true } }, inventory: { select: { quantity: true } } },
  });
  ok("prod · Style Avenue 3P offer untouched — ACTIVE / NEW / ₱1199 / qty 21",
    sa?.status === "ACTIVE" && sa?.condition === "NEW" && sa?.price === 119900 && sa?.inventory?.quantity === 21,
    JSON.stringify(sa));
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("prod · marketplace.multiSellerCheckout still 'true'", g?.value === "true");
  const tpActive = await prisma.offer.count({ where: { seller: { is: { type: "THIRD_PARTY" } }, status: "ACTIVE" } });
  ok("prod · still exactly one ACTIVE THIRD_PARTY offer system-wide", tpActive === 1, String(tpActive));

  // Informational: the CURRENT 1P drift this fix resolves on the next status change.
  const activeProdDraftOffer = await prisma.offer.count({
    where: { seller: { is: { type: "FIRST_PARTY" } }, status: { not: "ACTIVE" }, variant: { product: { status: "ACTIVE" } } },
  });
  const draftProdActiveOffer = await prisma.offer.count({
    where: { seller: { is: { type: "FIRST_PARTY" } }, status: "ACTIVE", variant: { product: { status: { not: "ACTIVE" } } } },
  });
  console.log(`  INFO  existing 1P drift (not fixed by this phase — corrects on next product-status change): ${activeProdDraftOffer} non-ACTIVE 1P offers under ACTIVE products, ${draftProdActiveOffer} ACTIVE 1P offers under non-ACTIVE products`);

  ok("prod · no leaked 9f25a fixtures", (await prisma.product.count({ where: { slug: { contains: "9f25a" } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-25A — G5: 1P Product/Offer status sync\n");
  staticTests();
  await dbTests();
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
