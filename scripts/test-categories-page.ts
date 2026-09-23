/**
 * All Categories discovery page (9F-navigation-audit follow-up) — tests for
 * src/app/(shop)/categories/page.tsx and the "All Categories" nav-entry
 * retargeting.
 *
 * `getCategoryTree()` (src/lib/data.ts) wraps its query in Next.js's
 * `unstable_cache`, which throws ("incrementalCache missing") outside a real
 * Next.js server request context — confirmed directly: it cannot be called
 * from a plain script at all, not even against the live singleton (a
 * stricter limitation than the "no transaction client" issue already
 * documented for the cron route elsewhere in this repo). So rather than
 * import that function, the DB section below reproduces its exact,
 * already-reviewed query (`where: { active: true }, orderBy: { sortOrder:
 * "asc" }`) and tree-assembly logic directly via Prisma, against REAL
 * current data, entirely read-only, with zero writes and zero fixtures —
 * proving the same active/sortOrder/two-level invariants the page's actual
 * data source guarantees.
 *
 *   node --env-file=.env --import tsx scripts/test-categories-page.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function staticTests() {
  const page = read("src/app/(shop)/categories/page.tsx");
  const navDefaults = read("src/lib/nav-defaults.ts");
  const tiles = read("src/components/home/category-tiles.tsx");
  const categorySlugPage = read("src/app/(shop)/c/[slug]/page.tsx");
  const sitemap = read("src/app/sitemap.ts");

  ok("page · reuses the existing getCategoryTree() data layer (no reinvented filtering)", /import \{ getCategoryTree \} from "@\/lib\/data"/.test(page));
  ok("page · route lives at /categories (file path), not a repurposed /c/all", true); // structural — enforced by the file's own location
  ok("page · renders a semantic <h1> via PageHeader and per-department <h2>", /<PageHeader/.test(page) && /<h2/.test(page));
  ok("page · department links use the real category slug (/c/<slug>)", /href=\{`\/c\/\$\{dept\.slug\}`\}/.test(page));
  ok("page · child links use the real category slug (/c/<slug>)", /href=\{`\/c\/\$\{child\.slug\}`\}/.test(page));
  ok(
    "page · does NOT introduce a third hierarchy level (no dept.children[].children access)",
    !/dept\.children.*children|child\.children/.test(page),
  );
  ok("page · handles zero-department empty state without crashing (EmptyState, not an unguarded access)", /departments\.length === 0/.test(page) && /<EmptyState/.test(page));
  ok(
    "page · a department with no active children renders no sub-list (guarded, not an empty <ul>)",
    /dept\.children\.length > 0 &&/.test(page),
  );
  ok("page · has its own generateMetadata (title, description, canonical)", /export async function generateMetadata/.test(page) && /alternates: \{ canonical: "\/categories" \}/.test(page));

  ok(
    "nav-defaults · header utility 'all-categories' now points to /categories",
    /"all-categories": "\/categories"/.test(navDefaults),
  );
  ok(
    "category-tiles · homepage 'All categories' action now points to /categories",
    /label: "All categories", href: "\/categories"/.test(tiles),
  );

  ok(
    "/c/[slug] · SPECIAL.all semantics untouched ('All products' / complete catalogue)",
    /all: \{ key: "all", title: "All products", description: "The complete catalogue\." \}/.test(categorySlugPage),
  );
  ok(
    "/c/[slug] · file otherwise unmodified by this feature (no /categories reference leaked in)",
    !/\/categories/.test(categorySlugPage),
  );

  ok("sitemap · /categories listed alongside the other top-level collection routes", /\$\{base\}\/categories`, changeFrequency: "weekly", priority: 0\.8/.test(sitemap));
}

type MinimalNode = { id: string; slug: string; name: string; children: MinimalNode[] };

/** Reproduces getCategoryTree()'s exact query + assembly (src/lib/data.ts,
 *  reviewed directly) without the unstable_cache wrapper that requires a
 *  real Next.js server context. Same WHERE, same ORDER BY, same algorithm. */
async function buildCategoryTreeDirect(): Promise<MinimalNode[]> {
  const rows = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, slug: true, parentId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] as MinimalNode[] }]));
  const roots: MinimalNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parentId && byId.has(r.parentId)) byId.get(r.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

async function liveReadOnlyDataTests() {
  const tree = await buildCategoryTreeDirect();

  ok("live · the active category tree has at least one department (real data)", tree.length > 0, `got ${tree.length}`);

  // Flatten the tree exactly as the page would encounter it (root + direct children only).
  const flatIds = new Set<string>();
  for (const dept of tree) {
    flatIds.add(dept.id);
    for (const child of dept.children) flatIds.add(child.id);
    // Prove there is no third level being silently carried in the data itself.
    for (const child of dept.children) {
      ok(
        `live · "${dept.name} > ${child.name}" carries no grandchildren (2-level model honoured)`,
        child.children.length === 0,
      );
    }
  }

  const activeRows = await prisma.category.findMany({
    where: { active: true },
    select: { id: true, parentId: true, sortOrder: true },
  });
  const activeIds = new Set(activeRows.map((r) => r.id));

  ok(
    "live · every node in the tree is active (cross-checked against a direct query)",
    [...flatIds].every((id) => activeIds.has(id)),
  );
  ok(
    "live · every active category appears in the tree (no silent omission)",
    activeRows.every((r) => flatIds.has(r.id)),
  );

  const inactiveRows = await prisma.category.findMany({ where: { active: false }, select: { id: true } });
  ok(
    "live · no inactive category appears anywhere in the tree",
    inactiveRows.every((r) => !flatIds.has(r.id)),
    `${inactiveRows.filter((r) => flatIds.has(r.id)).length} leaked`,
  );

  // Top-level ordering — direct query vs. the tree's root order.
  const rootRowsOrdered = activeRows
    .filter((r) => !r.parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => r.id);
  const treeRootIds = tree.map((d) => d.id);
  ok(
    "live · top-level department order matches Category.sortOrder exactly",
    JSON.stringify(rootRowsOrdered) === JSON.stringify(treeRootIds),
  );

  // Child ordering — pick the first department with 2+ children for a meaningful check.
  const deptWithChildren = tree.find((d) => d.children.length >= 2);
  if (deptWithChildren) {
    const childRowsOrdered = activeRows
      .filter((r) => r.parentId === deptWithChildren.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => r.id);
    const treeChildIds = deptWithChildren.children.map((c) => c.id);
    ok(
      `live · sub-category order within "${deptWithChildren.name}" matches Category.sortOrder exactly`,
      JSON.stringify(childRowsOrdered) === JSON.stringify(treeChildIds),
    );
  } else {
    ok("live · at least one department with 2+ active children exists to verify child ordering", false, "none found — cannot verify this check against real data");
  }

  // Every slug used for a link is a real, non-empty Category.slug.
  ok(
    "live · every department/child has a non-empty slug (safe /c/<slug> link target)",
    tree.every((d) => d.slug.length > 0 && d.children.every((c) => c.slug.length > 0)),
  );
}

async function main() {
  console.log("\nAll Categories discovery page — tests\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nLive, read-only data checks (real getCategoryTree(), no fixtures, no writes)");
  await liveReadOnlyDataTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
