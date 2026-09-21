/**
 * Product packed shipping dimensions — `Product.lengthCm/widthCm/heightCm`
 * (data-only fields, prepared for future carrier rate/label support).
 * Mirrors the `scripts/test-9f41b.ts` / `scripts/test-origin-address.ts`
 * pattern: DB fixtures build inside ONE `prisma.$transaction` and roll back —
 * nothing persists, no real Product row is touched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-product-dimensions.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { dimensionCmSchema, parseOptionalDimension } from "@/lib/admin/catalog-schemas";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

// ── pure — form parsing ────────────────────────────────────────────────
function parseTests() {
  console.log("\n── pure — parseOptionalDimension (blank/missing → null) ──");
  ok("blank string ->  null", parseOptionalDimension("") === null);
  ok("whitespace only -> null", parseOptionalDimension("   ") === null);
  ok("null -> null", parseOptionalDimension(null) === null);
  ok("'120' -> 120 (number)", parseOptionalDimension("120") === 120);
  ok("'12.5' -> 12.5 (schema rejects, not this fn)", parseOptionalDimension("12.5") === 12.5);
  ok("'abc' -> NaN (schema rejects, not this fn)", Number.isNaN(parseOptionalDimension("abc")));
}

// ── pure — validation schema ─────────────────────────────────────────────
function schemaTests() {
  console.log("\n── pure — dimensionCmSchema (optional, whole numbers > 0) ──");
  const v = (n: number | null) => dimensionCmSchema.safeParse(n);

  ok("A · null (not supplied) is accepted", v(null).success);
  ok("A · undefined (not supplied) is accepted", dimensionCmSchema.safeParse(undefined).success);
  ok("A · a valid whole number (e.g. 45) passes", v(45).success && v(45).success && (v(45) as { data: number }).data === 45);
  ok("A · a large-but-plausible whole number (e.g. 250) passes", v(250).success);
  ok("B · zero is rejected", !v(0).success);
  ok("C · a negative value is rejected", !v(-5).success);
  ok("D · a decimal value is rejected", !v(12.5).success);
  ok("E · a non-numeric value (NaN, from bad form input) is rejected", !v(NaN).success);
  ok("no arbitrary maximum — a very large plausible dimension (e.g. 100000 cm, unrealistic but not schema's job to cap) passes",
    v(100000).success);
}

// ── DB (transactional — rolls back, nothing persists, no real Product touched) ──
async function dbTests() {
  console.log("\n── DB (transaction rolls back — no persisted writes, no real product touched) ──");
  const before = {
    products: await prisma.product.count(),
    withDims: await prisma.product.count({
      where: { OR: [{ lengthCm: { not: null } }, { widthCm: { not: null } }, { heightCm: { not: null } }] },
    }),
  };

  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) throw new Error("no category exists — cannot build a fixture product");

  const sfx = Math.random().toString(36).slice(2, 8);
  const seedProduct = (tx: Tx, dims: { lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null } = {}) =>
    tx.product.create({
      data: {
        name: `Dim Test ${sfx}`,
        slug: `dim-test-${sfx}-${Math.random().toString(36).slice(2, 8)}`,
        shortDescription: "s",
        description: "d",
        categoryId: category!.id,
        status: "DRAFT",
        price: 1000,
        ...dims,
      },
      select: { id: true, lengthCm: true, widthCm: true, heightCm: true },
    });

  try {
    await prisma.$transaction(async (tx) => {
      // A — a fixture product with NO dimensions supplied stays NULL (no default, unlike weightGrams)
      const P0 = await seedProduct(tx);
      ok("A · a new product with no dimensions supplied → all three NULL (no default applied)",
        P0.lengthCm === null && P0.widthCm === null && P0.heightCm === null);

      // B — round-trip: set valid dimensions, read them back
      const P1 = await seedProduct(tx);
      const parsed = {
        lengthCm: dimensionCmSchema.parse(60),
        widthCm: dimensionCmSchema.parse(40),
        heightCm: dimensionCmSchema.parse(25),
      };
      await tx.product.update({ where: { id: P1.id }, data: parsed });
      const read1 = await tx.product.findUniqueOrThrow({ where: { id: P1.id }, select: { lengthCm: true, widthCm: true, heightCm: true, name: true, price: true, status: true } });
      ok("B · valid dimensions (60x40x25) round-trip through Prisma exactly",
        read1.lengthCm === 60 && read1.widthCm === 40 && read1.heightCm === 25);
      ok("B · other Product fields (name/price/status) are untouched by a dimensions-only update",
        read1.name === `Dim Test ${sfx}` && read1.price === 1000 && read1.status === "DRAFT");

      // C — clearing dimensions back to NULL (admin blanks the field)
      await tx.product.update({ where: { id: P1.id }, data: { lengthCm: null, widthCm: null, heightCm: null } });
      const read2 = await tx.product.findUniqueOrThrow({ where: { id: P1.id }, select: { lengthCm: true, widthCm: true, heightCm: true } });
      ok("C · dimensions can be cleared back to NULL", read2.lengthCm === null && read2.widthCm === null && read2.heightCm === null);

      // D — a partial update (only length supplied) leaves the others as they were, exactly
      // like the real form: it always submits all three, so this proves the write is a full
      // replace of the three fields together, not a silent partial-clobber path.
      const P2 = await seedProduct(tx, { lengthCm: 10, widthCm: 20, heightCm: 30 });
      await tx.product.update({ where: { id: P2.id }, data: { lengthCm: 99, widthCm: 20, heightCm: 30 } });
      const read3 = await tx.product.findUniqueOrThrow({ where: { id: P2.id }, select: { lengthCm: true, widthCm: true, heightCm: true } });
      ok("D · re-submitting the full form (unchanged width/height + a new length) stores exactly that",
        read3.lengthCm === 99 && read3.widthCm === 20 && read3.heightCm === 30);

      // E — validation-rejected inputs never reach the DB (the action would return early;
      // simulate that guarantee by asserting the schema rejects before any tx.update call)
      ok("E · zero/negative/decimal/NaN never produce a valid parsed value to write",
        !dimensionCmSchema.safeParse(0).success &&
        !dimensionCmSchema.safeParse(-1).success &&
        !dimensionCmSchema.safeParse(12.5).success &&
        !dimensionCmSchema.safeParse(NaN).success);

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · product count unchanged (no fixture product leaked)", (await prisma.product.count()) === before.products);
  ok("rollback · no Product dimension leaked into the real database", (await prisma.product.count({
    where: { OR: [{ lengthCm: { not: null } }, { widthCm: { not: null } }, { heightCm: { not: null } }] },
  })) === before.withDims);
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const cols = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='Product' AND column_name IN ('lengthCm','widthCm','heightCm')`,
  );
  ok("prod · all 3 Product dimension columns exist", cols[0].n === 3);
  ok("prod · no Product has a dimension yet (no backfill, no test data leaked)",
    (await prisma.product.count({
      where: { OR: [{ lengthCm: { not: null } }, { widthCm: { not: null } }, { heightCm: { not: null } }] },
    })) === 0);
  ok("prod · product count unchanged at 38", (await prisma.product.count()) === 38);
  ok("prod · seller count unchanged at 3, all originAddress still NULL",
    (await prisma.seller.count()) === 3 &&
    (await prisma.seller.count({ where: { originAddress: { not: Prisma.JsonNull } } })) === 0);
  const shipment = await prisma.shipment.findFirst({ select: { direction: true, returnRequestId: true } });
  ok("prod · the existing Shipment row is still direction=FORWARD, returnRequestId=NULL",
    shipment?.direction === "FORWARD" && shipment?.returnRequestId === null);
  const counts = {
    seller: await prisma.seller.count(),
    product: await prisma.product.count(),
    shipment: await prisma.shipment.count(),
    order: await prisma.order.count(),
    sellerOrder: await prisma.sellerOrder.count(),
    payment: await prisma.payment.count(),
  };
  console.log("  counts:", JSON.stringify(counts));
  ok("prod · Seller=3, Product=38, Shipment=1, Order=12, SellerOrder=12, Payment=2",
    counts.seller === 3 && counts.product === 38 && counts.shipment === 1 &&
    counts.order === 12 && counts.sellerOrder === 12 && counts.payment === 2);
}

async function main() {
  console.log("\nProduct packed shipping dimensions — data-only fields\n");
  parseTests();
  schemaTests();
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
