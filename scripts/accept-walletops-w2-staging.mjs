#!/usr/bin/env node
/**
 * Staging W2 acceptance. GET-only. No sweep write. No wallet fund POST.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { assumeCursorRole, masterToken } from './cognito-staging-token.mjs';

const OUT = '/opt/cursor/artifacts/walletops-w2';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';

const api = async (pathname, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 400) }; }
  return { ok: res.ok && data?.ok !== false && data?.error == null, status: res.status, data };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('walletops-w2-staging-accept');
  const health = await fetch(`${API}/health`).then(async (res) => ({
    status: res.status,
    data: await res.json().catch(() => ({})),
  }));
  const minted = await masterToken();
  const token = minted?.authentication?.IdToken || null;
  const identity = token ? await api('/identity/me', { token, method: 'GET' }) : { ok: false, error: 'no_token' };
  const memberships = identity.data?.memberships || identity.data?.tenants || [];
  const tenantId = memberships[0]?.tenant_id || memberships[0]?.id || FREEDOM;
  const sweep = token
    ? await api('/functions/v1/moov-sweep-config', {
      token,
      body: { action: 'get', tenant_id: tenantId, wallet_type: 'operating' },
    })
    : { ok: false, error: 'no_token' };
  const cross = token
    ? await api('/functions/v1/moov-sweep-config', {
      token,
      body: { action: 'get', tenant_id: OTHER === tenantId ? PLATFORM : OTHER, wallet_type: 'operating' },
    })
    : { ok: false, error: 'no_token' };
  const banner = await fetch('https://staging.checksops.com/').then(async (res) => {
    const html = await res.text();
    return {
      status: res.status,
      hasBannerChunk: /AwsStaging|AWS staging/.test(html),
      js: (html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/) || [])[1] || null,
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    walletFundPosted: false,
    sweepWritePosted: false,
    health,
    tokenOk: Boolean(token),
    identity: { ok: identity.ok, status: identity.status, user: identity.data?.email || identity.data?.user?.email || null },
    tenantId,
    sweep: {
      ok: sweep.ok,
      status: sweep.status,
      environment: sweep.data?.environment || null,
      hasSettlement: Boolean(sweep.data?.settlement_method),
      hasSweepConfig: sweep.data?.sweep_config != null,
      hasPushRails: Array.isArray(sweep.data?.available_push_rails),
      keys: sweep.data ? Object.keys(sweep.data) : [],
      error: sweep.data?.error || sweep.error || null,
    },
    crossTenant: {
      status: cross.status,
      error: cross.data?.error || cross.error || null,
      denied: cross.status === 403 || cross.data?.error === 'cross_tenant_denied',
    },
    banner,
    contract: Boolean(
      sweep.data
      && ('settlement_method' in (sweep.data || {}) || sweep.status === 409 || sweep.status === 503)
    ),
  };
  await writeFile(`${OUT}/staging-acceptance.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
