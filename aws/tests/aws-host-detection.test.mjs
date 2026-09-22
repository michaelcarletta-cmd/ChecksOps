import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  apexCanonicalRedirectUrl,
  awsPasskeyRequiredMessage,
  isAwsProductionHost,
  isAwsStagingHost,
  normalizePublicHostname,
  shouldShowAwsStagingBanner,
} from '../../src/lib/awsHost.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('hostname helpers distinguish staging from production without treating Cognito as staging', () => {
  assert.equal(normalizePublicHostname('Staging.ChecksOps.com.'), 'staging.checksops.com');
  assert.equal(isAwsStagingHost('staging.checksops.com'), true);
  assert.equal(isAwsStagingHost('checksops.com'), false);
  assert.equal(isAwsStagingHost('www.checksops.com'), false);
  assert.equal(isAwsProductionHost('checksops.com'), true);
  assert.equal(isAwsProductionHost('www.checksops.com'), true);
  assert.equal(isAwsProductionHost('staging.checksops.com'), false);
  assert.equal(shouldShowAwsStagingBanner({ cognito: true, hostname: 'staging.checksops.com' }), true);
  assert.equal(shouldShowAwsStagingBanner({ cognito: true, hostname: 'checksops.com' }), false);
  assert.equal(shouldShowAwsStagingBanner({ cognito: true, hostname: 'www.checksops.com' }), false);
  assert.equal(shouldShowAwsStagingBanner({ cognito: false, hostname: 'staging.checksops.com' }), false);
  assert.match(awsPasskeyRequiredMessage('https://checksops.com'), /https:\/\/checksops\.com/);
  assert.doesNotMatch(awsPasskeyRequiredMessage('https://checksops.com'), /staging\.checksops\.com/);
  assert.equal(
    apexCanonicalRedirectUrl({
      hostname: 'www.checksops.com',
      protocol: 'https:',
      pathname: '/freedom/checks',
      search: '?tab=open',
      hash: '#row',
    }),
    'https://checksops.com/freedom/checks?tab=open#row',
  );
  assert.equal(apexCanonicalRedirectUrl({ hostname: 'checksops.com', pathname: '/login' }), null);
  assert.equal(apexCanonicalRedirectUrl({ hostname: 'staging.checksops.com', pathname: '/login' }), null);
});

test('isAwsStaging remains the Cognito adapter switch and is not inverted', () => {
  const staging = read('src/lib/awsStaging.ts');
  assert.match(staging, /Do not invert it/);
  assert.match(staging, /VITE_AUTH_PROVIDER/);
  assert.match(staging, /isAwsStagingHost/);
  assert.doesNotMatch(
    staging,
    /export function isAwsStaging\(\)[\s\S]{0,120}staging\.checksops\.com/,
  );
});

test('production login copy no longer tells users to use staging.checksops.com', () => {
  const login = read('src/pages/checkops/CheckOpsLogin.tsx');
  const mortgage = read('src/pages/mortgage-ops/MortgageOpsLogin.tsx');
  const white = read('src/components/white-label/WhiteLabelLogin.tsx');
  const passkeys = read('src/components/auth/PasskeyManagerCard.tsx');
  const banner = read('src/components/AwsStagingBanner.tsx');
  for (const src of [login, mortgage, white, passkeys]) {
    assert.doesNotMatch(src, /Passkeys require https:\/\/staging\.checksops\.com/);
    assert.match(src, /awsPasskeysBlockedMessage|awsPasskeyRequiredMessage|awsStagingHost/);
  }
  assert.match(login, /awsStagingHost \? " AWS staging\." : ""/);
  assert.match(banner, /awsStagingBannerVisible/);
  assert.doesNotMatch(banner, /isAwsStaging\(\)/);
});

test('index.html canonicalizes www.checksops.com before the SPA boots', () => {
  const html = read('index.html');
  assert.match(html, /www\.checksops\.com/);
  assert.match(html, /https:\/\/checksops\.com/);
  assert.match(html, /location\.pathname \+ window\.location\.search \+ window\.location\.hash/);
  assert.doesNotMatch(html, /staging\.checksops\.com/);
});

test('frontend AWS write tables include the reviewed nonfinancial gaps', () => {
  const client = read('src/integrations/aws/client.ts');
  for (const table of [
    'claims',
    'cash_jobs',
    'cash_job_line_items',
    'cash_job_attachments',
    'homeowner_ledger_events',
    'financial_stepup_log',
  ]) {
    assert.match(client, new RegExp(`"${table}"`));
  }
});
