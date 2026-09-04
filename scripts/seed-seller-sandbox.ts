/**
 * Phase 9F-1 — DEV SANDBOX seller for exercising the `/seller` portal.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │  WRITES TO THE SHARED DATABASE (dev and prod point at the same         │
 * │  Supabase project). This is a CONTROLLED sandbox, not a real seller:   │
 * │    - THIRD_PARTY, APPROVED, slug "sandbox-seller"                       │
 * │    - one OWNER SellerUser linked to an EXISTING account (default        │
 * │      demo@axiaro.test — a kept test account with Supabase auth)         │
 * │    - NO offers are created here. Any offer you make in the portal is    │
 * │      DRAFT and can never reach ACTIVE while                             │
 * │      marketplace.multiSellerCheckout is false, so it is never           │
 * │      customer-visible.                                                  │
 * │  It does NOT create Supabase auth users, touch RBAC, or change the      │
 * │  gate. `--revert` removes it (only when it owns no offers / orders).    │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 *   node --env-file=.env --import tsx scripts/seed-seller-sandbox.ts [--email=<account>] [--revert] [--dry-run]
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const SLUG = "sandbox-seller";
const DISPLAY_NAME = "Sandbox Seller (dev)";
const SUPPORT_EMAIL = "sandbox-seller@axiaro.test";
const COMMISSION_BPS = 1500;
const DEFAULT_LINK_EMAIL = "demo@axiaro.test";

type Opts = { email: string; revert: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Opts {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  return {
    email: (get("email") ?? DEFAULT_LINK_EMAIL).trim().toLowerCase(),
    revert: argv.includes("--revert"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function seedSellerSandbox(prisma: PrismaClient, opts: Opts) {
  const log = (m: string) => console.log(`  ${m}`);
  console.log(`PHASE 9F-1 — dev sandbox seller${opts.dryRun ? " (dry run)" : ""}`);

  if (opts.revert) {
    const seller = await prisma.seller.findUnique({
      where: { slug: SLUG },
      select: { id: true, _count: { select: { offers: true, sellerOrders: true } } },
    });
    if (!seller) return log("nothing to revert — sandbox seller absent");
    if (seller._count.offers > 0 || seller._count.sellerOrders > 0) {
      throw new Error(
        `refusing to revert — sandbox seller still owns ${seller._count.offers} offer(s) / ${seller._count.sellerOrders} order(s). Archive + delete those first.`,
      );
    }
    if (opts.dryRun) return log(`would delete Seller ${seller.id} + its SellerUser rows`);
    await prisma.sellerUser.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.delete({ where: { id: seller.id } });
    return log(`reverted — sandbox seller ${seller.id} removed`);
  }

  const user = await prisma.user.findUnique({
    where: { email: opts.email },
    select: { id: true, email: true, supabaseUserId: true },
  });
  if (!user) {
    throw new Error(
      `no application User with email "${opts.email}". Pass --email=<an existing account>. This script never creates auth users.`,
    );
  }
  if (!user.supabaseUserId) {
    log(`[warn] "${opts.email}" has no linked Supabase auth user — you won't be able to sign in to /seller as them until they do.`);
  }

  const existing = await prisma.seller.findUnique({ where: { slug: SLUG }, select: { id: true, status: true, type: true } });

  if (opts.dryRun) {
    log(existing ? `sandbox Seller present (${existing.id})` : "would create sandbox Seller");
    log(`would ensure OWNER SellerUser for ${user.email} (${user.id})`);
    return;
  }

  const seller = existing
    ? await prisma.seller.update({
        where: { slug: SLUG },
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: DISPLAY_NAME, supportEmail: SUPPORT_EMAIL },
        select: { id: true },
      })
    : await prisma.seller.create({
        data: {
          type: "THIRD_PARTY",
          status: "APPROVED",
          displayName: DISPLAY_NAME,
          slug: SLUG,
          supportEmail: SUPPORT_EMAIL,
          commissionRate: COMMISSION_BPS,
        },
        select: { id: true },
      });
  log(`Seller ${seller.id} (${existing ? "updated" : "created"})`);

  const membership = await prisma.sellerUser.upsert({
    where: { sellerId_userId: { sellerId: seller.id, userId: user.id } },
    update: { role: "OWNER", status: "ACTIVE" },
    create: { sellerId: seller.id, userId: user.id, role: "OWNER", status: "ACTIVE" },
    select: { id: true },
  });
  log(`SellerUser ${membership.id} — OWNER / ACTIVE for ${user.email}`);

  console.log(`\n  done. Sign in at /seller/login as ${user.email}.`);
  console.log(`  Offers you create are DRAFT and never customer-visible (gate is off).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });
  seedSellerSandbox(prisma, opts)
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
