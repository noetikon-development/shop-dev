// Generates supabase/seed.sql from the current database (data-only snapshot).
// Run:  node --env-file=.env scripts/dump-seed-sql.mjs
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

// Catalogue + config + RBAC reference data, in FK-safe insert order. Customer /
// order / admin-assignment data (User, Address, Order*, Review, WishlistItem,
// UserRole, AdminInvite, AdminAuditLog) is intentionally excluded.
const TABLES = [
  "Category", "Product", "ProductImage", "ProductOption",
  "ProductOptionValue", "Variant", "VariantOptionValue", "Inventory",
  "Coupon", "StoreSetting",
  // RBAC catalogue (roles, permissions, grants) — reference data, not per-user.
  "Permission", "Role", "RolePermission",
];

function lit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

let out = `-- AXIARO demo seed data (snapshot generated from the demo catalogue).
-- Structure lives in supabase/migrations/. Apply after the migrations.
-- Regenerate: node --env-file=.env scripts/dump-seed-sql.mjs
SET session_replication_role = replica; -- defer FK checks during load

`;

for (const table of TABLES) {
  const model = table[0].toLowerCase() + table.slice(1);
  const rows = await db[model].findMany();
  if (!rows.length) continue;
  const cols = Object.keys(rows[0]);
  out += `-- ${table} (${rows.length})\n`;
  for (const r of rows) {
    const vals = cols.map((c) => lit(r[c])).join(", ");
    out += `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${vals}) ON CONFLICT DO NOTHING;\n`;
  }
  out += "\n";
}

out += `SET session_replication_role = DEFAULT;\n`;
writeFileSync("supabase/seed.sql", out);
console.log(`Wrote supabase/seed.sql (${out.length} bytes)`);
await db.$disconnect();
