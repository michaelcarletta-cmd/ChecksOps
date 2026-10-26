import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';
import { PLATFORM_OWNER_SQL, TENANT_MOOV_ENV_SQL } from '../functions/api/providers/onboarding/context.mjs';
import {
  NEW_ONBOARDING_FUNCTION_NAMES,
  ONBOARDING_FUNCTION_NAMES,
} from '../functions/api/providers/onboarding/handlers.mjs';
import { sniffContentType } from '../functions/api/providers/onboarding/documents.mjs';
import {
  applyOnboardingWebhookStatus,
  applyProductionOnboardingWebhook,
} from '../functions/api/providers/onboarding/webhook-status.mjs';
import { productionOnboardingWebhookApplyEnabled } from '../functions/api/providers/onboarding/flags.mjs';
import { redact } from '../functions/api/providers/onboarding/redact.mjs';
import { authorizeObject } from '../functions/api/storage.mjs';
import { APP_BUCKET_SET, s3KeyFor } from '../functions/api/storage-paths.mjs';
import { sanitizeWebhookPayload } from '../functions/api/providers/webhooks.mjs';
import { FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';
import { moovRejectedFields, redactText } from '../functions/api/providers/onboarding/redact.mjs';
import { accountBodyDigest, accountIdempotencyKey } from '../functions/api/providers/onboarding/moov-sync.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '9b1f7a52-1c0e-4d5a-9a3f-5d6e7f8a9b0c';
const MOOV_ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PII_KEY = 'arn:aws:kms:us-east-1:111122223333:key/11111111-2222-4333-8444-555555555555';
const DOC_KEY = 'arn:aws:kms:us-east-1:111122223333:key/66666666-7777-4888-8999-aaaaaaaaaaaa';
const SSN = '123456789';
const SSN_DASHED = '123-45-6789';
const SSN2 = '987650001';
const EIN = '274444321';

const USERS = {
  owner: { sub: 'sub-owner', app: '10000000-0000-4000-8000-000000000001', memberships: [[TENANT, 'owner']] },
  admin: { sub: 'sub-admin', app: '10000000-0000-4000-8000-000000000002', memberships: [[TENANT, 'admin']] },
  manager: { sub: 'sub-manager', app: '10000000-0000-4000-8000-000000000003', memberships: [[TENANT, 'manager']] },
  operator: { sub: 'sub-operator', app: '10000000-0000-4000-8000-000000000004', memberships: [[TENANT, 'operator']] },
  viewer: { sub: 'sub-viewer', app: '10000000-0000-4000-8000-000000000005', memberships: [[TENANT, 'viewer']] },
  partner: { sub: 'sub-partner', app: '10000000-0000-4000-8000-000000000006', memberships: [[OTHER_TENANT, 'owner']] },
  globalAdmin: { sub: 'sub-gadmin', app: '10000000-0000-4000-8000-000000000007', memberships: [], userRolesAdmin: true },
  platformOwner: { sub: 'sub-platform', app: '10000000-0000-4000-8000-000000000008', memberships: [], platformOwner: true },
};

const BASE_ENV = {
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
  AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  AWS_MOOV_ENABLED: 'false',
  AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: undefined,
  MOOV_ONBOARDING_PII_KMS_KEY_ARN: PII_KEY,
  COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: DOC_KEY,
  FILES_BUCKET: 'checksops-test-files',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** Captures console output so tests can assert nothing sensitive was logged. */
const captureConsole = async (fn) => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...args) => lines.push(args.map(String).join(' '));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    Object.assign(console, orig);
  }
};

const jwtEvent = (name, body, user) => ({
  rawPath: `/functions/v1/${name}`,
  headers: { authorization: 'Bearer test-id-token', 'user-agent': 'node-test' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: `/functions/v1/${name}` },
    authorizer: { jwt: { claims: { sub: user.sub, email: `${user.sub}@example.com`, token_use: 'id', auth_time: '1760000000' } } },
  },
});

// ------------------------------------------------------------------ fakes

let seq = 0;
const nextId = () => {
  seq += 1;
  return `ffffffff-0000-4000-8000-${String(seq).padStart(12, '0')}`;
};

/** In-memory database honoring the SQL the onboarding handlers issue. */
const makeDb = ({ tenantEnv = 'sandbox', account = true } = {}) => {
  const state = {
    tenants: {
      [TENANT]: { id: TENANT, name: 'Freedom', legal_business_name: 'Freedom Adj', email_reply_to: 'ops@example.com', moov_allowlisted: true, moov_environment: tenantEnv },
      [OTHER_TENANT]: { id: OTHER_TENANT, name: 'Partner', moov_allowlisted: true, moov_environment: 'sandbox' },
    },
    accounts: account ? [{
      id: 'acct-row-1', tenant_id: TENANT, environment: 'sandbox', provider_account_id: MOOV_ACCOUNT,
      onboarding_status: 'onboarding_incomplete', verification_status: 'not_started', capabilities: [],
      tos_accepted_at: null, disabled: false, restricted: false,
    }] : [],
    profiles: [],
    reps: [],
    docs: [],
    outbox: [],
    methods: [],
    verifications: [],
    events: [],
    writes: [],
    gucs: [],
    accountUpdates: [],
    locks: [],
    noStepUp: false,
    stepUpQueries: [],
    commits: 0,
  };
  const clients = [];
  const create = () => {
    let user = null;
    const client = {
      connect: async () => {},
      end: async () => {},
      query: async (sql, params = []) => {
        const text = String(sql);
        if (/^\s*(INSERT|UPDATE|DELETE)/i.test(text)) state.writes.push({ sql: text, params });
        if (text === 'COMMIT') state.commits += 1;
        if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(text)) return { rows: [], command: text };
        if (text.startsWith('SELECT set_config')) {
          if (text.includes('$1')) { if (params[0] === 'request.app_user_id') user = Object.values(USERS).find((u) => u.app === params[1]) || null; }
          state.gucs.push(text.includes('$1') ? params : [text]);
          return { rows: [{}] };
        }
        if (text === LOOKUP_MAPPING_SQL) {
          const u = Object.values(USERS).find((x) => x.sub === params[0]);
          return { rows: u ? [{ application_user_id: u.app, cognito_sub: u.sub, email: `${u.sub}@example.com`, status: 'active' }] : [] };
        }
        if (text === TENANT_MEMBERSHIP_SQL) {
          const u = Object.values(USERS).find((x) => x.app === params[0]);
          return { rows: (u?.memberships || []).map(([tenant_id, role]) => ({ tenant_id, role, tenant_name: 't', tenant_slug: 't' })) };
        }
        if (text === PLATFORM_OWNER_SQL) return { rows: [{ is_platform_owner: user?.platformOwner === true }] };
        if (text.includes('FROM public.user_roles')) return { rows: user?.userRolesAdmin ? [{ role: 'admin' }] : [] };
        if (text === TENANT_MOOV_ENV_SQL) {
          const t = state.tenants[params[0]];
          return { rows: t ? [{ moov_allowlisted: t.moov_allowlisted, moov_environment: t.moov_environment }] : [] };
        }
        if (text.includes('FROM public.tenants WHERE id')) return { rows: state.tenants[params[0]] ? [state.tenants[params[0]]] : [] };
        if (text.includes('payment_idempotency_keys')) return { rows: [] };
        if (text.includes('pg_advisory_xact_lock')) {
          state.locks.push(params);
          return { rows: [{}] };
        }
        if (text.includes('FROM public.financial_stepup_log')) {
          state.stepUpQueries.push({ sql: text, params, user: user?.app ?? null });
          // Bound to the signed-in user, this tenant, wallet.fund and this login; server-written rows only.
          const bound = params[0] === user?.app && params[1] === TENANT && params[2] === 'wallet.fund'
            && params[3] === `${user?.sub}:auth:1760000000`
            && /user_id = \$1::uuid/.test(text) && /tenant_id = \$2::uuid/.test(text)
            && /\(metadata->>'login_session'\) = \$4/.test(text) && /\(metadata->>'source'\) = 'app_financial_totp'/.test(text);
          return { rows: state.noStepUp || !bound ? [] : [{ id: 'stepup-1', created_at: new Date().toISOString() }] };
        }
        if (text.includes('count(*)::int AS pending')) {
          return { rows: [{ pending: state.docs.filter((d) => d.tenant_id === params[0] && d.status === 'pending_upload').length }] };
        }

        // payment_provider_accounts
        if (text.includes('INSERT INTO public.payment_provider_accounts')) {
          const fresh = {
            provider_account_id: params[2], onboarding_status: 'onboarding_incomplete', verification_status: 'not_started', capabilities: [],
            tos_accepted_at: params[5] ? new Date().toISOString() : null, provider_metadata: JSON.parse(params[4]), disabled: false, restricted: false,
          };
          // ON CONFLICT (tenant_id, provider, environment) DO UPDATE
          const existing = state.accounts.find((a) => a.tenant_id === params[0] && a.environment === params[1]);
          if (existing) {
            Object.assign(existing, fresh, { provider_metadata: { ...(existing.provider_metadata || {}), ...fresh.provider_metadata } });
            return { rows: [{ ...existing }] };
          }
          const row = { id: nextId(), tenant_id: params[0], environment: params[1], ...fresh };
          state.accounts.push(row);
          return { rows: [row] };
        }
        if (text.includes('FROM public.payment_provider_accounts') && text.includes('provider_account_id = $1')) {
          return { rows: state.accounts.filter((a) => a.provider_account_id === params[0] && a.environment === params[1]) };
        }
        if (text.includes('FROM public.payment_provider_accounts')) {
          return { rows: state.accounts.filter((a) => a.tenant_id === params[0] && a.environment === params[1]) };
        }
        if (text.includes('UPDATE public.payment_provider_accounts')) {
          state.accountUpdates.push({ sql: text, params });
          if (text.includes('last_webhook_event_type = $10')) {
            const a = state.accounts.find((x) => x.id === params[0]);
            if (a) Object.assign(a, { capabilities: JSON.parse(params[1]), onboarding_status: params[3], verification_status: params[2] ?? a.verification_status });
          }
          if (text.includes('tos_accepted_at = $2')) {
            const a = state.accounts.find((x) => x.id === params[0]);
            if (a) a.tos_accepted_at = params[1];
          }
          return { rows: [] };
        }

        // profiles
        if (text.includes('FROM public.moov_onboarding_profiles')) {
          return { rows: state.profiles.filter((p) => p.tenant_id === params[0] && p.environment === params[1]) };
        }
        if (text.includes('INSERT INTO public.moov_onboarding_profiles')) {
          let row = state.profiles.find((p) => p.tenant_id === params[0] && p.environment === params[1]);
          const fields = {
            legal_name: params[2], dba: params[3], business_type: params[4], email: params[5], phone: params[6],
            website: params[7], description: params[8], address: JSON.parse(params[9]), sync_pending: true,
            industry: params[14] ?? null,
          };
          if (!row) {
            row = { id: nextId(), tenant_id: params[0], environment: params[1], ...fields, ein_ciphertext: params[10], ein_last4: params[11], ein_key_arn: params[12] };
            state.profiles.push(row);
          } else {
            Object.assign(row, fields, {
              ein_ciphertext: params[10] ?? row.ein_ciphertext,
              ein_last4: params[11] ?? row.ein_last4,
              ein_key_arn: params[12] ?? row.ein_key_arn,
            });
          }
          return { rows: [{ ...row }] };
        }
        if (text.includes('UPDATE public.moov_onboarding_profiles')) {
          const row = state.profiles.find((p) => p.tenant_id === params[0] && p.environment === params[1]);
          if (row && text.includes('sync_pending = $3')) Object.assign(row, { sync_pending: params[2], last_error_code: params[3], moov_account_id: params[4] ?? row.moov_account_id });
          if (row && text.includes('last_webhook_event_type = $3')) row.last_webhook_event_type = params[2];
          return { rows: [] };
        }

        // representatives
        if (text.includes('FROM public.moov_onboarding_representatives') && text.includes('removed_at IS NOT NULL')) {
          return { rows: state.reps.filter((r) => r.tenant_id === params[0] && r.environment === params[1] && r.removed_at && r.moov_representative_id) };
        }
        if (text.includes('FROM public.moov_onboarding_representatives') && text.includes('WHERE id = $1')) {
          return { rows: state.reps.filter((r) => r.id === params[0] && r.tenant_id === params[1] && !r.removed_at) };
        }
        if (text.includes('FROM public.moov_onboarding_representatives')) {
          return { rows: state.reps.filter((r) => r.tenant_id === params[0] && r.environment === params[1] && !r.removed_at).map((r) => ({ ...r })) };
        }
        if (text.includes('INSERT INTO public.moov_onboarding_representatives')) {
          const row = {
            id: nextId(), tenant_id: params[0], environment: params[1], first_name: params[2], last_name: params[3],
            email: params[4], phone: params[5], title: params[6], address: JSON.parse(params[7]), is_controller: params[8],
            is_owner: params[9], ownership_pct: params[10], dob_ciphertext: params[11], dob_year: params[12],
            ssn_last4: params[13], ssn_resubmit_required: false, moov_representative_id: null, removed_at: null,
          };
          state.reps.push(row);
          return { rows: [{ ...row }] };
        }
        if (text.includes('UPDATE public.moov_onboarding_representatives')) {
          if (text.includes('first_name = $3')) {
            const row = state.reps.find((r) => r.id === params[14]);
            if (!row) return { rows: [] };
            Object.assign(row, {
              first_name: params[2], last_name: params[3], email: params[4], phone: params[5], title: params[6],
              address: JSON.parse(params[7]), is_controller: params[8], is_owner: params[9], ownership_pct: params[10],
              dob_ciphertext: params[11] ?? row.dob_ciphertext, dob_year: params[12] ?? row.dob_year,
              ssn_last4: params[13] ?? row.ssn_last4,
            });
            return { rows: [{ ...row }] };
          }
          if (text.includes('WHERE tenant_id = $1::uuid AND environment = $2 AND moov_representative_id IS NOT NULL')) {
            for (const r of state.reps) {
              if (r.tenant_id === params[0] && r.environment === params[1] && r.moov_representative_id) r.moov_representative_id = null;
            }
            return { rows: [] };
          }
          const row = state.reps.find((r) => r.id === params[0]);
          if (!row) return { rows: [] };
          if (text.includes('removed_at = now()')) row.removed_at = new Date().toISOString();
          else if (text.includes('moov_representative_id = $2')) {
            row.moov_representative_id = params[1];
            row.last_error_code = null;
            if (params[2]) row.ssn_resubmit_required = false;
          } else if (text.includes('ssn_resubmit_required = true')) {
            row.ssn_resubmit_required = true;
            row.last_error_code = params[1];
          } else if (text.includes('moov_representative_id = NULL')) row.moov_representative_id = null;
          return { rows: [] };
        }

        // documents
        if (text.includes('INSERT INTO public.moov_compliance_documents')) {
          const row = {
            id: params[0], tenant_id: params[1], environment: params[2], purpose: params[3], file_name: params[4],
            content_type: params[5], size_bytes: params[6], storage_key: params[7], kms_key_arn: params[8],
            status: 'pending_upload', moov_file_id: null, moov_status: null, uploaded_at: null,
            representative_id: params[10] ?? null, created_at: new Date().toISOString(),
          };
          state.docs.push(row);
          return { rows: [{ ...row }] };
        }
        if (text.includes('FROM public.moov_compliance_documents') && text.includes('WHERE id = $1')) {
          return { rows: state.docs.filter((d) => d.id === params[0] && d.tenant_id === params[1] && d.environment === params[2]).map((d) => ({ ...d })) };
        }
        if (text.includes('FROM public.moov_compliance_documents') && text.includes('moov_file_id IS NULL')) {
          return { rows: state.docs.filter((d) => d.tenant_id === params[0] && d.environment === params[1] && d.status === 'stored' && !d.moov_file_id).map((d) => ({ id: d.id })) };
        }
        if (text.includes('FROM public.moov_compliance_documents')) {
          return { rows: state.docs.filter((d) => d.tenant_id === params[0] && d.environment === params[1] && d.status !== 'rejected') };
        }
        if (text.includes('UPDATE public.moov_compliance_documents') && text.includes('moov_account_id = $3')) {
          const reset = state.docs.filter((d) => d.tenant_id === params[0] && d.environment === params[1] && d.moov_account_id === params[2] && d.status === 'sent');
          for (const d of reset) Object.assign(d, { status: 'stored', moov_file_id: null, moov_status: null, moov_account_id: null, sent_at: null, last_error_code: null });
          return { rows: reset.map((d) => ({ id: d.id })) };
        }
        if (text.includes('UPDATE public.moov_compliance_documents')) {
          const row = state.docs.find((d) => d.id === params[0]);
          if (!row) return { rows: [] };
          if (text.includes("status = 'sent'")) Object.assign(row, { status: 'sent', moov_file_id: params[1], moov_status: params[2], moov_account_id: params[3] });
          else if (text.includes('sha256 = $2')) Object.assign(row, { status: row.status === 'pending_upload' ? 'stored' : row.status, sha256: params[1], final_storage_key: row.final_storage_key ?? params[2], s3_version_id: row.s3_version_id ?? params[3], uploaded_at: row.uploaded_at || new Date().toISOString() });
          else if (text.includes("moov_status = 'sync_failed'")) Object.assign(row, { moov_status: 'sync_failed', last_error_code: params[1] ?? 'moov_account_missing' });
          return { rows: [{ ...row }] };
        }

        // outbox
        if (text.includes('FROM public.moov_onboarding_outbox') && text.includes('kind = $3')) {
          return { rows: state.outbox.filter((o) => o.tenant_id === params[0] && o.environment === params[1] && o.kind === params[2] && o.subject_id === params[3] && o.status === 'pending') };
        }
        if (text.includes('FROM public.moov_onboarding_outbox') && text.includes('next_attempt_at IS NULL')) {
          return { rows: state.outbox.filter((o) => o.tenant_id === params[0] && o.environment === params[1] && o.status === 'pending' && !(o.next_attempt_at > Date.now())) };
        }
        if (text.includes('FROM public.moov_onboarding_outbox')) {
          return { rows: state.outbox.filter((o) => o.tenant_id === params[0] && o.environment === params[1] && o.status === 'pending') };
        }
        if (text.includes('INSERT INTO public.moov_onboarding_outbox')) {
          if (text.includes('DO NOTHING') && state.outbox.some((o) => o.tenant_id === params[0] && o.environment === params[1] && o.kind === params[2] && o.subject_id === params[3] && o.status === 'pending')) {
            return { rows: [] };
          }
          const row = { id: nextId(), tenant_id: params[0], environment: params[1], kind: params[2], subject_id: params[3], payload: JSON.parse(params[4]), status: 'pending', attempts: 0 };
          state.outbox.push(row);
          return { rows: [{ id: row.id }] };
        }
        if (text.includes('UPDATE public.moov_onboarding_outbox')) {
          const row = state.outbox.find((o) => o.id === params[0]);
          if (row && (row.status === 'pending' || !text.includes("AND status = 'pending'"))) {
            row.attempts += 1;
            if (text.includes("status = 'completed'")) Object.assign(row, { status: 'completed', last_error_code: null, next_attempt_at: null });
            else if (text.includes("status = 'abandoned'")) Object.assign(row, { status: 'abandoned', last_error_code: params[1] ?? 'document_missing' });
            else if (text.includes("THEN 'failed'")) {
              row.last_error_code = params[1];
              if (row.attempts >= params[2]) Object.assign(row, { status: 'failed', next_attempt_at: null });
              else row.next_attempt_at = Date.now() + 60000;
            }
          }
          return { rows: [] };
        }

        // banks / verifications / events
        if (text.includes('INSERT INTO public.payment_provider_methods')) {
          const row = { id: nextId(), tenant_id: params[0], environment: params[1], provider_account_id: params[2], provider_bank_account_id: params[3], last_four: params[6], routing_last_four: params[7], verification_status: params[9], connection_status: 'connected', external_recipient_id: null };
          state.methods.push(row);
          return { rows: [{ id: row.id }] };
        }
        if (text.includes('FROM public.payment_provider_methods')) {
          return { rows: state.methods.filter((m) => m.tenant_id === params[0] && m.environment === params[1] && (params[2] === undefined || m.id === params[2])) };
        }
        if (text.includes('UPDATE public.payment_provider_methods') && text.includes('provider_account_id = $3')) {
          for (const m of state.methods) {
            if (m.tenant_id === params[0] && m.environment === params[1] && m.provider_account_id === params[2] && !m.external_recipient_id) m.connection_status = 'disconnected';
          }
          return { rows: [] };
        }
        if (text.includes('UPDATE public.payment_provider_methods')) {
          const m = state.methods.find((x) => x.id === params[0]);
          if (m && text.includes("verification_status = 'verified'")) m.verification_status = 'verified';
          if (m && text.includes("'pending_micro_deposit'")) m.verification_status = 'pending_micro_deposit';
          return { rows: [] };
        }
        if (text.includes('INSERT INTO public.payment_method_verifications')) {
          const row = { id: nextId(), tenant_id: params[0], payment_method_id: params[1], environment: params[2], provider_account_id: params[3], provider_bank_account_id: params[4], status: 'pending', attempts: 0 };
          state.verifications.push(row);
          return { rows: [row] };
        }
        if (text.includes('FROM public.payment_method_verifications')) {
          return { rows: state.verifications.filter((v) => (v.id === params[0] || v.payment_method_id === params[0]) && v.tenant_id === params[1] && v.environment === params[2]) };
        }
        if (text.includes('UPDATE public.payment_method_verifications')) {
          const v = state.verifications.find((x) => x.id === params[0]);
          if (v && text.includes('SET attempts = attempts + 1')) {
            if (v.attempts >= (v.max_attempts ?? 3)) return { rows: [] };
            v.attempts += 1;
            return { rows: [{ attempts: v.attempts }] };
          }
          if (v && text.includes("status = 'verified'")) Object.assign(v, { status: 'verified', attempts: params[1] });
          if (v && text.includes('SET failure_reason = $2')) {
            v.failure_reason = params[1];
            if (v.attempts >= (v.max_attempts ?? 3)) v.status = 'max_attempts_exceeded';
          }
          return { rows: [] };
        }
        if (text.includes('INSERT INTO public.payment_event_log')) {
          state.events.push({ sql: text, params });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    clients.push(client);
    return client;
  };
  return { state, create, clients };
};

/** Reversible fake KMS. Ciphertext never contains the plaintext digits. */
const fakeKms = () => {
  const calls = [];
  return {
    calls,
    encrypt: async (input) => {
      calls.push({ op: 'encrypt', KeyId: input.KeyId, EncryptionContext: input.EncryptionContext });
      const bytes = Buffer.from(input.Plaintext).map((b) => b ^ 0x5a);
      return { CiphertextBlob: Buffer.concat([Buffer.from('CTX'), bytes]), KeyId: input.KeyId };
    },
    decrypt: async (input) => {
      calls.push({ op: 'decrypt', EncryptionContext: input.EncryptionContext });
      return { Plaintext: Buffer.from(input.CiphertextBlob).subarray(3).map((b) => b ^ 0x5a) };
    },
  };
};

const sandboxCreds = async () => ({
  moov: { publicKey: 'pk_sandbox', secretKey: 'sk_sandbox', platformAccountId: PLATFORM_ID, origin: 'https://checksops.com', apiVersion: 'v2024.01.00' },
});

/** Recorded Moov fetch. `fail` routes return an error status. */
const moovFetch = (routes = []) => {
  const calls = [];
  let repSeq = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    calls.push({ url: u, method, headers: init.headers || {}, body: init.body });
    const hit = routes.find((r) => (r.match instanceof RegExp ? r.match.test(u) : u.includes(r.match)) && (!r.method || r.method === method));
    let status = hit?.status || 200;
    let payload = hit?.body;
    if (!hit) {
      if (u.endsWith('/oauth2/token')) payload = { access_token: 'tok', expires_in: 300 };
      else if (u.endsWith('/accounts') && method === 'POST') payload = { accountID: MOOV_ACCOUNT };
      else if (/\/representatives$/.test(u) && method === 'POST') { repSeq += 1; payload = { representativeID: `rep_${repSeq}` }; }
      else if (/\/files$/.test(u) && method === 'POST') payload = { fileID: 'file_1', fileStatus: 'pending' };
      else if (/\/bank-accounts$/.test(u) && method === 'POST') payload = { bankAccountID: 'bank_1', status: 'new', bankName: 'Test Bank', lastFourAccountNumber: '6789' };
      else if (/\/bank-accounts$/.test(u)) payload = [];
      else if (/\/capabilities$/.test(u) && method === 'GET') payload = [];
      else payload = {};
    }
    if (typeof hit?.status === 'function') status = hit.status();
    return { ok: status < 400, status, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})) };
  };
  return { fetchImpl, calls };
};

const run = async (name, body, user, { db, fetch = moovFetch(), kms = fakeKms(), s3, sign, extraDeps = {} } = {}) => {
  const event = jwtEvent(name, body, user);
  return handleProviderRequest(event, `/functions/v1/${name}`, 'POST', {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => db.create(),
    loadSandboxCredentials: sandboxCreds,
    fetchImpl: fetch.fetchImpl,
    kms,
    ...(s3 ? { s3 } : {}),
    ...(sign ? { getSignedUrl: sign } : {}),
    ...extraDeps,
  });
};

const ADDRESS = { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701' };
const BUSINESS = {
  legal_name: 'Freedom Adjusting LLC', dba: 'Freedom', type: 'llc', ein: EIN, email: 'ops@freedom.test',
  phone: '5125550100', website: 'freedom.test', description: 'Adjusting', address: ADDRESS,
};
const REP = {
  name: 'Jane Doe', email: 'jane@freedom.test', phone: '5125550101', title: 'CEO', dob: '1980-04-15',
  ssn: SSN_DASHED, address: ADDRESS, is_controller: true, ownership_pct: 60,
};
const saveBody = (extra = {}) => ({ tenant_id: TENANT, business: BUSINESS, representatives: [REP], ...extra });
const UNDERWRITING = {
  geographicReach: 'us-only',
  sendFunds: { ach: { estimatedActivity: { monthlyVolumeRange: 'under-10k' } } },
  collectFunds: { ach: { estimatedActivity: { monthlyVolumeRange: '10k-50k' } } },
};

const allPersisted = (db) => JSON.stringify([db.state.writes, db.state.profiles, db.state.reps, db.state.outbox, db.state.events]);

// ------------------------------------------------------------------ tests

test('catalog lists every onboarding function as a Moov function', () => {
  for (const name of ONBOARDING_FUNCTION_NAMES) assert.equal(FUNCTION_BY_NAME[name]?.provider, 'moov', name);
  assert.deepEqual([...NEW_ONBOARDING_FUNCTION_NAMES].sort(), [
    'moov-document-finalize', 'moov-document-upload-url', 'moov-document-view',
    'moov-ein-reveal', 'moov-onboarding-get', 'moov-onboarding-save',
  ]);
});

test('access matrix: every member of the tenant (any stored role) and the platform owner submit; partners, other tenants and non-member global admins get nothing', async () => {
  await withEnv(BASE_ENV, async () => {
    // Owner policy: no role tiers. The stored tenant_users.role is ignored.
    for (const who of ['owner', 'admin', 'manager', 'operator', 'viewer', 'platformOwner']) {
      resetMoovTokenCache();
      const db = makeDb();
      const result = await run('moov-onboarding-save', saveBody(), USERS[who], { db });
      assert.equal(result.ok, true, who);
      assert.equal(result.saved, true, who);
      assert.equal(result.moov_synced, true, who);
      assert.equal(result.can_submit, true, who);
      const read = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS[who], { db });
      assert.equal(read.ok, true, who);
      assert.equal(read.can_submit, true, who);
      const uw = await run('moov-underwriting', { tenant_id: TENANT, action: 'save', answers: UNDERWRITING }, USERS[who], { db });
      assert.equal(uw.ok, true, `${who} underwriting save`);
      const up = await run('moov-document-upload-url', {
        tenant_id: TENANT, purpose: 'w9', file_name: 'w9.pdf', content_type: 'application/pdf', size: 10,
      }, USERS[who], { db, sign: async () => 'https://s3.example/put' });
      assert.equal(up.ok, true, `${who} upload url`);
    }
    // A viewer-role member gets no tier-based refusal anywhere.
    const src = readFileSync(new URL('../functions/api/providers/onboarding/context.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /\.role\b/);
    for (const who of ['partner', 'globalAdmin']) {
      const db = makeDb();
      for (const name of ONBOARDING_FUNCTION_NAMES) {
        const r = await run(name, saveBody({ document_id: TENANT }), USERS[who], { db });
        assert.equal(r.statusCode, 403, `${who} ${name}`);
        assert.equal(r.error, 'cross_tenant_denied', `${who} ${name}`);
      }
      assert.equal(db.state.writes.length, 0);
    }
  });
});

test('tenant_id is required: no first-membership fallback', async () => {
  await withEnv(BASE_ENV, async () => {
    const db = makeDb();
    for (const name of ['moov-onboarding-get', 'moov-onboarding-save', 'moov-bank-account-add', 'moov-sync', 'moov-document-upload-url']) {
      const r = await run(name, { business: BUSINESS }, USERS.owner, { db });
      assert.equal(r.statusCode, 400, name);
      assert.equal(r.error, 'tenant_id_required', name);
    }
    const bad = await run('moov-onboarding-get', { tenant_id: 'not-a-uuid' }, USERS.owner, { db });
    assert.equal(bad.error, 'invalid_uuid');
    // The strict rule lives in the onboarding context only (no resolveTenant, no fallback).
    const context = readFileSync(new URL('../functions/api/providers/onboarding/context.mjs', import.meta.url), 'utf8');
    const code = context.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /memberships\[0\]|resolveTenant|isPlatformAdmin|user_roles/);
  });
});

test('SSN never persisted: Moov gets it once; DB writes, outbox and logs only see the last four', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch();
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody({
      representatives: [REP, { ...REP, name: 'John Roe', ssn: SSN2, is_controller: false, ownership_pct: 40 }],
    }), USERS.owner, { db, fetch }));
    assert.equal(result.ok, true);
    assert.equal(result.moov_synced, true);
    const persisted = allPersisted(db);
    for (const value of [SSN, SSN_DASHED, SSN2]) {
      assert.equal(persisted.includes(value), false, `persisted ${value}`);
      assert.equal(lines.join('\n').includes(value), false, `logged ${value}`);
      assert.equal(JSON.stringify(result).includes(value), false, `returned ${value}`);
    }
    assert.deepEqual(db.state.reps.map((r) => r.ssn_last4).sort(), ['0001', '6789']);
    for (const o of db.state.outbox) assert.deepEqual(Object.keys(o.payload), ['profile_id']);
    // Full SSN goes to Moov only, in the representative POST.
    const posts = fetch.calls.filter((c) => /\/representatives$/.test(c.url) && c.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(JSON.parse(posts[0].body).governmentID.ssn.full, SSN);
    const other = fetch.calls.filter((c) => !/\/representatives$/.test(c.url));
    for (const c of other) assert.equal(String(c.body ?? '').includes(SSN), false, c.url);
    assert.deepEqual(result.representatives.map((r) => r.ssn_last4).sort(), ['0001', '6789']);
    assert.equal(result.representatives[0].dob_masked, '**/**/1980');
    assert.equal(JSON.stringify(result).includes('1980-04-15'), false);
  });
});

test('single-word representative name is accepted (mononym stored as first + ".")', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch();
    const { result } = await captureConsole(() => run('moov-onboarding-save', saveBody({
      representatives: [{ ...REP, name: 'Madonna' }],
    }), USERS.owner, { db, fetch }));
    assert.equal(result.ok, true);
    assert.equal(result.representatives[0].name, 'Madonna .');
    const posts = fetch.calls.filter((c) => /\/representatives$/.test(c.url) && c.method === 'POST');
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.equal(body.name.firstName, 'Madonna');
    assert.equal(body.name.lastName, '.');
  });
});

test('EIN encrypted at rest, masked in every read, revealed only through moov-ein-reveal to tenant members with an audit row', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const kms = fakeKms();
    const fetch = moovFetch();
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db, kms, fetch });
    const profile = db.state.profiles[0];
    assert.match(profile.ein_ciphertext, /^kms:v1:/);
    assert.equal(profile.ein_ciphertext.includes(EIN), false);
    assert.equal(profile.ein_last4, '4321');
    assert.equal(allPersisted(db).includes(EIN), false);
    assert.deepEqual(kms.calls.find((c) => c.op === 'encrypt').EncryptionContext, { app: 'checksops-moov-onboarding', environment: 'sandbox', tenant_id: TENANT, field: 'ein' });
    assert.equal(kms.calls.find((c) => c.op === 'encrypt').KeyId, PII_KEY);
    // Moov receives the EIN in the profile PATCH.
    const patch = fetch.calls.find((c) => c.method === 'PATCH' && c.url.endsWith(`/accounts/${MOOV_ACCOUNT}`) && String(c.body).includes('taxID'));
    assert.equal(JSON.parse(patch.body).profile.business.taxID.ein.number, EIN);

    for (const who of ['owner', 'manager', 'viewer']) {
      const view = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS[who], { db, kms });
      assert.equal(view.business.ein_masked, '*****4321', who);
      assert.equal(JSON.stringify(view).includes(EIN), false, who);
    }
    for (const who of ['owner', 'viewer', 'operator']) {
      const before = db.state.events.length;
      const revealed = await run('moov-ein-reveal', { tenant_id: TENANT }, USERS[who], { db, kms });
      assert.equal(revealed.ok, true, who);
      assert.equal(revealed.ein, EIN, who);
      const audit = db.state.events.slice(before).find((e) => e.params.includes('onboarding.ein_revealed') || e.sql.includes('onboarding.ein_revealed'));
      assert.ok(audit, `audit ${who}`);
      assert.equal(audit.params[2].includes(EIN), false);
    }
    // Owner decision: the platform owner (not a member) is refused, as are partners and global admins.
    for (const who of ['platformOwner', 'partner', 'globalAdmin']) {
      const before = db.state.events.length;
      const r = await run('moov-ein-reveal', { tenant_id: TENANT }, USERS[who], { db, kms });
      assert.equal(r.statusCode, 403, who);
      assert.equal(r.ein, undefined, who);
      assert.equal(db.state.events.slice(before).some((e) => e.sql.includes('onboarding.ein_revealed') || e.params.includes('onboarding.ein_revealed')), false, who);
    }
    assert.equal((await run('moov-ein-reveal', { tenant_id: TENANT }, USERS.platformOwner, { db, kms })).error, 'tenant_member_required');
  });
});

test('EIN cannot be saved without a KMS key: fails closed, nothing written', async () => {
  await withEnv({ ...BASE_ENV, MOOV_ONBOARDING_PII_KMS_KEY_ARN: undefined }, async () => {
    const db = makeDb();
    const r = await run('moov-onboarding-save', saveBody(), USERS.owner, { db });
    assert.equal(r.statusCode, 503);
    assert.equal(r.error, 'pii_encryption_unavailable');
    assert.equal(db.state.profiles.length, 0);
  });
});

test('upload URL: purpose, type and 20 MB limit validated; presigned PUT signs exact type/length and requires SSE-KMS headers', async () => {
  await withEnv(BASE_ENV, async () => {
    const db = makeDb();
    const signed = [];
    const sign = async (client, command, options) => {
      signed.push({ input: command.input, options });
      return 'https://s3.example/presigned';
    };
    for (const [body, error] of [
      [{ purpose: 'w9', file_name: 'a.exe', content_type: 'application/octet-stream', size: 10 }, 'unsupported_document_type'],
      [{ purpose: 'w9', file_name: 'a.pdf', content_type: 'image/png', size: 10 }, 'unsupported_document_type'],
      [{ purpose: 'w9', file_name: 'a.pdf', content_type: 'application/pdf', size: 20 * 1024 * 1024 + 1 }, 'invalid_document_size'],
      [{ purpose: 'w9', file_name: 'a.pdf', content_type: 'application/pdf', size: 0 }, 'invalid_document_size'],
      [{ purpose: 'selfie', file_name: 'a.pdf', content_type: 'application/pdf', size: 10 }, 'invalid_document_purpose'],
      [{ purpose: 'representative_verification', representative_id: OTHER_TENANT, file_name: 'a.pdf', content_type: 'application/pdf', size: 10 }, 'invalid_representative_id'],
    ]) {
      const r = await run('moov-document-upload-url', { tenant_id: TENANT, ...body }, USERS.owner, { db, sign });
      assert.equal(r.statusCode, 400, error);
      assert.equal(r.error, error);
    }
    assert.equal(signed.length, 0);
    const ok = await run('moov-document-upload-url', {
      tenant_id: TENANT, purpose: 'bank_statement', file_name: '../statement.PDF', content_type: 'application/pdf', size: 1234,
    }, USERS.admin, { db, sign });
    assert.equal(ok.ok, true);
    assert.equal(ok.upload_url, 'https://s3.example/presigned');
    const doc = db.state.docs[0];
    assert.equal(doc.status, 'pending_upload');
    assert.equal(doc.file_name, 'statement.PDF');
    assert.equal(doc.storage_key, `files/verification-docs/uploads/${TENANT}/${ok.document_id}`);
    const { input, options } = signed[0];
    assert.equal(input.Bucket, 'checksops-test-files');
    assert.equal(input.Key, doc.storage_key);
    assert.equal(input.ContentType, 'application/pdf');
    assert.equal(input.ContentLength, 1234);
    assert.equal(input.ServerSideEncryption, 'aws:kms');
    assert.equal(input.SSEKMSKeyId, DOC_KEY);
    assert.ok(options.expiresIn <= 300);
    assert.deepEqual([...options.signableHeaders].sort(), ['content-length', 'content-type']);
    assert.ok(options.unhoistableHeaders.has('x-amz-server-side-encryption'));
    assert.ok(options.unhoistableHeaders.has('x-amz-server-side-encryption-aws-kms-key-id'));
    assert.deepEqual(ok.headers, {
      'Content-Type': 'application/pdf',
      'Content-Length': '1234',
      'x-amz-server-side-encryption': 'aws:kms',
      'x-amz-server-side-encryption-aws-kms-key-id': DOC_KEY,
    });
  });
});

test('real presigner: type, length and SSE-KMS headers are signed, not hoisted to the query', async () => {
  await withEnv(BASE_ENV, async () => {
    const db = makeDb();
    const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
    const r = await run('moov-document-upload-url', {
      tenant_id: TENANT, purpose: 'w9', file_name: 'w9.png', content_type: 'image/png', size: 2048,
    }, USERS.owner, { db, s3, sign: getSignedUrl });
    const url = new URL(r.upload_url);
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders').split(';');
    for (const h of ['content-length', 'content-type', 'host', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']) {
      assert.ok(signedHeaders.includes(h), h);
    }
    assert.equal(url.searchParams.get('x-amz-server-side-encryption'), null);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  });
});

const PDF = new Uint8Array([...Buffer.from('%PDF-1.7\n'), 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1]);

const fakeS3 = ({ bytes, contentType, size = bytes.length, sse = 'aws:kms', key = DOC_KEY, versionId = 'v-1' }) => {
  const sent = [];
  const store = { uploadDeleted: false, finalExists: false, lateUpload: null };
  const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  return {
    sent,
    store,
    send: async (command) => {
      const kind = command.constructor.name;
      const input = command.input;
      sent.push({ kind, input });
      const isFinal = String(input.Key).includes('/final/');
      if (kind === 'HeadObjectCommand') {
        if (isFinal) {
          if (!store.finalExists || (input.VersionId && input.VersionId !== 'final-v1')) throw notFound();
          return { ContentLength: bytes.length, ContentType: contentType, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: DOC_KEY, VersionId: 'final-v1' };
        }
        if (store.lateUpload) return store.lateUpload;
        if (store.uploadDeleted) throw notFound();
        return { ContentLength: size, ContentType: contentType, ServerSideEncryption: sse, SSEKMSKeyId: key, VersionId: versionId };
      }
      if (kind === 'GetObjectCommand') {
        if (isFinal && input.VersionId !== 'final-v1') throw notFound();
        return { Body: { transformToByteArray: async () => bytes } };
      }
      if (kind === 'CopyObjectCommand') {
        store.finalExists = true;
        return { VersionId: 'final-v1' };
      }
      if (kind === 'DeleteObjectCommand' && !isFinal && input.VersionId === versionId) store.uploadDeleted = true;
      return {};
    },
  };
};

const uploadDoc = async (db, { contentType = 'application/pdf', fileName = 'a.pdf', size = PDF.length, purpose = 'business_verification' } = {}) => {
  const r = await run('moov-document-upload-url', { tenant_id: TENANT, purpose, file_name: fileName, content_type: contentType, size }, USERS.owner, {
    db, sign: async () => 'https://s3.example/put',
  });
  assert.equal(r.ok, true);
  return r.document_id;
};

test('finalize rejects size, type, encryption and magic-byte mismatches and deletes the object', async () => {
  await withEnv(BASE_ENV, async () => {
    for (const [s3opts, error] of [
      [{ bytes: PDF, contentType: 'application/pdf', size: PDF.length + 1 }, 'document_size_mismatch'],
      [{ bytes: PDF, contentType: 'image/png' }, 'document_type_mismatch'],
      [{ bytes: PDF, contentType: 'application/pdf', sse: 'AES256' }, 'document_encryption_mismatch'],
      [{ bytes: PDF, contentType: 'application/pdf', key: 'arn:aws:kms:us-east-1:111122223333:key/other' }, 'document_encryption_mismatch'],
      [{ bytes: new Uint8Array([...PNG, 0, 0, 0]).slice(0, PDF.length), contentType: 'application/pdf' }, 'document_content_mismatch'],
    ]) {
      const db = makeDb();
      const id = await uploadDoc(db);
      const s3 = fakeS3(s3opts);
      const fetch = moovFetch();
      const r = await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch });
      assert.equal(r.statusCode, 422, error);
      assert.equal(r.error, error);
      const del = s3.sent.find((c) => c.kind === 'DeleteObjectCommand');
      assert.ok(del, error);
      assert.equal(del.input.VersionId, 'v-1', `${error}: the rejected version itself is deleted`);
      assert.equal(fetch.calls.filter((c) => c.url.includes('/files')).length, 0, error);
    }
    assert.equal(sniffContentType(Buffer.from('a,b\n1,2\n')), 'text/csv');
    assert.equal(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffContentType(new Uint8Array([0x4d, 0x5a, 0x00, 0x01])), null);
  });
});

test('finalize sends the verified bytes to Moov files as multipart and records moov_file_id; retry is a no-op', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const id = await uploadDoc(db, { purpose: 'w9' });
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    const fetch = moovFetch();
    const r = await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch });
    assert.equal(r.ok, true);
    assert.equal(r.moov_synced, true);
    assert.equal(r.document.moov_file_id, 'file_1');
    assert.equal(r.document.moov_status, 'pending');
    // Verified upload version is copied to the final key; that copy is what is pinned.
    assert.equal(s3.sent.find((c) => c.kind === 'GetObjectCommand').input.VersionId, 'v-1');
    const copy = s3.sent.find((c) => c.kind === 'CopyObjectCommand');
    assert.equal(copy.input.Key, `files/verification-docs/final/${TENANT}/${id}`);
    assert.equal(copy.input.CopySource, `checksops-test-files/files/verification-docs/uploads/${TENANT}/${id}?versionId=v-1`);
    assert.equal(copy.input.ServerSideEncryption, 'aws:kms');
    assert.equal(copy.input.SSEKMSKeyId, DOC_KEY);
    assert.equal(db.state.docs[0].final_storage_key, `files/verification-docs/final/${TENANT}/${id}`);
    assert.equal(db.state.docs[0].s3_version_id, 'final-v1');
    const del = s3.sent.find((c) => c.kind === 'DeleteObjectCommand');
    assert.deepEqual([del.input.Key, del.input.VersionId], [`files/verification-docs/uploads/${TENANT}/${id}`, 'v-1']);
    const call = fetch.calls.find((c) => c.url.endsWith(`/accounts/${MOOV_ACCOUNT}/files`));
    assert.equal(call.method, 'POST');
    assert.ok(call.headers['X-Idempotency-Key'], 'Moov files POST is idempotent per document');
    assert.ok(call.body instanceof FormData);
    assert.equal(call.headers['Content-Type'], undefined);
    const file = call.body.get('file');
    assert.equal(file.type, 'application/pdf');
    assert.equal(file.name, 'a.pdf');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PDF);
    assert.equal(call.body.get('filePurpose'), 'business_verification');
    // Only keys Moov accepts (staging 2026-10-26: checksops_document_id was refused with a 422).
    assert.deepEqual(JSON.parse(call.body.get('metadata')), { comment: `checksops:w9:${id}` });
    assert.equal(db.state.outbox[0].status, 'completed');
    const again = await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch });
    assert.equal(again.document.moov_file_id, 'file_1');
    assert.equal(fetch.calls.filter((c) => c.url.endsWith('/files')).length, 1);
    // Members may view; partners may not.
    const view = await run('moov-document-view', { tenant_id: TENANT, document_id: id }, USERS.viewer, { db, sign: async (c, cmd, o) => `https://s3.example/get?exp=${o.expiresIn}&key=${cmd.input.Key}&v=${cmd.input.VersionId}` });
    assert.equal(view.ok, true);
    assert.match(view.url, /exp=60/);
    assert.match(view.url, new RegExp(`key=files/verification-docs/final/${TENANT}/${id}&v=final-v1$`));
    const alias = await run('moov-account-file-view', { tenant_id: TENANT, file_id: id }, USERS.platformOwner, { db, sign: async () => 'https://s3.example/get' });
    assert.equal(alias.ok, true);
    const partner = await run('moov-document-view', { tenant_id: TENANT, document_id: id }, USERS.partner, { db, sign: async () => 'x' });
    assert.equal(partner.statusCode, 403);
  });
});

test('Moov file failure leaves the document stored and pending; moov-sync retries from the outbox', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const id = await uploadDoc(db);
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    const failing = moovFetch([{ match: '/files', method: 'POST', status: 503, body: { error: 'down' } }]);
    const r = await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch: failing });
    assert.equal(r.ok, true);
    assert.equal(r.pending, true);
    assert.equal(r.error_code, 'moov_unavailable');
    assert.equal(r.document.moov_file_id, null);
    assert.equal(db.state.docs[0].moov_status, 'sync_failed');
    assert.equal(db.state.outbox[0].status, 'pending');
    // Inside the backoff window nothing is re-sent.
    const early = moovFetch();
    await run('moov-sync', { tenant_id: TENANT }, USERS.owner, { db, s3, fetch: early });
    assert.equal(early.calls.filter((c) => c.url.endsWith('/files')).length, 0);
    db.state.outbox[0].next_attempt_at = 0; // backoff elapsed
    const retry = await run('moov-sync', { tenant_id: TENANT }, USERS.owner, { db, s3, fetch: moovFetch() });
    assert.equal(retry.ok, true);
    assert.equal(db.state.docs[0].moov_file_id, 'file_1');
    assert.equal(db.state.outbox[0].status, 'completed');
  });
});

test('a person\'s document names their Moov representative, and waits until that person reaches Moov', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const id = await uploadDoc(db, { purpose: 'representative_verification' });
    const repId = '11111111-2222-4333-8444-555555555555';
    db.state.reps.push({ id: repId, tenant_id: TENANT, environment: db.state.docs[0].environment, removed_at: null, moov_representative_id: null });
    db.state.docs[0].representative_id = repId;
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    const early = moovFetch();
    const waiting = await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch: early });
    assert.equal(waiting.error_code, 'moov_representative_missing');
    assert.equal(early.calls.filter((c) => c.url.endsWith('/files')).length, 0, 'nothing sent before the person is at Moov');
    db.state.reps[db.state.reps.length - 1].moov_representative_id = 'rep_moov_1';
    const fetch = moovFetch();
    const sent = await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch });
    assert.equal(sent.moov_synced, true);
    const call = fetch.calls.find((c) => c.url.endsWith('/files'));
    assert.equal(call.body.get('filePurpose'), 'representative_verification');
    assert.deepEqual(JSON.parse(call.body.get('metadata')), { comment: `checksops:representative_verification:${id}`, representative_id: 'rep_moov_1' });
  });
});

test('a refused Moov file logs Moov\'s masked reason and status, never the file name', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const id = await uploadDoc(db, { fileName: 'freedom-w9.pdf' });
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    const refusing = moovFetch([{
      match: '/files', method: 'POST', status: 422,
      body: { error: 'file rejected for owner@freedom.test account 000123456789' },
    }]);
    const { result, lines } = await captureConsole(() => run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch: refusing }));
    assert.equal(result.error_code, 'moov_rejected');
    const log = lines.find((line) => line.includes('moov_document_send_failed'));
    assert.ok(log, 'failure logged');
    const parsed = JSON.parse(log);
    assert.equal(parsed.status, 422);
    assert.equal(parsed.error_code, 'moov_rejected');
    assert.equal(parsed.reason, 'file rejected for [redacted] account [redacted]');
    assert.equal(log.includes('owner@freedom.test'), false);
    assert.equal(log.includes('000123456789'), false);
    assert.equal(db.state.docs[0].file_name, 'freedom-w9.pdf');
    assert.equal(log.includes('freedom-w9'), false);
  });
});

test('moov-onboarding-get industries: Moov\'s list on v2025.07.00 with the profile-enrichment scope, four fields only', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch([{ match: /\/industries$/, method: 'GET', body: { industries: [
      { industry: 'insurance-services', displayName: 'Insurance services', category: 'financial', categoryDisplayName: 'Financial', defaultMcc: '6411' },
      { displayName: 'no identifier' },
    ] } }]);
    const r = await run('moov-onboarding-get', { tenant_id: TENANT, action: 'industries' }, USERS.viewer, { db, fetch });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.industries, [
      { industry: 'insurance-services', displayName: 'Insurance services', category: 'financial', categoryDisplayName: 'Financial' },
    ]);
    const call = fetch.calls.find((c) => c.url.endsWith('/industries'));
    assert.equal(call.method, 'GET');
    assert.equal(call.headers['x-moov-version'], 'v2025.07.00');
    const token = fetch.calls.find((c) => c.url.endsWith('/oauth2/token'));
    assert.equal(new URLSearchParams(token.body).get('scope'), '/profile-enrichment.read');
    // Without the action the read is unchanged and calls no provider.
    const view = moovFetch();
    const plain = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS.viewer, { db, fetch: view });
    assert.equal(plain.ok, true);
    assert.equal(plain.industries, undefined);
    assert.equal(view.calls.length, 0);
  });
});

test('business industry: saved, shown, sent to Moov, kept when absent, cleared by null, refused when malformed', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch();
    const saved = await run('moov-onboarding-save', saveBody({ business: { ...BUSINESS, industry: 'insurance-services' } }), USERS.owner, { db, fetch });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(db.state.profiles[0].industry, 'insurance-services');
    const sent = fetch.calls.filter((c) => /\/accounts(\/[^/]+)?$/.test(c.url) && ['POST', 'PATCH'].includes(c.method)).map((c) => JSON.parse(c.body));
    assert.ok(sent.some((b) => b?.profile?.business?.industry === 'insurance-services'), 'industry sent on the business profile');
    const view = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS.viewer, { db });
    assert.equal(view.business.industry, 'insurance-services');
    // A save without the field keeps it; null clears it.
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db });
    assert.equal(db.state.profiles[0].industry, 'insurance-services');
    await run('moov-onboarding-save', saveBody({ business: { ...BUSINESS, industry: null } }), USERS.owner, { db });
    assert.equal(db.state.profiles[0].industry, null);
    const bad = await run('moov-onboarding-save', saveBody({ business: { ...BUSINESS, industry: 'Insurance Services!' } }), USERS.owner, { db });
    assert.equal(bad.ok, false);
    assert.equal(bad.field, 'business.industry');
  });
});

test('underwriting: POST on v2025.07.00 with exactly reach and ACH volumes; the old answers and unknown values are refused before Moov', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch();
    const r = await run('moov-underwriting', { tenant_id: TENANT, action: 'save', answers: UNDERWRITING }, USERS.owner, { db, fetch });
    assert.equal(r.ok, true, JSON.stringify(r));
    const post = fetch.calls.find((c) => c.url.endsWith('/underwriting'));
    assert.equal(post.method, 'POST');
    assert.equal(post.headers['x-moov-version'], 'v2025.07.00');
    assert.deepEqual(JSON.parse(post.body), UNDERWRITING);
    const read = moovFetch([{ match: /\/underwriting$/, method: 'GET', body: UNDERWRITING }]);
    const got = await run('moov-underwriting', { tenant_id: TENANT, action: 'get' }, USERS.viewer, { db, fetch: read });
    assert.deepEqual(got.underwriting, UNDERWRITING);
    assert.equal(read.calls.find((c) => c.url.endsWith('/underwriting')).headers['x-moov-version'], 'v2025.07.00');
    for (const [answers, field] of [
      [{ averageTransactionSize: 100, maxTransactionSize: 200, averageMonthlyTransactionVolume: 1000 }, 'answers'],
      [{ ...UNDERWRITING, geographicReach: 'mars' }, 'answers.geographicReach'],
      [{ ...UNDERWRITING, sendFunds: { ach: { estimatedActivity: { monthlyVolumeRange: '1-2' } } } }, 'answers.sendFunds'],
      [{ ...UNDERWRITING, collectFunds: { ach: { estimatedActivity: { monthlyVolumeRange: 'under-10k', extra: 1 } } } }, 'answers.collectFunds'],
      [{ geographicReach: 'us-only', sendFunds: UNDERWRITING.sendFunds }, 'answers.collectFunds'],
    ]) {
      const none = moovFetch();
      const refused = await run('moov-underwriting', { tenant_id: TENANT, action: 'save', answers }, USERS.owner, { db, fetch: none });
      assert.equal(refused.ok, false, field);
      assert.equal(refused.statusCode, 400, field);
      assert.equal(refused.field, field);
      assert.equal(none.calls.some((c) => c.url.endsWith('/underwriting')), false, `${field}: not sent to Moov`);
    }
  });
});

test('underwriting: the extended answers (ACH amounts next to the range, presence, litigation, customer-type share) go to Moov as given; malformed ones are refused before Moov', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const activity = (monthlyVolumeRange, averageTransactionAmount, maximumTransactionAmount) => ({
      ach: { estimatedActivity: { monthlyVolumeRange, averageTransactionAmount, maximumTransactionAmount } },
    });
    const EXTENDED = {
      geographicReach: 'us-only',
      sendFunds: activity('50k-100k', 2500, 25000),
      collectFunds: activity('50k-100k', 1500, 15000),
      businessPresence: 'commercial-office',
      pendingLitigation: 'none',
      volumeShareByCustomerType: { business: 80, consumer: 20, p2p: 0 },
    };
    const fetch = moovFetch();
    const r = await run('moov-underwriting', { tenant_id: TENANT, action: 'save', answers: EXTENDED }, USERS.owner, { db, fetch });
    assert.equal(r.ok, true, JSON.stringify(r));
    const post = fetch.calls.find((c) => c.url.endsWith('/underwriting'));
    assert.equal(post.headers['x-moov-version'], 'v2025.07.00');
    assert.deepEqual(JSON.parse(post.body), EXTENDED);
    for (const [answers, field] of [
      [{ ...EXTENDED, sendFunds: activity('50k-100k', 2500.5, 25000) }, 'answers.sendFunds'],
      [{ ...EXTENDED, sendFunds: activity('50k-100k', '2500', 25000) }, 'answers.sendFunds'],
      [{ ...EXTENDED, collectFunds: activity('50k-100k', 1500, 100) }, 'answers.collectFunds'],
      [{ ...EXTENDED, collectFunds: activity('50k-100k', 0, 100) }, 'answers.collectFunds'],
      [{ ...EXTENDED, businessPresence: 'garage' }, 'answers.businessPresence'],
      [{ ...EXTENDED, pendingLitigation: 'pending' }, 'answers.pendingLitigation'],
      [{ ...EXTENDED, volumeShareByCustomerType: { business: 80, consumer: 30, p2p: 0 } }, 'answers.volumeShareByCustomerType'],
      [{ ...EXTENDED, volumeShareByCustomerType: { business: 100, merchants: 0 } }, 'answers.volumeShareByCustomerType'],
      [{ ...EXTENDED, volumeShareByCustomerType: { business: 99.5, consumer: 0.5 } }, 'answers.volumeShareByCustomerType'],
      [{ ...EXTENDED, submissionIntent: 'submit' }, 'answers'],
    ]) {
      const none = moovFetch();
      const refused = await run('moov-underwriting', { tenant_id: TENANT, action: 'save', answers }, USERS.owner, { db, fetch: none });
      assert.equal(refused.ok, false, field);
      assert.equal(refused.statusCode, 400, field);
      assert.equal(refused.field, field);
      assert.equal(none.calls.some((c) => c.url.endsWith('/underwriting')), false, `${field}: not sent to Moov`);
    }
  });
});

test('legacy file upload is refused with a pointer to the new flow', async () => {
  await withEnv(BASE_ENV, async () => {
    const db = makeDb();
    const r = await run('moov-account-file-upload', { tenant_id: TENANT, file_base64: 'JVBERi0=' }, USERS.owner, { db });
    assert.equal(r.statusCode, 410);
    assert.equal(r.error, 'use_moov_document_upload_url');
    assert.deepEqual(r.replacement, ['moov-document-upload-url', 'moov-document-finalize']);
    const files = await run('moov-account-files', { tenant_id: TENANT }, USERS.viewer, { db });
    assert.equal(files.ok, true);
    assert.equal(files.account_connected, true);
    assert.ok(Array.isArray(files.representatives));
  });
});

test('Moov failure after save returns saved+pending, flags SSN re-entry, and moov-sync re-sends everything except the SSN', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const failing = moovFetch([{ match: '/representatives', method: 'POST', status: 502, body: { error: 'bad gateway' } }]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: failing }));
    assert.equal(result.ok, true);
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, false);
    assert.equal(result.pending, true);
    assert.equal(result.error_code, 'moov_unavailable');
    assert.equal(result.sync.pending, true);
    assert.equal(result.representatives[0].ssn_resubmit_required, true);
    assert.equal(db.state.outbox[0].status, 'pending');
    assert.equal(lines.join('\n').includes(SSN), false);
    assert.equal(allPersisted(db).includes(SSN), false);

    db.state.outbox[0].next_attempt_at = 0; // backoff elapsed
    const retryFetch = moovFetch();
    const retry = await run('moov-sync', { tenant_id: TENANT }, USERS.admin, { db, fetch: retryFetch });
    assert.equal(retry.ok, true);
    const patch = retryFetch.calls.find((c) => c.method === 'PATCH' && String(c.body).includes('legalBusinessName'));
    assert.ok(patch, 'profile re-sent');
    assert.equal(JSON.parse(patch.body).profile.business.taxID.ein.number, EIN);
    for (const c of retryFetch.calls) assert.equal(String(c.body ?? '').includes(SSN), false);
    assert.equal(retryFetch.calls.filter((c) => /\/representatives$/.test(c.url) && c.method === 'POST').length, 0);
    assert.equal(db.state.reps[0].ssn_resubmit_required, true);

    // Owner re-enters the SSN: the person is created and the flag clears.
    const fixed = await run('moov-onboarding-save', saveBody({
      representatives: [{ ...REP, id: db.state.reps[0].id }],
    }), USERS.owner, { db, fetch: moovFetch() });
    assert.equal(fixed.moov_synced, true);
    assert.equal(fixed.representatives[0].ssn_resubmit_required, false);
    assert.equal(db.state.reps[0].moov_representative_id, 'rep_1');
  });
});

test('Moov 422 after save names the failed step and rejected field paths, never Moov messages or values', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const rejecting = moovFetch([{
      match: `/accounts/${MOOV_ACCOUNT}`,
      method: 'PATCH',
      status: 422,
      body: { error: { profile: { business: { website: `bad value ${EIN}`, phone: { number: 'must be 10 digits' } } } } },
    }]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: rejecting }));
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, false);
    assert.equal(result.error_code, 'moov_rejected');
    assert.deepEqual(result.rejected_fields, ['profile.business.website', 'profile.business.phone.number']);
    const log = lines.find((line) => line.includes('moov_onboarding_sync_failed'));
    assert.ok(log, 'failure logged');
    const parsed = JSON.parse(log);
    assert.equal(parsed.step, 'business_profile');
    assert.deepEqual(parsed.rejected_fields, ['profile.business.website', 'profile.business.phone.number']);
    assert.equal(log.includes('must be 10 digits'), false);
    assert.equal(log.includes(EIN), false);
    assert.equal(JSON.stringify(result).includes(EIN), false);
  });
});

test('Moov 409 on a representative logs the step, create or update, and Moov\'s masked reason, never the SSN or email', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const conflicting = moovFetch([{
      match: `/accounts/${MOOV_ACCOUNT}/representatives`,
      method: 'POST',
      status: 409,
      body: { error: `representative owner@freedom.test with SSN ${SSN_DASHED} already exists` },
    }]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: conflicting }));
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, false);
    assert.equal(result.error_code, 'moov_conflict');
    const log = lines.find((line) => line.includes('moov_onboarding_sync_failed'));
    assert.ok(log, 'failure logged');
    const parsed = JSON.parse(log);
    assert.equal(parsed.status, 409);
    assert.equal(parsed.step, 'representative');
    assert.equal(parsed.representative_call, 'create');
    assert.equal(typeof parsed.reason, 'string');
    assert.match(parsed.reason, /already exists/);
    assert.equal(log.includes('owner@freedom.test'), false);
    assert.equal(log.includes(SSN_DASHED), false);
    assert.equal(log.includes(SSN_DASHED.replace(/-/g, '')), false);
    // The caller's response carries no Moov message.
    assert.equal(JSON.stringify(result).includes('already exists'), false);
  });
});

test('Moov 409 on the business profile logs a masked reason and still sends representatives and the capability request', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    let profilePatches = 0;
    const conflicting = moovFetch([{
      match: `/accounts/${MOOV_ACCOUNT}`,
      method: 'PATCH',
      // Only the business-profile PATCH (the first) is refused; ownersProvided goes through.
      status: () => (++profilePatches === 1 ? 409 : 200),
      body: { error: `cannot update verified fields for owner@freedom.test ${EIN}` },
    }]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: conflicting }));
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, true, JSON.stringify(result));
    assert.equal(result.error_code, undefined);
    assert.ok(conflicting.calls.some((c) => c.method === 'POST' && /\/representatives$/.test(c.url)), 'representatives still sent');
    assert.ok(conflicting.calls.some((c) => c.method === 'POST' && /\/capabilities$/.test(c.url)), 'capabilities still requested');
    const all = lines.join('\n');
    assert.equal(all.includes('moov_onboarding_sync_failed'), false);
    const log = lines.find((line) => line.includes('moov_onboarding_profile_conflict'));
    assert.ok(log, 'conflict logged');
    const parsed = JSON.parse(log);
    assert.equal(parsed.step, 'business_profile');
    assert.equal(parsed.status, 409);
    assert.match(parsed.reason, /^cannot update verified fields for \[redacted\] \[redacted\]/);
    assert.equal(log.includes('owner@freedom.test'), false);
    assert.equal(log.includes(EIN), false);
  });
});

test('a locked Moov profile skips the refused representative and owners writes and still requests capabilities', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const locked = { error: 'patch data not in valid state: profile locked: profile fields cannot be updated' };
    const conflicting = moovFetch([
      { match: `/accounts/${MOOV_ACCOUNT}`, method: 'PATCH', status: 409, body: locked },
      { match: /\/representatives$/, method: 'POST', status: 409, body: locked },
    ]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: conflicting }));
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, true, JSON.stringify(result));
    assert.ok(conflicting.calls.some((c) => c.method === 'POST' && /\/capabilities$/.test(c.url)), 'capabilities still requested');
    const all = lines.join('\n');
    assert.equal(all.includes('moov_onboarding_sync_failed'), false);
    const steps = lines.filter((line) => line.includes('moov_onboarding_profile_conflict')).map((line) => JSON.parse(line).step);
    assert.ok(steps.includes('business_profile'));
    assert.ok(steps.includes('representative'));
    assert.ok(steps.includes('owners_provided'));
    assert.equal(all.includes(EIN), false);
  });
});

test('a Moov 409 on a representative still fails the sync when the profile is not locked', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    let profilePatches = 0;
    const conflicting = moovFetch([
      { match: `/accounts/${MOOV_ACCOUNT}`, method: 'PATCH', status: () => (++profilePatches === 1 ? 409 : 200), body: { error: 'other conflict' } },
      { match: /\/representatives$/, method: 'POST', status: 409, body: { error: 'duplicate representative' } },
    ]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: conflicting }));
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, false);
    assert.equal(result.error_code, 'moov_conflict');
    assert.equal(conflicting.calls.some((c) => c.method === 'POST' && /\/capabilities$/.test(c.url)), false);
    const log = lines.find((line) => line.includes('moov_onboarding_sync_failed'));
    assert.equal(JSON.parse(log).step, 'representative');
  });
});

test('a refused underwriting save logs Moov\'s masked reason and status', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db });
    const refusing = moovFetch([{
      match: /\/underwriting$/, method: 'POST', status: 409,
      body: { error: `underwriting cannot be changed for owner@freedom.test ${EIN}` },
    }]);
    const { result, lines } = await captureConsole(() => run('moov-underwriting', { tenant_id: TENANT, action: 'save', answers: UNDERWRITING }, USERS.owner, { db, fetch: refusing }));
    assert.equal(result.ok, false);
    const log = lines.find((line) => line.includes('moov_underwriting_failed'));
    assert.ok(log, 'failure logged');
    const parsed = JSON.parse(log);
    assert.equal(parsed.status, 409);
    assert.equal(parsed.error_code, 'moov_conflict');
    assert.match(parsed.reason, /^underwriting cannot be changed for \[redacted\] \[redacted\]/);
    assert.equal(log.includes('owner@freedom.test'), false);
    assert.equal(log.includes(EIN), false);
  });
});

test('moovConflictReason reads only 409 bodies and masks emails and digit runs', async () => {
  const { moovConflictReason } = await import('../functions/api/providers/onboarding/moov-sync.mjs');
  assert.equal(moovConflictReason({ status: 422, body: { error: 'x' } }), null);
  assert.equal(moovConflictReason({ status: 409, body: {} }), null);
  assert.equal(moovConflictReason({ status: 409, body: 'plain a@b.co 123456' }), 'plain [redacted] [redacted]');
  assert.equal(moovConflictReason({ status: 409, body: JSON.stringify({ message: 'locked' }) }), 'locked');
  assert.equal(moovConflictReason({ status: 409, body: { error: 'x'.repeat(500) } }).length, 160);
});

test('business website is checked before Moov sees it: bare domains get https://, bad values fail on business.website', async () => {
  const { normalizeWebsite, WEBSITE_MAX } = await import('../functions/api/providers/onboarding/store.mjs');
  assert.equal(WEBSITE_MAX, 100);
  assert.equal(normalizeWebsite('freedom.test'), 'https://freedom.test');
  assert.equal(normalizeWebsite('  www.Freedom-Adjusting.com/claims?x=1  '), 'https://www.Freedom-Adjusting.com/claims?x=1');
  assert.equal(normalizeWebsite('http://freedom.test'), 'http://freedom.test');
  assert.equal(normalizeWebsite(''), null);
  assert.equal(normalizeWebsite(undefined), null);
  for (const bad of [
    'Freedom Adjusting',           // spaces, no host
    'freedom',                     // no dot
    'localhost',
    'freedom.',                    // empty label
    '.freedom.test',
    'freedom.t3st',                // TLD with a digit
    'ftp://freedom.test',          // not http(s)
    'https://user:pw@freedom.test',
    'https://freedom.test:8443',
    'https://freedom test.com',
    'not a url at all',
    `https://${'a'.repeat(95)}.com`, // over 100 characters
  ]) {
    assert.throws(() => normalizeWebsite(bad), (e) => e.code === 'validation_failed' && e.extra?.field === 'business.website', bad);
  }

  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch();
    const r = await run('moov-onboarding-save', saveBody({ business: { ...BUSINESS, website: 'Freedom Adjusting' } }), USERS.owner, { db, fetch });
    assert.equal(r.statusCode, 400);
    assert.equal(r.error, 'validation_failed');
    assert.match(JSON.stringify(r), /business\.website/);
    assert.equal(fetch.calls.length, 0, 'nothing reaches Moov');
    assert.equal(db.state.profiles.length, 0, 'nothing is saved');

    const ok = await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch });
    assert.equal(ok.moov_synced, true);
    const sent = fetch.calls.find((c) => String(c.body).includes('legalBusinessName'));
    assert.ok(sent, 'business profile reaches Moov');
    assert.equal(JSON.parse(sent.body).profile.business.website, 'https://freedom.test');
  });
});

test('account creation uses one idempotency key per distinct payload, so a corrected payload is not a Moov 409', async () => {
  const { accountIdempotencyKey, accountBodyDigest } = await import('../functions/api/providers/onboarding/moov-sync.mjs');
  assert.equal(accountIdempotencyKey('sandbox', TENANT), `checksops-account-sandbox-${TENANT}`);
  assert.equal(accountBodyDigest({ a: 1 }), accountBodyDigest({ a: 1 }));
  assert.notEqual(accountBodyDigest({ a: 1 }), accountBodyDigest({ a: 2 }));
  assert.match(accountBodyDigest({ a: 1 }), /^[0-9a-f]{16}$/);

  await withEnv(BASE_ENV, async () => {
    const keyOf = (fetch) => fetch.calls.find((c) => c.method === 'POST' && /\/accounts$/.test(c.url))?.headers['X-Idempotency-Key'];
    resetMoovTokenCache();
    const first = moovFetch();
    const r1 = await run('moov-onboarding-save', saveBody({ business: { ...BUSINESS, website: 'Freedom Adjusting' } }), USERS.owner, { db: makeDb({ account: false }), fetch: first });
    assert.equal(r1.statusCode, 400, 'the bad website never reaches Moov');
    assert.equal(keyOf(first), undefined);

    const a = moovFetch();
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db: makeDb({ account: false }), fetch: a });
    const b = moovFetch();
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db: makeDb({ account: false }), fetch: b });
    const c = moovFetch();
    await run('moov-onboarding-save', saveBody({ business: { ...BUSINESS, website: 'other.test' } }), USERS.owner, { db: makeDb({ account: false }), fetch: c });
    assert.ok(keyOf(a));
    assert.equal(keyOf(a), keyOf(b), 'same payload, same key');
    assert.notEqual(keyOf(a), keyOf(c), 'different payload, different key');
  });
});

test('a Moov 409 on account creation adopts the account Moov already holds for the tenant, else stays moov_conflict', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb({ account: false });
    const adopting = moovFetch([
      { match: /\/accounts$/, method: 'POST', status: 409, body: { error: 'conflict' } },
      { match: /\/accounts\?foreignID=/, method: 'GET', body: [{ accountID: MOOV_ACCOUNT, foreignID: TENANT }] },
    ]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: adopting }));
    assert.equal(result.saved, true);
    assert.equal(result.moov_synced, true, JSON.stringify(result));
    assert.equal(result.account.connected, true);
    assert.equal(lines.join('\n').includes('moov_onboarding_sync_failed'), false);
    const lookup = adopting.calls.find((c) => c.method === 'GET' && /\/accounts\?foreignID=/.test(c.url));
    assert.ok(lookup, 'looked the account up by foreignID');
    assert.equal(decodeURIComponent(lookup.url.split('foreignID=')[1]), TENANT);
    assert.ok(adopting.calls.some((c) => c.method === 'PATCH' && c.url.endsWith(`/accounts/${MOOV_ACCOUNT}`)), 'profile synced to the adopted account');

    resetMoovTokenCache();
    const orphan = moovFetch([
      { match: /\/accounts$/, method: 'POST', status: 409, body: { error: 'conflict' } },
      { match: /\/accounts\?foreignID=/, method: 'GET', body: [] },
    ]);
    const { result: r2 } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db: makeDb({ account: false }), fetch: orphan }));
    assert.equal(r2.saved, true);
    assert.equal(r2.moov_synced, false);
    assert.equal(r2.error_code, 'moov_conflict');
    assert.equal(orphan.calls.filter((c) => c.method === 'POST' && /\/accounts$/.test(c.url)).length, 1, 'no blind retry');
  });
});

const NEW_MOOV_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accountIdempotencyKeyFor = (body) => accountIdempotencyKey('sandbox', TENANT, accountBodyDigest(body));
const accountGet = (body, status) => ({ match: new RegExp(`/accounts/${MOOV_ACCOUNT}$`), method: 'GET', ...(status ? { status } : {}), body });

test('a Moov account that was disconnected or is gone is replaced by a new one, with people, banks and terms reset', async () => {
  await withEnv(BASE_ENV, async () => {
    for (const gone of [accountGet({ accountID: MOOV_ACCOUNT, disconnectedOn: '2026-10-26T12:00:00Z' }), accountGet({ error: 'not found' }, 404)]) {
      resetMoovTokenCache();
      const db = makeDb();
      const first = await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: moovFetch() });
      assert.equal(first.moov_synced, true);
      assert.equal(db.state.reps[0].moov_representative_id, 'rep_1');
      Object.assign(db.state.accounts[0], { tos_accepted_at: '2026-07-01T00:00:00Z', onboarding_status: 'verification_pending' });
      db.state.methods.push({ id: 'aaaaaaaa-0000-4000-8000-0000000000b1', tenant_id: TENANT, environment: 'sandbox', provider_account_id: MOOV_ACCOUNT, provider_bank_account_id: 'bank_old', connection_status: 'connected', verification_status: 'verified', external_recipient_id: null });

      resetMoovTokenCache();
      const fetch = moovFetch([gone, { match: /\/accounts$/, method: 'POST', body: { accountID: NEW_MOOV_ACCOUNT } }]);
      const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody({ representatives: [{ ...REP, id: db.state.reps[0].id }] }), USERS.owner, { db, fetch }));
      assert.equal(result.moov_synced, true, JSON.stringify(result));
      assert.ok(lines.join('\n').includes('moov_account_gone'));
      const creates = fetch.calls.filter((c) => c.method === 'POST' && /\/accounts$/.test(c.url));
      assert.equal(creates.length, 1, 'one new account');
      const sameBodyKey = accountIdempotencyKeyFor(JSON.parse(creates[0].body));
      assert.notEqual(creates[0].headers['X-Idempotency-Key'], sameBodyKey, 'the gone create is never replayed');
      assert.equal(db.state.accounts.length, 1);
      assert.equal(db.state.accounts[0].provider_account_id, NEW_MOOV_ACCOUNT);
      assert.equal(db.state.accounts[0].tos_accepted_at, null, 'terms are accepted again on the new account');
      assert.equal(db.state.accounts[0].provider_metadata.replaced_account_id, MOOV_ACCOUNT);
      assert.ok(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith(`/accounts/${NEW_MOOV_ACCOUNT}/representatives`)), 'the person is created on the new account');
      assert.equal(fetch.calls.some((c) => c.url.includes(`/accounts/${MOOV_ACCOUNT}/`)), false, 'nothing more goes to the gone account');
      assert.ok(fetch.calls.some((c) => c.method === 'POST' && c.url.endsWith(`/accounts/${NEW_MOOV_ACCOUNT}/capabilities`)));
      assert.equal(db.state.methods.find((m) => m.provider_bank_account_id === 'bank_old').connection_status, 'disconnected');
    }
  });
});

test('a live Moov account is kept: no new account, no reset', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    db.state.accounts[0].tos_accepted_at = '2026-10-01T00:00:00Z';
    const fetch = moovFetch([accountGet({ accountID: MOOV_ACCOUNT, disconnectedOn: null })]);
    const r = await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch });
    assert.equal(r.moov_synced, true);
    assert.equal(fetch.calls.filter((c) => c.method === 'POST' && /\/accounts$/.test(c.url)).length, 0);
    assert.equal(db.state.accounts[0].provider_account_id, MOOV_ACCOUNT);
    assert.equal(db.state.accounts[0].tos_accepted_at, '2026-10-01T00:00:00Z');
  });
});

test('every save logs what Moov reports for the stored account, with no personal data', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const fetch = moovFetch([accountGet({ accountID: MOOV_ACCOUNT, profile: { business: { legalBusinessName: 'Freedom Adjusting LLC' } } })]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db: makeDb(), fetch }));
    assert.equal(result.moov_synced, true);
    const line = lines.find((l) => l.includes('moov_account_check'));
    assert.ok(line, 'logged');
    const logged = JSON.parse(line);
    assert.equal(logged.account_suffix, MOOV_ACCOUNT.slice(-4));
    assert.equal(logged.http_status, 200);
    assert.equal(logged.gone, false);
    assert.deepEqual(logged.account_keys, ['accountID', 'profile']);
    assert.equal(line.includes('Freedom Adjusting'), false);
    assert.equal(line.includes(MOOV_ACCOUNT), false);

    resetMoovTokenCache();
    const { lines: l404 } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db: makeDb(), fetch: moovFetch([accountGet({ error: 'x' }, 404)]) }));
    const gone = JSON.parse(l404.find((l) => l.includes('moov_account_check')));
    assert.equal(gone.http_status, 404);
    assert.equal(gone.gone, true);
  });
});

const foreignIdList = (body, status) => ({ match: /\/accounts\?foreignID=/, method: 'GET', ...(status ? { status } : {}), body });

test('an account disconnected in the Moov dashboard is replaced even when the account itself does not say so', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    // Staging 2026-10-26: the account answers without disconnectedOn, filed under the tenant, and
    // Moov's list of accounts connected to ChecksOps no longer returns it.
    const fetch = moovFetch([
      accountGet({ accountID: MOOV_ACCOUNT, foreignID: TENANT }),
      foreignIdList([]),
      { match: /\/accounts$/, method: 'POST', body: { accountID: NEW_MOOV_ACCOUNT } },
    ]);
    const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch }));
    assert.equal(result.moov_synced, true, JSON.stringify(result));
    assert.equal(db.state.accounts[0].provider_account_id, NEW_MOOV_ACCOUNT);
    const logged = JSON.parse(lines.find((l) => l.includes('moov_account_check')));
    assert.deepEqual(
      { gone: logged.gone, disconnected_on: logged.disconnected_on, filed_here: logged.filed_here, listed: logged.listed },
      { gone: true, disconnected_on: false, filed_here: true, listed: false },
    );
    assert.equal(lines.find((l) => l.includes('moov_account_check')).includes(MOOV_ACCOUNT), false, 'no full account id logged');
  });
});

test('an account Moov still lists as connected is kept; a list that cannot be read or another foreignID never replaces it', async () => {
  await withEnv(BASE_ENV, async () => {
    for (const [remote, list, listed] of [
      [{ accountID: MOOV_ACCOUNT, foreignID: TENANT }, foreignIdList([{ accountID: MOOV_ACCOUNT, foreignID: TENANT }]), true],
      [{ accountID: MOOV_ACCOUNT, foreignID: TENANT }, foreignIdList({ error: 'down' }, 503), null],
      [{ accountID: MOOV_ACCOUNT, foreignID: OTHER_TENANT }, foreignIdList([]), null],
    ]) {
      resetMoovTokenCache();
      const db = makeDb();
      const fetch = moovFetch([accountGet(remote), list]);
      const { result, lines } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch }));
      assert.equal(result.moov_synced, true, JSON.stringify(result));
      assert.equal(fetch.calls.filter((c) => c.method === 'POST' && /\/accounts$/.test(c.url)).length, 0, 'no new account');
      assert.equal(db.state.accounts[0].provider_account_id, MOOV_ACCOUNT);
      const logged = JSON.parse(lines.find((l) => l.includes('moov_account_check')));
      assert.equal(logged.gone, false);
      assert.equal(logged.listed, listed);
      if (remote.foreignID !== TENANT) assert.equal(fetch.calls.some((c) => /\/accounts\?foreignID=/.test(c.url)), false, 'another foreignID is never judged by the list');
    }
  });
});

test('documents sent to a gone account are sent again to the new account from their stored copy', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    const id = await uploadDoc(db);
    const first = moovFetch();
    await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch: first });
    assert.equal(db.state.docs[0].moov_account_id, MOOV_ACCOUNT);
    const firstKey = first.calls.find((c) => c.url.endsWith(`/accounts/${MOOV_ACCOUNT}/files`)).headers['X-Idempotency-Key'];

    resetMoovTokenCache();
    const replace = moovFetch([
      accountGet({ accountID: MOOV_ACCOUNT, disconnectedOn: '2026-10-26T12:00:00Z' }),
      { match: /\/accounts$/, method: 'POST', body: { accountID: NEW_MOOV_ACCOUNT } },
    ]);
    const saved = await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: replace });
    assert.equal(saved.moov_synced, true, JSON.stringify(saved));
    assert.deepEqual(
      { status: db.state.docs[0].status, moov_file_id: db.state.docs[0].moov_file_id, moov_account_id: db.state.docs[0].moov_account_id },
      { status: 'stored', moov_file_id: null, moov_account_id: null },
    );
    assert.ok(db.state.outbox.some((o) => o.kind === 'document_upload' && o.subject_id === id && o.status === 'pending'));

    resetMoovTokenCache();
    const resend = moovFetch([{ match: `/accounts/${NEW_MOOV_ACCOUNT}/files`, method: 'POST', body: { fileID: 'file_new', fileStatus: 'pending' } }]);
    await run('moov-sync', { tenant_id: TENANT }, USERS.owner, { db, s3, fetch: resend });
    const upload = resend.calls.find((c) => c.method === 'POST' && c.url.endsWith('/files'));
    assert.ok(upload.url.endsWith(`/accounts/${NEW_MOOV_ACCOUNT}/files`), 'sent to the new account');
    assert.notEqual(upload.headers['X-Idempotency-Key'], firstKey, 'never answered from the gone account\'s upload');
    assert.deepEqual(
      { status: db.state.docs[0].status, moov_file_id: db.state.docs[0].moov_file_id, moov_account_id: db.state.docs[0].moov_account_id },
      { status: 'sent', moov_file_id: 'file_new', moov_account_id: NEW_MOOV_ACCOUNT },
    );
  });
});

test('a failed replacement create leaves people, banks and documents on the gone account untouched', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: moovFetch() });
    const id = await uploadDoc(db);
    await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch: moovFetch() });
    db.state.methods.push({ id: 'aaaaaaaa-0000-4000-8000-0000000000b2', tenant_id: TENANT, environment: 'sandbox', provider_account_id: MOOV_ACCOUNT, provider_bank_account_id: 'bank_old', connection_status: 'connected', verification_status: 'verified', external_recipient_id: null });

    resetMoovTokenCache();
    const fetch = moovFetch([
      accountGet({ accountID: MOOV_ACCOUNT, disconnectedOn: '2026-10-26T12:00:00Z' }),
      { match: /\/accounts$/, method: 'POST', status: 503, body: { error: 'down' } },
    ]);
    const { result } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch }));
    assert.equal(result.moov_synced, false);
    assert.equal(db.state.accounts[0].provider_account_id, MOOV_ACCOUNT);
    assert.equal(db.state.reps[0].moov_representative_id, 'rep_1', 'the person keeps the Moov id');
    assert.equal(db.state.methods[0].connection_status, 'connected');
    assert.deepEqual({ status: db.state.docs[0].status, moov_account_id: db.state.docs[0].moov_account_id }, { status: 'sent', moov_account_id: MOOV_ACCOUNT });
    assert.equal(db.state.outbox.some((o) => o.kind === 'document_upload' && o.status === 'pending'), false, 'nothing queued for the gone account');
  });
});

test('replacing a gone account never adopts it again by foreignID', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch([
      accountGet({ accountID: MOOV_ACCOUNT, disconnectedOn: '2026-10-26T12:00:00Z' }),
      { match: /\/accounts$/, method: 'POST', status: 409, body: { error: 'conflict' } },
      { match: /\/accounts\?foreignID=/, method: 'GET', body: [{ accountID: MOOV_ACCOUNT, foreignID: TENANT }] },
    ]);
    const { result } = await captureConsole(() => run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch }));
    assert.equal(result.moov_synced, false);
    assert.equal(result.error_code, 'moov_conflict');
    assert.equal(db.state.accounts[0].provider_account_id, MOOV_ACCOUNT, 'the record is unchanged until a new account exists');
  });
});

test('an account adopted after a 409 does not record terms Moov never received', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const created = makeDb({ account: false });
    await run('moov-account-create', { tenant_id: TENANT, terms_of_service_token: 'client-tos-token-123' }, USERS.owner, { db: created, fetch: moovFetch() });
    assert.ok(created.state.accounts[0].tos_accepted_at, 'a create Moov accepted records the terms');

    resetMoovTokenCache();
    const adopted = makeDb({ account: false });
    const fetch = moovFetch([
      { match: /\/accounts$/, method: 'POST', status: 409, body: { error: 'conflict' } },
      { match: /\/accounts\?foreignID=/, method: 'GET', body: [{ accountID: MOOV_ACCOUNT, foreignID: TENANT }] },
    ]);
    const r = await run('moov-account-create', { tenant_id: TENANT, terms_of_service_token: 'client-tos-token-123' }, USERS.owner, { db: adopted, fetch });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(adopted.state.accounts[0].provider_account_id, MOOV_ACCOUNT);
    assert.equal(adopted.state.accounts[0].tos_accepted_at, null);
  });
});

test('moovRejectedFields keeps only identifier-shaped keys from 400/422 bodies', () => {
  assert.deepEqual(moovRejectedFields({ status: 503, body: { error: { website: 'x' } } }), []);
  assert.deepEqual(moovRejectedFields({ status: 422, body: 'not json' }), []);
  assert.deepEqual(moovRejectedFields({ status: 400, body: JSON.stringify({ error: 'bad', message: 'nope' }) }), []);
  assert.deepEqual(
    moovRejectedFields({ status: 422, body: { error: { representatives: { 0: { email: 'x' } }, '123-45-6789': 'x', 'a b': 'x' } } }),
    ['representatives.0.email'],
  );
});

test('re-entering a person without an SSN after a failed send is refused (SSN must be re-entered)', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: moovFetch([{ match: '/representatives', method: 'POST', status: 500 }]) });
    const { ssn, ...noSsn } = REP;
    const r = await run('moov-onboarding-save', saveBody({ representatives: [{ ...noSsn, id: db.state.reps[0].id }] }), USERS.owner, { db });
    assert.equal(r.statusCode, 400);
    assert.equal(r.field, 'representatives[0].ssn');
    assert.equal(String(r.message).includes(ssn), false);
  });
});

test('representative upsert is idempotent: stored moov_representative_id is PATCHed, never re-POSTed', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    // First run: capability request fails after the person was created at Moov.
    const first = await run('moov-onboarding-save', saveBody(), USERS.owner, {
      db, fetch: moovFetch([{ match: '/capabilities', method: 'POST', status: 500 }]),
    });
    assert.equal(first.pending, true);
    assert.equal(db.state.reps[0].moov_representative_id, 'rep_1');
    assert.equal(db.state.reps[0].ssn_resubmit_required, false);
    const { ssn: _omit, ...noSsn } = REP;
    const second = moovFetch();
    const r = await run('moov-onboarding-save', saveBody({ representatives: [{ ...noSsn, id: db.state.reps[0].id, title: 'President' }] }), USERS.owner, { db, fetch: second });
    assert.equal(r.moov_synced, true);
    assert.equal(second.calls.filter((c) => /\/representatives$/.test(c.url) && c.method === 'POST').length, 0);
    const patch = second.calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/representatives/rep_1'));
    assert.ok(patch);
    const body = JSON.parse(patch.body);
    assert.equal(body.responsibilities.jobTitle, 'President');
    assert.equal(body.governmentID, undefined);
    assert.deepEqual(body.birthDate, { year: 1980, month: 4, day: 15 });
    assert.equal(db.state.reps.length, 1);
    assert.equal(db.state.outbox.filter((o) => o.status === 'pending').length, 0);
  });
});

test('save creates the Moov account when none exists, then returns the masked shape with can_submit', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb({ account: false });
    const fetch = moovFetch();
    const r = await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch });
    assert.equal(r.ok, true);
    assert.equal(r.account.connected, true);
    assert.equal(r.can_submit, true);
    const create = fetch.calls.find((c) => c.url.endsWith('/accounts') && c.method === 'POST');
    assert.ok(create.headers['X-Idempotency-Key']);
    assert.equal(JSON.parse(create.body).foreignID, TENANT);
    assert.equal(db.state.accounts[0].environment, 'sandbox');
    for (const key of ['ok', 'environment', 'account', 'business', 'representatives', 'documents', 'banks', 'sync', 'can_submit']) {
      assert.ok(key in r, key);
    }
    assert.deepEqual(Object.keys(r.business).sort(), ['address', 'dba', 'description', 'ein_masked', 'email', 'industry', 'legal_name', 'phone', 'type', 'website']);
    assert.deepEqual(r.business.address, { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' });
  });
});

test('environment always comes from the server: body environment is ignored, staging binds sandbox', async () => {
  await withEnv(BASE_ENV, async () => {
    const db = makeDb({ tenantEnv: 'production' });
    const r = await run('moov-onboarding-get', { tenant_id: TENANT, environment: 'production', moov_environment: 'production' }, USERS.owner, { db });
    assert.equal(r.environment, 'sandbox');
    assert.equal(r.productionExecution, false);
    const db2 = makeDb();
    const r2 = await run('moov-onboarding-get', { tenant_id: TENANT, environment: 'production' }, USERS.owner, { db: db2 });
    assert.equal(r2.environment, 'sandbox');
  });
});

test('production still refuses every onboarding function while AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED is off', async () => {
  const PROD = { ...BASE_ENV, AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'true', AWS_PROVIDER_LIVE_READS_ENABLED: 'true' };
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    await withEnv({ ...PROD, AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: flag }, async () => {
      let clients = 0;
      for (const name of ONBOARDING_FUNCTION_NAMES) {
        const result = await handleProviderRequest(jwtEvent(name, { tenant_id: TENANT }, USERS.owner), `/functions/v1/${name}`, 'POST', {
          createClient: () => { clients += 1; return makeDb().create(); },
          loadDatabaseCredentials: async () => ({}),
        });
        assert.equal(result.statusCode, 403, `${name} ${flag}`);
        assert.equal(result.error, 'production_execution_blocked', `${name} ${flag}`);
        assert.equal(result.tranche4HardBlock, true, name);
      }
      assert.equal(clients, 0);
      assert.equal(productionOnboardingWebhookApplyEnabled(), false);
    });
  }
  // Money movement stays blocked even with the onboarding flag on.
  await withEnv({ ...PROD, AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true' }, async () => {
    for (const name of ['moov-transfer-create', 'moov-tenant-fee-charge', 'moov-recipient-create', 'moov-platform-bank']) {
      const result = await handleProviderRequest(jwtEvent(name, { tenant_id: TENANT }, USERS.owner), `/functions/v1/${name}`, 'POST', {});
      assert.equal(result.error, 'production_execution_blocked', name);
    }
  });
});

test('production with the flag on: production tenant binds production credentials from Secrets Manager; sandbox tenants are refused', async () => {
  const PROD = { ...BASE_ENV, AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'true', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true' };
  await withEnv(PROD, async () => {
    resetMoovTokenCache();
    const db = makeDb({ tenantEnv: 'production', account: false });
    let sandboxLoaded = false;
    const fetch = moovFetch();
    const r = await run('moov-onboarding-save', saveBody(), USERS.owner, {
      db, fetch,
      extraDeps: {
        loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk_live', MOOV_SECRET_KEY: 'sk_live', MOOV_ACCOUNT_ID: PLATFORM_ID }),
        loadSandboxCredentials: async () => { sandboxLoaded = true; return {}; },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.environment, 'production');
    assert.equal(sandboxLoaded, false);
    assert.equal(db.state.profiles[0].environment, 'production');
    assert.equal(db.state.accounts[0].environment, 'production');
    const oauth = fetch.calls.find((c) => c.url.endsWith('/oauth2/token'));
    assert.equal(oauth.headers.Authorization, `Basic ${Buffer.from('pk_live:sk_live').toString('base64')}`);

    const sandboxTenant = makeDb({ tenantEnv: 'sandbox' });
    const refused = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS.owner, { db: sandboxTenant });
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.error, 'production_provider_context_unresolved');
  });
});

test('bank add stores last four only and banks[] ids drive micro-deposit initiate/confirm', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch([{ match: '/bank-accounts/bank_1', method: 'GET', body: { status: 'new' } }]);
    db.state.noStepUp = true;
    for (const name of ['moov-bank-account-add', 'moov-micro-deposit-initiate', 'moov-micro-deposit-confirm', 'moov-bank-link-token']) {
      const r = await run(name, { tenant_id: TENANT, holder_name: 'Freedom LLC', routing_number: '021000021', account_number: '000123456789', payment_method_id: TENANT, code: '1234' }, USERS.owner, { db, fetch });
      assert.equal(r.statusCode, 401, name);
      assert.equal(r.error, 'totp_required', name);
      assert.equal(r.actionKey, 'wallet.fund', name);
    }
    assert.equal(fetch.calls.length, 0);
    db.state.noStepUp = false;
    // A step-up for another user or another login does not count: the lookup is bound.
    const q = db.state.stepUpQueries.at(-1);
    assert.deepEqual(q.params, [USERS.owner.app, TENANT, 'wallet.fund', `${USERS.owner.sub}:auth:1760000000`]);
    const otherUser = await run('moov-bank-link-token', { tenant_id: TENANT }, USERS.admin, { db, fetch: moovFetch() });
    assert.equal(otherUser.ok, true, 'another member is checked against their own step-up');
    assert.deepEqual(db.state.stepUpQueries.at(-1).params, [USERS.admin.app, TENANT, 'wallet.fund', `${USERS.admin.sub}:auth:1760000000`]);
    const added = await run('moov-bank-account-add', {
      tenant_id: TENANT, holder_name: 'Freedom LLC', routing_number: '021000021', account_number: '000123456789',
    }, USERS.owner, { db, fetch });
    assert.equal(added.ok, true);
    assert.equal(added.routing_masked, '*****0021');
    assert.equal(allPersisted(db).includes('000123456789'), false);
    assert.equal(allPersisted(db).includes('021000021'), false);
    const view = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS.viewer, { db });
    assert.deepEqual(view.banks, [{ id: added.payment_method_id, last4: '6789', routing_masked: '*****0021', status: 'pending', verification: 'pending' }]);
    const init = await run('moov-micro-deposit-initiate', { tenant_id: TENANT, payment_method_id: added.payment_method_id }, USERS.owner, { db, fetch });
    assert.equal(init.ok, true);
    const confirm = await run('moov-micro-deposit-confirm', { tenant_id: TENANT, payment_method_id: added.payment_method_id, code: '1234' }, USERS.owner, { db, fetch });
    assert.equal(confirm.ok, true);
    assert.equal(confirm.verified, true);
    const put = fetch.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/verify'));
    assert.deepEqual(JSON.parse(put.body), { code: '1234' });
  });
});

test('a refused bank add logs Moov\'s masked reason and status, never the account or routing number', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const refusing = moovFetch([{
      match: /\/bank-accounts$/, method: 'POST', status: 422,
      body: { error: 'routing number 021000021 is not valid for account 000123456789' },
    }]);
    const { result, lines } = await captureConsole(() => run('moov-bank-account-add', {
      tenant_id: TENANT, holder_name: 'Freedom LLC', routing_number: '021000021', account_number: '000123456789',
    }, USERS.owner, { db, fetch: refusing }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'moov_rejected');
    const log = lines.find((line) => line.includes('moov_bank_account_failed'));
    assert.ok(log, 'failure logged');
    const parsed = JSON.parse(log);
    assert.equal(parsed.status, 422);
    assert.equal(parsed.error_code, 'moov_rejected');
    assert.equal(parsed.reason, 'routing number [redacted] is not valid for account [redacted]');
    assert.equal(log.includes('021000021'), false);
    assert.equal(log.includes('000123456789'), false);
  });
});

test('webhook status: capability and verification events update only the matching environment rows', async () => {
  const db = makeDb();
  db.state.accounts.push({ id: 'acct-prod', tenant_id: TENANT, environment: 'production', provider_account_id: MOOV_ACCOUNT, capabilities: [], verification_status: 'pending' });
  const client = db.create();
  const sandbox = await applyOnboardingWebhookStatus(client, {
    environment: 'sandbox', eventType: 'capability.updated', providerAccountId: MOOV_ACCOUNT,
    data: { accountID: MOOV_ACCOUNT, capabilityID: 'transfers', status: 'enabled' },
  });
  assert.equal(sandbox.applied, true);
  assert.deepEqual(db.state.accounts[0].capabilities, [{ capability: 'transfers', status: 'enabled' }]);
  assert.deepEqual(db.state.accounts[1].capabilities, []);
  const update = db.state.accountUpdates.at(-1);
  assert.match(update.sql, /WHERE id = \$1::uuid AND environment = \$11/);
  assert.equal(update.params[10], 'sandbox');

  await applyOnboardingWebhookStatus(client, {
    environment: 'sandbox', eventType: 'account.updated', providerAccountId: MOOV_ACCOUNT,
    data: { verification: { status: 'verified' } },
  });
  assert.equal(db.state.accounts[0].verification_status, 'verified');
  assert.equal(db.state.accounts[0].onboarding_status, 'active');

  const prod = await applyProductionOnboardingWebhook(client, {
    type: 'capability.requested', data: { accountID: MOOV_ACCOUNT, capabilityID: 'collect-funds.ach' },
  });
  assert.equal(prod.applied, true);
  assert.equal(prod.financialTablesMutated, false);
  assert.deepEqual(db.state.accounts[1].capabilities, [{ capability: 'collect-funds.ach', status: 'pending' }]);
  const skipped = await applyProductionOnboardingWebhook(client, { type: 'transfer.updated', data: { transferID: 't' } });
  assert.equal(skipped.applied, false);
  const missing = await applyOnboardingWebhookStatus(client, { environment: 'sandbox', eventType: 'account.updated', providerAccountId: 'unknown' });
  assert.equal(missing.applied, false);
});

test('production onboarding webhook apply needs the flag, production execution and non-dry-run', async () => {
  await withEnv({ AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'true', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true', AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false' }, async () => {
    assert.equal(productionOnboardingWebhookApplyEnabled(), true);
  });
  await withEnv({ AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'true', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true', AWS_PROVIDER_WEBHOOK_DRY_RUN: undefined }, async () => {
    assert.equal(productionOnboardingWebhookApplyEnabled(), false);
  });
  await withEnv({ AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'true', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: undefined, AWS_PROVIDER_WEBHOOK_DRY_RUN: 'false' }, async () => {
    assert.equal(productionOnboardingWebhookApplyEnabled(), false);
  });
});

test('redaction: SSN, EIN, DOB, account and routing numbers never survive log or webhook sanitizing', () => {
  const sample = {
    ssn: SSN, ein: EIN, dob: '1980-04-15', birthDate: { year: 1980 }, accountNumber: '000123456789',
    routing_number: '021000021', taxID: { ein: { number: EIN } }, governmentID: { ssn: { full: SSN } },
    note: `ssn ${SSN_DASHED} ein 27-4444321`, file_base64: 'JVBERi0=',
  };
  const text = JSON.stringify(redact(sample));
  for (const v of [SSN, SSN_DASHED, EIN, '27-4444321', '000123456789', '021000021', '1980-04-15', 'JVBERi0=']) {
    assert.equal(text.includes(v), false, v);
  }
  const hook = JSON.stringify(sanitizeWebhookPayload(sample));
  for (const v of [SSN, EIN, '000123456789', '021000021']) assert.equal(hook.includes(v), false, v);
});

test('generic storage can never address compliance documents', async () => {
  // Generic storage keys are files/{app bucket}/...; verification-docs is not an app bucket.
  assert.equal(APP_BUCKET_SET.has('verification-docs'), false);
  for (const bucket of APP_BUCKET_SET) {
    assert.equal(s3KeyFor(bucket, `${TENANT}/x`).startsWith('files/verification-docs/'), false, bucket);
  }
  const client = { query: async () => ({ rows: [] }) };
  const r = await authorizeObject(client, 'tenant-documents', `../verification-docs/final/${TENANT}/${OTHER_TENANT}`, { userId: USERS.owner.app });
  assert.equal(r.authorized, false);
  const storage = readFileSync(new URL('../functions/api/storage.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(storage, /isComplianceDocumentPath|compliance_document_path/);
});

test('SQL 91: tenant-scoped tables with RLS, member/platform-owner writers, no SSN column, ids-only outbox', () => {
  const sql = readFileSync(new URL('../workflows/sql/91_moov_onboarding.sql', import.meta.url), 'utf8');
  for (const table of ['moov_onboarding_profiles', 'moov_onboarding_representatives', 'moov_compliance_documents', 'moov_onboarding_outbox']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table} \\(`));
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`aws_select_${table} ON public\\.${table}[\\s\\S]*?aws_can_access_tenant\\(tenant_id\\)`));
    assert.match(sql, new RegExp(`aws_insert_${table} ON public\\.${table}[\\s\\S]*?aws_moov_onboarding_writer\\(tenant_id\\)`));
    assert.match(sql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC`));
  }
  assert.doesNotMatch(sql, /\bssn(_full)?\s+(text|varchar|char)/i);
  assert.match(sql, /ssn_last4 text/);
  assert.match(sql, /is_platform_owner\(\)/);
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.aws_can_submit_moov_onboarding');
  const submitter = sql.slice(start, sql.indexOf('$$;', start));
  assert.match(submitter, /is_platform_owner\(\)/);
  assert.match(submitter, /tu\.user_id = auth\.uid\(\)/);
  assert.doesNotMatch(submitter, /has_role\(|user_roles|aws_is_cross_tenant_reader|\.role\b/);
  assert.match(sql, /moov_onboarding_outbox_payload_no_pii/);
  const allowed = JSON.parse(readFileSync(new URL('../functions/api/allowed-tables.json', import.meta.url), 'utf8'));
  for (const table of ['moov_onboarding_profiles', 'moov_onboarding_representatives', 'moov_compliance_documents', 'moov_onboarding_outbox']) {
    assert.equal(allowed.includes(table), false, table);
  }
  const allowlist = readFileSync(new URL('../functions/api/write-allowlist.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(allowlist, /moov_onboarding|moov_compliance/);
});

test('template: dedicated KMS keys, SSE-KMS enforcement on the verification prefix, onboarding flag matches the live functions', () => {
  const t = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
  assert.match(t, /MoovOnboardingPiiKey:\n\s+Type: AWS::KMS::Key/);
  assert.match(t, /ComplianceDocumentsKey:\n\s+Type: AWS::KMS::Key/);
  assert.match(t, /EnableKeyRotation: true/);
  // On since the guarded configuration applies of 2026-10-21; staging still uses the sandbox path.
  assert.match(t, /AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: "true"/);
  assert.match(t, /AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: "true"/);
  assert.match(t, /MOOV_ONBOARDING_PII_KMS_KEY_ARN: !GetAtt MoovOnboardingPiiKey\.Arn/);
  assert.match(t, /COMPLIANCE_DOCUMENTS_KMS_KEY_ARN: !GetAtt ComplianceDocumentsKey\.Arn/);
  assert.match(t, /Resource: !Sub \$\{PrivateFilesBucket\.Arn\}\/files\/verification-docs\/\*/);
  assert.doesNotMatch(t, /tenant-documents\/\*\/verification/);
  assert.match(t, /s3:x-amz-server-side-encryption-aws-kms-key-id: !GetAtt ComplianceDocumentsKey\.Arn/);
  assert.match(t, /kms:ViaService: !Sub s3\.\$\{AWS::Region\}\.amazonaws\.com/);
  assert.match(t, /Environment:\n\s+Type: String\n\s+Default: staging\n\s+AllowedValues:\n\s+- staging/);
  // Key policies: root administers only; use is the API role's, by name.
  for (const key of ['MoovOnboardingPiiKey', 'ComplianceDocumentsKey']) {
    const block = t.slice(t.indexOf(`  ${key}:\n`), t.indexOf(`  ${key}Alias:\n`));
    assert.doesNotMatch(block, /Action: kms:\*/, key);
    assert.doesNotMatch(block, /kms:[A-Za-z]+\*/, `${key}: no wildcard actions`);
    assert.doesNotMatch(block, /kms:CreateGrant/, key);
    assert.match(block, /- kms:PutKeyPolicy\n/, key);
    const admin = block.slice(block.indexOf('Sid: KeyAdministrationOnly'), block.indexOf('Sid: ApiFunctionRole'));
    assert.doesNotMatch(admin, /kms:(Encrypt|Decrypt|GenerateDataKey)/, key);
    assert.match(block, /aws:PrincipalArn: !Sub arn:aws:iam::\$\{AWS::AccountId\}:role\/\$\{AWS::StackName\}-ApiFunctionRole-\*/, key);
  }
  // CORS: exact SPA origins, PUT/GET, the signed headers; never '*'.
  const cors = t.slice(t.indexOf('CorsConfiguration:\n        CorsRules:'), t.indexOf('LifecycleConfiguration:'));
  assert.match(cors, /AllowedOrigins: !If\n\s+- IsProductionEnvironment\n\s+- - https:\/\/checksops\.com\n\s+- https:\/\/www\.checksops\.com\n\s+- - https:\/\/staging\.checksops\.com\n/);
  assert.match(t, /IsProductionEnvironment: !Equals \[!Ref Environment, production\]/);
  assert.doesNotMatch(cors, /'\*'|- \*/);
  for (const h of ['content-type', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']) assert.match(cors, new RegExp(`- ${h}\\n`));
  assert.match(cors, /- PUT\n\s+- GET/);
  // Noncurrent versions of compliance documents expire.
  assert.match(t, /Prefix: files\/verification-docs\/final\/\n\s+NoncurrentVersionExpiration:\n\s+NoncurrentDays: 7/);
  assert.match(t, /Prefix: files\/verification-docs\/uploads\/\n\s+ExpirationInDays: 1/);
  const docKey = t.slice(t.indexOf('  ComplianceDocumentsKey:\n'), t.indexOf('  ComplianceDocumentsKeyAlias:\n'));
  assert.match(docKey, /kms:EncryptionContext:aws:s3:arn: !Sub arn:aws:s3:::\$\{PrivateFilesBucket\}\/files\/verification-docs\/\*/);
  // KMS endpoint is opt-in and limited to these keys and this account.
  assert.match(t, /KmsVpcEndpoint:\n\s+Type: AWS::EC2::VPCEndpoint\n\s+Condition: CreateKmsEndpoint/);
  assert.match(t, /CreateKmsVpcEndpoint:\n\s+Type: String\n\s+Default: 'false'/);
  assert.match(t, /aws:PrincipalAccount: !Ref AWS::AccountId/);
});

// ------------------------------------------------------------------ review fixes

test('default documents S3 client presigns a PUT with no checksum parameters (S3 would reject the browser upload)', async () => {
  await withEnv({ ...BASE_ENV, AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: undefined, AWS_REGION: 'us-east-1' }, async () => {
    const db = makeDb();
    // No deps.s3: the module's own client is used.
    const r = await run('moov-document-upload-url', {
      tenant_id: TENANT, purpose: 'w9', file_name: 'w9.pdf', content_type: 'application/pdf', size: 4096,
    }, USERS.owner, { db, sign: getSignedUrl });
    assert.equal(r.ok, true);
    const url = new URL(r.upload_url);
    for (const key of url.searchParams.keys()) {
      assert.doesNotMatch(key, /^x-amz-checksum-|^x-amz-sdk-checksum-algorithm$/i, key);
    }
    assert.doesNotMatch(url.searchParams.get('X-Amz-SignedHeaders'), /checksum/);
    assert.equal(url.pathname.endsWith(`/files/verification-docs/uploads/${TENANT}/${r.document_id}`), true);
  });
  const { DOCUMENTS_S3_CONFIG } = await import('../functions/api/providers/onboarding/documents.mjs');
  assert.deepEqual({ ...DOCUMENTS_S3_CONFIG }, { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
});

test('write handlers take the per-tenant lock and the onboarding write setting; read handlers take neither', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    await run('moov-onboarding-get', { tenant_id: TENANT }, USERS.owner, { db });
    await run('moov-document-view', { tenant_id: TENANT, document_id: TENANT }, USERS.owner, { db });
    await run('moov-readiness', { tenant_id: TENANT }, USERS.owner, { db });
    assert.equal(db.state.locks.length, 0);
    assert.equal(db.state.gucs.some((g) => g[0] === "SELECT set_config('request.moov_onboarding', '1', true)"), false);
    assert.equal(db.state.accountUpdates.length, 0, 'readiness never writes');
    for (const name of ['moov-onboarding-save', 'moov-sync', 'moov-document-finalize']) {
      const before = db.state.locks.length;
      await run(name, saveBody({ document_id: TENANT }), USERS.owner, { db });
      assert.deepEqual(db.state.locks.at(-1), [TENANT, 'sandbox'], name);
      assert.equal(db.state.locks.length, before + 1, name);
    }
    assert.ok(db.state.gucs.some((g) => g[0] === "SELECT set_config('request.moov_onboarding', '1', true)"));
  });
});

test('moov-tos-token never hands the browser a Moov access token; moov-tos-accept records acceptance server-side', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const fetch = moovFetch([{ match: '/tos-token', method: 'GET', body: { token: 'tos-token-from-moov' } }]);
    const r = await run('moov-tos-token', { tenant_id: TENANT }, USERS.owner, { db, fetch });
    assert.equal(r.ok, true);
    assert.equal(r.token, null);
    assert.equal(r.accept_with, 'moov-tos-accept');
    assert.equal(fetch.calls.length, 0);
    // The platform owner (not a member), partners and global admins cannot fetch or accept the terms.
    for (const who of ['platformOwner', 'partner', 'globalAdmin']) {
      for (const fn of ['moov-tos-token', 'moov-tos-accept']) {
        const refused = await run(fn, { tenant_id: TENANT, accepted: true }, USERS[who], { db, fetch });
        assert.equal(refused.statusCode, 403, `${who} ${fn}`);
      }
    }
    assert.equal(fetch.calls.length, 0);
    const accepted = await run('moov-tos-accept', { tenant_id: TENANT, accepted: true }, USERS.viewer, { db, fetch });
    assert.equal(accepted.ok, true);
    const patch = fetch.calls.find((c) => c.method === 'PATCH');
    assert.deepEqual(JSON.parse(patch.body), { termsOfService: { token: 'tos-token-from-moov' } });
  });
});

test('legacy moov-account-onboard matches people by moov_representative_id, never by name', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db });
    assert.equal(db.state.reps[0].moov_representative_id, 'rep_1');
    const legacyBusiness = {
      legalBusinessName: 'Freedom Adjusting LLC', businessType: 'llc', email: 'ops@freedom.test', phone: '5125550100',
      website: 'freedom.test', address: { addressLine1: '1 Main St', city: 'Austin', stateOrProvince: 'TX', postalCode: '78701' },
    };
    const legacyRep = { firstName: 'Jane', lastName: 'Doe', birthDate: '1980-04-15', isController: true, address: { addressLine1: '1 Main St', city: 'Austin', stateOrProvince: 'TX', postalCode: '78701' } };
    // Same name, no Moov id: a new person, so the SSN is required.
    const byName = await run('moov-account-onboard', { tenant_id: TENANT, business: legacyBusiness, representatives: [legacyRep] }, USERS.owner, { db });
    assert.equal(byName.statusCode, 400);
    assert.equal(byName.field, 'representatives[0].ssn');
    const byId = await run('moov-account-onboard', { tenant_id: TENANT, business: legacyBusiness, representatives: [{ ...legacyRep, representativeID: 'rep_1' }] }, USERS.owner, { db });
    assert.equal(byId.ok, true);
    assert.equal(db.state.reps.filter((r) => !r.removed_at).length, 1);
  });
});

test('pending uploads are capped per tenant', async () => {
  await withEnv(BASE_ENV, async () => {
    const db = makeDb();
    for (let i = 0; i < 50; i += 1) {
      db.state.docs.push({ id: `d-${i}`, tenant_id: TENANT, environment: 'sandbox', status: 'pending_upload' });
    }
    const r = await run('moov-document-upload-url', { tenant_id: TENANT, purpose: 'w9', file_name: 'a.pdf', content_type: 'application/pdf', size: 10 }, USERS.owner, { db, sign: async () => 'x' });
    assert.equal(r.statusCode, 429);
    assert.equal(r.error, 'too_many_pending_uploads');
  });
});

test('outbox: duplicate enqueue is a no-op, attempts back off and stop at 10 as failed', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const down = () => moovFetch([{ match: `/accounts/${MOOV_ACCOUNT}`, method: 'PATCH', status: 503 }]);
    await run('moov-onboarding-save', saveBody(), USERS.owner, { db, fetch: down() });
    await run('moov-onboarding-save', saveBody({ representatives: [{ ...REP, id: db.state.reps[0].id }] }), USERS.owner, { db, fetch: down() });
    assert.equal(db.state.outbox.filter((o) => o.status === 'pending').length, 1);
    for (let i = 0; i < 12; i += 1) {
      db.state.outbox[0].next_attempt_at = 0;
      await run('moov-sync', { tenant_id: TENANT }, USERS.owner, { db, fetch: down() });
    }
    assert.equal(db.state.outbox[0].status, 'failed');
    assert.equal(db.state.outbox[0].attempts, 10);
    const view = await run('moov-onboarding-get', { tenant_id: TENANT }, USERS.owner, { db });
    assert.equal(view.sync.pending, true, 'profile stays pending; a new save re-enqueues');
    const src = readFileSync(new URL('../functions/api/providers/onboarding/store.mjs', import.meta.url), 'utf8');
    assert.match(src, /ON CONFLICT \(tenant_id, environment, kind, subject_id\) WHERE status = 'pending' DO NOTHING/);
  });
});

test('drain completes the outbox row of a document that already has a Moov file id', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const id = await uploadDoc(db);
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, {
      db, s3, fetch: moovFetch([{ match: '/files', method: 'POST', status: 503 }]),
    });
    // Sent by another path meanwhile.
    Object.assign(db.state.docs[0], { moov_file_id: 'file_other', status: 'sent' });
    db.state.outbox[0].next_attempt_at = 0;
    const fetch = moovFetch();
    await run('moov-sync', { tenant_id: TENANT }, USERS.owner, { db, s3, fetch });
    assert.equal(db.state.outbox[0].status, 'completed');
    assert.equal(fetch.calls.filter((c) => c.url.endsWith('/files')).length, 0);
  });
});

test('micro-deposit confirm reserves each attempt under a row lock and stops at the limit', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    db.state.methods.push({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', tenant_id: TENANT, environment: 'sandbox', provider_account_id: MOOV_ACCOUNT, provider_bank_account_id: 'bank_9', connection_status: 'connected', verification_status: 'pending', external_recipient_id: null });
    db.state.verifications.push({ id: 'bbbbbbbb-0000-4000-8000-00000000000b', tenant_id: TENANT, payment_method_id: 'aaaaaaaa-0000-4000-8000-00000000000a', environment: 'sandbox', provider_account_id: MOOV_ACCOUNT, provider_bank_account_id: 'bank_9', status: 'pending', attempts: 0 });
    const wrong = () => moovFetch([
      { match: '/bank-accounts/bank_9/verify', method: 'PUT', status: 400 },
      { match: '/bank-accounts/bank_9', method: 'GET', body: { status: 'new' } },
    ]);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await run('moov-micro-deposit-confirm', { tenant_id: TENANT, payment_method_id: 'aaaaaaaa-0000-4000-8000-00000000000a', code: '0000' }, USERS.owner, { db, fetch: wrong() }));
    }
    assert.deepEqual(results.slice(0, 3).map((r) => r.attempts), [1, 2, 3]);
    assert.equal(results[2].requires_restart, true);
    assert.equal(results[3].error, 'max_attempts_exceeded');
    assert.equal(db.state.verifications[0].attempts, 3);
    const confirmSql = db.state.writes.map((w) => w.sql).find((q) => q.includes('SET attempts = attempts + 1'));
    assert.match(confirmSql, /attempts < COALESCE\(max_attempts, 3\)/);
    const src = readFileSync(new URL('../functions/api/providers/onboarding/handlers.mjs', import.meta.url), 'utf8');
    assert.equal((src.match(/FOR UPDATE`/g) || []).length >= 2, true);
  });
});

test('production onboarding webhook apply clears request.provider_webhook_apply afterwards', async () => {
  const db = makeDb();
  db.state.accounts.push({ id: 'acct-prod', tenant_id: TENANT, environment: 'production', provider_account_id: MOOV_ACCOUNT, capabilities: [] });
  const client = db.create();
  await applyProductionOnboardingWebhook(client, { type: 'capability.updated', data: { accountID: MOOV_ACCOUNT, capabilityID: 'transfers', status: 'enabled' } });
  const sets = db.state.gucs.map((g) => g[0]).filter((q) => q.includes('request.provider_webhook_apply'));
  assert.equal(sets.at(-1), "SELECT set_config('request.provider_webhook_apply', '0', true)");
});

test('a late re-PUT to the upload URL cannot change the pinned final copy', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    const id = await uploadDoc(db);
    const s3 = fakeS3({ bytes: PDF, contentType: 'application/pdf' });
    const failing = moovFetch([{ match: '/files', method: 'POST', status: 503 }]);
    await run('moov-document-finalize', { tenant_id: TENANT, document_id: id }, USERS.owner, { db, s3, fetch: failing });
    assert.equal(db.state.docs[0].s3_version_id, 'final-v1');
    // Attacker re-PUTs different bytes to the (still unexpired) upload URL.
    s3.store.lateUpload = { ContentLength: 999, ContentType: 'image/png', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: DOC_KEY, VersionId: 'v-evil' };
    db.state.outbox[0].next_attempt_at = 0;
    const fetch = moovFetch();
    await run('moov-sync', { tenant_id: TENANT }, USERS.owner, { db, s3, fetch });
    assert.equal(db.state.docs[0].moov_file_id, 'file_1');
    const heads = s3.sent.filter((c) => c.kind === 'HeadObjectCommand').slice(-1)[0];
    assert.deepEqual([heads.input.Key, heads.input.VersionId], [`files/verification-docs/final/${TENANT}/${id}`, 'final-v1']);
    const file = fetch.calls.find((c) => c.url.endsWith('/files')).body.get('file');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PDF);
  });
});

test('micro-deposit attempt is committed before calling Moov and still counts on a network error', async () => {
  await withEnv(BASE_ENV, async () => {
    resetMoovTokenCache();
    const db = makeDb();
    db.state.methods.push({ id: 'aaaaaaaa-0000-4000-8000-00000000000c', tenant_id: TENANT, environment: 'sandbox', provider_account_id: MOOV_ACCOUNT, provider_bank_account_id: 'bank_7', connection_status: 'connected', verification_status: 'pending', external_recipient_id: null });
    db.state.verifications.push({ id: 'bbbbbbbb-0000-4000-8000-00000000000c', tenant_id: TENANT, payment_method_id: 'aaaaaaaa-0000-4000-8000-00000000000c', environment: 'sandbox', provider_account_id: MOOV_ACCOUNT, provider_bank_account_id: 'bank_7', status: 'pending', attempts: 0 });
    let commitsAtPut = null;
    const base = moovFetch([{ match: '/bank-accounts/bank_7', method: 'GET', body: { status: 'new' } }]);
    const fetchImpl = async (url, init = {}) => {
      if (String(url).endsWith('/bank_7/verify') && init.method === 'PUT') {
        commitsAtPut = db.state.commits;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      }
      return base.fetchImpl(url, init);
    };
    const before = db.state.commits;
    const r = await run('moov-micro-deposit-confirm', { tenant_id: TENANT, payment_method_id: 'aaaaaaaa-0000-4000-8000-00000000000c', code: '1234' }, USERS.owner, { db, fetch: { fetchImpl, calls: [] } });
    assert.equal(commitsAtPut, before + 1, 'reservation committed in its own transaction before the PUT');
    assert.equal(r.error_code, 'moov_unreachable');
    assert.equal(r.attempts, 1);
    assert.equal(db.state.verifications[0].attempts, 1);
    // The second transaction re-binds identity, write setting and lock.
    const afterCommit = db.state.gucs.slice(-4).map((g) => g[0]);
    assert.ok(afterCommit.includes('request.app_user_id') || afterCommit.includes("SELECT set_config('request.moov_onboarding', '1', true)"));
    assert.equal(db.state.locks.length >= 2, true);
  });
});

test('redactText masks SSNs and EINs written with spaces, dots or other separators', () => {
  for (const text of ['ssn 123-45-6789', 'ssn 123 45 6789', 'ssn 123.45.6789', 'ssn 123  45  6789', 'ssn 123/45/6789', 'ssn 123_45_6789',
    'ein 12-3456789', 'ein 12 3456789', 'ein 12.3456789']) {
    const out = redactText(text);
    assert.doesNotMatch(out, /\d{2,}/, `${text} -> ${out}`);
    assert.match(out, /\[redacted\]/, text);
  }
  assert.equal(redactText('Account ok'), 'Account ok');
});

test('moov-account-create: a terms token is used only for a member; the platform owner acting on behalf has it dropped', async () => {
  await withEnv(BASE_ENV, async () => {
    for (const [who, expectTerms] of [['viewer', true], ['platformOwner', false]]) {
      resetMoovTokenCache();
      const db = makeDb({ account: false });
      const fetch = moovFetch();
      const r = await run('moov-account-create', { tenant_id: TENANT, terms_of_service_token: 'client-tos-token-123' }, USERS[who], { db, fetch });
      assert.equal(r.ok, true, `${who} ${JSON.stringify(r)}`);
      const create = fetch.calls.find((c) => c.url.endsWith('/accounts') && c.method === 'POST');
      assert.ok(create, who);
      assert.equal('termsOfService' in JSON.parse(create.body), expectTerms, who);
    }
  });
});
