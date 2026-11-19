// The iOS/Android app always runs on localhost, so the "AWS staging" banner and login labels, which
// were hidden only on the checksops.com hostnames, showed in the production app build too. They
// now also stay hidden when the bundle was built for production (VITE_APP_URL is checksops.com).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { appUrlHostname, isProductionAppBuild } from '../../src/lib/productionAppBuild.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('a bundle built for checksops.com is a production build; staging and junk are not', () => {
  assert.equal(isProductionAppBuild('https://checksops.com'), true);
  assert.equal(isProductionAppBuild('https://www.checksops.com/'), true);
  assert.equal(isProductionAppBuild(' HTTPS://CHECKSOPS.COM '), true);
  assert.equal(isProductionAppBuild('https://staging.checksops.com'), false);
  assert.equal(isProductionAppBuild('https://checksops.com.evil.example'), false);
  assert.equal(isProductionAppBuild(''), false);
  assert.equal(isProductionAppBuild(undefined), false);
  assert.equal(appUrlHostname('not a url'), '');
});

test('the staging labels and banner check the build, not only the hostname', () => {
  const site = read('src/lib/awsStagingSite.ts');
  assert.match(site, /if \(!isAwsStaging\(\)\) return false;\s*if \(isProductionAppBuild\(\)\) return false;/);
  const banner = read('src/components/AwsStagingBanner.tsx');
  assert.match(banner, /import \{ isProductionAppBuild \} from "@\/lib\/awsStagingSite";/);
  assert.match(banner, /if \(isProductionAppBuild\(\)\) return null;/);
});

test('the production app build is built for checksops.com and the staging build is not', () => {
  const yaml = read('codemagic.yaml');
  const prod = yaml.slice(yaml.indexOf('- &build_web_production'), yaml.indexOf('- &install_capacitor'));
  assert.match(prod, /\n {8}VITE_APP_URL=https:\/\/checksops\.com\n/);
  assert.match(read('.env.aws.example'), /^VITE_APP_URL=https:\/\/staging\.checksops\.com$/m);
});
