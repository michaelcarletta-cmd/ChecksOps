/**
 * The payee setup email: the tenant's branding (email-branding.mjs, sent "via
 * ChecksOps" unless the tenant has a verified sender), the shared ChecksOps
 * layout, and the /pay-setup/:token link. It never names the payment provider,
 * and the link (the payee's only key) is never logged.
 */
import { renderChecksOpsEmail } from '../../email-layout.mjs';
import { PLATFORM_PRIMARY_COLOR } from '../../email-branding.mjs';
import { isAllowlistedRecipient, normalizeEmail } from '../../email-policy.mjs';
import { endorsementFromAddress, loadResendApiKey } from '../../endorsement-parity.mjs';

export const PAYEE_SETUP_TEMPLATE = 'payee-setup-link';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/**
 * Sends the setup email through Resend, the provider the API already uses for
 * endorsement email (the SES path, sendViaSesOrSink, only sinks: neither stack
 * grants SES send). A production payee deployment emails the payee; anywhere
 * else only an allowlisted address (email-policy.mjs) is emailed and any other
 * is reported 'blocked', so staging never mails a real person. The sender is
 * the tenant's verified custom From, else the platform endorsement From.
 * Returns the sendViaSesOrSink result shape ({ mode, results: [{ status }] });
 * the body carries the link, so nothing here is logged and no error message is
 * passed on.
 */
export async function sendPayeeSetupEmail({
  to, subject, html, text, branding = {}, production = false, fetchImpl, loadSecrets,
} = {}) {
  const email = normalizeEmail(to);
  if (!email) return { mode: 'resend', results: [{ status: 'failed', reason: 'missing_email' }] };
  if (!production && !isAllowlistedRecipient(email)) {
    return { mode: 'resend', results: [{ status: 'blocked', reason: 'recipient_not_allowlisted' }] };
  }
  const key = await loadResendApiKey(loadSecrets);
  if (!key) return { mode: 'resend', results: [{ status: 'failed', reason: 'resend_not_configured' }] };
  const payload = { from: endorsementFromAddress(branding), to: [email], subject, html, text };
  if (branding.replyTo) payload.reply_to = branding.replyTo;
  const response = await (fetchImpl || fetch)(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return { mode: 'resend', results: [{ status: 'failed', reason: `resend_${response.status}` }] };
  const body = await response.json().catch(() => ({}));
  return { mode: 'resend', results: [{ status: 'sent', messageId: body?.id ?? null }] };
}

export function renderPayeeSetupEmail({ payeeName, payerName, setupUrl, expiresText, branding = {} } = {}) {
  const payer = payerName || 'A ChecksOps customer';
  const layout = renderChecksOpsEmail({
    title: 'Set up how you get paid',
    preview: `${payer} wants to pay you`,
    greeting: payeeName ? `Hi ${payeeName},` : 'Hi,',
    paragraphs: [
      `${payer} uses ChecksOps to send payments and wants to pay you by direct deposit.`,
      'Use the secure link below to confirm your identity and add the bank account where you want to be paid. You do not need a ChecksOps login.',
      'Your details go straight to our regulated payments partner. ChecksOps never stores your full Social Security number, tax ID or bank account number.',
      'If you were not expecting this, you can ignore this email.',
    ],
    ctaLabel: 'Set up payment details',
    ctaUrl: setupUrl,
    fallbackUrl: setupUrl,
    expiresText: expiresText || 'This link expires in 14 days.',
    companySubtitle: branding.companySubtitle || null,
    primaryColor: branding.primaryColor || PLATFORM_PRIMARY_COLOR,
    logoUrl: branding.logoUrl || null,
  });
  return { subject: `${payer} wants to pay you: set up your payment details`, ...layout };
}
