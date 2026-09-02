import { denyProviderExecution } from '../provider-flags.mjs';

export const publicPlaidStatus = ({ items = [], transfers = [] } = {}) => ({
  provider: 'plaid',
  liveItemConnected: false,
  sandboxIsolated: true,
  items: items.map((item) => ({
    id: item.id,
    tenant_id: item.tenant_id,
    status: item.status || 'unknown',
    has_item: Boolean(item.plaid_item_id || item.provider_item_id),
  })),
  transfers: transfers.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    provider_transfer_id: row.plaid_transfer_id || row.provider_transfer_id || null,
    status: row.status,
    amount: row.amount,
  })),
});

export const plaidExecutionStub = (operation) => denyProviderExecution('plaid', operation, {
  connectsAccount: /link-token|exchange/i.test(operation),
  movesMoney: /disburse|transfer/i.test(operation),
});
