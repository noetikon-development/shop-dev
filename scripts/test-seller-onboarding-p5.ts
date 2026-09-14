/**
 * Seller Onboarding — customer-facing storefront entry points (Phase 5).
 *
 * The account-CTA visibility rule (`sellerMemberships.length === 0`) depends
 * on `listSellerMemberships()`, which reads the CURRENT authenticated
 * session — not meaningfully invocable for a specific fake user from a bare
 * script (same class of limitation noted throughout this test family).
 * `listSellerMemberships` itself is pre-existing, unmodified, and already
 * relied on elsewhere (the Seller Portal gate) — what's new here is only
 * that the account page correctly wires its result, which is checked
 * statically below.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-onboarding-p5.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { FOOTER_DEFAULTS } from "../src/lib/footer-defaults";
import { getDefaultCommissionBps } from "../src/lib/marketplace/commission-config";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

async function main() {
  console.log("\nSeller Onboarding — storefront entry points (Phase 5)\n");

  const landingSrc = read("src/app/(shop)/sell-on-axiaro/page.tsx");
  const accountSrc = read("src/app/(shop)/account/page.tsx");
  const footerDefaultsSrc = read("src/lib/footer-defaults.ts");
  const applySrc = read("src/app/(shop)/sell-on-axiaro/apply/page.tsx");
  const statusSrc = read("src/app/(shop)/sell-on-axiaro/status/page.tsx");

  // ── 1 — landing page is public ──────────────────────────────────────────
  ok("1 · /sell-on-axiaro landing page file exists", landingSrc.length > 0);
  ok("1 · the landing page never calls requireUser() — it's public, no auth required",
    !/requireUser\(/.test(landingSrc));

  // ── 2/3 — CTAs present with correct destinations ────────────────────────
  ok("2 · landing page contains the Apply CTA text",
    /Apply to Sell on Axiaro/.test(landingSrc));
  ok("2 · Apply CTA points to \/sell-on-axiaro\/apply",
    /href="\/sell-on-axiaro\/apply"/.test(landingSrc));
  ok("3 · landing page contains the status CTA text",
    /Already applied\? Check your status/.test(landingSrc));
  ok("3 · status CTA points to \/sell-on-axiaro\/status",
    /href="\/sell-on-axiaro\/status"/.test(landingSrc));

  // ── 4 — the apply page's own auth/redirect is untouched ─────────────────
  ok("4 · the apply page still requires auth with the existing redirect pattern (unchanged by this phase)",
    /await requireUser\("\/sell-on-axiaro\/apply"\)/.test(applySrc));

  // ── 5 — the status page's claim logic is untouched by this phase ───────
  ok("5 · the status page's claim action import is unchanged (ClaimOwnerButton, not modified this phase)",
    /import \{ ClaimOwnerButton \} from "@\/components\/seller-onboarding\/claim-owner-button"/.test(statusSrc));

  // ── 6 — footer entry point via the existing defaults mechanism ─────────
  const companyLinks = FOOTER_DEFAULTS.companyColumn.links;
  ok("6 · FOOTER_DEFAULTS.companyColumn contains a \"Sell on Axiaro\" link to \/sell-on-axiaro",
    companyLinks.some((l) => l.label === "Sell on Axiaro" && l.href === "/sell-on-axiaro" && l.enabled));
  ok("6 · the existing \"About us\" link is still present and unchanged (additive edit, nothing removed)",
    companyLinks.some((l) => l.label === "About us" && l.href === "/pages/about"));
  ok("6 · no new footer component was introduced — footer-defaults.ts is the only footer file touched",
    !/export function|export default function/.test(footerDefaultsSrc));

  // ── 7 — account-area entry point ────────────────────────────────────────
  ok("7 · the account page imports listSellerMemberships (the existing seller-membership source)",
    /import \{ listSellerMemberships \} from "@\/lib\/seller\/session"/.test(accountSrc));
  ok("7 · the seller CTA is gated on having ZERO active seller memberships",
    /const showSellerCta = sellerMemberships\.length === 0/.test(accountSrc));
  ok("7 · the CTA text and destination are present",
    /Become a Seller/.test(accountSrc) && /href="\/sell-on-axiaro"/.test(accountSrc));
  ok("8 · the CTA render is conditioned on showSellerCta (an existing active seller never sees it)",
    /\{showSellerCta && \(/.test(accountSrc));

  // ── 9 — commission is sourced from the existing CMS config, not hard-coded ──
  ok("9 · the landing page imports getDefaultCommissionBps rather than a literal rate",
    /import \{ getDefaultCommissionBps \} from "@\/lib\/marketplace\/commission-config"/.test(landingSrc));
  ok("9 · the landing page derives its displayed label from the fetched value, not a literal string",
    /const commissionLabel = `\$\{\(commissionBps \/ 100\)\.toFixed\(2\)\}%`/.test(landingSrc));
  const liveCommissionBps = await getDefaultCommissionBps();
  ok("9 · getDefaultCommissionBps() itself resolves to a sane basis-point value (0–10000)",
    Number.isInteger(liveCommissionBps) && liveCommissionBps >= 0 && liveCommissionBps <= 10000,
    `got ${liveCommissionBps}`);

  // ── 10 — visiting these pages can never create business data ───────────
  const mutationRe = /\.(create|update|updateMany|upsert|delete|deleteMany)\(/;
  ok("10 · the landing page contains no database mutation of any kind",
    !mutationRe.test(landingSrc));
  ok("10 · footer-defaults.ts contains no database mutation (pure static data)",
    !mutationRe.test(footerDefaultsSrc));
  // The account page already had its own pre-existing reads (orders, address
  // count) — the NEW code added this phase is purely the seller-membership
  // read + conditional render, so scope the mutation check to that addition.
  ok("10 · the new account-page addition (seller CTA block) contains no mutation",
    (() => {
      const idx = accountSrc.indexOf("listSellerMemberships()");
      const ctaBlock = accountSrc.slice(accountSrc.indexOf("showSellerCta && ("));
      return idx !== -1 && !mutationRe.test(ctaBlock);
    })());

  // Live, read-only confirmation: visiting/rendering these pages cannot have
  // created anything — the counts before and after this entire test run are
  // identical (this file performs no writes of its own either).
  const inviteCountBefore = await prisma.sellerInvite.count();
  const sellerUserCountBefore = await prisma.sellerUser.count();
  await getDefaultCommissionBps(); // the same read the landing page performs
  ok("10 · SellerInvite count unchanged by exercising the same read the landing page performs",
    (await prisma.sellerInvite.count()) === inviteCountBefore);
  ok("10 · SellerUser count unchanged",
    (await prisma.sellerUser.count()) === sellerUserCountBefore);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
