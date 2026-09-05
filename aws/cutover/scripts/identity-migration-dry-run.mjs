#!/usr/bin/env node
/**
 * Identity import dry-run. Prints counts only (no emails in output).
 * Does not create Cognito users. --apply is refused.
 */
import { EXPECTED_EIGHT, NINTH_ID } from '../../identity/expected-mappings.mjs';
import { classifyNinthUuid, ninthExcludedFromInvite } from '../../identity/ninth-uuid.mjs';

const apply = process.argv.includes('--apply');

const report = {
  ok: !apply,
  mode: apply ? 'apply_refused' : 'dry_run',
  mappedEligible: EXPECTED_EIGHT.length,
  ninthUuid: NINTH_ID,
  ninth: classifyNinthUuid(),
  ninthExcludedFromInvite: ninthExcludedFromInvite(),
  refuseSubEqualsApplicationUserId: true,
  productionAuthSwitch: false,
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
