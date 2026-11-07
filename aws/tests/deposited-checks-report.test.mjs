import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import {
  buildDepositedCheckRows,
  depositedChecksSheetRows,
  depositedChecksTitle,
  depositedChecksTotal,
} from '../../src/lib/depositedChecksReport.ts';
import { DEPOSITED_CHECKS_CURRENCY_FORMAT, depositedChecksPdf, depositedChecksXlsx } from '../../src/lib/depositedChecksExport.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Noon UTC keeps the local deposit day the same in any US time zone.
const at = (day) => `${day}T12:00:00.000Z`;

const CHECKS = [
  { id: 'a', check_number: '1001', amount: 1500.5, deposited_at: at('2026-10-20'), claims: { claim_number: 'CLM-1', policyholder_name: 'Jane Smith' } },
  { id: 'b', check_number: '1002', amount: '250', deposited_at: at('2026-10-22'), detected_claim_number: 'OCR-9', check_payees: [{ payee_name: 'John Doe', payee_type: 'insured' }, { payee_name: 'Acme Mortgage LLC', payee_type: 'mortgage' }] },
  { id: 'c', check_number: '1003', amount: 99.99, deposited_at: at('2026-10-24'), case_id: 'case-1', freedom_claim_number: 'FR-7' },
  { id: 'd', check_number: '1004', amount: 10, deposited_at: null },
  { id: 'e', check_number: '1005', amount: 75, deposited_at: at('2026-10-24'), claims: [{ claim_number: null, policyholder_name: null }] },
];
const CASES = new Map([['case-1', 'Maria Lopez']]);

test('rows: insured name, deposit day, amount, check # and claim #; undeposited checks are left out', () => {
  const rows = buildDepositedCheckRows(CHECKS, CASES);
  assert.deepEqual(rows.map((r) => r.id), ['c', 'e', 'b', 'a']);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId.a, { id: 'a', insuredName: 'Jane Smith', depositedOn: '2026-10-20', amount: 1500.5, checkNumber: '1001', claimNumber: 'CLM-1' });
  // Insured payee beats the payee line; the number read from the check stands in for a linked claim.
  assert.equal(byId.b.insuredName, 'John Doe');
  assert.equal(byId.b.amount, 250);
  assert.equal(byId.b.claimNumber, 'OCR-9');
  // The case's insured name; the Freedom claim number as the last claim fallback.
  assert.equal(byId.c.insuredName, 'Maria Lopez');
  assert.equal(byId.c.claimNumber, 'FR-7');
  // Nothing known: blank, never "Unknown".
  assert.equal(byId.e.insuredName, '');
  assert.equal(byId.e.claimNumber, '');
  assert.equal(depositedChecksTotal(rows), 1925.49);
});

test('rows follow the Bank Deposits date rule: one date, a range, an end date alone', () => {
  const ids = (from, to) => buildDepositedCheckRows(CHECKS, CASES, from, to).map((r) => r.id);
  assert.deepEqual(ids('2026-10-24', ''), ['c', 'e']);
  assert.deepEqual(ids('2026-10-24', '2026-10-20'), ['c', 'e', 'b', 'a']);
  assert.deepEqual(ids('', '2026-10-22'), ['b', 'a']);
  assert.equal(depositedChecksTitle('', ''), 'Deposited Checks');
  assert.equal(depositedChecksTitle('2026-10-24', ''), 'Deposited Checks – 10/24/2026');
  assert.equal(depositedChecksTitle('2026-10-24', '2026-10-20'), 'Deposited Checks – 10/20/2026 to 10/24/2026');
  assert.equal(depositedChecksTitle('', '2026-10-22'), 'Deposited Checks through 10/22/2026');
});

test('Excel: the five owner columns, numeric amounts in currency format, a total row', async () => {
  const rows = buildDepositedCheckRows(CHECKS, CASES);
  assert.deepEqual(depositedChecksSheetRows(rows)[0], ['Insured Name', 'Date Deposited', 'Amount', 'Check #', 'Claim #']);
  const bytes = await depositedChecksXlsx(rows, 'Deposited Checks');
  // A real .xlsx file (a ZIP), read back with exceljs.
  assert.equal(Buffer.from(bytes.subarray(0, 2)).toString(), 'PK');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes));
  assert.equal(book.title, 'Deposited Checks');
  const sheet = book.getWorksheet('Deposited Checks');
  const row = (n) => sheet.getRow(n).values.slice(1);
  assert.deepEqual(row(1), ['Insured Name', 'Date Deposited', 'Amount', 'Check #', 'Claim #']);
  assert.deepEqual(row(5), ['Jane Smith', '10/20/2026', 1500.5, '1001', 'CLM-1']);
  // The empty cells of the total row are skipped (sparse), as in the old file.
  assert.deepEqual([1, 3, 4].map((c) => sheet.getRow(6).getCell(c).value), ['Total', 1925.49, '4 checks']);
  assert.equal(sheet.rowCount, rows.length + 2);
  // Amounts are numbers in currency format, from the first check row to the total row.
  for (let r = 2; r <= rows.length + 2; r += 1) {
    assert.equal(typeof sheet.getCell(r, 3).value, 'number', `row ${r}`);
    assert.equal(sheet.getCell(r, 3).numFmt, DEPOSITED_CHECKS_CURRENCY_FORMAT, `row ${r}`);
  }
  assert.equal(DEPOSITED_CHECKS_CURRENCY_FORMAT, '"$"#,##0.00');
  assert.deepEqual(sheet.columns.map((c) => c.width), [34, 15, 14, 16, 22]);
  // An empty selection still makes a valid file with the header and a zero total.
  const empty = new ExcelJS.Workbook();
  await empty.xlsx.load(Buffer.from(await depositedChecksXlsx([], 'Deposited Checks')));
  assert.equal(empty.getWorksheet('Deposited Checks').rowCount, 2);
});

test('the SheetJS xlsx package is gone: no source imports it and package.json does not list it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies?.xlsx, undefined);
  assert.equal(pkg.devDependencies?.xlsx, undefined);
  const exportSrc = fs.readFileSync(path.join(ROOT, 'src/lib/depositedChecksExport.ts'), 'utf8');
  assert.doesNotMatch(exportSrc, /from ["']xlsx["']/);
  assert.match(exportSrc, /import ExcelJS from "exceljs";/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/components/settings/ImportSettings.tsx')), false);
});

test('PDF: a real PDF, one page per screenful, also when empty', () => {
  const rows = buildDepositedCheckRows(CHECKS, CASES);
  const pdf = Buffer.from(depositedChecksPdf(rows, 'Deposited Checks', 'Freedom Adjustment'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pages = (s) => (s.match(/\/Type \/Page\b/g) || []).length;
  assert.equal(pages(pdf.toString('latin1')), 1);
  const many = Array.from({ length: 80 }, (_, i) => ({ ...rows[0], id: `x${i}` }));
  assert.ok(pages(Buffer.from(depositedChecksPdf(many, 'Deposited Checks')).toString('latin1')) >= 3);
  assert.equal(Buffer.from(depositedChecksPdf([], 'Deposited Checks')).subarray(0, 5).toString(), '%PDF-');
});

test('Reports tab mounts Deposited Checks with PDF and Excel export above the Daily Deposit Log', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/deposit-ops/DepositReports.tsx'), 'utf8');
  assert.match(src, /<DepositedChecksReport \/>\s*<DailyDepositLog/);
  assert.match(src, /exportReport\("pdf"\)/);
  assert.match(src, /exportReport\("xlsx"\)/);
  assert.match(src, /import\("@\/lib\/depositedChecksExport"\)/);
  assert.match(src, /await depositedChecksXlsx\(rows, title\)/);
  assert.match(src, /claims\(claim_number, policyholder_name\), check_payees\(payee_name, payee_type\)/);
  assert.match(src, /\.not\("deposited_at", "is", null\)/);
  assert.match(src, /\.eq\("tenant_id", tenantId as string\)/);
});
