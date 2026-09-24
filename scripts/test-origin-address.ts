/**
 * Seller pickup / origin address — `Seller.originAddress` (data-only field,
 * part of the moderated profile bundle, same shape/validation as
 * `returnAddress`). Mirrors the `scripts/test-9f41b.ts` pattern: DB fixtures
 * build inside ONE `prisma.$transaction` and roll back — nothing persists.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-origin-address.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import {
  validateSellerOriginAddress,
  parseSellerOriginAddress,
  sellerOriginAddressLines,
} from "@/lib/marketplace/origin-address";
import { validateSellerReturnAddress } from "@/lib/marketplace/return-destination";
import { updateSellerProfileDraft } from "@/lib/marketplace/seller-profile-repository";
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

const ADDR = {
  recipient: "Style Avenue Warehouse",
  line1: "45 Industrial Ave",
  line2: "Unit 3",
  barangay: "San Isidro",
  city: "Batangas City",
  province: "Batangas",
  postalCode: "4200",
  country: "PH",
  phone: "+63 917 555 0199",
};

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — origin-address validation / parse / display ──");

  const v = validateSellerOriginAddress(ADDR);
  ok("A · a complete address validates", v.ok && v.value != null && v.value.city === "Batangas City");
  ok("A · an all-blank map → { ok: true, value: null } (cleared)",
    (() => { const r = validateSellerOriginAddress({}); return r.ok && r.value === null; })());
  ok("A · a missing required field is rejected",
    !validateSellerOriginAddress({ ...ADDR, line1: "" }).ok && !validateSellerOriginAddress({ ...ADDR, city: "" }).ok);
  ok("A · a bad phone / postal code for the country is rejected",
    !validateSellerOriginAddress({ ...ADDR, phone: "nope" }).ok && !validateSellerOriginAddress({ ...ADDR, postalCode: "999999" }).ok);
  ok("A · an unsupported country is rejected", !validateSellerOriginAddress({ ...ADDR, country: "ZZ" }).ok);
  ok("A · line2 + barangay are optional", validateSellerOriginAddress({ ...ADDR, line2: "", barangay: "" }).ok);
  ok("A · error messages are pickup-address-specific, not the return-address copy",
    validateSellerOriginAddress({ ...ADDR, line1: "" }).ok === false &&
    /Pickup address/.test((validateSellerOriginAddress({ ...ADDR, line1: "" }) as { error: string }).error));

  ok("parse · parseSellerOriginAddress round-trips a stored blob; incomplete → null",
    parseSellerOriginAddress(ADDR)?.postalCode === "4200" && parseSellerOriginAddress({ recipient: "x" }) === null && parseSellerOriginAddress(null) === null);

  ok("lines · sellerOriginAddressLines renders recipient → phone, drops blanks",
    (() => { const L = sellerOriginAddressLines(parseSellerOriginAddress(ADDR)!); return L[0] === "Style Avenue Warehouse" && L.includes("+63 917 555 0199") && L.some((l) => l.includes("Philippines")); })());

  ok("independence · validateSellerOriginAddress and validateSellerReturnAddress are separate functions with separate copy",
    validateSellerOriginAddress !== (validateSellerReturnAddress as unknown));
}

// ── coordinates (lat/lng) — optional, manual, never geocoded ────────────
function coordinateTests() {
  console.log("\n── coordinates — lat/lng validation / parse round-trip ──");

  ok("coord · an address with no lat/lng remains valid, both null",
    (() => {
      const r = validateSellerOriginAddress(ADDR);
      return r.ok && r.value != null && r.value.lat === null && r.value.lng === null;
    })());

  ok("coord · valid lat/lng are accepted and returned as-is",
    (() => {
      const r = validateSellerOriginAddress({ ...ADDR, lat: "13.7565", lng: "121.0583" });
      return r.ok && r.value?.lat === "13.7565" && r.value?.lng === "121.0583";
    })());

  ok("coord · a negative, in-range lat/lng pair is accepted",
    (() => {
      const r = validateSellerOriginAddress({ ...ADDR, lat: "-33.8688", lng: "-70.6483" });
      return r.ok && r.value?.lat === "-33.8688" && r.value?.lng === "-70.6483";
    })());

  ok("coord · non-numeric latitude is rejected",
    !validateSellerOriginAddress({ ...ADDR, lat: "not-a-number", lng: "121.0583" }).ok);

  ok("coord · non-numeric longitude is rejected",
    !validateSellerOriginAddress({ ...ADDR, lat: "13.7565", lng: "not-a-number" }).ok);

  ok("coord · latitude outside -90..90 is rejected (91)",
    !validateSellerOriginAddress({ ...ADDR, lat: "91", lng: "121.0583" }).ok);
  ok("coord · latitude outside -90..90 is rejected (-91)",
    !validateSellerOriginAddress({ ...ADDR, lat: "-91", lng: "121.0583" }).ok);

  ok("coord · longitude outside -180..180 is rejected (181)",
    !validateSellerOriginAddress({ ...ADDR, lat: "13.7565", lng: "181" }).ok);
  ok("coord · longitude outside -180..180 is rejected (-181)",
    !validateSellerOriginAddress({ ...ADDR, lat: "13.7565", lng: "-181" }).ok);

  ok("coord · boundary values -90/90 and -180/180 are accepted",
    validateSellerOriginAddress({ ...ADDR, lat: "90", lng: "180" }).ok &&
    validateSellerOriginAddress({ ...ADDR, lat: "-90", lng: "-180" }).ok);

  ok("coord · lat/lng error messages are pickup-address-specific",
    /Pickup address — latitude/.test((validateSellerOriginAddress({ ...ADDR, lat: "999" }) as { error: string }).error) &&
    /Pickup address — longitude/.test((validateSellerOriginAddress({ ...ADDR, lat: "13.7565", lng: "999" }) as { error: string }).error));

  ok("coord · parseSellerOriginAddress round-trips lat/lng from a stored blob",
    (() => {
      const stored = { ...ADDR, lat: "13.7565", lng: "121.0583" };
      const p = parseSellerOriginAddress(stored);
      return p?.lat === "13.7565" && p?.lng === "121.0583";
    })());

  ok("coord · parseSellerOriginAddress returns null lat/lng when the stored blob has none",
    (() => {
      const p = parseSellerOriginAddress(ADDR);
      return p?.lat === null && p?.lng === null;
    })());
}

// ── DB (transactional — rolls back, nothing persists) ──────────────────
async function dbTests() {
  console.log("\n── DB (transaction rolls back — no persisted writes) ──");
  const before = {
    sellers: await prisma.seller.count(),
    withOrigin: await prisma.seller.count({ where: { originAddress: { not: Prisma.JsonNull } } }),
  };

  const sfx = Math.random().toString(36).slice(2, 8);
  const seed = (tx: Tx, tag: string, opts: { contentStatus?: string; origin?: object | null; ret?: object | null } = {}) =>
    tx.seller.create({
      data: {
        type: "THIRD_PARTY", status: "APPROVED", displayName: `${tag} ${sfx}`, slug: `${tag}-${sfx}-${Math.random().toString(36).slice(2, 6)}`,
        supportEmail: "s@t.test",
        contentStatus: opts.contentStatus ?? "APPROVED",
        originAddress: opts.origin === undefined ? Prisma.JsonNull : opts.origin === null ? Prisma.JsonNull : (opts.origin as object),
        returnAddress: opts.ret === undefined ? Prisma.JsonNull : opts.ret === null ? Prisma.JsonNull : (opts.ret as object),
      },
      select: { id: true, contentStatus: true },
    });

  try {
    await prisma.$transaction(async (tx) => {
      // A — moderation: editing originAddress on an APPROVED bundle drops it to PENDING via the SAME writeBundle() used by returnAddress.
      const S = await seed(tx, "mod", { contentStatus: "APPROVED" });
      const m = await updateSellerProfileDraft(ctxFor(S.id), { originAddress: ADDR }, tx);
      ok("A · updateSellerProfileDraft(originAddress) → ok, bundle now PENDING (APPROVED edit, same gate as returnAddress)", m.ok && m.contentStatus === "PENDING");
      const modRow = await tx.seller.findUniqueOrThrow({ where: { id: S.id }, select: { originAddress: true, contentStatus: true } });
      ok("A · the address persisted (inside the tx) and parses back correctly, contentStatus PENDING",
        parseSellerOriginAddress(modRow.originAddress)?.city === "Batangas City" && modRow.contentStatus === "PENDING");

      // B — validation rejects a bad patch, stored value unchanged
      const bad = await updateSellerProfileDraft(ctxFor(S.id), { originAddress: { ...ADDR, phone: "" } }, tx);
      ok("B · a missing required field is rejected (VALIDATION), stored value unchanged",
        !bad.ok && bad.code === "VALIDATION" &&
        parseSellerOriginAddress((await tx.seller.findUniqueOrThrow({ where: { id: S.id }, select: { originAddress: true } })).originAddress)?.city === "Batangas City");

      // C — clearing (blank map) → null
      const cleared = await updateSellerProfileDraft(ctxFor(S.id), { originAddress: {} }, tx);
      ok("C · a blank map clears the address (VALIDATION-free), stored value → null",
        cleared.ok && parseSellerOriginAddress((await tx.seller.findUniqueOrThrow({ where: { id: S.id }, select: { originAddress: true } })).originAddress) === null);

      // D — independence: setting originAddress never touches returnAddress and vice versa
      const S2 = await seed(tx, "indep", { contentStatus: "APPROVED", ret: { recipient: "R", line1: "L1", line2: null, barangay: null, city: "C", province: "P", postalCode: "1000", country: "PH", phone: "+639170000000" } });
      await updateSellerProfileDraft(ctxFor(S2.id), { originAddress: ADDR }, tx);
      const afterOrigin = await tx.seller.findUniqueOrThrow({ where: { id: S2.id }, select: { originAddress: true, returnAddress: true } });
      ok("D · setting originAddress does not clobber an existing returnAddress",
        parseSellerOriginAddress(afterOrigin.originAddress)?.city === "Batangas City" &&
        parseSellerOriginAddress(afterOrigin.returnAddress as Prisma.JsonValue)?.line1 === "L1");
      await updateSellerProfileDraft(ctxFor(S2.id), { returnAddress: { recipient: "R2", line1: "L2", city: "C2", province: "P2", postalCode: "2000", country: "PH", phone: "+639170000001" } }, tx);
      const afterReturn = await tx.seller.findUniqueOrThrow({ where: { id: S2.id }, select: { originAddress: true, returnAddress: true } });
      ok("D · setting returnAddress does not clobber the just-set originAddress",
        parseSellerOriginAddress(afterReturn.originAddress)?.city === "Batangas City" &&
        parseSellerOriginAddress(afterReturn.returnAddress as Prisma.JsonValue)?.line1 === "L2");

      // E — a DRAFT bundle stays DRAFT (never silently APPROVED / PENDING by this write)
      const S3 = await seed(tx, "draft", { contentStatus: "DRAFT" });
      const d = await updateSellerProfileDraft(ctxFor(S3.id), { originAddress: ADDR }, tx);
      ok("E · editing originAddress on a DRAFT bundle keeps it DRAFT (writeBundle never sets APPROVED, only APPROVED→PENDING)", d.ok && d.contentStatus === "DRAFT");

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · seller count unchanged (no fixture seller leaked)", (await prisma.seller.count()) === before.sellers);
  ok("rollback · no Seller.originAddress leaked into the real database", (await prisma.seller.count({ where: { originAddress: { not: Prisma.JsonNull } } })) === before.withOrigin);
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const cols = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='Seller' AND column_name='originAddress'`,
  );
  ok("prod · Seller.originAddress column exists", cols[0].n === 1);
  ok("prod · no Seller has an originAddress yet (no backfill, no test data leaked)",
    (await prisma.seller.count({ where: { originAddress: { not: Prisma.JsonNull } } })) === 0);
  ok("prod · seller count unchanged at 3 (Axiaro, Sandbox Seller (dev), Style Avenue)", (await prisma.seller.count()) === 3);
}

async function main() {
  console.log("\nSeller pickup / origin address — data-only field\n");
  pureTests();
  coordinateTests();
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
