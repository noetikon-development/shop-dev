/**
 * Category taxonomy hardening (broad-marketplace-taxonomy audit follow-up) —
 * generalizes category-cycle prevention (src/lib/admin/catalog.ts,
 * src/lib/admin/catalog-actions.ts) from a one-level-only check to an
 * arbitrary-depth ancestor walk, ahead of any future 3rd taxonomy level.
 *
 * The taxonomy itself stays at its current real depth (1 — department ->
 * category) for this task; the 3-level/grandchild scenario below is exercised
 * against a synthetic chain created and rolled back inside a single Prisma
 * transaction, so nothing is left in the database (see the same convention
 * in scripts/test-9da.ts).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-category-taxonomy-hardening.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { categoryWouldCreateCycle, categorySelectOptions } from "../src/lib/admin/catalog";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

class Rollback extends Error {}

function staticTests() {
  const catalog = read("src/lib/admin/catalog.ts");
  const actions = read("src/lib/admin/catalog-actions.ts");

  ok(
    "catalog.ts · categoryWouldCreateCycle is exported",
    /export async function categoryWouldCreateCycle/.test(catalog),
  );
  ok(
    "catalog.ts · walks the ancestor chain generally (while loop over parentOf), not a fixed one-level check",
    /while \(cur\)/.test(catalog) && /parentOf\.get\(cur\)/.test(catalog),
  );
  ok(
    "catalog.ts · guards against pre-existing corruption looping forever (visited-set)",
    /seen\.has\(cur\)/.test(catalog),
  );
  ok(
    "catalog-actions.ts · updateCategory now calls the general cycle check",
    /await categoryWouldCreateCycle\(id, data\.parentId\)/.test(actions),
  );
  ok(
    "catalog-actions.ts · the old one-level-only check (parent.parentId === id) is gone",
    !/parent\.parentId === id/.test(actions),
  );
}

async function liveDataTests() {
  // Real, already-existing data — no writes. "Living" (department) and one
  // of its real children give a genuine self/direct-child/unrelated triple
  // without needing any synthetic rows.
  const living = await prisma.category.findUnique({ where: { slug: "living" }, select: { id: true } });
  const sofas = await prisma.category.findUnique({ where: { slug: "sofas-seating" }, select: { id: true, parentId: true } });
  const bedroom = await prisma.category.findUnique({ where: { slug: "bedroom" }, select: { id: true } });
  if (!living || !sofas || !bedroom) {
    ok("live · expected seed categories (living/sofas-seating/bedroom) exist to test against", false);
    return;
  }
  ok("live · sofas-seating really is a direct child of living (test fixture sanity)", sofas.parentId === living.id);

  ok(
    "1  self-parent is rejected (categoryWouldCreateCycle(living, living) === true)",
    await categoryWouldCreateCycle(living.id, living.id) === true,
  );
  ok(
    "2  direct-child-as-parent is rejected (categoryWouldCreateCycle(living, sofas) === true)",
    await categoryWouldCreateCycle(living.id, sofas.id) === true,
  );
  ok(
    "4  valid, unrelated parent is accepted (categoryWouldCreateCycle(sofas, bedroom) === false)",
    await categoryWouldCreateCycle(sofas.id, bedroom.id) === false,
  );

  const picker = await categorySelectOptions(living.id);
  ok(
    "5  parent picker excludes the category itself (living) when editing living",
    !picker.some((o) => o.id === living.id),
  );
  ok(
    "5  parent picker excludes living's own descendant (sofas-seating) when editing living",
    !picker.some((o) => o.id === sofas.id),
  );
  ok(
    "5  parent picker still includes an unrelated category (bedroom) when editing living",
    picker.some((o) => o.id === bedroom.id),
  );

  // 6. Existing 2-level model unchanged — same invariant the audit measured
  // (52 categories, every child's parent has no parent of its own).
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  const byId = new Map(all.map((c) => [c.id, c]));
  const maxDepth = Math.max(
    ...all.map((c) => {
      let d = 0;
      let cur = c;
      while (cur.parentId && byId.has(cur.parentId)) {
        cur = byId.get(cur.parentId)!;
        d++;
      }
      return d;
    }),
  );
  ok("6  existing category tree is still exactly 2 levels deep (unchanged by this task)", maxDepth === 1, `got maxDepth=${maxDepth}`);
}

async function deeperDescendantTest() {
  // 3-level chain A -> B -> C, created and rolled back inside one transaction
  // — proves the general algorithm rejects a *grandchild* as parent, a case
  // the old one-level check (parent.parentId === id) could not catch, without
  // ever persisting a 3rd taxonomy level.
  const suffix = Math.random().toString(36).slice(2, 8);
  try {
    await prisma.$transaction(async (tx) => {
      const a = await tx.category.create({ data: { name: `Test A ${suffix}`, slug: `test-a-${suffix}` } });
      const b = await tx.category.create({ data: { name: `Test B ${suffix}`, slug: `test-b-${suffix}`, parentId: a.id } });
      const c = await tx.category.create({ data: { name: `Test C ${suffix}`, slug: `test-c-${suffix}`, parentId: b.id } });

      ok(
        "3  deeper-descendant (grandchild) as parent is rejected — categoryWouldCreateCycle(A, C) === true",
        await categoryWouldCreateCycle(a.id, c.id, tx) === true,
      );
      ok(
        "3  the old one-level check would have missed this (C.parentId is B, not A) — confirms the fix was necessary",
        c.parentId !== a.id,
      );
      ok(
        "4  a real ancestor-ward assignment is still valid — categoryWouldCreateCycle(C, A) === false (A is not a descendant of C)",
        await categoryWouldCreateCycle(c.id, a.id, tx) === false,
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const leaked = await prisma.category.count({ where: { slug: { contains: suffix } } });
  ok("synthetic 3-level test chain was fully rolled back (no leaked rows)", leaked === 0, `leaked ${leaked}`);
}

async function main() {
  console.log("\nCategory taxonomy hardening — tests\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nLive, read-only checks against real categories");
  await liveDataTests();
  console.log("\nSynthetic 3-level chain (created + rolled back in one transaction)");
  await deeperDescendantTest();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
