/**
 * Passwordless homeowner ledger tracking (no Cognito).
 * Presenter + URL + sign-link gate. Public data is scoped by ledger token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { normalizeEmail } from './email-policy.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';

const DEPOSITED_STAGES = new Set(['deposited', 'cleared', 'funds_released', 'disbursed']);
const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'failed', 'returned', 'voided']);
const COLLAPSE_TYPES = new Set(['endorsement_requested', 'endorsements_sent']);
const WINDOW_MS = 15 * 60 * 1000;
const SIGN_LINK_TTL_MS = 72 * 60 * 60 * 1000;
const EVENT_PAYLOAD_KEYS = new Set([
  'check_number', 'payee_name', 'payee_type', 'recipient_type', 'method',
  'status', 'note', 'document_label', 'file_name', 'batched', 'batched_count',
  'batched_payees',
]);

export const homeownerLedgerTrackingUrl = (origin, token, claimId) => {
  const base = String(origin || '').replace(/\/$/, '');
  const tok = String(token || '').trim();
  if (claimId) return `${base}/ledger/${tok}`;
  return `${base}/start-claim/${tok}`;
};

export const endorseBaseUrl = () => String(
  process.env.SIGN_BASE_URL
  || process.env.VITE_APP_URL
  || process.env.APP_PUBLIC_URL
  || 'https://staging.checksops.com',
).replace(/\/$/, '');

export const computeHomeownerLedgerTotals = (checks = [], splits = [], disbursements = []) => {
  const totals = { received: 0, deposited: 0, released: 0, remaining: 0 };
  for (const row of checks) {
    const amt = Number(row.amount ?? 0);
    totals.received += amt;
    if (DEPOSITED_STAGES.has(String(row.check_stage || '').toLowerCase())) {
      totals.deposited += amt;
    }
  }
  for (const row of splits) {
    if (!DEAD_STATUSES.has(String(row.status || '').toLowerCase())) {
      totals.released += Number(row.amount ?? 0);
    }
  }
  for (const row of disbursements) {
    if (!DEAD_STATUSES.has(String(row.status || '').toLowerCase())) {
      totals.released += Number(row.amount ?? 0);
    }
  }
  totals.remaining = Math.max(0, totals.received - totals.released);
  return totals;
};

export const collapseLedgerEvents = (events = []) => {
  const seenBuckets = new Map();
  const collapsed = [];
  for (const row of events) {
    if (!COLLAPSE_TYPES.has(row.event_type) || !row.check_id) {
      collapsed.push(row);
      continue;
    }
    const bucketMs = Math.floor(new Date(row.occurred_at).getTime() / WINDOW_MS);
    const key = `${row.check_id}|${row.event_type}|${bucketMs}`;
    const existing = seenBuckets.get(key);
    const payeeName = row.payload_json?.payee_name;
    if (!existing) {
      const bucket = { rep: row, count: 1, names: new Set() };
      if (payeeName) bucket.names.add(payeeName);
      seenBuckets.set(key, bucket);
      collapsed.push(row);
    } else {
      existing.count += 1;
      if (payeeName) existing.names.add(payeeName);
      existing.rep.payload_json = {
        ...(existing.rep.payload_json || {}),
        batched: true,
        batched_count: existing.count,
        batched_payees: Array.from(existing.names),
      };
    }
  }
  return collapsed;
};

const sanitizePayload = (payload) => {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const key of EVENT_PAYLOAD_KEYS) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
};

const sanitizeEvents = (events = []) => collapseLedgerEvents(events).map((row) => ({
  id: row.id,
  check_id: row.check_id || null,
  event_type: row.event_type,
  occurred_at: row.occurred_at,
  amount: row.amount ?? null,
  actor_label: row.actor_label || null,
  payload_json: sanitizePayload(row.payload_json),
}));

export const pendingSignaturesForHomeowner = (requests = [], homeownerEmail) => {
  const email = normalizeEmail(homeownerEmail);
  return (requests || []).map((row) => ({
    request_id: row.id || row.request_id,
    document_name: row.document_name,
    sent_at: row.sent_at || null,
    signers: (row.signers || row.signature_signers || []).map((signer) => {
      const signerEmail = normalizeEmail(signer.signer_email || signer.email);
      const isHomeowner = Boolean(email) && signerEmail === email;
      return {
        signer_id: signer.id || signer.signer_id,
        name: signer.signer_name || signer.name || null,
        email: signerEmail || null,
        status: signer.status,
        signed_at: signer.signed_at || null,
        is_homeowner: isHomeowner,
      };
    }),
  })).filter((row) => row.signers.some((signer) => signer.status !== 'signed'));
};

export const pendingEndorsementsForHomeowner = ({
  endorsements = [],
  checks = [],
  homeownerEmail,
  homeownerName,
  endorseOrigin,
} = {}) => {
  const email = normalizeEmail(homeownerEmail);
  const nameParts = String(homeownerName || '').toLowerCase().trim().split(/\s+/).filter((part) => part.length >= 3);
  const checkMeta = new Map((checks || []).map((row) => [String(row.id), row]));
  const isDone = (row) => row.signed_at || ['signed', 'waived', 'endorsed', 'completed', 'complete']
    .includes(String(row.status || '').toLowerCase());
  const isSent = (row) => {
    if (row.request_sent_at) return true;
    const status = String(row.status || '').toLowerCase();
    return ['sent', 'requested', 'in_progress', 'pending_signature', 'awaiting_signature'].includes(status);
  };
  const isHomeownerParty = (row) => {
    if (row.payee_type !== 'insured') return false;
    const emailHit = email && normalizeEmail(row.contact_email) === email;
    const nameLc = String(row.payee_name || '').toLowerCase();
    const nameHit = nameParts.length > 0 && nameParts.some((part) => nameLc.includes(part));
    return emailHit || nameHit || !email;
  };
  const byCheck = new Map();
  const origin = String(endorseOrigin || endorseBaseUrl()).replace(/\/$/, '');
  for (const row of endorsements || []) {
    if (isDone(row)) continue;
    if (!isSent(row) && !isHomeownerParty(row)) continue;
    const checkId = String(row.check_id);
    if (!byCheck.has(checkId)) {
      const meta = checkMeta.get(checkId) || {};
      byCheck.set(checkId, {
        check_id: row.check_id,
        check_number: meta.check_number ?? null,
        check_amount: meta.amount ?? null,
        parties: [],
      });
    }
    const homeownerParty = isHomeownerParty(row);
    byCheck.get(checkId).parties.push({
      endorsement_id: row.id || row.endorsement_id,
      payee_name: row.payee_name,
      payee_type: row.payee_type,
      status: row.status,
      sent_at: row.request_sent_at || null,
      is_homeowner: homeownerParty,
      sign_url: (row.payee_type === 'insured' && homeownerParty && row.token)
        ? `${origin}/endorse?token=${row.token}`
        : null,
    });
  }
  return Array.from(byCheck.values());
};

export const canMintHomeownerSignLink = (tok, signer) => {
  if (!tok) return { ok: false, statusCode: 404, error: 'not_found' };
  if (tok.error === 'revoked' || tok.revoked_at) {
    return { ok: false, statusCode: 410, error: 'revoked' };
  }
  if (tok.error === 'expired') return { ok: false, statusCode: 410, error: 'expired' };
  const claimId = tok.claim_id || tok.token?.claim_id;
  if (!claimId) return { ok: false, statusCode: 400, error: 'no_claim' };
  if (!signer) return { ok: false, statusCode: 404, error: 'signer_not_found' };
  if (String(signer.claim_id || '') !== String(claimId)) {
    return { ok: false, statusCode: 403, error: 'mismatch' };
  }
  if (String(signer.status || '').toLowerCase() === 'signed') {
    return { ok: false, statusCode: 409, error: 'already_signed' };
  }
  const home = normalizeEmail(tok.homeowner_email || tok.token?.homeowner_email);
  const signerEmail = normalizeEmail(signer.signer_email || signer.email);
  if (!home || home !== signerEmail) {
    return { ok: false, statusCode: 403, error: 'not_your_signature' };
  }
  return { ok: true };
};

const publicClaim = (claim) => {
  if (!claim) return null;
  return {
    id: claim.id,
    claim_number: claim.claim_number || null,
    property_address: claim.property_address || claim.policyholder_address || null,
    loss_type: claim.loss_type || null,
    status: claim.status || null,
    created_at: claim.created_at || null,
  };
};

const publicPlan = (plan) => {
  if (!plan || plan.share_with_homeowner === false) return null;
  if (!plan.share_with_homeowner && plan.share_with_homeowner !== true) {
    if (plan.start_window_start == null && plan.schedule_status == null) return null;
  }
  if (plan.share_with_homeowner !== true) return null;
  return {
    start_window_start: plan.start_window_start || null,
    start_window_end: plan.start_window_end || null,
    schedule_status: plan.schedule_status || null,
    schedule_note: plan.schedule_note || null,
    updated_at: plan.updated_at || null,
  };
};

export const presentHomeownerLedgerView = async (raw, {
  signDocumentUrl,
  endorseOrigin,
} = {}) => {
  if (!raw || raw.error) return raw;
  const token = raw.token || {};
  const homeownerEmail = token.homeowner_email || raw.homeowner?.email || null;
  const homeownerName = token.homeowner_name || raw.homeowner?.name || null;
  const claimId = token.claim_id || raw.claim?.id || null;
  const checks = raw.checks || [];
  const documents = [];
  for (const doc of raw.documents || raw.shared_documents || []) {
    let url = doc.url || null;
    if (!url && doc.file_path && typeof signDocumentUrl === 'function') {
      url = await signDocumentUrl(doc.file_path);
    }
    documents.push({
      id: doc.id,
      file_name: doc.file_name,
      doc_type: doc.doc_type || null,
      mime_type: doc.mime_type || null,
      file_size: doc.file_size || null,
      url: url || null,
    });
  }
  return {
    ok: true,
    mode: claimId ? 'claim' : 'pre_claim',
    homeowner: { name: homeownerName || null, email: homeownerEmail || null },
    claim: publicClaim(raw.claim),
    events: sanitizeEvents(raw.events || []),
    totals: computeHomeownerLedgerTotals(checks, raw.splits || [], raw.disbursements || []),
    pending_upload_count: Number(raw.pending_upload_count || 0),
    pending_signatures: pendingSignaturesForHomeowner(
      raw.signature_requests || raw.pending_signatures || [],
      homeownerEmail,
    ),
    pending_endorsements: pendingEndorsementsForHomeowner({
      endorsements: raw.endorsements || [],
      checks,
      homeownerEmail,
      homeownerName,
      endorseOrigin,
    }),
    shared_documents: documents,
    project_plan: publicPlan(raw.plan || raw.project_plan),
    money: null,
    deductible_payments: [],
    allow_deductible_payment: false,
    can_upload: true,
  };
};

export const signTenantDocumentUrl = async (s3Client, filePath, {
  getSignedUrlFn = getSignedUrl,
  bucket = process.env.FILES_BUCKET || '',
} = {}) => {
  if (!filePath || !bucket || !s3Client) return null;
  const rel = normalizePath(filePath, 'tenant-documents');
  const key = s3KeyFor('tenant-documents', rel);
  if (!key) return null;
  try {
    return await getSignedUrlFn(
      s3Client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 60 * 60 * 24 },
    );
  } catch {
    return null;
  }
};

const tokenFromDoc = (doc) => {
  if (!doc) return null;
  if (doc.error) return doc;
  return {
    ...doc,
    id: doc.token?.id || doc.id,
    claim_id: doc.token?.claim_id ?? doc.claim_id ?? doc.claim?.id ?? null,
    homeowner_email: doc.token?.homeowner_email || doc.homeowner_email || doc.homeowner?.email,
    homeowner_name: doc.token?.homeowner_name || doc.homeowner_name || doc.homeowner?.name,
    tenant_id: doc.tenant_id || doc.token?.tenant_id || null,
  };
};

export const loadLedgerTokenDoc = async (client, token) => {
  const key = String(token || '').trim();
  if (!key || key.length < 8) return { error: 'invalid_token' };
  try {
    const bundle = (await client.query(
      'SELECT public.aws_public_homeowner_ledger_bundle($1) AS doc',
      [key],
    )).rows[0]?.doc;
    if (bundle) return bundle;
  } catch {
    /* unapplied SQL — fall back */
  }
  const fallback = (await client.query(
    'SELECT public.aws_public_homeowner_ledger_by_token($1) AS doc',
    [key],
  )).rows[0]?.doc;
  return fallback || { error: 'not_found' };
};

export const runHomeownerLedgerView = async ({
  client, token, spoof, signDocumentUrl, endorseOrigin, s3Client,
}) => {
  const key = String(token || '').trim();
  if (!key || key.length < 8) {
    return { ok: false, statusCode: 400, error: 'invalid_token', spoofFieldsIgnored: spoof };
  }
  const raw = await loadLedgerTokenDoc(client, key);
  if (!raw || raw.error) {
    const error = raw?.error || 'not_found';
    const status = error === 'revoked' || error === 'expired' ? 410 : error === 'invalid_token' ? 400 : 404;
    return { ok: false, statusCode: status, error, spoofFieldsIgnored: spoof };
  }
  const presented = await presentHomeownerLedgerView(raw, {
    signDocumentUrl: signDocumentUrl || ((path) => signTenantDocumentUrl(s3Client, path)),
    endorseOrigin: endorseOrigin || endorseBaseUrl(),
  });
  return { ...presented, statusCode: 200, spoofFieldsIgnored: spoof };
};

export const runHomeownerLedgerSignLink = async ({
  client, body, spoof, origin,
}) => {
  const token = String(body.token || '').trim();
  const signerId = body.signer_id || body.signature_signer_id;
  if (!token || !signerId) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + SIGN_LINK_TTL_MS).toISOString();

  let minted = null;
  try {
    minted = (await client.query(
      `SELECT public.aws_public_homeowner_ledger_mint_sign_link(
         $1, $2::uuid, $3, $4::timestamptz
       ) AS doc`,
      [token, signerId, tokenHash, expiresAt],
    )).rows[0]?.doc;
  } catch {
    minted = null;
  }
  if (minted?.error) {
    const status = minted.statusCode || (
      minted.error === 'revoked' || minted.error === 'expired' ? 410
        : minted.error === 'mismatch' || minted.error === 'not_your_signature' ? 403
          : minted.error === 'already_signed' ? 409
            : minted.error === 'no_claim' ? 400
              : 404
    );
    return { ok: false, statusCode: status, error: minted.error, spoofFieldsIgnored: spoof };
  }
  const signOrigin = endorseBaseUrl();
  if (minted?.ok) {
    return {
      ok: true,
      statusCode: 200,
      sign_url: `${signOrigin}/sign?token=${rawToken}`,
      spoofFieldsIgnored: spoof,
    };
  }

  const doc = await loadLedgerTokenDoc(client, token);
  if (!doc || doc.error) {
    const error = doc?.error || 'not_found';
    const status = error === 'revoked' || error === 'expired' ? 410 : 404;
    return { ok: false, statusCode: status, error, spoofFieldsIgnored: spoof };
  }
  const tok = tokenFromDoc(doc);
  const signer = (await client.query(
    `SELECT ss.id, ss.signer_email, ss.status,
            COALESCE(sr.claim_id, ci.claim_id)::text AS claim_id
     FROM public.signature_signers ss
     JOIN public.signature_requests sr ON sr.id = ss.signature_request_id
     LEFT JOIN public.check_intake_items ci ON ci.id = sr.check_intake_item_id
     WHERE ss.id = $1::uuid
     LIMIT 1`,
    [signerId],
  )).rows[0];
  const gate = canMintHomeownerSignLink(tok, signer);
  if (!gate.ok) return { ...gate, spoofFieldsIgnored: spoof };
  await client.query(
    `UPDATE public.signature_signers
     SET token_hash = $2, expires_at = $3::timestamptz
     WHERE id = $1::uuid`,
    [signerId, tokenHash, expiresAt],
  );
  return {
    ok: true,
    statusCode: 200,
    sign_url: `${signOrigin}/sign?token=${rawToken}`,
    spoofFieldsIgnored: spoof,
  };
};

export const ledgerUploadInsertValues = (tok, rel, body = {}) => ([
  tok.tenant_id,
  tok.id,
  tok.claim_id || null,
  rel,
  body.amount_estimate ?? null,
  body.homeowner_note || body.note || null,
]);

export const ledgerUploadToken = (doc) => {
  const tok = tokenFromDoc(doc);
  if (!tok || tok.error) return null;
  if (!tok.id || !tok.tenant_id) return null;
  return tok;
};
