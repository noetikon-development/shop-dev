/**
 * Shared contact-form constants and types (Step 21 P5). Pure module — safe to
 * import from the `"use server"` action AND the client form component, so the
 * limits shown in the UI and enforced on the server never drift.
 */

export const CONTACT_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  emailMax: 160,
  subjectMin: 3,
  subjectMax: 160,
  messageMin: 10,
  messageMax: 4000,
} as const;

export type ContactFieldName = "name" | "email" | "subject" | "message";

export type ContactFormState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<ContactFieldName, string>>;
};
