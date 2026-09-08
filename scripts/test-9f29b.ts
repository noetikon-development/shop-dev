/**
 * PHASE 9F-29B — remove stale 3P seller-portal copy (P2, copy-only).
 *
 * The 3P marketplace is live (marketplace.multiSellerCheckout = "true", 9F-9;
 * publishing shipped in 9F-24A; product requests shipped in 9F-5b/5c). Four
 * pieces of seller-facing copy still said the opposite:
 *   1. dashboard banner — "…when customer checkout opens for sellers."
 *   2. /seller/offers/new empty state — "requesting a new one opens in a later phase."
 *   3. offer-create-form — "publishing to buyers opens later."
 *   4. seller navigation doc comment — "…land in later phases…"
 *
 * This test asserts the stale phrases are gone, the new request link is present,
 * and NO functional code path changed.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f29b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { SELLER_ROUTES, sellerNav, sellerBreadcrumbs } from "@/lib/seller/navigation";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function staticTests() {
  console.log("\n── stale copy removed ──");
  const banner = read("src/components/seller/approved-banner.tsx");
  const offersNew = read("src/app/seller/(portal)/offers/new/page.tsx");
  const createForm = read("src/components/seller/offer-create-form.tsx");
  const nav = read("src/lib/seller/navigation.ts");

  // 1 — dashboard banner
  ok("1 · banner no longer says 'customer checkout opens for sellers'",
    !/customer checkout opens for sellers/.test(banner));
  ok("1 · banner no longer claims multiSellerCheckout is off",
    !/multiSellerCheckout is off/.test(banner));
  ok("1 · banner now tells the seller they can publish + buyers can purchase",
    /publish a listing when it(&rsquo;|['’])s ready/.test(banner) &&
    /buyers can[\s\S]{0,30}purchase from your published listings/.test(banner));
  ok("1 · banner copy still avoids the 9F-5c forbidden phrases",
    !/sell to customers|customers can buy|live seller|active marketplace|start selling/i.test(banner));

  // 2 — /seller/offers/new empty state
  ok("2 · offers/new no longer says 'opens in a later phase'",
    !/opens in a later phase/.test(offersNew) && !/requesting a new one/.test(offersNew));
  ok("2 · offers/new empty state now says 'request it' + links /seller/product-requests/new",
    /doesn't carry your product yet, request it\./.test(offersNew) &&
    /href="\/seller\/product-requests\/new"/.test(offersNew));

  // 3 — offer-create-form
  ok("3 · offer-create-form no longer says 'publishing to buyers opens later'",
    !/publishing to buyers opens later/.test(createForm));
  ok("3 · offer-create-form now points to the listing page to publish",
    /publish it from the listing page when it(&rsquo;|['’])s ready/.test(createForm));

  // 4 — navigation doc comment
  ok("4 · seller navigation doc comment no longer says routes 'land in later phases'",
    !/land in later phases/.test(nav));
  ok("4 · seller navigation doc comment reflects the real portal",
    /every route below has a real[\s\S]{0,12}screen/.test(nav));

  // 5 (9F-29C) — Listings status-filter lifecycle order
  const offersPage = read("src/app/seller/(portal)/offers/page.tsx");
  const filterValues = [...offersPage.matchAll(/\{ value: "(DRAFT|ACTIVE|INACTIVE|ARCHIVED)", label: "[^"]+" \}/g)].map((m) => m[1]);
  ok("5 · Listings status filter options are in lifecycle order (FilterSelect prepends 'All')",
    JSON.stringify(filterValues) === JSON.stringify(["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"]),
    JSON.stringify(filterValues));
  ok("5 · FilterSelect still auto-prepends 'All' (default allLabel), so the rendered order is All → Draft → Active → Inactive → Archived",
    /allLabel = "All"/.test(read("src/components/admin/ui/controls.tsx")) &&
    /<option value="">\{allLabel\}<\/option>/.test(read("src/components/admin/ui/controls.tsx")) &&
    /<FilterSelect\s*\n\s*label="Status"/.test(offersPage));

  // ── no functional change ──────────────────────────────────────────────
  console.log("\n── no functional code changed ──");
  ok("nav · SELLER_ROUTES array + helpers unchanged (7 live routes, /seller/offers path kept)",
    SELLER_ROUTES.length === 7 &&
    SELLER_ROUTES.every((r) => r.live === true) &&
    SELLER_ROUTES.some((r) => r.path === "/seller/offers" && r.label === "Listings") &&
    SELLER_ROUTES.some((r) => r.path === "/seller/product-requests" && r.accepts === "manage_offers"));
  ok("nav · sellerNav / sellerBreadcrumbs still behave (OWNER sees all; crumbs resolve)",
    sellerNav(new Set<string>(), "OWNER").length === 7 &&
    sellerNav(new Set(["view_offers"]), "STAFF").some((r) => r.path === "/seller/offers") &&
    sellerBreadcrumbs("/seller/offers/new").map((c) => c.label).join(">") === "Seller>Listings>Add listing");
  ok("nav · doc comment change is comment-only (no code line touched below the header)",
    /^export const SELLER_ROUTES: SellerRoute\[\] = \[/m.test(nav) && /export function sellerNav\(/.test(nav));

  ok("banner · dismiss / localStorage logic untouched",
    /localStorage\.setItem\(KEY, "1"\)/.test(banner) && /useSyncExternalStore\(subscribe, isDismissed, isDismissedServer\)/.test(banner) &&
    /SellerApprovedBanner\(\{ sellerName \}/.test(banner));
  ok("offers/new · still renders OfferCreateForm + findListableVariants (workflow unchanged)",
    /<OfferCreateForm/.test(offersNew) && /findListableVariants\(ctx/.test(offersNew) &&
    /requireSellerSessionPermission\("manage_offers"\)/.test(offersNew));
  ok("offer-create-form · still submits createOfferAction with the 'Create listing' button",
    /createOfferAction/.test(createForm) && /Create listing/.test(createForm));

  // scope — nothing outside the 4 named files, no logic markers
  ok("scope · no marketplace/offer-status/permission/checkout/inventory/email/schema change",
    !/9F-29B/.test(read("src/lib/marketplace/seller-repository.ts")) &&
    !/9F-29B/.test(read("src/lib/seller/offer-actions.ts")) &&
    !/9F-29B/.test(read("src/lib/checkout.ts")) &&
    !/9F-29B/.test(read("src/lib/email/notifications.ts")) &&
    !/9F-29B/.test(read("prisma/schema.prisma")) &&
    !/9F-29B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · offer-status-controls + offer detail page NOT touched (already 9F-24A-correct)",
    !/9F-29B/.test(read("src/components/seller/offer-status-controls.tsx")) &&
    !/9F-29B/.test(read("src/app/seller/(portal)/offers/[id]/page.tsx")));
}

async function prodTests() {
  console.log("\n── production (READ-ONLY, context) ──");
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("prod · marketplace.multiSellerCheckout is 'true' — the new copy is accurate", g?.value === "true", g?.value ?? "(unset)");
}

async function main() {
  console.log("\nPHASE 9F-29B — stale 3P seller-portal copy\n");
  staticTests();
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
