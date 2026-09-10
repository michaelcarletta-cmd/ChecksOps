#!/usr/bin/env node
/**
 * M6.3D pre-deploy proofs against the live AWS public session route.
 * Dummy / malformed tokens only. Never prints or posts a real pay-setup token.
 */
import { writeFileSync } from 'node:fs';

const SESSION_URL = 'https://checksops.com/prep/public/moov-recipient-session';
const STATUS_URL = 'https://checksops.com/prep/financial/status';
const READINESS_URL = 'https://checksops.com/prep/ops/readiness';
const DUMMY_UUID = '00000000-0000-4000-8000-000000000000';
const SPOOF_ACCOUNT = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const OUT = process.env.M63D_PROOF_OUT || '/opt/cursor/artifacts/m63d_predeploy_proofs.json';

const pick = (json, keys) => {
  const out = {};
  for (const key of keys) {
    if (json[key] !== undefined) out[key] = json[key];
  }
  return out;
};

const postSession = async (body) => {
  const response = await fetch(SESSION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return {
    http: response.status,
    ...pick(json, [
      'ok', 'statusCode', 'error', 'message', 'fields',
      'liveProviderCalled', 'mutated', 'token_consumed',
      'cognito_required', 'public_recipient', 'productionExecution',
      'productionRead', 'provider',
    ]),
  };
};

const dummy = await postSession({ token: DUMMY_UUID });
const malformedShort = await postSession({ token: 'x' });
const malformedFilter = await postSession({
  token: '*,id=eq.62a858ff-ee6a-49d7-9898-1c8e4a44227b',
});
const spoof = await postSession({
  token: DUMMY_UUID,
  provider_account_id: SPOOF_ACCOUNT,
});
const mutationFlag = await postSession({
  token: DUMMY_UUID,
  verify_bank: true,
});

const statusRes = await fetch(STATUS_URL);
const statusJson = await statusRes.json().catch(() => ({}));
const flags = statusJson.flags || {};
const readinessRes = await fetch(READINESS_URL);
const readinessJson = await readinessRes.json().catch(() => ({}));

const report = {
  phase: 'M6.3D-predeploy',
  session_url: SESSION_URL,
  dummy_uuid: dummy,
  malformed_short: malformedShort,
  malformed_filter: malformedFilter,
  provider_account_id_spoof: spoof,
  mutation_flag: mutationFlag,
  financial_status_http: statusRes.status,
  ops_readiness_http: readinessRes.status,
  money_flags: {
    AWS_MOOV_ENABLED: flags.AWS_MOOV_ENABLED,
    AWS_PROVIDER_EXECUTION_ENABLED: flags.AWS_PROVIDER_EXECUTION_ENABLED,
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: flags.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED,
    AWS_PROVIDER_LIVE_READS_ENABLED: flags.AWS_PROVIDER_LIVE_READS_ENABLED,
    AWS_PROVIDER_WEBHOOK_DRY_RUN: flags.AWS_PROVIDER_WEBHOOK_DRY_RUN,
  },
  sql72: readinessJson.financialActivationSqlApplied === true ? 'APPLIED' : 'NOT_APPLIED',
};

const pass = dummy.http === 404
  && dummy.token_consumed === false
  && dummy.liveProviderCalled === false
  && malformedShort.http === 404
  && malformedFilter.http === 404
  && spoof.http === 400
  && spoof.error === 'untrusted_provider_config'
  && mutationFlag.http === 400
  && mutationFlag.error === 'read_only_operation'
  && flags.AWS_MOOV_ENABLED === false
  && flags.AWS_PROVIDER_EXECUTION_ENABLED === false
  && flags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED === false
  && flags.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED === false;

report.pass = pass;
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, pass }, null, 2));
if (!pass) process.exit(1);
