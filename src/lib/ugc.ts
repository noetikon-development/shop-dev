/**
 * Shared helpers for user-generated content (reviews, questions, answers) —
 * Step 15. Pure module: safe to import from server actions AND client form
 * components, so the limits shown in the UI and the limits enforced on the
 * server can never drift apart.
 *
 * Rendering safety: every surface renders this text as plain React children
 * (never dangerouslySetInnerHTML), so React escapes it. cleanUserText is a
 * second layer — it strips control characters and normalises whitespace so a
 * stored value cannot carry hidden payloads or break layout.
 */

export const REVIEW_LIMITS = {
  titleMax: 120,
  bodyMin: 10,
  bodyMax: 4000,
} as const;

export const QUESTION_LIMITS = {
  bodyMin: 10,
  bodyMax: 2000,
} as const;

export const ANSWER_LIMITS = {
  bodyMin: 2,
  bodyMax: 4000,
} as const;

/** Drop C0/C1 control characters, keeping only TAB (9) and LF (10). */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10) {
      out += ch;
    } else if (code < 32 || (code >= 127 && code <= 159)) {
      // skip
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Normalise a free-text field: strip control chars (except tab/newline), collapse
 * runs of blank lines, trim trailing spaces per line and trim the whole string.
 * Does NOT attempt to "sanitise HTML" — callers render the result as text.
 */
export function cleanUserText(input: unknown): string {
  if (typeof input !== "string") return "";
  return stripControlChars(input.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type LengthCheck = { ok: true; value: string } | { ok: false; error: string };

export function checkLength(
  raw: unknown,
  { min, max, label }: { min: number; max: number; label: string },
): LengthCheck {
  const value = cleanUserText(raw);
  if (value.length < min) {
    return { ok: false, error: `${label} must be at least ${min} characters.` };
  }
  if (value.length > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer.` };
  }
  return { ok: true, value };
}
