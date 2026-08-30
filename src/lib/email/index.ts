/**
 * Transactional email (Step 17). Import notification triggers from here.
 * SMTP calls happen ONLY inside this module — never scattered across routes /
 * actions. Configuration comes from server-side EMAIL_* environment variables.
 */
export {
  sendOrderConfirmation,
  sendOrderShipped,
  sendOrderDelivered,
  sendOrderCancelled,
  sendWelcomeEmail,
  sendRefundNotification,
  sendEmailVerification,
  sendPasswordReset,
} from "@/lib/email/notifications";
export { isEmailConfigured, getEmailConfig } from "@/lib/email/config";
export type { DispatchResult, EmailType } from "@/lib/email/send";
