import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CHECK_QUEUE_DEPENDENT_ROOTS,
  CHECK_QUEUE_QUERY_ROOTS,
  isQueueListInvalidation,
  refreshCheckQueues,
  refreshQueueDependents,
  shouldRefreshOnFocus,
} from '../../src/lib/checkQueueRefresh.ts';
import {
  loginPathWithNext,
  postLoginPath,
  safeLoginReturnPath,
} from '../../src/lib/loginReturnPath.ts';

const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const recorder = () => {
  const calls = [];
  return {
    calls,
    invalidateQueries(filters, options) {
      calls.push({ ...filters, options });
      return Promise.resolve();
    },
  };
};

// ---------------------------------------------------------------- queue refresh

test('queue refresh covers the lane lists and the lane badge totals', () => {
  for (const root of [
    'check-intake-items',
    'check-intake-items-deposited',
    'check-stage-totals',
    'check-review-queue',
    'check-dashboard-counts',
    'loss-draft-counts',
    'returned-checks-count',
    'shared-with-me-checks',
  ]) {
    assert.ok(CHECK_QUEUE_QUERY_ROOTS.includes(root), `${root} is refreshed`);
  }
});

test('refreshCheckQueues invalidates every root as an active refetch by default', async () => {
  const qc = recorder();
  await refreshCheckQueues(qc);
  assert.deepEqual(
    qc.calls.map((c) => c.queryKey),
    CHECK_QUEUE_QUERY_ROOTS.map((root) => [root]),
  );
  assert.ok(qc.calls.every((c) => c.refetchType === 'active'));
  // Joins an in-flight fetch instead of cancelling and restarting it.
  assert.ok(qc.calls.every((c) => c.options?.cancelRefetch === false));
});

test('a list-only invalidation also refreshes the lane counts', async () => {
  const listKey = { queryKey: ['check-intake-items', 't1'] };
  assert.equal(isQueueListInvalidation({ type: 'updated', action: { type: 'invalidate' }, query: listKey }), true);
  assert.equal(isQueueListInvalidation({ type: 'updated', action: { type: 'success' }, query: listKey }), false);
  assert.equal(isQueueListInvalidation({ type: 'added', query: listKey }), false);
  assert.equal(
    isQueueListInvalidation({ type: 'updated', action: { type: 'invalidate' }, query: { queryKey: ['check-stage-totals', 't1'] } }),
    false,
    'dependent invalidations do not cascade again',
  );
  assert.equal(isQueueListInvalidation(null), false);

  assert.ok(!CHECK_QUEUE_DEPENDENT_ROOTS.includes('check-intake-items'));
  assert.ok(CHECK_QUEUE_DEPENDENT_ROOTS.includes('check-stage-totals'));
  const qc = recorder();
  await refreshQueueDependents(qc);
  assert.deepEqual(qc.calls.map((c) => c.queryKey[0]), CHECK_QUEUE_DEPENDENT_ROOTS);
});

test('refreshCheckQueues can refetch unmounted queries and one check detail', async () => {
  const qc = recorder();
  await refreshCheckQueues(qc, { includeInactive: true, checkId: 'chk-1' });
  const queue = qc.calls.slice(0, CHECK_QUEUE_QUERY_ROOTS.length);
  assert.ok(queue.every((c) => c.refetchType === 'all'));
  assert.deepEqual(qc.calls.at(-1).queryKey, ['check-detail', 'chk-1']);
  assert.equal(qc.calls.length, CHECK_QUEUE_QUERY_ROOTS.length + 1);
});

test('focus refresh is throttled', () => {
  assert.equal(shouldRefreshOnFocus(0, 1_000), true);
  assert.equal(shouldRefreshOnFocus(100_000, 105_000), false);
  assert.equal(shouldRefreshOnFocus(100_000, 110_000), true);
  assert.equal(shouldRefreshOnFocus(100_000, 101_000, 500), true);
});

// ---------------------------------------------------------------- login return path

test('return path stays inside the tenant and never points at login', () => {
  assert.equal(safeLoginReturnPath('/acme/payments?tab=invoices', '/acme'), '/acme/payments?tab=invoices');
  assert.equal(safeLoginReturnPath('/acme/checks?tab=review', '/acme'), '/acme/checks?tab=review');
  assert.equal(safeLoginReturnPath('/wl/acme/settings?tab=users', '/wl/acme'), '/wl/acme/settings?tab=users');
  assert.equal(safeLoginReturnPath('/wallet-ops', ''), '/wallet-ops');
  assert.equal(safeLoginReturnPath('/acme/checks#x', '/acme'), '/acme/checks');

  for (const bad of [
    null,
    undefined,
    '',
    'https://evil.example/acme/checks',
    '//evil.example/acme/checks',
    '/\\evil.example',
    '/acme/login',
    '/acme/login?next=/acme/checks',
    '/acme',
    '/acme/',
    '/other/checks',
    '/acmex/checks',
    '/acme/../other/checks',
    'acme/checks',
  ]) {
    assert.equal(safeLoginReturnPath(bad, '/acme'), null, String(bad));
  }
  assert.equal(safeLoginReturnPath('/login', ''), null);
  assert.equal(safeLoginReturnPath('/', ''), null);
});

test('login redirect carries the current page and sign-in returns to it', () => {
  const login = loginPathWithNext('/acme', { pathname: '/acme/payments', search: '?tab=invoices' });
  assert.equal(login, '/acme/login?next=%2Facme%2Fpayments%3Ftab%3Dinvoices');
  assert.equal(postLoginPath('/acme', login.slice(login.indexOf('?'))), '/acme/payments?tab=invoices');

  // Custom domain: tenant routes at the root.
  const cd = loginPathWithNext('', { pathname: '/wallet-ops', search: '' });
  assert.equal(cd, '/login?next=%2Fwallet-ops');
  assert.equal(postLoginPath('', '?next=%2Fwallet-ops'), '/wallet-ops');

  // Nothing worth keeping, or an unsafe value: default to the Check Center.
  assert.equal(loginPathWithNext('/acme', { pathname: '/acme/login', search: '' }), '/acme/login');
  assert.equal(postLoginPath('/acme', ''), '/acme/checks');
  assert.equal(postLoginPath('/acme', '?next=https%3A%2F%2Fevil.example'), '/acme/checks');
  assert.equal(postLoginPath('', null), '/checks');
});

// ---------------------------------------------------------------- wiring

test('Command Center refresh polls on AWS builds (no realtime) and on tab focus', () => {
  const hook = read('src/features/check-command/useCheckCommandRealtime.ts');
  assert.match(hook, /refreshCheckQueues\(qc\)/);
  assert.match(hook, /useAwsPollingFallback\(!!tenantId, poll, 5_000\)/);
  assert.match(hook, /addEventListener\("focus", onFocus\)/);
  assert.match(hook, /addEventListener\("visibilitychange", onFocus\)/);
  assert.match(hook, /shouldRefreshOnFocus\(/);

  const polling = read('src/hooks/useAwsPollingFallback.ts');
  assert.match(polling, /isAwsStaging\(\) \|\| import\.meta\.env\.MODE === "aws"/);

  // The AWS adapter's realtime channel is a no-op: polling is the only live path there.
  const aws = read('src/integrations/aws/client.ts');
  assert.match(aws, /const channel = \(\) => \{\s+const noop = \{/);
});

test('every check upload path refreshes the queue and its counts', () => {
  // The Command Center upload dialog invalidates the list; the hook cascades
  // that to the counts (CheckCommandCenter.tsx itself is not changed here).
  const center = read('src/pages/CheckCommandCenter.tsx');
  const dialog = center.slice(center.indexOf('<CheckUploadForm'), center.indexOf('</DialogContent>', center.indexOf('<CheckUploadForm')));
  assert.match(dialog, /invalidateQueries\(\{ queryKey: \["check-intake-items"\] \}\)/);
  assert.match(center, /useCheckCommandRealtime\(tenantId\)/);
  const hook = read('src/features/check-command/useCheckCommandRealtime.ts');
  assert.match(hook, /getQueryCache\(\)\.subscribe/);
  assert.match(hook, /isQueueListInvalidation\(/);
  assert.match(hook, /refreshQueueDependents\(qc\)/);

  const cash = read('src/components/cash-jobs/CashJobCheckUpload.tsx');
  assert.match(cash, /refreshCheckQueues\(qc, \{ includeInactive: true \}\)/);

  const inbox = read('src/components/homeowner-ledger/HomeownerSubmittedChecksInbox.tsx');
  assert.match(inbox, /refreshCheckQueues\(qc, \{ checkId \}\)/);
  assert.match(inbox, /setInterval\(tick, INBOX_REFRESH_MS\)/);
  assert.match(inbox, /if \(!silent\) setLoading\(true\)/);
});

test('signed-out redirects keep the page and sign-in returns to it', () => {
  const app = read('src/pages/WhiteLabelApp.tsx');
  assert.match(app, /loginPathWithNext\(basePath, location\)/);
  assert.match(app, /postLoginPath\(basePath, location\.search\)/);

  const cd = read('src/components/white-label/CustomDomainWhiteLabelApp.tsx');
  assert.match(cd, /loginPathWithNext\("", location\)/);
  assert.match(cd, /postLoginPath\("", location\.search\)/);
  assert.match(cd, /path="\/wallet-ops"/);
  assert.match(cd, /<WhiteLabelCheckCenter basePath="" \/>/);

  const center = read('src/components/white-label/WhiteLabelCheckCenter.tsx');
  assert.match(center, /if \(basePath !== undefined\) return basePath;/);
  assert.match(center, /loginPathWithNext\(tenantBase \?\? "", location\)/);

  const login = read('src/components/white-label/WhiteLabelLogin.tsx');
  assert.match(login, /navigate\(postLoginPath\(basePath, location\.search\), \{ replace: true \}\)/);
});

test('Payments and Settings write the active tab to ?tab=', () => {
  const payments = read('src/pages/Payments.tsx');
  assert.match(payments, /setSearchParams\(\(prev\) => \{/);
  assert.match(payments, /if \(tab === "ledger"\) next\.delete\("tab"\);/);

  const settings = read('src/components/white-label/WhiteLabelSettings.tsx');
  assert.match(settings, /if \(tab === "profile"\) next\.delete\("tab"\);/);
});
