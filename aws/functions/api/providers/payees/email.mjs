/**
 * The payee setup email: the tenant's branding (email-branding.mjs, sent "via
 * ChecksOps" unless the tenant has a verified sender), the shared ChecksOps
 * layout, and the /pay-setup/:token link. It never names the payment provider,
 * and the link (the payee's only key) is never logged.
 */
import { renderChecksOpsEmail } from '../../email-layout.mjs';
import { PLATFORM_PRIMARY_COLOR } from '../../email-branding.mjs';

export const PAYEE_SETUP_TEMPLATE = 'payee-setup-link';

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
