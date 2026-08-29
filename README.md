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

Runs on **Supabase Postgres** (or any Postgres host).

```bash
cp .env.example .env         # then fill in DATABASE_URL / DIRECT_URL / AUTH_SECRET
npm install
npm run db:push              # create the schema in Supabase
npm run db:seed              # load demo catalogue + accounts
npm run dev                  # http://localhost:3000
```

Re-seed at any time (wipes + reloads demo data): `npm run db:seed`.

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
   | `AUTH_SECRET` | output of `npx auth secret` (or `openssl rand -base64 33`) |
   | `NEXT_PUBLIC_SITE_URL` | your production URL, e.g. `https://axiaro.vercel.app` (optional) |
4. **Create the schema + seed data** once, from your machine (uses `DIRECT_URL`):
   ```bash
   npm run db:push     # creates all tables in Supabase
   npm run db:seed      # loads the demo catalogue + accounts
   ```
   (Fill `.env` first — copy from `.env.example`.)
5. **Redeploy.** The build runs `prisma generate` automatically (`build` script + `postinstall`) and never connects to the database itself.

The build never connects to the database — every storefront route is
`force-dynamic` and renders on request. SQLite is not used anywhere; it cannot
run on Vercel's serverless filesystem.

### Local production build

```bash
npm run build && npm start
```
