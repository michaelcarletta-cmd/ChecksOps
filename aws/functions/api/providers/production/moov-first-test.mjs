import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';

export const FIRST_PRODUCTION_TRANSFER_CENTS = 1;

export const MOOV_FUND_TOTP_ACTION = 'wallet.fund';
export const MOOV_DISBURSE_TOTP_ACTION = 'wallet.disburse';
export const MOOV_DEPOSIT_TOTP_ACTION = 'deposit.submit';
export const MOOV_WALLET_TOTP_ACTIONS = Object.freeze([
  MOOV_FUND_TOTP_ACTION,
  MOOV_DISBURSE_TOTP_ACTION,
]);

export const isMoovWalletTotpAction = (actionKey) =>
  MOOV_WALLET_TOTP_ACTIONS.includes(String(actionKey || ''));

export const firstTestFundBinding = () => {
  const freedom = KNOWN_APPROVED_MOOV.freedom;
  return Object.freeze({
    tenantId: freedom.tenantId,
    actionKey: MOOV_FUND_TOTP_ACTION,
    amountCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    bankId: freedom.bankId,
    walletId: freedom.walletId,
    sourcePaymentMethodId: freedom.achDebitFundPm,
    destinationPaymentMethodId: freedom.walletPm,
    recipientId: null,
    recipientBankId: null,
    sourceLabel: freedom.fundingBankLabel,
    destinationLabel: freedom.walletLabel,
  });
};

export const firstTestDisburseBinding = () => {
  const freedom = KNOWN_APPROVED_MOOV.freedom;
  const recipient = KNOWN_APPROVED_MOOV.recipient;
  return Object.freeze({
    tenantId: freedom.tenantId,
    actionKey: MOOV_DISBURSE_TOTP_ACTION,
    amountCents: FIRST_PRODUCTION_TRANSFER_CENTS,
    bankId: freedom.bankId,
    walletId: freedom.walletId,
    sourcePaymentMethodId: freedom.walletPm,
    destinationPaymentMethodId: recipient.achCreditStandardPm,
    recipientId: recipient.recipientId,
    recipientBankId: recipient.bankId,
    sourceLabel: freedom.walletLabel,
    destinationLabel: recipient.bankLabel,
    recipientLabel: recipient.displayName,
  });
};

export const bindingForMoovWalletAction = (actionKey) => {
  if (String(actionKey) === MOOV_DISBURSE_TOTP_ACTION) return firstTestDisburseBinding();
  if (String(actionKey) === MOOV_FUND_TOTP_ACTION) return firstTestFundBinding();
  return null;
};

const claimed = (body, ...keys) => {
  for (const key of keys) {
    if (body?.[key] !== undefined && body?.[key] !== null && body?.[key] !== '') {
      return body[key];
    }
  }
  return null;
};

/** Browser IDs/amounts are hints. Mismatch against the server first-test binding is refused. */
export const mismatchFirstTestBody = (body, binding) => {
  const tenant = claimed(body, 'tenant_id', 'tenantId');
  if (tenant && String(tenant) !== binding.tenantId) {
    return {
      error: 'first_test_party_mismatch',
      field: 'tenant_id',
      statusCode: 403,
      message: 'First-test Moov send is bound to the Freedom tenant, bank, and wallet. Browser tenant_id is not authority.',
    };
  }
  const amountRaw = claimed(body, 'amount_cents', 'amountCents');
  if (amountRaw !== null) {
    const amount = Number(amountRaw);
    if (!Number.isInteger(amount) || amount <= 0) {
      return {
        error: 'invalid_amount',
        statusCode: 400,
        message: 'amount_cents must be a positive integer. Browser amount is not authority.',
      };
    }
    if (amount !== binding.amountCents) {
      return {
        error: 'first_transfer_cap',
        statusCode: 403,
        amountCents: amount,
        capCents: binding.amountCents,
        message: 'The first production Moov transfer is capped at 1 cent until a later reviewed raise. Browser amount is not authority.',
      };
    }
  }
  const recipient = claimed(body, 'external_recipient_id', 'recipient_id', 'recipientId');
  if (binding.recipientId && recipient && String(recipient) !== binding.recipientId) {
    return {
      error: 'first_test_party_mismatch',
      field: 'recipient_id',
      statusCode: 403,
      message: 'First-test WALLET→RECIPIENT is bound to the approved pay-setup recipient. Browser recipient id is not authority.',
    };
  }
  const bank = claimed(body, 'bank_id', 'bankId', 'source_bank_id');
  if (binding.bankId && bank && String(bank) !== binding.bankId) {
    return {
      error: 'first_test_party_mismatch',
      field: 'bank_id',
      statusCode: 403,
      message: 'First-test Moov send is bound to the Freedom verified bank. Browser bank id is not authority.',
    };
  }
  const wallet = claimed(body, 'wallet_id', 'walletId');
  if (binding.walletId && wallet && String(wallet) !== binding.walletId) {
    return {
      error: 'first_test_party_mismatch',
      field: 'wallet_id',
      statusCode: 403,
      message: 'First-test Moov send is bound to the Freedom wallet. Browser wallet id is not authority.',
    };
  }
  return null;
};
