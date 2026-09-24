# Category taxonomy — design policy

Axiaro's `Category` table (`prisma/schema.prisma`) is a self-referential tree
(`parentId` / `parent` / `children`) with no hard depth limit at the schema
level. This document records the *deliberate* policy the application layer
currently enforces on top of that — not a technical limitation, a decision.

## Current policy: 2 levels — Department → Category

The taxonomy is intentionally kept to exactly two levels for the current
marketplace phase:

- **Department** — a top-level `Category` (`parentId: null`), e.g. `Living`,
  `Bedroom`, `Technology & Electronics`.
- **Category** — a direct child of a Department, e.g. `Sofas & Seating` under
  `Living`.

This is enforced by convention in the storefront and admin UI, not by a
schema constraint:

- [`/categories`](../src/app/(shop)/categories/page.tsx) renders each
  department and only its direct children — deliberately, by design (see the
  comment at the top of that file).
- [`/c/[slug]`](<../src/app/(shop)/c/[slug]/page.tsx>) shows one parent level
  in its breadcrumb and one level of child "chips".
- The primary navigation's resolved shape
  (`ResolvedNavItem` / `ResolvedNavChild` in `src/lib/types.ts`) has **no
  third level in its type at all** — a nav item's children cannot themselves
  have children.

A future 3rd level is technically possible (the schema and the core query
helpers — `getCategoryTree()`, `descendantCategoryIds()` in `src/lib/data.ts`
— already walk to arbitrary depth), but requires deliberate review of all
three surfaces above before it's introduced. Don't add a 3rd level by
accident just because the schema allows it.

## Navigation vs. taxonomy — kept separate on purpose

- **The complete taxonomy** lives entirely in the `Category` table.
  [`/categories`](../src/app/(shop)/categories/page.tsx) reads
  `getCategoryTree()` directly and is the complete, unfiltered category
  discovery surface — every active department and category appears there
  automatically, with no navigation change required.
- **The primary navigation** (`nav.primary` CMS `ContentBlock`, resolved by
  `getResolvedNav()` in `src/lib/navigation.ts`) is a *curated, selective*
  subset — an editor chooses which departments appear in the header and in
  what order. Adding a new department to the database does **not**
  automatically add it to the header nav, and doesn't need to.

Keep it this way: don't wire `/categories` to read from the nav block, and
don't make the mega-menu try to render the full tree.

## Depth belongs to the taxonomy, not to products

When a department's catalog needs finer distinctions than "Department →
Category" gives you, prefer a **product attribute or facet**
(`Product.specs`, badges, filters) over reflexively adding a 3rd category
level. A category level should represent a genuine browsing destination
customers navigate *to*; an attribute should represent something they filter
*by* on a listing they're already viewing. Mixing the two — e.g. turning a
color or material into a leaf category — is a taxonomy smell to avoid.

## Category-cycle prevention

Category re-parenting is validated in
[`updateCategory()`](../src/lib/admin/catalog-actions.ts) via
[`categoryWouldCreateCycle()`](../src/lib/admin/catalog.ts), which walks the
proposed parent's ancestor chain up to the root and rejects the change if it
ever reaches the category being edited — catching a cycle at **any depth**
(self, direct child, or any deeper descendant), not just one level. The
admin parent-picker (`categorySelectOptions()`, same file) independently
excludes the edited category and its entire subtree from the dropdown, for
the same reason. Both remain correct if the taxonomy ever grows past 2
levels — they don't assume the current depth.

## Explicitly open (not decided by this document)

The following are known, real questions this policy does **not** resolve —
don't infer an answer from anything above:

- The `Technology & Electronics` department currently has 5 subcategories
  and 0 products.
- Nav labels `"Kitchen + Dining"` / `"Bags + Accessories"` use `+`, while the
  underlying `Category.name` values use `&` (`"Kitchen & Dining"` /
  `"Bags & Accessories"`).
- Whether a `Product` should ever be assignable to more than one category
  (`Product.categoryId` is currently a single, mandatory foreign key).
- A category-specific attribute/facet schema, for departments whose products
  need very different fields (e.g. Electronics specs vs. Fashion sizing).
- A slug-collision policy as more departments are added (`Category.slug` is
  globally unique, not scoped per parent).
- Adding any new departments or categories to the live taxonomy.
