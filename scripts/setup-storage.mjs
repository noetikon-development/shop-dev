// Creates the Supabase Storage bucket used by the admin media library.
// Public read (so <img src> works on the storefront); writes only ever happen
// server-side with the service-role key. Idempotent.
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

const BUCKET = "media";
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: existing } = await supabase.storage.getBucket(BUCKET);
if (existing) {
  await supabase.storage.updateBucket(BUCKET, {
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
  console.log(`bucket "${BUCKET}" already exists — settings refreshed`);
} else {
  const { error } = await supabase.storage.createBucket(BUCKET, {
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
  if (error) {
    console.error("createBucket failed:", error.message);
    process.exit(1);
  }
  console.log(`bucket "${BUCKET}" created (public read, 8MB limit)`);
}
