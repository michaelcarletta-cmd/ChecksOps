/**
 * Gated endorsement parity helpers.
 * Production stays sink / no-auto-advance until the activation flags are set.
 * Resend is called directly (api.resend.com). Not SES. Not Supabase Edge.
 */
import { loadProviderSecrets } from './provider-secrets.mjs';
import { isAllowlistedRecipient, normalizeEmail } from './email-policy.mjs';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

export const INELIGIBLE_AUTO_ADVANCE_STATUSES = new Set([
  'deposited',
  'voided',
  'returned',
  'cancelled',
  'funds_released',
  'disbursed_externally',
]);

export const endorsementResendEnabled = () => (
  String(process.env.AWS_ENDORSEMENT_RESEND_ENABLED || '').trim().toLowerCase() === 'true'
);

export const endorsementAutoAdvanceEnabled = () => (
  String(process.env.AWS_ENDORSEMENT_AUTO_ADVANCE || '').trim().toLowerCase() === 'true'
);

export const endorsementResendAllowAnyRecipient = () => (
  String(process.env.AWS_ENDORSEMENT_RESEND_ALLOW_ANY_RECIPIENT || '').trim().toLowerCase() === 'true'
);

export const allowDepositAdvance = (newStatus = 'approved_for_deposit') => ({
  depositAdvanceDenied: false,
  advance_check_on_endorsement_complete: newStatus === 'approved_for_deposit' ? 'applied' : newStatus,
  newStatus,
  readyForDeposit: newStatus === 'approved_for_deposit',
  approvedForDeposit: newStatus === 'approved_for_deposit',
  paymentDirectionTriggered: false,
});

export const loadResendApiKey = async (loadSecrets = loadProviderSecrets) => {
  const fromEnv = String(process.env.RESEND_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const secrets = await loadSecrets();
    const fromSecret = String(secrets?.RESEND_API_KEY || secrets?.RESEND_KEY || '').trim();
    return fromSecret || null;
  } catch {
    return null;
  }
};

/** Approved platform fallback when the tenant has no verified sending domain. */
export const PLATFORM_ENDORSEMENT_FROM = 'ChecksOps <notify@checksops.com>';

/**
 * Reuse resolveEmailBranding() output. Verified tenant custom From wins.
 * Unverified / unconfigured tenants use the ChecksOps platform fallback.
 * Does not apply a global Freedom or RESEND_FROM_EMAIL override.
 */
export const endorsementFromAddress = (resolved = {}) => {
  if (resolved.usingCustomFrom && String(resolved.from || '').trim()) {
    return String(resolved.from).trim();
  }
  return PLATFORM_ENDORSEMENT_FROM;
};

export const resendFromAddress = (brandingFrom) => {
  if (String(brandingFrom || '').trim()) return String(brandingFrom).trim();
  return PLATFORM_ENDORSEMENT_FROM;
};

export const isSuccessfulEndorsementDelivery = (result, { injected = false } = {}) => {
  if (injected && (result == null || result === undefined)) return true;
  if (result && result.ok === false) return false;
  if (result && (result.status === 'failed' || result.deliveryFailed === true)) return false;
  if (result && String(result.mode || '').toLowerCase() === 'resend') {
    const failed = (result.results || []).some((row) => row.status === 'failed');
    return Number(result.deliveredCount || 0) > 0 && !failed;
  }
  if (endorsementResendEnabled() && result && String(result.mode || '').toLowerCase() === 'sink') {
    return false;
  }
  return true;
};

export const sendViaResend = async ({
  to,
  cc = [],
  subject,
  html,
  text,
  from,
  replyTo,
  headers = {},
  fetchImpl,
  apiKey,
  loadSecrets,
} = {}) => {
  const key = apiKey || await loadResendApiKey(loadSecrets);
  if (!key) {
    throw new Error('RESEND_API_KEY not configured');
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .map((value) => normalizeEmail(value))
    .filter(Boolean);
  if (!recipients.length) {
    throw new Error('Missing payee email address');
  }

  let ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : []))
    .map((value) => normalizeEmail(value))
    .filter((value) => value && !recipients.includes(value));

  if (!endorsementResendAllowAnyRecipient()) {
    if (recipients.some((email) => !isAllowlistedRecipient(email))) {
      throw new Error('endorsement_recipient_not_allowlisted');
    }
    ccList = ccList.filter((email) => isAllowlistedRecipient(email));
  }

  const payload = {
    from: resendFromAddress(from),
    to: recipients,
    subject,
    html,
    text,
  };
  if (replyTo) payload.reply_to = replyTo;
  if (ccList.length) payload.cc = ccList;
  if (headers && Object.keys(headers).length) payload.headers = headers;

  const fetchFn = fetchImpl || fetch;
  const response = await fetchFn(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.message || body?.error || `Resend ${response.status}`;
    throw new Error(String(message).slice(0, 240));
  }

  return {
    mode: 'resend',
    provider: 'resend',
    messageId: body.id || null,
    deliveredCount: recipients.length,
    sunkCount: 0,
    results: recipients.map((email) => ({
      to: email,
      status: 'sent',
      delivery: 'resend',
      messageId: body.id || null,
    })),
  };
};
