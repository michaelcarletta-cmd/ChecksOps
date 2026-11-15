/**
 * Owner 2026-11-15: "We also need to be able to create excel and pdf reports for this." Excel and PDF
 * of one recipient's drill-down (as shown: client search and All/Sent/Received filter applied) and of
 * the whole Per-Recipient Detail report (as shown: search and type filters applied), in the style of
 * the Deposited Checks export (deposited-checks-report.test.mjs). src/lib/payments/recipientReportExport.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import {
  DRILLDOWN_FILTER_LABELS,
  RECIPIENT_REPORT_CURRENCY_FORMAT,
  REPORT_FIRST_ROW,
  recipientDrilldownTable,
  recipientReportTable,
  reportFileName,
  reportMoney,
  reportTablePdf,
  reportTableXlsx,
} from '../../src/lib/payments/recipientReportExport.ts';
import {
  checkClientName,
  filterByDirection,
  receivedTransactions,
  recipientTransactions,
  searchTransactions,
  sentTransactions,
} from '../../src/lib/payments/recipientDrilldown.ts';
import { DEPOSITED_CHECKS_CURRENCY_FORMAT } from '../../src/lib/depositedChecksExport.ts';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
// MM/DD/YYYY in the local time zone, as the sheet shows dates.
const day = (iso) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
};
const RANGE = 'This year (Jan 1, 2026 – Dec 31, 2026)';

const split = (id, extra = {}) => ({
  id, date: '2026-11-08T15:00:00Z', name: 'Ann Roofing', type: 'contractor', acct4: '••••1234',
  amount: 500, status: 'settled', method: 'actum', reference: '271682',
  clientName: checkClientName({ claims: { policyholder_name: 'Anissa Nassry' } }), claimNumber: '38-99V2-97X', ...extra,
});
const incoming = (id, extra = {}) => ({
  id, amount_cents: 20000, status: 'completed', environment: 'production', leg_role: 'send_wallet',
  created_at: '2026-11-10T15:00:00Z', submitted_at: '2026-11-10T15:00:01Z', completed_at: '2026-11-10T16:00:00Z',
  check_id: 'chk-9', sender_tenant_id: 'c1-tenant', sender_name: 'Ann Roofing',
  check_number: '2002', carrier_name: 'Allstate', claim_number: 'CL-77', policyholder_name: 'Deen Bandhu',
  ...extra,
});
const MINE = () => recipientTransactions('Ann Roofing', [
  ...sentTransactions([
    split('s1'),
    split('s2', { date: '2026-11-09T15:00:00Z', amount: 250.1, reference: '3003', clientName: 'Mary Jones', claimNumber: null }),
    split('s3', { date: '2026-11-07T15:00:00Z', amount: 75, status: 'returned' }),
  ]),
  ...receivedTransactions([incoming('a')]),
]);

const load = async (bytes) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes));
  return book;
};
const values = (sheet, n) => sheet.getRow(n).values.slice(1);
const pdfText = (bytes) => Buffer.from(bytes).toString('latin1');
// PDF string literals escape parentheses and backslashes.
const pdfEscape = (text) => text.replace(/[()\\]/g, '\\$&');
const has = (pdf, text) => pdf.includes(pdfEscape(text));
const count = (pdf, text) => pdf.split(`(${pdfEscape(text)}) Tj`).length - 1;
const pages = (s) => (s.match(/\/Type \/Page\b/g) || []).length;

test('one recipient: the table is the rows shown, with Sent, Received and Net totals and a titled header', () => {
  const t = recipientDrilldownTable({ recipient: 'Ann Roofing', transactions: MINE(), filter: 'all', rangeLabel: RANGE, companyName: 'Freedom Adjustment' });
  assert.equal(t.title, 'Freedom Adjustment – Recipient: Ann Roofing');
  assert.equal(t.subtitle, `All transactions – ${RANGE}`);
  assert.deepEqual(t.columns.map((c) => c.label), ['Date', 'Direction', 'Client', 'Amount', 'Method', 'Status', 'Reference']);
  assert.deepEqual(t.rows[0], [day('2026-11-10T16:00:00Z'), 'Received', 'Deen Bandhu', 200, 'Partner wallet', 'Received', 'Ck #2002 · Claim CL-77']);
  assert.deepEqual(t.rows[1], [day('2026-11-09T15:00:00Z'), 'Sent', 'Mary Jones', 250.1, 'ACH', 'Settled', 'Ck #3003']);
  assert.deepEqual(t.rows[3], [day('2026-11-07T15:00:00Z'), 'Sent', 'Anissa Nassry', 75, 'ACH', 'Returned (not totaled)', 'Ck #271682 · Claim 38-99V2-97X']);
  assert.deepEqual(t.totals.map((r) => [r[0], r[3]]), [['Total sent (2)', 750.1], ['Total received (1)', 200], ['Net (received - sent)', -550.1]]);

  // The search and the filter: exactly what the sheet shows, named in the subtitle.
  const shown = filterByDirection(searchTransactions(MINE(), 'anissa'), 'sent');
  const s = recipientDrilldownTable({ recipient: 'Ann Roofing', transactions: shown, filter: 'sent', search: 'anissa', rangeLabel: RANGE });
  assert.equal(s.title, 'Recipient: Ann Roofing');
  assert.equal(s.subtitle, `Sent only – matching "anissa" – ${RANGE}`);
  assert.deepEqual(s.rows.map((r) => r[2]), ['Anissa Nassry', 'Anissa Nassry']);
  assert.deepEqual(s.totals.map((r) => [r[0], r[3]]), [['Total sent (1)', 500], ['Net (received - sent)', -500]]);
  const r = recipientDrilldownTable({ recipient: 'Ann Roofing', transactions: filterByDirection(MINE(), 'received'), filter: 'received', rangeLabel: RANGE });
  assert.deepEqual(r.totals.map((x) => x[0]), ['Total received (1)', 'Net (received - sent)']);
  assert.deepEqual(DRILLDOWN_FILTER_LABELS, { all: 'All transactions', sent: 'Sent only', received: 'Received only' });
});

test('one recipient Excel: the sheet, title, headers, rows and totals, amounts in the deposited-checks currency format', async () => {
  const t = recipientDrilldownTable({ recipient: 'Ann Roofing', transactions: MINE(), filter: 'all', rangeLabel: RANGE, companyName: 'Freedom Adjustment' });
  const bytes = await reportTableXlsx(t);
  assert.equal(Buffer.from(bytes.subarray(0, 2)).toString(), 'PK');
  const book = await load(bytes);
  assert.equal(book.title, 'Freedom Adjustment – Recipient: Ann Roofing');
  const sheet = book.getWorksheet('Recipient');
  assert.ok(sheet);
  assert.deepEqual(values(sheet, 1), ['Freedom Adjustment – Recipient: Ann Roofing']);
  assert.deepEqual(values(sheet, 2), [`All transactions – ${RANGE}`]);
  assert.deepEqual(values(sheet, 3), ['Date', 'Direction', 'Client', 'Amount', 'Method', 'Status', 'Reference']);
  assert.equal(REPORT_FIRST_ROW, 4);
  assert.deepEqual(values(sheet, 5), [day('2026-11-09T15:00:00Z'), 'Sent', 'Mary Jones', 250.1, 'ACH', 'Settled', 'Ck #3003']);
  const totalsAt = REPORT_FIRST_ROW + t.rows.length;
  assert.deepEqual([1, 4].map((c) => sheet.getRow(totalsAt).getCell(c).value), ['Total sent (2)', 750.1]);
  assert.deepEqual([1, 4].map((c) => sheet.getRow(totalsAt + 1).getCell(c).value), ['Total received (1)', 200]);
  assert.deepEqual([1, 4].map((c) => sheet.getRow(totalsAt + 2).getCell(c).value), ['Net (received - sent)', -550.1]);
  assert.match(String(sheet.getRow(totalsAt + 3).getCell(1).value), /^Totals count settled payments sent/);
  for (let row = REPORT_FIRST_ROW; row < totalsAt + 3; row += 1) {
    assert.equal(typeof sheet.getCell(row, 4).value, 'number', `row ${row}`);
    assert.equal(sheet.getCell(row, 4).numFmt, '"$"#,##0.00', `row ${row}`);
  }
  assert.equal(RECIPIENT_REPORT_CURRENCY_FORMAT, DEPOSITED_CHECKS_CURRENCY_FORMAT);
  // Nothing shown: still a valid file with the header and zero totals.
  const empty = await load(await reportTableXlsx(recipientDrilldownTable({ recipient: 'X', transactions: [], filter: 'all', rangeLabel: 'All time' })));
  const es = empty.getWorksheet('Recipient');
  assert.deepEqual(values(es, 3)[0], 'Date');
  assert.equal(es.getRow(REPORT_FIRST_ROW).getCell(4).value, 0);
});

test('one recipient PDF: a real PDF with the title, the range and the totals; the header repeats on every page', () => {
  const t = recipientDrilldownTable({ recipient: 'Ann Roofing', transactions: MINE(), filter: 'all', rangeLabel: RANGE, companyName: 'Freedom Adjustment' });
  const pdf = pdfText(reportTablePdf(t));
  assert.equal(pdf.slice(0, 5), '%PDF-');
  assert.equal(pages(pdf), 1);
  for (const text of ['Recipient: Ann Roofing', 'Freedom Adjustment', 'Jan 1, 2026', 'Total sent (2)', '$750.10', 'Total received (1)', '$200.00', 'Net (received - sent)', '-$550.10', 'Anissa Nassry', 'Date', 'Client', 'Reference']) {
    assert.ok(has(pdf, text), text);
  }
  // 80 rows: several pages, the column header on each, the totals once at the end.
  const many = Array.from({ length: 80 }, (_, i) => ({ ...MINE()[1], id: `x${i}` }));
  const long = pdfText(reportTablePdf(recipientDrilldownTable({ recipient: 'Ann Roofing', transactions: many, filter: 'all', rangeLabel: RANGE })));
  const n = pages(long);
  assert.ok(n >= 3, `${n} pages`);
  assert.equal(count(long, 'Recipient: Ann Roofing'), n, 'title on every page');
  assert.equal(count(long, 'Reference'), n, 'column header on every page');
  assert.equal(count(long, 'Total sent (80)'), 1);
  assert.ok(long.lastIndexOf('Page 1') < long.lastIndexOf(`Page ${n}`));
  assert.ok(long.indexOf(pdfEscape('Total sent (80)')) > long.indexOf(`Page ${n}`), 'the totals are on the last page');
  assert.equal(pdfText(reportTablePdf(recipientDrilldownTable({ recipient: 'X', transactions: [], filter: 'all', rangeLabel: 'All time' }))).slice(0, 5), '%PDF-');
});

const SUMMARY = [
  { name: 'Ann Roofing', types: ['contractor', 'partner'], count: 3, total: 750.1, last: '2026-11-09T15:00:00Z' },
  { name: 'Bob Supply', type: 'supplier', count: 1, total: 0.2, last: '2026-10-01T15:00:00Z' },
  { name: 'Carol Sales', type: 'sales_rep', count: 0, total: 0, last: null },
];
const LABELS = { contractor: 'Contractors', partner: 'Partners', supplier: 'Suppliers', sales_rep: 'Sales Reps' };
const typeLabel = (t) => LABELS[t] ?? t;

test('Per-Recipient Detail: the rows as shown, Type(s) as words, a grand total; Excel and PDF', async () => {
  const t = recipientReportTable({ rows: SUMMARY, typeLabel, rangeLabel: RANGE, typeFilterLabel: 'All types', search: '', companyName: 'Freedom Adjustment' });
  assert.equal(t.title, 'Freedom Adjustment – Per-Recipient Detail');
  assert.equal(t.subtitle, `All types – ${RANGE}`);
  assert.deepEqual(t.columns.map((c) => c.label), ['Recipient', 'Type(s)', 'Payments', 'Total Paid', 'Last Paid']);
  assert.deepEqual(t.rows, [
    ['Ann Roofing', 'Contractors / Partners', 3, 750.1, day('2026-11-09T15:00:00Z')],
    ['Bob Supply', 'Suppliers', 1, 0.2, day('2026-10-01T15:00:00Z')],
    ['Carol Sales', 'Sales Reps', 0, 0, ''],
  ]);
  // Cents, not floats.
  assert.deepEqual(t.totals, [['Grand total (3 recipients)', '', 4, 750.3, '']]);
  const filtered = recipientReportTable({ rows: SUMMARY.slice(1, 2), typeLabel, rangeLabel: 'All time', typeFilterLabel: 'Suppliers', search: 'bob' });
  assert.equal(filtered.subtitle, 'Suppliers – matching "bob" – All time');
  assert.deepEqual(filtered.totals, [['Grand total (1 recipient)', '', 1, 0.2, '']]);

  const book = await load(await reportTableXlsx(t));
  const sheet = book.getWorksheet('Per-Recipient Detail');
  assert.ok(sheet);
  assert.deepEqual(values(sheet, 1), ['Freedom Adjustment – Per-Recipient Detail']);
  assert.deepEqual(values(sheet, 3), ['Recipient', 'Type(s)', 'Payments', 'Total Paid', 'Last Paid']);
  assert.deepEqual(values(sheet, 4), ['Ann Roofing', 'Contractors / Partners', 3, 750.1, day('2026-11-09T15:00:00Z')]);
  assert.deepEqual([1, 3, 4].map((c) => sheet.getRow(7).getCell(c).value), ['Grand total (3 recipients)', 4, 750.3]);
  for (let row = 4; row <= 7; row += 1) assert.equal(sheet.getCell(row, 4).numFmt, '"$"#,##0.00', `row ${row}`);
  assert.notEqual(sheet.getCell(4, 3).numFmt, '"$"#,##0.00', 'the payment count is not currency');

  const pdf = pdfText(reportTablePdf(t));
  assert.equal(pdf.slice(0, 5), '%PDF-');
  for (const text of ['Freedom Adjustment', 'Per-Recipient Detail', 'Grand total (3 recipients)', '$750.30', 'Contractors / Partners', 'Total Paid']) {
    assert.ok(has(pdf, text), text);
  }
});

test('file names are safe: lower-case words and dashes, the range, the extension', () => {
  assert.equal(reportFileName(['recipient', 'Ann Roofing, LLC', null, '2026-01-01-to-2026-12-31'], 'xlsx'), 'recipient-ann-roofing-llc-2026-01-01-to-2026-12-31.xlsx');
  assert.equal(reportFileName(['recipient', 'José / O\'Brien & Sons', 'sent', 'all-time'], 'pdf'), 'recipient-jose-o-brien-sons-sent-all-time.pdf');
  assert.equal(reportFileName(['recipient-report', 'all-time'], 'pdf'), 'recipient-report-all-time.pdf');
  assert.equal(reportFileName(['../../etc/passwd'], 'pdf'), 'etc-passwd.pdf');
  assert.equal(reportFileName([], 'xlsx'), 'report.xlsx');
  assert.ok(reportFileName(['x'.repeat(300)], 'pdf').length <= 124);
  assert.equal(reportMoney(-550.1), '-$550.10');
  assert.equal(reportMoney(1234.5), '$1,234.50');
});

test('buttons: an Export menu (Excel, PDF) in the sheet header and the Per-Recipient Detail header; CSV unchanged', () => {
  const menu = read('src/components/ledger/ReportExportMenu.tsx');
  assert.match(menu, /from "@\/components\/ui\/dropdown-menu"/);
  assert.match(menu, /onSelect=\{\(\) => onExport\("xlsx"\)\}/);
  assert.match(menu, /onSelect=\{\(\) => onExport\("pdf"\)\}/);
  assert.match(menu, /\{busy \? "Preparing…" : "Export"\}/);

  const sheet = read('src/components/ledger/RecipientDrilldownSheet.tsx');
  assert.match(sheet, /<ReportExportMenu onExport=\{exportShown\} busy=\{exporting\} label=\{`Export transactions with \$\{name \?\? "recipient"\}`\} \/>/);
  // Exactly what is shown: the searched, filtered rows, the filter and the search.
  assert.match(sheet, /recipientDrilldownTable\(\{ recipient: name, transactions: shown, filter, search: query, rangeLabel, companyName \}\)/);
  assert.match(sheet, /reportFileName\(\["recipient", name, filter === "all" \? null : filter, fileRange\], kind\)/);
  assert.match(sheet, /await import\("@\/lib\/payments\/recipientReportExport"\)/);
  assert.match(sheet, /const \{ downloadReportFile \} = await import\("@\/lib\/depositedChecksExport"\);/);

  const report = read('src/components/ledger/RecipientReport.tsx');
  assert.match(report, /<CardTitle className="text-sm">Per-Recipient Detail<\/CardTitle>\s+<ReportExportMenu onExport=\{exportReport\} busy=\{exporting\} disabled=\{isLoading\} label="Export Per-Recipient Detail" \/>/);
  assert.match(report, /rows: byRecipient,/);
  assert.match(report, /typeFilterLabel: typeFilter === "all" \? "All types" : TYPE_LABELS\[typeFilter\] \?\? typeFilter,/);
  assert.match(report, /search,\n\s+companyName: tenant\?\.name \?\? "",/);
  assert.match(report, /reportFileName\(\["recipient-report", fileRange\], kind\)/);
  assert.match(report, /<RecipientDrilldownSheet[\s\S]*?fileRange=\{fileRange\}\s+companyName=\{tenant\?\.name \?\? ""\}/);
  // The CSV export is kept as it was.
  assert.match(report, /const headers = \["Recipient", "Type", "Total Paid", "Payment Count", "Last Paid"\];/);
  assert.match(report, /onClick=\{exportCSV\}/);
  // exceljs and jsPDF load only when an export is asked for.
  assert.doesNotMatch(report, /from "@\/lib\/payments\/recipientReportExport"/);
  assert.doesNotMatch(sheet, /from "@\/lib\/payments\/recipientReportExport"/);
  // No new dependency.
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies.exceljs && pkg.dependencies.jspdf);
});
