import { capabilitiesStillNeeded, capabilityEnabled } from './moov-capability-policy.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import { listOf, productionMoovFetch } from './moov-http.mjs';

const verificationOf = (account) => String(
  account?.profile?.business?.verification?.status
  ?? account?.profile?.individual?.verification?.status
  ?? account?.verification?.status
  ?? '',
).toLowerCase();

export const liveTosAccepted = (account = {}) => Boolean(
  account?.termsOfService?.acceptedDate
  || account?.termsOfService?.acceptedOn
  || account?.termsOfService?.accepted === true,
);

export const sweepBlocksFirstCent = (sweeps = []) => {
  const list = Array.isArray(sweeps) ? sweeps : listOf(sweeps);
  return list.some((row) => {
    const status = String(row?.status || '').toLowerCase();
    if (status !== 'enabled') return false;
    const min = Number(row?.minimumBalance?.value ?? row?.minBalance ?? row?.minimumBalance ?? 0);
    return !Number.isFinite(min) || min <= 0;
  });
};

export const summarizeApprovedAccount = ({
  label,
  account,
  capabilities,
  banks,
  paymentMethods,
  wallets,
  sweeps,
  requiredCapabilities = ['send-funds.ach', 'wallet.balance', 'collect-funds.ach', 'transfers'],
} = {}) => {
  const caps = listOf(capabilities);
  const bankList = listOf(banks);
  const methods = listOf(paymentMethods);
  const walletList = listOf(wallets);
  const sweepList = listOf(sweeps);
  const verification = verificationOf(account);
  const needed = capabilitiesStillNeeded(caps, requiredCapabilities);
  return {
    label,
    accountId: account?.accountID || account?.accountId || null,
    displayName: account?.profile?.business?.legalBusinessName
      || account?.displayName
      || account?.profile?.individual?.name?.firstName
      || null,
    verification,
    verified: verification === 'verified',
    tosAccepted: liveTosAccepted(account),
    disabled: Boolean(account?.disabledOn),
    capabilities: caps.map((row) => ({ capability: row.capability, status: row.status })),
    canSend: capabilityEnabled(caps, 'send-funds'),
    canCollect: capabilityEnabled(caps, 'collect-funds'),
    canTransfer: capabilityEnabled(caps, 'transfers'),
    canWallet: capabilityEnabled(caps, 'wallet'),
    capabilitiesStillNeeded: needed,
    reKycRequired: needed.length > 0,
    banks: bankList.map((row) => ({
      bankAccountID: row.bankAccountID || row.bankAccountId || null,
      bankName: row.bankName || null,
      lastFour: row.lastFourAccountNumber || null,
      status: row.status || null,
    })),
    verifiedBank: bankList.some((row) => String(row.status || '').toLowerCase() === 'verified'),
    paymentMethodTypes: methods.map((row) => row.paymentMethodType).filter(Boolean),
    walletCount: walletList.length,
    sweepEnabledMinZero: sweepBlocksFirstCent(sweepList),
  };
};

export const assertNoReKyc = (summary) => {
  if (summary.reKycRequired) {
    return {
      ok: false,
      statusCode: 409,
      error: 'capabilities_missing_do_not_auto_request',
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      missing: summary.capabilitiesStillNeeded,
      message: 'Required capability families are absent. Do not auto-request; that re-opens billed KYC/KYB. Review with a human before requesting.',
    };
  }
  if (!summary.verified) {
    return {
      ok: false,
      statusCode: 409,
      error: 'identity_not_verified',
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      message: 'Moov identity is not verified. Do not submit KYC/KYB from ChecksOps.',
    };
  }
  return { ok: true };
};

export async function getApprovedAccountSnapshot({
  credentials,
  known = KNOWN_APPROVED_MOOV.freedom,
  fetchImpl,
  includeSweeps = true,
} = {}) {
  const accountId = known.moovAccountId;
  const account = await productionMoovFetch({
    credentials, path: `/accounts/${accountId}`, fetchImpl,
  });
  const capabilities = await productionMoovFetch({
    credentials, path: `/accounts/${accountId}/capabilities`, fetchImpl,
  }).catch(() => []);
  const banks = await productionMoovFetch({
    credentials, path: `/accounts/${accountId}/bank-accounts`, fetchImpl,
  }).catch(() => []);
  const paymentMethods = await productionMoovFetch({
    credentials, path: `/accounts/${accountId}/payment-methods`, fetchImpl,
  }).catch(() => []);
  let wallets = [];
  let sweeps = [];
  if (known.walletId) {
    wallets = [await productionMoovFetch({
      credentials, path: `/accounts/${accountId}/wallets/${known.walletId}`, fetchImpl,
    }).catch(() => null)].filter(Boolean);
    if (includeSweeps) {
      sweeps = await productionMoovFetch({
        credentials, path: `/accounts/${accountId}/wallets/${known.walletId}/sweeps`, fetchImpl,
      }).catch(() => []);
    }
  }
  return summarizeApprovedAccount({
    label: known.label,
    account,
    capabilities,
    banks,
    paymentMethods,
    wallets,
    sweeps,
    requiredCapabilities: known.walletId
      ? ['send-funds.ach', 'wallet.balance', 'collect-funds.ach', 'transfers']
      : ['transfers'],
  });
}
