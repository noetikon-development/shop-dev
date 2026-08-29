// Applies supabase/migrations/20260829140100_rls_and_grants.sql via DIRECT_URL.
// Idempotent — safe to re-run.  Run:  node --env-file=.env scripts/apply-rls.mjs
import { execFileSync } from "node:child_process";

const url = process.env.DIRECT_URL;
if (!url) {
  console.error("DIRECT_URL is not set (use: node --env-file=.env scripts/apply-rls.mjs)");
  process.exit(1);
}

execFileSync(
  "npx",
  [
    "prisma",
    "db",
    "execute",
    "--url",
    url,
    "--file",
    "supabase/migrations/20260829140100_rls_and_grants.sql",
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
