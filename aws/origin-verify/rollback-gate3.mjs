#!/usr/bin/env node
/**
 * Rollback helpers for Gates 3A–3C. Never prints secrets.
 * Fastest observe/require rollback later: ORIGIN_VERIFY_REQUIRE=false or $default NONE.
 * This package never enables require-mode.
 */
import { requireGate, API_ID, DISTRIBUTION_ID, HEADER_NAME } from './lib.mjs';

const gate = String(process.env.CHECKSOPS_ROLLBACK_GATE || '');
if (!['3A', '3B', '3C'].includes(gate)) {
  console.error('Set CHECKSOPS_ROLLBACK_GATE to 3A, 3B, or 3C');
  process.exit(2);
}
requireGate('CHECKSOPS_APPLY_ROLLBACK');

const plan = {
  '3A': {
    action: 'Leave secret unused. Delete unattached authorizer object and unused Lambda if desired. Do not delete the secret automatically.',
  },
  '3B': {
    action: `Remove ${HEADER_NAME} from ${DISTRIBUTION_ID} origin ProductionPrepHttpApi. Wait Deployed. Do not print the old value.`,
  },
  '3C': {
    action: `Set ${API_ID} $default AuthorizationType=NONE. Leave OPTIONS /{proxy+} or delete it. Execute-api stays enabled.`,
  },
};

console.log(JSON.stringify({ gate, ...plan[gate], executeApiRemainsEnabled: true }));
process.exit(2);
