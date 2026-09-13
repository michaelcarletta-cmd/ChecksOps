/**
 * Compatibility barrel for audited outbound email.
 * Canonical implementation lives in email.mjs so stacked overlays are not required.
 */
export {
  EMAIL_SEND_LOG_STATUSES,
  emailSendLogStatusFromMailer,
  withEmailLogSavepoint,
  logEmail,
  findIdempotencyRow,
  claimIdempotencyKey,
  finalizeClaimedLog,
  replayIdempotentSend,
  stableEmailIdempotencyKey,
  validatedMailReplyTo,
  peekAuditedEmail,
  deliverAuditedEmail,
  copyIdentityGucs,
  withDurableAuditClient,
} from './email.mjs';
