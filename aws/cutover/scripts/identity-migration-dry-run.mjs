#!/usr/bin/env node
/**
 * Identity import dry-run. Prints counts only (no emails).
 * Does not create Cognito users. --apply is refused.
 */
import { EXPECTED_EIGHT, NINTH_ID } from '../../identity/expected-mappings.mjs';

const apply = process.argv.includes('--apply');
const collisions = EXPECTED_EIGHT.filter((row) => row.applicationUserId === row.cognitoSub);

const report = {
  ok: !apply && collisions.length === 0,
  mode: apply ? 'apply_refused' : 'dry_run',
  mappedEligibleCount: EXPECTED_EIGHT.length,
  ninthUuidPresent: Boolean(NINTH_ID),
  ninthExcludedFromInvite: true,
  subEqualsApplicationUserIdCount: collisions.length,
  refuseSubEqualsApplicationUserId: true,
  productionAuthSwitch: false,
  productionPoolMustNotBeStaging: 'us-east-1_vPmQ7cL1F',
};

if (apply) {
  console.error(JSON.stringify({
    ...report,
    error: 'refusing_identity_apply',
    message: 'This script is dry-run only. Do not create production Cognito users from this PR.',
  }, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
