/**
 * PHASE 9F-26A — G7: reopen a REJECTED seller product request.
 *
 * `reopenRejectedRequest(ctx, requestId, tx?)` moves the seller's OWN request
 * REJECTED → DRAFT so they can revise it and resubmit via the normal
 * `submitSellerRequest` (DRAFT → PENDING) flow. Proposal, images and the
 * rejection feedback (`reviewStatusNote` / `reviewedById` / `reviewedAt`) are all
 * preserved. Scoped to `ctx.sellerId`. No new request row. Admin-side REJECTED
 * stays terminal; APPROVED / "request changes" flows unchanged.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f26a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  createSellerRequest,
  updateSellerRequest,
  submitSellerRequest,
  reopenRejectedRequest,
  getSellerRequestForSeller,
  parseProposal,
} from "@/lib/marketplace/seller-product-request-repository";
import { requestChanges, rejectRequest, linkExistingProduct } from "@/lib/admin/seller-product-requests/repository";
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
  sellerId,
  sellerName: "S",
  sellerUserId: "su-" + sellerId,
  userId: "u-" + sellerId,
  role: "OWNER",
  permissions: new Set(),
});

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-product-request-repository.ts");
  const actions = read("src/lib/seller/product-request-actions.ts");
  const reads = read("src/lib/seller/product-requests.ts");
  const page = read("src/app/seller/(portal)/product-requests/[id]/page.tsx");
  const btn = read("src/components/seller/request-reopen-button.tsx");
  const adminRepo = read("src/lib/admin/seller-product-requests/repository.ts");

  ok("repo · exports reopenRejectedRequest(ctx, requestId, tx?)",
    /export async function reopenRejectedRequest\(\s*\n\s*ctx: SellerContext,\s*\n\s*requestId: string,\s*\n\s*externalTx\?: Prisma\.TransactionClient,\s*\n\s*\)/.test(repo));
  ok("repo · REJECTED → DRAFT only (non-REJECTED, non-DRAFT → LOCKED)",
    /if \(current\.status === "DRAFT"\) return \{ ok: true, reopened: false \};\s*\n\s*if \(current\.status !== "REJECTED"\) \{/.test(repo));
  ok("repo · status-guarded updateMany sets DRAFT only",
    /where: \{ id: requestId, sellerId: ctx\.sellerId, status: current\.status \},\s*\n\s*data: \{ status: "DRAFT" \},/.test(repo));
  ok("repo · scoped to ctx.sellerId (wrong seller → NOT_FOUND)",
    /where: \{ id: requestId, sellerId: ctx\.sellerId \},\s*\n\s*select: \{ id: true, status: true \},/.test(repo));
  ok("repo · CONFLICT on a lost race (count === 0)", /if \(reopened\.count === 0\) \{/.test(repo));
  ok("repo · submitSellerRequest guard unchanged (a REJECTED request still can't be submitted directly)",
    /if \(current\.status !== "DRAFT"\) \{\s*\n\s*if \(current\.status === "PENDING"\) return \{ ok: true, warnings: \[\] \};\s*\n\s*return \{ ok: false, code: "LOCKED", error: `A \$\{current\.status\.toLowerCase\(\)\} request can't be submitted\.` \};/.test(repo));
  ok("repo · never writes status APPROVED / REJECTED (9F-5b invariant still holds)",
    !/status["\s:]+["'](APPROVED|REJECTED)/.test(repo));

  ok("actions · reopenRequestAction requires the seller session permission",
    /export async function reopenRequestAction\([\s\S]{0,220}requireSellerSessionPermission\("manage_offers"\)/.test(actions));
  ok("actions · one audit row on a real reopen, matching the submit-action pattern",
    /if \(res\.reopened\) \{\s*\n\s*await writeAudit\(\{[\s\S]{0,260}action: "seller\.product_request\.reopened",/.test(actions));
  ok("actions · no email on reopen (self-service, like saving a draft)",
    !/scheduleEmail[\s\S]{0,120}reopen/i.test(actions) &&
    (() => {
      const m = actions.match(/export async function reopenRequestAction[\s\S]*?\n\}/);
      return !!m && !/scheduleEmail/.test(m[0]);
    })());
  ok("actions · never writes an APPROVED / REJECTED status literal",
    !/["'](APPROVED|REJECTED)["']/.test(actions));
  ok("actions · action count === requireSellerSessionPermission count (all gated)",
    (actions.match(/export async function \w+Action/g) ?? []).length === (actions.match(/requireSellerSessionPermission\(/g) ?? []).length);

  ok("reads · SellerRequestDetailView gains canReopen + reopenedFromRejection",
    /canReopen: boolean;/.test(reads) && /reopenedFromRejection: boolean;/.test(reads));
  ok("reads · canReopen === (status REJECTED)", /const canReopen = r\.status === "REJECTED";/.test(reads));
  ok("reads · reopenedFromRejection = DRAFT + review note + a reopen audit row",
    /action: "seller\.product_request\.reopened",/.test(reads) && /editable && r\.reviewStatusNote != null/.test(reads));
  ok("reads · never writes any catalog / offer / inventory row",
    !/\b(product|variant|category|offer|offerInventory|inventory)\.(create|update|delete|upsert|updateMany|deleteMany)/i.test(reads));

  ok("ui · REJECTED shows the RequestReopenButton (canReopen)",
    /\{r\.canReopen && <RequestReopenButton requestId=\{r\.id\} \/>\}/.test(page));
  ok("ui · button label is 'Revise and resubmit'", /Revise and resubmit/.test(btn) && /reopenRequestAction/.test(btn));
  ok("ui · reopened DRAFT keeps the rejection feedback visible",
    /\{r\.reopenedFromRejection && r\.reviewNote &&/.test(page));
  ok("ui · stale 'Start a new request' copy removed", !/Start a new request/.test(page));

  ok("scope · no schema change", !/9F-26A/.test(read("prisma/schema.prisma")));
  ok("scope · seed-rbac.ts not marked / touched", !/9F-26A/.test(read("scripts/seed-rbac.ts")));
  ok("scope · admin repo REJECTED still terminal (advanceFromPending requires PENDING)",
    /if \(current\.status !== "PENDING"\) \{/.test(adminRepo) && !/9F-26A/.test(adminRepo));
  ok("scope · storefront / checkout / offer logic untouched",
    !/9F-26A/.test(read("src/lib/checkout.ts")) && !/9F-26A/.test(read("src/lib/data.ts")) &&
    !/9F-26A/.test(read("src/lib/admin/seller-product-requests/create-canonical.ts")));
}

// ── DB behaviour (rolled back) ───────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const adminUser = await prisma.user.findFirst({ select: { id: true } });
  const realProduct = await prisma.product.findFirst({ where: { status: { not: "ARCHIVED" } }, select: { id: true, slug: true } });
  if (!category || !adminUser || !realProduct) return ok("(skipped — no catalog data / user)", true);
  const sfx = "9f26a-" + Date.now().toString(36);
  const before = await prisma.sellerProductRequest.count();

  async function seedSeller(tx: Tx, slug: string) {
    return tx.seller.create({
      data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
      select: { id: true },
    });
  }
  async function seedRejected(tx: Tx, sellerId: string, name: string) {
    const created = await createSellerRequest(
      ctxFor(sellerId),
      { proposedName: name, proposedCategoryId: category!.id, proposedVariants: [{ label: "Small" }, { label: "Large" }], sellerNote: "please" },
      tx,
    );
    if (!created.ok) throw new Error("seed create failed: " + JSON.stringify(created));
    await tx.sellerProductRequest.update({
      where: { id: created.requestId },
      data: { status: "REJECTED", reviewStatusNote: "Add real dimensions and a clearer photo.", reviewedById: adminUser!.id, reviewedAt: new Date("2026-09-01T00:00:00Z"), submittedAt: new Date("2026-08-31T00:00:00Z") },
    });
    return created.requestId;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const A = await seedSeller(tx, `a26a-${sfx}`);
      const B = await seedSeller(tx, `b26a-${sfx}`);

      // ── REJECTED → DRAFT ──
      {
        const id = await seedRejected(tx, A.id, `Widget ${sfx}`);
        const rowBefore = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id }, select: { proposedName: true, proposedVariants: true, reviewStatusNote: true, reviewedById: true, reviewedAt: true } });
        const res = await reopenRejectedRequest(ctxFor(A.id), id, tx);
        const rowAfter = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id }, select: { status: true, proposedName: true, proposedVariants: true, reviewStatusNote: true, reviewedById: true, reviewedAt: true } });
        ok("REJECTED → DRAFT · reopen ok, status now DRAFT", res.ok && "reopened" in res && res.reopened === true && rowAfter.status === "DRAFT");
        ok("HISTORY · reviewStatusNote / reviewedById / reviewedAt preserved",
          rowAfter.reviewStatusNote === rowBefore.reviewStatusNote &&
          rowAfter.reviewedById === rowBefore.reviewedById &&
          JSON.stringify(rowAfter.reviewedAt) === JSON.stringify(rowBefore.reviewedAt));
        ok("HISTORY · proposal (name + variants) preserved",
          rowAfter.proposedName === rowBefore.proposedName &&
          parseProposal(rowAfter.proposedVariants).variants.length === 2);
        ok("NO DUPLICATE · request count unchanged (same row, no new request)",
          (await tx.sellerProductRequest.count({ where: { sellerId: A.id } })) === 1);

        // ── EDIT AFTER REJECTION ──
        const edited = await updateSellerRequest(
          ctxFor(A.id), id,
          { proposedName: `Widget ${sfx} revised`, proposedCategoryId: category!.id, proposedVariants: [{ label: "One size" }] },
          tx,
        );
        const editedRow = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id }, select: { proposedName: true, reviewStatusNote: true } });
        ok("EDIT AFTER REJECTION · updateSellerRequest ok on the reopened DRAFT", edited.ok === true);
        ok("EDIT AFTER REJECTION · edit persisted, rejection note still there",
          editedRow.proposedName === `Widget ${sfx} revised` && editedRow.reviewStatusNote === "Add real dimensions and a clearer photo.");

        // ── DRAFT → PENDING ──
        const submitted = await submitSellerRequest(ctxFor(A.id), id, tx);
        const submittedRow = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id }, select: { status: true, submittedAt: true } });
        ok("DRAFT → PENDING · resubmit ok, status PENDING, submittedAt re-stamped",
          submitted.ok === true && submittedRow.status === "PENDING" && (submittedRow.submittedAt?.getTime() ?? 0) > new Date("2026-09-01T00:00:00Z").getTime());
      }

      // ── AUTHORIZATION ──
      {
        const id = await seedRejected(tx, A.id, `Auth ${sfx}`);
        const wrong = await reopenRejectedRequest(ctxFor(B.id), id, tx);
        ok("AUTHORIZATION · seller B cannot reopen seller A's request (NOT_FOUND)", !wrong.ok && "code" in wrong && wrong.code === "NOT_FOUND");
        const stillRejected = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id }, select: { status: true } });
        ok("AUTHORIZATION · A's request untouched by B", stillRejected.status === "REJECTED");
        const wrongEdit = await updateSellerRequest(ctxFor(B.id), id, { proposedName: "x y", proposedVariants: [{ label: "d" }] }, tx);
        ok("AUTHORIZATION · seller B cannot edit it either (NOT_FOUND)", !wrongEdit.ok && "code" in wrongEdit && wrongEdit.code === "NOT_FOUND");
        ok("AUTHORIZATION · getSellerRequestForSeller(B, A's id) → null", (await getSellerRequestForSeller(ctxFor(B.id), id, tx)) === null);
      }

      // ── only REJECTED is reopenable ──
      {
        const id = await seedRejected(tx, A.id, `Lock ${sfx}`);
        await reopenRejectedRequest(ctxFor(A.id), id, tx); // → DRAFT
        const noop = await reopenRejectedRequest(ctxFor(A.id), id, tx); // already DRAFT
        ok("IDEMPOTENT · reopening a DRAFT request → ok, reopened:false (no-op)", noop.ok === true && "reopened" in noop && noop.reopened === false);

        await tx.sellerProductRequest.update({ where: { id }, data: { status: "PENDING" } });
        const lockedPending = await reopenRejectedRequest(ctxFor(A.id), id, tx);
        ok("LOCKED · a PENDING request can't be reopened", !lockedPending.ok && "code" in lockedPending && lockedPending.code === "LOCKED");

        await tx.sellerProductRequest.update({ where: { id }, data: { status: "APPROVED" } });
        const lockedApproved = await reopenRejectedRequest(ctxFor(A.id), id, tx);
        ok("LOCKED · an APPROVED request can't be reopened", !lockedApproved.ok && "code" in lockedApproved && lockedApproved.code === "LOCKED");
      }

      // ── existing admin flows unchanged ──
      {
        // REQUEST_CHANGES: PENDING → DRAFT still works, seller resubmits
        const rc = await createSellerRequest(ctxFor(A.id), { proposedName: `RC ${sfx}`, proposedCategoryId: category!.id, proposedVariants: [{ label: "d" }] }, tx);
        if (!rc.ok) throw new Error("rc seed");
        await submitSellerRequest(ctxFor(A.id), rc.requestId, tx);
        const changed = await requestChanges(rc.requestId, adminUser!.id, "Please add a brand.", tx);
        const rcRow = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: rc.requestId }, select: { status: true, reviewStatusNote: true } });
        ok("REQUEST_CHANGES · PENDING → DRAFT unchanged (note stored, seller can edit)", changed.ok === true && rcRow.status === "DRAFT" && rcRow.reviewStatusNote === "Please add a brand.");
        const rcResubmit = await submitSellerRequest(ctxFor(A.id), rc.requestId, tx);
        ok("REQUEST_CHANGES · seller can resubmit the returned DRAFT", rcResubmit.ok === true);

        // ADMIN REJECT still terminal (admin plane)
        const rej = await createSellerRequest(ctxFor(A.id), { proposedName: `Rej ${sfx}`, proposedCategoryId: category!.id, proposedVariants: [{ label: "d" }] }, tx);
        if (!rej.ok) throw new Error("rej seed");
        await submitSellerRequest(ctxFor(A.id), rej.requestId, tx);
        await rejectRequest(rej.requestId, adminUser!.id, "No.", tx);
        ok("ADMIN REJECT · still terminal on the admin plane (2nd reject / changes / link all fail)",
          (await rejectRequest(rej.requestId, adminUser!.id, "x", tx)).ok === false &&
          (await requestChanges(rej.requestId, adminUser!.id, "x", tx)).ok === false &&
          (await linkExistingProduct(rej.requestId, realProduct!.id, adminUser!.id, null, tx)).ok === false);
        // …but the SELLER can now reopen it (that's the whole point of G7)
        const sellerReopen = await reopenRejectedRequest(ctxFor(A.id), rej.requestId, tx);
        ok("G7 · the owning seller CAN reopen that same admin-rejected request", sellerReopen.ok === true);

        // APPROVED via link still works
        const appr = await createSellerRequest(ctxFor(B.id), { proposedName: `Appr ${sfx}`, proposedCategoryId: category!.id, proposedVariants: [{ label: "d" }] }, tx);
        if (!appr.ok) throw new Error("appr seed");
        await submitSellerRequest(ctxFor(B.id), appr.requestId, tx);
        const linked = await linkExistingProduct(appr.requestId, realProduct!.id, adminUser!.id, null, tx);
        const apprRow = await tx.sellerProductRequest.findUniqueOrThrow({ where: { id: appr.requestId }, select: { status: true, resultProductId: true } });
        ok("APPROVED · link flow unchanged (PENDING → APPROVED, resultProductId set)",
          linked.ok === true && apprRow.status === "APPROVED" && apprRow.resultProductId === realProduct!.id);
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · request count unchanged", (await prisma.sellerProductRequest.count()) === before);
}

// ── production read-only ─────────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const byStatus = await prisma.sellerProductRequest.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("  INFO  SellerProductRequest by status:", JSON.stringify(byStatus));
  ok("prod · only DRAFT/PENDING/APPROVED/REJECTED statuses exist",
    byStatus.every((r) => ["DRAFT", "PENDING", "APPROVED", "REJECTED"].includes(r.status)));
  ok("prod · no leaked 9f26a fixtures", (await prisma.seller.count({ where: { slug: { contains: "9f26a" } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-26A — G7: reopen a REJECTED seller product request\n");
  staticTests();
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
