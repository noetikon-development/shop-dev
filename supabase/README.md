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

# 2. RLS + API-role grants + integrity constraints
psql "$DIRECT_URL" -f supabase/migrations/20260829140100_rls_and_grants.sql

# 3. demo catalogue data
psql "$DIRECT_URL" -f supabase/seed.sql
```

`20260830120000_address_step8.sql` is a one-off transform of a pre-Step-8
`Address` table (split `recipient`, drop `isDefault`). It is **not** needed on a
fresh database — `20260829140000_initial_schema.sql` already produces the
Step 8 shape — but it is idempotent and harmless to run.

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
- Every other table (`User, Address, Order*, ShippingMethod, Inventory,
  InventoryAdjustment, Cart, CartItem, StoreSetting, Coupon, WishlistItem`, the RBAC tables `Role,
  Permission, UserRole, RolePermission, AdminInvite, AdminAuditLog`, and the
  CMS/media tables `ContentPage, ContentBlock, MediaAsset`) has RLS on and
  **no policy** → the public API returns nothing and cannot write.

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
| `Variant` | FK → `Product`; `sku` unique; `status` ACTIVE/ARCHIVED; `stock` is a denormalised mirror of `Inventory` available (`quantity − reserved`), re-derived on every inventory write |
| `VariantOptionValue` | join: variant ↔ option value |
| `Inventory` | 1:1 with `Variant`; `quantity`, `reserved`, `reorderPoint`. CHECK: `quantity ≥ 0`, `reserved ≥ 0`, `quantity ≥ reserved`, `reorderPoint ≥ 0` |
| `InventoryAdjustment` | append-only stock-change history (Step 6): `previousQuantity`, signed `delta`, `newQuantity`, open-string `reason`, `note`, `actorUserId`. Excluded from `seed.sql` |
| `Cart` | Step 7. Guest (`token`, httpOnly cookie) or customer (`userId`) cart; `status` ACTIVE/CONVERTED/ABANDONED. Partial unique index = one ACTIVE cart per user. CHECK: has an owner. Step 14 adds `couponCode` (applied promo code — not authoritative). Excluded from `seed.sql` |
| `CartItem` | Step 7. `@@unique([cartId, variantId])`; `priceSnapshot` is a display cache, not authoritative. CHECK: `0 < quantity ≤ 99`, `priceSnapshot ≥ 0`. Excluded from `seed.sql` |
| `StoreSetting` | key/value store config, seeded from `src/lib/constants.ts` |
| `Coupon` | promo codes. Step 14 adds `perCustomerLimit` / `updatedAt` / `archivedAt`. Lifecycle state (Draft/Scheduled/Active/Expired/Disabled/Archived) is derived. Included in `seed.sql` |
| `CouponRedemption` | Step 14. One row per successful coupon application (`orderId` unique); authoritative for global + per-customer usage limits (checkout locks the parent `Coupon` row, counts rows whose order isn't `CANCELLED`). Excluded from `seed.sql` |
| `User` | application record only — **no password**; `supabaseUserId` unique link to `auth.users`; `role` is a coarse mirror of the RBAC tables |
| `Address` | FK → `User` (cascade). Step 8: firstName/lastName/company/country + independent `defaultShipping`/`defaultBilling`. Partial unique indexes = at most one default of each type per user. CHECK: names non-empty. Excluded from `seed.sql` |
| `Role` / `Permission` | RBAC catalogue; seeded from `src/lib/rbac/catalog.ts` — included in `seed.sql` |
| `RolePermission` | join: role ↔ permission — included in `seed.sql` |
| `UserRole` | join: user ↔ role (who is an admin, and as what) |
| `AdminInvite` | pending admin invitations; trusted record of the intended role |
| `AdminAuditLog` | append-only trail of admin logins / invites / role changes / media ops |
| `ContentPage` | standalone CMS pages at `/pages/<slug>` — `slug` unique, `title`, Markdown `body`, `excerpt`, `seoTitle`/`seoDescription`, `status` DRAFT/PUBLISHED, `publishedAt`. Step 16 makes these editable in `/admin/content/pages`. Included in `seed.sql` (demo pages) |
| `ContentBlock` | typed homepage sections (Step 16): `key` unique, `area` (`homepage`), `type` (`hero`/`category_tiles`/`product_rail`/`feature_grid`/`value_props`/`rich_text`), `title`, JSON `data` (Zod-validated per type), integer `position` (deterministic order), `status` DRAFT/PUBLISHED. Managed in `/admin/content/homepage`. Included in `seed.sql` |
| `MediaAsset` | metadata for files in Supabase **Storage** (bucket `media`) — no binary data. `alt`/`width`/`height` optional. Step 16: uploads sniffed by magic bytes, SVG rejected, deletes blocked while referenced |
| `EmailLog` | Step 17 transactional-email delivery log. One row per email the app tries to send: `type`, `recipient`, `subject`, `status` (`PENDING`/`SENDING`/`SENT`/`FAILED`/`SKIPPED`), `provider`, `error` (truncated, no secrets), `attempts`, `sentAt`, FK → `User` / `Order` (both `SET NULL`). `idempotencyKey` UNIQUE (`ORDER_CREATED:<id>` etc.) — the dedup guard. No message bodies, no credentials. RLS on, no policy. Excluded from `seed.sql` |
| `Order` | Step 9 checkout writes real orders. `cartId` (`@unique` — one order per cart, the double-submit guard), `billingAddressId` + `billingAddress` JSON snapshot, `status` value `PENDING_PAYMENT`. Order numbers from the `order_number_seq` sequence. Step 11 adds `shippingMethodId` (FK → `ShippingMethod`, `SET NULL`) + immutable `shippingMethodCode` / `shippingMethodName` snapshot alongside the existing `shippingFee`. Step 12 adds `placedAt` + `paymentStatus` indexes for the admin order list. Step 13 adds fulfilment columns `courier` / `courierName` / `trackingNumber` / `trackingUrl` / `shippedAt` / `deliveredAt` / `fulfillmentNote` + a `courier` index. Step 14 adds `discountType` / `discountValue` (coupon snapshot, alongside the existing `couponCode` / `discountTotal`). Excluded from `seed.sql` |
| `OrderItem` / `OrderEvent` | present; excluded from `seed.sql` |
| `Review` | Step 15 adds `orderId` (the DELIVERED order behind a verified purchase, `SET NULL`), `status` (`PENDING`/`APPROVED`/`REJECTED`/`ARCHIVED`, default `PENDING`), `updatedAt`, and indexes on `status` / `(productId,status)` / `userId`. `@@unique([productId,userId])`. Excluded from `seed.sql` |
| `WishlistItem` | one row per saved product; `@@unique([userId,productId])`. Authoritative wishlist store (Step 15) — not `localStorage`. Excluded from `seed.sql` |
| `ProductQuestion` / `ProductAnswer` | Step 15 product Q&A. Question: FK → `Product` + `User`, `status` moderated. Answer: FK → `ProductQuestion` (cascade), `authorId` (`SET NULL`), `authorType` `STORE`/`CUSTOMER`, `status`. Both excluded from `seed.sql` |
| `ShippingMethod` | Step 11. Configurable delivery option shown at checkout: `code` unique, `name`, `description`, `rate` (centavos), `currency`, `active`, `sortOrder`. CHECK: `rate ≥ 0`. Included in `seed.sql` (demo methods STANDARD / EXPRESS / PICKUP) |

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
