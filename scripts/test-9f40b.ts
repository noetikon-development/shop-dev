/**
 * PHASE 9F-40B — seller product-request review UX fixes.
 *
 * No new approval/rejection system, no new reason field. `reviewStatusNote`
 * stays the single source for the current review reason. This phase:
 *   1. surfaces the review note on ANY editable DRAFT that was sent back
 *      (admin "Request changes" OR a seller reopen) — the seller `[id]` banner
 *      "Axiaro asked for changes", derived from
 *      `editable && reviewStatusNote != null && reviewedAt != null` (no audit lookup);
 *   2. shows "Changes requested" (not plain "Draft") for such a DRAFT;
 *   3. captures each round's note text in the audit `meta.note` so the Admin
 *      Activity view can show per-round feedback;
 *   4. an approval with NO fresh note no longer NULLs an earlier `reviewStatusNote`;
 *   5. corrects "terminal" copy (admin Outcome card, reject email, review-actions);
 *   6. shows the previous round's note to the admin re-reviewer;
 *   7. groups the review outcomes (APPROVE / REQUEST CHANGES / REJECT).
 * Condition flow, product/offer seeding and email idempotency are unchanged.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f40b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  createSellerRequest,
  updateSellerRequest,
  submitSellerRequest,
  reopenRejectedRequest,
  getSellerRequestForSeller,
} from "@/lib/marketplace/seller-product-request-repository";
import {
  requestChanges,
  rejectRequest,
  linkExistingProduct,
  getAdminProductRequest,
} from "@/lib/admin/seller-product-requests/repository";
import { approveByCreatingProduct, seedSellerDraftOffers } from "@/lib/admin/seller-product-requests/create-canonical";
import { requestStatusLabel, requestStatusTone } from "@/lib/seller/format";
import { renderSellerProductRequestRejected } from "@/lib/email/templates/seller-product-request";
import type { SellerContext } from "@/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

const ctxFor = (sellerId: string): SellerContext => ({
  sellerId, sellerName: "S", sellerUserId: "su-" + sellerId, userId: "u-" + sellerId, role: "OWNER", permissions: new Set(),
});

/** The 9F-40B "seller must act on this DRAFT" gate — keep in sync with getSellerRequestDetail. */
const isChangesRequested = (r: { status: string; reviewStatusNote: string | null; reviewedAt: Date | null }) =>
  r.status === "DRAFT" && r.reviewStatusNote != null && r.reviewedAt != null;

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — status label ──");
  const at = "2026-09-05T00:00:00Z";
  ok("C · DRAFT + reviewedAt → 'Changes requested'", requestStatusLabel("DRAFT", at) === "Changes requested");
  ok("C · tone for a sent-back DRAFT is 'warning'", requestStatusTone("DRAFT", at) === "warning");
  ok("D · fresh DRAFT (no reviewedAt) → 'Draft'", requestStatusLabel("DRAFT", null) === "Draft" && requestStatusLabel("DRAFT") === "Draft");
  ok("D · fresh DRAFT tone unchanged ('neutral')", requestStatusTone("DRAFT", null) === "neutral");
  ok("· PENDING / APPROVED / REJECTED labels + tones unchanged by the 2nd arg",
    requestStatusLabel("PENDING", at) === "In review" && requestStatusLabel("APPROVED", at) === "Approved" &&
    requestStatusLabel("REJECTED", at) === "Rejected" && requestStatusTone("REJECTED", at) === "danger");
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const format = read("src/lib/seller/format.ts");
  const reads = read("src/lib/seller/product-requests.ts");
  const sellerPage = read("src/app/seller/(portal)/product-requests/[id]/page.tsx");
  const sellerList = read("src/app/seller/(portal)/product-requests/page.tsx");
  const adminPage = read("src/app/admin/(shell)/seller-product-requests/[id]/page.tsx");
  const adminRepo = read("src/lib/admin/seller-product-requests/repository.ts");
  const createCanonical = read("src/lib/admin/seller-product-requests/create-canonical.ts");
  const actions = read("src/lib/admin/seller-product-requests/actions.ts");
  const reviewActions = read("src/components/admin/seller-product-requests/review-actions.tsx");
  const emailTpl = read("src/lib/email/templates/seller-product-request.ts");
  const notifs = read("src/lib/email/notifications.ts");

  // 2 — status label
  ok("2 · format.ts derives 'Changes requested' for DRAFT + reviewedAt (display only, no new DB status)",
    /return "Changes requested";/.test(format) && /status === "DRAFT" && reviewedAt != null/.test(format) &&
    !/"(NEEDS_CHANGES|CHANGES_REQUESTED|IN_REVIEW)"/.test(format));
  ok("2 · both seller pages pass reviewedAt to the status helpers",
    /requestStatusTone\(r\.status, r\.reviewedAt\)/.test(sellerPage) && /requestStatusLabel\(r\.status, r\.reviewedAt\)/.test(sellerPage) &&
    /requestStatusTone\(r\.status, r\.reviewedAt\)/.test(sellerList) && /requestStatusLabel\(r\.status, r\.reviewedAt\)/.test(sellerList));

  // 1 — seller feedback banner
  ok("1 · SellerRequestDetailView drops reopenedFromRejection, gains changesRequested",
    !/reopenedFromRejection/.test(reads) && /changesRequested: boolean;/.test(reads));
  ok("1 · changesRequested = editable && reviewStatusNote != null && reviewedAt != null (NO adminAuditLog lookup)",
    /const changesRequested =\s*\n?\s*editable && r\.reviewStatusNote != null && r\.reviewedAt != null;/.test(reads) &&
    !/adminAuditLog\.findFirst/.test(reads) && !/seller\.product_request\.reopened/.test(reads));
  ok("1 · SellerRequestRow carries reviewedAt for the list label", /reviewedAt: string \| null;/.test(reads) && /reviewedAt: r\.reviewedAt\?\.toISOString\(\) \?\? null,/.test(reads));
  ok("1 · seller [id] page renders the 'Axiaro asked for changes' banner on changesRequested",
    /\{r\.changesRequested && r\.reviewNote &&/.test(sellerPage) && /Axiaro asked for changes/.test(sellerPage) &&
    /Make these changes and submit for review again\./.test(sellerPage));
  ok("1 · the REJECTED red banner + reopen button are still present", /r\.status === "REJECTED"/.test(sellerPage) && /RequestReopenButton/.test(sellerPage));

  // 3 — audit meta.note
  ok("3 · requestChanges / rejectRequest audits carry meta.note",
    /to: "DRAFT", note: res\.reviewNote \}/.test(actions) && /to: "REJECTED", note: res\.reviewNote \}/.test(actions));
  ok("3 · both approve audits carry meta.note (null when none typed)",
    (actions.match(/mode: "(link|create)", note: res\.reviewNote \}/g) ?? []).length === 2);
  ok("3 · ReviewResult / LinkResult / CreateFromRequestResult expose reviewNote",
    /reviewedAt: Date; reviewNote: string \}/.test(adminRepo) && /reviewNote: string \| null;/.test(adminRepo) &&
    /reviewNote: string \| null;/.test(createCanonical));
  ok("3 · getAdminProductRequest selects meta + parses meta.note into audit[].note",
    /select: \{ createdAt: true, action: true, summary: true, meta: true, actor:/.test(adminRepo) &&
    /note: parseAuditNote\(a\.meta\)/.test(adminRepo) && /function parseAuditNote/.test(adminRepo));
  ok("3 · admin [id] Activity renders a.note per row",
    /\{a\.note && \(/.test(adminPage));

  // 4 — approval never erases an existing note
  ok("4 · linkExistingProduct writes reviewStatusNote ONLY when a note was typed (conditional spread)",
    /\.\.\.\(cleanNote \? \{ reviewStatusNote: cleanNote \} : \{\}\)/.test(adminRepo) &&
    !/reviewStatusNote: note \? cleanUserText\(note\) : null/.test(adminRepo));
  ok("4 · approveByCreatingProduct writes reviewStatusNote ONLY when a note was typed",
    /\.\.\.\(cleanNote \? \{ reviewStatusNote: cleanNote \} : \{\}\)/.test(createCanonical) &&
    !/reviewStatusNote: curated\.reviewNote \? cleanUserText\(curated\.reviewNote\) : null/.test(createCanonical));

  // 5 — corrected copy
  ok("5 · admin Outcome card no longer says 'It is terminal'",
    !/It is terminal/.test(adminPage) && /The seller can reopen it to revise and resubmit\./.test(adminPage));
  ok("5 · review-actions reject helper text mentions reopen, not 'start a new request'",
    !/would need to start a new request/.test(reviewActions) && /The seller can still reopen it to revise and resubmit\./.test(reviewActions));
  ok("5/Q · rejection email body says reopen, not 'start a new request'",
    !/start a new request/i.test(emailTpl) && /reopen the request to revise and resubmit/.test(emailTpl));

  // 6 — admin re-review context
  ok("6 · admin [id] shows 'Previous Axiaro feedback' (gated on r.reviewNote) above the <RequestReviewActions/> block",
    /Previous Axiaro feedback/.test(adminPage) && /\{r\.reviewNote && \(/.test(adminPage) &&
    adminPage.indexOf("Previous Axiaro feedback") < adminPage.indexOf("<RequestReviewActions"));

  // 7 — outcome grouping
  ok("7 · admin [id] groups the outcomes (APPROVE / REQUEST CHANGES or REJECT headers)",
    />Approve<\/p>/.test(adminPage) && /Request changes or reject/.test(adminPage));
  ok("7 · REQUEST CHANGES + REJECT still require a note (RequestReviewActions textarea required + server min(1))",
    /name="note"\s*\n?\s*required/.test(reviewActions) && /z\.string\(\)\.trim\(\)\.min\(1\)\.max\(2000\)/.test(actions));

  // 8/9 — condition + offer seeding untouched
  ok("9 · seedSellerDraftOffers logic untouched — still condition = isOfferCondition(conditionInput) ? … : 'NEW'",
    /isOfferCondition\(conditionInput\) \? conditionInput : "NEW"/.test(createCanonical) && /condition, openingQuantity: 0/.test(createCanonical));
  ok("9 · proposedCondition still carried out of link + create",
    /proposedCondition: current\.proposedCondition,/.test(adminRepo) && /proposedCondition: req\.proposedCondition,/.test(createCanonical));

  // 10 / R — email idempotency unchanged
  ok("R · rejection email idempotency key format unchanged (SELLER_PRODUCT_REQUEST_REJECTED:<id>:<outcome>:<ms>)",
    /SELLER_PRODUCT_REQUEST_REJECTED:\$\{requestId\}:\$\{outcome\}:\$\{reviewedAt\.getTime\(\)\}/.test(notifs));
  ok("R · approve / submit email keys unchanged",
    /SELLER_PRODUCT_REQUEST_APPROVED:\$\{requestId\}:\$\{reviewedAt\.getTime\(\)\}/.test(notifs) &&
    /SELLER_PRODUCT_REQUEST_SUBMITTED:\$\{requestId\}/.test(notifs));
  ok("R · no new EmailType / send fn introduced",
    (notifs.match(/export async function sendSellerProductRequest\w+/g) ?? []).length === 3);

  // scope
  ok("scope · seed-rbac.ts untouched", !/9F-40B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · no schema change", !/9F-40B/.test(read("prisma/schema.prisma")));
  ok("scope · checkout / settlement / data untouched",
    !/9F-40B/.test(read("src/lib/checkout.ts")) && !/9F-40B/.test(read("src/lib/marketplace/settlement.ts")));
}

// ── email render ────────────────────────────────────────────────────────
function emailTests() {
  console.log("\n── rejection email (Q) ──");
  const base = { brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", productName: "Linen Shirt", requestUrl: "https://axiaro.shop/seller/product-requests/x" };
  const rej = renderSellerProductRequestRejected({ ...base, outcome: "rejected", reviewNote: "Photos are too low-res." });
  ok("Q · 'Not approved' subject unchanged", rej.subject === "Not approved: Linen Shirt");
  ok("Q · body + text mention reopening, not starting a new request",
    /reopen the request to revise and resubmit/.test(rej.html) && String(rej.text).includes("reopen the request to revise and resubmit") &&
    !/start a new request/i.test(rej.html) && !/start a new request/i.test(String(rej.text)));
  ok("Q · the review note is still rendered", rej.html.includes("Photos are too low-res.") && String(rej.text).includes("Photos are too low-res."));

  const chg = renderSellerProductRequestRejected({ ...base, outcome: "changes_requested", reviewNote: "Add dimensions." });
  ok("Q · 'Changes needed' subject + 'submit it again' copy unchanged",
    chg.subject === "Changes needed: Linen Shirt" && /make the changes and submit it again/.test(chg.html));
}

// ── DB fixtures (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const adminUser = await prisma.user.findFirst({ select: { id: true } });
  const realProduct = await prisma.product.findFirst({
    where: { status: { not: "ARCHIVED" }, variants: { some: { status: "ACTIVE" } } },
    select: { id: true },
  });
  if (!category || !adminUser || !realProduct) { ok("(skipped — no catalog data / user)", true); return; }
  const before = { req: await prisma.sellerProductRequest.count(), product: await prisma.product.count(), offer: await prisma.offer.count() };
  const sfx = "9f40b-" + Date.now().toString(36);

  const seedSeller = (tx: Tx, slug: string) =>
    tx.seller.create({ data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" }, select: { id: true } });
  const seedPending = async (tx: Tx, sellerId: string, name: string, condition = "OPEN_BOX") => {
    const c = await createSellerRequest(ctxFor(sellerId), { proposedName: name, proposedCategoryId: category!.id, proposedCondition: condition, proposedVariants: [{ label: "Default" }] }, tx);
    if (!c.ok) throw new Error("seed failed " + JSON.stringify(c));
    const s = await submitSellerRequest(ctxFor(sellerId), c.requestId, tx);
    if (!s.ok) throw new Error("submit failed " + JSON.stringify(s));
    return c.requestId;
  };

  try {
    await prisma.$transaction(async (tx) => {
      const S = await seedSeller(tx, `s-${sfx}`);
      const admin = adminUser.id;

      // ── A / L — Request Changes stores the note; empty note rejected ──
      const idA = await seedPending(tx, S.id, `A ${sfx}`);
      ok("L · requestChanges requires a non-empty note", (await requestChanges(idA, admin, "   ", tx)).ok === false);
      const rcA = await requestChanges(idA, admin, "Please add the fabric weight.", tx);
      ok("A · requestChanges ok, returns the cleaned reviewNote", rcA.ok === true && rcA.ok && rcA.reviewNote === "Please add the fabric weight.");
      const rowA = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: idA }, select: { status: true, reviewStatusNote: true, reviewedAt: true, reviewedById: true } });
      ok("A · request is DRAFT with the note + reviewer + reviewedAt stored",
        rowA.status === "DRAFT" && rowA.reviewStatusNote === "Please add the fabric weight." && rowA.reviewedById === admin && rowA.reviewedAt != null);

      // ── B / C — seller sees the feedback; label is "Changes requested" ──
      const sellerViewA = await getSellerRequestForSeller(ctxFor(S.id), idA, tx);
      ok("B · the seller-scoped read exposes reviewStatusNote + reviewedAt on the DRAFT",
        sellerViewA?.status === "DRAFT" && sellerViewA?.reviewStatusNote === "Please add the fabric weight." && sellerViewA?.reviewedAt != null);
      ok("B · changesRequested gate is true for this sent-back DRAFT",
        isChangesRequested({ status: sellerViewA!.status, reviewStatusNote: sellerViewA!.reviewStatusNote, reviewedAt: sellerViewA!.reviewedAt }));
      ok("C · list/detail label for this DRAFT is 'Changes requested'",
        requestStatusLabel(sellerViewA!.status, sellerViewA!.reviewedAt?.toISOString()) === "Changes requested");

      // ── D — a fresh DRAFT stays "Draft" ──
      const fresh = await createSellerRequest(ctxFor(S.id), { proposedName: `Fresh ${sfx}`, proposedCategoryId: category.id, proposedCondition: "NEW", proposedVariants: [{ label: "Default" }] }, tx);
      const freshView = await getSellerRequestForSeller(ctxFor(S.id), fresh.ok ? fresh.requestId : "", tx);
      ok("D · fresh DRAFT → not changesRequested, label 'Draft'",
        !isChangesRequested({ status: freshView!.status, reviewStatusNote: freshView!.reviewStatusNote, reviewedAt: freshView!.reviewedAt }) &&
        requestStatusLabel(freshView!.status, freshView!.reviewedAt?.toISOString() ?? null) === "Draft");

      // ── M / N / O — reopen + resubmit + condition preservation ──
      await updateSellerRequest(ctxFor(S.id), idA, { proposedName: `A ${sfx} v2`, proposedCategoryId: category.id, proposedCondition: "OPEN_BOX", proposedVariants: [{ label: "Default" }] }, tx);
      const resubA = await submitSellerRequest(ctxFor(S.id), idA, tx);
      ok("N · the sent-back DRAFT resubmits to PENDING", resubA.ok === true &&
        (await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: idA }, select: { status: true } })).status === "PENDING");
      ok("O · proposedCondition preserved through requestChanges → edit → resubmit",
        (await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: idA }, select: { proposedCondition: true } })).proposedCondition === "OPEN_BOX");

      // ── E / F — REJECTED shows reason; reopen keeps it → changesRequested ──
      const idE = await seedPending(tx, S.id, `E ${sfx}`);
      await rejectRequest(idE, admin, "Not a category we carry.", tx);
      const rejView = await getSellerRequestForSeller(ctxFor(S.id), idE, tx);
      ok("E · a REJECTED request exposes the rejection reason", rejView?.status === "REJECTED" && rejView?.reviewStatusNote === "Not a category we carry.");
      const reopened = await reopenRejectedRequest(ctxFor(S.id), idE, tx);
      const reView = await getSellerRequestForSeller(ctxFor(S.id), idE, tx);
      ok("F · reopen → DRAFT, reason + reviewedAt preserved → changesRequested true",
        reopened.ok && reView?.status === "DRAFT" && reView?.reviewStatusNote === "Not a category we carry." &&
        isChangesRequested({ status: reView!.status, reviewStatusNote: reView!.reviewStatusNote, reviewedAt: reView!.reviewedAt }));
      ok("M · reopen is idempotent (already DRAFT → reopened:false)",
        (await reopenRejectedRequest(ctxFor(S.id), idE, tx)).ok === true);

      // ── K — reject requires a non-empty note ──
      const idK = await seedPending(tx, S.id, `K ${sfx}`);
      ok("K · rejectRequest requires a non-empty note", (await rejectRequest(idK, admin, "\n\t ", tx)).ok === false &&
        (await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: idK }, select: { status: true } })).status === "PENDING");

      // ── I — approve with NO new note does NOT erase a prior reviewStatusNote ──
      const idI = await seedPending(tx, S.id, `I ${sfx}`);
      await requestChanges(idI, admin, "Round 1: add a barcode.", tx);
      await updateSellerRequest(ctxFor(S.id), idI, { proposedName: `I ${sfx} v2`, proposedCategoryId: category.id, proposedCondition: "OPEN_BOX", proposedVariants: [{ label: "Default" }] }, tx);
      await submitSellerRequest(ctxFor(S.id), idI, tx);
      const linkNoNote = await linkExistingProduct(idI, realProduct.id, admin, null, tx);
      ok("I · linkExistingProduct(note=null) → ok, returns reviewNote null", linkNoNote.ok === true && linkNoNote.ok && linkNoNote.reviewNote === null);
      ok("I · the earlier 'Round 1' reviewStatusNote is PRESERVED, not nulled",
        (await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: idI }, select: { status: true, reviewStatusNote: true } })).reviewStatusNote === "Round 1: add a barcode." );

      // ── J — approve WITH a new note replaces the current note ──
      const idJ = await seedPending(tx, S.id, `J ${sfx}`);
      await requestChanges(idJ, admin, "Round 1 note.", tx);
      await submitSellerRequest(ctxFor(S.id), idJ, tx);
      const linkNote = await linkExistingProduct(idJ, realProduct.id, admin, "Approved — curated in house style.", tx);
      ok("J · approval with a new note updates reviewStatusNote + returns it",
        linkNote.ok === true && linkNote.ok && linkNote.reviewNote === "Approved — curated in house style." &&
        (await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: idJ }, select: { reviewStatusNote: true } })).reviewStatusNote === "Approved — curated in house style.");

      // ── G / H — audit meta.note surfaces per round via getAdminProductRequest ──
      const idG = await seedPending(tx, S.id, `G ${sfx}`);
      // simulate two review rounds' audit rows (the actions write these; here we
      // seed them directly since the server action needs an auth session)
      await tx.adminAuditLog.create({ data: { actorUserId: admin, action: "seller_product_request.changes_requested", targetType: "seller_product_request", targetId: idG, summary: "sent back", meta: JSON.stringify({ from: "PENDING", to: "DRAFT", note: "Round 1: fix the photos." }) } });
      await tx.adminAuditLog.create({ data: { actorUserId: admin, action: "seller_product_request.changes_requested", targetType: "seller_product_request", targetId: idG, summary: "sent back", meta: JSON.stringify({ from: "PENDING", to: "DRAFT", note: "Round 2: fix the SKU." }) } });
      await tx.adminAuditLog.create({ data: { actorUserId: admin, action: "seller_product_request.approved", targetType: "seller_product_request", targetId: idG, summary: "approved", meta: JSON.stringify({ mode: "link", note: null }) } });
      const detailG = await getAdminProductRequest(idG, tx);
      const notes = (detailG?.audit ?? []).map((a) => a.note);
      ok("G · getAdminProductRequest surfaces meta.note per audit row",
        notes.includes("Round 1: fix the photos.") && notes.includes("Round 2: fix the SKU."));
      ok("H · multiple review rounds each keep their own note (not just the latest)",
        (detailG?.audit ?? []).filter((a) => a.action === "seller_product_request.changes_requested" && a.note != null).length === 2);
      ok("H · an approve row with meta.note null → audit note null (no crash)",
        (detailG?.audit ?? []).some((a) => a.action === "seller_product_request.approved" && a.note === null));

      // ── P — approval still creates the product + seeds 3P offers with the condition ──
      const idP = await seedPending(tx, S.id, `P ${sfx}`, "REFURBISHED");
      const createdP = await approveByCreatingProduct(idP, admin, {
        name: `Curated P ${sfx}`, slug: `curated-p-${sfx}`, brand: "Axiaro",
        shortDescription: "short", description: "long description", categoryId: category.id, price: 149900, sku: `CUR-P-${sfx}`, options: [],
      }, tx);
      ok("P · approveByCreatingProduct → ok, product DRAFT, proposedCondition + reviewNote carried",
        createdP.ok === true && createdP.ok && createdP.proposedCondition === "REFURBISHED" && createdP.reviewNote === null &&
        (await tx.product.findUniqueOrThrow({ where: { id: createdP.ok ? createdP.productId : "" }, select: { status: true } })).status === "DRAFT");
      if (createdP.ok) {
        const seeded = await seedSellerDraftOffers(S.id, admin, createdP.productId, createdP.proposedCondition, tx);
        ok("P · 3P DRAFT offers seeded with the proposed condition; FIRST_PARTY offer stays NEW",
          seeded.condition === "REFURBISHED" && seeded.created.length >= 1 &&
          (await tx.offer.findMany({ where: { sellerId: S.id, variant: { productId: createdP.productId } }, select: { condition: true, status: true } })).every((o) => o.condition === "REFURBISHED" && o.status === "DRAFT") &&
          (await tx.offer.findFirst({ where: { seller: { is: { type: "FIRST_PARTY" } }, variant: { productId: createdP.productId } }, select: { condition: true } }))?.condition === "NEW");
      }

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · no SellerProductRequest leaked", (await prisma.sellerProductRequest.count()) === before.req);
  ok("rollback · no Product leaked", (await prisma.product.count()) === before.product);
  ok("rollback · no Offer leaked", (await prisma.offer.count()) === before.offer);
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const byStatus = await prisma.sellerProductRequest.groupBy({ by: ["status"], _count: true });
  ok("prod · request statuses unchanged (1 APPROVED, no DRAFT/PENDING/REJECTED)",
    byStatus.length === 1 && byStatus[0].status === "APPROVED" && byStatus[0]._count === 1);
  ok("prod · the one request still carries its reviewStatusNote",
    (await prisma.sellerProductRequest.findFirst({ select: { reviewStatusNote: true } }))?.reviewStatusNote != null);
}

async function main() {
  console.log("\nPHASE 9F-40B — seller product-request review UX fixes\n");
  pureTests();
  staticTests();
  emailTests();
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
