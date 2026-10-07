/**
 * Source-only TMP write-policy reconcile contract.
 * Built from the 2026-10-05 staging catalog inspection.
 * Does not connect to staging. Does not apply SQL.
 */

export const INSPECTED_CATALOG = Object.freeze({
  capturedAt: '2026-10-05T18:25:00Z',
  table: 'public.tenant_maintenance_payments',
  owner: 'checksops_admin',
  relrowsecurity: true,
  relforcerowsecurity: false,
  lambdaRole: 'checksops',
  lambdaMembership: Object.freeze(['authenticated']),
  grants: Object.freeze({
    authenticated: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    checksops: Object.freeze(['SELECT', 'INSERT', 'UPDATE']),
    PUBLIC: Object.freeze([]),
    anon: Object.freeze([]),
  }),
  driftedWriteUsing:
    '(is_platform_owner() OR aws_monthly_billing_job() OR (current_setting(\'request.provider_webhook_apply\'::text, true) = \'1\'::text))',
  intendedWriteUsing: 'public.aws_can_write_tenant(tenant_id)',
  jobUsing:
    '(aws_monthly_billing_job() OR (current_setting(\'request.provider_webhook_apply\'::text, true) = \'1\'::text))',
});

export const LIVE_POLICIES = Object.freeze([
  Object.freeze({
    name: 'aws_write_tenant_maintenance_payments',
    permissive: 'PERMISSIVE',
    command: 'ALL',
    roles: Object.freeze(['authenticated']),
    kind: 'drifted_authenticated_write',
    using: INSPECTED_CATALOG.driftedWriteUsing,
    withCheck: INSPECTED_CATALOG.driftedWriteUsing,
  }),
  Object.freeze({
    name: 'aws_write_tenant_maintenance_payments_job',
    permissive: 'PERMISSIVE',
    command: 'ALL',
    roles: Object.freeze(['checksops']),
    kind: 'machine_write',
    using: INSPECTED_CATALOG.jobUsing,
    withCheck: INSPECTED_CATALOG.jobUsing,
  }),
  Object.freeze({
    name: 'aws_select_tenant_maintenance_payments',
    permissive: 'PERMISSIVE',
    command: 'SELECT',
    roles: Object.freeze(['authenticated']),
    kind: 'select',
    using: '(aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id))',
    withCheck: null,
  }),
  Object.freeze({
    name: 'aws_select_tenant_maintenance_payments_job',
    permissive: 'PERMISSIVE',
    command: 'SELECT',
    roles: Object.freeze(['checksops']),
    kind: 'select',
    using: 'aws_monthly_billing_job()',
    withCheck: null,
  }),
]);

export const AFTER_REPAIR_POLICIES = Object.freeze(LIVE_POLICIES.map((policy) => (
  policy.name === 'aws_write_tenant_maintenance_payments'
    ? Object.freeze({
      ...policy,
      kind: 'intended_authenticated_write',
      using: INSPECTED_CATALOG.intendedWriteUsing,
      withCheck: INSPECTED_CATALOG.intendedWriteUsing,
    })
    : policy
)));

export const REMAINING_POLICY_NAMES = Object.freeze([
  'aws_select_tenant_maintenance_payments',
  'aws_select_tenant_maintenance_payments_job',
  'aws_write_tenant_maintenance_payments',
  'aws_write_tenant_maintenance_payments_job',
]);

/** Live Collection V2 product SQL captured from the accepted staging package. */
export const COLLECTION_V2_CREATE_OR_GET_OCCURRENCE_INSERT = `INSERT INTO public.tenant_maintenance_payments (
       tenant_id, amount_cents, monthly_rate_cents, discount_cents,
       period_start, period_end, billing_period, method, status,
       idempotence_key, recorded_by, notes,
       funding_source_method_id, destination_account_id, destination_payment_method_id,
       provider_environment,
       maintenance_net_cents, check_usage_cents, next_day_usage_cents, same_day_usage_cents,
       usage_total_cents, check_count, next_day_count, same_day_count,
       mortgage_ops_initial_count, mortgage_ops_initial_amount_cents,
       mortgage_ops_additional_count, mortgage_ops_additional_amount_cents,
       occurrence_kind
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::date, $6::date, $7, 'moov_ach', 'due',
       $8, $9::uuid, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
     )`;

export const COLLECTION_V2_SETTLEMENT_UPDATE = `UPDATE public.tenant_maintenance_payments SET
       status = $2,
       settled_at = CASE
         WHEN $2 = 'settled' THEN COALESCE(settled_at, $4::timestamptz, now())
         ELSE settled_at
       END,
       returned_at = CASE WHEN $2 = 'returned' THEN COALESCE(returned_at, now()) ELSE returned_at END,
       return_reason = CASE WHEN $2 = 'returned' THEN COALESCE($3, return_reason) ELSE return_reason END,
       failure_reason = CASE WHEN $2 IN ('failed','returned') THEN COALESCE($3, failure_reason) ELSE failure_reason END
     WHERE id = $1::uuid`;

export function evaluateAwsCanWriteTenant(ctx, tenantId) {
  const authenticated = Boolean(ctx.uid);
  const access = Boolean(ctx.isPlatformOwner) || (Array.isArray(ctx.tenantIds) && ctx.tenantIds.includes(tenantId));
  const writer = Boolean(ctx.isPlatformOwner) || ctx.hasAdmin === true || ctx.hasStaff === true;
  return Boolean(authenticated && tenantId && access && writer);
}

export function evaluateMachineWrite(ctx) {
  return ctx.monthlyBillingJob === true || ctx.providerWebhookApply === true;
}

export function evaluateDriftedAuthenticatedWrite(ctx) {
  return ctx.isPlatformOwner === true || evaluateMachineWrite(ctx);
}

function roleApplies(policyRoles, currentRole, memberships) {
  if (policyRoles.includes(currentRole)) return true;
  return policyRoles.some((role) => memberships.includes(role));
}

function evaluatePolicy(policy, ctx, tenantId) {
  if (policy.kind === 'drifted_authenticated_write') return evaluateDriftedAuthenticatedWrite(ctx);
  if (policy.kind === 'intended_authenticated_write') return evaluateAwsCanWriteTenant(ctx, tenantId);
  if (policy.kind === 'machine_write') return evaluateMachineWrite(ctx);
  return false;
}

export function evaluateTmpWrite({
  policies,
  command,
  currentRole = 'checksops',
  memberships = ['authenticated'],
  ctx,
  tenantId,
}) {
  const applicable = policies.filter((policy) => (
    (policy.command === 'ALL' || policy.command === command)
    && roleApplies(policy.roles, currentRole, memberships)
  ));
  const restrictive = applicable.filter((policy) => policy.permissive === 'RESTRICTIVE');
  if (restrictive.some((policy) => !evaluatePolicy(policy, ctx, tenantId))) {
    return { allowed: false, reason: 'restrictive_deny', applicable: applicable.map((p) => p.name) };
  }
  const permissive = applicable.filter((policy) => policy.permissive === 'PERMISSIVE');
  const passed = permissive.filter((policy) => evaluatePolicy(policy, ctx, tenantId));
  if (passed.length === 0) {
    return { allowed: false, reason: 'default_deny', applicable: applicable.map((p) => p.name) };
  }
  return { allowed: true, reason: passed.map((p) => p.name).join(','), applicable: applicable.map((p) => p.name) };
}

export function actorMatrix(policies) {
  const T1 = 'db13cc17-547b-4ca8-806a-f3cf79eafe59';
  const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const lambda = { currentRole: 'checksops', memberships: ['authenticated'] };
  const cases = [
    {
      name: 'authorized_tenant_admin_insert',
      command: 'INSERT',
      tenantId: T1,
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
    {
      name: 'unauthorized_tenant_insert',
      command: 'INSERT',
      tenantId: T2,
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
    {
      name: 'authorized_tenant_update',
      command: 'UPDATE',
      tenantId: T1,
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
    {
      name: 'cross_tenant_update',
      command: 'UPDATE',
      tenantId: T2,
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
    {
      name: 'ordinary_user_foreign_insert',
      command: 'INSERT',
      tenantId: T2,
      ctx: { uid: '11111111-1111-4111-8111-111111111111', tenantIds: [T1], hasAdmin: false },
    },
    {
      name: 'monthly_billing_job',
      command: 'INSERT',
      tenantId: T2,
      ctx: { monthlyBillingJob: true },
    },
    {
      name: 'provider_webhook_apply',
      command: 'UPDATE',
      tenantId: T2,
      ctx: { providerWebhookApply: true },
    },
    {
      name: 'platform_owner_insert',
      command: 'INSERT',
      tenantId: T2,
      ctx: { uid: '7dbb3009-0000-4000-8000-000000000001', isPlatformOwner: true, tenantIds: [] },
    },
    {
      name: 'public_role_insert',
      command: 'INSERT',
      tenantId: T1,
      currentRole: 'PUBLIC',
      memberships: [],
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
    {
      name: 'anon_insert',
      command: 'INSERT',
      tenantId: T1,
      currentRole: 'anon',
      memberships: [],
      ctx: {},
    },
    {
      name: 'collection_v2_create_or_get_occurrence',
      command: 'INSERT',
      tenantId: T1,
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
    {
      name: 'collection_v2_settlement_update',
      command: 'UPDATE',
      tenantId: T1,
      ctx: { uid: '75d3da03-326c-4ea0-8cd1-684d695495a3', tenantIds: [T1], hasAdmin: true },
    },
  ];
  return cases.map((row) => {
    const result = evaluateTmpWrite({
      policies,
      command: row.command,
      currentRole: row.currentRole || lambda.currentRole,
      memberships: row.memberships || lambda.memberships,
      ctx: row.ctx,
      tenantId: row.tenantId,
    });
    return { name: row.name, command: row.command, tenantId: row.tenantId, ...result };
  });
}

export function naiveReplaceRemovesMachineWrite(policiesWithoutJob) {
  const job = evaluateTmpWrite({
    policies: policiesWithoutJob,
    command: 'INSERT',
    ctx: { monthlyBillingJob: true },
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  });
  return job.allowed === false;
}
