/**
 * Homeowner Ops doorway helpers for existing Signature Requests.
 * Does not change esign.mjs, signature-submit.mjs, Sign.tsx, or SQL73.
 * Does not call the historical Homeowner remint RPC.
 */
const HOMEOWNER_DOCUMENT_SIGNER_TYPES = Object.freeze([
  'policyholder', 'insured', 'homeowner',
]);
const BLOCKED_DOCUMENT_SIGNER_TYPES = Object.freeze([
  'contractor', 'staff', 'other', 'mortgage', 'mortgage_company',
  'public_adjuster', 'pa',
]);
const OPEN_REQUEST_STATUSES = Object.freeze([
  'pending', 'sent', 'partial', 'in_progress',
]);
const DONE_SIGNER_STATUSES = Object.freeze([
  'signed', 'completed', 'complete',
]);
const DEAD_REQUEST_STATUSES = Object.freeze([
  'cancelled', 'canceled', 'revoked', 'expired', 'completed', 'complete',
  'failed', 'voided',
]);
const DEAD_SIGNER_STATUSES = Object.freeze([
  'cancelled', 'canceled', 'revoked', 'expired', 'voided', 'rejected',
]);

const nameParts = (name) => String(name || '')
  .toLowerCase()
  .trim()
  .split(/\s+/)
  .filter((part) => part.length >= 3);

export const isReusableDocumentAccessToken = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw.includes('://') || raw.includes('//') || raw.includes('\\') || raw.includes('..')) {
    return false;
  }
  return /^[A-Fa-f0-9]{32,}$/.test(raw);
};

export const isHomeownerDocumentSignerType = (signer) => {
  const type = String(signer?.signer_type || '').toLowerCase();
  if (BLOCKED_DOCUMENT_SIGNER_TYPES.includes(type)) return false;
  return HOMEOWNER_DOCUMENT_SIGNER_TYPES.includes(type);
};

export const isHomeownerDocumentSigner = (signer = {}, homeowner = {}, ctx = {}) => {
  if (!isHomeownerDocumentSignerType(signer)) return false;
  const email = String(homeowner.email || '').toLowerCase().trim();
  const emailHit = email && String(signer.signer_email || '').toLowerCase().trim() === email;
  const nameHit = nameParts(homeowner.name).some((part) => (
    String(signer.signer_name || '').toLowerCase().includes(part)
  ));
  if (emailHit || nameHit) return true;
  const sole = Number(ctx.homeownerSignerCount);
  return Number.isInteger(sole) && sole === 1;
};

const requestIsOpen = (request = {}) => {
  const status = String(request.status || request.request_status || '').toLowerCase();
  if (DEAD_REQUEST_STATUSES.includes(status)) return false;
  if (request.cancelled_at || request.revoked_at) return false;
  return OPEN_REQUEST_STATUSES.includes(status) || !status;
};

const signerIsOpen = (signer = {}) => {
  const status = String(signer.status || signer.signer_status || '').toLowerCase();
  if (signer.signed_at || DONE_SIGNER_STATUSES.includes(status)) return false;
  if (signer.revoked_at || DEAD_SIGNER_STATUSES.includes(status)) return false;
  if (signer.expires_at && new Date(signer.expires_at) < new Date()) return false;
  return true;
};

const priorSignerBlocks = (signer, siblings = []) => {
  const order = Number(signer.signing_order || 1);
  if (!Number.isFinite(order) || order <= 1) return false;
  return siblings.some((other) => {
    if (String(other.signer_id || other.id) === String(signer.signer_id || signer.id)) return false;
    const otherOrder = Number(other.signing_order || 1);
    if (!Number.isFinite(otherOrder) || otherOrder >= order) return false;
    return signerIsOpen(other);
  });
};

const publicSigner = (signer, homeowner, ctx) => {
  const isHomeowner = isHomeownerDocumentSigner(signer, homeowner, ctx);
  const canSign = Boolean(
    isHomeowner
    && signerIsOpen(signer)
    && !priorSignerBlocks(signer, ctx.siblings || []),
  );
  return {
    signer_id: signer.signer_id || signer.id || null,
    name: signer.signer_name || signer.name || null,
    email: signer.signer_email || signer.email || null,
    status: signer.status || signer.signer_status || null,
    signed_at: signer.signed_at || null,
    is_homeowner: isHomeowner,
    can_sign: canSign,
  };
};

const stripSecrets = (row) => {
  if (!row || typeof row !== 'object') return row;
  const {
    token: _token,
    token_hash: _hash,
    access_token: _access,
    ...safe
  } = row;
  return safe;
};

export const pendingSignaturesForHomeowner = ({
  requests = [],
  homeowner = {},
} = {}) => {
  const out = [];
  for (const request of requests) {
    if (!requestIsOpen(request)) continue;
    const rawSigners = Array.isArray(request.signers) ? request.signers : [];
    const homeownerSignerCount = rawSigners.filter((row) => isHomeownerDocumentSignerType(row)).length;
    const signers = rawSigners.map((row) => publicSigner(row, homeowner, {
      homeownerSignerCount,
      siblings: rawSigners,
    }));
    if (!signers.some((row) => row.is_homeowner && row.can_sign)) continue;
    out.push(stripSecrets({
      request_id: request.request_id || request.id || null,
      document_name: request.document_name || null,
      sent_at: request.sent_at || request.created_at || null,
      status: request.status || request.request_status || null,
      signers,
    }));
  }
  return out;
};

const HOMEOWNER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mapDocumentCapabilityError = (cap, spoof) => {
  const code = String(cap?.error || 'not_found');
  if (code === 'revoked' || code === 'expired') {
    return { ok: false, statusCode: 410, error: code, spoofFieldsIgnored: spoof };
  }
  if (code === 'already_signed' || code === 'existing_email_link_required') {
    return {
      ok: false,
      statusCode: 409,
      error: code,
      message: code === 'existing_email_link_required'
        ? 'The existing emailed signing link is still the valid /sign capability. Homeowner Ops will not replace that signer token.'
        : undefined,
      request_id: cap?.request_id || null,
      signer_id: cap?.signer_id || null,
      spoofFieldsIgnored: spoof,
    };
  }
  if (code === 'missing_fields') {
    return { ok: false, statusCode: 400, error: code, spoofFieldsIgnored: spoof };
  }
  if (code === 'no_claim' || code === 'not_found') {
    return { ok: false, statusCode: 404, error: code, spoofFieldsIgnored: spoof };
  }
  return { ok: false, statusCode: 403, error: code, spoofFieldsIgnored: spoof };
};

export const loadPendingSignaturesForHomeowner = async (client, token, homeowner) => {
  const ledgerToken = String(token || '').trim();
  if (!ledgerToken || ledgerToken.length < 8) return [];
  const doc = (await client.query(
    'SELECT public.aws_public_homeowner_pending_signatures($1) AS doc',
    [ledgerToken],
  )).rows[0]?.doc;
  if (!doc || doc.error || !Array.isArray(doc.requests)) return [];
  return pendingSignaturesForHomeowner({
    requests: doc.requests,
    homeowner,
  });
};

export const runHomeownerLedgerDocumentSignLink = async ({
  client, token, signerId, spoof,
}) => {
  const ledgerToken = String(token || '').trim();
  const id = String(signerId || '').trim();
  if (!ledgerToken || ledgerToken.length < 8 || !id) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  if (!HOMEOWNER_UUID_RE.test(id)) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }

  const cap = (await client.query(
    'SELECT public.aws_public_homeowner_document_sign_capability($1, $2::uuid) AS doc',
    [ledgerToken, id],
  )).rows[0]?.doc;
  if (!cap || cap.error || cap.ok === false) {
    return mapDocumentCapabilityError(cap, spoof);
  }
  if (!isReusableDocumentAccessToken(cap.access_token)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'existing_email_link_required',
      message: 'The existing emailed signing link is still the valid /sign capability. Homeowner Ops will not replace that signer token.',
      request_id: cap.request_id || null,
      signer_id: cap.signer_id || id,
      spoofFieldsIgnored: spoof,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    sign_url: `/sign?token=${encodeURIComponent(String(cap.access_token).trim())}`,
    request_id: cap.request_id || null,
    signer_id: cap.signer_id || id,
    reused_existing_access_token: true,
    spoofFieldsIgnored: spoof,
  };
};
