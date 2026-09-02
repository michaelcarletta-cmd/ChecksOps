import { denyProviderExecution } from '../provider-flags.mjs';
import { evaluateReadiness } from './readiness.mjs';

const asCapabilities = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => ({
      capability: item.capability || item.id || item.name,
      status: item.status || item.state || 'unknown',
      requirements: item.requirements || null,
    })).filter((item) => item.capability);
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([capability, status]) => ({
      capability,
      status: typeof status === 'string' ? status : status?.status || 'unknown',
      requirements: status?.requirements || null,
    }));
  }
  return [];
};

const asBanks = (metadata) => {
  const list = metadata?.banks || metadata?.bank_accounts || [];
  if (!Array.isArray(list)) return [];
  return list.map((bank) => ({
    status: bank.status || bank.verification_status || null,
    verification_status: bank.verification_status || null,
    connection_status: bank.connection_status || null,
  }));
};

export const localMoovReadiness = (account) => {
  if (!account) {
    return evaluateReadiness({
      environment: 'sandbox',
      accountId: null,
      capabilities: [],
      banks: [],
      termsAccepted: false,
    });
  }
  return evaluateReadiness({
    environment: account.environment || 'sandbox',
    accountId: account.provider_account_id || null,
    capabilities: asCapabilities(account.capabilities),
    banks: asBanks(account.provider_metadata),
    verificationStatus: account.verification_status,
    disabled: !!account.disabled,
    termsAccepted: Boolean(account.tos_accepted_at),
    feePlanCode: account.fee_plan_code || null,
    feePlanUnavailable: !account.fee_plan_code,
  });
};

export const publicMoovAccount = (account) => {
  if (!account) return null;
  return {
    id: account.id,
    tenant_id: account.tenant_id,
    provider: 'moov',
    provider_account_id: account.provider_account_id,
    environment: account.environment,
    account_type: account.account_type,
    onboarding_status: account.onboarding_status,
    verification_status: account.verification_status,
    tos_accepted_at: account.tos_accepted_at,
    tos_source: account.tos_source,
    can_send_payments: account.can_send_payments,
    can_receive_payments: account.can_receive_payments,
    can_ach_credit: account.can_ach_credit,
    can_ach_debit: account.can_ach_debit,
    disabled: account.disabled,
    restricted: account.restricted,
    fee_plan_code: account.fee_plan_code,
    display_name: account.display_name,
    last_synced_at: account.last_synced_at,
    readiness_source: 'local_snapshot',
  };
};

export const publicMoovWallet = (wallet) => {
  if (!wallet) return null;
  return {
    id: wallet.id,
    tenant_id: wallet.tenant_id,
    provider: wallet.provider,
    provider_wallet_id: wallet.provider_wallet_id,
    provider_account_id: wallet.provider_account_id,
    wallet_type: wallet.wallet_type,
    status: wallet.status,
    available_cents: wallet.available_cents,
    pending_cents: wallet.pending_cents,
    currency: wallet.currency,
    environment: wallet.environment,
    last_synced_at: wallet.last_synced_at,
  };
};

export const publicMoovTransfer = (transfer) => {
  if (!transfer) return null;
  return {
    id: transfer.id,
    tenant_id: transfer.tenant_id,
    provider: transfer.provider,
    provider_transfer_id: transfer.provider_transfer_id,
    status: transfer.status,
    provider_status: transfer.provider_status,
    amount_cents: transfer.amount_cents,
    currency: transfer.currency,
    speed: transfer.speed,
    selected_rail: transfer.selected_rail,
    wallet_id: transfer.wallet_id,
    created_at: transfer.created_at,
  };
};

export const moovExecutionStub = (operation) => denyProviderExecution('moov', operation, {
  createsOrChangesMoovAccount: /account|onboard|recipient|tos|kyc|underwriting|bank|micro|plaid-bridge|sync/i.test(operation),
  movesMoney: /transfer|disburse|fund|fee-charge|wallet-fund/i.test(operation),
});
