// Vendor payments screens (owner, 2026-11-13: "Start the vendor payments API and screens"), the website
// side of the vendor payee API. Owner decisions: a tenant pays a vendor from a check (Funds tab) and from
// the Payroll payment dialog only ("Do not add another location"); the normal send fee; wallet only (the
// API refuses with vendor_setup_required, no bank fallback); the Vendor Portal stays as it is; any member
// may add, remove and pay vendor payees; the same wallet.fund two-factor as other sends; no email.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  TENANT_VENDOR_SET_ACTION,
  TENANT_VENDOR_STATUS_ACTION,
  VENDOR_CODE_PATTERN,
  VENDOR_NO_PARTNERSHIP_NOTE,
  VENDOR_PAYEE_ADD_RPC,
  VENDOR_PAYEE_ERROR_MESSAGES,
  VENDOR_PAYEE_REMOVE_RPC,
  VENDOR_PAYEES_LIST_RPC,
  VENDOR_SEND_ERROR_MESSAGES,
  VENDOR_SEND_TOTP_ACTION,
  isValidVendorCode,
  normalizeVendorCode,
  payableVendorPayees,
  sendErrorMessage,
  vendorPayeeErrorMessage,
  vendorPayeeRows,
  vendorRecipientKey,
  vendorTenantIdFromKey,
} from '../../src/lib/payments/vendorPayees.ts';
import {
  PAYROLL_RUN_COLUMNS,
  payrollLedgerRows,
  payrollPayeeLines,
  payrollRecipientReportRows,
  payrollTaxPayments,
  payrollVendorTaxPayments,
  withVendorNames,
} from '../../src/lib/payments/payrollRows.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const flags = read('src/lib/payments/featureFlags.ts');
const sends = read('src/lib/payments/sends.ts');
const hook = read('src/hooks/useVendorPayees.ts');
const card = read('src/components/disbursement/VendorPayeesSettings.tsx');
const settings = read('src/components/white-label/WhiteLabelSettings.tsx');
const partnerManager = read('src/components/white-label/TenantPartnerManager.tsx');
const funds = read('src/components/disbursement/DisbursementConsole.tsx');
const payroll = read('src/components/payroll/RunPayrollDialog.tsx');
const history = read('src/components/payroll/PayrollHistoryTable.tsx');
const adminTenants = read('src/pages/admin/AdminTenants.tsx');
const vendorSwitch = read('src/components/admin/TenantVendorSwitch.tsx');
const tenantVendor = read('src/lib/tenantVendor.ts');
const app = read('src/App.tsx');
const lib = read('src/lib/payments/vendorPayees.ts');

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|mjs)$/.test(name) ? [full] : [];
});
const srcFiles = walk(join(ROOT, 'src')).map((f) => relative(ROOT, f).split('\\').join('/'));

test('flag: SHOW_VENDOR_PAYMENTS is true, typed, and not read from the environment', () => {
  assert.match(flags, /^\s*SHOW_VENDOR_PAYMENTS: boolean;$/m);
  assert.match(flags, /^\s*SHOW_VENDOR_PAYMENTS: true,$/m);
  assert.doesNotMatch(flags, /envFlag\("SHOW_VENDOR_PAYMENTS"/);
  // Every new screen is behind the flag.
  assert.match(settings, /\{PAYMENT_FLAGS\.SHOW_VENDOR_PAYMENTS && <VendorPayeesSettings \/>\}/);
  assert.match(adminTenants, /\{PAYMENT_FLAGS\.SHOW_VENDOR_PAYMENTS && <TenantVendorSwitch tenantId=\{tenant\.id\} tenantName=\{tenant\.name\} \/>\}/);
  assert.match(funds, /const SHOW_VENDOR_PAYMENTS = PAYMENT_FLAGS\.SHOW_VENDOR_PAYMENTS;/);
  assert.match(funds, /\{SHOW_VENDOR_PAYMENTS && checkIntakeItemId && \(/);
  assert.match(payroll, /const SHOW_VENDOR_PAYMENTS = PAYMENT_FLAGS\.SHOW_VENDOR_PAYMENTS;/);
  // Payroll: a "Pay a: Stakeholder / Vendor" choice behind the flag, then one list per kind
  // (aws/tests/payroll-vendor-picker.test.mjs renders it).
  assert.match(payroll, /const showingVendors = SHOW_VENDOR_PAYMENTS && payeeKind === "vendor";/);
  assert.match(payroll, /\{SHOW_VENDOR_PAYMENTS && \(\s*<div role="radiogroup" aria-label="Pay a"/);
  assert.match(hook, /enabled: PAYMENT_FLAGS\.SHOW_VENDOR_PAYMENTS && !!tenantId && enabled,/);
});

test('Vendors card: in Settings → Bank Account/Stakeholders after the stakeholders, not in Partners, no new page', () => {
  const tab = settings.indexOf('<TabsContent value="banking"');
  const end = settings.indexOf('</TabsContent>', tab);
  const stakeholders = settings.indexOf('<StakeholderAccountSettings />', tab);
  const vendors = settings.indexOf('<VendorPayeesSettings />', tab);
  assert.ok(tab > 0 && stakeholders > tab && vendors > stakeholders && vendors < end);
  assert.equal(settings.split('<VendorPayeesSettings').length, 2, 'rendered once');
  // The Partners tab (sharing) is unchanged: still the 8-character partner code, no vendor wording.
  assert.doesNotMatch(partnerManager, /vendor/i);
  assert.match(partnerManager, /maxLength=\{8\}/);
  // No new route or page.
  assert.doesNotMatch(app, /VendorPayees|vendor-payees|vendor-payments|TenantVendorSwitch/);
  assert.equal(srcFiles.filter((f) => f.startsWith('src/pages/') && /vendor/i.test(f) && !f.startsWith('src/pages/vendor-ops/')).length, 0);
  // Title, the explanation that it creates no partnership and shares nothing, list fields, remove.
  assert.match(card, /title="Vendors"/);
  assert.match(VENDOR_NO_PARTNERSHIP_NOTE, /creates no partnership and shares nothing/);
  assert.match(VENDOR_NO_PARTNERSHIP_NOTE, /only lets you pay the vendor's ChecksOps wallet/);
  assert.match(card, /\{VENDOR_NO_PARTNERSHIP_NOTE\}/);
  assert.match(card, /vendorPayeeName\(p\)/);
  assert.match(card, /p\.partner_code_used/);
  assert.match(card, /addedOn\(p\.created_at\)/);
  assert.match(card, /\{!p\.vendor_active && \(/);
  assert.match(card, /VENDOR_INACTIVE_LABEL/);
  assert.match(lib, /export const VENDOR_INACTIVE_LABEL = "No longer a vendor";/);
  assert.match(card, /remove\.mutate\(p\.vendor_tenant_id\)/);
  // Any member: shown wherever the tab is (the server checks membership), no extra role gate.
  assert.doesNotMatch(card, /isAdmin|usePermissions|canManage|role/);
});

test('code input: 3-40 of A-Z 0-9 _ -, normalized as typed, never forced to 8', () => {
  assert.equal(String(VENDOR_CODE_PATTERN), String(/^[A-Z0-9_-]{3,40}$/));
  assert.equal(normalizeVendorCode(' acme-supply_1 '), 'ACME-SUPPLY_1');
  assert.equal(normalizeVendorCode('ab.c d!'), 'ABCD');
  assert.equal(normalizeVendorCode('x'.repeat(50)).length, 40);
  assert.equal(isValidVendorCode('AB'), false);
  assert.equal(isValidVendorCode('ABC'), true);
  assert.equal(isValidVendorCode('A'.repeat(40)), true);
  assert.equal(isValidVendorCode('A'.repeat(41)), false);
  assert.equal(isValidVendorCode('AB3K7X9P'), true);
  assert.equal(isValidVendorCode('abc'), false);
  assert.match(card, /onChange=\{\(e\) => setCode\(normalizeVendorCode\(e\.target\.value\)\)\}/);
  assert.match(card, /maxLength=\{VENDOR_CODE_MAX\}/);
  assert.doesNotMatch(card, /maxLength=\{8\}|length !== 8|\.length === 8/);
  assert.match(card, /disabled=\{!codeValid \|\| add\.isPending \|\| !tenantId\}/);
});

test('API contract: /data/rpc vendor_payee_add/remove/list and tenant-billing-admin vendor-set/vendor-status', () => {
  assert.equal(VENDOR_PAYEE_ADD_RPC, 'vendor_payee_add');
  assert.equal(VENDOR_PAYEE_REMOVE_RPC, 'vendor_payee_remove');
  assert.equal(VENDOR_PAYEES_LIST_RPC, 'vendor_payees_list');
  assert.match(hook, /rpc\(VENDOR_PAYEES_LIST_RPC, \{ tenant_id: tenantId \}\)/);
  assert.match(hook, /rpc\(VENDOR_PAYEE_ADD_RPC, \{ tenant_id: tenantId, partner_code: partnerCode \}\)/);
  assert.match(hook, /rpc\(VENDOR_PAYEE_REMOVE_RPC, \{ tenant_id: tenantId, vendor_tenant_id: vendorTenantId \}\)/);
  // supabase.rpc on AWS is the /data/rpc bridge.
  assert.match(read('src/integrations/aws/client.ts'), /apiFetch\("\/data\/rpc", \{\s*method: "POST",\s*body: JSON\.stringify\(\{ name, args \}\),/);
  assert.equal(TENANT_VENDOR_SET_ACTION, 'vendor-set');
  assert.equal(TENANT_VENDOR_STATUS_ACTION, 'vendor-status');
  assert.match(tenantVendor, /invoke\("tenant-billing-admin", \{\s*body: \{ action: TENANT_VENDOR_STATUS_ACTION, tenant_id: tenantId \},/);
  assert.match(tenantVendor, /invoke\("tenant-billing-admin", \{\s*body: \{ action: TENANT_VENDOR_SET_ACTION, tenant_id: tenantId, is_vendor: isVendor \},/);

  const rows = vendorPayeeRows([
    { link_id: 'l1', vendor_tenant_id: 'v1', vendor_name: 'Acme', partner_code_used: 'ACME', created_at: '2026-11-13T00:00:00Z', vendor_active: true },
    { link_id: 'l2', vendor_tenant_id: 'v2', vendor_name: 'Gone', partner_code_used: 'GONE', created_at: null, vendor_active: false },
    { link_id: 'l3', vendor_tenant_id: 'v3', vendor_name: 'Unmarked', is_vendor: false },
    { link_id: 'bad' },
  ]);
  assert.deepEqual(rows.map((r) => [r.vendor_tenant_id, r.vendor_active]), [['v1', true], ['v2', false], ['v3', false]]);
  assert.deepEqual(payableVendorPayees(rows).map((r) => r.vendor_tenant_id), ['v1']);
  assert.deepEqual(vendorPayeeRows({ payees: [{ vendor_tenant_id: 'v9' }] }).map((r) => r.vendor_tenant_id), ['v9']);
  assert.deepEqual(vendorPayeeRows(null), []);
});

test('errors: every vendor code has a plain message and the server message wins', () => {
  for (const code of ['forbidden', 'invalid_code', 'vendor_not_found', 'own_code', 'vendor_inactive', 'invalid_vendor', 'not_found']) {
    assert.ok(VENDOR_PAYEE_ERROR_MESSAGES[code], code);
  }
  for (const code of ['vendor_not_payee', 'vendor_setup_required', 'vendor_wallet_choice_required', 'recipient_is_sender', 'totp_required']) {
    assert.ok(VENDOR_SEND_ERROR_MESSAGES[code], code);
  }
  assert.match(VENDOR_SEND_ERROR_MESSAGES.vendor_setup_required, /has not set up its ChecksOps wallet/);
  assert.equal(sendErrorMessage('vendor_setup_required', 'Server says so', 'x'), 'Server says so');
  assert.equal(sendErrorMessage('vendor_setup_required', 'vendor_setup_required', 'x'), VENDOR_SEND_ERROR_MESSAGES.vendor_setup_required);
  assert.equal(sendErrorMessage('vendor_setup_required', null, 'x'), VENDOR_SEND_ERROR_MESSAGES.vendor_setup_required);
  // Codes that are not the vendor's keep the old behaviour: the code, or the fallback.
  assert.equal(sendErrorMessage('send_failed', null, 'fallback'), 'send_failed');
  assert.equal(sendErrorMessage(null, null, 'fallback'), 'fallback');
  assert.equal(sendErrorMessage('toString', null, 'fallback'), 'toString');
  assert.equal(vendorPayeeErrorMessage('own_code', null, 'x'), VENDOR_PAYEE_ERROR_MESSAGES.own_code);
  // sends.ts shows the server's message plainly through the same helper.
  assert.match(sends, /const message = sendErrorMessage\(code, typeof reply\?\.message === "string" \? reply\.message : null, fallback\);/);
  // The Funds tab treats every vendor_ / recipient_ refusal as final for this payment.
  assert.equal((funds.match(/\/\^\(recipient\|partner\|vendor\)_\/\.test\(e\.code\)/g) ?? []).length, 2);
  // Payroll shows the error message as is.
  assert.match(payroll, /toast\(\{ title: "Payroll failed", description: e\.message \?\? String\(e\), variant: "destructive" \}\)/);
});

test('wallet only: no bank fallback wording for a vendor, and no external record for a vendor', () => {
  const vendorText = [lib, card].join("\n").replaceAll("Bank Account/Stakeholders", "the settings tab");
  assert.doesNotMatch(vendorText, /fall back|fallback to (the )?bank|bank account|ACH|linked bank/i);
  assert.match(lib, /export const VENDOR_WALLET_ONLY_NOTE = "Vendors are paid to their ChecksOps wallet only\.";/);
  const picker = funds.slice(funds.indexOf('data-testid="funds-tab-vendor-picker"'), funds.indexOf('{partnersNeedingSetup.length > 0'));
  assert.ok(picker.length > 0);
  assert.doesNotMatch(picker.replaceAll("Bank Account/Stakeholders", "the settings tab"), /bank|ACH|fall back/i);
  assert.match(picker, /The normal send fee applies\./);
  assert.match(funds, /if \(acct\?\.vendor_tenant_id\) \{\s*throw new Error\(`\$\{acct\.nickname\} is a vendor and is paid to its ChecksOps wallet only\./);
  assert.match(sends, /\| \{ kind: "vendor"; vendor_tenant_id: string; amount_cents: number \};/);
});

test('pay: a vendor recipient in the Funds tab and the payroll dialog, nowhere else', () => {
  // Funds tab: a chosen vendor payee becomes { kind: "vendor", vendor_tenant_id, amount_cents }.
  assert.match(funds, /if \(acct\?\.vendor_tenant_id\) return \{ kind: "vendor", vendor_tenant_id: acct\.vendor_tenant_id, amount_cents \};/);
  assert.match(funds, /const accounts = useMemo\(\(\) => \[\.\.\.mergedAccounts, \.\.\.vendorAccounts\], \[mergedAccounts, vendorAccounts\]\);/);
  assert.match(funds, /\.filter\(\(v\): v is NonNullable<typeof v> => !!v && v\.vendor_active\)/);
  assert.match(funds, /r\.kind === "vendor" \? vendorRecipientKey\(r\.id\)/);
  assert.match(funds, /sendPayment\(\{ tenantId: tenant\.id, checkId: checkIntakeItemId, speed, recipients, idempotencyKey \}\)/);
  // Payroll: exactly one recipient, a stakeholder or a vendor payee.
  assert.match(sends, /recipients: \[payrollRecipient\(input\)\],/);
  assert.match(sends, /if \(input\.vendorTenantId\) return \{ kind: "vendor", vendor_tenant_id: input\.vendorTenantId, amount_cents: input\.amountCents \};/);
  assert.match(payroll, /stakeholderAccountId: selectedVendor \? null : selected!\.id,\s*vendorTenantId: selectedVendor\?\.vendor_tenant_id \?\? null,/);
  assert.match(payroll, /value=\{vendorRecipientKey\(v\.vendor_tenant_id\)\} disabled=\{!v\.vendor_active\}/);
  assert.match(payroll, /v\.vendor_tenant_id === vendorTenantId && v\.vendor_active/);
  // The fee is the normal speed fee in both places.
  assert.match(payroll, /const fee = SPEED_FEES\[speed\];/);
  assert.match(funds, /const fee = SPEED_FEES\[deliverySpeed\];/);
  assert.equal(vendorRecipientKey('abc'), 'vendor:abc');
  assert.equal(vendorTenantIdFromKey('vendor:abc'), 'abc');
  assert.equal(vendorTenantIdFromKey('abc'), null);

  // Nowhere else: the vendor payee hook and the vendor recipient appear only in these files.
  const allowed = new Set([
    'src/hooks/useVendorPayees.ts',
    'src/components/disbursement/VendorPayeesSettings.tsx',
    'src/components/disbursement/DisbursementConsole.tsx',
    'src/components/payroll/RunPayrollDialog.tsx',
    // Read-only: Tax & 1099 uses the list to recognise vendor sends; nothing is paid from there.
    'src/components/ledger/TaxSummary.tsx',
    // A partner's send from a check shared with it pays its own vendor payees (partnerSend.ts).
    'src/components/payments/PartnerSendPanel.tsx',
  ]);
  const users = srcFiles.filter((f) => /useVendorPayees\b/.test(read(f)));
  assert.deepEqual(users.filter((f) => !allowed.has(f)), []);
  assert.doesNotMatch(read('src/components/ledger/TaxSummary.tsx'), /sendPayment|sendPayrollPayment|kind: "vendor"/);
  const vendorSends = srcFiles.filter((f) => /kind: "vendor"/.test(read(f)));
  assert.deepEqual(vendorSends.sort(), ['src/components/disbursement/DisbursementConsole.tsx', 'src/lib/payments/partnerSend.ts', 'src/lib/payments/sends.ts']);
});

test('two-factor: vendor sends reuse the existing wallet.fund step-up and retry', () => {
  assert.equal(VENDOR_SEND_TOTP_ACTION, 'wallet.fund');
  for (const src of [funds, payroll]) {
    assert.match(src, /error\.code !== "totp_required"/);
    assert.match(src, /actionKey: "wallet\.fund",/);
    assert.match(src, /\{ force: true \}/);
    assert.equal((src.match(/requireStepUp\(/g) ?? []).length, 1, 'one step-up path, shared by every recipient');
  }
  // No email from the website.
  assert.doesNotMatch(card + hook + lib, /send-email|sendEmail|email_queue|"email"/);
});

test('platform owner: a Vendor switch on the tenant Company tab, modeled on the deposits switch', () => {
  const company = adminTenants.indexOf('<TabsContent value="company"');
  const end = adminTenants.indexOf('</TabsContent>', company);
  const badge = adminTenants.indexOf('<TenantOpsBadgeSwitch', company);
  const vendor = adminTenants.indexOf('<TenantVendorSwitch', company);
  assert.ok(company > 0 && badge > company && vendor > badge && vendor < end);
  assert.match(vendorSwitch, /title="Vendor"/);
  assert.match(vendorSwitch, /data-testid="tenant-vendor"/);
  assert.match(vendorSwitch, /queryFn: \(\) => fetchTenantVendorStatus\(tenantId\)/);
  assert.match(vendorSwitch, /mutationFn: \(next: boolean\) => saveTenantVendor\(tenantId, next\)/);
  assert.match(vendorSwitch, /Only the ChecksOps platform owner can change this/);
  assert.match(tenantVendor, /functionRefusalMessage\(data, error, "Vendor setting was not saved"\)/);
});

test('Vendor Portal unchanged: vendorOps.ts and the /vendor-ops routes know nothing of vendor payees', () => {
  const vendorOps = read('src/lib/vendorOps.ts');
  assert.doesNotMatch(vendorOps, /vendor_payee|VendorPayee|SHOW_VENDOR_PAYMENTS|vendor-set|is_vendor/);
  for (const f of srcFiles.filter((f) => f.startsWith('src/pages/vendor-ops/'))) {
    assert.doesNotMatch(read(f), /vendor_payee|VendorPayee|SHOW_VENDOR_PAYMENTS|TenantVendorSwitch/, f);
  }
  assert.doesNotMatch(vendorSwitch + card + lib + hook, /from "@\/lib\/vendorOps"|to="\/vendor-ops|navigate\("\/vendor-ops/);
});

test('payroll history: a vendor run (SQL 165 vendor_tenant_id, no stakeholder) shows the vendor name and never crashes', async () => {
  assert.match(PAYROLL_RUN_COLUMNS, /\bvendor_tenant_id\b/);
  assert.match(history, /vendor_tenant_id/);
  assert.match(history, /const payee = payrollPayeeLines\(r\);/);
  assert.match(history, /return withVendorNames\(supabase, /);
  const vendorRun = { id: 'r1', amount: '25.00', speed: 'next_day', status: 'submitted', created_at: '2026-11-13T10:00:00Z', stakeholder_account_id: null, stakeholder_accounts: null, vendor_tenant_id: 'v1' };
  const stakeholderRun = { id: 'r2', amount: 10, status: 'completed', created_at: '2026-11-12T10:00:00Z', stakeholder_account_id: 's1', stakeholder_accounts: { id: 's1', nickname: 'Pat', custname: 'Pat Co', account_type: 'contractor', chk_acct: '991234' } };
  const lookups = [];
  const client = {
    from(table) {
      return {
        select() {
          return {
            in(column, ids) {
              lookups.push([table, column, ids]);
              return Promise.resolve({ data: [{ id: 'v1', name: 'Acme Supply' }], error: null });
            },
          };
        },
      };
    },
  };
  const named = await withVendorNames(client, [vendorRun, stakeholderRun]);
  assert.deepEqual(lookups, [['tenants_public', 'id', ['v1']]]);
  assert.equal(named[0].vendor_name, 'Acme Supply');
  assert.deepEqual(payrollPayeeLines(named[0]), { name: 'Acme Supply', detail: 'Vendor · ChecksOps wallet' });
  assert.deepEqual(payrollPayeeLines(named[1]), { name: 'Pat', detail: 'Pat Co' });
  assert.deepEqual(payrollPayeeLines(vendorRun), { name: 'Vendor', detail: 'Vendor · ChecksOps wallet' });
  const ledger = payrollLedgerRows(named);
  assert.equal(ledger[0].recipient_name, 'Acme Supply');
  assert.equal(ledger[0].recipient_type, 'vendor');
  assert.equal(payrollRecipientReportRows(named)[0].acct4, '—');
  // The stakeholder path keys to a stakeholder account; a vendor run is counted for the vendor instead.
  assert.deepEqual(payrollTaxPayments(named).map((p) => p.stakeholder_accounts.id), ['s1']);
  assert.deepEqual(payrollVendorTaxPayments(named), [{ vendor_tenant_id: 'v1', vendor_name: 'Acme Supply', at: '2026-11-13T10:00:00Z', amount: 25 }]);
  // A failed name lookup never fails the read.
  const broken = { from() { throw new Error('down'); } };
  assert.equal((await withVendorNames(broken, [vendorRun]))[0].vendor_name, null);
  // No vendor runs: no lookup at all.
  assert.equal((await withVendorNames(broken, [stakeholderRun])).length, 1);
});
