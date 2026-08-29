// Creates the demo accounts in Supabase Auth (email pre-confirmed) and links
// each to its application User row via User.supabaseUserId. Idempotent.
//
// Requires SUPABASE_SERVICE_ROLE_KEY.
// Run:  node --env-file=.env scripts/seed-auth-users.mjs

import { createClient } from "@supabase/supabase-js";
import { PrismaClient } from "@prisma/client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

const DEMO = [
  { email: "demo@axiaro.test", password: "password123", name: "Mara Santos", phone: "+63 917 555 0142" },
  { email: "admin@axiaro.test", password: "password123", name: "AXIARO Admin" },
];

async function findAuthUserByEmail(email) {
  // paginate through users (small project)
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

for (const d of DEMO) {
  let authUser = await findAuthUserByEmail(d.email);

  if (!authUser) {
    const { data, error } = await admin.auth.admin.createUser({
      email: d.email,
      password: d.password,
      email_confirm: true,
      user_metadata: { name: d.name, ...(d.phone ? { phone: d.phone } : {}) },
    });
    if (error) throw error;
    authUser = data.user;
    console.log(`created auth user  ${d.email}`);
  } else {
    await admin.auth.admin.updateUserById(authUser.id, {
      password: d.password,
      email_confirm: true,
      user_metadata: { name: d.name, ...(d.phone ? { phone: d.phone } : {}) },
    });
    console.log(`updated auth user  ${d.email}`);
  }

  await prisma.user.upsert({
    where: { email: d.email.toLowerCase() },
    update: { supabaseUserId: authUser.id, emailVerified: new Date() },
    create: {
      email: d.email.toLowerCase(),
      supabaseUserId: authUser.id,
      name: d.name,
      phone: d.phone ?? null,
      role: d.email.startsWith("admin@") ? "ADMIN" : "CUSTOMER",
      emailVerified: new Date(),
    },
  });
  console.log(`linked User row     ${d.email} -> ${authUser.id}`);
}

await prisma.$disconnect();
console.log("Done.");
