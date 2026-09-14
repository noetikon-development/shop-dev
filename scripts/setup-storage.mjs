// Creates the Supabase Storage buckets this project uses. Idempotent.
//
// - "media"               — PUBLIC read, for the admin media library / product
//                            images / storefront assets. Writes only ever
//                            happen server-side with the service-role key.
// - "seller-verification" — PRIVATE (Seller Verification foundation, Phase 1).
//                            No public read at all — every read must go
//                            through a server-issued short-lived signed URL
//                            (see src/lib/seller-verification/storage.ts).
//                            Government IDs / business documents must NEVER
//                            land in "media" or get a public URL.
//
// Requires SUPABASE_SERVICE_ROLE_KEY.
// Run:  node --env-file=.env scripts/setup-storage.mjs
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function upsertBucket(name, options) {
  const { data: existing } = await supabase.storage.getBucket(name);
  if (existing) {
    await supabase.storage.updateBucket(name, options);
    console.log(`bucket "${name}" already exists — settings refreshed (public: ${options.public})`);
  } else {
    const { error } = await supabase.storage.createBucket(name, options);
    if (error) {
      console.error(`createBucket "${name}" failed:`, error.message);
      process.exit(1);
    }
    console.log(`bucket "${name}" created (public: ${options.public}, limit ${options.fileSizeLimit})`);
  }
}

await upsertBucket("media", {
  public: true,
  fileSizeLimit: "8MB",
  allowedMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/svg+xml",
    "application/pdf",
  ],
});

// Seller Verification foundation (Phase 1) — schema-only feature so far, no
// upload path exists yet. This bucket is created ahead of that workflow so
// the storage side of the foundation is complete and reviewable on its own.
await upsertBucket("seller-verification", {
  public: false,
  fileSizeLimit: "8MB",
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
});
