#!/usr/bin/env node
/**
 * Validate production identity mappings without switching authentication.
 * Never creates Cognito users. --apply is refused.
 * Prints counts and UUID match flags only (no emails).
 */
import { EXPECTED_EIGHT, NINTH_ID } from '../../identity/expected-mappings.mjs';
import { classifyNinthUuid, ninthExcludedFromInvite } from '../../identity/ninth-uuid.mjs';

const apply = process.argv.includes('--apply');
const collisions = EXPECTED_EIGHT.filter((row) => row.applicationUserId === row.cognitoSub);
const uniqueIds = new Set(EXPECTED_EIGHT.map((row) => row.applicationUserId));

const report = {
  ok: !apply && collisions.length === 0 && uniqueIds.size === 8 && ninthExcludedFromInvite(),
  mode: apply ? 'apply_refused' : 'dry_run',
  mappedEligibleCount: EXPECTED_EIGHT.length,
  uniqueApplicationUserIds: uniqueIds.size,
  ninth: classifyNinthUuid(),
  ninthExcludedFromInvite: ninthExcludedFromInvite(),
  subEqualsApplicationUserIdCount: collisions.length,
  refuseSubEqualsApplicationUserId: true,
  productionAuthSwitch: false,
  productionPoolMustNotBeStaging: 'us-east-1_vPmQ7cL1F',
  inviteNotPerformed: true,
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
