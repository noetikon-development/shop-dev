/**
 * Seller Verification — private storage + schema foundation (Phase 1).
 *
 * Schema/storage foundation ONLY — no application code reads or writes these
 * models yet (no UI, no server action, no admin page, no email, no gating of
 * approval/claim/portal access). This file proves the foundation itself is
 * sound: the two new models exist with the right shape/constraints, the new
 * bucket is genuinely private while "media" stays exactly as it was, and
 * every existing Seller Onboarding table/behavior is completely undisturbed.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p1.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { createAdminClient } from "../src/lib/supabase/admin";
import { SELLER_VERIFICATION_BUCKET } from "../src/lib/seller-verification/storage";
import { submitSellerApplication } from "../src/lib/seller-onboarding/repository";

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

function seedSellerInput(tag: string) {
  return {
    displayName: `P1V Store ${tag}`,
    slug: `p1v-store-${tag}-${Math.random().toString(36).slice(2, 7)}`,
    supportEmail: `p1v-support-${tag}@t.test`,
  };
}
function seedUser(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `p1v-${tag}-${Math.random().toString(36).slice(2, 8)}@t.test`, name: "P1V User" },
    select: { id: true },
  });
}

async function main() {
  console.log("\nSeller Verification — private storage + schema foundation (Phase 1)\n");

  // ── A/B — models exist and are queryable ────────────────────────────────
  ok("A · SellerVerification is queryable (model exists)", (await prisma.sellerVerification.count()) >= 0);
  ok("B · SellerVerificationDocument is queryable (model exists)", (await prisma.sellerVerificationDocument.count()) >= 0);

  // ── C — indexes / FKs exist, per information_schema ─────────────────────
  const svIndexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'SellerVerification'`,
  );
  const svdIndexes = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'SellerVerificationDocument'`,
  );
  const svIdxNames = svIndexes.map((r) => r.indexname);
  const svdIdxNames = svdIndexes.map((r) => r.indexname);
  ok("C · SellerVerification has a sellerId index", svIdxNames.includes("SellerVerification_sellerId_idx"));
  ok("C · SellerVerification has a status index", svIdxNames.includes("SellerVerification_status_idx"));
  ok("C · SellerVerificationDocument has a sellerVerificationId index", svdIdxNames.includes("SellerVerificationDocument_sellerVerificationId_idx"));
  ok("C · SellerVerificationDocument has a documentType index", svdIdxNames.includes("SellerVerificationDocument_documentType_idx"));
  ok("C · SellerVerificationDocument has a status index", svdIdxNames.includes("SellerVerificationDocument_status_idx"));
  ok("C · SellerVerificationDocument has a unique (bucket, storagePath) index", svdIdxNames.includes("SellerVerificationDocument_bucket_storagePath_key"));

  const fkRows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
    `SELECT conname FROM pg_constraint WHERE conname IN (
       'SellerVerification_sellerId_fkey',
       'SellerVerificationDocument_sellerVerificationId_fkey'
     )`,
  );
  const fkNames = fkRows.map((r) => r.conname);
  ok("C · SellerVerification → Seller FK exists", fkNames.includes("SellerVerification_sellerId_fkey"));
  ok("C · SellerVerificationDocument → SellerVerification FK exists", fkNames.includes("SellerVerificationDocument_sellerVerificationId_fkey"));

  // ── F — no public/signed URL column exists on the document model ───────
  const svdCols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'SellerVerificationDocument'`,
  );
  const colNames = svdCols.map((r) => r.column_name.toLowerCase());
  ok("F · no 'url' column on SellerVerificationDocument", !colNames.includes("url"));
  ok("F · no 'publicurl' column on SellerVerificationDocument", !colNames.includes("publicurl"));
  ok("F · no 'signedurl' column on SellerVerificationDocument", !colNames.includes("signedurl"));
  ok("F · storagePath column exists instead (metadata only)", colNames.includes("storagepath"));

  // ── static — schema comments document the controlled vocabularies ──────
  const schemaSrc = read("prisma/schema.prisma");
  const svBlock = schemaSrc.match(/model SellerVerification \{[\s\S]*?\n\}/)?.[0] ?? "";
  const svdBlock = schemaSrc.match(/model SellerVerificationDocument \{[\s\S]*?\n\}/)?.[0] ?? "";
  ok("D · SellerVerification.status documents DRAFT|PENDING|APPROVED|REJECTED",
    /DRAFT \| PENDING \| APPROVED \| REJECTED/.test(svBlock));
  ok("D · SellerVerification.status defaults to DRAFT",
    /status\s+String\s+@default\("DRAFT"\)/.test(svBlock));
  ok("· CHANGES_REQUESTED was NOT added to the status vocabulary yet",
    !/CHANGES_REQUESTED/.test(svBlock));
  ok("E · SellerVerificationDocument.documentType documents the controlled vocabulary",
    /GOVERNMENT_ID_PRIMARY \| GOVERNMENT_ID_SECONDARY \| BUSINESS_PERMIT \| BUSINESS_REGISTRATION \| PROOF_OF_ADDRESS \| OTHER/.test(svdBlock));
  ok("E · SellerVerificationDocument.status documents PENDING|APPROVED|REJECTED (kept separate from Seller.contentStatus)",
    /status\s+String\s+@default\("PENDING"\) \/\/ PENDING \| APPROVED \| REJECTED/.test(svdBlock));
  ok("· the schema documents that no public/signed URL is stored on this model",
    /no public\/signed URL stored/.test(svdBlock));

  // ── I — no existing seller-onboarding code references the new models yet ─
  const actionsSrc = read("src/lib/seller-onboarding/actions.ts");
  const repoSrc = read("src/lib/seller-onboarding/repository.ts");
  const adminActionsSrc = read("src/lib/admin/sellers/actions.ts");
  const sessionSrc = read("src/lib/seller/session.ts");
  ok("I · seller-onboarding/actions.ts does not reference SellerVerification yet",
    !/SellerVerification/.test(actionsSrc));
  ok("I · seller-onboarding/repository.ts does not reference SellerVerification yet",
    !/SellerVerification/.test(repoSrc));
  ok("I · admin/sellers/actions.ts does not reference SellerVerification yet",
    !/SellerVerification/.test(adminActionsSrc));
  ok("I · the Seller Portal session gate does not reference SellerVerification yet (not gated)",
    !/SellerVerification/.test(sessionSrc));

  // ── J/K — bucket configuration, read directly from Supabase Storage ────
  const supabase = createAdminClient();
  const { data: mediaBucket, error: mediaErr } = await supabase.storage.getBucket("media");
  ok("J · the existing 'media' bucket still exists", !mediaErr && !!mediaBucket);
  ok("J · the existing 'media' bucket remains PUBLIC (unchanged)", mediaBucket?.public === true);

  const { data: svBucket, error: svErr } = await supabase.storage.getBucket(SELLER_VERIFICATION_BUCKET);
  ok("K · the new 'seller-verification' bucket exists", !svErr && !!svBucket);
  ok("K · the new 'seller-verification' bucket is PRIVATE", svBucket?.public === false);
  ok("K · the storage helper's bucket constant matches the actual bucket name",
    SELLER_VERIFICATION_BUCKET === "seller-verification");

  // ── DB (rolled back) ─────────────────────────────────────────────────────
  const beforeSeller = await prisma.seller.count();
  const beforeSellerUser = await prisma.sellerUser.count();
  const beforeSellerInvite = await prisma.sellerInvite.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);

      // Relational integrity + cascade behavior.
      const applicant = await seedUser(tx, `a-${t}`);
      const created = await submitSellerApplication(applicant.id, seedSellerInput(`a-${t}`), tx);
      if (!created.ok) throw new Error(`fixture setup failed: ${JSON.stringify(created)}`);

      // L — submitting an application creates NO SellerVerification row.
      const svCountAfterApply = await tx.sellerVerification.count({ where: { sellerId: created.sellerId } });
      ok("L · submitting a seller application does not auto-create a SellerVerification row", svCountAfterApply === 0);

      const verification = await tx.sellerVerification.create({
        data: { sellerId: created.sellerId, status: "PENDING", submittedAt: new Date() },
      });
      ok("· SellerVerification row created with the expected default-adjacent shape",
        verification.status === "PENDING" && verification.sellerId === created.sellerId);

      const doc = await tx.sellerVerificationDocument.create({
        data: {
          sellerVerificationId: verification.id,
          documentType: "GOVERNMENT_ID_PRIMARY",
          bucket: SELLER_VERIFICATION_BUCKET,
          storagePath: `sellers/${created.sellerId}/gov-id-${t}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 12345,
        },
      });
      ok("· SellerVerificationDocument row created, status defaults to PENDING", doc.status === "PENDING");
      ok("· SellerVerificationDocument.bucket is the private bucket, never 'media'", doc.bucket === SELLER_VERIFICATION_BUCKET);

      // D — every documented status value is accepted by the column (plain
      // string, matching every other status field's convention in this
      // schema — Seller.status, SellerInvite.status, etc. are never native
      // Postgres/Prisma enums either).
      for (const status of ["DRAFT", "PENDING", "APPROVED", "REJECTED"]) {
        const row = await tx.sellerVerification.create({ data: { sellerId: created.sellerId, status } });
        ok(`D · SellerVerification.status accepts "${status}"`, row.status === status);
      }

      // E — every documented document type + document status value is accepted.
      for (const documentType of [
        "GOVERNMENT_ID_PRIMARY", "GOVERNMENT_ID_SECONDARY", "BUSINESS_PERMIT",
        "BUSINESS_REGISTRATION", "PROOF_OF_ADDRESS", "OTHER",
      ]) {
        const row = await tx.sellerVerificationDocument.create({
          data: {
            sellerVerificationId: verification.id,
            documentType,
            bucket: SELLER_VERIFICATION_BUCKET,
            storagePath: `sellers/${created.sellerId}/${documentType.toLowerCase()}-${t}.pdf`,
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        });
        ok(`E · SellerVerificationDocument.documentType accepts "${documentType}"`, row.documentType === documentType);
      }
      for (const status of ["PENDING", "APPROVED", "REJECTED"]) {
        const row = await tx.sellerVerificationDocument.create({
          data: {
            sellerVerificationId: verification.id,
            documentType: "OTHER",
            bucket: SELLER_VERIFICATION_BUCKET,
            storagePath: `sellers/${created.sellerId}/status-${status}-${t}.pdf`,
            mimeType: "application/pdf",
            sizeBytes: 1,
            status,
          },
        });
        ok(`E · SellerVerificationDocument.status accepts "${status}"`, row.status === status);
      }

      // Cascade: deleting the SellerVerification removes its documents.
      const docCountBefore = await tx.sellerVerificationDocument.count({ where: { sellerVerificationId: verification.id } });
      await tx.sellerVerification.delete({ where: { id: verification.id } });
      const docCountAfter = await tx.sellerVerificationDocument.count({ where: { sellerVerificationId: verification.id } });
      ok("· deleting a SellerVerification cascades to its documents", docCountBefore > 0 && docCountAfter === 0);

      // Cascade: deleting the Seller removes its remaining SellerVerification rows.
      const svCountBeforeSellerDelete = await tx.sellerVerification.count({ where: { sellerId: created.sellerId } });
      ok("· fixture still has other SellerVerification rows to prove the Seller cascade", svCountBeforeSellerDelete > 0);
      await tx.seller.delete({ where: { id: created.sellerId } });
      const svCountAfterSellerDelete = await tx.sellerVerification.count({ where: { sellerId: created.sellerId } });
      ok("· deleting a Seller cascades to its SellerVerification rows", svCountAfterSellerDelete === 0);

      // C (functional) — unique (bucket, storagePath) is enforced. Run LAST:
      // Postgres aborts the rest of the transaction after a real constraint
      // violation (no implicit per-statement savepoint), so nothing below
      // this point may depend on the transaction remaining usable.
      const applicant2 = await seedUser(tx, `b-${t}`);
      const created2 = await submitSellerApplication(applicant2.id, seedSellerInput(`b-${t}`), tx);
      if (!created2.ok) throw new Error(`fixture setup failed (2): ${JSON.stringify(created2)}`);
      const verification2 = await tx.sellerVerification.create({ data: { sellerId: created2.sellerId, status: "DRAFT" } });
      const dupPath = `sellers/${created2.sellerId}/dup-${t}.pdf`;
      await tx.sellerVerificationDocument.create({
        data: {
          sellerVerificationId: verification2.id,
          documentType: "OTHER",
          bucket: SELLER_VERIFICATION_BUCKET,
          storagePath: dupPath,
          mimeType: "application/pdf",
          sizeBytes: 1,
        },
      });
      let dupRejected = false;
      try {
        await tx.sellerVerificationDocument.create({
          data: {
            sellerVerificationId: verification2.id,
            documentType: "OTHER",
            bucket: SELLER_VERIFICATION_BUCKET,
            storagePath: dupPath,
            mimeType: "application/pdf",
            sizeBytes: 1,
          },
        });
      } catch (e) {
        dupRejected = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      }
      ok("C · unique (bucket, storagePath) constraint rejects a duplicate", dupRejected);

      throw new Rollback();
    }, { timeout: 30_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // C (functional) — the sellerId FK is enforced. A separate, isolated
  // transaction: like the unique-constraint check above, a real constraint
  // violation aborts the rest of the transaction it happens in, so this gets
  // its own rolled-back block rather than sharing one with anything else.
  try {
    await prisma.$transaction(async (tx) => {
      let fkRejected = false;
      try {
        await tx.sellerVerification.create({ data: { sellerId: "does-not-exist-" + Date.now(), status: "DRAFT" } });
      } catch (e) {
        fkRejected = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
      }
      ok("C · sellerId FK rejects a non-existent seller", fkRejected);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ── G/H — existing rows completely unaffected by any of the above ──────
  ok("G · Seller row count unchanged", (await prisma.seller.count()) === beforeSeller, `before=${beforeSeller}`);
  ok("H · SellerUser row count unchanged", (await prisma.sellerUser.count()) === beforeSellerUser);
  ok("H · SellerInvite row count unchanged", (await prisma.sellerInvite.count()) === beforeSellerInvite);

  ok("isolation · no fixture User leaked", (await prisma.user.count({ where: { email: { contains: "p1v-" } } })) === 0);
  ok("isolation · no fixture Seller leaked", (await prisma.seller.count({ where: { displayName: { startsWith: "P1V Store " } } })) === 0);
  ok("isolation · no SellerVerification row leaked", (await prisma.sellerVerification.count()) === 0);
  ok("isolation · no SellerVerificationDocument row leaked", (await prisma.sellerVerificationDocument.count()) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
