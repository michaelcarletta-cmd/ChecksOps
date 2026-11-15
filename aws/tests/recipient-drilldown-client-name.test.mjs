/**
 * Owner 2026-11-15: "For the recipient report how can we show the exact client name the payment was
 * for." then "build the client name". Each drill-down row shows the client (insured/homeowner) of the
 * check the payment was for, by the check file's rule (CheckCommandCenter: the linked claim's
 * policyholder_name, else the insured check_payees row, else extractInsuredName(payee_line)), and the
 * drill-down search matches client names, check numbers and claim numbers. Pure helpers in
 * src/lib/payments/recipientDrilldown.ts; the sheet is src/components/ledger/RecipientDrilldownSheet.tsx.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CHECK_CLIENT_COLUMNS,
  RECIPIENT_REPORT_SPLIT_SELECT,
  checkClaimNumber,
  checkClientName,
  drilldownTotals,
  filterByDirection,
  receivedTransactions,
  recipientTransactions,
  searchTransactions,
  sentTransactions,
} from '../../src/lib/payments/recipientDrilldown.ts';
import { payrollRecipientReportRows } from '../../src/lib/payments/payrollRows.ts';
import { sendRecipientReportRows } from '../../src/lib/payments/transferFinanceRows.ts';
import { handleDataQuery } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const PAYEE_LINE = 'JOHN SMITH & STATE FARM BANK';

test('client name rule: linked claim, else the insured payee, else the payee line, else null', () => {
  const payees = [{ payee_type: 'mortgage_company', payee_name: 'Wells Fargo Bank' }, { payee_type: 'insured', payee_name: 'Jane Roe' }];
  // 1. The linked claim's policyholder_name wins.
  assert.equal(checkClientName({ claims: { policyholder_name: 'Anissa Nassry' }, check_payees: payees, payee_line: PAYEE_LINE }), 'Anissa Nassry');
  // An embed may return the claim as a one-row array; the RPC returns it flat.
  assert.equal(checkClientName({ claims: [{ policyholder_name: 'Anissa Nassry' }] }), 'Anissa Nassry');
  assert.equal(checkClientName({ policyholder_name: 'Deen Bandhu', payee_line: PAYEE_LINE }), 'Deen Bandhu');
  // 2. No linked claim name: the check_payees row with payee_type "insured" (not the first payee).
  assert.equal(checkClientName({ claims: null, check_payees: payees, payee_line: PAYEE_LINE }), 'Jane Roe');
  assert.equal(checkClientName({ claims: { policyholder_name: '   ' }, check_payees: payees }), 'Jane Roe', 'a blank name falls through');
  // 3. No insured payee: the insured parsed from the payee line.
  assert.equal(checkClientName({ check_payees: [payees[0]], payee_line: PAYEE_LINE }), 'JOHN SMITH');
  assert.equal(checkClientName({ payee_line: 'Pay to the order of FREEDOM ADJUSTMENT & MARY  JONES' }), 'MARY JONES');
  // None: null.
  assert.equal(checkClientName({}), null);
  assert.equal(checkClientName({ claims: null, check_payees: [], payee_line: null }), null);
  assert.equal(checkClientName(null), null);
  assert.equal(checkClientName(undefined), null);
  // The claim number: the linked claim's, else the detected one.
  assert.equal(checkClaimNumber({ claims: { claim_number: 'CL-1' }, detected_claim_number: 'D-1' }), 'CL-1');
  assert.equal(checkClaimNumber({ claims: null, detected_claim_number: 'D-1' }), 'D-1');
  assert.equal(checkClaimNumber({ claim_number: 'CL-9' }), 'CL-9');
  assert.equal(checkClaimNumber(null), null);
});

// ------------------------------------------------------------------------------- sources

// A split as RecipientReport normalizes it, the client read off its deposited check.
const split = (id, extra = {}) => ({
  id, date: '2026-11-08T10:00:00Z', name: 'Ann Roofing', type: 'contractor', acct4: '••••1234',
  amount: 500, status: 'settled', method: 'actum', reference: '271682',
  clientName: checkClientName({ claims: { policyholder_name: 'Anissa Nassry' } }), claimNumber: '38-99V2-97X', ...extra,
});

const leg = (id, extra = {}) => ({
  id, check_id: 'chk-1', leg_role: 'send_wallet', status: 'completed', amount_cents: 30000,
  created_at: '2026-11-06T19:06:01Z', submitted_at: '2026-11-06T19:06:02Z', completed_at: '2026-11-06T20:00:00Z',
  destination_tenant_id: null,
  provider_metadata: { request_hash: `h-${id}`, recipient_index: 0, recipient_kind: 'stakeholder', recipient_name: 'Ann Roofing' },
  check: {
    check_number: '1001', carrier_name: 'State Farm', claim_id: null, detected_claim_number: 'D-77', payee_line: PAYEE_LINE,
    claims: null, check_payees: [{ payee_type: 'insured', payee_name: 'Jane Roe' }],
  },
  ...extra,
});

const incoming = (id, extra = {}) => ({
  id, amount_cents: 20000, status: 'completed', environment: 'production', leg_role: 'send_wallet',
  created_at: '2026-11-10T09:00:00Z', submitted_at: '2026-11-10T09:00:01Z', completed_at: '2026-11-10T12:00:00Z',
  check_id: 'chk-9', sender_tenant_id: 'c1-tenant', sender_name: 'Ann Roofing',
  check_number: '2002', carrier_name: 'Allstate', claim_number: 'CL-77', policyholder_name: 'Deen Bandhu', payee_line: 'DEEN BANDHU & FREEDOM ADJUSTMENT',
  ...extra,
});

test('sources: a split carries its deposited check\'s client and claim; the reference adds the claim', () => {
  const [t] = sentTransactions([split('s1')]);
  assert.deepEqual(
    { clientName: t.clientName, checkNumber: t.checkNumber, claimNumber: t.claimNumber, reference: t.reference },
    { clientName: 'Anissa Nassry', checkNumber: '271682', claimNumber: '38-99V2-97X', reference: 'Ck #271682 · Claim 38-99V2-97X' },
  );
  // A split whose check has no client or claim: nothing extra, the reference as before.
  const [bare] = sentTransactions([split('s2', { clientName: null, claimNumber: null, reference: '5550' })]);
  assert.deepEqual([bare.clientName, bare.claimNumber, bare.reference], [null, null, 'Ck #5550']);
});

test('sources: a send reads the client off the sent check (insured payee here), payroll shows none', () => {
  const legs = [leg('a')];
  const [send] = sentTransactions(sendRecipientReportRows(legs), legs);
  assert.equal(send.method, 'send');
  assert.deepEqual(
    { clientName: send.clientName, checkNumber: send.checkNumber, claimNumber: send.claimNumber, reference: send.reference },
    { clientName: 'Jane Roe', checkNumber: '1001', claimNumber: 'D-77', reference: 'Ck #1001 · Claim D-77' },
  );
  // The linked claim beats the payee; without a check there is no client.
  const linked = [leg('b', { check: { check_number: '1002', claims: { claim_number: 'CL-5', policyholder_name: 'Albert Aggrey' }, check_payees: [{ payee_type: 'insured', payee_name: 'Jane Roe' }] } })];
  assert.equal(sentTransactions(sendRecipientReportRows(linked), linked)[0].clientName, 'Albert Aggrey');
  const noCheck = [leg('c', { check_id: null, check: null })];
  assert.deepEqual(sentTransactions(sendRecipientReportRows(noCheck), noCheck).map((t) => [t.clientName, t.reference]), [[null, null]]);

  const payroll = sentTransactions(payrollRecipientReportRows([{
    id: 'run-1', status: 'completed', amount: 1200, created_at: '2026-11-05T08:00:00Z',
    stakeholder_accounts: { id: 'sa-1', nickname: 'Ann Roofing', account_type: 'contractor', chk_acct: '9999' },
  }]));
  assert.deepEqual(payroll.map((t) => [t.method, t.clientName, t.checkNumber, t.claimNumber]), [['payroll', null, null, null]]);
});

test('sources: a received payment reads the client get_tenant_incoming_transfers already returns', () => {
  const [r] = receivedTransactions([incoming('a')]);
  assert.deepEqual(
    { clientName: r.clientName, checkNumber: r.checkNumber, claimNumber: r.claimNumber, reference: r.reference },
    { clientName: 'Deen Bandhu', checkNumber: '2002', claimNumber: 'CL-77', reference: 'Ck #2002 · Claim CL-77' },
  );
  // No policyholder (claim not linked): the payee line.
  assert.equal(receivedTransactions([incoming('b', { policyholder_name: null })])[0].clientName, 'DEEN BANDHU');
  // The check not shared with this organization (the RPC returns no check columns): no client.
  const hidden = receivedTransactions([incoming('c', { check_number: null, carrier_name: null, claim_number: null, policyholder_name: null, payee_line: null })]);
  assert.deepEqual([hidden[0].clientName, hidden[0].reference], [null, null]);
});

// ------------------------------------------------------------------------------- search

const ALL = () => recipientTransactions('Ann Roofing', [
  ...sentTransactions([
    split('s1'),
    split('s2', { clientName: 'Mary Jones', claimNumber: 'CL-200', reference: '3003', amount: 250.1, date: '2026-11-09T10:00:00Z' }),
    split('s3', { status: 'returned', amount: 75, date: '2026-11-07T10:00:00Z' }),
  ]),
  ...receivedTransactions([incoming('a'), incoming('r', { status: 'returned', created_at: '2026-11-11T09:00:00Z', completed_at: null, submitted_at: null })]),
]);

test('search: client name, check number and claim number; case-insensitive; empty keeps every row', () => {
  const all = ALL();
  assert.equal(all.length, 5);
  assert.equal(searchTransactions(all, ''), all);
  assert.equal(searchTransactions(all, '   '), all);
  assert.equal(searchTransactions(all, null), all);
  const ids = (q) => searchTransactions(all, q).map((t) => t.id);
  assert.deepEqual(ids('anissa'), ['s1', 's3']);
  assert.deepEqual(ids('MARY JONES'), ['s2']);
  assert.deepEqual(ids('mary  jones'), ['s2'], 'repeated spaces');
  assert.equal(searchTransactions(all, 'deen').length, 2);
  // Check numbers, with or without "#" / "Ck".
  assert.deepEqual(ids('3003'), ['s2']);
  assert.deepEqual(ids('#3003'), ['s2']);
  assert.deepEqual(ids('Ck #3003'), ['s2']);
  assert.equal(searchTransactions(all, '2002').length, 2);
  // Claim numbers, with or without "Claim".
  assert.deepEqual(ids('cl-200'), ['s2']);
  assert.deepEqual(ids('Claim 38-99V2'), ['s1', 's3']);
  // The recipient's own name, the amount and the method are not searched.
  assert.deepEqual(ids('Ann Roofing'), []);
  assert.deepEqual(ids('nobody'), []);
});

test('search: works with the All/Sent/Received filter, and the totals count the visible rows', () => {
  const all = ALL();
  const anissa = searchTransactions(all, 'anissa');
  const t = drilldownTotals(anissa);
  // s1 settled $500 counted, s3 returned listed not counted.
  assert.deepEqual(t.sent, { total: 500, count: 1 });
  assert.deepEqual(t.received, { total: 0, count: 0 });
  assert.equal(t.net, -500);
  assert.deepEqual(t.rows, { all: 2, sent: 2, received: 0 });
  assert.deepEqual(filterByDirection(anissa, 'received'), []);
  assert.equal(filterByDirection(anissa, 'sent').length, 2);

  const deen = searchTransactions(all, 'deen');
  assert.deepEqual(drilldownTotals(deen).received, { total: 200, count: 1 }, 'the returned one is listed, not totaled');
  assert.deepEqual(drilldownTotals(deen).rows, { all: 2, sent: 0, received: 2 });
  assert.equal(drilldownTotals(deen).net, 200);
  // Without a search the totals are the whole recipient's, as before.
  assert.deepEqual(drilldownTotals(all).sent, { total: 750.1, count: 2 });
});

// ------------------------------------------------------------------------------- reads

test('reads: the split embed and the send check lookup add the client columns, nothing else changes', () => {
  assert.equal(
    CHECK_CLIENT_COLUMNS,
    'claim_id, detected_claim_number, payee_line, claims:claim_id (claim_number, policyholder_name), check_payees (payee_type, payee_name)',
  );
  const select = RECIPIENT_REPORT_SPLIT_SELECT.replace(/\s+/g, ' ').trim();
  assert.equal(
    select,
    'id, amount, status, method, recipient_name, recipient_type, created_at, settled_at, external_check_number, '
      + 'stakeholder_accounts (id, nickname, custname, account_type, chk_acct), '
      + 'disbursement_batches (check_intake_items:check_intake_item_id (check_number, claim_id, detected_claim_number, payee_line, '
      + 'claims:claim_id (claim_number, policyholder_name), check_payees (payee_type, payee_name)))',
  );

  const report = read('src/components/ledger/RecipientReport.tsx');
  assert.match(report, /\.from\("disbursement_splits"\)\s+\.select\(RECIPIENT_REPORT_SPLIT_SELECT\)/);
  assert.match(report, /clientName: checkClientName\(r\.disbursement_batches\?\.check_intake_items\),/);
  assert.match(report, /claimNumber: checkClaimNumber\(r\.disbursement_batches\?\.check_intake_items\),/);
  // No new query in the report: the same three reads plus the hooks.
  assert.equal((report.match(/\.from\(/g) ?? []).length, 2, 'the split read and the rename');

  const hook = read('src/hooks/useTransferFinance.ts');
  assert.match(hook, /export const SEND_CHECK_COLUMNS = `id, check_number, carrier_name, \$\{CHECK_CLIENT_COLUMNS\}`;/);
  assert.match(hook, /\.from\("check_intake_items"\)\s+\.select\(SEND_CHECK_COLUMNS as string\)\s+\.eq\("tenant_id", tenantId!\)\s+\.in\("id", ids\)/);
  // Received: no SQL change; the drill-down reads the columns SQL 144 already returns.
  const sql144 = read('aws/workflows/sql/144_tenant_incoming_transfers.sql');
  assert.match(sql144, /payee_line text,/);
  assert.match(sql144, /policyholder_name text/);
});

// The AWS data API resolves both reads: nested belongs-to claims and has-many check_payees under the
// aliased check embed (the same path the funds-released select takes in api-auth-data.test.mjs).
const IDS = {
  tenant: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
  split: '11111111-1111-4111-8111-111111111111',
  batch: '33333333-3333-4333-8333-333333333333',
  item: '44444444-4444-4444-8444-444444444444',
  claim: '55555555-5555-4555-8555-555555555555',
};
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const event = (body) => ({
  rawPath: '/data/query',
  headers: { authorization: 'Bearer test-id-token' },
  queryStringParameters: {},
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/query' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});
const fakeClient = () => {
  const client = {
    queries: [],
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      client.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91', cognito_sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', status: 'active' }] };
      }
      if (sql.includes('count(*)')) return { rows: [{ n: 1 }] };
      if (sql.includes('FROM public.disbursement_splits')) {
        return { rows: [{ id: IDS.split, amount: 100, status: 'settled', method: 'ach', recipient_name: 'Ann Roofing', batch_id: IDS.batch, stakeholder_account_id: null }] };
      }
      if (sql.includes('FROM public.disbursement_batches')) return { rows: [{ id: IDS.batch, check_intake_item_id: IDS.item }] };
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: [{ id: IDS.item, check_number: '271682', carrier_name: 'State Farm', claim_id: IDS.claim, detected_claim_number: 'D-1', payee_line: PAYEE_LINE }] };
      }
      if (sql.includes('FROM public.claims')) return { rows: [{ id: IDS.claim, claim_number: '38-99V2-97X', policyholder_name: 'Anissa Nassry' }] };
      if (sql.includes('FROM public.check_payees')) return { rows: [{ check_id: IDS.item, payee_type: 'insured', payee_name: 'Jane Roe' }] };
      return { rows: [] };
    },
  };
  return client;
};
const deps = (client) => ({
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});

test('data API: the recipient report split select resolves the check, its claim and its payees', async () => {
  const client = fakeClient();
  const result = await handleDataQuery(event({
    table: 'disbursement_splits',
    select: RECIPIENT_REPORT_SPLIT_SELECT,
    filters: [{ column: 'tenant_id', op: 'eq', value: IDS.tenant }, { column: 'status', op: 'neq', value: 'pending' }],
    order: { column: 'created_at', ascending: false },
  }), deps(client));
  assert.equal(result.statusCode, 200, JSON.stringify(result.error ?? null));
  const check = result.data[0].disbursement_batches.check_intake_items;
  assert.equal(check.check_number, '271682');
  assert.equal(check.claims.policyholder_name, 'Anissa Nassry');
  assert.deepEqual(check.check_payees.map((p) => [p.payee_type, p.payee_name]), [['insured', 'Jane Roe']]);
  assert.equal(checkClientName(check), 'Anissa Nassry');
  assert.equal(checkClaimNumber(check), '38-99V2-97X');
  const sql = (table) => client.queries.map((q) => String(q.sql)).find((s) => s.includes(`FROM public.${table}`) && !s.includes('count(*)'));
  assert.match(sql('check_intake_items'), /claim_id/);
  assert.match(sql('check_payees'), /WHERE check_id = ANY/);
});

test('data API: the send check lookup resolves the same client columns', async () => {
  const client = fakeClient();
  const result = await handleDataQuery(event({
    table: 'check_intake_items',
    select: `id, check_number, carrier_name, ${CHECK_CLIENT_COLUMNS}`,
    filters: [{ column: 'tenant_id', op: 'eq', value: IDS.tenant }, { column: 'id', op: 'in', value: [IDS.item] }],
  }), deps(client));
  assert.equal(result.statusCode, 200, JSON.stringify(result.error ?? null));
  assert.equal(result.data[0].claims.claim_number, '38-99V2-97X');
  assert.equal(result.data[0].check_payees[0].payee_name, 'Jane Roe');
  assert.equal(checkClientName(result.data[0]), 'Anissa Nassry');
});

// ------------------------------------------------------------------------------- UI

test('sheet: a "For:" client line on each row and a search by client, check or claim number', () => {
  const sheet = read('src/components/ledger/RecipientDrilldownSheet.tsx');
  assert.match(sheet, /import \{ displayCase \} from "@\/lib\/displayCase";/);
  assert.match(sheet, /\{t\.clientName && \(/);
  assert.match(sheet, /<span className="text-muted-foreground">For:<\/span> <span className="font-medium">\{displayCase\(t\.clientName\)\}<\/span>/);
  assert.match(sheet, /placeholder="Search client, check # or claim #"/);
  assert.match(sheet, /aria-label="Search transactions by client name, check number or claim number"/);
  assert.match(sheet, /const matching = useMemo\(\(\) => searchTransactions\(mine, query\), \[mine, query\]\);/);
  assert.match(sheet, /const totals = useMemo\(\(\) => drilldownTotals\(matching\), \[matching\]\);/);
  assert.match(sheet, /const shown = useMemo\(\(\) => filterByDirection\(matching, filter\), \[matching, filter\]\);/);
  // Opening another recipient clears the search and the filter.
  assert.match(sheet, /useEffect\(\(\) => \{ if \(name\) \{ setFilter\("all"\); setQuery\(""\); \} \}, \[name\]\);/);
  assert.match(sheet, /aria-label="Clear search"/);
  assert.doesNotMatch(sheet, /supabase|useQuery/);
});
