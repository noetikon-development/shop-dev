/**
 * Seeds / re-syncs the RBAC catalogue (roles, permissions, role→permission
 * grants) from src/lib/rbac/catalog.ts into the database. Idempotent — it
 * upserts rows and, for the shipped system roles, brings each role's grant set
 * exactly in line with the catalogue. It never touches UserRole assignments.
 *
 * Also (best-effort) links admin@axiaro.test to SUPER_ADMIN so there is always
 * one bootstrap administrator in dev / demo environments.
 *
 * Run:  npm run db:seed:rbac        (node --env-file=.env --import tsx …)
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  type RoleKey,
} from "../src/lib/rbac/catalog";

type Db = PrismaClient;

export async function seedRbac(prisma: Db, opts: { log?: boolean } = {}) {
  const log = opts.log ? (m: string) => console.log(m) : () => {};

  // 1. Permissions -----------------------------------------------------------
  for (let i = 0; i < PERMISSIONS.length; i++) {
    const p = PERMISSIONS[i];
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { description: p.description, group: p.group, sortOrder: i },
      create: { key: p.key, description: p.description, group: p.group, sortOrder: i },
    });
  }
  log(`permissions: ${PERMISSIONS.length}`);

  // 2. Roles ---------------------------------------------------------------
  for (let i = 0; i < ROLES.length; i++) {
    const r = ROLES[i];
    await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description, isSystem: true, sortOrder: i },
      create: {
        key: r.key,
        name: r.name,
        description: r.description,
        isSystem: true,
        sortOrder: i,
      },
    });
  }
  log(`roles: ${ROLES.length}`);

  // 3. Role → permission grants (sync system roles to the catalogue) --------
  const permIdByKey = new Map(
    (await prisma.permission.findMany()).map((p) => [p.key, p.id]),
  );

  for (const role of ROLES) {
    const dbRole = await prisma.role.findUniqueOrThrow({ where: { key: role.key } });
    const wantKeys = new Set(ROLE_PERMISSIONS[role.key as RoleKey]);
    const current = await prisma.rolePermission.findMany({
      where: { roleId: dbRole.id },
      include: { permission: true },
    });
    const currentKeys = new Set(current.map((rp) => rp.permission.key));

    // add missing
    for (const key of wantKeys) {
      if (!currentKeys.has(key)) {
        const permissionId = permIdByKey.get(key);
        if (!permissionId) continue;
        await prisma.rolePermission.create({ data: { roleId: dbRole.id, permissionId } });
      }
    }
    // remove extras (keeps system roles matching the catalogue exactly)
    for (const rp of current) {
      if (!wantKeys.has(rp.permission.key)) {
        await prisma.rolePermission.delete({ where: { id: rp.id } });
      }
    }
    log(`  ${role.key}: ${wantKeys.size} permissions`);
  }

  // 4. Bootstrap admin -----------------------------------------------------
  const bootstrap = await prisma.user.findUnique({ where: { email: "admin@axiaro.test" } });
  if (bootstrap) {
    const superRole = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: bootstrap.id, roleId: superRole.id } },
      update: {},
      create: { userId: bootstrap.id, roleId: superRole.id },
    });
    if (bootstrap.role !== "ADMIN") {
      await prisma.user.update({ where: { id: bootstrap.id }, data: { role: "ADMIN" } });
    }
    log("bootstrap: admin@axiaro.test → SUPER_ADMIN");
  } else {
    log("bootstrap: admin@axiaro.test not found (run db:seed first) — skipped");
  }
}

// CLI entry -------------------------------------------------------------------
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedRbac(prisma, { log: true })
    .then(() => console.log("RBAC seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
