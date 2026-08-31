/**
 * Generates the 5 branded Supabase Auth email templates (Batch 3 Phase 2).
 *
 * Renders the canonical copy in `src/lib/email/templates/auth.ts` through the
 * shared Axiaro `layout()` shell, substituting Supabase's Go template tokens
 * (`{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}`). The output is
 * pasted verbatim into Supabase Dashboard → Authentication → Emails → Templates.
 *
 *   node --env-file=.env --import tsx scripts/gen-supabase-templates.ts            # print
 *   node --env-file=.env --import tsx scripts/gen-supabase-templates.ts --write    # write files to scratch
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  renderEmailVerification,
  renderPasswordReset,
  renderMagicLink,
  renderInvite,
  renderEmailChangeConfirm,
} from "../src/lib/email/templates/auth";

const BRAND = "Axiaro";
const SITE = "https://axiaro.shop";
const URL = "{{ .ConfirmationURL }}";
const EMAIL = "{{ .Email }}";
const NEW_EMAIL = "{{ .NewEmail }}";
// Go-template conditional: greets by first name when signup metadata carries one.
const NAME = "{{ if .Data.name }}{{ .Data.name }}{{ else }}there{{ end }}";

const templates = [
  {
    key: "confirm-signup",
    label: "Confirm signup",
    ...renderEmailVerification({ brand: BRAND, siteUrl: SITE, actionUrl: URL, recipient: NAME }),
  },
  {
    key: "reset-password",
    label: "Reset password",
    ...renderPasswordReset({ brand: BRAND, siteUrl: SITE, actionUrl: URL, recipient: NAME }),
  },
  {
    key: "magic-link",
    label: "Magic Link",
    ...renderMagicLink({ brand: BRAND, siteUrl: SITE, actionUrl: URL, recipient: NAME }),
  },
  {
    key: "invite",
    label: "Invite user",
    ...renderInvite({ brand: BRAND, siteUrl: SITE, actionUrl: URL, recipient: NAME }),
  },
  {
    key: "email-change",
    label: "Change Email Address",
    ...renderEmailChangeConfirm({
      brand: BRAND,
      siteUrl: SITE,
      actionUrl: URL,
      recipient: EMAIL,
      newEmail: NEW_EMAIL,
    }),
  },
];

const write = process.argv.includes("--write");
const outDir = "scripts/.supabase-templates";
if (write) mkdirSync(outDir, { recursive: true });

for (const t of templates) {
  // Safety: the rendered HTML must contain the action token verbatim and must
  // NOT contain a raw token/secret placeholder.
  const okUrl = t.html.includes("{{ .ConfirmationURL }}");
  const leak = /{{\s*\.Token(Hash)?\s*}}|service_role|sbp_|eyJ[A-Za-z0-9_-]{10}|smtp-brevo/i.test(t.html);
  console.log(`\n\n===== ${t.label}  (${okUrl ? "URL ok" : "!! URL MISSING"}${leak ? " !! LEAK" : ""}) =====`);
  console.log(`SUBJECT: ${t.subject}`);
  console.log(`----- HTML -----\n${t.html}`);
  if (write) {
    writeFileSync(`${outDir}/${t.key}.subject.txt`, t.subject + "\n");
    writeFileSync(`${outDir}/${t.key}.html`, t.html);
  }
}
if (write) console.log(`\n\nWrote ${templates.length} templates to ${outDir}/`);
