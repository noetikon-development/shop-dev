/**
 * Desktop mega-menu overflow containment (9F-navigation-audit follow-up) —
 * a focused test for the single-class fix in
 * src/components/header/mega-menu.tsx, proportionate to the size of the
 * change itself.
 *
 * The actual overlap/page-overflow behavior was verified live in a real
 * browser during implementation (getBoundingClientRect / scrollWidth
 * measurements at 1280px and at 14/20 synthetic items — see the task's own
 * report) — that is not repeatable here without a browser, so this file
 * checks the static wiring that PRODUCES that verified behavior: the exact
 * class is present, nothing that would defeat it was removed, and the
 * surrounding files this task was explicitly told not to touch remain
 * untouched.
 *
 *   node --env-file=.env --import tsx scripts/test-mega-menu-overflow.ts
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function staticTests() {
  const megaMenu = read("src/components/header/mega-menu.tsx");

  ok(
    "mega-menu · the primary <nav> carries overflow-x-auto (containment) alongside min-w-0 (lets it shrink to its allotted space)",
    /className="-ml-2 hidden min-w-0 items-center overflow-x-auto xl:flex"/.test(megaMenu),
  );
  ok(
    "mega-menu · min-w-0 was not accidentally dropped (it's what lets the flex row actually shrink, without it overflow-x-auto has nothing to contain)",
    /min-w-0/.test(megaMenu),
  );
  ok(
    "mega-menu · a keyboard-focused item scrolls into view within the nav's own scroll box (onFocus on the <nav> itself, so it covers plain links and dropdown triggers alike without touching their own handlers)",
    /onFocus=\{scrollFocusedIntoView\}/.test(megaMenu) && /scrollIntoView\(\{ inline: "nearest", block: "nearest" \}\)/.test(megaMenu),
  );
  ok(
    "mega-menu · dropdown panels remain position:absolute (unchanged — they escape the new scroll container via the <header>'s containing block, not clipped by it)",
    /className="absolute inset-x-0 top-full/.test(megaMenu),
  );
  ok(
    "mega-menu · item-order logic untouched (still a plain nav.items.map, no added sort/slice/filter)",
    /nav\.items\.map\(\(item\) => \{/.test(megaMenu) && !/nav\.items\.(sort|slice|filter)\(/.test(megaMenu),
  );
  ok(
    "mega-menu · aria-haspopup / aria-expanded / aria-controls all still present (unchanged)",
    /aria-haspopup="true"/.test(megaMenu) && /aria-expanded=\{expanded\}/.test(megaMenu) && /aria-controls=\{panelId/.test(megaMenu),
  );
  ok(
    "mega-menu · onMouseLeave / openPanel / closePanel wiring untouched (hover behavior unchanged)",
    /onMouseLeave=\{closePanel\}/.test(megaMenu) && /onMouseEnter=\{.*openPanel/.test(megaMenu) && /onFocus=\{.*openPanel/.test(megaMenu),
  );

  // Files this task was explicitly told not to modify.
  const untouched = execSync("git diff --name-only -- src/components/header/mobile-menu.tsx src/components/header/site-header.tsx src/lib/navigation.ts src/lib/nav-defaults.ts", {
    cwd: new URL("..", import.meta.url),
  }).toString().trim();
  ok(
    "scope · mobile-menu.tsx / site-header.tsx / navigation.ts / nav-defaults.ts remain unmodified in the working tree",
    untouched === "",
    `git reports changes in: ${untouched || "(none)"}`,
  );
}

function main() {
  console.log("\nDesktop mega-menu overflow containment — tests\n");
  staticTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
