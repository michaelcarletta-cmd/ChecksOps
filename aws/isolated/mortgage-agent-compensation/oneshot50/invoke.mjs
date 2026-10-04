#!/usr/bin/env node
/**
 * Inspect-only invoke helper. Apply is refused here on purpose.
 * Later execute authorization must use confirm + expected_ids_fingerprint.
 */
import { FUNCTION_NAME, FORBIDDEN_FUNCTIONS } from './constants.mjs';

const action = process.argv[2] || 'inspect';
if (FORBIDDEN_FUNCTIONS.includes(FUNCTION_NAME)) {
  throw new Error('refusing shared function invoke');
}
if (action !== 'inspect') {
  throw new Error('this helper is inspect-only; apply is a later authorization');
}
process.stdout.write(JSON.stringify({
  ok: false,
  code: 'NOT_DEPLOYED',
  message: 'macomp50 oneshot is prepared in-repo only. Do not create or invoke it until cleanup is authorized.',
  function_name: FUNCTION_NAME,
  action,
}, null, 2) + '\n');
process.exit(2);
