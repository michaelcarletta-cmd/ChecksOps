#!/usr/bin/env node
/**
 * S14 Deposit Payee Line Protection pre-deploy safeguard.
 *
 * Reuses the existing AWS API unit-test guardrail. Does not deploy, overlay,
 * call providers, or pin a production Lambda SHA.
 *
 * Usage:
 *   node scripts/aws-s14-deposit-payee-line-safeguard.mjs
 *   npm run test:s14-safeguard
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'S14 Deposit Payee Line Protection';

const S14_TESTS = [
  'aws/tests/s14-deposit-payee-line-safeguard.test.mjs',
  'aws/tests/check-deposited.test.mjs',
];

const CROSS_PROTECTION_TESTS = {
  S2: [
    'aws/tests/endorsement-material-invalidation.test.mjs',
    'aws/tests/s2-material-endorsement-invalidation-safeguard.test.mjs',
  ],
  S3: ['aws/tests/endorsement-material-invalidation.test.mjs'],
  S4: ['aws/tests/api-workflow.test.mjs', 'aws/tests/checkalt-endorsement-gate.test.mjs'],
  S5: [
    'aws/tests/api-write.test.mjs',
    'aws/tests/admin-set-check-claim.test.mjs',
    'aws/tests/s5-audited-claim-association-safeguard.test.mjs',
  ],
  S11: ['aws/tests/financial-remaining.test.mjs', 'aws/tests/api-financial.test.mjs'],
};

const runNodeTest = (files, name) => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', ...files],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  if (result.status !== 0) {
    console.error(`\n${LABEL}: FAIL — ${name}`);
    return false;
  }
  console.log(`${LABEL}: ${name} PASS`);
  return true;
};

const main = () => {
  console.log(`${LABEL}: running accepted-implementation suite`);
  const s14Ok = runNodeTest(S14_TESTS, 'S14 regression suite');
  const cross = [];
  for (const [item, files] of Object.entries(CROSS_PROTECTION_TESTS)) {
    const ok = runNodeTest(files, `${item} existing safeguard/regression`);
    cross.push({ item, ok });
  }
  const allCross = cross.every((row) => row.ok);
  if (!s14Ok || !allCross) {
    console.error(`\n${LABEL}: FAIL`);
    if (!s14Ok) console.error('  S14 suite failed');
    for (const row of cross.filter((item) => !item.ok)) {
      console.error(`  ${row.item} existing safeguard failed`);
    }
    return 1;
  }
  console.log(`\n${LABEL}: PASS`);
  console.log('S14 SAFEGUARD: PASS');
  console.log('Cross-protection: S2/S3/S4/S5/S11 PASS');
  return 0;
};

process.exitCode = main();
