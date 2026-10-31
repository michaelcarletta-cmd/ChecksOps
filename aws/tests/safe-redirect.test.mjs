import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { safeRedirectPath, safeRelativePath } from '../../src/lib/safeRedirect.ts';

const ORIGIN = 'https://checksops.com';
const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('same-origin relative paths pass through unchanged', () => {
  for (const p of ['/login', '/acme/login', '/acme/checks?tab=open', '/acme/checks#top', '/']) {
    assert.equal(safeRelativePath(p), p);
    assert.equal(safeRedirectPath(p, ORIGIN), p);
  }
});

test('external, protocol-relative, backslash and scheme targets fall back to /login', () => {
  const bad = [
    'https://evil.example/',
    'http://evil.example/login',
    'HTTPS://evil.example',
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    '/\\/evil.example',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/javascript:alert(1)',
    'evil.example',
    'login',
    '',
    ' /login',
    'https://checksops.com.evil.example/login',
    'https://checksops.com@evil.example/login',
    'https://user:pw@checksops.com/login',
    'https://checksops.com:8443/login',
    'http://checksops.com/login',
    'https://checksops.com//evil.example',
    'https://acme.example/login',
  ];
  for (const value of bad) {
    assert.equal(safeRedirectPath(value, ORIGIN), '/login', JSON.stringify(value));
  }
  assert.equal(safeRedirectPath(null, ORIGIN), '/login');
  assert.equal(safeRedirectPath(undefined, ORIGIN), '/login');
});

test('control characters are rejected (browsers strip tab/CR/LF, turning "/\\t/x" into "//x")', () => {
  for (const value of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/login\u0000', '/\u007f/x', '/\u0085/x']) {
    assert.equal(safeRelativePath(value), null, JSON.stringify(value));
    assert.equal(safeRedirectPath(value, ORIGIN), '/login', JSON.stringify(value));
  }
});

test('an absolute URL on exactly the current origin is reduced to its path', () => {
  // The existing reset-link producers (AdminTenants resend, tenant-invite-user)
  // send https://checksops.com/<slug>/login.
  assert.equal(safeRedirectPath('https://checksops.com/acme/login', ORIGIN), '/acme/login');
  assert.equal(safeRedirectPath('https://checksops.com/acme/checks?x=1#h', ORIGIN), '/acme/checks?x=1#h');
  assert.equal(safeRedirectPath('https://staging.checksops.com/acme/login', 'https://staging.checksops.com'), '/acme/login');
  assert.equal(safeRedirectPath('https://staging.checksops.com/acme/login', ORIGIN), '/login');
});

test('the fallback is configurable', () => {
  assert.equal(safeRedirectPath('https://evil.example', ORIGIN, '/mortgage-ops/login'), '/mortgage-ops/login');
});

test('CheckOpsResetPassword routes ?next= through safeRedirectPath and never location.replace', () => {
  const src = read('src/pages/checkops/CheckOpsResetPassword.tsx');
  assert.match(src, /from "@\/lib\/safeRedirect"/);
  assert.match(src, /safeRedirectPath\(params\.get\("next"\), window\.location\.origin, "\/login"\)/);
  assert.doesNotMatch(src, /location\.replace\(/);
  assert.doesNotMatch(src, /\/\^https\?:/);
});
