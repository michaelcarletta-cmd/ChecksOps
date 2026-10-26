/**
 * ChecksOps persistence for Moov onboarding (SQL 91 tables) and the masked
 * read shape returned by moov-onboarding-get / moov-onboarding-save.
 *
 * Stored: business profile (EIN as KMS ciphertext + last four), representatives
 * (date of birth as KMS ciphertext + birth year, SSN last four only),
 * compliance documents, and an outbox whose payload holds ids only.
 * Never stored: the full SSN, the plaintext EIN or date of birth.
 */
import { OnboardingError, decryptPii, encryptPii } from './crypto.mjs';

export const BUSINESS_TYPES = Object.freeze([
  'soleProprietorship', 'unincorporatedAssociation', 'trust', 'llc',
  'publicCorporation', 'privateCorporation', 'partnership',
  'unincorporatedNonProfit', 'incorporatedNonProfit',
]);

export const MAX_REPRESENTATIVES = 6;

const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const digitsOf = (v, max = 20) => {
  if (typeof v === 'string' || typeof v === 'number') {
    return String(v).replace(/\D/g, '').slice(0, max) || null;
  }
  return null;
};
const bool = (v) => v === true || v === 'true';

const invalid = (field, message) => new OnboardingError('validation_failed', 400, { field, message });

// Moov keeps a business website only as an http(s) URL with a real host name
// (a dot-separated name, no spaces or credentials) of at most 100 characters.
// A bare domain gets https://; anything else fails here, not at Moov.
export const WEBSITE_MAX = 100;
export function normalizeWebsite(value) {
  const raw = str(value, 200);
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (/\s/.test(withScheme) || withScheme.length > WEBSITE_MAX) throw invalid('business.website', WEBSITE_MESSAGE);
  let url;
  try { url = new URL(withScheme); } catch { throw invalid('business.website', WEBSITE_MESSAGE); }
  const host = url.hostname;
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port
      || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)
      || !/^[a-z]{2,}$/i.test(host.slice(host.lastIndexOf('.') + 1))) {
    throw invalid('business.website', WEBSITE_MESSAGE);
  }
  return withScheme;
}
const WEBSITE_MESSAGE = 'Provide a website address such as https://yourcompany.com (no spaces, 100 characters or fewer), or leave it blank and give a short description.';

export const maskLast4 = (last4) => (last4 ? `*****${last4}` : null);

/** Accepts snake_case (contract) or Moov camelCase. Returns the contract shape or null. */
export function normalizeAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const line1 = str(a.line1 ?? a.addressLine1 ?? a.address_line1, 100);
  const line2 = str(a.line2 ?? a.addressLine2 ?? a.address_line2, 100);
  const city = str(a.city, 60);
  const state = str(a.state ?? a.stateOrProvince ?? a.state_or_province, 2);
  const postal = digitsOf(a.postal_code ?? a.postalCode ?? a.zip, 5);
  if (!line1 || !city || !state || state.length !== 2 || !postal || postal.length !== 5) return null;
  return { line1, ...(line2 ? { line2 } : {}), city, state: state.toUpperCase(), postal_code: postal, country: 'US' };
}

export const moovAddress = (a) => (a ? {
  addressLine1: a.line1,
  ...(a.line2 ? { addressLine2: a.line2 } : {}),
  city: a.city,
  stateOrProvince: a.state,
  postalCode: a.postal_code,
  country: 'US',
} : undefined);

/**
 * Validates the business section. `stored` is the existing profile row (EIN may
 * already be on file). Returns { fields, ein } where ein is the full EIN only
 * when supplied in this request (in memory, write-only).
 */
const INDUSTRY_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function validateBusiness(input = {}, stored = null) {
  const legalName = str(input.legal_name ?? input.legalBusinessName, 120);
  if (!legalName) throw invalid('business.legal_name', 'Legal business name is required.');
  const type = str(input.type ?? input.businessType, 40);
  if (!type || !BUSINESS_TYPES.includes(type)) throw invalid('business.type', 'Choose a valid business type.');
  const address = normalizeAddress(input.address);
  if (!address) throw invalid('business.address', 'Provide a complete business address.');
  const phone = digitsOf(input.phone, 11)?.replace(/^1(?=\d{10}$)/, '') ?? null;
  if (!phone || phone.length !== 10) throw invalid('business.phone', 'Provide a 10-digit business phone.');
  const email = str(input.email, 120);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('business.email', 'Provide a business email.');
  const rawEin = input.ein ?? null;
  let ein = null;
  if (rawEin !== null && rawEin !== undefined && String(rawEin).trim() !== '') {
    ein = digitsOf(rawEin, 12);
    if (!ein || ein.length !== 9) throw invalid('business.ein', 'Provide a valid 9-digit EIN.');
  }
  if (type !== 'soleProprietorship' && !ein && !stored?.ein_ciphertext) {
    throw invalid('business.ein', 'Provide a valid 9-digit EIN.');
  }
  const website = normalizeWebsite(input.website);
  const description = str(input.description, 300);
  if (!website && !description) {
    throw invalid('business.website', 'Provide a website or a short business description.');
  }
  // Moov's industry identifier (GET /industries, e.g. 'clothing-accessories'; SQL 116). Absent from
  // the request keeps the stored one; null or blank clears it.
  let industry = stored?.industry ?? null;
  if (input.industry !== undefined) {
    industry = str(input.industry, 100);
    if (industry && !INDUSTRY_PATTERN.test(industry)) throw invalid('business.industry', 'Choose an industry from the list.');
  }
  return {
    fields: {
      legal_name: legalName,
      dba: str(input.dba ?? input.doingBusinessAs, 120),
      business_type: type,
      email,
      phone,
      website,
      description,
      address,
      industry,
    },
    ein,
  };
}

const splitName = (rep) => {
  let first = str(rep.first_name ?? rep.firstName, 60);
  let last = str(rep.last_name ?? rep.lastName, 60);
  if ((!first || !last) && str(rep.name, 120)) {
    const parts = str(rep.name, 120).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      last = last || parts.pop().slice(0, 60);
      first = first || parts.join(' ').slice(0, 60);
    } else if (parts.length === 1) {
      // Single-word name: use it as first name, set last to "." so Moov accepts it.
      first = first || parts[0].slice(0, 60);
      last = last || '.';
    }
  }
  return { first, last };
};

/**
 * Validates representatives. Returns rows to persist plus an in-memory map of
 * full SSNs keyed by the representative's index (resolved to row ids on save).
 * `storedById` maps existing representative row id -> row.
 */
export function validateRepresentatives(list, storedById = new Map()) {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) throw invalid('representatives', 'representatives must be a list.');
  if (list.length > MAX_REPRESENTATIVES) throw invalid('representatives', `At most ${MAX_REPRESENTATIVES} people can be added.`);
  if (list.length > 0 && !list.some((r) => bool(r?.is_controller ?? r?.isController))) {
    throw invalid('representatives', 'One person must be marked as the controller.');
  }
  return list.map((rep, index) => {
    const id = rep?.id ?? null;
    const stored = id ? storedById.get(String(id)) : null;
    if (id && !stored) throw invalid(`representatives[${index}].id`, 'Unknown representative.');
    const { first, last } = splitName(rep || {});
    if (!first || !last) throw invalid(`representatives[${index}].name`, 'Each person needs a first and last name.');
    const label = `${first} ${last}`;
    const address = normalizeAddress(rep.address);
    if (!address) throw invalid(`representatives[${index}].address`, `Provide a full home address for ${label}.`);
    const dobRaw = str(rep.dob ?? rep.birthDate ?? rep.birth_date, 10);
    let dob = null;
    if (dobRaw) {
      const m = dobRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const year = m ? Number(m[1]) : 0;
      const month = m ? Number(m[2]) : 0;
      const day = m ? Number(m[3]) : 0;
      if (!m || year < 1900 || year > new Date().getUTCFullYear() || month < 1 || month > 12 || day < 1 || day > 31) {
        throw invalid(`representatives[${index}].dob`, `Provide a valid date of birth for ${label}.`);
      }
      dob = dobRaw;
    } else if (!stored?.dob_ciphertext) {
      throw invalid(`representatives[${index}].dob`, `Provide a date of birth for ${label}.`);
    }
    const rawSsn = rep.ssn ?? null;
    let ssn = null;
    if (rawSsn !== null && rawSsn !== undefined && String(rawSsn).trim() !== '') {
      ssn = digitsOf(rawSsn, 12);
      if (!ssn || ssn.length !== 9) throw invalid(`representatives[${index}].ssn`, `Provide a valid 9-digit SSN for ${label}.`);
    }
    const needsSsn = !stored || stored.ssn_resubmit_required === true || (!stored.moov_representative_id && !stored.ssn_last4);
    if (!ssn && needsSsn) {
      throw invalid(`representatives[${index}].ssn`, `Provide the 9-digit SSN for ${label}.`);
    }
    const phone = digitsOf(rep.phone, 11)?.replace(/^1(?=\d{10}$)/, '') ?? null;
    if (phone && phone.length !== 10) throw invalid(`representatives[${index}].phone`, `Provide a 10-digit phone for ${label}.`);
    const pctRaw = rep.ownership_pct ?? rep.ownershipPercentage ?? null;
    const pct = pctRaw === null || pctRaw === undefined || pctRaw === '' ? null : Number(pctRaw);
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw invalid(`representatives[${index}].ownership_pct`, 'Ownership must be between 0 and 100.');
    }
    const email = str(rep.email, 120);
    return {
      id: stored?.id ?? null,
      first_name: first,
      last_name: last,
      email,
      phone,
      title: str(rep.title ?? rep.jobTitle, 60) || 'Owner',
      address,
      is_controller: bool(rep.is_controller ?? rep.isController),
      is_owner: rep.is_owner !== undefined || rep.isOwner !== undefined
        ? bool(rep.is_owner ?? rep.isOwner)
        : (pct ?? 0) > 0,
      ownership_pct: pct,
      dob,
      ssn,
    };
  });
}

// ---------------------------------------------------------------- SQL

export const loadProfile = async (client, tenantId, environment) => (await client.query(
  `SELECT * FROM public.moov_onboarding_profiles
   WHERE tenant_id = $1::uuid AND environment = $2 LIMIT 1`,
  [tenantId, environment],
)).rows[0] || null;

export const loadRepresentatives = async (client, tenantId, environment) => (await client.query(
  `SELECT * FROM public.moov_onboarding_representatives
   WHERE tenant_id = $1::uuid AND environment = $2 AND removed_at IS NULL
   ORDER BY created_at ASC, id ASC`,
  [tenantId, environment],
)).rows;

export const loadDocuments = async (client, tenantId, environment) => (await client.query(
  `SELECT * FROM public.moov_compliance_documents
   WHERE tenant_id = $1::uuid AND environment = $2 AND status <> 'rejected'
   ORDER BY created_at DESC, id DESC`,
  [tenantId, environment],
)).rows;

export const loadDocument = async (client, tenantId, environment, documentId) => (await client.query(
  `SELECT * FROM public.moov_compliance_documents
   WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = $3 LIMIT 1`,
  [documentId, tenantId, environment],
)).rows[0] || null;

export const loadAccount = async (client, tenantId, environment) => (await client.query(
  `SELECT id, tenant_id, environment, provider_account_id, onboarding_status, verification_status,
          capabilities, tos_accepted_at, disabled, restricted, last_synced_at
   FROM public.payment_provider_accounts
   WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
   ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  [tenantId, environment],
)).rows[0] || null;

export const loadBanks = async (client, tenantId, environment) => (await client.query(
  `SELECT id, last_four, routing_last_four, connection_status, verification_status, bank_name
   FROM public.payment_provider_methods
   WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
     AND external_recipient_id IS NULL AND connection_status <> 'disconnected'
   ORDER BY is_default DESC NULLS LAST, created_at DESC NULLS LAST`,
  [tenantId, environment],
)).rows;

export const loadPendingOutbox = async (client, tenantId, environment) => (await client.query(
  `SELECT id, kind, subject_id, status, attempts, last_error_code, updated_at
   FROM public.moov_onboarding_outbox
   WHERE tenant_id = $1::uuid AND environment = $2 AND status = 'pending'
   ORDER BY created_at ASC`,
  [tenantId, environment],
)).rows;

export async function upsertProfile(client, deps, { tenantId, environment, fields, ein, userId }) {
  let einCipher = null;
  let einLast4 = null;
  let einKey = null;
  if (ein) {
    const enc = await encryptPii(deps, { tenantId, field: 'ein', environment, plaintext: ein });
    einCipher = enc.ciphertext;
    einKey = enc.keyArn;
    einLast4 = ein.slice(-4);
  }
  return (await client.query(
    `INSERT INTO public.moov_onboarding_profiles
      (tenant_id, environment, legal_name, dba, business_type, email, phone, website, description,
       address, ein_ciphertext, ein_last4, ein_key_arn, submitted_by, sync_pending, industry)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::uuid, true, $15)
     ON CONFLICT (tenant_id, environment) DO UPDATE SET
       legal_name = EXCLUDED.legal_name, dba = EXCLUDED.dba, business_type = EXCLUDED.business_type,
       email = EXCLUDED.email, phone = EXCLUDED.phone, website = EXCLUDED.website,
       description = EXCLUDED.description, address = EXCLUDED.address, industry = EXCLUDED.industry,
       ein_ciphertext = COALESCE(EXCLUDED.ein_ciphertext, moov_onboarding_profiles.ein_ciphertext),
       ein_last4 = COALESCE(EXCLUDED.ein_last4, moov_onboarding_profiles.ein_last4),
       ein_key_arn = COALESCE(EXCLUDED.ein_key_arn, moov_onboarding_profiles.ein_key_arn),
       submitted_by = EXCLUDED.submitted_by, sync_pending = true, updated_at = now()
     RETURNING *`,
    [
      tenantId, environment, fields.legal_name, fields.dba, fields.business_type, fields.email,
      fields.phone, fields.website, fields.description, JSON.stringify(fields.address),
      einCipher, einLast4, einKey, userId, fields.industry ?? null,
    ],
  )).rows[0];
}

/** Persists one representative. The full SSN is not a parameter here: only its last four. */
export async function upsertRepresentative(client, deps, { tenantId, environment, rep, userId }) {
  let dobCipher = null;
  let dobYear = null;
  if (rep.dob) {
    const enc = await encryptPii(deps, { tenantId, field: 'representative_dob', environment, plaintext: rep.dob });
    dobCipher = enc.ciphertext;
    dobYear = Number(rep.dob.slice(0, 4));
  }
  const ssnLast4 = rep.ssn ? rep.ssn.slice(-4) : null;
  const params = [
    tenantId, environment, rep.first_name, rep.last_name, rep.email, rep.phone, rep.title,
    JSON.stringify(rep.address), rep.is_controller, rep.is_owner, rep.ownership_pct,
    dobCipher, dobYear, ssnLast4,
  ];
  if (rep.id) {
    return (await client.query(
      `UPDATE public.moov_onboarding_representatives SET
         first_name = $3, last_name = $4, email = $5, phone = $6, title = $7, address = $8::jsonb,
         is_controller = $9, is_owner = $10, ownership_pct = $11,
         dob_ciphertext = COALESCE($12, dob_ciphertext), dob_year = COALESCE($13, dob_year),
         ssn_last4 = COALESCE($14, ssn_last4), updated_at = now()
       WHERE id = $15::uuid AND tenant_id = $1::uuid AND environment = $2 AND removed_at IS NULL
       RETURNING *`,
      [...params, rep.id],
    )).rows[0];
  }
  return (await client.query(
    `INSERT INTO public.moov_onboarding_representatives
      (tenant_id, environment, first_name, last_name, email, phone, title, address,
       is_controller, is_owner, ownership_pct, dob_ciphertext, dob_year, ssn_last4, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::uuid)
     RETURNING *`,
    [...params, userId],
  )).rows[0];
}

export const removeRepresentative = (client, { tenantId, environment, id }) => client.query(
  `UPDATE public.moov_onboarding_representatives SET removed_at = now(), updated_at = now()
   WHERE id = $1::uuid AND tenant_id = $2::uuid AND environment = $3 AND removed_at IS NULL`,
  [id, tenantId, environment],
);

export const markRepresentativeSynced = (client, { id, moovRepresentativeId, ssnDelivered }) => client.query(
  `UPDATE public.moov_onboarding_representatives SET
     moov_representative_id = $2, moov_synced_at = now(), last_error_code = NULL,
     ssn_resubmit_required = CASE WHEN $3 THEN false ELSE ssn_resubmit_required END,
     updated_at = now()
   WHERE id = $1::uuid`,
  [id, moovRepresentativeId, Boolean(ssnDelivered)],
);

export const markRepresentativeSsnResubmit = (client, { id, errorCode }) => client.query(
  `UPDATE public.moov_onboarding_representatives SET
     ssn_resubmit_required = true, last_error_code = $2, updated_at = now()
   WHERE id = $1::uuid`,
  [id, errorCode],
);

/**
 * Serializes onboarding writes per tenant + environment for the rest of the
 * transaction (save, finalize, moov-sync, outbox drain, bank changes).
 */
export const ONBOARDING_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('moov-onboarding:' || $1 || ':' || $2, 0))`;
export const lockTenantOnboarding = (client, { tenantId, environment }) => client.query(
  ONBOARDING_LOCK_SQL, [String(tenantId), String(environment)],
);

/** Retry policy: exponential backoff, then the row is marked failed. */
export const OUTBOX_MAX_ATTEMPTS = 10;

/** Outbox payload holds ids only (enforced again by a CHECK in SQL 91). */
export async function enqueueOutbox(client, { tenantId, environment, kind, subjectId, userId, payload = {} }) {
  const inserted = (await client.query(
    `INSERT INTO public.moov_onboarding_outbox
      (tenant_id, environment, kind, subject_id, payload, status, attempts, created_by)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, 'pending', 0, $6::uuid)
     ON CONFLICT (tenant_id, environment, kind, subject_id) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [tenantId, environment, kind, subjectId, JSON.stringify(payload), userId],
  )).rows[0];
  if (inserted) return inserted;
  return (await client.query(
    `SELECT id FROM public.moov_onboarding_outbox
     WHERE tenant_id = $1::uuid AND environment = $2 AND kind = $3 AND subject_id = $4::uuid AND status = 'pending'
     LIMIT 1`,
    [tenantId, environment, kind, subjectId],
  )).rows[0];
}

/** Pending rows whose backoff has elapsed. */
export const loadDueOutbox = async (client, tenantId, environment) => (await client.query(
  `SELECT id, kind, subject_id, status, attempts, last_error_code, updated_at
   FROM public.moov_onboarding_outbox
   WHERE tenant_id = $1::uuid AND environment = $2 AND status = 'pending'
     AND (next_attempt_at IS NULL OR next_attempt_at <= now())
   ORDER BY created_at ASC
   FOR UPDATE`,
  [tenantId, environment],
)).rows;

export const completeOutbox = (client, { id }) => client.query(
  `UPDATE public.moov_onboarding_outbox
   SET status = 'completed', attempts = attempts + 1, last_error_code = NULL, next_attempt_at = NULL,
       completed_at = now(), updated_at = now()
   WHERE id = $1::uuid AND status = 'pending'`,
  [id],
);

export const failOutboxAttempt = (client, { id, errorCode }) => client.query(
  `UPDATE public.moov_onboarding_outbox
   SET attempts = attempts + 1, last_error_code = $2, updated_at = now(),
       status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END,
       next_attempt_at = CASE WHEN attempts + 1 >= $3 THEN NULL
         ELSE now() + make_interval(secs => LEAST(21600, 60 * power(2, attempts))) END
   WHERE id = $1::uuid AND status = 'pending'`,
  [id, errorCode, OUTBOX_MAX_ATTEMPTS],
);

export const setProfileSyncState = (client, { tenantId, environment, pending, errorCode, moovAccountId = null }) => client.query(
  `UPDATE public.moov_onboarding_profiles SET
     sync_pending = $3, last_error_code = $4,
     moov_account_id = COALESCE($5, moov_account_id),
     moov_profile_synced_at = CASE WHEN $3 THEN moov_profile_synced_at ELSE now() END,
     updated_at = now()
   WHERE tenant_id = $1::uuid AND environment = $2`,
  [tenantId, environment, Boolean(pending), errorCode ?? null, moovAccountId],
);

export async function decryptProfileEin(deps, profile) {
  if (!profile?.ein_ciphertext) return null;
  return decryptPii(deps, {
    tenantId: profile.tenant_id, field: 'ein', environment: profile.environment, ciphertext: profile.ein_ciphertext,
  });
}

export async function decryptRepresentativeDob(deps, rep) {
  if (!rep?.dob_ciphertext) return null;
  return decryptPii(deps, {
    tenantId: rep.tenant_id, field: 'representative_dob', environment: rep.environment, ciphertext: rep.dob_ciphertext,
  });
}

// ---------------------------------------------------------------- masked shape

const capabilityList = (caps) => {
  if (Array.isArray(caps)) {
    return caps
      .map((c) => ({ capability: String(c?.capability ?? c?.capabilityID ?? ''), status: c?.status ? String(c.status) : null }))
      .filter((c) => c.capability);
  }
  return [];
};

export const publicAddress = (address) => {
  if (!address || typeof address !== 'object' || !address.line1) return null;
  return {
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city ?? null,
    state: address.state ?? null,
    postal_code: address.postal_code ?? null,
    country: address.country ?? 'US',
  };
};

export const publicDocument = (row) => ({
  id: row.id,
  purpose: row.purpose,
  file_name: row.file_name,
  size: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
  content_type: row.content_type,
  uploaded_at: row.uploaded_at ?? null,
  moov_file_id: row.moov_file_id ?? null,
  moov_status: row.moov_status ?? null,
  status: row.status,
  representative_id: row.representative_id ?? null,
});

/** Bank verification vocabulary for the SPA: values contain "verified", "pending" or "failed". */
export const bankVerification = (raw) => {
  const v = String(raw || '').toLowerCase();
  if (v === 'verified') return 'verified';
  if (['failed', 'errored', 'max_attempts_exceeded', 'verification_failed'].includes(v)) return 'failed';
  if (v === 'pending_micro_deposit') return 'pending_micro_deposit';
  return 'pending';
};

export const bankStatus = (connection, verification) => {
  const c = String(connection || '').toLowerCase();
  if (c === 'failed' || c === 'errored') return 'failed';
  const v = bankVerification(verification);
  return v === 'verified' || v === 'failed' ? v : 'pending';
};

export const publicRepresentative = (row) => ({
  id: row.id,
  name: [row.first_name, row.last_name].filter(Boolean).join(' '),
  first_name: row.first_name,
  last_name: row.last_name,
  email: row.email ?? null,
  phone: row.phone ?? null,
  title: row.title ?? null,
  dob_masked: row.dob_year ? `**/**/${row.dob_year}` : null,
  ssn_last4: row.ssn_last4 ?? null,
  address: publicAddress(row.address),
  is_controller: row.is_controller === true,
  ownership_pct: row.ownership_pct === null || row.ownership_pct === undefined ? null : Number(row.ownership_pct),
  ssn_resubmit_required: row.ssn_resubmit_required === true,
});

export async function buildOnboardingView(client, ctx) {
  const { tenantId, environment } = ctx;
  const [account, profile, reps, docs, banks, outbox] = [
    await loadAccount(client, tenantId, environment),
    await loadProfile(client, tenantId, environment),
    await loadRepresentatives(client, tenantId, environment),
    await loadDocuments(client, tenantId, environment),
    await loadBanks(client, tenantId, environment),
    await loadPendingOutbox(client, tenantId, environment),
  ];
  const lastError = outbox.find((o) => o.last_error_code)?.last_error_code ?? profile?.last_error_code ?? null;
  return {
    ok: true,
    environment,
    account: {
      connected: Boolean(account?.provider_account_id),
      status: account?.onboarding_status ?? 'not_started',
      capabilities: capabilityList(account?.capabilities),
      tos_accepted: Boolean(account?.tos_accepted_at),
    },
    business: {
      legal_name: profile?.legal_name ?? null,
      dba: profile?.dba ?? null,
      type: profile?.business_type ?? null,
      ein_masked: maskLast4(profile?.ein_last4),
      email: profile?.email ?? null,
      phone: profile?.phone ?? null,
      website: profile?.website ?? null,
      description: profile?.description ?? null,
      address: publicAddress(profile?.address),
      industry: profile?.industry ?? null,
    },
    representatives: reps.map(publicRepresentative),
    documents: docs.map(publicDocument),
    banks: banks.map((b) => ({
      id: b.id,
      last4: b.last_four ?? null,
      routing_masked: maskLast4(b.routing_last_four),
      status: bankStatus(b.connection_status, b.verification_status),
      verification: bankVerification(b.verification_status),
    })),
    sync: {
      pending: outbox.length > 0 || profile?.sync_pending === true,
      last_error_code: lastError,
    },
    can_submit: ctx.canSubmit === true,
  };
}
