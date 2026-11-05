/**
 * Public "Request demo" form on the marketing site (checksops.com#demo).
 *
 * No Cognito: visitors are not signed in. The send-transactional-email route requires an
 * identity, so the marketing form was answered 401 and fell back to the visitor's mailto client.
 *
 * Guard rails for an unauthenticated mail route:
 *   - the recipient is fixed (support@checksops.com); the body cannot choose it;
 *   - only the demo-request template is rendered, and every field is length-bounded;
 *   - a hidden honeypot field answers success without sending;
 *   - a per-IP and per-instance rate limit (in memory, per warm Lambda instance);
 *   - no database access and no tenant data.
 */
import { parseBody, ignoredSpoof } from './data.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { PLATFORM_PRIMARY_COLOR } from './email-branding.mjs';

export const DEMO_REQUEST_RECIPIENT = 'support@checksops.com';

export const DEMO_REQUEST_LIMITS = Object.freeze({
  name: 120,
  email: 254,
  company: 160,
  role: 120,
  notes: 2000,
});

const RATE_WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 5;
const PER_INSTANCE_LIMIT = 60;

// Simple, strict address shape: no whitespace, no angle brackets, one @, a dotted domain.
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]{2,}$/;

// Strip control characters (CR/LF included) from single-line fields; keep newlines in notes.
const cleanLine = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const cleanText = (value) => String(value ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
  .trim();

const requestMethod = (event) =>
  String(event?.httpMethod || event?.requestContext?.http?.method || 'POST').toUpperCase();

const sourceIp = (event) => String(
  event?.requestContext?.http?.sourceIp
  || event?.requestContext?.identity?.sourceIp
  || 'unknown',
);

export const createDemoRequestRateLimiter = ({
  now = () => Date.now(),
  perIp = PER_IP_LIMIT,
  perInstance = PER_INSTANCE_LIMIT,
  windowMs = RATE_WINDOW_MS,
} = {}) => {
  const byIp = new Map();
  let all = [];
  const prune = (list, t) => list.filter((at) => t - at < windowMs);
  return (ip) => {
    const t = now();
    all = prune(all, t);
    const mine = prune(byIp.get(ip) || [], t);
    if (mine.length >= perIp || all.length >= perInstance) {
      byIp.set(ip, mine);
      return false;
    }
    mine.push(t);
    all.push(t);
    byIp.set(ip, mine);
    return true;
  };
};

const defaultLimiter = createDemoRequestRateLimiter();

export const validateDemoRequest = (body = {}) => {
  const fields = {
    name: cleanLine(body.name),
    email: cleanLine(body.email).toLowerCase(),
    company: cleanLine(body.company),
    role: cleanLine(body.role),
    notes: cleanText(body.notes ?? body.message),
  };
  if (!fields.name) return { ok: false, error: 'missing_name' };
  if (!fields.email) return { ok: false, error: 'missing_email' };
  for (const [key, max] of Object.entries(DEMO_REQUEST_LIMITS)) {
    if (fields[key].length > max) return { ok: false, error: `${key}_too_long` };
  }
  if (!EMAIL_RE.test(fields.email)) return { ok: false, error: 'invalid_email' };
  return { ok: true, fields };
};

export const handlePublicDemoRequest = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  if (requestMethod(event) !== 'POST') {
    return { ok: false, statusCode: 405, error: 'method_not_allowed', spoofFieldsIgnored: spoof };
  }

  // Honeypot: real visitors never see or fill this field. Answer like a success, send nothing.
  if (cleanLine(body.website || body.company_website)) {
    return { ok: true, statusCode: 200, success: true, spoofFieldsIgnored: spoof };
  }

  const checked = validateDemoRequest(body);
  if (!checked.ok) {
    return { ok: false, statusCode: 400, success: false, error: checked.error, spoofFieldsIgnored: spoof };
  }

  const allow = deps.rateLimit || defaultLimiter;
  if (!allow(sourceIp(event))) {
    return { ok: false, statusCode: 429, success: false, error: 'rate_limited', spoofFieldsIgnored: spoof };
  }

  const { fields } = checked;
  const rendered = renderTransactionalTemplate('demo-request', {
    ...fields,
    branding: { primaryColor: PLATFORM_PRIMARY_COLOR },
  });
  const mailer = deps.sendViaSesOrSink || sendViaSesOrSink;
  const send = await mailer({
    to: DEMO_REQUEST_RECIPIENT,
    subject: `${rendered.subject}: ${fields.name}${fields.company ? ` (${fields.company})` : ''}`,
    html: rendered.html,
    text: rendered.text,
    replyTo: fields.email,
  });
  const primary = send.results?.[0] || {};
  if (primary.status === 'failed') {
    return { ok: false, statusCode: 502, success: false, error: 'send_failed', spoofFieldsIgnored: spoof };
  }
  return {
    ok: true,
    statusCode: 200,
    success: true,
    sent: primary.delivery === 'ses' && primary.status === 'sent',
    sunk: primary.delivery !== 'ses' || primary.status === 'sunk',
    spoofFieldsIgnored: spoof,
  };
};
