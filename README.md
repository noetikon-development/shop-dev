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
  deleted; a product always keeps ≥ 1 variant. `Variant.stock` is a
  denormalised mirror driven by Step 6 inventory.
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

## Inventory management (Step 6)

`/admin/inventory` (list) and `/admin/inventory/history` (audit) — one
`Inventory` row per variant, gated by `view_inventory` / `manage_inventory`.

- **Stock list:** product · variant · SKU · on-hand · reserved · **available**
  (`quantity − reserved`) · reorder threshold · status · last updated. Search,
  filter by status, paginate. `IN_STOCK` / `LOW_STOCK` / `OUT_OF_STOCK` are
  **derived** (`src/lib/inventory-status.ts`), never stored — low when
  `available ≤ reorderPoint`, out when `available ≤ 0`.
- **Adjustments:** add / remove / set-exact, with a reason
  (`RESTOCK` · `MANUAL_ADJUSTMENT` · `DAMAGE` · `LOSS` · `RETURN` ·
  `CORRECTION` · `INITIAL_STOCK` · `SALE` — an open string, new reasons need
  no migration) and an optional note. The modal previews the new on-hand /
  available / status and asks for confirmation. Server-validated: whole
  numbers, never below 0, never below the reserved amount.
- **History:** append-only `InventoryAdjustment` (previous qty, signed delta,
  new qty, reason, note, actor, timestamp). Searchable / filterable /
  paginated via the Step 4 `DataTable`. Audit events
  `inventory.stock_adjusted` / `inventory.stock_corrected` /
  `inventory.threshold_updated`.
- **Primitives** (`src/lib/inventory.ts`, server-only): `getAvailableStock`,
  `adjustStock`, `setReorderPoint`, and the reservation foundation
  `reserveStock` / `releaseStock` / `commitStock`. Every write is a single
  condition-guarded atomic `UPDATE` (Postgres row-locks for its duration) or a
  `SELECT … FOR UPDATE` inside a transaction — concurrent callers serialise and
  cannot oversell. DB `CHECK` constraints (`quantity ≥ 0`, `reserved ≥ 0`,
  `quantity ≥ reserved`, `reorderPoint ≥ 0`) are the final backstop.
- **Storefront:** `Variant.stock` is a denormalised mirror of **available**,
  re-derived on every inventory write, so the product grid / PDP show In / Low /
  Out with no query changes. `placeOrder` records a `SALE` adjustment through
  `adjustStock` (inside its existing transaction) so `Inventory` stays the
  source of truth — the reservation primitives are **not** wired into checkout.
- **Reservation primitives are foundation only** — no customer reservation
  during checkout, no separate final deduction step. `reserved` is `0`
  everywhere today.

## Shopping cart & persistence (Step 7)

Database-backed cart. `src/lib/cart.ts` (server-only) owns all logic;
`src/lib/cart-actions.ts` is the only browser-facing surface;
`src/lib/cart-store.ts` (Zustand) mirrors server state and `<CartProvider>`
(in the storefront layout) drives hydration + the guest→customer merge.

- **Ownership is resolved server-side, every call.** Signed-in customer → the
  one ACTIVE `Cart` for their `userId`. Guest → the `Cart` whose opaque
  256-bit token matches the httpOnly `axiaro_cart` cookie. The browser never
  sends a cart id, item id or price — only a variant id and a quantity.
- **Every mutation re-validates**: variant exists, product + variant `ACTIVE`,
  variant belongs to the product, inventory row exists, and quantity is capped
  to `available = Inventory.quantity − Inventory.reserved`. Price and line
  totals are always read live from `Variant.price`. `CartItem.priceSnapshot`
  is a display cache, refreshed on write and never treated as authoritative.
- **A cart is not a reservation** — cart operations never touch
  `Inventory.reserved`. Stock reservation belongs to the future checkout step.
- **Guest → customer merge** (`mergeGuestCartCore`, run once on the first
  authenticated cart bootstrap, then the cookie is dropped): identical variants
  are combined (not duplicated), quantities are re-validated against live
  inventory and capped, and the customer is told what changed.
- **Actions:** `getCart`, `addToCart`, `updateCartItem`, `removeCartItem`,
  `clearCart`, `syncCart`/`mergeGuestCart`. No admin permissions — this is
  customer/guest functionality. No `AdminAuditLog` entries for shopping.
- **Schema (additive):** `Cart` (userId? / token? / status
  `ACTIVE|CONVERTED|ABANDONED` / timestamps) + `CartItem`
  (`@@unique([cartId, variantId])`, `priceSnapshot`). DB guards:
  partial unique index `one ACTIVE cart per userId`, `CHECK` (cart has an
  owner; `0 < quantity ≤ 99`; `priceSnapshot ≥ 0`). Concurrent adds of the
  same variant use an atomic `INSERT … ON CONFLICT DO UPDATE SET quantity =
  LEAST(…)`.
- **UI:** unchanged layout. `<CartButton>` count, `<CartDrawer>` and
  `/cart` all read the one store; unavailable / over-stock lines are flagged
  inline and excluded from the subtotal and from checkout.

## Customer addresses (Step 8)

`/account/addresses` — an authenticated customer manages multiple saved
addresses (add / edit / delete / set default). `src/lib/addresses.ts`
(server-only) owns the logic; `src/lib/address-actions.ts` is the browser
surface; `src/components/account/address-manager.tsx` is the UI.

- **Ownership is resolved server-side on every call** (`getCurrentUser()`).
  The browser never sends a userId or an ownership claim; an address id that
  isn't the caller's returns "not found" (no IDOR). Guests can't reach the
  page (middleware + `requireUser`) or the actions (they return a 401 result).
- **Model** (`Address`, evolved additively): `firstName` / `lastName` /
  `company?` / `phone` / `line1` / `line2?` / `barangay?` (PH) / `city` /
  `province` / `region?` (PH) / `postalCode` / `country` / `label` /
  `defaultShipping` / `defaultBilling` / timestamps. `recipient` is kept as a
  maintained `"firstName lastName"` denormalisation so the checkout prefill and
  the order address snapshot keep working unchanged. Flat field set — new
  fields can be added later without restructuring.
- **Country** is an ISO-3166-1 alpha-2 code validated against
  `src/lib/countries.ts` (Philippines only today; the form uses each country's
  own wording and phone / postal patterns). Extensible with a one-line add.
- **Independent defaults.** Setting a new default shipping (or billing) address
  unsets the previous default *of the same type only* in the same transaction;
  the other type is untouched. The same address can be both. Deleting a default
  auto-promotes the most recent remaining address.
- **DB integrity** (`20260830120000_address_step8.sql` +
  `20260829140100_rls_and_grants.sql` §8): partial unique indexes
  `at most one default shipping / billing per userId`, `CHECK` first/last name
  non-empty, `(userId, defaultShipping)` / `(userId, defaultBilling)` indexes,
  RLS on + no policy.
- **Deletion never destroys order history.** An address attached to a past
  order can't be deleted (clear error, edit instead); orders carry their own
  `shippingAddress` JSON snapshot regardless.
- **Server actions:** `getCustomerAddresses`, `createAddress`, `updateAddress`,
  `deleteAddress`, `setDefaultShippingAddress`, `setDefaultBillingAddress` —
  each resolves the customer, validates (Zod, server-side), verifies ownership,
  mutates, keeps default integrity, and returns the updated list. No admin
  permissions; no `AdminAuditLog` entries.

## Checkout & order creation (Step 9)

`/checkout` requires an authenticated customer (middleware + `requireUser`;
guests are redirected to sign in and returned afterwards). `src/lib/checkout.ts`
(server-only) owns it; `src/lib/checkout-actions.ts` is the browser surface;
`src/components/checkout/checkout-flow.tsx` is the UI (select saved shipping +
billing address, server-calculated summary, review-and-confirm).

- **The browser never sends items, prices or totals.** `createOrderFromCart`
  re-reads the customer's ACTIVE cart, re-validates every line (product +
  variant `ACTIVE`, belongs to product, live inventory ≥ quantity, live price),
  ownership-checks **both** selected addresses, and recalculates
  subtotal / shipping / total server-side.
- **One transaction, all-or-nothing:** atomic `Cart ACTIVE → CONVERTED`
  (the concurrency + double-submit gate) → `adjustStock(-qty, "SALE")` per line
  via the Step 6 primitive (row-locked, records an `InventoryAdjustment`, keeps
  `Variant.stock` in sync, can't oversell) → `Order` + `OrderItem`s + first
  `OrderEvent` → `soldCount`. Any failure rolls the lot back — no partial
  order, no deduction, cart stays `ACTIVE`. A second concurrent request finds
  the cart already converted (or hits `Order.cartId @unique`) and gets the
  order that was actually created.
- **No payment.** Orders are created `status: PENDING_PAYMENT`,
  `paymentStatus: PENDING`, `paymentMethod: NONE` and are never shown as paid.
  Payment is the next step.
- **Address + item snapshots.** `Order.shippingAddress` / `Order.billingAddress`
  store immutable JSON copies; editing the saved address later doesn't touch
  historical orders. `OrderItem` keeps name / variant label / SKU / unit price /
  line total.
- **Order numbers** come from a Postgres sequence (`order_number_seq`) —
  `AX-<YYMMDD>-<nnnnn>`, collision-free under concurrent checkout.
- Coupons and tax stay deferred; the `Order` fields for them remain.
- Order confirmation (`/order/[n]`) and account order pages
  (`/account/orders/[n]`) are ownership-checked server-side.

## Shipping & delivery foundation (Step 11)

A configurable delivery system that checkout and orders use now and courier APIs
can plug into later. No payment, courier integration or tracking is included.

- **`ShippingMethod` model** (`code` unique, `name`, `description`, `rate` in
  centavos with a DB `CHECK rate >= 0`, `currency`, `active`, `sortOrder`).
  Seeded demo methods: `STANDARD` ₱150, `EXPRESS` ₱300, `PICKUP` ₱0 — all
  editable in the admin, nothing hardcoded in checkout.
- **`src/lib/shipping.ts`** (server-only): `getActiveShippingMethods`,
  `resolveActiveShippingMethod` (returns `null` for an unknown or inactive id),
  `getSupportedShippingCountries` / `getFreeShippingThreshold` (from Store
  Settings `shipping.countries` / `shipping.freeThreshold`),
  `effectiveShippingFee` (free when the subtotal clears the threshold).
- **Checkout** (`src/components/checkout/checkout-flow.tsx`) lists the active
  methods; picking one re-asks the server for the summary. **The browser only
  ever submits `shippingMethodId`** — never an amount. `createOrderFromCart`
  re-resolves the method server-side, rejects an inactive/unknown one, rejects a
  shipping address whose country isn't in `shipping.countries`, and computes
  `grandTotal = subtotal + shippingAmount` (no fees, coupons or tax).
- **Order snapshot.** Every order stores `shippingMethodId` (live link,
  `SET NULL` if the method is later deleted) plus immutable `shippingMethodCode`
  / `shippingMethodName` / `shippingFee`. Renaming or repricing a method never
  changes historical orders.
- **Inventory is untouched** by shipping selection — no reserve, no deduct, no
  `SALE` adjustment. Orders still land `PENDING_PAYMENT`.
- **Admin → Shipping** (`/admin/shipping`, permission `view_shipping` /
  `manage_shipping` — both already in the RBAC catalogue): list, create, edit,
  activate / deactivate, reorder. Courier accounts, tracking numbers, delivery
  zones and fulfilment workflow are explicitly out of scope.
- Delivery zones are prepared for, not built: the store-wide
  `shipping.countries` list is the only destination check today.

The cart page keeps its own lightweight shipping **estimate**
(`src/lib/constants.ts` + `src/lib/pricing.ts`); the authoritative rate is always
the `ShippingMethod` record resolved at checkout.

## Data model

`src/lib/data.ts` is the read layer (server-only). Mutations: `validateCoupon`
in `src/lib/actions.ts`; addresses in `src/lib/addresses.ts`; cart in
`src/lib/cart.ts`; checkout / orders in `src/lib/checkout.ts`.
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
