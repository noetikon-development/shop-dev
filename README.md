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
npm run db:seed:cms          # homepage blocks + demo content pages (create-if-missing)
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
| Product detail | `/p/[slug]` | gallery, variant selection (colour × size), stock-aware, moderated reviews + rating summary, product Q&A, related |
| Cart | `/cart` + slide-over drawer | quantity, coupon, free-shipping progress |
| Checkout | `/checkout` | guest or signed-in; contact / address / delivery / payment; server-side re-pricing in `placeOrder` |
| Order confirmation | `/order/[orderNumber]` | |
| Order tracking | `/track` | public, by order number + email; status timeline |
| Accounts | `/account`, `/account/orders`, `/account/orders/[n]`, `/account/addresses`, `/account/wishlist` | auth-guarded |
| Wishlist | `/account/wishlist` | server-persisted per customer (`/wishlist` redirects) |
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

## Admin order management (Step 12)

`/admin/orders` (list) and `/admin/orders/[id]` (detail), built on the Step 4 UI
kit and guarded by the Step 3 `view_orders` / `manage_orders` permissions — no
new permission, no new status system.

- **List** (`src/lib/admin/orders.ts` → `listAdminOrders`): server-side paginated
  (20/page), searchable by order number / customer name / email, filterable by
  order status, payment status and date range, sortable by date / total /
  recently-updated. The browser never receives the full order set.
- **Detail** (`getAdminOrder`): order info, customer, items, totals, shipping and
  billing — all from the **immutable snapshots** on `Order` / `OrderItem`
  (name, SKU, unit price, line total, address JSON, shipping method code/name/fee,
  totals). The current Product / ShippingMethod / Address records are never read
  to represent a historical order. Plus the full `OrderEvent` timeline.
- **Status transitions** (`src/lib/admin/order-actions.ts` → `updateOrderStatusAction`,
  `src/lib/orders/status.ts`): every move is validated server-side against
  `canTransition`; the client can only post a status, and the guard re-loads the
  order's real status before an atomic conditional `UPDATE`. **An admin can never
  set `PAID`** — payment confirmation is the deferred payment step and there is
  no manual payment mechanism. `PENDING_PAYMENT` therefore has no forward move in
  the admin today (only cancellation).
- **Cancellation** (`cancelOrderAction`): confirmation dialog → `manage_orders`
  check → atomic status gate (`PENDING_PAYMENT` / `PENDING` / `PROCESSING` only)
  → for every `SALE` `InventoryAdjustment` the order recorded, one reversing
  `CANCELLATION` adjustment through the existing row-locked `adjustStock` (never
  `Variant.stock` directly, never a duplicate) → `soldCount` decremented (never
  below zero) → `OrderEvent`. Pre-Step-9 orders have no `SALE` rows, so nothing is
  restocked for them.
- Every status change and cancellation writes both an `OrderEvent` (customer
  timeline) and an `AdminAuditLog` entry (acting admin, previous/new status,
  reason). `paymentStatus` is display-only and is never modified here.
- Not in scope: PayMongo, payments, refunds, courier APIs, tracking numbers,
  fulfilment automation, `PACKED` / `REFUNDED` statuses.

## Fulfilment, courier & tracking (Step 13)

Extends order management with a courier / tracking foundation. Still no second
status system — the "fulfilment status" is `Order.status`
(`SHIPPED → OUT_FOR_DELIVERY → DELIVERED`) — and still `view_orders` /
`manage_orders`, no new permission.

- **`Order` fields:** `courier` (a code from `src/lib/orders/couriers.ts`),
  `courierName` (display snapshot / custom text for "Other"), `trackingNumber`,
  `trackingUrl` (HTTPS-only), `shippedAt`, `deliveredAt` (both server-set),
  `fulfillmentNote` (internal — never shown to the customer or on public
  tracking).
- **`src/lib/orders/couriers.ts`** — plain config, not a model: J&T, LBC, Ninja
  Van, Flash, Lalamove, Store Pickup, Other. Optional `trackingUrlTemplate`
  (used only to auto-fill a URL when the admin gives a tracking number and no
  URL). `isSafeTrackingUrl` rejects anything but a plain `https:` URL
  (`javascript:` / `data:` / `http:` / relative all fail). A future courier-API
  layer attaches by `code` — no schema change.
- **`src/lib/admin/fulfillment-actions.ts`** — `updateFulfillmentAction` (edit
  courier / tracking / URL / internal note, no status change),
  `markShippedAction` (PROCESSING → SHIPPED, requires courier + tracking unless
  Store Pickup, sets `shippedAt`), `markOutForDeliveryAction` (SHIPPED →
  OUT_FOR_DELIVERY), `markDeliveredAction` (→ DELIVERED, sets `deliveredAt`;
  rejects an already-delivered order). Each: `manage_orders`, re-reads the real
  status, atomic status-guarded `updateMany`, `OrderEvent` + `AdminAuditLog`.
  Timestamps are always `new Date()` on the server.
- **PENDING_PAYMENT can't ship** — `canTransition` has no path into a fulfilment
  status from it, and `markShippedAction` refuses it explicitly. Payment stays
  deferred; no order is marked `PAID` by hand.
- **Store Pickup** (`shippingMethodCode === "PICKUP"`) skips SHIPPED /
  OUT_FOR_DELIVERY entirely: PROCESSING → DELIVERED ("Mark as collected"). No
  courier or tracking fields are shown or required. The timeline uses a shorter
  ladder.
- **Customer tracking** (`/account/orders/[n]`, confirmation page) gains a
  Delivery / Pickup card: courier, tracking number, safe tracking link, shipped
  / delivered dates. Ownership checks unchanged.
- **Public tracking** (`/track`) now requires the order number **and** the
  checkout email, and renders a dedicated PII-free view
  (`src/components/order/public-tracking.tsx` + `getPublicTracking`): status,
  fulfilment, item names + quantities, timeline. No email, phone, address,
  billing, prices, internal note, or free-text event detail.
- The admin order list shows courier + tracking under the status badge (no extra
  column) and search matches the tracking number.

## Coupons & discounts (Step 14)

A reusable coupon system. **The discount is always calculated server-side** — the
browser only ever submits a coupon *code*; validity, the discount amount, the
subtotal and the total are recomputed on the server at cart-apply and again at
checkout.

- **`Coupon` model** (extended): `code` (canonical UPPERCASE, unique),
  `description`, `type` (`PERCENT` / `FIXED`), `value`, `minSubtotal`,
  `maxDiscount` (caps a %), `startsAt` / `expiresAt`, `usageLimit` (global),
  `perCustomerLimit`, `active`, `archivedAt`, `createdAt` / `updatedAt`. The
  lifecycle **state** (Draft / Scheduled / Active / Expired / Disabled /
  Archived) is *derived* — no second status column.
- **`CouponRedemption` model** (new): one row per successful application
  (`couponId`, `userId`, `orderId` unique, `code` + `amount` snapshot). This is
  the authoritative record for usage limits — `Coupon.usedCount` is just a loose
  mirror.
- **`src/lib/coupons.ts`** (pure): `normalizeCouponCode`, `COUPON_CODE_RE`,
  `couponState`, and `evaluateCoupon(coupon, subtotal, now)` — the one discount
  evaluator. It clamps: never negative, never more than the subtotal (so the
  final subtotal can’t go below zero); the discount applies to the **merchandise
  subtotal only** — shipping is untouched (Step 11 rules unchanged).
- **Cart** (`Cart.couponCode`): the applied code is persisted server-side so it
  survives reloads and carries to checkout. `loadCart` returns a server-evaluated
  `coupon` (code, discount, valid, error). `applyCartCouponCore` /
  `removeCartCouponCore` back the existing promo field on the cart page and a new
  one on checkout.
- **Checkout** (`createOrderFromCart`): re-reads `Cart.couponCode`, re-evaluates
  against the recalculated subtotal + server clock, then — **inside the order
  transaction** — takes `SELECT … FOR UPDATE` on the `Coupon` row and COUNTs
  `CouponRedemption`s whose order isn’t `CANCELLED`, enforcing the global and
  per-customer limits **race-safely** (two concurrent last-use checkouts: one
  succeeds, one is rejected and rolled back). It writes the redemption row + the
  order snapshot in the same locked section.
- **Order snapshot** (§13): every order keeps `couponCode`, `discountType`,
  `discountValue` and `discountTotal`. Editing, disabling or deleting the coupon
  later never changes a historical order.
- **Cancellation** (Step 12, unchanged): a cancelled order’s redemption row stays
  for audit but stops counting toward the limits — the customer’s entitlement is
  freed, not lost.
- **Admin** `/admin/marketing/coupons` (list / create / edit / activate /
  deactivate / archive / detail with redemption history) — `view_coupons` /
  `manage_coupons`, no new permission.
- **Not in scope**: free-shipping coupons (`FREESHIP`-type coupons are rejected
  this step), product/category targeting, BOGO, tiered promotions, loyalty
  points.

## Reviews, wishlist & Q&A (Step 15)

Customer-generated content, all moderated. **The server never trusts the browser**
for the reviewer id, the verified-purchase flag, the review status, the answer
author, or another customer's order.

- **`Review` model** (extended): `+ orderId` (the DELIVERED order that establishes
  the verified purchase — server-set, `SET NULL` on order delete), `+ status`
  (`PENDING` / `APPROVED` / `REJECTED` / `ARCHIVED`, default **PENDING**),
  `+ updatedAt`, and indexes on `status` / `(productId,status)` / `userId`. One
  review per customer per product (`@@unique([productId, userId])`, pre-existing).
- **Verified purchase** (`src/lib/reviews.ts` → `reviewEligibility`): a customer
  may review a product only if their account has a `DELIVERED` order containing
  it. The query is scoped to the authenticated `userId`, so another customer's
  order can't be used.
- **Public reads** (`src/lib/data.ts`): `getProductReviews` and `getReviewSummary`
  (average / count / 1–5 distribution) are computed from **APPROVED rows only** —
  never a browser-supplied summary. `getProductReviews` shows verified purchases
  first. The curated `Product.ratingAvg` / `ratingCount` merchandising columns
  (used by the product-list sort/filter) are intentionally left untouched — see
  the Step 15 report, item 19.
- **Editing** (`src/lib/review-actions.ts`): a customer edits only their own
  review; an edit sets it **back to PENDING** so changed text is re-moderated
  before it is public again. A customer may delete their own review (genuine
  removal); admin moderation uses `ARCHIVED` instead, so history stays auditable.
- **Wishlist** — stored in **PostgreSQL** (`WishlistItem`, `@@unique([userId,
  productId])`), never `localStorage`. `src/lib/wishlist.ts` (`loadWishlist`,
  `toggleWishlist`) is always scoped to the authenticated user (no IDOR).
  `src/lib/wishlist-store.ts` is a thin client mirror of the id set for instant
  heart toggles, hydrated once per page by `<WishlistHydrator>` from the server.
  A guest heart tap prompts sign-in. Archived / inactive products stay in the
  wishlist but render an "unavailable" state and can't be bought. The page moved
  to **`/account/wishlist`** (`/wishlist` redirects).
- **Q&A** — `ProductQuestion` (customer question, moderated) + `ProductAnswer`
  (`authorType` `STORE` → shown as **"AXIARO Team"**, or `CUSTOMER`; `authorId`
  is the authenticated author). `src/lib/qa.ts` `getPublicQA` returns APPROVED
  questions with their APPROVED answers only. Customers ask, edit/delete their
  own still-PENDING questions, and see their own submissions with status.
- **Admin** — `/admin/reviews` (list / search / filter by status·rating·verified
  / paginate / approve·reject·archive / detail) and `/admin/reviews/questions`
  (moderate questions, post official answers as AXIARO Team, edit/archive
  answers). Reuses `view_reviews` / `manage_reviews` — no new permission. Every
  mutation writes an `AdminAuditLog` entry (`review.approved` / `.rejected` /
  `.archived`, `question.*`, `answer.created` / `.updated` / `.archived`).
- **Not in scope**: review/question notification emails (Step 17), review photos,
  helpful-votes, seller responses to reviews, spam scoring.

## Full CMS & store settings (Step 16)

Completes the Step 4 foundation so a store admin can run AXIARO without code
changes. **No new models** — everything reuses `ContentPage`, `ContentBlock`,
`MediaAsset`, `StoreSetting` and Supabase Storage.

- **Store settings** (`/admin/settings`) — editable grouped forms (identity,
  contact, business, regional, social, SEO). Keys + types live in
  `src/lib/admin/settings-registry.ts`; `src/lib/admin/settings-actions.ts`
  validates every value by its declared type (https-only URLs, valid emails,
  numeric bounds, media ids must exist) and writes **only registered keys**.
  Reads for the storefront go through `src/lib/site-settings.ts` (cached, tag
  `settings`). Sensitive credentials stay in env vars — never in the table.
- **Branding** — `store.logoMediaId` / `store.faviconMediaId` (blank = the
  built-in AXIARO mark / icon, so the demo is unchanged). `<Logo>` takes an
  optional `src`; the root layout sets `<link rel=icon>` from the favicon
  setting.
- **Homepage** (`/admin/content/homepage`) — the homepage is a list of typed
  `ContentBlock`s (`hero`, `category_tiles`, `product_rail`, `feature_grid`,
  `value_props`, `rich_text`) with reorder / publish / draft. Product rails
  reference **product IDs / category slugs only** — names and prices always come
  from `Product`. Block payloads are Zod-validated on write and on read (a bad
  row is skipped, never rendered). If no blocks are published the storefront
  falls back to the built-in homepage.
- **Content pages** (`/admin/content/pages`) — standalone pages at
  `/pages/<slug>` with title / slug / Markdown body / SEO fields /
  draft·published. Body is rendered by `src/lib/markdown.tsx` **to React
  elements** — no `dangerouslySetInnerHTML`, no HTML passthrough, link schemes
  restricted to internal / https / mailto. The footer links to these pages when
  they're published.
- **Media library** (`/admin/media`) — search / folder / type filters,
  pagination, alt-text editing, copy-URL, and a reusable `<MediaPickerField>`.
  Uploads are validated server-side by **magic bytes** (not the browser's MIME
  type); **SVG is rejected**; PNG/JPG/WEBP/GIF/PDF only; ≤ 8 MB; object paths are
  slug + time-prefixed with `upsert:false` (no overwrite / traversal). Deletes
  are blocked while an asset is referenced by a product, category, content block
  or setting.
- **SEO** — `seo.indexable` drives `robots.txt`; `seo.defaultTitle` /
  `titleTemplate` / `defaultDescription` / `ogImageMediaId` feed the root
  `generateMetadata`. `sitemap.xml` now includes published content pages.
- **Caching** — settings writes `revalidateTag("settings")`; content writes
  `revalidateTag("content")`. Storefront updates within a minute, no redeploy.
- **RBAC** — reuses `view_content` / `manage_content` (content + media) and
  `view_settings` / `manage_settings` (settings). ADMIN has `view_settings` but
  **not** `manage_settings` — settings writes require `manage_settings`
  server-side. Every mutation is audited (`settings.updated`, `content.page_*`,
  `content.block_*`, `media.*`).
- **Seed** — `scripts/seed-cms.ts` (`npm run db:seed:cms`) creates the homepage
  blocks (reproducing the built-in homepage) and demo pages (About, Contact,
  FAQ, Shipping, Returns, Care + Privacy/Terms/Cookies/Cancellation clearly
  marked **demo content, not legal advice**). Non-destructive: create-if-missing.

## Transactional email (Step 17)

Server-side transactional email, provider-agnostic over SMTP. **All SMTP code
lives in `src/lib/email/` — never in a route or action.**

- **Provider** — nodemailer over SMTP. Works with any transactional provider
  (Resend, SendGrid, Postmark, Mailgun, SES, plain relay). Config comes from
  `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USER` / `EMAIL_PASSWORD` / `EMAIL_FROM` /
  `EMAIL_FROM_NAME` / `EMAIL_REPLY_TO` — **server-only, never `NEXT_PUBLIC_`**.
  If host/user/password aren't all set (or `EMAIL_MODE=log`), every email is
  **recorded in `EmailLog` with status `SKIPPED` and not sent** — no credentials
  are invented. The AXIARO demo runs in this mode.
- **Service** — `src/lib/email/notifications.ts`: `sendOrderConfirmation`,
  `sendOrderShipped`, `sendOrderDelivered`, `sendOrderCancelled`,
  `sendWelcomeEmail`, plus `sendRefundNotification` and
  `sendEmailVerification` / `sendPasswordReset` as **foundation only** (not
  wired — Supabase Auth owns verification/reset). Each loads the authoritative
  record, renders a template (`src/lib/email/templates/*` — subject + HTML +
  plain text, warm-neutral email-safe markup, every dynamic value `esc()`-aped),
  and hands it to `dispatchEmail`.
- **Idempotency** — `EmailLog.idempotencyKey` is UNIQUE. Keys are deterministic:
  `ORDER_CREATED:<id>`, `ORDER_SHIPPED:<id>`, `ORDER_DELIVERED:<id>`,
  `ORDER_CANCELLED:<id>`, `WELCOME:<userId>`. `dispatchEmail` claims the key with
  `createMany({ skipDuplicates:true })` before sending — a retry / refresh /
  repeated callback can never send twice.
- **Failure isolation** — `dispatchEmail` never throws; a provider error is
  recorded (`status FAILED`, truncated reason, no secrets) and swallowed. Order
  creation and status transitions are already committed — email is a side effect.
  Dispatch runs in `after()` so the customer/admin isn't blocked.
- **Triggers** — order confirmation from `createOrderFromCart` (after commit,
  `duplicate:false` only); shipment/delivery from the Step 13 fulfilment actions
  after the atomic transition; cancellation from the Step 12 `cancelOrderAction`;
  welcome from `syncAppUser` when a brand-new `User` row is created. All
  server-side, keyed off the real business event — never a frontend click.
- **Payment wording** — orders are `PENDING_PAYMENT`; the confirmation says
  *"your order has been received"* and *"this is not a payment confirmation"*.
  Nothing claims payment succeeded. Cancellation never claims a refund.
- **Admin** — `/admin/email` (permission `view_audit_logs`) lists every attempt
  (type, recipient, order, status, error, created/sent) — **no message bodies**.
  A FAILED / SKIPPED row can be retried, reusing its idempotency key.
- **Links** — built from `getSiteUrl()` (`NEXT_PUBLIC_SITE_URL` → prod domain).
  Customer order links go to `/account/orders/<n>` (authenticated) or `/track`.

## Analytics & reporting (Step 18)

Database-backed store analytics at **`/admin/analytics`** (permission
`view_analytics` — granted to SUPER_ADMIN, ADMIN, FINANCE). Read-only: nothing on
this page mutates an order, product, customer, coupon or stock level.

- **Data source** — `User` / `Order` / `OrderItem` / `Product` / `Category` /
  `Coupon` / `CouponRedemption` / `Inventory`, aggregated in the database
  (`COUNT` / `SUM` / `GROUP BY`, `prisma.aggregate` / `groupBy` and a few
  parameterised `$queryRaw` group-bys). No rows are pulled into memory to be
  totalled. No analytics-only tables. Three additive indexes were added for the
  group-bys: `User.createdAt`, `OrderItem.productId`, `CouponRedemption.createdAt`.
- **Date range** (`src/lib/analytics/range.ts`) — Today / Yesterday / Last 7 /
  Last 30 / This month / Last month / Custom. Boundaries are **midnight-to-midnight
  in the store timezone** (`regional.timezone`, default `Asia/Manila`), resolved
  server-side — the browser clock is never used. Ranges are **half-open
  `[start, end)`**. Custom ranges are capped at 366 days; invalid input is
  rejected (`400` on export, safe default on the dashboard).
- **Metrics** — Orders / Order value (gross · discounts · shipping · net) /
  Average order value / Units sold / Order status breakdown / Best-selling
  products / Category performance / Customer metrics / Coupon usage / Inventory
  insights + low-stock report. Every figure comes from the immutable per-order
  snapshots (`grandTotal`, `discountTotal`, `shippingFee`, `OrderItem.lineTotal`,
  `CouponRedemption.amount`) — never recomputed from current prices/coupons/rates.
  Definitions are shown on the page and documented in
  `src/lib/analytics/queries.ts`.
- **"Included" order** — `placedAt` in range **and** `status <> CANCELLED`. This
  is the set behind every sales metric. Cancelled orders appear only in the
  status breakdown and a separate count.
- **Paid revenue** — `SUM(grandTotal) WHERE paymentStatus = 'PAID'`, shown
  **separately** from order value and **never** labelled as revenue elsewhere.
  Payment capture (PayMongo) is still deferred, so no automated flow sets `PAID`;
  the figure reflects only orders reconciled as paid by an admin or the seed. It
  is never inferred from order creation.
- **Currency** — `regional.currency` / `regional.locale` via `Intl.NumberFormat`
  (`src/lib/analytics/format.ts`). Money is integer centavos summed in the DB and
  divided by 100 only for display. Multi-currency is not implemented — every
  amount is in the single store currency, so an aggregate never mixes currencies.
- **Comparison** — optional "vs previous equivalent period". A zero previous
  period shows **"N/A"**, never "∞%".
- **Charts** — dependency-free SVG (`src/components/admin/analytics/`), responsive,
  with hover/focus tooltips and a visually-hidden data table. Order-count and
  order-value trends are labelled as such — never "Revenue".
- **Export** — server-generated CSV (`/admin/analytics/export`, same
  `view_analytics` gate, its own `403`): product sales, coupon usage, orders by
  day, customer summary (aggregated — no personal data).

## Legal & storefront completion (Step 19)

Finishes the customer-facing storefront. No redesign — the AXIARO header, footer
and product pages are unchanged in appearance.

- **Legal / informational pages** — Privacy, Terms, Shipping, Returns,
  Cancellation, About, Contact and FAQ live as CMS `ContentPage` rows and are
  editable in `/admin/content/pages` without a code change. Their canonical
  content is `scripts/seed-legal-content.ts` (`npm run db:seed:legal`, an
  idempotent upsert; also runs from `db:seed:cms` and `db:seed`). Copy matches
  what the platform actually does today: online payment is not active (orders are
  *awaiting payment*), refunds are handled manually, delivery is the Philippines
  only, and the three configured `ShippingMethod` rows. A "Last updated" line on
  each page reflects the row's `updatedAt` (never changes on render). Legal pages
  carry a demo disclaimer and must be reviewed by the business before a real
  launch.
- **Contact page** — `/pages/contact` renders a details panel built from Store
  Settings (`contact.email` / `contact.phone` / address / `contact.hours` /
  social links). Nothing is hardcoded; unconfigured rows are hidden and a
  fallback points at order tracking. Never shows an internal admin address.
- **SEO** — every storefront route now emits `<link rel="canonical">` (home,
  `/c/*`, `/p/*`, `/pages/*`, `/promotions`). `robots.txt` / `sitemap.xml` and
  the per-page titles/descriptions from Steps 16/18 are unchanged.
- **Storefront polish** — PDP image gallery thumbnails carry product-scoped
  `aria-label`s and `aria-pressed`; the main image has an accessible name; the
  non-functional "Size guide" button was removed; PDP shipping copy now reads the
  `STANDARD_SHIPPING_FEE` / `FREE_SHIPPING_THRESHOLD` constants instead of a stale
  literal; the footer "Returns" link label matches the page title; the footer
  first-order prompt reveals the real `WELCOME10` code instead of implying an
  email was sent; a branded `(shop)/error.tsx` boundary was added.
- **Markdown renderer** — `src/lib/markdown.tsx` now recurses into `**bold**` /
  `*italic*` so a link or code span inside emphasis renders (previously shown
  raw). Still React-element output only — no HTML passthrough.

## Online payments — PayMongo Hosted Checkout (Phase 6A: architecture only)

The store takes **cash / pay-on-delivery only** today. Online card / e-wallet
payment is being built in phases against **PayMongo Hosted Checkout** in
**TEST mode**. **Phase 6A wired the configuration + client foundation and this
documentation. No payment flow, no payment UI, and no customer redirect exist
yet** — those are Phase 6B onward.

### Target architecture

```
Axiaro checkout (server action)
  └─ createOrderFromCart  → Order (PENDING_PAYMENT) + Payment (PENDING), server-authoritative totals
       └─ createCheckoutSession(order)  → PayMongo POST /checkout_sessions (TEST)
            └─ redirect customer to session.checkout_url
                 └─ customer pays on PayMongo's hosted page
                      └─ return to /order/<n>  (display only — NEVER marks paid)
                      └─ POST /api/webhooks/paymongo  ← the authoritative confirmation
                           └─ verify HMAC signature → claim event id → re-read our
                              Payment/Order → validate amount+currency → Order PAID
```

### Server-only modules (`src/lib/payments/`)

| File | Role | Phase 6A state |
| --- | --- | --- |
| `config.ts` | `getPaymentsConfig()` — merges `payments.*` store settings + env presence; centralises the **API base + version** (`paymongoApiBase()`, default `https://api.paymongo.com/v2`, HTTPS-enforced, `PAYMONGO_API_BASE` override); derives test/live from the `sk_test_` / `sk_live_` key prefix; `modeMismatch` guard | active (returns feature = **off**) |
| `diagnostics.ts` | `getPaymongoDiagnostics()` — booleans/enums only, **no network, no secret**; for a future admin diagnostics view. Real connectivity is first proven in Phase 6B session creation | new in 6A |
| `paymongo.ts` | `verifyWebhookSignature()` (used); `createCheckoutSession` / `getCheckoutSession` / `createRefund` — **dormant**, throw `PaymongoNotConfiguredError` with no key | dormant |
| `status.ts` | `Payment.status` state machine + label/tone maps + `HANDLED_WEBHOOK_TYPES` (incl. `checkout_session.payment.paid`) | design present |
| `webhook.ts` | `processPaymongoWebhook()` — signature-first, event-id claim (idempotency), amount/currency re-validation, order transition, audit + email. Currently: fails 401 (no webhook secret) or records + `IGNORED` (feature off) | dormant |
| `refund.ts` | `refundRouteForOrder()` — always `"bookkeeping"` while online payment is off (P3 returns unchanged) | dormant |

Webhook route: `src/app/api/webhooks/paymongo/route.ts` — `POST` only, Node runtime,
`force-dynamic`, excluded from the auth middleware (`src/proxy.ts` — it is
authenticated by HMAC, not a session), reads the **raw** body verbatim, caps at
512 KB, never logs the body / signature / any secret.

### Environment variables (server-only — never `NEXT_PUBLIC_`)

| Name | Purpose | Phase 6A |
| --- | --- | --- |
| `PAYMONGO_SECRET_KEY` | API auth (`Basic base64(key:)`). `sk_test_…` only for now | **not set** in any environment |
| `PAYMONGO_WEBHOOK_SECRET` | HMAC key for `Paymongo-Signature` verification (created in Phase 6C) | **not set** |
| `PAYMONGO_API_BASE` | optional override / version pin (default already v2) | not set |

Set them per Vercel environment (**Development / Preview / Production** are
independent). **Production must not receive a live key until a later, explicitly
approved stage.** A `sk_live_` key while `NODE_ENV !== "production"`, or a key
whose prefix disagrees with the `payments.mode` setting, **hard-disables** online
payment (`modeMismatch`).

### Test / live separation

`sk_test_…` → TEST · `sk_live_…` → LIVE. `detectKeyMode()` reads the prefix;
`getPaymentsConfig().detectedMode` / `.modeMismatch` surface it. The master
switch `onlinePaymentEnabled` is true only when **all** hold: the
`payments.onlinePaymentEnabled` setting is on **and** both secrets are present
**and** `!modeMismatch`. In Phase 6A it is always false.

### Order ↔ Checkout Session correlation

- **Primary key:** Axiaro `Order.orderNumber` (`AX-YYMMDD-NNNNN`, from the
  `order_number_seq` Postgres sequence — deterministic, unique) → PayMongo
  `reference_number`.
- **Back-reference:** `Payment.providerId` (`ps_…`) stores the session id; the
  webhook looks up the `Payment` by `providerId` (plus any nested payment id),
  then re-reads `Payment.order`. Email is **never** a correlation key.
- **Metadata** (PayMongo `metadata`, ≤ the provider's key limit): `order_number`,
  `order_id`, `payment_id` — identifiers only. No name, address, phone, or line
  detail duplicated into the provider.

### Checkout Session payload (Phase 6B — design)

| Field | Source |
| --- | --- |
| `line_items[].amount` / total | **server** — recomputed by `createOrderFromCart` from the ACTIVE cart; a client total is never trusted |
| `currency` | `PHP` (single store currency) |
| `line_items` | `OrderItem` snapshots (name, quantity, unit `amount`) + one line for shipping |
| billing email | `Order.email` (= authenticated `user.email`) |
| `reference_number` | `Order.orderNumber` |
| `metadata` | `{ order_number, order_id, payment_id }` |
| `success_url` | `${SITE_URL}/order/${orderNumber}` (display only) |
| `cancel_url` | `${SITE_URL}/checkout?cancelled=1` |
| `payment_method_types` | from `payments.enabledMethods` minus `COD` (e.g. `card`, `gcash`) |
| `Idempotency-Key` | deterministic per order+attempt so a retried create is a no-op |

### Webhook flow (Phase 6C — design; handler already written)

Authoritative event: **`checkout_session.payment.paid`** (also `payment.paid`
as a fallback). Never mark an order paid because the customer reached
`success_url`. Steps, all in `webhook.ts`:

1. **HTTPS required**, else 400.
2. **Verify `Paymongo-Signature` HMAC** against the raw body *before* any parse
   or DB write — fails closed with no webhook secret.
3. **Claim the event id** — `WebhookEvent.providerId` is `@unique`;
   `createMany({ skipDuplicates: true })`. A duplicate delivery returns `200`
   without repeating the mutation. A known id with a different `payloadHash` is
   logged (tamper signal) and still `200`.
4. **Unknown / unhandled type** → record + `IGNORED`, `200` (provider stops
   retrying).
5. **Feature disabled** → record + `IGNORED`, no state change.
6. **Dispatch** → re-read our `Payment` + `Order`, verify `amount` **and**
   `currency` **and** `order.grandTotal` match our snapshot, then transition
   `Order` `PENDING_PAYMENT → PAID` (→ `PROCESSING` unless
   `payments.holdForReview`), write an `OrderEvent`, an audit row, and schedule
   the confirmation email. Handler errors are recorded (`FAILED`) and answered
   `200` so the provider does not retry-storm — a `FAILED` `WebhookEvent` is
   visible in `/admin/payments` for manual reconciliation.

### Payment-state mapping

`Payment.status` (`src/lib/payments/status.ts`, model already in the schema):

| State | Meaning | Set by |
| --- | --- | --- |
| `PENDING` | row created, no session yet | session-create step (6B) |
| `AWAITING_PAYMENT` | hosted session created, customer paying | session-create step (6B) |
| `PAID` | verified webhook: money captured | webhook only |
| `FAILED` | verified webhook: declined (order stays `PENDING_PAYMENT`, customer may retry) | webhook only |
| `EXPIRED` | session TTL elapsed unpaid | webhook only |
| `CANCELLED` | order cancelled before payment | admin cancel path |
| `REFUND_PENDING` / `PARTIALLY_REFUNDED` / `REFUNDED` | P3 return refund lifecycle | webhook / refund path (6D) |

`Order.status` gains no new values — `PENDING_PAYMENT` (exists) is "awaiting
payment"; `PAID` (exists) is set only from a verified webhook. `Order.paymentStatus`
(`PENDING | UNPAID | PAID | PARTIALLY_REFUNDED | REFUNDED`) is display-only and
webhook-written.

### Idempotency

- **Webhook:** `WebhookEvent.providerId` unique + `payloadHash` — see step 3 above.
- **Session create:** deterministic `Idempotency-Key` per order (+ attempt).
- **Order transition:** `updateMany({ where: { status: "PENDING_PAYMENT" } })` —
  a second delivery that beats the dedup finds `count === 0` and no-ops.
- **Email:** `EmailLog.idempotencyKey` unique (`PAYMENT_PAID:<orderId>` etc.).
- **`Payment` "one active per order":** partial unique index
  `payment_one_active_per_order` (in `supabase/migrations/…_rls_and_grants.sql`).

### Security boundaries

- Secret key + webhook secret are **server-only env vars** — never in source,
  Git, seed files, the schema, the CMS, a `NEXT_PUBLIC_` var, a client bundle, a
  log line, or an error message. `authHeader()` throws `PaymongoNotConfiguredError`
  (no value) if the key is missing.
- The webhook is the **only** thing that can mark an order paid. A browser
  redirect to `success_url` is display-only.
- The PayMongo `amount` is always the **server-recomputed** order total.
- Webhook signature is verified before any parse; the raw body is read verbatim
  and never re-serialised.
- Payload logging: only coarse reasons / ids in production — never full payment
  payloads or personal data.

### Not implemented in Phase 6A (deliberately)

Session creation call · any change to `createOrderFromCart` · a `Payment` row
being created · the checkout UI showing a PayMongo button or redirecting · a
webhook secret in any environment · a live key anywhere · a health-check route ·
any schema, order, pricing, inventory, coupon, shipping, StoreSetting, CMS or
auth change · any customer-visible behaviour difference. **The build produces no
PayMongo network call during normal browsing and creates no payment records.**

## Data model

`src/lib/data.ts` is the read layer (server-only). Mutations: coupons in
`src/lib/coupons.ts` + `src/lib/admin/coupon-actions.ts`; addresses in
`src/lib/addresses.ts`; cart in `src/lib/cart.ts`; checkout / orders in
`src/lib/checkout.ts`; reviews in `src/lib/review-actions.ts` +
`src/lib/admin/review-actions.ts`; wishlist in `src/lib/wishlist-actions.ts`;
Q&A in `src/lib/qa-actions.ts` + `src/lib/admin/question-actions.ts`.
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
   | `NEXT_PUBLIC_SITE_URL` | your production URL, e.g. `https://axiaro.shop` (needed for correct auth email links) |
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
