# Supabase — database

Production database for AXIARO. PostgreSQL, hosted on Supabase
(`ap-northeast-1` / Tokyo). The Next.js app talks to it through **Prisma over a
direct Postgres connection** — it does **not** use `supabase-js`, the anon key, or
the service-role key.

## Credentials

All in environment variables — never in code. See `../.env.example`.

| Var | What | Used by |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **transaction pooler** (`:6543`, `?pgbouncer=true`) | app at runtime (Prisma) |
| `DIRECT_URL` | Supabase **session pooler** (`:5432`) | `prisma db push` / seed |
| `NEXT_PUBLIC_SUPABASE_URL` | project URL | Supabase Auth (browser + server) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / public key | Supabase Auth cookie sessions |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role / secret key | **server only** — admin invitations (`inviteUserByEmail`) and seed scripts |
| `NEXT_PUBLIC_SITE_URL` | canonical site origin | auth email redirect links |

The **service-role key is server-only** — it is never sent to the browser, never
prefixed `NEXT_PUBLIC_`, and is used only in `src/lib/supabase/admin.ts`
(`createAdminClient`) for admin provisioning, plus the seed scripts. The
auto-generated PostgREST API is locked down by RLS (below).

## Reproducing the database from scratch

```bash
# 1. schema (all tables, PKs, FKs, indexes, constraints)
psql "$DIRECT_URL" -f supabase/migrations/20260829140000_initial_schema.sql

# 2. RLS + API-role grants
psql "$DIRECT_URL" -f supabase/migrations/20260829140100_rls_and_grants.sql

# 3. demo catalogue data
psql "$DIRECT_URL" -f supabase/seed.sql
```

Or with the Prisma toolchain (no psql needed):

```bash
npm run db:push        # applies prisma/schema.prisma
npm run db:seed         # full demo seed (catalogue + demo accounts + sample orders)
```

`prisma/schema.prisma` is the source of truth for structure. Regenerate the SQL:

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > supabase/migrations/20260829140000_initial_schema.sql
node --env-file=.env scripts/dump-seed-sql.mjs      # regenerates supabase/seed.sql
```

## Row Level Security

`20260829140100_rls_and_grants.sql` does:

- **Revokes** the permissive default grants Supabase gives `anon` / `authenticated`.
- **Enables RLS on every table.**
- Adds a single `SELECT` policy (public read) to the catalogue tables:
  `Category, Product, ProductImage, ProductOption, ProductOptionValue, Variant,
  VariantOptionValue, Review`.
- Every other table (`User, Address, Order*, Inventory, StoreSetting, Coupon,
  WishlistItem`, the RBAC tables `Role, Permission, UserRole, RolePermission,
  AdminInvite, AdminAuditLog`, and the CMS/media tables `ContentPage,
  ContentBlock, MediaAsset`) has RLS on and **no policy** → the public API
  returns nothing and cannot write.

## Storage

Bucket **`media`** (public read, 8 MB limit, image + PDF mime types) holds
admin-uploaded files. Created by `npm run storage:setup`. All writes happen
server-side with the service-role key (`src/lib/admin/media.ts`); the bucket is
public-read so `<img src>` works on the storefront. `MediaAsset` rows hold the
reference + metadata; binary data is never in Postgres.

The app is unaffected: it connects as the `postgres` role, which has `BYPASSRLS`.

## Tables in this step

| Table | Notes |
| --- | --- |
| `Category` | self-referencing tree (`parentId`) |
| `Product` | FK → `Category`; JSON-ish fields stored as text |
| `ProductImage` | FK → `Product` (cascade) |
| `ProductOption` / `ProductOptionValue` | option definitions (Colour, Size…) |
| `Variant` | FK → `Product`; `sku` unique; `status` ACTIVE/ARCHIVED; `stock` mirrors `Inventory.quantity` (Step 6) |
| `VariantOptionValue` | join: variant ↔ option value |
| `Inventory` | 1:1 with `Variant`; `quantity`, `reserved`, `reorderPoint` |
| `StoreSetting` | key/value store config, seeded from `src/lib/constants.ts` |
| `Coupon` | promo codes |
| `User` | application record only — **no password**; `supabaseUserId` unique link to `auth.users`; `role` is a coarse mirror of the RBAC tables |
| `Address` | FK → `User` (cascade) |
| `Role` / `Permission` | RBAC catalogue; seeded from `src/lib/rbac/catalog.ts` — included in `seed.sql` |
| `RolePermission` | join: role ↔ permission — included in `seed.sql` |
| `UserRole` | join: user ↔ role (who is an admin, and as what) |
| `AdminInvite` | pending admin invitations; trusted record of the intended role |
| `AdminAuditLog` | append-only trail of admin logins / invites / role changes / media ops |
| `ContentPage` | standalone CMS pages (slug, title, body, SEO, status) — Step 4 foundation |
| `ContentBlock` | data-driven managed blocks (hero/banner/collection…); `type` + JSON `data` |
| `MediaAsset` | metadata for files in Supabase **Storage** (bucket `media`) — no binary data |
| `Order` / `OrderItem` / `OrderEvent`, `Review`, `WishlistItem` | present; out of scope, excluded from `seed.sql` |

## Authentication

Passwords and sessions are handled by **Supabase Auth** (`auth.users`), not by
Prisma. `User.supabaseUserId` is the 1:1 link, set server-side on first
authenticated request (`src/lib/auth.ts` → `syncAppUser`). The app connects to
Postgres as `postgres` (BYPASSRLS) for its data. `scripts/seed-auth-users.mjs`
provisions + links the demo accounts.

**Admin authorization (Step 3)** is database-backed RBAC: `Role`, `Permission`,
`UserRole`, `RolePermission`, seeded from `src/lib/rbac/catalog.ts`
(`npm run db:seed:rbac`). Admin identity is resolved server-side in
`src/lib/admin/rbac.ts` — never from client input or Supabase `user_metadata`.
The **service-role key** is used only server-side, only for `inviteUserByEmail`
during admin provisioning (`src/lib/admin/actions.ts` → `createAdminClient`).
