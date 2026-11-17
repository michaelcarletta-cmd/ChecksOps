/**
 * Checks → Outstanding (owner 2026-11-17). A new "Outstanding" tab in Checks lists every claim with a balance above
 * $0 by the claim ledger's own figure: expected (the full RCV across all categories plus any expected supplement)
 * minus received (the checks on that claim). Each row also shows recoverable depreciation and the deductible, stays
 * listed after its check is disbursed, and opens the check file and its ledger. Excel and PDF from the same menu and
 * writers as the recipient report. Website only: no database or API change.
 *
 * src/lib/claimLedgerTotals.ts, src/lib/outstandingClaims.ts, src/lib/outstandingClaimsLoad.ts,
 * src/components/checks/OutstandingClaimsPanel.tsx, src/pages/CheckCommandCenter.tsx.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { claimLedgerExpected, claimLedgerRemaining, claimLedgerTotals } from '../../src/lib/claimLedgerTotals.ts';
import {
  OUTSTANDING_CLAIMS_COLUMNS,
  buildOutstandingClaimRows,
  filterOutstandingClaimRows,
  insuredNameForClaim,
  outstandingClaimsTable,
  outstandingTotals,
} from '../../src/lib/outstandingClaims.ts';
import {
  OUTSTANDING_CHECK_COLUMNS,
  OUTSTANDING_CLAIM_COLUMNS,
  OUTSTANDING_ID_CHUNK,
  loadOutstandingClaims,
} from '../../src/lib/outstandingClaimsLoad.ts';
import { RECIPIENT_REPORT_CURRENCY_FORMAT, REPORT_FIRST_ROW, reportFileName, reportTablePdf, reportTableXlsx } from '../../src/lib/payments/recipientReportExport.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const SETTLEMENT_A = {
  claim_id: 'claim-a',
  replacement_cost_value: 50000, recoverable_depreciation: 8000, non_recoverable_depreciation: 1000, deductible: 2500,
  other_structures_rcv: 5000, other_structures_recoverable_depreciation: 500, other_structures_deductible: 250,
  pwi_rcv: 3000, pwi_recoverable_depreciation: 300,
  personal_property_rcv: 10000, personal_property_recoverable_depreciation: 1200,
  ale_rcv: 2000, ale_recoverable_depreciation: 0,
  supplement_expected: '4000.50',
};
const CLAIMS = [
  { id: 'claim-a', claim_number: 'CLM-100', policyholder_name: 'THERESA JOHNSON', policyholder_address: '12 Oak St' },
  { id: 'claim-b', claim_number: 'CLM-200', policyholder_name: 'sam lee', policyholder_address: '9 Elm Ave' },
  { id: 'claim-c', claim_number: 'CLM-300', policyholder_name: 'Paid In Full', policyholder_address: null },
  { id: 'claim-d', claim_number: 'CLM-400', policyholder_name: 'No Settlement', policyholder_address: null },
];
const SETTLEMENTS = [
  SETTLEMENT_A,
  { claim_id: 'claim-b', replacement_cost_value: 20000, recoverable_depreciation: 3000, deductible: 1000 },
  { claim_id: 'claim-c', replacement_cost_value: 15000, deductible: 500 },
];
const CHECKS = [
  { id: 'chk-a1', claim_id: 'claim-a', amount: 30000, check_number: '1001', carrier_name: 'Acme Mutual', status: 'deposited', check_stage: 'funds_released', created_at: '2026-10-01T00:00:00Z' },
  { id: 'chk-a2', claim_id: 'claim-a', amount: '12000.25', check_number: '1002', carrier_name: 'Acme Mutual', status: 'needs_review', check_stage: 'review', created_at: '2026-11-01T00:00:00Z' },
  { id: 'chk-b1', claim_id: 'claim-b', amount: 19999.99, check_number: '2001', carrier_name: 'Beta Ins', status: 'deposited', check_stage: 'funds_released', created_at: '2026-09-01T00:00:00Z' },
  { id: 'chk-c1', claim_id: 'claim-c', amount: 15000, check_number: '3001', carrier_name: 'Gamma', status: 'deposited', check_stage: 'deposited', created_at: '2026-09-02T00:00:00Z' },
  { id: 'chk-d1', claim_id: 'claim-d', amount: 700, check_number: '4001', carrier_name: 'Delta', status: 'needs_review', check_stage: 'review', created_at: '2026-09-03T00:00:00Z' },
  { id: 'chk-x', claim_id: null, amount: 999, check_number: '9001', carrier_name: 'Nobody', created_at: '2026-09-04T00:00:00Z' },
];

test('the ledger figure: expected is the full RCV across all categories plus the expected supplement; deductible and depreciation do not reduce it', () => {
  const expected = claimLedgerExpected(SETTLEMENT_A);
  assert.deepEqual(expected, { totalRcv: 70000, totalRecDep: 10000, totalDeductible: 2750, totalExpected: 74000.5 });
  assert.deepEqual(claimLedgerExpected(null), { totalRcv: 0, totalRecDep: 0, totalDeductible: 0, totalExpected: 0 });
  assert.equal(claimLedgerRemaining(100, 40), 60);
  // Never below $0: an overpaid claim has nothing outstanding.
  assert.equal(claimLedgerRemaining(100, 140), 0);
  const totals = claimLedgerTotals(SETTLEMENT_A, CHECKS.filter((c) => c.claim_id === 'claim-a'));
  assert.equal(totals.totalReceived, 42000.25);
  assert.equal(totals.remaining, 74000.5 - 42000.25);
});

test('the Claim Ledger card takes its totals from the same functions (one figure in both places)', () => {
  const card = read('src/components/payments/ClaimLedgerCard.tsx');
  assert.match(card, /import \{ claimLedgerExpected, claimLedgerRemaining \} from "@\/lib\/claimLedgerTotals";/);
  assert.match(card, /const \{ totalRecDep, totalRcv, totalDeductible, totalExpected \} = claimLedgerExpected\(s\);/);
  assert.match(card, /const totalReceived = fundsReceivedFromScopedIntakeRows\(siblingChecks\);/);
  assert.match(card, /const remaining = claimLedgerRemaining\(totalExpected, totalReceived\);/);
  // No second copy of the sums in the card.
  assert.doesNotMatch(card, /const totalExpected = totalRcv \+/);
  assert.doesNotMatch(card, /Math\.max\(0, totalExpected - totalReceived\)/);
  const lib = read('src/lib/outstandingClaims.ts');
  assert.match(lib, /claimLedgerTotals\(settlements\.get\(claimId\), checks\)/);
});

test('every claim with a balance above $0 is listed, largest first, whatever its checks\' status; $0 and unsettled claims are not', () => {
  const rows = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: CHECKS });
  assert.deepEqual(rows.map((r) => r.claimId), ['claim-a', 'claim-b']);
  const [a, b] = rows;
  assert.deepEqual(a, {
    claimId: 'claim-a', claimNumber: 'CLM-100', policyholderName: 'THERESA JOHNSON', policyholderAddress: '12 Oak St',
    expected: 74000.5, received: 42000.25, outstanding: 32000.25, recoverableDepreciation: 10000, deductible: 2750,
    checkCount: 2,
    // A row opens the claim's most recent check.
    openCheckId: 'chk-a2', openCheckNumber: '1002', carrierName: 'Acme Mutual',
  });
  // One cent outstanding still lists; its only check is already disbursed (funds_released).
  assert.equal(Math.round(b.outstanding * 100), 1);
  assert.equal(b.openCheckId, 'chk-b1');
  assert.equal(b.recoverableDepreciation, 3000);
  assert.equal(b.deductible, 1000);
  // Paid in full (claim-c), no settlement entered (claim-d: expects $0) and a check with no claim are not listed.
  assert.equal(rows.some((r) => ['claim-c', 'claim-d'].includes(r.claimId)), false);
  // A repeated check row counts once (offset paging can repeat a row).
  const again = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: [...CHECKS, CHECKS[0]] });
  assert.deepEqual(again, rows);
  // A further check that brings the balance to $0 removes the claim; status never matters.
  const paid = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: [...CHECKS, { id: 'chk-b2', claim_id: 'claim-b', amount: 0.01, created_at: '2026-11-02T00:00:00Z' }] });
  assert.deepEqual(paid.map((r) => r.claimId), ['claim-a']);
  for (const status of ['deposited', 'voided', 'returned', 'needs_review']) {
    const same = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: CHECKS.map((c) => ({ ...c, status, check_stage: status })) });
    assert.deepEqual(same.map((r) => [r.claimId, r.outstanding]), rows.map((r) => [r.claimId, r.outstanding]), status);
  }
  // A claim row that could not be read still lists, without a number or name.
  const bare = buildOutstandingClaimRows({ claims: [], settlements: SETTLEMENTS, checks: CHECKS });
  assert.deepEqual(bare.map((r) => [r.claimId, r.claimNumber, r.policyholderName]), [['claim-a', null, null], ['claim-b', null, null]]);
  assert.deepEqual(buildOutstandingClaimRows({ claims: [], settlements: [], checks: [] }), []);
});

test('search and totals work on the rows as shown', () => {
  const rows = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: CHECKS });
  assert.equal(filterOutstandingClaimRows(rows, '  ').length, 2);
  assert.deepEqual(filterOutstandingClaimRows(rows, 'theresa').map((r) => r.claimId), ['claim-a']);
  assert.deepEqual(filterOutstandingClaimRows(rows, 'clm-200').map((r) => r.claimId), ['claim-b']);
  assert.deepEqual(filterOutstandingClaimRows(rows, 'elm ave').map((r) => r.claimId), ['claim-b']);
  assert.deepEqual(filterOutstandingClaimRows(rows, 'acme').map((r) => r.claimId), ['claim-a']);
  assert.deepEqual(filterOutstandingClaimRows(rows, '1002').map((r) => r.claimId), ['claim-a']);
  assert.deepEqual(filterOutstandingClaimRows(rows, 'zzz'), []);
  assert.deepEqual(outstandingTotals(rows), { count: 2, expected: 94000.5, received: 62000.24, outstanding: 32000.26, recoverableDepreciation: 13000, deductible: 3750 });
  assert.deepEqual(outstandingTotals([]), { count: 0, expected: 0, received: 0, outstanding: 0, recoverableDepreciation: 0, deductible: 0 });
});

test('Excel and PDF: the list as shown with a grand total, through the recipient report\'s writers', async () => {
  const rows = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: CHECKS });
  const table = outstandingClaimsTable({ rows, search: ' theresa ', companyName: 'Freedom Adjusting', asOfLabel: 'As of 11/17/2026', displayName: (v) => v.toLowerCase() });
  assert.equal(table.sheetName, 'Outstanding');
  assert.equal(table.title, 'Freedom Adjusting – Outstanding Claims');
  assert.equal(table.subtitle, 'Claims with a balance above $0 – matching "theresa" – As of 11/17/2026');
  assert.deepEqual(table.columns.map((c) => c.label), ['Claim #', 'Policyholder', 'Checks', 'Expected', 'Received', 'Recoverable Dep.', 'Deductible', 'Outstanding']);
  assert.equal(table.columns, OUTSTANDING_CLAIMS_COLUMNS);
  assert.deepEqual(table.columns.filter((c) => c.money).map((c) => c.label), ['Expected', 'Received', 'Recoverable Dep.', 'Deductible', 'Outstanding']);
  assert.deepEqual(table.rows[0], ['CLM-100', 'theresa johnson', 2, 74000.5, 42000.25, 10000, 2750, 32000.25]);
  assert.deepEqual(table.totals, [['Total (2 claims)', '', '', 94000.5, 62000.24, 13000, 3750, 32000.26]]);
  assert.match(table.note, /expected \(full RCV across all categories plus any expected supplement\) minus the checks received/);
  for (const row of [...table.rows, ...table.totals]) assert.equal(row.length, table.columns.length);
  assert.equal(outstandingClaimsTable({ rows: rows.slice(0, 1), asOfLabel: 'As of today' }).totals[0][0], 'Total (1 claim)');
  assert.equal(outstandingClaimsTable({ rows: [], asOfLabel: 'As of today' }).subtitle, 'Claims with a balance above $0 – As of today');

  // Excel: amounts are numbers in the currency format; the total row follows the rows.
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await reportTableXlsx(table));
  const sheet = book.getWorksheet('Outstanding');
  const first = sheet.getRow(REPORT_FIRST_ROW);
  assert.equal(first.getCell(1).value, 'CLM-100');
  assert.equal(first.getCell(8).value, 32000.25);
  assert.equal(first.getCell(8).numFmt, RECIPIENT_REPORT_CURRENCY_FORMAT);
  const total = sheet.getRow(REPORT_FIRST_ROW + table.rows.length);
  assert.equal(total.getCell(1).value, 'Total (2 claims)');
  assert.equal(total.getCell(8).value, 32000.26);
  // PDF: a real PDF file.
  const pdf = reportTablePdf(table);
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString('latin1'), '%PDF-');
  assert.equal(reportFileName(['outstanding-claims', '2026-11-17'], 'xlsx'), 'outstanding-claims-2026-11-17.xlsx');
});

/** A fake query builder that records each read and answers from in-memory tables. */
const fakeClient = (tables, { pageCap = 500, failOn = null } = {}) => {
  const reads = [];
  return {
    reads,
    from(table) {
      const q = { table, filters: [], orders: [] };
      const api = {
        select(columns, opts) { q.columns = columns; q.opts = opts ?? null; return api; },
        eq(col, val) { q.filters.push(['eq', col, val]); return api; },
        not(col, op, val) { q.filters.push(['not', col, op, val]); return api; },
        in(col, vals) { q.filters.push(['in', col, vals]); return api; },
        order(col, o) { q.orders.push([col, o?.ascending ?? true]); return api; },
        range(from, to) { q.range = [from, to]; return api; },
        then(resolve, reject) {
          reads.push(q);
          if (failOn === table) return Promise.resolve({ data: null, error: new Error(`${table} read failed`) }).then(resolve, reject);
          let rows = tables[table] ?? [];
          for (const f of q.filters) {
            if (f[0] === 'eq') rows = rows.filter((r) => r[f[1]] === f[2]);
            if (f[0] === 'not') rows = rows.filter((r) => r[f[1]] !== null && r[f[1]] !== undefined);
            if (f[0] === 'in') rows = rows.filter((r) => f[2].includes(r[f[1]]));
          }
          const count = rows.length;
          if (q.range) rows = rows.slice(q.range[0], Math.min(q.range[1] + 1, q.range[0] + pageCap));
          return Promise.resolve({ data: rows, error: null, count }).then(resolve, reject);
        },
      };
      return api;
    },
  };
};

test('the loader reads only this company\'s claim-linked checks, then those claims and settlements; nothing is written', async () => {
  const TENANT = 'tenant-1';
  const tables = {
    check_intake_items: [
      ...CHECKS.map((c) => ({ ...c, tenant_id: TENANT })),
      // Another company's check on the same claim id is not read.
      { id: 'chk-other', tenant_id: 'tenant-2', claim_id: 'claim-a', amount: 50000, created_at: '2026-11-05T00:00:00Z' },
    ],
    claims: CLAIMS,
    claim_settlements: SETTLEMENTS,
  };
  const client = fakeClient(tables);
  const out = await loadOutstandingClaims(client, TENANT);
  assert.deepEqual(out.rows, buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: CHECKS }));
  assert.equal(out.incomplete, false);
  assert.equal(out.checkCount, 5);
  assert.equal(out.claimCount, 4);
  const [checksRead, ...rest] = client.reads;
  assert.equal(checksRead.table, 'check_intake_items');
  assert.equal(checksRead.columns, OUTSTANDING_CHECK_COLUMNS);
  assert.deepEqual(checksRead.opts, { count: 'exact' });
  assert.deepEqual(checksRead.filters, [['eq', 'tenant_id', TENANT], ['not', 'claim_id', 'is', null]]);
  assert.deepEqual(checksRead.orders, [['created_at', false], ['id', true]]);
  assert.deepEqual(checksRead.range, [0, 499]);
  assert.deepEqual(rest.map((r) => r.table).sort(), ['claim_settlements', 'claims']);
  const claimsRead = rest.find((r) => r.table === 'claims');
  assert.equal(claimsRead.columns, OUTSTANDING_CLAIM_COLUMNS);
  assert.deepEqual(claimsRead.filters, [['in', 'id', ['claim-a', 'claim-b', 'claim-c', 'claim-d']]]);
  const settlementsRead = rest.find((r) => r.table === 'claim_settlements');
  assert.equal(settlementsRead.columns, '*');
  assert.deepEqual(settlementsRead.filters, [['in', 'claim_id', ['claim-a', 'claim-b', 'claim-c', 'claim-d']]]);
  // The same columns the Claim Ledger card reads for a claim's checks, plus the claim id.
  for (const column of ['id', 'check_number', 'amount', 'carrier_name', 'issue_date', 'status', 'check_stage', 'created_at', 'claim_id']) {
    assert.ok(OUTSTANDING_CHECK_COLUMNS.split(', ').includes(column), column);
  }
  // Read-only source: the loader has no insert, update, delete, upsert or rpc.
  assert.doesNotMatch(read('src/lib/outstandingClaimsLoad.ts'), /\.(insert|update|delete|upsert|rpc)\(/);
  assert.doesNotMatch(read('src/lib/outstandingClaims.ts'), /\.(insert|update|delete|upsert|rpc)\(/);
});

test('the loader pages past 500 checks, chunks the claim ids, and reports an incomplete or failed read', async () => {
  const TENANT = 'tenant-1';
  const many = Array.from({ length: 1203 }, (_, i) => ({
    id: `chk-${String(i).padStart(4, '0')}`, tenant_id: TENANT, claim_id: `claim-${i % 120}`, amount: 10, created_at: '2026-10-01T00:00:00Z',
  }));
  const claims = Array.from({ length: 120 }, (_, i) => ({ id: `claim-${i}`, claim_number: `N-${i}` }));
  const settlements = claims.map((c) => ({ claim_id: c.id, replacement_cost_value: 1000 }));
  const client = fakeClient({ check_intake_items: many, claims, claim_settlements: settlements });
  const out = await loadOutstandingClaims(client, TENANT);
  assert.equal(out.checkCount, 1203);
  assert.equal(out.incomplete, false);
  assert.equal(out.rows.length, 120);
  assert.deepEqual(client.reads.filter((r) => r.table === 'check_intake_items').map((r) => r.range), [[0, 499], [500, 999], [1000, 1499]]);
  const chunkSizes = client.reads.filter((r) => r.table === 'claims').map((r) => r.filters[0][2].length);
  assert.deepEqual(chunkSizes, [OUTSTANDING_ID_CHUNK, OUTSTANDING_ID_CHUNK, 20]);
  // claim-0..2 have 11 checks ($110), the rest 10 ($100): balances from every page.
  assert.equal(out.rows.find((r) => r.claimId === 'claim-0').outstanding, 890);
  assert.equal(out.rows.find((r) => r.claimId === 'claim-119').outstanding, 900);

  await assert.rejects(loadOutstandingClaims(fakeClient({ check_intake_items: many }, { failOn: 'check_intake_items' }), TENANT), /check_intake_items read failed/);
  await assert.rejects(loadOutstandingClaims(fakeClient({ check_intake_items: many, claims }, { failOn: 'claim_settlements' }), TENANT), /claim_settlements read failed/);
});

test('Checks page: an Outstanding tile, its own panel beside the check file opened on the ledger, and the recipient report\'s export menu', () => {
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.match(page, /const OutstandingClaimsPanel = lazy\(\(\) => import\("@\/components\/checks\/OutstandingClaimsPanel"\)\);/);
  assert.match(page, /\{ key: "outstanding",\s+label: "Outstanding",\s+count: null as number \| null, icon: Scale \}/);
  // The tile sits with the money lanes, before Manager and Messages.
  assert.ok(page.indexOf('key: "fundsreceived", label: "Funds Received"') < page.indexOf('key: "outstanding"'));
  assert.ok(page.indexOf('key: "outstanding"') < page.indexOf('key: "manager", label: "Manager"'));
  const section = page.slice(page.indexOf('{activeTab === "outstanding" && ('), page.indexOf('{activeTab === "fundsreceived" && ('));
  assert.match(section, /<OutstandingClaimsPanel/);
  assert.match(section, /tenantId=\{tenantId\}/);
  assert.match(section, /searchQuery=\{searchQuery\}/);
  assert.match(section, /onOpenCheck=\{\(id\) => setSelectedCheck\(selectedCheck === id \? null : id\)\}/);
  // Tapping a claim opens the check file on its ledger (the Funds tab holds the Claim Ledger card).
  assert.match(section, /<CheckDetailPanel\s+key=\{selectedCheck\}\s+checkId=\{selectedCheck\}\s+initialTab="funds"/);
  assert.match(page, /const \[detailTab, setDetailTab\] = useState\(initialTab \?\? "overview"\);/);
  assert.match(page, /<TabsContent value="funds" className="p-4 mt-0 space-y-4">\s*\{\/\* Claim Ledger[^\n]*\n\s*<ClaimLedgerCard/);
  // The generic check-lane list does not render under it, and a search does not jump away from it.
  assert.match(page, /activeTab !== "fundsreceived" && activeTab !== "outstanding" && \(/);
  assert.match(page, /if \(activeTab === "outstanding"\) return;/);

  const panel = read('src/components/checks/OutstandingClaimsPanel.tsx');
  assert.match(panel, /import \{ ReportExportMenu, type ReportExportKind \} from "@\/components\/ledger\/ReportExportMenu";/);
  assert.match(panel, /<ReportExportMenu onExport=\{exportShown\}/);
  assert.match(panel, /await import\("@\/lib\/payments\/recipientReportExport"\)/);
  assert.match(panel, /queryFn: \(\) => loadOutstandingClaims\(supabase, tenantId!, \{ insuredNameFromPayeeLine: extractInsuredName \}\)/);
  for (const heading of ['Expected', 'Received', 'Recoverable Dep.', 'Deductible', 'Outstanding']) assert.ok(panel.includes(`>${heading}</TableHead>`), heading);
  // Rows are keyboard reachable.
  assert.match(panel, /role="button"\s+tabIndex=\{0\}/);
  assert.match(panel, /e\.key === "Enter" \|\| e\.key === " "/);
  // Website only: the panel writes nothing.
  assert.doesNotMatch(panel, /\.(insert|update|delete|upsert|rpc)\(/);
});

// Owner 2026-11-17, after the first production use: "It says no policy holder in outstanding tab. It should say at least
// one insured name. Also, public adjusters or attorneys will not be collecting deductibles only contractors. Add a button
// to toggle off deductibles or a way to waive deductibles being visible for certain users".
const fromPayeeLine = (line) => {
  const m = /^PAY TO THE ORDER OF (.+?)(?: AND | & |$)/i.exec(String(line ?? ''));
  return m ? m[1] : null;
};

test('a row names at least one insured: the claim\'s policyholder, else an insured payee of a check, else the payee line', () => {
  const claim = { id: 'c1', claim_number: 'N-1', policyholder_name: '  ' };
  const older = { id: 'k1', claim_id: 'c1', amount: 1, created_at: '2026-01-01T00:00:00Z', payee_line: 'PAY TO THE ORDER OF OLD NAME AND ACME BANK',
    check_payees: [{ payee_name: 'Acme Bank', payee_type: 'mortgage_company' }, { payee_name: 'Theresa Johnson', payee_type: 'insured' }] };
  const newer = { id: 'k2', claim_id: 'c1', amount: 1, created_at: '2026-02-01T00:00:00Z', payee_line: 'PAY TO THE ORDER OF PAT SMITH & ACME BANK', check_payees: [] };
  // The claim's own name wins.
  assert.equal(insuredNameForClaim({ ...claim, policyholder_name: 'Maria Garcia' }, [newer, older], fromPayeeLine), 'Maria Garcia');
  // No name on the claim: an insured payee of any of its checks, before any payee line.
  assert.equal(insuredNameForClaim(claim, [newer, older], fromPayeeLine), 'Theresa Johnson');
  // No insured payee: the newest check's payee line.
  assert.equal(insuredNameForClaim(claim, [newer, { ...older, check_payees: null }], fromPayeeLine), 'PAT SMITH');
  // A mortgage company payee is never used as the insured.
  assert.equal(insuredNameForClaim(claim, [{ ...older, check_payees: [{ payee_name: 'Acme Bank', payee_type: 'mortgage_company' }], payee_line: null }], fromPayeeLine), null);
  // Without a payee-line reader, or with nothing to read, there is no name.
  assert.equal(insuredNameForClaim(claim, [newer], undefined), null);
  assert.equal(insuredNameForClaim(null, [], fromPayeeLine), null);

  const rows = buildOutstandingClaimRows({
    claims: [claim],
    settlements: [{ claim_id: 'c1', replacement_cost_value: 1000, deductible: 250 }],
    checks: [older, newer],
    insuredNameFromPayeeLine: fromPayeeLine,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policyholderName, 'Theresa Johnson');
  // The name is searchable like a policyholder name.
  assert.deepEqual(filterOutstandingClaimRows(rows, 'theresa').map((r) => r.claimId), ['c1']);
  // The loader passes the reader through and asks for the payee line and payees.
  for (const column of ['payee_line', 'check_payees(payee_name, payee_type)']) assert.ok(OUTSTANDING_CHECK_COLUMNS.includes(column), column);
});

test('the loader uses the insured-name reader it is given', async () => {
  const client = fakeClient({
    check_intake_items: [{ id: 'k1', tenant_id: 't', claim_id: 'c1', amount: 10, created_at: '2026-02-01T00:00:00Z', payee_line: 'PAY TO THE ORDER OF PAT SMITH & ACME BANK' }],
    claims: [{ id: 'c1', claim_number: 'N-1', policyholder_name: null }],
    claim_settlements: [{ claim_id: 'c1', replacement_cost_value: 100 }],
  });
  assert.equal((await loadOutstandingClaims(client, 't', { insuredNameFromPayeeLine: fromPayeeLine })).rows[0].policyholderName, 'PAT SMITH');
  assert.equal((await loadOutstandingClaims(client, 't')).rows[0].policyholderName, null);
});

test('deductibles can be hidden: the export drops the column; the outstanding amount and the other columns do not change', () => {
  const rows = buildOutstandingClaimRows({ claims: CLAIMS, settlements: SETTLEMENTS, checks: CHECKS });
  const shown = outstandingClaimsTable({ rows, asOfLabel: 'As of today' });
  const hidden = outstandingClaimsTable({ rows, asOfLabel: 'As of today', showDeductible: false });
  assert.deepEqual(hidden.columns.map((c) => c.label), ['Claim #', 'Policyholder', 'Checks', 'Expected', 'Received', 'Recoverable Dep.', 'Outstanding']);
  assert.deepEqual(hidden.rows[0], ['CLM-100', 'THERESA JOHNSON', 2, 74000.5, 42000.25, 10000, 32000.25]);
  assert.deepEqual(hidden.totals, [['Total (2 claims)', '', '', 94000.5, 62000.24, 13000, 32000.26]]);
  for (const row of [...hidden.rows, ...hidden.totals]) assert.equal(row.length, hidden.columns.length);
  // Same figures as with the column shown, minus that one cell.
  assert.deepEqual(shown.rows[0].filter((_c, i) => i !== 6), hidden.rows[0]);
  assert.equal(shown.columns.length, 8);
  assert.equal(outstandingClaimsTable({ rows, asOfLabel: 'x', showDeductible: true }).columns.length, 8);
  // A claim with no insured name anywhere exports as "Unknown insured", never blank.
  const bare = buildOutstandingClaimRows({ claims: [], settlements: SETTLEMENTS, checks: CHECKS });
  assert.equal(outstandingClaimsTable({ rows: bare, asOfLabel: 'x' }).rows[0][1], 'Unknown insured');
});

test('panel: a per-user "Show deductible" switch, remembered in the browser, and "Unknown insured" instead of "No policyholder"', () => {
  const panel = read('src/components/checks/OutstandingClaimsPanel.tsx');
  assert.match(panel, /import \{ extractInsuredName \} from "@\/features\/check-command\/status";/);
  assert.match(panel, /const deductibleKey = `checksops\.outstanding\.showDeductible\.\$\{user\?\.id \?\? "anonymous"\}`;/);
  assert.match(panel, /window\.localStorage\.getItem\(deductibleKey\) !== "0"/);
  assert.match(panel, /window\.localStorage\.setItem\(deductibleKey, next \? "1" : "0"\)/);
  assert.match(panel, /<Switch id="outstanding-show-deductible" checked=\{showDeductible\} onCheckedChange=\{changeShowDeductible\} \/>/);
  assert.match(panel, /<Label htmlFor="outstanding-show-deductible"[^>]*>Show deductible<\/Label>/);
  // Header, row cell and total all follow the switch; so does the export.
  assert.equal((panel.match(/\{!compact && showDeductible && </g) || []).length, 3);
  assert.match(panel, /showDeductible \? ` · Ded\. \$\{money\(row\.deductible\)\}` : ""/);
  assert.match(panel, /displayName: displayCase,\s+showDeductible,/);
  assert.ok(panel.includes('"Unknown insured"'));
  assert.ok(!panel.includes('No policyholder'));
  // The Checks lanes read the insured name the same way (policyholder, insured payee, payee line).
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.match(page, /linked\?\.policyholder_name \|\| insuredPayee \|\| parsedInsured \|\| "Unknown insured"/);
});
