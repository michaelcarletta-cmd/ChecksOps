/**
 * Staging-safe email recipient policy.
 * Default mode = sink (log only, never deliver to real production customers).
 * Optional SES mode only delivers to allowlisted domains / exact addresses.
 */

const DEFAULT_ALLOWLIST_DOMAINS = [
  'checksops.invalid',
  'checksops.com',
  'freedomadj.com',
];

const DEFAULT_ALLOWLIST_EXACT = [
  'staging-master@checksops.invalid',
  'mcarletta@freedomadj.com',
  'checksops-tester@freedomadj.com',
];

export const emailMode = () => {
  const mode = String(process.env.AWS_EMAIL_MODE || 'sink').trim().toLowerCase();
  if (mode === 'ses' || mode === 'sink' || mode === 'log') return mode === 'log' ? 'sink' : mode;
  return 'sink';
};

export const allowlistDomains = () => {
  const raw = String(process.env.AWS_EMAIL_ALLOWLIST_DOMAINS || '').trim();
  if (!raw) return DEFAULT_ALLOWLIST_DOMAINS;
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
};

export const allowlistExact = () => {
  const raw = String(process.env.AWS_EMAIL_ALLOWLIST_EXACT || '').trim();
  const extras = raw ? raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_ALLOWLIST_EXACT, ...extras])];
};

export const sinkAddress = () => String(
  process.env.AWS_EMAIL_SINK_ADDRESS || 'staging-sink@checksops.invalid',
).trim().toLowerCase();

export const defaultFromAddress = () => String(
  process.env.AWS_EMAIL_FROM || 'ChecksOps Staging <noreply@checksops.com>',
).trim();

export const defaultReplyTo = () => String(
  process.env.AWS_EMAIL_REPLY_TO || 'support@checksops.com',
).trim() || 'support@checksops.com';

export const mortgageOpsEmail = () => String(
  process.env.AWS_MORTGAGE_OPS_EMAIL || 'staging-mortgage-ops@checksops.invalid',
).trim().toLowerCase();

export const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

export const isAllowlistedRecipient = (email) => {
  const addr = normalizeEmail(email);
  if (!addr || !addr.includes('@')) return false;
  if (allowlistExact().includes(addr)) return true;
  const domain = addr.split('@').pop();
  return allowlistDomains().includes(domain);
};

/**
 * Apply staging recipient policy.
 * - sink mode: always rewrite to sink (record original)
 * - ses mode: only allow allowlisted; others rewritten to sink with blocked flag
 */
export const applyRecipientPolicy = (recipients = []) => {
  const mode = emailMode();
  const list = (Array.isArray(recipients) ? recipients : [recipients])
    .map((r) => (typeof r === 'string' ? { email: r } : r))
    .filter((r) => r && r.email);

  return list.map((r) => {
    const original = normalizeEmail(r.email);
    const allowed = isAllowlistedRecipient(original);
    if (mode === 'sink') {
      return {
        ...r,
        email: sinkAddress(),
        originalEmail: original,
        delivery: 'sink',
        blocked: !allowed,
        policy: 'staging_sink',
      };
    }
    // ses mode
    if (allowed) {
      return {
        ...r,
        email: original,
        originalEmail: original,
        delivery: 'ses',
        blocked: false,
        policy: 'staging_allowlist',
      };
    }
    return {
      ...r,
      email: sinkAddress(),
      originalEmail: original,
      delivery: 'sink',
      blocked: true,
      policy: 'staging_rewritten_non_allowlist',
    };
  });
};
