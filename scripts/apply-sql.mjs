// Applies a raw .sql file to the database via DIRECT_URL (session-pooler /
// direct connection — required for DDL). Idempotent iff the SQL is.
//
// Run:  node --env-file=.env scripts/apply-sql.mjs supabase/migrations/<file>.sql
import { execFileSync } from "node:child_process";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --env-file=.env scripts/apply-sql.mjs <path-to.sql>");
  process.exit(1);
}
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DIRECT_URL / DATABASE_URL not set (use: node --env-file=.env …)");
  process.exit(1);
}

execFileSync(
  "npx",
  ["prisma", "db", "execute", "--url", url, "--file", file],
  { stdio: "inherit", shell: process.platform === "win32" },
);
console.log(`Applied ${file}`);
