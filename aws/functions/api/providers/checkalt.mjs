import { denyProviderExecution } from '../provider-flags.mjs';
import { formatCheckAltUserAmount, mapCheckAltStatus } from './amounts.mjs';

export const publicCheckAltAccount = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    enabled: row.enabled,
    registered_at: row.registered_at,
    auto_approve_enabled: row.auto_approve_enabled,
    has_deposit_account: Boolean(row.deposit_account_number),
    has_sso_user: Boolean(row.sso_user_id),
  };
};

export const publicCheckAltDeposit = (row) => {
  if (!row) return null;
  const formatted = row.amount == null ? null : formatCheckAltUserAmount(row.amount);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    check_intake_item_id: row.check_intake_item_id,
    checkalt_reference: row.checkalt_reference,
    status: row.status,
    amount: row.amount,
    amount_integer_cents: formatted?.userAmount ?? null,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    cleared_at: row.cleared_at,
    returned_at: row.returned_at,
    last_polled_at: row.last_polled_at,
  };
};

export const checkAltAmountPreview = (dollarAmount) => {
  const formatted = formatCheckAltUserAmount(dollarAmount);
  if (formatted.error) return formatted;
  return {
    ok: true,
    ...formatted,
    submitted: false,
    liveDeposit: false,
  };
};

export { mapCheckAltStatus };

export const checkaltExecutionStub = (operation) => denyProviderExecution('checkalt', operation, {
  submitsDeposit: /submit|approve|prepare-image/i.test(operation),
});
