export const WALLET_OP = Object.freeze({
  BALANCE_READ: 'BALANCE_READ',
  FUNDING: 'FUNDING',
  TRANSFER: 'TRANSFER',
  DISBURSEMENT: 'DISBURSEMENT',
  SWEEP: 'SWEEP',
});

export const classifyWalletOperation = (name) => {
  if (name === 'moov-readiness' || name === 'moov-wallet-activity' || name === 'moov-wallet-sync') {
    return WALLET_OP.BALANCE_READ;
  }
  if (name === 'initiate-wallet-funding' || name === 'moov-wallet-fund' || name === 'wallet-fund-on-clear') {
    return WALLET_OP.FUNDING;
  }
  if (name === 'moov-transfer-create' || name === 'moov-transfer-group-create') return WALLET_OP.TRANSFER;
  if (name === 'moov-disburse' || name === 'process-funded-payment') return WALLET_OP.DISBURSEMENT;
  if (name === 'moov-sweep-config') return WALLET_OP.SWEEP;
  return null;
};

export const walletMutationHeld = (name) => classifyWalletOperation(name) !== WALLET_OP.BALANCE_READ;

export const publicWalletBalance = (wallet = {}) => ({
  status: wallet.status || null,
  available_cents: wallet.availableBalance?.value ?? wallet.available_cents ?? null,
  pending_cents: wallet.pendingBalance?.value ?? wallet.pending_cents ?? null,
  currency: wallet.availableBalance?.currency || wallet.currency || 'USD',
});

export const walletActivityFromLedger = (rows = []) => (rows || []).map((row) => ({
  id: row.id,
  direction: row.direction || row.leg_role || null,
  amount_cents: row.amount_cents ?? null,
  status: row.status || null,
  created_at: row.created_at || null,
  provider_transfer_id_present: Boolean(row.provider_transfer_id),
}));
