import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { LOGIN_MFA_ACTION as API_LOGIN_MFA_ACTION } from '../functions/api/login-mfa.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('the SPA and the API use the same login MFA step-up purpose', () => {
  assert.match(read('src/lib/awsMfa.ts'), new RegExp(`LOGIN_MFA_ACTION = "${API_LOGIN_MFA_ACTION.replace('.', '\\.')}"`));
});

test('two-factor calls use the Mortgage Desk session on Mortgage Desk pages and the default session elsewhere', () => {
  const src = read('src/lib/awsMfa.ts');
  assert.match(src, /startsWith\("\/mortgage-ops"\)\s*\?\s*AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY\s*:\s*AWS_STAGING_AUTH_SESSION_KEY/);
  assert.match(src, /const readSession = \(sessionKey = mfaSessionKey\(\)\)/);
});

test('status exposes whether this sign-in still owes the authenticator code', () => {
  const src = read('src/lib/awsMfa.ts');
  assert.match(src, /loginMfaRequired: payload\.loginMfa\?\.required === true/);
  assert.match(src, /loginMfaSatisfied: payload\.loginMfa\?\.satisfied === true/);
});

test('the app routes sit inside the login MFA gate, and Mortgage Desk has its own gate', () => {
  const app = read('src/App.tsx');
  assert.match(app, /<LoginMfaGate>\s*<AppRoutes \/>\s*<\/LoginMfaGate>/);
  assert.match(app, /<MortgageLoginMfaGate><MortgageOpsQueue \/><\/MortgageLoginMfaGate>/);
});

test('the gate shows no app content until the API answers, fails closed on an error, and offers sign-out', () => {
  const gate = read('src/components/auth/LoginMfaGate.tsx');
  assert.match(gate, /if \(!applies \|\| state === "passed"\) return <>\{children\}<\/>;/);
  assert.match(gate, /state === "idle" \|\| state === "checking"/);
  assert.match(gate, /catch \(err: unknown\) \{[\s\S]*setState\("required"\)/);
  assert.match(gate, /Sign out/);
  assert.match(gate, /isPublicTokenRoute\(pathname\)/);
});

test('first-time setup inside the sign-in check also records the sign-in step-up with the same code', () => {
  const dialog = read('src/components/auth/StepUpDialog.tsx');
  const enrollBranch = dialog.slice(dialog.indexOf('if (mode === "enroll")'), dialog.indexOf('} else {', dialog.indexOf('if (mode === "enroll")')));
  assert.match(enrollBranch, /request\?\.actionKey === LOGIN_MFA_ACTION/);
  assert.match(enrollBranch, /stepUpAwsTotp\(/);
});

test('the public security page no longer claims roles, SAML SSO or MFA only for admin and staff', () => {
  const page = read('src/pages/checkops/CheckOpsSecurity.tsx');
  for (const stale of ['required for admin and staff', 'SAML SSO', 'Role-based permissions', 'admin and staff lists', 'Least-privilege by default']) {
    assert.equal(page.includes(stale), false, stale);
  }
  assert.match(page, /Authenticator-app code required for every user after every sign-in/);
});
