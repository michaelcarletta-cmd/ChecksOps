#!/usr/bin/env node
/**
 * Phase 3A Steps 14-19: production health + Freedom READ-ONLY invoice preview.
 * Never sends action=pull. Never sets PRODUCTION_POST. Never creates EventBridge.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole, secretString } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/consolidated-billing-prod-safe';
const PROD_API = 'https://checksops.com/prep';
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const OWNER_EMAIL = 'checksopsadmin@gmail.com';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const awsTry = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 500) };
  }
};

const api = async (pathname, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${PROD_API}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('phase3a-freedom-preview');
  const cfg = awsTry(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
  const vars = cfg.data?.Environment?.Variables || {};
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing preview run');
  }

  const health = await fetch(`${PROD_API}/health`).then(async (res) => ({
    status: res.status, body: await res.json().catch(() => null),
  }));
  const unauth = await api('/tenant-billing-admin', { body: { action: 'preview', tenant_id: FREEDOM } });

  let token = null;
  let auth = { attempted: false };
  try {
    const password = secretString('checksops/staging/master-uat-password');
    const minted = awsTry([
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', PROD_POOL,
      '--client-id', PROD_CLIENT,
      '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${OWNER_EMAIL},PASSWORD=${password}`,
    ]);
    token = minted.data?.AuthenticationResult?.IdToken || null;
    auth = { attempted: true, ok: Boolean(token), error: token ? null : minted.error, passwordReset: false };
  } catch (error) {
    auth = { attempted: true, ok: false, error: String(error.message || error).slice(0, 300), passwordReset: false };
  }

  const identity = token ? await api('/identity/me', { token, method: 'GET' }) : null;
  const preview = token ? await api('/tenant-billing-admin', {
    token,
    body: { action: 'preview', tenant_id: FREEDOM },
  }) : null;
  const snapshot = token ? await api('/tenant-billing-authorize', {
    token,
    body: { action: 'snapshot', tenant_id: FREEDOM },
  }) : null;

  const invoice = preview?.data?.invoice || snapshot?.data?.invoice || null;
  const report = {
    generatedAt: new Date().toISOString(),
    productionPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST,
    lambdaSha: cfg.data?.CodeSha256 || null,
    health,
    unauthPreview: { status: unauth.status, error: unauth.data?.error || null },
    auth,
    identity: identity && {
      status: identity.status,
      ok: identity.ok,
      isMasterOwner: identity.data?.isMasterOwner ?? identity.data?.is_platform_owner ?? null,
    },
    previewStatus: preview?.status ?? null,
    snapshotStatus: snapshot?.status ?? null,
    invoice,
    pullPreview: preview?.data?.pull_preview || snapshot?.data?.pull_preview || null,
    currentAmountDue: preview?.data?.current_amount_due_cents ?? snapshot?.data?.current_amount_due_cents ?? null,
    currentPeriod: preview?.data?.current_period || snapshot?.data?.current_period || null,
    collectionPeriod: preview?.data?.collection_period || snapshot?.data?.collection_period || null,
    pullPeriod: preview?.data?.pull_period || snapshot?.data?.pull_period || null,
    nextBillingDate: preview?.data?.next_billing_date || snapshot?.data?.next_billing_date || null,
    rates: {
      monthly: preview?.data?.monthly_rate_cents ?? snapshot?.data?.monthly_rate_cents ?? null,
      discount: preview?.data?.referral_discount_cents ?? snapshot?.data?.referral_discount_cents ?? null,
      perCheck: preview?.data?.per_check_rate_cents ?? snapshot?.data?.per_check_rate_cents ?? null,
      nextDay: preview?.data?.next_day_rate_cents ?? snapshot?.data?.next_day_rate_cents ?? null,
      sameDay: preview?.data?.same_day_rate_cents ?? snapshot?.data?.same_day_rate_cents ?? null,
      instant: preview?.data?.instant_rate_cents ?? snapshot?.data?.instant_rate_cents ?? null,
      instantEnabled: preview?.data?.instant_enabled ?? snapshot?.data?.instant_enabled ?? null,
    },
    fundingLast4: preview?.data?.funding_source_last4 ?? snapshot?.data?.funding_source_last4 ?? null,
    destination: preview?.data?.destination || snapshot?.data?.destination || null,
    readiness: preview?.data?.readiness || snapshot?.data?.readiness || null,
    pendingCharge: preview?.data?.pending_charge || snapshot?.data?.pending_charge || null,
    pullExecuted: false,
    rowsCreatedByPreview: null,
  };
  await writeFile(`${OUT}/phase3a-freedom-preview.json`, JSON.stringify(report, null, 2));
  if (preview?.data) {
    await writeFile(`${OUT}/phase3a-freedom-preview-raw.json`, JSON.stringify({
      preview: preview.data,
      snapshot: snapshot?.data || null,
    }, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
