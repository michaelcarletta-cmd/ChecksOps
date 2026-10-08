import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_ROUTE,
  collectReadonlyStatus,
  entryFromHtml,
  evaluatePublicValidator,
  evaluateSpaFingerprint,
  evaluateValidatorPreflight,
} from '../../scripts/deployment-guard/staging-db-validator-readonly-status.mjs';

test('SPA fingerprint detects the admin validator route only from live assets', () => {
  const html = '<script type="module" src="/assets/index-abc123.js"></script>';
  const missing = evaluateSpaFingerprint({ html, bundleText: 'other-app' });
  assert.equal(missing.entry_bundle, '/assets/index-abc123.js');
  assert.equal(missing.admin_route_present, false);
  assert.equal(entryFromHtml(html), '/assets/index-abc123.js');

  const present = evaluateSpaFingerprint({
    html,
    bundleText: `lazy(() => import("${ADMIN_ROUTE}"))`,
  });
  assert.equal(present.admin_route_present, true);
});

test('public validator contract stays redacted', () => {
  const unhealthy = evaluatePublicValidator({
    status: 503,
    body: { service: 'checksops-api', status: 'unhealthy', readOnly: true },
  });
  assert.equal(unhealthy.redacted, true);
  assert.equal(unhealthy.publicUnhealthy, true);

  const leak = evaluatePublicValidator({
    status: 503,
    body: { service: 'checksops-api', status: 'unhealthy', issues: [{ kind: 'count_mismatch' }] },
  });
  assert.equal(leak.redacted, false);
});

test('validator preflight requires GET and authorization from staging origin', () => {
  const headers = {
    get: (name) => ({
      'access-control-allow-origin': 'https://staging.checksops.com',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    }[name] || null),
  };
  const allowed = evaluateValidatorPreflight({ status: 204, headers });
  assert.equal(allowed.originAllowed, true);
  assert.equal(allowed.getAllowed, true);
  assert.equal(allowed.authorizationAllowed, true);

  const blocked = evaluateValidatorPreflight({
    status: 204,
    headers: { get: () => null },
  });
  assert.equal(blocked.originAllowed, false);
  assert.equal(blocked.authorizationAllowed, false);
});

test('readonly collector never sends a token and records SPA miss without deploying', async () => {
  const calls = [];
  const evidence = await collectReadonlyStatus({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, headers: init?.headers || {} });
      assert.equal(init?.headers?.authorization, undefined);
      if (String(url).endsWith('.com/')) {
        return {
          status: 200,
          headers: { entries: () => [['etag', 'abc']] },
          text: async () => '<script src="/assets/index-old.js"></script>',
        };
      }
      if (String(url).includes('/assets/index-old.js')) {
        return { status: 200, headers: { entries: () => [] }, text: async () => 'no-admin-ui' };
      }
      if (String(url).includes('/health') && !String(url).includes('db-health')) {
        return { status: 200, headers: { entries: () => [] }, text: async () => '{"status":"ok"}' };
      }
      if (String(url).includes('/db-health')) {
        return { status: 200, headers: { entries: () => [] }, text: async () => '{"status":"ok"}' };
      }
      if (init?.method === 'OPTIONS') {
        return {
          status: 204,
          headers: {
            entries: () => [
              ['access-control-allow-origin', 'https://staging.checksops.com'],
              ['access-control-allow-methods', 'GET,OPTIONS'],
              ['access-control-allow-headers', 'authorization'],
            ],
          },
          text: async () => '',
        };
      }
      return {
        status: 503,
        headers: { entries: () => [] },
        text: async () => '{"service":"checksops-api","status":"unhealthy","readOnly":true}',
      };
    },
  });
  assert.equal(evidence.tokenSent, false);
  assert.equal(evidence.writesAttempted, false);
  assert.equal(evidence.live_admin_ui_proven, false);
  assert.equal(evidence.public_validator.publicUnhealthy, true);
  assert.equal(evidence.cors.authorizationAllowed, true);
  assert.ok(calls.every((call) => !JSON.stringify(call.headers).toLowerCase().includes('bearer')));
});
