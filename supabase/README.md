# Supabase — database

Production database for AXIARO. PostgreSQL, hosted on Supabase
(`ap-northeast-1` / Tokyo). The Next.js app talks to it through **Prisma over a
direct Postgres connection** — it does **not** use `supabase-js`, the anon key, or
the service-role key.

## Credentials

All in environment variables — never in code. See `../.env.example`.

| Var | What | Used by |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **transaction pooler** (`:6543`, `?pgbouncer=true`) | app at runtime |
| `DIRECT_URL` | Supabase **session pooler** (`:5432`) | `prisma migrate` / `db push` / seed |
| `AUTH_SECRET` | Auth.js JWT secret | app |

The Supabase **service-role key is not used anywhere** and must never be added to
client code. The anon key is likewise unused; the auto-generated PostgREST API is
locked down by RLS (below).

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
- Every other table (`User, Account, Session, Address, Order*, Inventory,
  StoreSetting, Coupon, WishlistItem, VerificationToken`) has RLS on and **no
  policy** → the public API returns nothing and cannot write.

The app is unaffected: it connects as the `postgres` role, which has `BYPASSRLS`.

## Tables in this step

| Table | Notes |
| --- | --- |
| `Category` | self-referencing tree (`parentId`) |
| `Product` | FK → `Category`; JSON-ish fields stored as text |
| `ProductImage` | FK → `Product` (cascade) |
| `ProductOption` / `ProductOptionValue` | option definitions (Colour, Size…) |
| `Variant` | FK → `Product`; `sku` unique; `stock` is a mirror of `Inventory.quantity` |
| `VariantOptionValue` | join: variant ↔ option value |
| `Inventory` | 1:1 with `Variant`; `quantity`, `reserved`, `reorderPoint` |
| `StoreSetting` | key/value store config, seeded from `src/lib/constants.ts` |
| `Coupon` | promo codes |
| `User` | application record only — **no password**; `supabaseUserId` unique link to `auth.users` |
| `Address` | FK → `User` (cascade) |
| `Order` / `OrderItem` / `OrderEvent`, `Review`, `WishlistItem` | present; out of scope, excluded from `seed.sql` |

## Authentication

Passwords and sessions are handled by **Supabase Auth** (`auth.users`), not by
Prisma. `User.supabaseUserId` is the 1:1 link, set server-side on first
authenticated request (`src/lib/auth.ts` → `syncAppUser`). The app connects to
Postgres as `postgres` (BYPASSRLS) and never uses `supabase-js`, the anon key, or
the service-role key in the request path — only the direct Postgres connection.
`scripts/seed-auth-users.mjs` provisions + links the two demo accounts.
