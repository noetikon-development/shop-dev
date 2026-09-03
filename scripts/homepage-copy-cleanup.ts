/**
 * Homepage wording & UI cleanup — repositions Axiaro as an e-commerce store /
 * marketplace rather than an in-house furniture design company.
 *
 * CONTENT ONLY. No schema change, no product / offer / inventory / cart / order
 * data touched. Operates purely on the CMS `ContentBlock` rows for the homepage.
 *
 *   1. homepage.valueprops.default — replace items 3 & 4:
 *        "Considered, in-house design" → "Discover more for everyday living" (icon compass)
 *          body: "Find useful products for every part of life."
 *        "Assembly help"               → "Helpful support"                   (icon headset)
 *          body: "We're here to help before, during, and after your purchase."
 *      Items 1 & 2 (shipping, returns) are untouched. Descriptions are
 *      deliberately category-neutral and marketplace-safe (valid for future
 *      3P sellers), and carry no manufacturing / in-house / assembly claim.
 *   2. homepage.editorial.default — DELETE the block entirely. It carried the
 *      single line "Designed in-house, and made to last." and is removed with
 *      no replacement. Remaining homepage blocks are renumbered to close the gap.
 *   3. homepage.hero.default — rewrite body + notes only (eyebrow / heading /
 *      CTAs / images untouched):
 *        body  "Furniture, lighting, textiles and a small wardrobe — designed
 *               in-house, made to last, and priced without the markup."
 *              → "Everything for everyday living."
 *        notes ["Designed in-house", "Easy returns", "Assembly help included"]
 *              → ["Free standard shipping", "Easy returns", "Helpful support"]
 *      Drops every manufacturing / in-house / assembly / no-markup claim so the
 *      hero stays valid for a broad catalogue + future 3P seller products, and
 *      mirrors the cleaned value-props row directly below it.
 *
 * All three changes are recorded in AdminAuditLog (targetType "content_block")
 * with the previous and new values.
 *
 * Idempotent: re-running validates each payload again, no-ops the editorial
 * delete if the row is already gone, and no-ops the hero write if already applied.
 *
 * Run:  node --env-file=.env --import tsx scripts/homepage-copy-cleanup.ts
 */
import { PrismaClient } from "@prisma/client";
import { heroSchema, valuePropsSchema } from "../src/lib/content-blocks";

const ACTOR_ID = "cmtibjt150000l504y4yyxgsg"; // marlo.deocampo@noetikon.tech (SUPER_ADMIN)
const ACTOR_EMAIL = "marlo.deocampo@noetikon.tech";
const VALUEPROPS_KEY = "homepage.valueprops.default";
const EDITORIAL_KEY = "homepage.editorial.default";
const HERO_KEY = "homepage.hero.default";

const HERO_BODY = "Everything for everyday living.";
const HERO_NOTES = ["Free standard shipping", "Easy returns", "Helpful support"];
const HERO_REASON =
  "Updated homepage hero to reflect Axiaro's e-commerce and future marketplace positioning and remove unsupported manufacturing/design claims.";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

async function audit(action: string, targetId: string | null, summary: string, meta: Record<string, unknown>) {
  await prisma.adminAuditLog.create({
    data: { actorUserId: ACTOR_ID, action, targetType: "content_block", targetId, summary, meta: JSON.stringify(meta) },
  });
}

async function run() {
  const now = new Date().toISOString();
  console.log(`Homepage copy cleanup — ${now}\n`);

  // ── 1. value_props items 3 & 4 ───────────────────────────────────────────
  const vp = await prisma.contentBlock.findUnique({ where: { key: VALUEPROPS_KEY } });
  if (!vp) throw new Error(`${VALUEPROPS_KEY} not found`);
  const prevVp = JSON.parse(vp.data) as { items: { icon: string; title: string; body: string }[] };

  const nextItems = prevVp.items.map((it, i) => {
    if (i === 2)
      return {
        icon: "compass",
        title: "Discover more for everyday living",
        body: "Find useful products for every part of life.",
      };
    if (i === 3)
      return {
        icon: "headset",
        title: "Helpful support",
        body: "We're here to help before, during, and after your purchase.",
      };
    return it;
  });
  const nextVp = valuePropsSchema.parse({ items: nextItems });
  const nextVpStr = JSON.stringify(nextVp);

  if (nextVpStr === vp.data) {
    console.log("  value_props: already up to date — no write");
  } else {
    await prisma.contentBlock.update({ where: { id: vp.id }, data: { data: nextVpStr } });
    await audit("content.block_updated", vp.id, `${ACTOR_EMAIL} refined homepage value props (items 3 & 4)`, {
      key: VALUEPROPS_KEY,
      previous: prevVp.items,
      next: nextVp.items,
      reason: "Reposition Axiaro as an e-commerce store: drop in-house-design / assembly-help framing",
      at: now,
    });
    console.log("  value_props: updated");
    console.log("    previous:", JSON.stringify(prevVp.items));
    console.log("    next:    ", JSON.stringify(nextVp.items));
  }

  // ── 2. delete the editorial block ────────────────────────────────────────
  const ed = await prisma.contentBlock.findUnique({ where: { key: EDITORIAL_KEY } });
  if (!ed) {
    console.log("\n  editorial: already removed — no delete");
  } else {
    const prevEd = JSON.parse(ed.data);
    await prisma.contentBlock.delete({ where: { id: ed.id } });
    await audit("content.block_deleted", ed.id, `${ACTOR_EMAIL} removed the homepage editorial statement block`, {
      key: EDITORIAL_KEY,
      previous: { type: ed.type, title: ed.title, status: ed.status, position: ed.position, data: prevEd },
      next: null,
      reason: "Remove 'Designed in-house, and made to last.' — no replacement (e-commerce repositioning)",
      at: now,
    });
    console.log(`\n  editorial: deleted (was "${prevEd.heading}")`);
  }

  // ── 3. hero body + notes ────────────────────────────────────────────────
  const hero = await prisma.contentBlock.findUnique({ where: { key: HERO_KEY } });
  if (!hero) throw new Error(`${HERO_KEY} not found`);
  const prevHero = JSON.parse(hero.data) as Record<string, unknown>;
  const nextHero = heroSchema.parse({ ...prevHero, body: HERO_BODY, notes: HERO_NOTES });
  const nextHeroStr = JSON.stringify(nextHero);

  if (nextHeroStr === hero.data) {
    console.log("\n  hero: already up to date — no write");
  } else {
    await prisma.contentBlock.update({ where: { id: hero.id }, data: { data: nextHeroStr } });
    await audit("content.block_updated", hero.id, `${ACTOR_EMAIL} rewrote the homepage hero body + notes`, {
      key: HERO_KEY,
      previous: { body: prevHero.body, notes: prevHero.notes },
      next: { body: nextHero.body, notes: nextHero.notes },
      reason: HERO_REASON,
      at: now,
    });
    console.log("\n  hero: updated");
    console.log("    previous body: ", JSON.stringify(prevHero.body));
    console.log("    previous notes:", JSON.stringify(prevHero.notes));
    console.log("    next body:     ", JSON.stringify(nextHero.body));
    console.log("    next notes:    ", JSON.stringify(nextHero.notes));
  }

  // ── 4. renumber remaining homepage blocks to close any gap ───────────────
  const blocks = await prisma.contentBlock.findMany({
    where: { area: "homepage" },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, key: true, position: true },
  });
  const renum = blocks.map((b, i) => ({ ...b, to: i })).filter((b) => b.to !== b.position);
  if (renum.length) {
    await prisma.$transaction(renum.map((b) => prisma.contentBlock.update({ where: { id: b.id }, data: { position: b.to } })));
    console.log(`\n  positions normalised: ${renum.map((b) => `${b.key} ${b.position}→${b.to}`).join(", ")}`);
  } else {
    console.log("\n  positions already contiguous");
  }

  const final = await prisma.contentBlock.findMany({
    where: { area: "homepage" },
    orderBy: { position: "asc" },
    select: { position: true, key: true, status: true },
  });
  console.log("\n  final homepage order:");
  for (const b of final) console.log(`    #${b.position} ${b.key} [${b.status}]`);
}

run()
  .then(() => console.log("\nDone."))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
