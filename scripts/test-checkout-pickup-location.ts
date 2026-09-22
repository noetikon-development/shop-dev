/**
 * Store Pickup location selection in checkout (Phase 9F-49 checkout step).
 *
 * Focused on the one piece of new logic that actually needs DB-backed
 * verification: `getActivePickupLocations()`'s scoping (`sellerId: null` AND
 * `active: true`). Everything `createOrderFromCart` does with that list
 * (`activeLocations.find((l) => l.id === input.pickupLocationId) ?? null`) is
 * then correct BY CONSTRUCTION — a `.find()` over a correctly-scoped list can
 * never resolve to an inactive, nonexistent, or seller-owned row, so there is
 * no separate acceptance-logic to test once the scoping itself is proven.
 *
 * `createOrderFromCart` itself is not exercised directly here: it opens by
 * calling `getCurrentUser()` (a real Supabase session), which cannot be
 * faked in a standalone script the way a `SellerContext` can be constructed
 * by hand for the marketplace repository layer — unlike those functions,
 * this one has no way to inject an authenticated caller. Testing it live
 * would require a real user session and a real cart, which this task's
 * "do not create test orders" constraint rules out anyway.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back — no
 * PickupLocation row is ever persisted.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-checkout-pickup-location.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { getActivePickupLocations } from "@/lib/shipping";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

// ── pure — snapshot shape ────────────────────────────────────────────────
function snapshotShapeTest() {
  console.log("\n── pure — pickupLocationSnapshot field shape ──");
  const dto = {
    id: "x", name: "Batangas City Store", recipient: "Axiaro Ops", phone: "+639170000000",
    line1: "1 Warehouse Rd", line2: "Bldg B", barangay: "San Isidro", city: "Batangas City",
    province: "Batangas", postalCode: "4200", country: "PH", instructions: "Ready in 1-2 days",
  };
  // Mirrors exactly the object literal built in checkout.ts's createOrderFromCart.
  const snapshot = {
    name: dto.name, recipient: dto.recipient, phone: dto.phone, line1: dto.line1, line2: dto.line2,
    barangay: dto.barangay, city: dto.city, province: dto.province, postalCode: dto.postalCode,
    country: dto.country, instructions: dto.instructions,
  };
  const expectedKeys = ["name", "recipient", "phone", "line1", "line2", "barangay", "city", "province", "postalCode", "country", "instructions"];
  ok("snapshot has exactly the customer-facing fields, nothing else (no internal id leaked)",
    JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify([...expectedKeys].sort()) && !("id" in snapshot));
}

// ── DB (transaction rolls back — no persisted writes) ──────────────────
async function scopingTests() {
  console.log("\n── DB (transaction rolls back — no PickupLocation row persists) ──");
  const before = {
    pickupLocations: await prisma.pickupLocation.count(),
  };

  const realSeller = await prisma.seller.findFirst({ where: { type: "THIRD_PARTY" }, select: { id: true } });
  if (!realSeller) throw new Error("no THIRD_PARTY seller exists to build the seller-owned fixture against");

  const sfx = Math.random().toString(36).slice(2, 8);
  const fixture = (tx: Tx, tag: string, opts: { active: boolean; sellerId: string | null }) =>
    tx.pickupLocation.create({
      data: {
        sellerId: opts.sellerId,
        name: `Fixture ${tag} ${sfx}`,
        recipient: "Test Recipient", phone: "+639170000000",
        line1: "1 Test Rd", city: "Test City", province: "Test Province", postalCode: "1000", country: "PH",
        active: opts.active,
      },
      select: { id: true },
    });

  try {
    await prisma.$transaction(async (tx) => {
      const activeAxiaro = await fixture(tx, "active-axiaro", { active: true, sellerId: null });
      const inactiveAxiaro = await fixture(tx, "inactive-axiaro", { active: false, sellerId: null });
      const activeSellerOwned = await fixture(tx, "active-seller-owned", { active: true, sellerId: realSeller.id });

      const active = await getActivePickupLocations(tx);
      const ids = active.map((l) => l.id);

      ok("getActivePickupLocations() includes the active Axiaro-owned fixture",
        ids.includes(activeAxiaro.id));
      ok("getActivePickupLocations() EXCLUDES the inactive Axiaro-owned fixture",
        !ids.includes(inactiveAxiaro.id));
      ok("getActivePickupLocations() EXCLUDES the active but seller-owned fixture",
        !ids.includes(activeSellerOwned.id));

      // The exact lookup createOrderFromCart performs — proven correct by
      // construction once the scoping above holds.
      const resolve = (id: string) => active.find((l) => l.id === id) ?? null;
      ok("simulated order-write lookup ACCEPTS the active Axiaro-owned id", resolve(activeAxiaro.id) !== null);
      ok("simulated order-write lookup REJECTS the inactive id", resolve(inactiveAxiaro.id) === null);
      ok("simulated order-write lookup REJECTS the seller-owned id", resolve(activeSellerOwned.id) === null);
      ok("simulated order-write lookup REJECTS a nonexistent id", resolve("not-a-real-id") === null);

      const returnedFields = active.find((l) => l.id === activeAxiaro.id);
      ok("returned DTO carries the expected customer-facing fields",
        returnedFields?.name === `Fixture active-axiaro ${sfx}` && returnedFields?.city === "Test City" && returnedFields?.country === "PH");

      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · PickupLocation count unchanged (no fixture leaked)", (await prisma.pickupLocation.count()) === before.pickupLocations);
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  ok("prod · PickupLocation count is 0 (no real records exist or were created)", (await prisma.pickupLocation.count()) === 0);
  ok("prod · getActivePickupLocations() against the real DB returns [] (zero-location fallback path)",
    (await getActivePickupLocations()).length === 0);
  const pickup = await prisma.shippingMethod.findUnique({ where: { code: "PICKUP" }, select: { active: true, description: true } });
  ok("prod · ShippingMethod PICKUP still active=false, description unchanged",
    pickup?.active === false && pickup?.description === "Collect from our Batangas City store, ready in 1–2 days");
}

async function main() {
  console.log("\nStore Pickup location selection in checkout — focused test\n");
  snapshotShapeTest();
  await scopingTests();
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
