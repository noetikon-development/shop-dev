# AXIARO — e-commerce platform

An original, production-quality storefront for a homeware + lifestyle brand.
Built from scratch — no third-party themes, no copied UI, branding, or copy.

> The project directory is still named `lumo-store` for path stability; the
> brand, wordmark, and all customer-facing copy are AXIARO.

## Stack

- **Next.js 16** (App Router, Turbopack) + React 19 + TypeScript
- **Tailwind CSS v4** — design tokens in `src/app/globals.css`
- **Prisma 6** + **PostgreSQL** (no enums / scalar lists — JSON-shaped data stored as `String`)
- **Auth.js (next-auth v5)** — credentials provider, JWT sessions
- **Zustand** — client cart + wishlist (persisted to `localStorage`)
- **sonner** — toasts, **lucide-react** — icons

## Design system

Warm-neutral canvas, ink typography (Fraunces display + Inter UI), a single clay
accent, quiet borders, generous spacing — a clean IKEA/ZALORA-adjacent look
without cloning either. Product imagery is an **in-house SVG illustration system**
(`src/lib/product-art.tsx`) — minimal line-drawn objects on tinted panels, so the
store ships with zero licensed photography.

The **AXIARO logo** is the supplied mark — an open-triangle "A" in brand navy
(`#05172d`), stored as `public/axiaro-logo.png` (transparent) and also `src/app/icon.png`
(favicon) / `src/app/apple-icon.tsx`. `src/components/logo.tsx` renders it verbatim via
`next/image`; size it with a height class. Never recreate it in a font or add a text
wordmark — use `<Logo />` everywhere the mark appears.

## Getting started

Runs on **Supabase** — Postgres for app data (Prisma), **Supabase Auth** for customer accounts.

```bash
cp .env.example .env         # fill in DATABASE_URL / DIRECT_URL / NEXT_PUBLIC_SUPABASE_* / SUPABASE_SERVICE_ROLE_KEY
npm install
npm run db:push              # schema -> Supabase
npm run db:seed              # demo catalogue + application User rows (also seeds RBAC)
npm run db:seed:config       # inventory + store settings
npm run db:seed:auth         # demo accounts in Supabase Auth + link to User rows
npm run db:seed:rbac         # roles + permissions + link admin@axiaro.test -> SUPER_ADMIN
npm run db:seed:settings     # store-settings registry defaults (StoreSetting rows)
npm run storage:setup        # create the Supabase Storage "media" bucket
npm run dev                  # http://localhost:3400
```

### Supabase Auth dashboard settings (required)

- **Authentication → URL Configuration → Site URL:** your production URL
- **Authentication → URL Configuration → Redirect URLs:** add
  `http://localhost:3400/**` and `https://YOUR-DOMAIN/**`
- **Authentication → Sign In / Providers → Email:** "Confirm email" ON
- The built-in email sender is rate-limited (~a few/hour). Configure **custom
  SMTP** (Authentication → Emails) for real verification / password-reset email.

### Demo accounts

| Email              | Password      | Role     |
| ------------------ | ------------- | -------- |
| demo@axiaro.test   | password123   | Customer (has orders, address, wishlist) |
| admin@axiaro.test  | password123   | Admin    |

### Promo codes

`WELCOME10` · `AXIARO500` · `FREESHIP` · `HOME15` (see `/promotions`)

## Feature map

| Area | Route | Notes |
| --- | --- | --- |
| Homepage / discovery | `/` | hero, category tiles, new/bestseller/sale rails |
| Category + PLP | `/c/[slug]` | filters (price, colour, rating, sale, stock, shipping), sort, pagination; special slugs `all` / `new` / `sale` |
| Search | `/search?q=` | live suggestions in the header, full results page reuses PLP filters |
| Product detail | `/p/[slug]` | gallery, variant selection (colour × size), stock-aware, reviews, related |
| Cart | `/cart` + slide-over drawer | quantity, coupon, free-shipping progress |
| Checkout | `/checkout` | guest or signed-in; contact / address / delivery / payment; server-side re-pricing in `placeOrder` |
| Order confirmation | `/order/[orderNumber]` | |
| Order tracking | `/track` | public, by order number + email; status timeline |
| Accounts | `/account`, `/account/orders`, `/account/orders/[n]`, `/account/addresses` | auth-guarded |
| Wishlist | `/wishlist` | device-local |
| Auth | `/login`, `/register` | |
| Admin | `/admin`, `/admin/login`, `/admin/users`, `/admin/audit` | separate login; database-backed RBAC (see below) |

## Admin area & RBAC

`/admin` has its own sign-in (`/admin/login`) and never shows the storefront
header/footer. Admins are ordinary Supabase Auth users (one Supabase user ↔ one
Prisma `User`) who hold one or more **roles**; each role grants a set of granular
**permissions**. Everything is database-backed — `Role`, `Permission`,
`UserRole`, `RolePermission` — and seeded from `src/lib/rbac/catalog.ts`
(`npm run db:seed:rbac`). Shipped roles: `SUPER_ADMIN`, `ADMIN`, `STAFF`,
`SUPPORT`, `CONTENT_MANAGER`, `FINANCE`.

- **Route protection:** `proxy.ts` redirects unauthenticated `/admin/**` traffic
  to `/admin/login`; `src/app/admin/(shell)/layout.tsx` returns a real **HTTP 403**
  for signed-in non-admins (`app/forbidden.tsx`).
- **Authorization helpers** (`src/lib/admin/rbac.ts`): `getCurrentAdmin()`,
  `requireAdmin()`, `requireRole()`, `requirePermission()`,
  `requireAnyPermission()`, `hasPermission()`. Enforced server-side on every
  protected page **and** server action — UI visibility is never the only gate.
- **Provisioning:** only `SUPER_ADMIN` can invite/promote. New addresses get a
  Supabase invitation email (they set a password at `/admin/accept`); existing
  accounts are promoted instantly. The `AdminInvite` row — not `user_metadata` —
  is the trusted record of the intended role. `AdminAuditLog` records logins,
  invitations and role changes (`/admin/audit`, `view_audit_logs`).
- **First admin:** `npm run db:seed:rbac` links `admin@axiaro.test` to
  `SUPER_ADMIN`. `admin@axiaro.test / password123`.

## Admin Panel foundation (Step 4)

A professional admin shell — responsive sidebar (off-canvas on mobile),
top bar with breadcrumbs and a user menu, permission-filtered navigation,
and a dashboard foundation. **No business CRUD yet** — every section renders
a permission-gated foundation page.

- **IA / navigation:** `src/lib/admin/navigation.ts` is the single source of
  truth — sidebar groups, breadcrumbs and per-route `accepts` permissions.
  Adding a section is one entry here; the `[...path]` foundation route and its
  guard pick it up automatically.
- **UI kit:** `src/components/admin/ui` — `Card`, `StatCard`, `PageHeader`,
  `Breadcrumbs`, `DataTable`, `SearchInput`, `FilterBar`/`FilterSelect`,
  `Pagination`, `StatusBadge`, `EmptyState`, `LoadingState`, `ErrorState`,
  `Modal`, `ConfirmDialog`, `FormField`, `Select`, `Tabs`, `ActionMenu`,
  `notify`. Generic and reusable — CRUD steps compose these, they don't fork.
- **CMS foundation:** `ContentPage` (standalone pages) + `ContentBlock`
  (data-driven homepage/banner/collection blocks — `type` selects the payload
  schema, `data` is JSON, so new block types need no migration). Editor and
  management UI come later.
- **Media:** files live in **Supabase Storage** (bucket `media`, public read,
  server-side writes only). `MediaAsset` stores metadata only — never binary
  data. `/admin/media` has a minimal upload + grid + delete to prove the
  foundation; the full library is a later step.
- **Settings:** `src/lib/admin/settings-registry.ts` defines *what* is
  configurable (identity, contact, business, regional, social, SEO, payments,
  shipping, email); values live in `StoreSetting`. Nothing brand-specific is in
  application logic. Sensitive credentials (payment/SMTP keys) stay in the
  server environment and are never in the registry or the client.
- **403 vs loading:** there is intentionally **no route-level `loading.tsx`** in
  `/admin` — a Suspense boundary there would turn a permission failure into a
  200 with forbidden content. Per-section loading uses `<Suspense>` around the
  data component (permission check runs first, in the page body → real 403).

## Catalog management (Step 5)

`/admin/products`, `/admin/categories`, `/admin/variants` — full management,
built on the Step 4 UI kit and Step 3 RBAC.

- **Products:** list (search / filter by status + category / sort / paginate),
  create, edit (tabbed: Details · Images · Variants), status
  (`DRAFT` / `ACTIVE` / `ARCHIVED`), archive, and delete (only when the product
  has no orders, reviews or wishlist entries — otherwise archive). Slugs are
  URL-safe, unique, stable, and auto-generated from the name.
- **Images:** uploaded to Supabase Storage (`products/` folder) via
  `manage_product_images`; `ProductImage.mediaAssetId` links the file, the
  lowest `sortOrder` is the primary image. Reorder / set-primary / delete /
  replace. `<ProductImage>` already renders real URLs, so the storefront needs
  no change.
- **Variants:** define option types (Colour / Size / Material / Style / …); the
  variant matrix is regenerated as the cartesian product. Per-variant SKU,
  price, compare-at and status. Variants with order history are archived, never
  deleted; a product always keeps ≥ 1 variant. `Variant.stock` stays 0 —
  inventory is Step 6.
- **Categories:** list, create, edit, image (Storage), display order (up/down
  + Save), `active` toggle (inactive = hidden from the storefront, products
  stay in the catalog), delete (only when empty).
- **Schema additions (all additive):** `Product.featured`, `Category.active`,
  `Category.imageMediaId`, `ProductImage.mediaAssetId`, `Variant.status`. SKU
  stays on the variant (every product has ≥ 1 variant); the product form's SKU
  field manages the default variant's SKU. Existing rows keep working. `src/lib/data.ts` now hides non-`ACTIVE` products and inactive
  categories from the storefront; mutations `revalidateTag("products"/"categories")`.
- Validation: `src/lib/admin/catalog-schemas.ts` (Zod) — required fields,
  lengths, non-negative integer-centavos prices, `compareAt > price`, slug
  shape, SKU shape, enum status. Enforced server-side in
  `src/lib/admin/catalog-actions.ts`; every mutation `requirePermission(...)`.

## Data model

`src/lib/data.ts` is the read layer (server-only); `src/lib/actions.ts` holds the
mutations (register, sign-in, validate coupon, place order, address CRUD).
Prices are integer centavos throughout; `formatPrice` renders PHP.

## Deploying to Vercel (Supabase Postgres)

1. **Create a Supabase project** (free tier). Set a database password when prompted.
2. **Grab the connection strings:** Supabase dashboard → **Connect** → **ORMs / Prisma**.
   - `DATABASE_URL` → **Transaction pooler**, port `6543`, append `?pgbouncer=true&connection_limit=1`
   - `DIRECT_URL` → **Session pooler / direct**, port `5432`
3. **Set Environment Variables** in Vercel (Project → Settings → Environment Variables, all environments):
   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | transaction-pooler string (`…:6543/postgres?pgbouncer=true&connection_limit=1`) |
   | `DIRECT_URL` | session-pooler / direct string (`…:5432/postgres`) |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://PROJECT_REF.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Settings → API → `anon` `public` |
   | `SUPABASE_SERVICE_ROLE_KEY` | Settings → API → `service_role` `secret` — **do not** prefix `NEXT_PUBLIC_` |
   | `NEXT_PUBLIC_SITE_URL` | your production URL, e.g. `https://shop.demo.noetikon.tech` (needed for correct auth email links) |
4. **Configure Supabase Auth** (see "Supabase Auth dashboard settings" above) — Site URL + Redirect URLs.
5. **Create the schema + seed data** once, from your machine (uses `DIRECT_URL`):
   ```bash
   npm run db:push && npm run db:seed && npm run db:seed:config && npm run db:seed:auth && npm run db:seed:rbac
   ```
   (Fill `.env` first — copy from `.env.example`.) On an existing database, just
   `npm run db:push && npm run db:seed:rbac` adds the RBAC tables + catalogue.
6. **Redeploy.** The build runs `prisma generate` automatically (`build` script + `postinstall`) and never connects to the database itself.

The build never connects to the database — every storefront route is
`force-dynamic` and renders on request. SQLite is not used anywhere; it cannot
run on Vercel's serverless filesystem.

### Local production build

```bash
npm run build && npm start
```
