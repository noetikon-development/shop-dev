/**
 * Phase 9F-4b — Admin Seller Management — assertion runner.
 *
 * DB tests build Sellers / SellerUsers / a DRAFT Offer inside ONE
 * prisma.$transaction and roll back. The repository + seller-user functions take
 * an optional transaction client; audit is written by the action layer, so
 * audit coverage (spec 19) is a STATIC check (same split as test-9f3).
 * Run with --conditions=react-server.
 *
 * Coverage (spec VALIDATION 1-34; 29-34 run as separate npm scripts):
 *   1-3  list / detail / statuses
 *   4    creation defaults (THIRD_PARTY / PENDING / DRAFT / commission)
 *   5    slug uniqueness + format + reserved
 *   6    invalid lifecycle transition rejected
 *   7-10 the four valid transitions
 *   11   seller cannot perform admin lifecycle actions (no seller-plane path)
 *   12-14 seller cannot change type / commission / slug
 *   15-17 SellerUser management is seller-scoped; cross-seller fails; roles unchanged
 *   18   content moderation stays 9F-4a-compatible
 *   19   audit records created (static — actions call writeAudit)
 *   20-25 no Product/Variant/Offer/OfferInventory/Inventory/InventoryAdjustment/StoreSetting writes
 *   26   multiSellerCheckout false
 *   27   PayMongo dormant
 *   28   storefront unchanged (no admin/sellers import)
 *   +    9F-1 gate: approving a seller never makes an offer buy-box eligible
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f4b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  listAdminSellers,
  getAdminSeller,
  transitionSellerStatus,
  updateSellerConfig,
  createSeller,
} from "../src/lib/admin/sellers/repository";
import {
  addSellerUserByEmail,
  setSellerUserRole,
  setSellerUserStatus,
} from "../src/lib/admin/sellers/seller-users";
import {
  canTransitionSeller,
  validateSellerSlug,
  validateCommissionBps,
  SELLER_TRANSITIONS,
} from "../src/lib/admin/sellers/lifecycle";
import { isEligibleCandidate } from "../src/lib/marketplace/buy-box-rule";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}   ${detail}`);
  }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function seedSeller(tx: Tx, slug: string, over: Record<string, unknown> = {}) {
  return tx.seller.create({
    data: {
      type: "THIRD_PARTY",
      status: "APPROVED",
      displayName: slug,
      slug,
      supportEmail: `${slug}@t.test`,
      contentStatus: "DRAFT",
      commissionRate: 1500,
      ...over,
    },
    select: { id: true, type: true, status: true, slug: true, commissionRate: true, contentStatus: true },
  });
}

async function seedUser(tx: Tx, email: string) {
  return tx.user.create({
    data: { email, supabaseUserId: `sb-${Math.random().toString(36).slice(2)}`, role: "CUSTOMER" },
    select: { id: true, email: true },
  });
}

async function dbTests() {
  const counts0 = await snapshotCounts();

  try {
    await prisma.$transaction(
      async (tx) => {
        const t = String(Date.now()).slice(-7);
        const A = await seedSeller(tx, `a94b-${t}`, { status: "PENDING" });
        const B = await seedSeller(tx, `b94b-${t}`, { status: "APPROVED" });

        // 1 / 3
        const list = await listAdminSellers({}, tx);
        const seenA = list.find((r) => r.id === A.id);
        const seenB = list.find((r) => r.id === B.id);
        ok("1 · listAdminSellers returns seeded sellers", Boolean(seenA && seenB));
        ok("3 · list carries the true status", seenA?.status === "PENDING" && seenB?.status === "APPROVED");
        ok("3 · list carries member + offer counts", typeof seenA?.sellerUserCount === "number" && typeof seenA?.offerCount === "number");

        // 2 / 18
        const detail = await getAdminSeller(A.id, tx);
        ok("2 · getAdminSeller returns detail", detail?.id === A.id && detail?.type === "THIRD_PARTY");
        ok("2 · detail exposes allowedTransitions from the state machine", JSON.stringify(detail?.allowedTransitions) === JSON.stringify(["APPROVED"]));
        ok("18 · detail reads contentStatus from the 9F-4a columns (no 2nd machine)", detail?.content.status === "DRAFT");

        // 6
        for (const [from, to] of [["PENDING", "SUSPENDED"], ["PENDING", "CLOSED"], ["APPROVED", "PENDING"], ["CLOSED", "APPROVED"]] as const) {
          ok(`6 · canTransitionSeller rejects ${from} → ${to}`, canTransitionSeller(from, to) === false);
        }
        const badLive = await transitionSellerStatus(A.id, "SUSPENDED", tx);
        ok("6 · transitionSellerStatus rejects PENDING → SUSPENDED", badLive.ok === false && badLive.code === "INVALID_TRANSITION");

        // 7-10
        const approve = await transitionSellerStatus(A.id, "APPROVED", tx);
        ok("7 · PENDING → APPROVED", approve.ok === true && (await tx.seller.findUnique({ where: { id: A.id }, select: { status: true } }))?.status === "APPROVED");
        ok("8 · APPROVED → SUSPENDED", (await transitionSellerStatus(A.id, "SUSPENDED", tx)).ok === true);
        const react = await transitionSellerStatus(A.id, "APPROVED", tx);
        ok("9 · SUSPENDED → APPROVED (reactivate)", react.ok === true && react.ok && react.reactivate === true);
        ok("10 · APPROVED → CLOSED", (await transitionSellerStatus(A.id, "CLOSED", tx)).ok === true);
        ok("10 · CLOSED is terminal", (await transitionSellerStatus(A.id, "APPROVED", tx)).ok === false);
        const S = await seedSeller(tx, `s94b-${t}`, { status: "SUSPENDED" });
        ok("10 · SUSPENDED → CLOSED", (await transitionSellerStatus(S.id, "CLOSED", tx)).ok === true);

        // 4
        const made = await createSeller({ displayName: "Acme Co", slug: `acme-${t}`, supportEmail: "acme@t.test" }, tx);
        ok("4 · createSeller succeeds", made.ok === true);
        if (made.ok) {
          const row = await tx.seller.findUnique({ where: { id: made.sellerId } });
          ok("4 · new seller is THIRD_PARTY / PENDING / DRAFT / 1500 bps", row?.type === "THIRD_PARTY" && row?.status === "PENDING" && row?.contentStatus === "DRAFT" && row?.commissionRate === 1500);
        }

        // 5 / 13 / 14
        ok("5 · validateSellerSlug rejects bad format", validateSellerSlug("Bad Slug!").ok === false);
        ok("5 · validateSellerSlug rejects reserved", validateSellerSlug("admin").ok === false && validateSellerSlug("store").ok === false);
        ok("5 · validateSellerSlug accepts a clean slug", validateSellerSlug("acme-supplies").ok === true);
        const dupeSlug = await createSeller({ displayName: "Dupe", slug: B.slug, supportEmail: "d@t.test" }, tx);
        ok("5 · createSeller rejects a taken slug", dupeSlug.ok === false && dupeSlug.code === "CONFLICT");
        ok("13 · validateCommissionBps range", validateCommissionBps(-1).ok === false && validateCommissionBps(10001).ok === false && validateCommissionBps(1500).ok === true);
        ok("14 · updateSellerConfig rejects a reserved slug", (await updateSellerConfig(B.id, { slug: "api" }, tx)).ok === false);
        const dupeSlugUpdate = await updateSellerConfig(B.id, { slug: A.slug }, tx);
        ok("14 · updateSellerConfig rejects a taken slug", dupeSlugUpdate.ok === false && dupeSlugUpdate.code === "CONFLICT");
        const commissionUpdate = await updateSellerConfig(B.id, { commissionRate: 2000 }, tx);
        ok("13 · admin can set commission", commissionUpdate.ok === true && (await tx.seller.findUnique({ where: { id: B.id }, select: { commissionRate: true } }))?.commissionRate === 2000);

        // 12
        const typeBefore = (await tx.seller.findUnique({ where: { id: B.id }, select: { type: true } }))?.type;
        await updateSellerConfig(B.id, { displayName: "Renamed" }, tx);
        const typeAfter = (await tx.seller.findUnique({ where: { id: B.id }, select: { type: true } }))?.type;
        ok("12 · seller type never changes through config updates", typeBefore === typeAfter && typeAfter === "THIRD_PARTY");

        // 15-17
        const u1 = await seedUser(tx, `u1-${t}@t.test`);
        const u2 = await seedUser(tx, `u2-${t}@t.test`);
        ok("15 · addSellerUserByEmail links an existing account", (await addSellerUserByEmail(B.id, u1.email, "OWNER", tx)).ok === true);
        const noAccount = await addSellerUserByEmail(B.id, "ghost@nowhere.test", "STAFF", tx);
        ok("15 · addSellerUserByEmail refuses an unknown email", noAccount.ok === false && noAccount.code === "NO_ACCOUNT");
        await addSellerUserByEmail(B.id, u2.email, "STAFF", tx);
        const aUsers = await tx.sellerUser.findMany({ where: { sellerId: A.id }, select: { id: true } });
        const bUsers = await tx.sellerUser.findMany({ where: { sellerId: B.id }, select: { id: true, role: true } });
        ok("16 · adding to B never touches A", aUsers.length === 0 && bUsers.length === 2);
        const bStaff = bUsers.find((x) => x.role === "STAFF")!;
        const bOwner = bUsers.find((x) => x.role === "OWNER")!;
        ok("16 · setSellerUserRole(A, B's member) → NOT_FOUND", (await setSellerUserRole(A.id, bStaff.id, "OWNER", tx)).ok === false);
        ok("16 · setSellerUserStatus(A, B's member) → NOT_FOUND", (await setSellerUserStatus(A.id, bStaff.id, "DISABLED", tx)).ok === false);
        ok("17 · setSellerUserRole STAFF → MANAGER (scoped)", (await setSellerUserRole(B.id, bStaff.id, "MANAGER", tx)).ok === true);
        const lastOwner = await setSellerUserRole(B.id, bOwner.id, "STAFF", tx);
        ok("17 · cannot demote the last active owner", lastOwner.ok === false && lastOwner.code === "LAST_OWNER");
        const disableOwner = await setSellerUserStatus(B.id, bOwner.id, "DISABLED", tx);
        ok("17 · cannot disable the last active owner", disableOwner.ok === false && disableOwner.code === "LAST_OWNER");

        // 9F-1 GATE
        const G = await seedSeller(tx, `g94b-${t}`, { status: "PENDING" });
        const variant = await tx.variant.findFirst({ where: { status: "ACTIVE" }, select: { id: true } });
        if (variant) {
          const offer = await tx.offer.create({ data: { sellerId: G.id, variantId: variant.id, price: 9999, condition: "NEW", status: "DRAFT", sellerSku: `g-${t}` }, select: { id: true } });
          await tx.offerInventory.create({ data: { offerId: offer.id, quantity: 5, reserved: 0, reorderPoint: 1 } });
          await transitionSellerStatus(G.id, "APPROVED", tx);
          ok("gate · offer stays DRAFT after seller APPROVED", (await tx.offer.findUnique({ where: { id: offer.id }, select: { status: true } }))?.status === "DRAFT");
          ok(
            "gate · a DRAFT offer under an APPROVED seller is NOT buy-box eligible",
            isEligibleCandidate({ offerId: offer.id, sellerId: G.id, sellerType: "THIRD_PARTY", sellerStatus: "APPROVED", offerStatus: "DRAFT", available: 5, price: 9999, createdAt: new Date() }) === false,
          );
        }

        throw new Rollback();
      },
      { timeout: 25_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const counts1 = await snapshotCounts();
  ok(
    "20-25 · Product/Variant/Offer/OfferInventory/OfferAdjustment/Inventory/InventoryAdjustment/StoreSetting/SellerUser counts unchanged",
    JSON.stringify(counts0) === JSON.stringify(counts1),
    `${JSON.stringify(counts0)} vs ${JSON.stringify(counts1)}`,
  );

  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("26 · marketplace.multiSellerCheckout false/unset", (gate?.value ?? "false") !== "true");
  ok("27 · payments empty", (await prisma.payment.count()) === 0);
  ok("27 · webhookEvents empty", (await prisma.webhookEvent.count()) === 0);
}

async function snapshotCounts() {
  return {
    product: await prisma.product.count(),
    variant: await prisma.variant.count(),
    offer: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    offerAdjustment: await prisma.offerAdjustment.count(),
    inventory: await prisma.inventory.count(),
    inventoryAdjustment: await prisma.inventoryAdjustment.count(),
    storeSetting: await prisma.storeSetting.count(),
    sellerUser: await prisma.sellerUser.count(),
    seller: await prisma.seller.count(),
  };
}

function staticTests() {
  const repo = read("src/lib/admin/sellers/repository.ts");
  const su = read("src/lib/admin/sellers/seller-users.ts");
  const actions = read("src/lib/admin/sellers/actions.ts");
  const lifecycle = read("src/lib/admin/sellers/lifecycle.ts");
  const nav = read("src/lib/admin/navigation.ts");
  const catalog = read("src/lib/rbac/catalog.ts");
  const seedRbac = read("scripts/seed-rbac.ts");

  // 10 — no invented statuses
  ok("10 · exactly the four spec statuses", Object.keys(SELLER_TRANSITIONS).sort().join(",") === "APPROVED,CLOSED,PENDING,SUSPENDED");
  ok(
    "10 · transition map matches the spec exactly",
    JSON.stringify(SELLER_TRANSITIONS) === JSON.stringify({ PENDING: ["APPROVED"], APPROVED: ["SUSPENDED", "CLOSED"], SUSPENDED: ["APPROVED", "CLOSED"], CLOSED: [] }),
  );

  // 11 — no seller-plane path imports the admin seller area
  for (const f of ["src/lib/seller/session.ts", "src/lib/seller/settings-actions.ts", "src/lib/seller/offer-actions.ts", "src/lib/seller/return-actions.ts", "src/lib/marketplace/seller-repository.ts", "src/lib/marketplace/seller-profile-repository.ts"]) {
    ok(`11 · ${f} does not import admin/sellers`, !/admin\/sellers/.test(read(f)));
  }

  // 12 — type is only ever the THIRD_PARTY literal in createSeller
  ok("12 · repository assigns Seller.type exactly once (THIRD_PARTY in createSeller)", (repo.match(/type:\s*"THIRD_PARTY"/g) ?? []).length === 1);
  ok("12 · updateSellerConfig has no type path", !/data\.type\s*=/.test(repo));

  // 10-permission
  ok("10auth · every seller-admin action requires manage_settings", (actions.match(/requirePermission\("manage_settings"\)/g) ?? []).length >= 6);
  ok("10auth · no new permission string introduced", !/manage_sellers|"view_sellers"|seller_admin|manage_seller_lifecycle/.test(actions + repo + su + catalog));
  ok("10auth · rbac catalog has no seller permission", !/manage_sellers|"view_sellers"/.test(catalog));
  ok("10auth · seed-rbac.ts not referenced / touched by 9F-4b", !/admin\/sellers/.test(seedRbac));

  // 19 — every mutation action writes an audit row
  for (const a of ["seller.created", "seller.updated", "seller.reactivated", "seller_user.added", "seller_user.role_changed", "seller_user.disabled"]) {
    ok(`19 · actions reference audit action "${a}"`, actions.includes(`"${a}"`));
  }
  ok("19 · lifecycle helper supplies suspend/close audit actions", /"seller\.suspended"/.test(lifecycle) && /"seller\.closed"/.test(lifecycle));
  ok("19 · actions import + call writeAudit for every mutation", /import \{ writeAudit \}/.test(actions) && (actions.match(/await writeAudit\(/g) ?? []).length >= 6);

  // 20-25 — no forbidden writes
  for (const [label, src] of [["repository", repo], ["seller-users", su], ["actions", actions]] as const) {
    ok(`20-25 · ${label} never imports @/lib/inventory`, !/@\/lib\/inventory/.test(src));
    ok(`20-25 · ${label} never writes Offer/OfferInventory/Inventory/Product/Variant/StoreSetting`, !/\b(offer|offerInventory|offerAdjustment|inventory|inventoryAdjustment|product|variant|storeSetting)\.(update|create|delete|upsert|updateMany)/i.test(src));
  }

  // 28 — storefront never imports the admin seller area
  for (const f of ["src/lib/data.ts", "src/lib/cart.ts", "src/lib/checkout.ts", "src/lib/marketplace/offer-resolver.ts"]) {
    ok(`28 · ${f} does not import admin/sellers`, !/admin\/sellers/.test(read(f)));
  }

  ok(
    "nav · /admin/sellers route accepts manage_settings + manage_content",
    /path: "\/admin\/sellers",[\s\S]{0,300}accepts: \["manage_settings", "manage_content"\]/.test(nav),
  );
  ok("nav · /admin/sellers/new route accepts manage_settings", /path: "\/admin\/sellers\/new",[\s\S]{0,300}accepts: \["manage_settings"\]/.test(nav));

  // 18 — 9F-4a content moderation unchanged
  const contentActions = read("src/lib/admin/seller-content-actions.ts");
  ok("18 · seller-content-actions still requires manage_content (9F-4a unchanged)", /requirePermission\("manage_content"\)/.test(contentActions));
  ok("18 · 9F-4b never moves contentStatus to PENDING/APPROVED", !/contentStatus["\s:=]+["'](PENDING|APPROVED)/.test(actions + repo));
  ok("18 · 9F-4b only ever creates contentStatus DRAFT", (repo.match(/contentStatus:\s*"DRAFT"/g) ?? []).length === 1 && !/actions[\s\S]*contentStatus:/.test("actions:" + actions));
}

async function main() {
  console.log("\nPHASE 9F-4b — Admin Seller Management\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (rolled back)");
  await dbTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
