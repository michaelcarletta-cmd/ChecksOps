// Wallet & Treasury "Transfer to bank" (owner, 2026-11-13: "Start the transfer to bank button"), the website
// side of the moov-wallet-withdraw API (#1876, docs/WALLET_TO_BANK_TRANSFER_DESIGN.md §6). Owner decisions:
// no fee; limits set by the tenant (empty = no limit); any member; no admin approval; same-day ACH; the same
// wallet.fund two-factor as Add funds; no email; operating wallet only; the default bank only, never a picker;
// the arrival estimate comes from the API; changing the limits needs the two-factor code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  arrivalText,
  defaultSettlementBank,
  limitInputToCents,
  maskedBankLabel,
  parseDollarsToCents,
  precheckWithdrawAmount,
  WALLET_WITHDRAW_FUNCTION,
  WALLET_WITHDRAW_LIMITS_FUNCTION,
  WALLET_WITHDRAW_TOTP_ACTION,
  WITHDRAW_ERROR_MESSAGES,
  withdrawErrorMessage,
} from '../../src/lib/payments/walletWithdraw.ts';
import { summarizeWalletOps } from '../../src/lib/payments/walletRelativeTransfers.ts';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const page = read('src/pages/WalletOps.tsx');
const dialog = read('src/components/payments/TransferToBankDialog.tsx');
const hook = read('src/hooks/useWalletWithdraw.ts');
const wallets = read('src/lib/payments/wallets.ts');
const flags = read('src/lib/payments/featureFlags.ts');

test('flag: SHOW_WALLET_WITHDRAW is true and not read from the environment', () => {
  assert.match(flags, /^\s*SHOW_WALLET_WITHDRAW: boolean;$/m);
  assert.match(flags, /^\s*SHOW_WALLET_WITHDRAW: true,$/m);
  assert.doesNotMatch(flags, /envFlag\("SHOW_WALLET_WITHDRAW"/);
  assert.match(page, /const SHOW_WALLET_WITHDRAW = PAYMENT_FLAGS\.SHOW_WALLET_WITHDRAW;/);
});

test('placement: the button sits in Wallet & Treasury next to Add funds and Manage sweeps, behind its flag', () => {
  const card = page.indexOf('title="Wallet & Treasury"');
  const nextCard = page.indexOf('title="Automatic Funding"');
  assert.ok(card > 0 && nextCard > card);
  const sweeps = page.indexOf('Manage sweeps', card);
  const addFunds = page.indexOf('Add funds', card);
  const gate = page.indexOf('{SHOW_WALLET_WITHDRAW && (', card);
  const button = page.indexOf('<TransferToBankDialog', card);
  assert.ok(sweeps > card && addFunds > sweeps, 'Manage sweeps, then Add funds');
  assert.ok(gate > addFunds && button > gate && button < nextCard, 'Transfer to bank follows Add funds in the same card');
  // The three buttons share one button row.
  const row = page.lastIndexOf('<div className="flex flex-wrap gap-2">', sweeps);
  assert.ok(row > card && page.indexOf('</SectionCard>', row) > button);
  assert.match(page, /availableCents=\{syncFailed \? 0 : \(wallet\?\.available_cents \?\? 0\)\}/);
  assert.match(page, /onTransferred=\{\(\) => refreshWallet\.mutateAsync\(\)\}/);
  assert.match(dialog, />\s*Transfer to bank\s*<\/Button>/);
  // Add funds and its dialog stay as they were.
  assert.match(page, /<WalletPanel \/>/);
});

test('default bank only: no bank picker, the masked default bank, an explanation and a link when there is none', () => {
  // The browser never sends a bank: the request has no destination field.
  const fn = wallets.slice(wallets.indexOf('export function withdrawToBank'), wallets.indexOf('const limitsOf'));
  const requestBody = fn.slice(fn.indexOf('WALLET_WITHDRAW_FUNCTION,'), fn.indexOf('},', fn.indexOf('WALLET_WITHDRAW_FUNCTION,')));
  const fields = [...requestBody.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['tenant_id', 'wallet_type', 'amount_cents', 'idempotency_key', 'description']);
  assert.match(requestBody, /wallet_type: "operating",/);
  assert.doesNotMatch(requestBody, /bank_|destination|payment_method/);
  // No picker of any kind in the dialog.
  assert.doesNotMatch(dialog, /<Select|SelectItem|RadioGroup|bank_account_id|setBank/);
  assert.match(dialog, /To \(default bank\)/);
  assert.match(dialog, /Transfers go to the default bank only\./);
  assert.match(dialog, /No default bank/);
  assert.match(dialog, /<Link to=\{paymentsHref\}/);
  assert.match(page, /paymentsHref=\{`\$\{tenantBase\}\/payments`\}/);
  assert.match(hook, /\.eq\("environment", walletEnvironment\)/);
  assert.match(hook, /return defaultSettlementBank\(/);

  const own = { id: 'a', bank_name: 'FIRST BANK', last_four: '1234', is_default: true, connection_status: 'connected', external_recipient_id: null };
  const other = { id: 'b', bank_name: 'OTHER', last_four: '9999', is_default: false, connection_status: 'connected', external_recipient_id: null };
  assert.equal(defaultSettlementBank([other, own])?.id, 'a');
  // Never a fallback to another bank, a disconnected default, or a recipient's bank.
  assert.equal(defaultSettlementBank([other]), null);
  assert.equal(defaultSettlementBank([{ ...own, connection_status: 'pending' }, other]), null);
  assert.equal(defaultSettlementBank([{ ...own, external_recipient_id: 'r1' }]), null);
  assert.equal(defaultSettlementBank([]), null);
  assert.equal(maskedBankLabel(own), 'FIRST BANK ••1234');
  assert.equal(maskedBankLabel(null), 'No default bank');
});

test('two-factor: the transfer and the limits both use the wallet.fund step-up and retry with the same key', () => {
  assert.equal(WALLET_WITHDRAW_TOTP_ACTION, 'wallet.fund');
  assert.match(read('src/hooks/useWallet.ts'), /actionKey: "wallet\.fund",/);
  assert.match(hook, /error\.code !== "totp_required"/);
  assert.match(hook, /requireStepUp\(\s*\{\s*actionKey: WALLET_WITHDRAW_TOTP_ACTION,/);
  assert.match(hook, /\{ force: true \}/);
  // Both mutations go through the step-up.
  assert.match(hook, /withStepUp\(\s*\(\) => withdrawToBank\(\{ tenantId, amountCents: input\.amountCents, idempotencyKey: input\.idempotencyKey \}\),/);
  assert.match(hook, /withStepUp\(\(\) => saveWithdrawLimits\(tenantId, next\), "Confirm transfer limits"\)/);
  // One key per confirmation, made before Send and reused by the retry.
  assert.match(dialog, /setIdempotencyKey\(crypto\.randomUUID\(\)\);\s*setStep\("confirm"\);/);
  assert.match(dialog, /withdraw\.mutateAsync\(\{ amountCents, idempotencyKey \}\)/);
  assert.match(dialog, /Saving asks for your two-factor code\./);
  // The API names and request fields as built (#1876).
  assert.equal(WALLET_WITHDRAW_FUNCTION, 'moov-wallet-withdraw');
  assert.equal(WALLET_WITHDRAW_LIMITS_FUNCTION, 'save-tenant-wallet-withdraw-limits');
  assert.match(read('aws/functions/api/providers.mjs'), /name === 'moov-wallet-withdraw' && executionAllowed\('moov'\)/);
  assert.match(read('aws/functions/api/app-services.mjs'), /case 'save-tenant-wallet-withdraw-limits':/);
  assert.match(wallets, /\{ action: "get", tenant_id: tenantId \}/);
  assert.match(wallets, /action: "save",\s*tenant_id: tenantId,\s*\[PER_TRANSFER_LIMIT_FIELD\]: limits\[PER_TRANSFER_LIMIT_FIELD\],\s*\[PER_DAY_LIMIT_FIELD\]: limits\[PER_DAY_LIMIT_FIELD\],/);
});

test('errors: every code the API returns is handled, and its own message is shown plainly', () => {
  const required = [
    'default_bank_required', 'same_day_unavailable', 'tenant_limit_exceeded', 'insufficient_available_balance',
    'totp_required', 'withdrawal_not_ready', 'limits_not_ready',
  ];
  for (const code of required) assert.ok(WITHDRAW_ERROR_MESSAGES[code], code);
  // Every coded refusal in the two API handlers has a message here.
  const api = read('aws/functions/api/providers/production/moov-wallet-withdraw.mjs') + read('aws/functions/api/wallet-withdraw-limits.mjs');
  const codes = new Set([
    ...[...api.matchAll(/fail\('([a-z_]+)'/g)].map((m) => m[1]),
    ...[...api.matchAll(/refuse\(spoof, \d+, '([a-z_]+)'/g)].map((m) => m[1]),
    ...[...api.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]),
    ...[...api.matchAll(/return \{ error: '([a-z_]+)' \}/g)].map((m) => m[1]),
  ]);
  for (const code of required) assert.ok(codes.has(code), `the API still returns ${code}`);
  for (const code of codes) assert.ok(WITHDRAW_ERROR_MESSAGES[code], `handled: ${code}`);

  // The API's message wins; the numbers it returned are added.
  assert.equal(withdrawErrorMessage('same_day_unavailable', { message: 'From the API. Nothing was sent.' }), 'From the API. Nothing was sent.');
  assert.match(
    withdrawErrorMessage('tenant_limit_exceeded', { message: 'That is more than your daily transfer-to-bank limit. Nothing was sent.', limit: 'per_day', limit_cents: 50000, used_today_cents: 20000 }),
    /daily transfer-to-bank limit\. Nothing was sent\. Your daily limit is \$500\.00; \$200\.00 has already been sent today\./,
  );
  assert.match(withdrawErrorMessage('tenant_limit_exceeded', { limit: 'per_transfer', limit_cents: 10000 }), /Your per-transfer limit is \$100\.00\./);
  assert.match(withdrawErrorMessage('insufficient_available_balance', { available_cents: 1234 }), /Available to transfer now: \$12\.34\./);
  assert.equal(withdrawErrorMessage('withdrawal_not_ready'), 'Transfers to your bank are not switched on yet. Nothing was sent.');
  assert.equal(withdrawErrorMessage('limits_not_ready'), 'Transfer-to-bank limits are not switched on yet. Nothing was saved.');
  assert.match(withdrawErrorMessage('step_up_cancelled'), /Two-factor confirmation is required/);

  // The wallet functions show those messages, from either backend's error shape.
  assert.match(wallets, /new WalletWithdrawError\(code \|\| reply\?\.message \? withdrawErrorMessage\(code, reply\) : fallback, code, reply\)/);
  assert.match(dialog, /setSendError\(\(e as Error\)\.message\)/);
  assert.match(dialog, /setLimitsError\(\(e as Error\)\.message\)/);
});

test('amount, limits input and the arrival estimate from the API', () => {
  assert.equal(parseDollarsToCents('12.34'), 1234);
  assert.equal(parseDollarsToCents('$1,250.5'), 125050);
  assert.equal(parseDollarsToCents('.5'), 50);
  assert.equal(parseDollarsToCents('0'), null);
  assert.equal(parseDollarsToCents('1.234'), null);
  assert.equal(parseDollarsToCents('-5'), null);
  assert.equal(parseDollarsToCents('abc'), null);
  assert.equal(limitInputToCents(''), null);
  assert.equal(limitInputToCents('  '), null);
  assert.equal(limitInputToCents('100'), 10000);
  assert.equal(limitInputToCents('0'), 'invalid');
  // Unset limits: any amount up to the operating wallet balance.
  assert.equal(precheckWithdrawAmount({ amountCents: 5000, availableCents: 5000, perTransferCents: null }), null);
  assert.equal(precheckWithdrawAmount({ amountCents: 5001, availableCents: 5000, perTransferCents: null })?.code, 'insufficient_available_balance');
  assert.equal(precheckWithdrawAmount({ amountCents: 3000, availableCents: 5000, perTransferCents: 2000 })?.code, 'tenant_limit_exceeded');
  assert.equal(precheckWithdrawAmount({ amountCents: null, availableCents: 5000, perTransferCents: null })?.code, 'invalid_amount');
  // The date is the API's expected_arrival; the browser does not compute one.
  assert.equal(arrivalText({ arrives: 'today', date: '2026-11-13' }), 'Arrives today, Fri, Nov 13, 2026');
  assert.equal(
    arrivalText({ arrives: 'next_banking_day', date: '2026-11-16' }),
    "Arrives next banking day, Mon, Nov 16, 2026 (sent after today's same-day cutoff)",
  );
  assert.equal(arrivalText(null), null);
  assert.match(dialog, /arrivalText\(result\.expected_arrival\)/);
  assert.match(dialog, /Same-day ACH · No fee/);
  assert.match(dialog, /This cannot be cancelled once sent\./);
});

test('after a transfer: balance and transfer list refresh; the movement reads "Transfer to bank"', () => {
  assert.match(hook, /qc\.invalidateQueries\(\{ queryKey: \["payment-wallet", tenantId\] \}\);/);
  assert.match(hook, /qc\.invalidateQueries\(\{ queryKey: \["wallet-ops-transfers"\] \}\);/);
  assert.match(dialog, /await onTransferred\?\.\(\);/);
  assert.match(page, /wallet_withdrawal: "Transfer to bank",/);

  const summary = summarizeWalletOps({
    tenantId: 't1',
    tenantWalletPaymentMethodId: 'wallet-pm',
    tenantName: 'Acme',
    methods: [{ id: 'local-bank', tenant_id: 't1', provider_payment_method_id: 'bank-pm', bank_name: 'FIRST BANK', last_four: '1234' }],
    transfers: [{
      id: 'x1', tenant_id: 't1', amount_cents: 2500, status: 'pending', leg_role: 'wallet_withdrawal',
      description: 'Transfer to bank', destination_payment_method_id: 'local-bank', source_payment_method_id: null,
      provider_metadata: { checksops_leg: 'wallet_withdrawal', source_moov_payment_method_id: 'wallet-pm', destination_moov_payment_method_id: 'bank-credit-pm' },
      created_at: '2026-11-13T15:00:00Z',
    }],
  });
  const [row] = summary.transfers;
  assert.equal(row.purpose, 'Transfer to bank');
  assert.equal(row.isWalletSource, true);
  assert.equal(row.isWalletDestination, false);
  assert.equal(row.kind, 'pending_out');
  assert.equal(row.from_label, 'Acme Wallet');
  assert.equal(row.to_label, 'FIRST ••••1234');
  assert.equal(summary.pendingOutCents, 2500);
  // Sweeps keep their own label.
  assert.match(read('src/lib/payments/walletRelativeTransfers.ts'), /return "Sweep to bank";/);
});

test('automatic payouts stay hidden and the Manage sweeps button stays', () => {
  assert.match(flags, /^\s*SHOW_AUTOMATIC_PAYOUTS: false,$/m);
  assert.match(flags, /^\s*SHOW_SWEEPS_BUTTON: true,$/m);
  assert.match(page, /const SHOW_AUTOMATIC_PAYOUTS = PAYMENT_FLAGS\.SHOW_AUTOMATIC_PAYOUTS;/);
  assert.match(page, /\{SHOW_SWEEPS_BUTTON && \(/);
  assert.match(page, /<DialogTitle>Treasury sweeps<\/DialogTitle>/);
  // The new dialog does not bring any automatic-payout wording back.
  assert.doesNotMatch(dialog, /automatic payout/i);
});
