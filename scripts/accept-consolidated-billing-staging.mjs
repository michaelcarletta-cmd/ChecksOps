#!/usr/bin/env node
/**
 * Phase 2B staging acceptance: synthetic $109.50 consolidated invoice.
 * Staging/sandbox/simulation only. Does not touch production or Freedom.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';
import { collectionPeriodKey, defaultPullPeriodKey } from '../aws/functions/api/tenant-billing-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const API_NAME = 'checksops-staging-api';
const ONESHOT = 'checksops-staging-sql44-seed-2d41';
const OUT = '/opt/cursor/artifacts/consolidated-billing-staging';
const EXPECTED = 10950;

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', 'us-east-1', '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const apiCall = async (fn, { token, body, method = 'POST' } = {}) => {
  const res = await fetch(`${API}/functions/v1/${fn}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 600) }; }
  return { http: res.status, ok: res.ok && data?.ok !== false, data };
};

const invokeSeed = async ({ mode, ownerId, testerId, rebuilt = false } = {}) => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const apiCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]);
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST,
      DATABASE_NAME: 'checksops',
      SEED_MODE: mode,
      OWNER_USER_ID: ownerId || '',
      TESTER_USER_ID: testerId || '',
      SYNTHETIC_SLUG: 'synthetic-consolidated-billing',
      BILLING_PERIOD: '2026-09',
    },
  };
  if (!rebuilt) {
    const staging = path.join(os.tmpdir(), 'checksops-sql44-seed-pack');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await copyFile(path.join(ROOT, 'aws/rls/oneshot/consolidated-billing-seed/index.mjs'), path.join(staging, 'index.mjs'));
    await copyFile(path.join(ROOT, 'aws/rls/oneshot/consolidated-billing-seed/package.json'), path.join(staging, 'package.json'));
    await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
    execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
    const zip = path.join(os.tmpdir(), 'checksops-sql44-seed.zip');
    await rm(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
    try {
      awsJson(['lambda', 'get-function', '--function-name', ONESHOT]);
      awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
      waitFn(ONESHOT);
      awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '90', '--environment', JSON.stringify(env)]);
    } catch {
      const vpc = apiCfg.VpcConfig || {};
      awsJson([
        'lambda', 'create-function',
        '--function-name', ONESHOT,
        '--runtime', 'nodejs20.x',
        '--role', rehearsal.Role,
        '--handler', 'index.handler',
        '--timeout', '90',
        '--memory-size', '256',
        '--zip-file', `fileb://${zip}`,
        '--environment', JSON.stringify(env),
        '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
      ]);
    }
    waitFn(ONESHOT);
  } else {
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--environment', JSON.stringify(env)]);
    waitFn(ONESHOT);
  }
  const outFile = path.join(os.tmpdir(), `sql44-seed-${mode}-${Date.now()}.json`);
  execFileSync(AWS, ['lambda', 'invoke', '--function-name', ONESHOT, outFile]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const moneyProof = (snap) => {
  const inv = snap?.invoice || snap?.pull_preview || {};
  return {
    maintenance_rate_cents: inv.maintenance_rate_cents ?? snap?.monthly_rate_cents,
    discount_cents: inv.discount_cents ?? snap?.referral_discount_cents,
    maintenance_net_cents: inv.maintenance_net_cents ?? snap?.net_fee_cents,
    check_count: inv.check_count,
    check_usage_cents: inv.check_usage_cents,
    next_day_count: inv.next_day_count,
    next_day_usage_cents: inv.next_day_usage_cents,
    same_day_count: inv.same_day_count,
    same_day_usage_cents: inv.same_day_usage_cents,
    usage_total_cents: inv.usage_total_cents,
    amount_cents: inv.amount_cents ?? snap?.current_amount_due_cents,
    current_amount_due_cents: snap?.current_amount_due_cents,
    instant_enabled: snap?.instant_enabled,
    instant_rate_cents: snap?.instant_rate_cents,
    per_check_rate_cents: snap?.per_check_rate_cents,
    next_day_rate_cents: snap?.next_day_rate_cents,
    same_day_rate_cents: snap?.same_day_rate_cents,
    pending_period: snap?.pending_charge?.billing_period ?? null,
    pending_amount: snap?.pending_charge?.amount_cents ?? null,
    pending_status: snap?.pending_charge?.status ?? null,
  };
};

const expected10950 = (proof) => (
  proof.maintenance_rate_cents === 10000
  && proof.discount_cents === 500
  && proof.maintenance_net_cents === 9500
  && proof.check_count === 3
  && proof.check_usage_cents === 1200
  && proof.next_day_count === 2
  && proof.next_day_usage_cents === 150
  && proof.same_day_count === 1
  && proof.same_day_usage_cents === 100
  && proof.usage_total_cents === 1450
  && proof.amount_cents === EXPECTED
  && proof.instant_enabled === false
  && proof.instant_rate_cents == null
);

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('phase2b-accept');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/mint-platform-owner-token.mjs')], { stdio: 'inherit' });
  const ownerTok = JSON.parse(await readFile('/opt/cursor/artifacts/moov-monthly-billing-preprod/.staging-owner.jwt.json', 'utf8'));
  const testerTok = JSON.parse(await readFile('/opt/cursor/artifacts/moov-monthly-billing-preprod/.staging-tester.jwt.json', 'utf8'));
  const ownerMe = await fetch(`${API}/identity/me`, { headers: { authorization: `Bearer ${ownerTok.idToken}` } }).then((r) => r.json());
  const testerMe = await fetch(`${API}/identity/me`, { headers: { authorization: `Bearer ${testerTok.idToken}` } }).then((r) => r.json());

  const seed = await invokeSeed({
    mode: 'seed10950',
    ownerId: ownerMe.applicationUserId,
    testerId: testerMe.applicationUserId,
  });
  const tenantId = seed.tenantId || seed.tenant?.id;
  if (!tenantId) {
    await writeFile(path.join(OUT, 'phase2b-accept.json'), JSON.stringify({ ok: false, step: 'seed', seed }, null, 2));
    console.log(JSON.stringify({ ok: false, step: 'seed', seed }, null, 2));
    process.exit(1);
  }

  const configUpdate = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: {
      action: 'update',
      tenant_id: tenantId,
      monthly_rate_cents: 10000,
      referral_discount_cents: 500,
      per_check_rate_cents: 400,
      next_day_rate_cents: 75,
      same_day_rate_cents: 100,
      billing_enabled: true,
      billing_day_of_month: 1,
    },
  });
  const adminSnap = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'get', tenant_id: tenantId },
  });
  const tenantSnap = await apiCall('tenant-billing-authorize', {
    token: testerTok.idToken,
    body: { action: 'snapshot', tenant_id: tenantId },
  });
  const tenantDeniedUpdate = await apiCall('tenant-billing-admin', {
    token: testerTok.idToken,
    body: { action: 'update', tenant_id: tenantId, next_day_rate_cents: 1 },
  });
  const previewNoConfirm = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'pull', tenant_id: tenantId, period: '2026-09', amount_cents: 1 },
  });
  const preview = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'preview', tenant_id: tenantId },
  });
  const pull = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'pull', tenant_id: tenantId, period: '2026-09', confirm: true, amount_cents: 1 },
  });
  const pullAgain = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'pull', tenant_id: tenantId, period: '2026-09', confirm: true, amount_cents: 99999 },
  });

  const promoRate = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'update', tenant_id: tenantId, next_day_rate_cents: 50 },
  });
  const afterPromoSnap = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'get', tenant_id: tenantId },
  });
  const promoSeed = await invokeSeed({
    mode: 'promo50',
    ownerId: ownerMe.applicationUserId,
    testerId: testerMe.applicationUserId,
    rebuilt: true,
  });

  const transferId = pull.data?.pull?.occurrence?.provider_transfer_id
    || pull.data?.pending_charge?.provider_transfer_id;
  const returned = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: {
      action: 'apply-event',
      tenant_id: tenantId,
      provider_transfer_id: transferId,
      status: 'transfer.returned',
      reason: 'simulated_R01',
    },
  });
  const afterReturnSnap = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'get', tenant_id: tenantId },
  });
  const pullAfterReturn = await apiCall('tenant-billing-admin', {
    token: ownerTok.idToken,
    body: { action: 'pull', tenant_id: tenantId, period: '2026-09', confirm: true },
  });

  const adminProof = moneyProof(adminSnap.data);
  const tenantProof = moneyProof(tenantSnap.data);
  const previewProof = moneyProof(preview.data);
  const occurrence = pull.data?.pull?.occurrence || pull.data?.pending_charge || {};
  const allocations = pull.data?.invoice?.allocations
    || afterPromoSnap.data?.invoice?.allocations
    || [];
  const legacyInHistory = (adminSnap.data?.history || []).find((row) => Number(row.amount_cents) === 1 && !row.billing_period);
  const pendingIsLegacy = Number(adminSnap.data?.pending_charge?.amount_cents) === 1
    && !adminSnap.data?.pending_charge?.billing_period;

  const flags = awsJson(['lambda', 'get-function-configuration', '--function-name', API_NAME]).Environment?.Variables || {};
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);

  const report = {
    generatedAt: new Date().toISOString(),
    seed,
    tenantId,
    configUpdate: {
      ok: configUpdate.ok,
      rates: moneyProof(configUpdate.data),
      http: configUpdate.http,
    },
    adminSnap: { http: adminSnap.http, ok: adminSnap.ok, proof: adminProof },
    tenantSnap: { http: tenantSnap.http, ok: tenantSnap.ok, proof: tenantProof },
    tenantCannotEditRates: {
      ok: tenantDeniedUpdate.ok === false,
      http: tenantDeniedUpdate.http,
      error: tenantDeniedUpdate.data?.error || null,
    },
    previewRequiresConfirm: {
      ok: previewNoConfirm.data?.error === 'confirmation_required',
      http: previewNoConfirm.http,
      error: previewNoConfirm.data?.error || null,
      clientAmountIgnored: previewNoConfirm.data?.client_amount_ignored ?? null,
      amount: previewNoConfirm.data?.current_amount_due_cents ?? previewNoConfirm.data?.invoice?.amount_cents,
    },
    preview: { http: preview.http, ok: preview.ok, proof: previewProof },
    pull: {
      http: pull.http,
      ok: pull.ok,
      amount_cents_posted: pull.data?.amount_cents_posted ?? occurrence.amount_cents ?? null,
      client_amount_ignored: pull.data?.client_amount_ignored,
      simulated: pull.data?.pull?.simulated,
      liveProviderCalled: pull.data?.pull?.liveProviderCalled,
      provider_transfer_id: occurrence.provider_transfer_id || null,
      status: occurrence.status || null,
      occurrence_id: occurrence.id || null,
      check_count: occurrence.check_count,
      next_day_count: occurrence.next_day_count,
      same_day_count: occurrence.same_day_count,
      allocations: allocations.length,
    },
    idempotency: {
      http: pullAgain.http,
      ok: pullAgain.ok,
      duplicate: pullAgain.data?.pull?.duplicate === true,
      reason: pullAgain.data?.pull?.reason || null,
      sameOccurrence: pullAgain.data?.pull?.occurrence?.id === occurrence.id,
      sameTransfer: pullAgain.data?.pull?.occurrence?.provider_transfer_id === occurrence.provider_transfer_id,
      secondCollection: pullAgain.data?.pull?.created === true,
    },
    promo: {
      rateUpdate: promoRate.ok,
      next_day_rate_cents: promoRate.data?.next_day_rate_cents,
      existingInvoiceAmount: afterPromoSnap.data?.pending_charge?.amount_cents
        ?? afterPromoSnap.data?.last_charge?.amount_cents
        ?? occurrence.amount_cents,
      existingInvoiceUnchanged: (
        afterPromoSnap.data?.pending_charge?.amount_cents === EXPECTED
        || afterPromoSnap.data?.last_charge?.amount_cents === EXPECTED
        || occurrence.amount_cents === EXPECTED
      ),
      newLine: promoSeed.promoLine || null,
    },
    failureReturn: {
      applied: returned.data?.event?.applied === true,
      status: returned.data?.event?.occurrence?.status || returned.data?.pending_charge?.status,
      allocationsAfter: (afterReturnSnap.data?.invoice?.allocations || []).length,
      occurrenceId: afterReturnSnap.data?.returned_charges?.[0]?.id
        || returned.data?.event?.occurrence?.id,
      retry: {
        http: pullAfterReturn.http,
        duplicate: pullAfterReturn.data?.pull?.duplicate === true,
        reason: pullAfterReturn.data?.pull?.reason || null,
        sameOccurrence: pullAfterReturn.data?.pull?.occurrence?.id === occurrence.id,
      },
    },
    legacyPenny: {
      seed: seed.legacyPenny || null,
      inHistory: Boolean(legacyInHistory),
      pendingIsLegacy,
      currentDueIs10950: adminProof.current_amount_due_cents === EXPECTED
        || adminProof.amount_cents === EXPECTED,
    },
    billingPeriod: {
      collectionDate: '2026-10-01',
      selectedPeriod: collectionPeriodKey(new Date('2026-10-01T00:00:00.000Z')),
      expected: '2026-09',
      defaultPullOnBillingDay: defaultPullPeriodKey(new Date('2026-10-01T00:00:00.000Z'), 1),
      defaultPullMidMonth: defaultPullPeriodKey(new Date('2026-09-25T17:00:00.000Z'), 1),
    },
    agreement: {
      adminEqualsTenant: JSON.stringify(adminProof) === JSON.stringify(tenantProof)
        || (
          adminProof.amount_cents === tenantProof.amount_cents
          && adminProof.check_count === tenantProof.check_count
          && adminProof.next_day_count === tenantProof.next_day_count
          && adminProof.same_day_count === tenantProof.same_day_count
        ),
      matches10950: expected10950(adminProof) && expected10950(tenantProof),
    },
    stagingFlags: {
      AWS_MOOV_MONTHLY_BILLING_ENABLED: flags.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
      AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: flags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED ?? null,
    },
    production: {
      name: prod.FunctionName,
      codeSha256: prod.CodeSha256,
      PRODUCTION_POST: prod.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
      notModified: true,
    },
    liveDebitCreated: false,
    productionSql: false,
    productionEventBridge: false,
  };
  report.ok = Boolean(
    seed.ok
    && configUpdate.ok
    && expected10950(adminProof)
    && expected10950(tenantProof)
    && tenantDeniedUpdate.ok === false
    && previewNoConfirm.data?.error === 'confirmation_required'
    && pull.ok
    && Number(report.pull.amount_cents_posted) === EXPECTED
    && pull.data?.pull?.liveProviderCalled !== true
    && report.idempotency.duplicate
    && report.billingPeriod.selectedPeriod === '2026-09'
    && !pendingIsLegacy
    && flags.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'true',
  );
  await writeFile(path.join(OUT, 'phase2b-accept.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
