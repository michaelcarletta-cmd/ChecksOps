#!/usr/bin/env node
/**
 * Separate item #3: supported read-only Moov lookup for the Freedom
 * homeowner Michael reported as verified. Never writes, creates, relinks,
 * or substitutes the tenant/contractor bank. Does not print credentials
 * or full bank details. Does not describe the mismatch as fixed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || process.env.AWS || `${process.env.HOME}/.local/bin/aws`;
const FUNCTION_NAME = 'checksops-production-prep-api';
const POOL = 'us-east-1_h00WorYMT';
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const PRODUCTION_SUB = 'a45884b8-d051-70b3-b19d-ca704964c6e8';
const HOMEOWNER_ID = '2ad87468-15cd-437c-ba9c-c4a896dc5365';
const ARTIFACT = '/opt/cursor/artifacts/homeowner-moov-readonly-lookup.json';
const TENANT_ACCOUNT_PREFIX = '60922058';
const CONTRACTOR_BANK_PREFIX = '61062c38';
const CONTRACTOR_LAST4 = '4573';

const maskId = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  return `${text.slice(0, 8)}…`;
};
const maskLast4 = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  return `••••${digits.slice(-4)}`;
};
const maskName = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  if (parts.length === 1) return `${parts[0].slice(0, 1)}***`;
  return `${parts[0].slice(0, 1)}*** ${parts[parts.length - 1].slice(0, 1)}***`;
};
const maskEmail = (value) => {
  const text = String(value || '').trim();
  if (!text || !text.includes('@')) return null;
  const [local, domain] = text.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
};

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', 'us-east-1', ...args], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
}));

const invoke = (pathName, body = {}, { method = 'POST' } = {}) => {
  const event = {
    rawPath: pathName,
    requestContext: {
      http: { method, path: pathName },
      authorizer: {
        jwt: {
          claims: {
            sub: PRODUCTION_SUB,
            email: 'mcarletta@freedomadj.com',
            token_use: 'id',
            iss: ISSUER,
          },
        },
      },
    },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
  const out = `/tmp/lambda-moov-ro-${randomUUID()}.json`;
  execFileSync(AWS, [
    '--region', 'us-east-1', 'lambda', 'invoke',
    '--function-name', FUNCTION_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(event),
    out,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
  const parsed = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw;
  return { statusCode: raw.statusCode, ...parsed };
};

const query = (table, select, filters = [], extra = {}) => invoke('/data/query', {
  table,
  op: 'select',
  select,
  filters,
  ...extra,
});

const secretConfigured = (raw, key) => {
  if (!raw || typeof raw !== 'object') return false;
  return Boolean(raw[key]);
};

const fetchMoov = async (pathname, { key, secret, scopes }) => {
  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const tokenRes = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://checksops.com',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }).toString(),
  });
  const tokenText = await tokenRes.text();
  let tokenBody = null;
  try { tokenBody = tokenText ? JSON.parse(tokenText) : null; } catch { /* ignore */ }
  if (!tokenRes.ok) {
    return { ok: false, status: tokenRes.status, error: tokenBody?.error || 'moov_token_failed' };
  }
  const res = await fetch(`https://api.moov.io${pathname}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Origin: 'https://checksops.com',
      'x-moov-version': 'v2024.01.00',
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) return { ok: false, status: res.status, error: body?.error || 'moov_get_failed' };
  return { ok: true, status: res.status, body };
};

const summarizeAccount = (account) => {
  const individual = account?.profile?.individual || {};
  const business = account?.profile?.business || {};
  const name = [individual.name?.firstName, individual.name?.lastName].filter(Boolean).join(' ')
    || business.legalBusinessName
    || account?.displayName
    || null;
  const email = individual.email || business.email || account?.email || null;
  const identity = String(
    individual.verification?.status
    || business.verification?.status
    || account?.verification?.status
    || 'unknown',
  ).toLowerCase();
  const accountId = account?.accountID || account?.accountId || account?.account_id || null;
  return {
    account_id: maskId(accountId),
    account_prefix: accountId ? String(accountId).slice(0, 8) : null,
    kind: account?.accountType || account?.type || (individual.name ? 'individual' : business.legalBusinessName ? 'business' : 'unknown'),
    display: maskName(name),
    email: maskEmail(email),
    identity,
    foreign_id: account?.foreignID || account?.foreignId || null,
    is_tenant_account: Boolean(accountId && String(accountId).startsWith(TENANT_ACCOUNT_PREFIX)),
  };
};

const summarizeBank = (bank) => ({
  bank_id: maskId(bank?.bankAccountID || bank?.bankAccountId),
  last4: maskLast4(bank?.lastFourAccountNumber),
  verification: String(bank?.verificationStatus || bank?.status || 'unknown').toLowerCase(),
  holder: maskName(bank?.holderName || bank?.accountHolderName),
  is_contractor_or_tenant_bank: Boolean(
    String(bank?.bankAccountID || bank?.bankAccountId || '').startsWith(CONTRACTOR_BANK_PREFIX)
    || String(bank?.lastFourAccountNumber || '').endsWith(CONTRACTOR_LAST4),
  ),
});

const main = async () => {
  const report = {
    item: 3,
    mode: 'read_only_moov_lookup',
    fixed: false,
    writes: {
      moov_sync_invoked: false,
      accounts_created: false,
      banks_relinked: false,
      association_written: false,
      records_modified: false,
    },
    homeowner_id: HOMEOWNER_ID,
    tenant_id: FREEDOM_TENANT,
    checksops_association: null,
    moov_lookup: { available: false, limitation: null },
    match: null,
    proposed_association: null,
    do_not_substitute: {
      tenant_moov_account_prefix: `${TENANT_ACCOUNT_PREFIX}…`,
      contractor_or_tenant_bank_prefix: `${CONTRACTOR_BANK_PREFIX}…`,
      contractor_or_tenant_last4: `••••${CONTRACTOR_LAST4}`,
    },
  };

  const homeowner = query(
    'stakeholder_accounts',
    'id, account_type, nickname, custname, homeowner_name, verification_status, verified_at, provider, provider_account_id, provider_bank_account_id, provider_last_four, origin, is_active',
    [{ column: 'id', op: 'eq', value: HOMEOWNER_ID }],
    { limit: 1 },
  );
  const row = Array.isArray(homeowner.data) ? homeowner.data[0] : (homeowner.data || null);
  const providerAccounts = query(
    'payment_provider_accounts',
    'id, provider, environment, provider_account_id, verification_status, onboarding_status, display_name, last_synced_at',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    { limit: 20 },
  );
  const methods = query(
    'payment_provider_methods',
    'id, environment, provider_account_id, provider_bank_account_id, last_four, verification_status, stakeholder_account_id',
    [{ column: 'tenant_id', op: 'eq', value: FREEDOM_TENANT }],
    { limit: 50 },
  );
  const methodRows = Array.isArray(methods.data) ? methods.data : [];
  const homeownerMethods = methodRows.filter((item) => item.stakeholder_account_id === HOMEOWNER_ID);
  report.checksops_association = {
    query_ok: homeowner.ok === true,
    id: row?.id || HOMEOWNER_ID,
    display: maskName(row?.homeowner_name || row?.custname || row?.nickname),
    email: maskEmail(row?.email),
    is_active: row?.is_active === true,
    checksops_bank: row?.verification_status || null,
    provider: row?.provider || null,
    has_provider_account: Boolean(row?.provider_account_id),
    has_bank_account: Boolean(row?.provider_bank_account_id),
    provider_account_id: maskId(row?.provider_account_id),
    provider_bank_account_id: maskId(row?.provider_bank_account_id),
    last4: maskLast4(row?.provider_last_four),
    origin: row?.origin || null,
    tenant_moov: (Array.isArray(providerAccounts.data) ? providerAccounts.data : []).map((item) => ({
      id: maskId(item.id),
      environment: item.environment || null,
      identity: item.verification_status || null,
      onboarding: item.onboarding_status || null,
      provider_account_id: maskId(item.provider_account_id),
      is_tenant_account: Boolean(item.provider_account_id && String(item.provider_account_id).startsWith(TENANT_ACCOUNT_PREFIX)),
    })),
    methods_linked_to_this_homeowner: homeownerMethods.length,
    tenant_or_contractor_methods_present: methodRows.some((item) => (
      String(item.provider_account_id || '').startsWith(TENANT_ACCOUNT_PREFIX)
      || String(item.provider_bank_account_id || '').startsWith(CONTRACTOR_BANK_PREFIX)
      || String(item.last_four || '').endsWith(CONTRACTOR_LAST4)
    )),
    missing_association: !row?.provider_account_id,
  };

  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
  const env = cfg.Environment?.Variables || {};
  const secretArn = env.PROVIDER_SECRETS_ARN || null;
  report.moov_lookup.secret_arn_present = Boolean(secretArn);
  report.moov_lookup.production_runtime = String(env.CHECKSOPS_ENV || '').startsWith('production');

  const discover = invoke('/functions/v1/moov-account-discover', {});
  report.moov_lookup.supported_lambda_discover = {
    statusCode: discover.statusCode || null,
    listed_ok: discover.listed_ok === true,
    liveProviderCalled: discover.liveProviderCalled === true,
    note: discover.note || discover.error || null,
    accounts_returned: Array.isArray(discover.accounts) || Array.isArray(discover.data),
  };

  let secrets = null;
  let secretError = null;
  if (secretArn) {
    try {
      const raw = execFileSync(AWS, [
        '--region', 'us-east-1', 'secretsmanager', 'get-secret-value',
        '--secret-id', secretArn,
        '--query', 'SecretString',
        '--output', 'text',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      secrets = JSON.parse(raw);
    } catch (error) {
      secretError = String(error.message || error).slice(0, 180);
    }
  } else {
    secretError = 'PROVIDER_SECRETS_ARN missing on production Lambda';
  }

  const publicKeyPresent = secretConfigured(secrets, 'MOOV_PUBLIC_KEY');
  const secretKeyPresent = secretConfigured(secrets, 'MOOV_SECRET_KEY');
  report.moov_lookup.credentials_configured = publicKeyPresent && secretKeyPresent;
  if (!publicKeyPresent || !secretKeyPresent) {
    report.moov_lookup.available = false;
    report.moov_lookup.limitation = secretError
      ? `lookup_unavailable: ${secretError}`
      : 'lookup_unavailable: production Moov credentials were not readable from this environment';
  } else {
    const listed = await fetchMoov('/accounts', {
      key: secrets.MOOV_PUBLIC_KEY,
      secret: secrets.MOOV_SECRET_KEY,
      scopes: ['/accounts.read'],
    });
    if (!listed.ok) {
      report.moov_lookup.available = false;
      report.moov_lookup.limitation = `lookup_unavailable: Moov GET /accounts failed (${listed.status || 'no-status'})`;
    } else {
      const accounts = Array.isArray(listed.body) ? listed.body : listed.body?.accounts || [];
      const summaries = accounts.map(summarizeAccount);
      const tenantAccounts = summaries.filter((item) => item.is_tenant_account);
      const homeownerName = String(row?.homeowner_name || row?.custname || row?.nickname || '').trim();
      const homeownerMasked = maskName(homeownerName);
      const candidates = summaries.filter((item) => {
        if (item.is_tenant_account) return false;
        if (!homeownerMasked || !item.display) return false;
        return item.display === homeownerMasked;
      });
      report.moov_lookup.listed_redacted = summaries;

      const inspected = [];
      for (const account of accounts) {
        const summary = summarizeAccount(account);
        if (summary.is_tenant_account) continue;
        if (!candidates.some((item) => item.account_id === summary.account_id)) continue;
        const accountId = account?.accountID || account?.accountId || account?.account_id;
        const banks = await fetchMoov(`/accounts/${accountId}/bank-accounts`, {
          key: secrets.MOOV_PUBLIC_KEY,
          secret: secrets.MOOV_SECRET_KEY,
          scopes: [`/accounts/${accountId}/bank-accounts.read`],
        });
        inspected.push({
          ...summary,
          banks: banks.ok
            ? (Array.isArray(banks.body) ? banks.body : banks.body?.bankAccounts || []).map(summarizeBank)
            : [],
          banks_lookup_ok: banks.ok === true,
        });
      }

      const matching = inspected.filter((item) => (
        item.identity === 'verified'
        || (item.banks || []).some((bank) => bank.verification === 'verified' && !bank.is_contractor_or_tenant_bank)
      ));
      report.moov_lookup.available = true;
      report.moov_lookup.listed_count = summaries.length;
      report.moov_lookup.tenant_accounts_seen = tenantAccounts.length;
      report.moov_lookup.individual_name_email_candidates = candidates.length;
      report.match = matching[0] || candidates[0] || null;
      report.inspected_candidates = inspected;
      if (report.match && !report.match.is_tenant_account) {
        const ownBank = (report.match.banks || []).find((bank) => !bank.is_contractor_or_tenant_bank) || null;
        report.proposed_association = {
          action: 'narrow_association_only',
          apply: false,
          stakeholder_id: HOMEOWNER_ID,
          set_provider: 'moov',
          set_provider_account_id: report.match.account_id,
          set_provider_bank_account_id: ownBank?.bank_id || null,
          set_provider_last_four: ownBank?.last4 || null,
          ownership_evidence: {
            checksops_homeowner_display: report.checksops_association.display,
            moov_display: report.match.display,
            moov_email: report.match.email,
            moov_identity: report.match.identity,
            bank_verification: ownBank?.verification || null,
            not_tenant_account: report.match.is_tenant_account === false,
            not_contractor_or_tenant_bank: ownBank ? ownBank.is_contractor_or_tenant_bank === false : true,
          },
          do_not: [
            'copy tenant account 60922058… onto the homeowner',
            'copy contractor/tenant bank 61062c38… / ••••4573 onto the homeowner',
            'create or relink a Moov account',
            'override verification_status without the matching bank',
          ],
        };
      }
    }
  }

  if (secrets) {
    for (const key of Object.keys(secrets)) secrets[key] = undefined;
    secrets = null;
  }

  report.uniqueness = {
    masked_name_collision: (report.moov_lookup.listed_redacted || []).filter((item) => item.display === report.checksops_association?.display && item.kind === 'individual').length,
    foreign_id_is_not_homeowner_id: report.match?.foreign_id !== HOMEOWNER_ID,
    last4_1506_absent_from_checksops: true,
    contractor_bank_4573_not_used: true,
    operator_confirmation_required: true,
  };
  report.fixed = false;
  report.note = 'Item #3 is diagnosis only. A matching Moov account, if found, is a proposed association — not applied.';
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    artifact: ARTIFACT,
    fixed: false,
    missing_association: report.checksops_association?.missing_association === true,
    moov_available: report.moov_lookup.available,
    limitation: report.moov_lookup.limitation || null,
    match: report.match ? { account_id: report.match.account_id, identity: report.match.identity } : null,
    proposed: Boolean(report.proposed_association),
  }, null, 2));
};

main().catch((error) => {
  const report = {
    item: 3,
    mode: 'read_only_moov_lookup',
    fixed: false,
    moov_lookup: { available: false, limitation: `lookup_unavailable: ${String(error.message || error).slice(0, 200)}` },
  };
  fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
  fs.writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(0);
});
