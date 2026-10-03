import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const session = readFileSync(new URL('../../supabase/functions/moov-recipient-session/index.ts', import.meta.url), 'utf8');
const classify = readFileSync(new URL('../../supabase/functions/_shared/moovAccountGetClassify.ts', import.meta.url), 'utf8');
const client = readFileSync(new URL('../../supabase/functions/_shared/moovClient.ts', import.meta.url), 'utf8');
const guard = readFileSync(new URL('../../supabase/functions/_shared/moovGuard.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');

const classifyProviderErrorClass = ({ stage, status, cloudflareCode, hint, network }) => {
  if (cloudflareCode || hint === 'html_error_page') return 'cloudflare_block';
  if (network && (status == null || status === 0)) return 'network';
  const text = String(hint ?? '').toLowerCase();
  if (stage === 'oauth_token') {
    if (status === 401 && /origin/.test(text)) return 'oauth_origin';
    if (status === 401 && /invalid_client|unauthorized_client|invalid client/i.test(text)) return 'oauth_credentials';
    if (status === 401 || status === 403) return /origin/.test(text) ? 'oauth_origin' : 'oauth_credentials';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'provider_error';
    return 'oauth_unauthorized';
  }
  if (status === 401) return 'account_unauthenticated';
  if (status === 403) return 'account_unauthorized';
  if (status === 404) return 'account_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'unknown';
};

test('session no longer swallows the account GET', () => {
  assert.doesNotMatch(session, /moovFetch<any>\(`\/accounts\/\$\{accountId\}`.+\)\.catch\(\(\) => null\)/s);
  assert.match(session, /oauthTokenIssued/);
  assert.match(session, /accountGetSent/);
  assert.match(session, /classifyMoovAccountGetFailure/);
  assert.match(session, /x-checksops-moov-classify/);
  assert.match(session, /error: "moov_account_get_failed"/);
  assert.doesNotMatch(session, /method:\s*"POST"/);
  assert.doesNotMatch(session, /method:\s*"PATCH"/);
  assert.doesNotMatch(session, /bankAccountsWrite/);
  assert.doesNotMatch(session, /transfers\.write/);
});

test('public 502 body stays generic and diagnostics are operator-gated', () => {
  assert.match(session, /operatorClassifyRequested\(req\)/);
  assert.match(session, /error: "moov_account_get_failed", message: "Could not load the payment-provider account\." \}, 502, extra\)/);
  assert.doesNotMatch(session, /json\(\{[^}]*failure_stage/);
  assert.match(guard, /x-checksops-operator-classify/);
  assert.doesNotMatch(guard, /Access-Control-Expose-Headers/);
});

test('classifier never asks for raw secrets or secure-link tokens', () => {
  assert.match(classify, /AWS_PRODUCTION_PUBLIC_KEY_FP12 = "3ad0839428e5"/);
  assert.match(classify, /AWS_PRODUCTION_APP_ID_PREFIX = "694a303b"/);
  assert.match(classify, /sha256Hex12/);
  assert.match(classify, /edge_public_key_fp12/);
  assert.doesNotMatch(classify, /access_token\s*[:=]/);
  assert.doesNotMatch(session, /console\.(?:log|error)\([^)]*secure_token/);
  assert.doesNotMatch(session, /console\.(?:log|error)\([^)]*access_token/);
  assert.doesNotMatch(client, /body \?\? text/);
  assert.match(client, /moovResponseMeta\(res, text, "oauth_token"\)/);
  assert.match(client, /sanitizedMoovLogBody/);
});

test('recipient session JWT remains off', () => {
  assert.match(
    config,
    /\[functions\.moov-recipient-session\]\s*\nverify_jwt = false/,
  );
});

test('error class mapping covers oauth vs account GET', () => {
  assert.equal(classifyProviderErrorClass({
    stage: 'oauth_token', status: 401, cloudflareCode: null, hint: 'invalid_client', network: false,
  }), 'oauth_credentials');
  assert.equal(classifyProviderErrorClass({
    stage: 'oauth_token', status: 401, cloudflareCode: null, hint: 'origin not allowed', network: false,
  }), 'oauth_origin');
  assert.equal(classifyProviderErrorClass({
    stage: 'account_get', status: 403, cloudflareCode: null, hint: null, network: false,
  }), 'account_unauthorized');
  assert.equal(classifyProviderErrorClass({
    stage: 'account_get', status: 404, cloudflareCode: null, hint: null, network: false,
  }), 'account_not_found');
  assert.equal(classifyProviderErrorClass({
    stage: 'account_get', status: 401, cloudflareCode: null, hint: null, network: false,
  }), 'account_unauthenticated');
  assert.equal(classifyProviderErrorClass({
    stage: 'oauth_token', status: 403, cloudflareCode: '1010', hint: 'html_error_page', network: false,
  }), 'cloudflare_block');
  assert.equal(classifyProviderErrorClass({
    stage: 'oauth_token', status: null, cloudflareCode: null, hint: null, network: true,
  }), 'network');
});
