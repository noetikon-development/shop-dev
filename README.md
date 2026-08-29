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
npm run db:seed              # demo catalogue + application User rows
npm run db:seed:config       # inventory + store settings
npm run db:seed:auth         # demo accounts in Supabase Auth + link to User rows
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
   npm run db:push && npm run db:seed && npm run db:seed:config && npm run db:seed:auth
   ```
   (Fill `.env` first — copy from `.env.example`.)
6. **Redeploy.** The build runs `prisma generate` automatically (`build` script + `postinstall`) and never connects to the database itself.

The build never connects to the database — every storefront route is
`force-dynamic` and renders on request. SQLite is not used anywhere; it cannot
run on Vercel's serverless filesystem.

### Local production build

```bash
npm run build && npm start
```
