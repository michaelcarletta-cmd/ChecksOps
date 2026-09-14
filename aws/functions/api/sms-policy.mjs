/**
 * Class A SMS recipient policy.
 * Telnyx live delivery is LEGACY_UNUSED (owner-retired). Default mode = sink
 * (audit only). AWS_SMS_MODE=live|telnyx still means "allowlisted sink/live
 * policy" for the generic SMS handler — it does not call Telnyx.
 */
const DEFAULT_ALLOWLIST = [
  '+15555550100', // staging sink sentinel
];

export const smsMode = () => {
  const mode = String(process.env.AWS_SMS_MODE || 'sink').trim().toLowerCase();
  if (mode === 'live' || mode === 'telnyx') return 'live';
  return 'sink';
};

export const smsSinkNumber = () => String(
  process.env.AWS_SMS_SINK_NUMBER || '+15555550100',
).trim();

export const smsAllowlist = () => {
  const raw = String(process.env.AWS_SMS_ALLOWLIST || '').trim();
  const extras = raw ? raw.split(',').map((n) => normalizePhone(n)).filter(Boolean) : [];
  return [...new Set([...DEFAULT_ALLOWLIST.map(normalizePhone), ...extras])];
};

export const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return String(phone).startsWith('+') ? `+${digits}` : `+${digits}`;
};

export const applySmsRecipientPolicy = (toNumber) => {
  const original = normalizePhone(toNumber);
  const mode = smsMode();
  const allowed = smsAllowlist().includes(original);
  if (mode === 'sink' || !allowed) {
    return {
      to: smsSinkNumber(),
      originalTo: original,
      delivery: 'sink',
      blocked: !allowed,
      policy: mode === 'sink' ? 'staging_sms_sink' : 'staging_rewritten_non_allowlist',
    };
  }
  return {
    to: original,
    originalTo: original,
    delivery: 'live',
    blocked: false,
    policy: 'staging_sms_allowlist',
  };
};
