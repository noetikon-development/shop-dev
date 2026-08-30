/**
 * Step 19 — Legal / storefront completion.
 *
 * The single source of truth for the AXIARO storefront's legal and
 * informational pages: Privacy, Terms, Shipping, Returns, Cancellation, About,
 * Contact and FAQ. Content is stored as CMS `ContentPage` rows (Step 16
 * architecture) so an administrator can edit any of it in /admin/content/pages
 * without a code change.
 *
 * IDEMPOTENT UPSERT: a page is created if missing, otherwise its title / body /
 * excerpt / SEO fields are refreshed to the values below. `publishedAt` is set
 * only on first creation, so the storefront's "Last updated" line tracks the
 * row's `updatedAt` (which only moves when this content or an admin actually
 * changes it — never on a page render).
 *
 * The copy is demo content written to match what the platform can actually do
 * today: PayMongo / online payment is NOT live, refunds are handled manually,
 * delivery is the Philippines only, and the shipping options are the three
 * configured ShippingMethod rows. It is not legal advice — a real launch must
 * have it reviewed by the business's own legal owner.
 *
 * Run on its own:  npm run db:seed:legal
 * Also runs as part of:  npm run db:seed:cms  and  npm run db:seed
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

export type LegalPageSeed = {
  slug: string;
  title: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  body: string;
};

const DEMO_NOTE =
  "> **Demo store.** AXIARO is a demonstration store. This page is sample copy that reflects how the platform currently works — it is not legal advice. Before any real commercial launch, the business owner must have this reviewed and adapted by a qualified professional.\n\n";

const PAYMENT_NOTE =
  "Online card, GCash and Maya payments are **not active on this store yet**. When you place an order it is recorded as *awaiting payment* and our team contacts you to arrange payment separately. No card or wallet details are collected or stored by the store.";

// ---------------------------------------------------------------------------

const PRIVACY = `${DEMO_NOTE}AXIARO ("we", "us", "the store") operates this online store. This policy explains what personal information we collect, why we collect it, how we use and protect it, and the choices you have. It applies to this website and the orders placed through it.

# Information we collect

## Account information
When you create an account we store your name, email address and a secure reference to your sign-in identity. Passwords are handled by our authentication provider and are never stored by the store itself.

## Contact information
The email address, and where you provide it the phone number, that you give us so we can send order updates and respond to support requests.

## Order information
The products you order, quantities, prices at the time of purchase, any discount code applied, your chosen delivery method, and the order's status history. Each order keeps its own immutable snapshot of these details.

## Address information
The delivery address, and billing address where different, that you enter at checkout or save to your account. Saved addresses stay in your account until you delete them.

## Authentication and session technology
We use cookies that are strictly necessary to keep you signed in and to keep your shopping cart and checkout working. These cannot be switched off without breaking core functionality.

## Website usage information
Basic technical information that your browser sends with every request — such as your device type and pages viewed — may be processed by our hosting provider to run the site securely and to diagnose faults. This demo store does not run advertising or cross-site tracking.

# How we use your information

- To process, fulfil and deliver your orders.
- To contact you about an order, including to arrange payment and delivery.
- To provide customer support and handle returns, refunds and cancellations.
- To maintain your account and order history.
- To keep the store secure, prevent fraud and abuse, and meet our record-keeping obligations.

We do not sell your personal information, and we do not use it for automated decision-making that produces legal effects.

# Service providers

We rely on a small number of providers to run the store: a cloud hosting and database provider, an authentication provider, and — once configured — an email delivery provider and a payment provider. These providers process data only on our instructions and only as needed to provide their service. Transactional email is currently in a record-only mode and no marketing email is sent.

# Data retention

We keep order and transaction records for as long as needed to fulfil the order and to meet tax and accounting requirements. Account information is kept until you ask us to delete your account. Support messages are kept only as long as needed to resolve your query.

# Security

Access to store data is restricted to authorised staff through role-based permissions. Connections to the site are encrypted in transit. Payment credentials are not collected or held by the store. No online service can be guaranteed perfectly secure, but we take reasonable technical and organisational measures to protect your information.

# Your rights

Depending on where you live, you may have the right to access the personal information we hold about you, to ask us to correct or delete it, to object to or restrict certain processing, and to receive a copy in a portable format. You can exercise these rights, or ask a question about this policy, using the contact details on our **[Contact us](/pages/contact)** page. We may need to verify your identity before acting on a request.

# Children

This store is intended for adults. We do not knowingly collect information from children.

# Changes to this policy

We may update this policy from time to time. The "Last updated" date at the top of the page shows when it last changed. Significant changes will be highlighted on this page.

# Contact

Questions about privacy or your data can be sent through our **[Contact us](/pages/contact)** page.`;

// ---------------------------------------------------------------------------

const TERMS = `${DEMO_NOTE}These Terms & Conditions govern your use of the AXIARO store and any order you place. By using the site or placing an order you agree to them. Please read them together with our **[Privacy policy](/pages/privacy)**, **[Shipping & delivery](/pages/shipping)**, **[Returns & refunds](/pages/returns)** and **[Cancellation policy](/pages/cancellation)**.

# Using this website

You may browse and shop for your own personal, non-commercial use. You agree not to misuse the site — for example by attempting to interfere with its security, scrape it at scale, or use it to break the law. We may suspend access if we reasonably believe the site is being misused.

# Your account

You are responsible for the accuracy of the information on your account and for keeping your sign-in credentials confidential. Tell us promptly if you think your account has been used without your permission. You must be able to form a legally binding contract to place an order.

# Product information

We describe our products as accurately as we can. Product illustrations on this demo store are an in-house graphic system rather than photographs, and colours can vary between screens. Minor variation in natural materials is normal and is not a fault.

# Pricing

Prices are shown in Philippine peso (₱) and, where applicable, include tax. The price you pay is the price shown at the time your order is placed. If we discover a genuine pricing error before we accept your order, we will contact you to confirm the correct price or cancel the order without charge.

# Product availability

All products are subject to availability. Stock shown on the site is indicative and can change while you are shopping. If an item becomes unavailable after you order, we will let you know and arrange a substitute where possible or cancel that item without charge.

# Orders and order acceptance

Submitting an order is an offer to buy. A confirmation screen or message acknowledges that we have received your order — it is not acceptance. We accept your order when we begin preparing it for dispatch (or, for store pickup, when we confirm it is ready). We may decline an order, for example where stock is unavailable, where we could not arrange payment, or where we suspect fraud.

# Payments

${PAYMENT_NOTE} Because payment is arranged after the order is placed, your order will show as *awaiting payment* until our team has confirmed it with you.

# Shipping and delivery

Delivery is within the Philippines only. Available methods, fees and estimated timeframes are set out on the **[Shipping & delivery](/pages/shipping)** page and shown again at checkout. Delivery estimates are not guarantees.

# Returns, refunds and cancellations

Your options for returning an item or cancelling an order are set out on the **[Returns & refunds](/pages/returns)** and **[Cancellation policy](/pages/cancellation)** pages. Refunds are processed manually by our team; automated online refunds are not available on this store.

# Promotions and discount codes

Discount codes are applied at checkout, cannot be exchanged for cash, and may be limited by time, by order value, by number of uses, or to one use per customer. We may withdraw a code or correct an error in how it was applied.

# Intellectual property

The AXIARO name, store design, text and graphics are owned by us or our licensors and may not be copied or reused without permission, except that you may keep a copy of your own order records.

# Limitation of liability

The store is provided on an "as is" basis. To the extent the law allows, we are not liable for indirect or consequential loss, or for loss caused by events outside our reasonable control. Nothing in these terms limits any liability that cannot be limited by law, including for death or personal injury caused by negligence, or for fraud. Your statutory consumer rights are not affected.

# Changes to these terms

We may update these terms. The version that applies to your order is the one published when you place it. The "Last updated" date shows when this page last changed.

# Contact

Questions about these terms can be sent through our **[Contact us](/pages/contact)** page.`;

// ---------------------------------------------------------------------------

const SHIPPING = `${DEMO_NOTE}This page explains how delivery works for AXIARO orders. The options and fees shown at checkout are always the current ones — if anything below differs from checkout, checkout is correct.

# Where we deliver

We deliver within the Philippines only. We are not able to ship internationally at this time.

# Delivery options

## Standard delivery
Estimated 3–7 business days after your order is prepared for dispatch. Fee: ₱150.

## Express delivery
Estimated 1–3 business days after your order is prepared for dispatch. Fee: ₱300.

## Store pickup
Free. Collect from our Batangas City location, usually ready in 1–2 business days. We will let you know when your order is ready to collect.

# Shipping fees

The exact fee for your order and address is calculated and shown at checkout before you confirm. **Standard delivery is free on orders of ₱2,500 or more** (before delivery fees). Store pickup is always free.

# Processing time

Orders are prepared for dispatch on business days. The delivery estimates above start once your order has been prepared, not from the moment you place it. Because payment is arranged after you order, preparation begins after payment has been confirmed with you.

# Delivery estimates

Timeframes are estimates, not guarantees. Weather, peak periods, courier delays and remote delivery areas can add time. If your order is significantly delayed, contact us and we will chase it up.

# Tracking

Once your order is handed to the courier, its status moves to *shipped* and — where the courier provides one — a tracking number and link are added to the order. You can check the current status any time on the **[Track your order](/track)** page using your order number and email, or from **[your account](/account/orders)** if you were signed in when you ordered.

# Incorrect or incomplete addresses

Please check your delivery address carefully. If a parcel is returned to us because the address was wrong or incomplete, or because no one was available to receive it after reasonable attempts, we will contact you to arrange redelivery. A further delivery fee may apply.

# Problems with a delivery

If your order arrives damaged, incomplete or incorrect, keep the packaging and contact us within a reasonable time — see the **[Returns & refunds](/pages/returns)** page.

# Contact

Delivery questions can be sent through our **[Contact us](/pages/contact)** page. Please include your order number.`;

// ---------------------------------------------------------------------------

const RETURNS = `${DEMO_NOTE}We want you to be happy with your order. This page explains when and how you can return an item and how refunds are handled on this store.

# Refunds on this store

Refunds are **processed manually by our team**. Automated or instant online refunds are not available, because online payment is not yet active on this store. Once a refund is agreed we arrange it with you directly and confirm when it has been sent.

# Return window

You can request a return within **30 days of delivery** (or of collection, for store pickup orders). Items must be unused, in a resaleable condition, and in their original packaging with any tags attached.

# Items that cannot be returned

- Made-to-order or personalised items.
- Clearance or final-sale items, unless they are faulty.
- Items that have been used, assembled beyond what is needed to inspect them, or damaged after delivery.

This does not affect your rights if an item is faulty or not as described.

# Damaged, faulty or incorrect items

If an item arrives damaged or faulty, or you received the wrong item, contact us within a reasonable time of delivery and include your order number and a photo where possible. We will arrange a repair, replacement or refund at no cost to you, including any return shipping.

# How to return an item

1. Contact us through the **[Contact us](/pages/contact)** page with your order number and which item(s) you want to return and why.
2. We will confirm whether the item is eligible and send you return instructions. For larger furniture we arrange collection; for smaller items we provide a return address.
3. Pack the item securely in its original packaging.
4. Hand it to the courier we arrange, or send it to the address we give you.

# Refund process and timing

Once we receive the returned item we inspect it, usually within 3–5 business days. If the return is approved we process the refund for the price of the item. Return shipping costs are refunded only where the item was faulty, damaged or incorrect. Because refunds are arranged manually, the time to reach you depends on the payment method used — we will keep you updated and confirm when it has been sent.

# Exchanges

We do not run automated exchanges. If you want a different size, colour or item, return the original for a refund and place a new order.

# Contact

Start a return, or ask a question, through the **[Contact us](/pages/contact)** page.`;

// ---------------------------------------------------------------------------

const CANCELLATION = `${DEMO_NOTE}This page explains when you can cancel an AXIARO order and what happens to any payment.

# Before your order is prepared for dispatch

You can cancel an order at no cost any time before it has been marked as *shipped* (or, for store pickup, before it is marked ready). Contact us through the **[Contact us](/pages/contact)** page with your order number and ask to cancel.

Because payment on this store is arranged after you order, in most cases nothing will have been paid yet and there is simply nothing to refund. If you had already arranged payment, we will arrange the refund with you — see below.

# After your order has shipped

Once an order has been handed to the courier it can no longer be cancelled. When it arrives you can use the **[Returns & refunds](/pages/returns)** process instead.

# Orders already delivered or collected

Delivered and collected orders are handled under the **[Returns & refunds](/pages/returns)** policy, not this one.

# Part-cancellations

If you want to remove only some items from an order that has not yet shipped, contact us — we can usually adjust the order and update what is owed.

# Payment and refund implications

- If no payment had been arranged: the order is simply cancelled, with nothing to refund.
- If payment had been arranged: we process the refund manually and confirm with you when it has been sent. Automated online refunds are not available on this store.
- Any discount code used on a cancelled order becomes available to use again, subject to its own conditions.

# If we cancel an order

We may cancel an order — for example where an item is out of stock, where a pricing error is found, or where payment could not be arranged. If this happens we will tell you and arrange a full refund of anything paid.

# Contact

To cancel an order, use the **[Contact us](/pages/contact)** page and include your order number.`;

// ---------------------------------------------------------------------------

const ABOUT = `# Our approach

AXIARO designs homeware and a small wardrobe in-house, works directly with a short list of makers, and skips the traditional retail markup. The aim is furniture and everyday pieces that are made to last and priced fairly.

# What we care about

- **Materials you can trace** — solid wood, natural fibres and honest hardware.
- **Repairable design** — covers that unzip, parts that can be replaced.
- **Fair pricing** — a real price, not an inflated "RRP" to discount from.

# How the store works

Browse the catalogue, add pieces to your bag, and check out with delivery or free store pickup. You can shop as a guest or create an account to save addresses, track orders and keep a wishlist. After you place an order our team contacts you to arrange payment, then prepares it for dispatch.

# About this store

AXIARO is a demonstration store built to showcase a complete e-commerce platform. Product imagery is an in-house illustration system rather than photography, and some details — such as company registration and a published payment method — are intentionally left for a real operator to configure. Store and contact details shown across the site are drawn from the store's own settings.

# Get in touch

Questions are welcome through our **[Contact us](/pages/contact)** page, and order updates are always on **[Track your order](/track)**.`;

// ---------------------------------------------------------------------------

const CONTACT = `# Get in touch

For anything about an existing order, check **[Track your order](/track)** first — it always has the latest status. If you were signed in when you ordered, your full history is in **[your account](/account/orders)**.

For everything else — a question before you buy, a return, a cancellation, or a problem with a delivery — use the contact details below. If you have an order number, please include it so we can help faster.

We aim to reply within one business day.

# What we can help with

- Questions about a product before you order
- Arranging payment for an order that is awaiting payment
- Delivery questions and delayed parcels
- Returns, refunds and cancellations
- Account and sign-in help

_AXIARO is a demonstration store. The contact details shown here come from the store's settings and can be updated by an administrator._`;

// ---------------------------------------------------------------------------

const FAQ = `# Ordering

## How do I place an order?
Add the items you want to your bag, open the bag and choose **Checkout**. Pick a delivery method (or free store pickup), confirm your address, review the order and place it. You will see a confirmation with your order number.

## Do I need an account?
No — you can check out as a guest. Creating an account lets you save addresses, track orders from **[your account](/account/orders)**, keep a wishlist, and leave reviews on items you have received.

## Can I change or cancel my order?
You can cancel at no cost any time before the order is marked as shipped — see the **[Cancellation policy](/pages/cancellation)**. To change items on an order that has not shipped, contact us and we will adjust it where we can.

# Payment

## What payment methods are available?
Online card, GCash and Maya payments are **not active on this store yet**. When you place an order it is recorded as *awaiting payment*, and our team contacts you to arrange payment. No card or wallet details are collected by the store.

## When am I charged?
Nothing is charged automatically. Payment is arranged with you after the order is placed and before it is prepared for dispatch.

# Shipping

## How does shipping work?
We deliver within the Philippines only. You can choose Standard delivery (₱150, about 3–7 business days), Express delivery (₱300, about 1–3 business days), or free store pickup in Batangas City. Standard delivery is free on orders of ₱2,500 or more. The exact fee is shown at checkout. Full details are on the **[Shipping & delivery](/pages/shipping)** page.

## How do I track my order?
Use the **[Track your order](/track)** page with your order number and email, or open **[your account](/account/orders)** if you were signed in. Once the courier has your parcel, a tracking link is added where available.

# Returns

## How do returns work?
You can request a return within 30 days of delivery for unused items in their original packaging. Contact us to start a return and we will send instructions. Refunds are processed manually by our team. Full details are on the **[Returns & refunds](/pages/returns)** page.

## What if my item arrives damaged?
Keep the packaging and contact us as soon as you can with your order number and a photo. We will arrange a repair, replacement or refund at no cost to you.

# Support

## How do I contact support?
Use the **[Contact us](/pages/contact)** page. Include your order number if your question is about an order. We aim to reply within one business day.`;

// ---------------------------------------------------------------------------

export const LEGAL_PAGES: LegalPageSeed[] = [
  {
    slug: "privacy",
    title: "Privacy policy",
    excerpt: "What personal information AXIARO collects, how it is used, and the choices you have.",
    seoTitle: "Privacy policy",
    seoDescription:
      "How AXIARO collects, uses, retains and protects your personal information, and how to exercise your rights.",
    body: PRIVACY,
  },
  {
    slug: "terms",
    title: "Terms & conditions",
    excerpt: "The terms that apply to using the AXIARO store and placing an order.",
    seoTitle: "Terms & conditions",
    seoDescription:
      "The terms governing use of the AXIARO store, orders, pricing, payment, delivery, returns and liability.",
    body: TERMS,
  },
  {
    slug: "shipping",
    title: "Shipping & delivery",
    excerpt: "Delivery options, fees, timeframes and tracking for AXIARO orders.",
    seoTitle: "Shipping & delivery",
    seoDescription:
      "AXIARO delivery options and fees: standard and express delivery within the Philippines, free store pickup, and order tracking.",
    body: SHIPPING,
  },
  {
    slug: "returns",
    title: "Returns & refunds",
    excerpt: "When you can return an item, how to do it, and how refunds are handled.",
    seoTitle: "Returns & refunds",
    seoDescription:
      "AXIARO returns policy: 30-day return window, how to return an item, faulty items, and how manual refunds are processed.",
    body: RETURNS,
  },
  {
    slug: "cancellation",
    title: "Cancellation policy",
    excerpt: "When an order can be cancelled and what happens to any payment.",
    seoTitle: "Cancellation policy",
    seoDescription:
      "How to cancel an AXIARO order before it ships, what happens after dispatch, and the payment and refund implications.",
    body: CANCELLATION,
  },
  {
    slug: "about",
    title: "About AXIARO",
    excerpt: "Why we make what we make, and how the store works.",
    seoTitle: "About AXIARO",
    seoDescription:
      "AXIARO designs homeware and a small wardrobe in-house, works directly with makers, and prices fairly. How the store works.",
    body: ABOUT,
  },
  {
    slug: "contact",
    title: "Contact us",
    excerpt: "How to reach the AXIARO team about an order or a question.",
    seoTitle: "Contact us",
    seoDescription:
      "Contact AXIARO about an order, a return, a cancellation or a question. We aim to reply within one business day.",
    body: CONTACT,
  },
  {
    slug: "faq",
    title: "Frequently asked questions",
    excerpt: "Ordering, payment, shipping, returns and support — answered.",
    seoTitle: "Frequently asked questions",
    seoDescription:
      "Answers to common questions about ordering from AXIARO: accounts, payment, delivery, tracking, returns and support.",
    body: FAQ,
  },
];

export async function seedLegalContent(
  prisma: PrismaClient,
  log: (m: string) => void = () => {},
) {
  let created = 0;
  let updated = 0;
  for (const p of LEGAL_PAGES) {
    const existing = await prisma.contentPage.findUnique({ where: { slug: p.slug } });
    if (existing) {
      await prisma.contentPage.update({
        where: { slug: p.slug },
        data: {
          title: p.title,
          excerpt: p.excerpt,
          body: p.body,
          seoTitle: p.seoTitle,
          seoDescription: p.seoDescription,
          status: "PUBLISHED",
          publishedAt: existing.publishedAt ?? new Date(),
        },
      });
      updated++;
    } else {
      await prisma.contentPage.create({
        data: {
          slug: p.slug,
          title: p.title,
          status: "PUBLISHED",
          excerpt: p.excerpt,
          body: p.body,
          seoTitle: p.seoTitle,
          seoDescription: p.seoDescription,
          publishedAt: new Date(),
        },
      });
      created++;
    }
  }
  log(`Legal/info content: ${created} page(s) created, ${updated} updated`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedLegalContent(prisma, (m) => console.log(m))
    .then(() => console.log("Legal/info content seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
