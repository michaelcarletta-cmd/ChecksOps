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

export const loadPendingSignaturesForHomeowner = async (client, token, homeowner) => {
  if (!token?.claim_id || !token?.tenant_id) return [];
  const rows = (await client.query(
    `SELECT r.id AS request_id, r.document_name, r.status AS request_status,
            r.sent_at, r.created_at, r.claim_id, r.check_intake_item_id,
            s.id AS signer_id, s.signer_name, s.signer_email, s.signer_type,
            s.status AS signer_status, s.signed_at, s.signing_order, s.expires_at
     FROM public.signature_requests r
     JOIN public.signature_signers s
       ON s.signature_request_id = r.id
     LEFT JOIN public.claims c
       ON c.id = r.claim_id
     LEFT JOIN public.check_intake_items i
       ON i.id = r.check_intake_item_id
     WHERE (
        r.claim_id = $1::uuid
        OR (
          r.check_intake_item_id IS NOT NULL
          AND i.claim_id = $1::uuid
          AND i.tenant_id = $2::uuid
        )
      )
       AND (c.id IS NULL OR c.org_id = $2::uuid)
       AND lower(COALESCE(r.status, '')) IN ('pending', 'sent', 'partial', 'in_progress')
     ORDER BY r.sent_at DESC NULLS LAST, r.created_at DESC NULLS LAST`,
    [token.claim_id, token.tenant_id],
  )).rows;
  const byRequest = new Map();
  for (const row of rows) {
    const requestId = String(row.request_id);
    if (!byRequest.has(requestId)) {
      byRequest.set(requestId, {
        request_id: row.request_id,
        document_name: row.document_name,
        status: row.request_status,
        sent_at: row.sent_at,
        created_at: row.created_at,
        signers: [],
      });
    }
    byRequest.get(requestId).signers.push({
      signer_id: row.signer_id,
      signer_name: row.signer_name,
      signer_email: row.signer_email,
      signer_type: row.signer_type,
      status: row.signer_status,
      signed_at: row.signed_at,
      signing_order: row.signing_order,
      expires_at: row.expires_at,
    });
  }
  return pendingSignaturesForHomeowner({
    requests: Array.from(byRequest.values()),
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

  const doc = (await client.query(
    'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
    [ledgerToken],
  )).rows[0]?.doc;
  if (!doc) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }
  if (doc.error) {
    const status = doc.error === 'revoked' || doc.error === 'expired' ? 410 : 400;
    return { ok: false, statusCode: status, error: doc.error, spoofFieldsIgnored: spoof };
  }

  const tok = doc.token && typeof doc.token === 'object' ? doc.token : null;
  if (!tok?.tenant_id || !tok?.claim_id) {
    return { ok: false, statusCode: 404, error: 'no_claim', spoofFieldsIgnored: spoof };
  }

  const row = (await client.query(
    `SELECT s.id, s.signer_name, s.signer_email, s.signer_type, s.status, s.signed_at,
            s.signing_order, s.expires_at, s.access_token, s.revoked_at,
            r.id AS request_id, r.status AS request_status, r.document_name,
            r.claim_id, r.check_intake_item_id,
            c.org_id AS claim_tenant_id,
            i.tenant_id AS check_tenant_id, i.claim_id AS check_claim_id
     FROM public.signature_signers s
     JOIN public.signature_requests r
       ON r.id = s.signature_request_id
     LEFT JOIN public.claims c
       ON c.id = r.claim_id
     LEFT JOIN public.check_intake_items i
       ON i.id = r.check_intake_item_id
     WHERE s.id::text = $1
     LIMIT 1`,
    [id],
  )).rows[0];
  if (!row) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }

  const requestClaim = row.claim_id || row.check_claim_id;
  const requestTenant = row.claim_tenant_id || row.check_tenant_id;
  if (!requestClaim || String(requestClaim) !== String(tok.claim_id)) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }
  if (requestTenant && String(requestTenant) !== String(tok.tenant_id)) {
    return { ok: false, statusCode: 404, error: 'not_found', spoofFieldsIgnored: spoof };
  }
  if (!isHomeownerDocumentSignerType(row)) {
    return { ok: false, statusCode: 403, error: 'not_your_signature', spoofFieldsIgnored: spoof };
  }

  const siblings = (await client.query(
    `SELECT id, signer_type, status, signed_at, signing_order, expires_at, revoked_at
     FROM public.signature_signers
     WHERE signature_request_id = $1::uuid`,
    [row.request_id],
  )).rows.map((sibling) => ({
    ...sibling,
    signer_id: sibling.id,
    signer_status: sibling.status,
  }));
  const homeownerSignerCount = siblings.filter((sibling) => isHomeownerDocumentSignerType(sibling)).length;
  const homeowner = {
    name: doc.homeowner?.name ?? tok.homeowner_name ?? null,
    email: doc.homeowner?.email ?? tok.homeowner_email ?? null,
  };
  if (!isHomeownerDocumentSigner(row, homeowner, { homeownerSignerCount })) {
    return { ok: false, statusCode: 403, error: 'not_your_signature', spoofFieldsIgnored: spoof };
  }
  if (!requestIsOpen({ status: row.request_status })) {
    return { ok: false, statusCode: 403, error: 'invalid_state', spoofFieldsIgnored: spoof };
  }
  if (row.signed_at || DONE_SIGNER_STATUSES.includes(String(row.status || '').toLowerCase())) {
    return { ok: false, statusCode: 409, error: 'already_signed', spoofFieldsIgnored: spoof };
  }
  if (!signerIsOpen(row)) {
    return { ok: false, statusCode: 403, error: 'invalid_state', spoofFieldsIgnored: spoof };
  }
  if (priorSignerBlocks(row, siblings)) {
    return { ok: false, statusCode: 403, error: 'signer_order_blocked', spoofFieldsIgnored: spoof };
  }

  if (!isReusableDocumentAccessToken(row.access_token)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'existing_email_link_required',
      message: 'The existing emailed signing link is still the valid /sign capability. Homeowner Ops will not replace that signer token.',
      request_id: row.request_id,
      signer_id: row.id,
      spoofFieldsIgnored: spoof,
    };
  }

  return {
    ok: true,
    statusCode: 200,
    sign_url: `/sign?token=${encodeURIComponent(String(row.access_token).trim())}`,
    request_id: row.request_id,
    signer_id: row.id,
    reused_existing_access_token: true,
    spoofFieldsIgnored: spoof,
  };
};
