/**
 * Phase 9C — Axiaro FIRST_PARTY seller + Offer + OfferInventory backfill.
 *
 * ADDITIVE and REVERSIBLE. Creates, for the existing single-seller catalogue:
 *   1. exactly one Seller  { type: FIRST_PARTY, status: APPROVED, slug: "axiaro" }
 *   2. one Offer per QUALIFYING Variant  (status ACTIVE, product status ACTIVE|DRAFT)
 *        Offer.price          <- Variant.price          (COPY — catalogue stays authoritative)
 *        Offer.compareAtPrice <- Variant.compareAtPrice
 *        Offer.costPrice      <- Product.costPrice
 *        Offer.sellerSku      <- Variant.sku
 *        Offer.condition      =  NEW
 *        Offer.fulfillmentType=  SELLER_FULFILLED
 *        Offer.handlingTimeDays= 2
 *        Offer.status         =  ACTIVE (product ACTIVE) | DRAFT (product DRAFT)
 *   3. one OfferInventory per Offer, copied from the Variant's Inventory row
 *        quantity / reserved / reorderPoint / restockEta / sellerSku
 *   4. one OfferAdjustment { reason: "MIGRATION_OPENING" } per OfferInventory
 *
 * It NEVER updates or deletes any existing Product / Variant / Inventory /
 * InventoryAdjustment / Order row, and NEVER calls src/lib/inventory.ts. This is
 * a pure data-copy — there is no dual-write and OfferInventory is not kept in
 * sync with Inventory afterwards.
 *
 * Idempotent + re-runnable: each qualifying Variant is processed in its own
 * transaction; an already-created Offer / OfferInventory is left untouched and
 * counted as "skipped".
 *
 * Run:      npm run db:backfill:marketplace
 * Revert:   npm run db:backfill:marketplace -- --revert
 * Preview:  npm run db:backfill:marketplace -- --dry-run
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const AXIARO_SLUG = "axiaro";
const FALLBACK_SUPPORT_EMAIL = "support@axiaro.shop";
const FALLBACK_DISPLAY_NAME = "Axiaro";

type Opts = { dryRun?: boolean; revert?: boolean; log?: (m: string) => void };

export async function backfillMarketplaceFoundation(prisma: PrismaClient, opts: Opts = {}) {
  const log = opts.log ?? (() => {});

  if (opts.revert) return revert(prisma, log);

  // --- 1. Axiaro FIRST_PARTY seller ---------------------------------------
  const contactRow = await prisma.storeSetting.findUnique({
    where: { key: "contact.email" },
    select: { value: true },
  });
  const brandRow = await prisma.storeSetting.findUnique({
    where: { key: "store.brand" },
    select: { value: true },
  });
  const supportEmail = (contactRow?.value ?? "").trim() || FALLBACK_SUPPORT_EMAIL;
  const displayName = (brandRow?.value ?? "").trim() || FALLBACK_DISPLAY_NAME;

  const existingFp = await prisma.seller.findFirst({
    where: { OR: [{ type: "FIRST_PARTY" }, { slug: AXIARO_SLUG }] },
  });

  let sellerId: string;
  if (existingFp) {
    if (existingFp.type !== "FIRST_PARTY" || existingFp.slug !== AXIARO_SLUG) {
      throw new Error(
        `A Seller row already exists that is not the expected Axiaro FIRST_PARTY/axiaro record (id=${existingFp.id}, type=${existingFp.type}, slug=${existingFp.slug}). Aborting.`,
      );
    }
    sellerId = existingFp.id;
    log(`seller: reusing existing Axiaro FIRST_PARTY (${sellerId})`);
  } else if (opts.dryRun) {
    sellerId = "<dry-run>";
    log(`seller: WOULD create Axiaro FIRST_PARTY { slug: ${AXIARO_SLUG}, supportEmail: ${supportEmail} }`);
  } else {
    const created = await prisma.seller.create({
      data: {
        type: "FIRST_PARTY",
        status: "APPROVED",
        displayName,
        slug: AXIARO_SLUG,
        supportEmail,
        commissionRate: 0,
      },
    });
    sellerId = created.id;
    log(`seller: created Axiaro FIRST_PARTY (${sellerId})`);
  }

  // --- 2-4. one Offer + OfferInventory + opening OfferAdjustment per Variant
  const variants = await prisma.variant.findMany({
    where: { status: "ACTIVE", product: { status: { in: ["ACTIVE", "DRAFT"] } } },
    select: {
      id: true,
      sku: true,
      price: true,
      compareAtPrice: true,
      product: { select: { status: true, costPrice: true } },
      inventory: {
        select: { quantity: true, reserved: true, reorderPoint: true, restockEta: true, sku: true },
      },
    },
    orderBy: { id: "asc" },
  });

  log(`variants: ${variants.length} qualifying (ACTIVE variant, product ACTIVE|DRAFT)`);

  let offersCreated = 0;
  let offersSkipped = 0;
  let inventoryCreated = 0;
  let inventorySkipped = 0;
  let adjustmentsCreated = 0;

  for (const v of variants) {
    if (!v.inventory) {
      throw new Error(`Variant ${v.id} (${v.sku}) has no Inventory row — cannot copy stock. Aborting.`);
    }

    const offerStatus = v.product.status === "ACTIVE" ? "ACTIVE" : "DRAFT";

    if (opts.dryRun) {
      const exists =
        sellerId !== "<dry-run>" &&
        (await prisma.offer.findUnique({
          where: { sellerId_variantId_condition: { sellerId, variantId: v.id, condition: "NEW" } },
          select: { id: true },
        }));
      if (exists) offersSkipped++;
      else offersCreated++;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      let offer = await tx.offer.findUnique({
        where: { sellerId_variantId_condition: { sellerId, variantId: v.id, condition: "NEW" } },
        include: { inventory: { select: { id: true } } },
      });

      if (!offer) {
        offer = await tx.offer.create({
          data: {
            sellerId,
            variantId: v.id,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            costPrice: v.product.costPrice,
            sellerSku: v.sku,
            condition: "NEW",
            status: offerStatus,
            fulfillmentType: "SELLER_FULFILLED",
            handlingTimeDays: 2,
          },
          include: { inventory: { select: { id: true } } },
        });
        offersCreated++;
      } else {
        offersSkipped++;
      }

      if (!offer.inventory) {
        const inv = await tx.offerInventory.create({
          data: {
            offerId: offer.id,
            sellerSku: v.inventory!.sku,
            quantity: v.inventory!.quantity,
            reserved: v.inventory!.reserved,
            reorderPoint: v.inventory!.reorderPoint,
            restockEta: v.inventory!.restockEta,
          },
        });
        inventoryCreated++;

        await tx.offerAdjustment.create({
          data: {
            offerInventoryId: inv.id,
            previousQuantity: 0,
            delta: inv.quantity,
            newQuantity: inv.quantity,
            reason: "MIGRATION_OPENING",
            note: "Phase 9C opening balance — copied from Inventory at migration boundary.",
            actorUserId: null,
          },
        });
        adjustmentsCreated++;
      } else {
        inventorySkipped++;
      }
    });
  }

  log(
    `offers:        created ${offersCreated}, skipped ${offersSkipped} (total ${offersCreated + offersSkipped})`,
  );
  log(
    `offerInventory: created ${inventoryCreated}, skipped ${inventorySkipped} (total ${inventoryCreated + inventorySkipped})`,
  );
  log(`offerAdjustment (MIGRATION_OPENING): created ${adjustmentsCreated}`);

  return {
    sellerId,
    qualifyingVariants: variants.length,
    offersCreated,
    offersSkipped,
    inventoryCreated,
    inventorySkipped,
    adjustmentsCreated,
    dryRun: Boolean(opts.dryRun),
  };
}

async function revert(prisma: PrismaClient, log: (m: string) => void) {
  const seller = await prisma.seller.findFirst({
    where: { OR: [{ type: "FIRST_PARTY" }, { slug: AXIARO_SLUG }] },
    select: { id: true },
  });
  if (!seller) {
    log("revert: no Axiaro seller found — nothing to do.");
    return { reverted: false };
  }
  // Offer → OfferInventory → OfferAdjustment all cascade on delete.
  const offers = await prisma.offer.findMany({ where: { sellerId: seller.id }, select: { id: true } });
  const del = await prisma.offer.deleteMany({ where: { sellerId: seller.id } });
  const users = await prisma.sellerUser.count({ where: { sellerId: seller.id } });
  if (users === 0) {
    await prisma.seller.delete({ where: { id: seller.id } });
    log(`revert: deleted ${del.count} offers (of ${offers.length}) + the Axiaro Seller row.`);
  } else {
    log(`revert: deleted ${del.count} offers; kept Seller (${users} SellerUser rows attached).`);
  }
  return { reverted: true, offersDeleted: del.count, sellerDeleted: users === 0 };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  backfillMarketplaceFoundation(prisma, {
    dryRun: process.argv.includes("--dry-run"),
    revert: process.argv.includes("--revert"),
    log: (m) => console.log(m),
  })
    .then((r) => console.log("Backfill result:", JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
