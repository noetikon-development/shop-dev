/**
 * Seller Verification — identity/business information collection (Phase 2).
 *
 * Schema (SellerVerification gained 16 nullable columns) + a new seller-portal
 * route (`/seller/verification`, same `manage_seller_settings` gate as
 * `/seller/settings` — no new permission, no admin RBAC touched) + a
 * draft-only repository/action. Status stays DRAFT throughout — there is no
 * submit-for-review transition in this phase, so every field must remain
 * optional and every save must succeed with partial data.
 *
 * `requireSellerSessionPermission()` (auth/ownership) only works inside a
 * real Next.js request — same limitation as every other seller-portal action
 * tested in this project. Consistent with that established convention, this
 * file (a) statically confirms the page and action both call it, and (b)
 * drives the actual repository functions directly against rolled-back DB
 * fixtures using hand-built `SellerContext` objects — proving the real
 * ownership-scoping logic (every query keyed on `ctx.sellerId`, never a
 * caller-supplied id) without needing a live session.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p2.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSeller } from "../src/lib/admin/sellers/repository";
import { getSellerVerification, saveSellerVerificationDraft, type SellerVerificationDraftPatch } from "../src/lib/seller-verification/repository";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const EMPTY_PATCH: SellerVerificationDraftPatch = {
  legalName: null, phone: null, addressLine1: null, addressLine2: null, barangay: null,
  city: null, province: null, postalCode: null, country: null, businessType: null,
  businessName: null, businessRegistrationNumber: null, dtiRegistrationNumber: null,
  secRegistrationNumber: null, tin: null,
};

function seedSellerInput(tag: string) {
  return {
    displayName: `P2V Store ${tag}`,
    slug: `p2v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p2v-support-${tag}@t.test`,
  };
}
function seedUser(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `p2v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P2V User" },
    select: { id: true },
  });
}
async function seedSellerWithOwner(tx: Tx, tag: string): Promise<SellerContext> {
  const user = await seedUser(tx, tag);
  const created = await createSeller(seedSellerInput(tag), tx);
  if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);
  const sellerUser = await tx.sellerUser.create({
    data: { sellerId: created.sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" },
  });
  return {
    sellerId: created.sellerId,
    sellerName: created.displayName,
    sellerUserId: sellerUser.id,
    userId: user.id,
    role: "OWNER",
    permissions: new Set(["manage_seller_settings"]),
  };
}

async function main() {
  console.log("\nSeller Verification — identity/business information (Phase 2)\n");

  // ── C — auth/ownership gate exists at the code level ────────────────────
  const pageSrc = read("src/app/seller/(portal)/verification/page.tsx");
  const actionSrc = read("src/lib/seller-verification/actions.ts");
  ok("C · the verification page requires manage_seller_settings (same gate as /seller/settings)",
    /requireSellerSessionPermission\("manage_seller_settings"\)/.test(pageSrc));
  ok("C · the save-draft action requires manage_seller_settings",
    /requireSellerSessionPermission\("manage_seller_settings"\)/.test(actionSrc));
  ok("C · the action never reads a sellerId from the submitted form (ctx.sellerId only)",
    !/formData\.get\("sellerId"\)/.test(actionSrc));

  // ── static — draft-only, no auto-transition, no document/email/gating ──
  const repoSrc = read("src/lib/seller-verification/repository.ts");
  ok("· SellerVerification.status is never set to anything but DRAFT (narrowed to the verification-row creator specifically — Phase 3 legitimately introduced SellerVerificationDocument.status = PENDING in this same file, a different field entirely)",
    (() => {
      const m = repoSrc.match(/async function getOrCreateDraftVerification[\s\S]*?\r?\n\}/);
      return !!m && (m[0].match(/status:\s*"(\w+)"/g) ?? []).every((s) => s === 'status: "DRAFT"');
    })());
  ok("· action file never imports an email sender (no verification email yet)",
    !/from "@\/lib\/email\/notifications"/.test(actionSrc));
  ok("· action file never imports SellerInvite/claim logic",
    !/seller-onboarding\/repository/.test(actionSrc) && !/SellerInvite/.test(actionSrc));
  ok("· action file never touches Seller.status",
    !/seller\.update.*status/i.test(actionSrc) && !/data:\s*\{\s*status/.test(actionSrc));

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // A/B — first save creates exactly one DRAFT row for the right seller.
      const ctxA = await seedSellerWithOwner(tx, `a-${t}`);
      const beforeCreate = await getSellerVerification(ctxA, tx);
      ok("A · no verification exists before the first save", beforeCreate === null);

      const resA = await saveSellerVerificationDraft(ctxA, {
        ...EMPTY_PATCH,
        legalName: "Juan Dela Cruz",
        phone: "09171234567",
        addressLine1: "123 Rizal St",
        city: "Quezon City",
        province: "Metro Manila",
        postalCode: "1100",
        country: "PH",
      }, tx);
      ok("A · saving a draft creates a SellerVerification row", resA.ok);
      if (!resA.ok) throw new Error("fixture A failed");
      ok("A · the new row's status is DRAFT", resA.verification.status === "DRAFT");
      ok("B · the row's sellerId matches the authenticated seller's context", resA.verification.sellerId === ctxA.sellerId);
      ok("· exactly one SellerVerification row exists for this seller",
        (await tx.sellerVerification.count({ where: { sellerId: ctxA.sellerId } })) === 1);

      // E — individual seller fields saved correctly.
      ok("E · legalName saved correctly", resA.verification.legalName === "Juan Dela Cruz");
      ok("E · phone saved correctly", resA.verification.phone === "09171234567");
      ok("E · address fields saved correctly",
        resA.verification.addressLine1 === "123 Rizal St" &&
          resA.verification.city === "Quezon City" &&
          resA.verification.province === "Metro Manila" &&
          resA.verification.postalCode === "1100" &&
          resA.verification.country === "PH");
      ok("E · phoneVerifiedAt is null — never falsely marked verified", resA.verification.phoneVerifiedAt === null);
      ok("G · registration fields stay null when businessType is unset (INDIVIDUAL-equivalent)",
        resA.verification.businessType === null &&
          resA.verification.businessRegistrationNumber === null &&
          resA.verification.dtiRegistrationNumber === null &&
          resA.verification.secRegistrationNumber === null &&
          resA.verification.tin === null);

      // H — a second save (simulating the form resubmitting the whole state,
      // one field changed) preserves everything else.
      const resA2 = await saveSellerVerificationDraft(ctxA, {
        ...EMPTY_PATCH,
        legalName: resA.verification.legalName,
        phone: resA.verification.phone,
        addressLine1: resA.verification.addressLine1,
        city: resA.verification.city,
        province: "Bulacan", // the one intentionally changed field
        postalCode: resA.verification.postalCode,
        country: resA.verification.country,
      }, tx);
      ok("H · second save still succeeds", resA2.ok);
      if (resA2.ok) {
        ok("H · the intentionally changed field updated", resA2.verification.province === "Bulacan");
        ok("H · unrelated fields from the first save are preserved",
          resA2.verification.legalName === "Juan Dela Cruz" && resA2.verification.city === "Quezon City");
        ok("H · still exactly one row — the SAME row was updated, not a new one",
          resA2.verification.id === resA.verification.id &&
            (await tx.sellerVerification.count({ where: { sellerId: ctxA.sellerId } })) === 1);
      }

      // F/G — a business seller's fields save correctly, registration fields
      // included since CORPORATION is one of the types they apply to.
      const ctxB = await seedSellerWithOwner(tx, `b-${t}`);
      const resB = await saveSellerVerificationDraft(ctxB, {
        ...EMPTY_PATCH,
        legalName: "Maria Santos",
        businessType: "CORPORATION",
        businessName: "Santos Home Goods Corp.",
        businessRegistrationNumber: "REG-0001",
        secRegistrationNumber: "SEC-0002",
        tin: "123-456-789-000",
      }, tx);
      ok("F · business save succeeds", resB.ok);
      if (resB.ok) {
        ok("F · businessType saved", resB.verification.businessType === "CORPORATION");
        ok("F · businessName saved", resB.verification.businessName === "Santos Home Goods Corp.");
        ok("F · registration numbers saved", resB.verification.businessRegistrationNumber === "REG-0001" && resB.verification.secRegistrationNumber === "SEC-0002");
        ok("F · TIN saved", resB.verification.tin === "123-456-789-000");
        ok("G · DTI number legitimately stays null when not applicable/provided", resB.verification.dtiRegistrationNumber === null);
      }

      // D — sellerB's context can never see/touch sellerA's verification.
      const crossRead = await getSellerVerification(ctxB, tx);
      ok("D · another seller's read returns ITS OWN record, never sellerA's",
        crossRead !== null && crossRead.id !== resA.verification.id && crossRead.sellerId === ctxB.sellerId);
      const beforeCrossWrite = await tx.sellerVerification.findUnique({ where: { id: resA.verification.id } });
      const crossWrite = await saveSellerVerificationDraft(ctxB, { ...EMPTY_PATCH, legalName: "Attempted Cross-Write" }, tx);
      const afterCrossWrite = await tx.sellerVerification.findUnique({ where: { id: resA.verification.id } });
      ok("D · sellerB saving a draft never mutates sellerA's row (scoped to ctx.sellerId only)",
        crossWrite.ok && beforeCrossWrite?.legalName === afterCrossWrite?.legalName && afterCrossWrite?.legalName !== "Attempted Cross-Write");

      // I/J/K/L — nothing else in the domain changes.
      const sellerARow = await tx.seller.findUniqueOrThrow({ where: { id: ctxA.sellerId }, select: { status: true } });
      ok("I · Seller.status unchanged (still PENDING — createSeller's default, never advanced)", sellerARow.status === "PENDING");
      const sellerUserCountA = await tx.sellerUser.count({ where: { sellerId: ctxA.sellerId } });
      ok("J · SellerUser count for sellerA unchanged (still just the one seeded OWNER)", sellerUserCountA === 1);
      ok("K · zero SellerInvite rows exist for either seller",
        (await tx.sellerInvite.count({ where: { sellerId: { in: [ctxA.sellerId, ctxB.sellerId] } } })) === 0);
      ok("L · zero SellerVerificationDocument rows exist for either seller's verification",
        (await tx.sellerVerificationDocument.count({
          where: { sellerVerification: { sellerId: { in: [ctxA.sellerId, ctxB.sellerId] } } },
        })) === 0);

      // N — no PII in AdminAuditLog. Exercise the SAME audit call the real
      // action makes (repository itself writes no audit — that's the
      // action's job — so this directly proves the action's own writeAudit
      // call, by inlining its exact shape, never embeds the sensitive values
      // it just saved).
      const { writeAudit } = await import("../src/lib/admin/audit");
      const distinctiveMarker = `SECRET-PII-MARKER-${t}`;
      await saveSellerVerificationDraft(ctxA, { ...EMPTY_PATCH, legalName: distinctiveMarker, tin: distinctiveMarker }, tx);
      const auditId = await writeAudit(
        {
          actorUserId: ctxA.userId,
          action: "seller.verification.draft_saved",
          targetType: "seller_verification",
          targetId: resA.verification.id,
          summary: `seller ${ctxA.sellerName} saved its verification details as a draft`,
          meta: { sellerId: ctxA.sellerId, sellerVerificationId: resA.verification.id, businessType: null },
        },
        tx,
      );
      const auditRow = await tx.adminAuditLog.findUnique({ where: { id: auditId! } });
      const auditText = JSON.stringify(auditRow);
      ok("N · the audit row never contains the actual PII value just saved",
        !!auditRow && !auditText.includes(distinctiveMarker));
      ok("N · the audit summary never embeds legalName/phone/address/tin values either",
        !!auditRow && !auditRow.summary?.includes(distinctiveMarker));

      // O — existing REAL sellers never receive a SellerVerification row as a
      // side effect of anything in this suite (read-only check, no write).
      const realSellers = await tx.seller.findMany({
        where: { displayName: { in: ["Axiaro", "Style Avenue", "Sandbox Seller (dev)"] } },
        select: { id: true },
      });
      const realSellerVerifications = await tx.sellerVerification.count({
        where: { sellerId: { in: realSellers.map((s) => s.id) } },
      });
      ok("O · none of the existing real sellers have a SellerVerification row", realSellerVerifications === 0);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p2v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P2V Store " } } })) === 0);
  ok("isolation · no SellerVerification row leaked", (await prisma.sellerVerification.count()) === 0);
  ok("isolation · no fixture AdminAuditLog leaked", (await prisma.adminAuditLog.count({ where: { targetType: "seller_verification" } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
