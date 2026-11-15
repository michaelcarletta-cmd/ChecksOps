// Wallet & Treasury "Transfer to bank" (owner, 2026-11-13: "Start the transfer to bank button"), the website
// side of the moov-wallet-withdraw API (#1876, docs/WALLET_TO_BANK_TRANSFER_DESIGN.md §6). Owner decisions:
// no fee; limits set by the tenant (empty = no limit); any member; no admin approval; same-day ACH; the same
// wallet.fund two-factor as Add funds; no email; operating wallet only; the arrival estimate comes from the API;
// changing the limits needs the two-factor code. The bank (owner 2026-11-15: "The default bank should be the
// settlement bank that each tenant sets up"): the dialog starts on the settlement bank, the same row the Settlement
// bank tile shows, and offers a picker of the organization's banks; the picked bank's id is sent to the API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  arrivalText,
  bankIneligibility,
  defaultSettlementBank,
  initialTransferBankId,
  limitInputToCents,
  maskedBankLabel,
  parseDollarsToCents,
  precheckWithdrawAmount,
  transferBankOptions,
  WALLET_WITHDRAW_FUNCTION,
  WALLET_WITHDRAW_LIMITS_FUNCTION,
  WALLET_WITHDRAW_TOTP_ACTION,
  WITHDRAW_ERROR_MESSAGES,
  withdrawErrorMessage,
} from '../../src/lib/payments/walletWithdraw.ts';
import { summarizeWalletOps } from '../../src/lib/payments/walletRelativeTransfers.ts';
import { pickSettlementMethod } from '../functions/api/providers/parity/sweep-read.mjs';

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

test('settlement bank by default, a picker of the organization\'s banks, the picked bank sent; no dead link', () => {
  // The browser sends the picked bank's row id, and nothing else that names a destination.
  const fn = wallets.slice(wallets.indexOf('export function withdrawToBank'), wallets.indexOf('const limitsOf'));
  const requestBody = fn.slice(fn.indexOf('WALLET_WITHDRAW_FUNCTION,'), fn.indexOf('},', fn.indexOf('WALLET_WITHDRAW_FUNCTION,')));
  const fields = [...requestBody.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['tenant_id', 'wallet_type', 'amount_cents', 'idempotency_key', 'bank_id', 'description']);
  assert.match(requestBody, /wallet_type: "operating",/);
  assert.match(requestBody, /bank_id: input\.bankId,/);
  assert.doesNotMatch(requestBody, /destination|payment_method|provider_bank/);
  // The dialog: a picker of every bank, ineligible ones disabled with the reason; it sends the picked bank.
  assert.match(dialog, /<Select\b/);
  assert.match(dialog, /<SelectItem key=\{option\.bank\.id\} value=\{option\.bank\.id\} disabled=\{option\.disabled\}>/);
  assert.match(dialog, /option\.reason \? ` — \$\{option\.reason\}` : ""/);
  assert.match(dialog, /option\.settlement \? " · Settlement bank" : ""/);
  assert.match(dialog, /setBankId\(initialTransferBankId\(banks\.data \?\? \[\]\)\)/);
  assert.match(dialog, /withdraw\.mutateAsync\(\{ amountCents, idempotencyKey, bankId: bank\.id \}\)/);
  assert.match(dialog, /const canSend = walletActive && !!bank && available > 0;/);
  // The dead "choose a default bank" link is gone; a plain message says what to do instead.
  assert.doesNotMatch(dialog, /Choose a default bank|default bank only|<Link|paymentsHref/);
  assert.doesNotMatch(page, /paymentsHref/);
  assert.match(dialog, /Your settlement bank cannot receive transfers yet/);
  assert.match(dialog, /No settlement bank/);
  assert.match(dialog, /Add a bank in Payment Account and verify it/);
  // The rows: the tile's (this environment, never a recipient's, default first, then newest), not only connected ones.
  assert.match(hook, /\.eq\("environment", walletEnvironment\)/);
  assert.match(hook, /\.is\("external_recipient_id", null\)/);
  assert.match(hook, /\.order\("is_default", \{ ascending: false, nullsFirst: false \}\)\s*\.order\("created_at", \{ ascending: false, nullsFirst: false \}\)/);
  assert.doesNotMatch(hook, /\.eq\("connection_status"/);
  assert.match(hook, /return transferBankOptions\(/);

  const row = (id, extra = {}) => ({
    id, bank_name: 'FIRST BANK', last_four: id.slice(-4).padStart(4, '0'), is_default: false,
    connection_status: 'connected', verification_status: 'verified', external_recipient_id: null, ...extra,
  });
  // The settlement bank is used even when is_default is false (rows a legacy sync or a re-add left that way).
  assert.equal(defaultSettlementBank([row('a')])?.id, 'a');
  // is_default is only the tiebreak: connected or verified wins first.
  assert.equal(defaultSettlementBank([row('d', { is_default: true, connection_status: 'pending', verification_status: 'pending' }), row('a')])?.id, 'a');
  assert.equal(defaultSettlementBank([row('a'), row('d', { is_default: true })])?.id, 'd');
  // A recipient's bank is never the organization's.
  assert.equal(defaultSettlementBank([row('r', { external_recipient_id: 'r1', is_default: true })]), null);
  assert.equal(defaultSettlementBank([]), null);
  assert.equal(defaultSettlementBank(null), null);
  assert.equal(maskedBankLabel(row('1234')), 'FIRST BANK ••1234');
  assert.equal(maskedBankLabel(null), 'No bank');

  // Eligibility as the browser can see it (the API checks Moov again): not linked, not verified, else pickable.
  assert.equal(bankIneligibility(row('a')), null);
  assert.equal(bankIneligibility(row('a', { verification_status: 'successful' })), null);
  assert.equal(bankIneligibility(row('a', { verification_status: null })), null, 'an empty status is left to the server');
  assert.deepEqual(bankIneligibility(row('a', { connection_status: 'disconnected' })), { code: 'not_linked', reason: 'Not linked' });
  assert.deepEqual(bankIneligibility(row('a', { connection_status: 'pending' })), { code: 'not_linked', reason: 'Not linked' });
  assert.deepEqual(bankIneligibility(row('a', { verification_status: 'pending_micro_deposit' })), { code: 'not_verified', reason: 'Not verified' });
  assert.deepEqual(bankIneligibility(row('a', { verification_status: 'unverified' })), { code: 'not_verified', reason: 'Not verified' });

  // The options: settlement bank first, every other bank listed, ineligible ones disabled with the reason.
  const rows = [
    row('d', { is_default: true, connection_status: 'pending', verification_status: 'pending' }),
    row('a'),
    row('u', { verification_status: 'unverified' }),
    row('r', { external_recipient_id: 'r1' }),
  ];
  const options = transferBankOptions(rows);
  assert.deepEqual(options.map((o) => [o.bank.id, o.settlement, o.disabled, o.reason]), [
    ['a', true, false, null],
    ['d', false, true, 'Not linked'],
    ['u', false, true, 'Not verified'],
  ]);
  assert.equal(initialTransferBankId(options), 'a');
  // When the settlement bank itself cannot receive, nothing is chosen for the user (the dialog explains).
  const stuck = transferBankOptions([row('s', { connection_status: 'disconnected', verification_status: 'verified', is_default: true }), row('b', { verification_status: 'unverified' })]);
  assert.equal(stuck[0].bank.id, 's');
  assert.equal(stuck[0].disabled, true);
  assert.equal(initialTransferBankId(stuck), null);
  assert.equal(initialTransferBankId([]), null);
});

test('the dialog\'s settlement bank is the tile\'s: the same rule as sweep-read.mjs pickSettlementMethod on the same rows', () => {
  const statuses = [
    { connection_status: 'connected', verification_status: 'verified' },
    { connection_status: 'connected', verification_status: null },
    { connection_status: 'pending', verification_status: 'verified' },
    { connection_status: 'disconnected', verification_status: 'successful' },
    { connection_status: 'pending', verification_status: 'pending' },
    { connection_status: null, verification_status: null },
  ];
  // Every list of up to three banks over these states, with and without is_default, in the tile's order.
  const banks = [];
  for (const [i, state] of statuses.entries()) for (const isDefault of [true, false, null]) banks.push({ id: `b${i}${isDefault}`, is_default: isDefault, ...state });
  const ordered = (list) => [...list].sort((a, b) => Number(b.is_default === true) - Number(a.is_default === true));
  let checked = 0;
  for (const a of banks) {
    for (const b of banks) {
      for (const c of [null, ...banks.slice(0, 6)]) {
        const list = ordered([a, b, c].filter(Boolean).filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i));
        assert.equal(defaultSettlementBank(list)?.id ?? null, pickSettlementMethod(list)?.id ?? null, JSON.stringify(list));
        checked += 1;
      }
    }
  }
  assert.ok(checked > 2000);
  assert.equal(defaultSettlementBank([]), pickSettlementMethod([]));
});

test('two-factor: the transfer and the limits both use the wallet.fund step-up and retry with the same key', () => {
  assert.equal(WALLET_WITHDRAW_TOTP_ACTION, 'wallet.fund');
  assert.match(read('src/hooks/useWallet.ts'), /actionKey: "wallet\.fund",/);
  assert.match(hook, /error\.code !== "totp_required"/);
  assert.match(hook, /requireStepUp\(\s*\{\s*actionKey: WALLET_WITHDRAW_TOTP_ACTION,/);
  assert.match(hook, /\{ force: true \}/);
  // Both mutations go through the step-up.
  assert.match(hook, /withStepUp\(\s*\(\) => withdrawToBank\(\{ tenantId, amountCents: input\.amountCents, idempotencyKey: input\.idempotencyKey, bankId: input\.bankId \}\),/);
  assert.match(hook, /withStepUp\(\(\) => saveWithdrawLimits\(tenantId, next\), "Confirm transfer limits"\)/);
  // One key per confirmation, made before Send and reused by the retry.
  assert.match(dialog, /setIdempotencyKey\(crypto\.randomUUID\(\)\);\s*setStep\("confirm"\);/);
  assert.match(dialog, /withdraw\.mutateAsync\(\{ amountCents, idempotencyKey, bankId: bank\.id \}\)/);
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
  // (Since the settlement bank change, owner 2026-11-15, the API names why the bank cannot be credited instead of
  // default_bank_required.)
  const required = [
    'no_settlement_bank', 'bank_not_found', 'settlement_bank_not_linked', 'settlement_bank_not_verified',
    'same_day_unavailable', 'tenant_limit_exceeded', 'insufficient_available_balance',
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
