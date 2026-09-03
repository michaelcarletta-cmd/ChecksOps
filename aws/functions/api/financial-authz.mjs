/**
 * Server-side financial authorization is separate from application login.
 *
 * Existing ChecksOps `has_permission()` is CRUD only (read/create/update/delete/
 * export/reveal_pii/manage_users/view_audit_logs). It is NOT money-movement
 * authority.
 *
 * Production money movement today uses:
 *   - tenant role owner/admin/manager (Moov Edge Function)
 *   - frontend step-up 2FA (`useFinancialGuard`) for deposit.submit,
 *     deposit.approve, disbursement.send, payroll.run
 *
 * This gate documents the required financial permissions and keeps them
 * deactivated. Authenticated + tenant member + admin/staff does NOT grant
 * production money movement.
 */

export const FINANCIAL_ROLES = new Set(['owner', 'admin', 'manager']);

export const FINANCIAL_OPERATIONS = {
  checkalt_deposit: {
    operation: 'checkalt_deposit',
    permission: 'deposit.submit',
    providers: ['checkalt'],
    who: 'Tenant owner/admin/manager + deposit.submit + step-up. NOT activated.',
    canRetry: true,
    canCancel: false,
    activated: false,
  },
  checkalt_approve: {
    operation: 'checkalt_approve',
    permission: 'deposit.approve',
    providers: ['checkalt'],
    who: 'Tenant owner/admin/manager + deposit.approve + step-up. NOT activated.',
    canRetry: false,
    canCancel: false,
    activated: false,
  },
  wallet_fund: {
    operation: 'wallet_fund',
    permission: 'wallet.fund',
    providers: ['moov'],
    who: 'Tenant owner/admin/manager + wallet.fund. NOT activated.',
    canRetry: true,
    canCancel: true,
    activated: false,
  },
  disbursement: {
    operation: 'disbursement',
    permission: 'disbursement.send',
    providers: ['moov', 'plaid'],
    who: 'Tenant owner/admin/manager + disbursement.send + step-up. NOT activated.',
    canRetry: true,
    canCancel: true,
    activated: false,
  },
  ach: {
    operation: 'ach',
    permission: 'payments.ach',
    providers: ['moov'],
    who: 'Same as disbursement plus send-funds.ach capability. NOT activated.',
    canRetry: true,
    canCancel: false,
    activated: false,
  },
  rtp: {
    operation: 'rtp',
    permission: 'payments.rtp',
    providers: ['moov'],
    who: 'Same as ACH plus RTP capability and requested_speed=instant. NOT activated.',
    canRetry: true,
    canCancel: false,
    activated: false,
  },
  wire: {
    operation: 'wire',
    permission: 'payments.wire',
    providers: ['moov'],
    who: 'Not a current production Moov primary rail. Documented, blocked. NOT activated.',
    canRetry: false,
    canCancel: false,
    activated: false,
  },
  pay_homeowner: {
    operation: 'pay_homeowner',
    permission: 'stakeholder.pay',
    providers: ['moov'],
    who: 'Tenant owner/admin/manager + stakeholder.pay. NOT activated.',
    canRetry: true,
    canCancel: true,
    activated: false,
  },
  pay_contractor: {
    operation: 'pay_contractor',
    permission: 'contractor.pay',
    providers: ['moov', 'plaid'],
    who: 'Tenant owner/admin/manager + contractor.pay / disbursement.send. NOT activated.',
    canRetry: true,
    canCancel: true,
    activated: false,
  },
  pay_vendor: {
    operation: 'pay_vendor',
    permission: 'contractor.pay',
    providers: ['moov'],
    who: 'Same as pay_contractor. NOT activated.',
    canRetry: true,
    canCancel: true,
    activated: false,
  },
  retry_failed: {
    operation: 'retry_failed',
    permission: '(same as original operation)',
    providers: ['checkalt', 'moov', 'plaid'],
    who: 'Requires the original operation permission. NOT activated.',
    canRetry: false,
    canCancel: false,
    activated: false,
  },
  cancel: {
    operation: 'cancel',
    permission: '(same as original operation, where supported)',
    providers: ['moov'],
    who: 'Wallet funding cancel is the only production-supported cancel. NOT activated.',
    canRetry: false,
    canCancel: false,
    activated: false,
  },
};

export const financialPermissionSnapshot = () => (
  Object.fromEntries(
    Object.entries(FINANCIAL_OPERATIONS).map(([key, value]) => [
      key,
      { ...value, activated: false },
    ]),
  )
);

export const roleAllowsFinancial = (roles = []) =>
  roles.some((role) => FINANCIAL_ROLES.has(String(role || '').toLowerCase()));

/**
 * Evaluate the financial gate. Production execution is never allowed while
 * permissions remain deactivated. Sandbox simulation may proceed when the
 * caller is an authenticated tenant member with a documented financial role
 * and AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED=true.
 */
export const evaluateFinancialAuthorization = ({
  operation,
  identityOk,
  membershipOk,
  roles = [],
  simulationEnabled,
  permissionsActivated,
} = {}) => {
  const spec = FINANCIAL_OPERATIONS[operation] || null;
  const roleOk = roleAllowsFinancial(roles);
  const canExecuteProduction = Boolean(
    identityOk && membershipOk && roleOk && permissionsActivated && spec,
  );
  const canSimulate = Boolean(
    identityOk && membershipOk && roleOk && simulationEnabled && spec,
  );
  return {
    operation: operation || null,
    spec,
    identityOk: Boolean(identityOk),
    membershipOk: Boolean(membershipOk),
    roleOk,
    financialPermissionActivated: Boolean(permissionsActivated),
    canExecuteProduction: false,
    canSimulate,
    activated: false,
    message: canExecuteProduction
      ? 'Production financial permissions must stay deactivated on this phase.'
      : canSimulate
        ? 'Sandbox simulation authorized. Production money movement remains blocked.'
        : 'Financial authorization denied.',
  };
};

export const denyFinancialPermission = (operation, extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: 'financial_unauthorized',
  operation,
  activated: false,
  message: 'Application login is not financial execution authority. This permission is documented and not activated.',
  requirements: FINANCIAL_OPERATIONS[operation] || null,
  ...extra,
});
