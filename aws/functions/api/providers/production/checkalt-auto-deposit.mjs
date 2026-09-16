/**
 * Tenant CheckAlt Auto-Deposit.
 *
 * Reuses evaluateCheckAltDepositPreflight + handleProductionCheckAltSubmit.
 * Does not implement a parallel FinCapture client.
 * Does not reuse auto_approve_* (status-40 helpers, not auto-submit).
 * Settings changes never sweep existing Ready checks.
 */
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { roleAllowsFinancial } from '../../financial-authz.mjs';
import { productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';
import { evaluateCheckAltDepositPreflight } from './checkalt-preflight.mjs';
import { handleProductionCheckAltSubmit } from './checkalt-submit.mjs';
import { loadDepositsForCheck, pickBlockingDeposit } from './checkalt-idempotency.mjs';
import { loadTenantRole, serverAmountCentsFromCheck } from './checkalt-authz.mjs';

export const CHECKALT_AUTO_DEPOSIT_CONFIGURE_ACTION = 'checkalt.auto_deposit.configure';
export const AUTO_DEPOSIT_CONFIG_ROLES = new Set(['owner', 'admin']);
export const AUTO_DEPOSIT_ACTOR = 'system:auto_deposit';
export const AUTO_DEPOSIT_CONFIG_TTL_MS = 30 * 60 * 1000;

export const AUTO_DEPOSIT_REASONS = Object.freeze({
  SETTING_OFF: 'setting_off',
  ABOVE_THRESHOLD: 'above_threshold',
  PREEXISTING_READY: 'preexisting_ready',
  ALREADY_HAS_REFERENCE: 'already_has_reference',
  UNCERTAIN_BLOCKED: 'uncertain_blocked',
  GATES_FAILED: 'gates_failed',
  NOT_READY: 'not_ready',
  AMOUNT_INVALID: 'amount_invalid',
  INVALID_THRESHOLD: 'invalid_threshold',
  DEPOSITOR_DISABLED: 'depositor_disabled',
  PRODUCTION_BLOCKED: 'production_execution_blocked',
  EXECUTED: 'executed',
  DUPLICATE_BLOCKED: 'duplicate_blocked',
});

export const AUTO_DEPOSIT_TRIGGERS = Object.freeze({
  READY_TRANSITION: 'ready_transition',
  SETTINGS_CHANGE: 'settings_change',
});

export const roleAllowsAutoDepositConfig = (roles = []) =>
  (roles || []).some((role) => AUTO_DEPOSIT_CONFIG_ROLES.has(String(role || '').toLowerCase()));

export const wasAlreadyReady = (check = {}) => {
  const status = String(check.status || '');
  const stage = String(check.check_stage || '');
  return status === 'approved_for_deposit' || stage === 'ready_for_deposit';
};

export const isReadyForDeposit = (check = {}) => {
  const status = String(check.status || '');
  const stage = String(check.check_stage || '');
  return status === 'approved_for_deposit' && stage === 'ready_for_deposit';
};

export const emptyAutoDepositSetting = (tenantId) => ({
  tenant_id: tenantId,
  auto_deposit_enabled: false,
  auto_deposit_max_cents: null,
  auto_deposit_updated_at: null,
  auto_deposit_updated_by: null,
});

export function evaluateAutoDepositPolicy({
  setting,
  check,
  previous,
  amountCents,
  trigger,
} = {}) {
  const snapshot = {
    auto_deposit_enabled: setting?.auto_deposit_enabled === true,
    auto_deposit_max_cents: Number.isInteger(Number(setting?.auto_deposit_max_cents))
      ? Number(setting.auto_deposit_max_cents)
      : null,
  };
  if (trigger === AUTO_DEPOSIT_TRIGGERS.SETTINGS_CHANGE) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.PREEXISTING_READY, ...snapshot };
  }
  if (!snapshot.auto_deposit_enabled) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.SETTING_OFF, ...snapshot };
  }
  if (!Number.isInteger(snapshot.auto_deposit_max_cents) || snapshot.auto_deposit_max_cents < 0) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.INVALID_THRESHOLD, ...snapshot };
  }
  if (!isReadyForDeposit(check)) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.NOT_READY, ...snapshot };
  }
  if (wasAlreadyReady(previous)) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.PREEXISTING_READY, ...snapshot };
  }
  const enteredAt = check.ready_entered_at || check.updated_at || null;
  const settingAt = setting?.auto_deposit_updated_at || null;
  if (settingAt && enteredAt && new Date(enteredAt) <= new Date(settingAt)) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.PREEXISTING_READY, ...snapshot };
  }
  if (!Number.isInteger(Number(amountCents))) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.AMOUNT_INVALID, ...snapshot };
  }
  if (Number(amountCents) > snapshot.auto_deposit_max_cents) {
    return { eligible: false, reason: AUTO_DEPOSIT_REASONS.ABOVE_THRESHOLD, ...snapshot };
  }
  return {
    eligible: true,
    reason: Number(amountCents) === snapshot.auto_deposit_max_cents ? 'at_threshold' : 'below_threshold',
    ...snapshot,
  };
}

export async function loadAutoDepositSetting(client, tenantId) {
  if (!tenantId) return emptyAutoDepositSetting(null);
  try {
    const row = (await client.query(
      `SELECT tenant_id, auto_deposit_enabled, auto_deposit_max_cents,
              auto_deposit_updated_at, auto_deposit_updated_by
       FROM public.checkalt_tenant_deposit_settings
       WHERE tenant_id = $1::uuid
       LIMIT 1`,
      [tenantId],
    )).rows[0];
    return row || emptyAutoDepositSetting(tenantId);
  } catch {
    return emptyAutoDepositSetting(tenantId);
  }
}

export async function recordAutoDepositDecision(client, decision) {
  const row = (await client.query(
    `INSERT INTO public.checkalt_auto_deposit_decisions (
       tenant_id, check_intake_item_id, amount_cents, auto_deposit_enabled,
       auto_deposit_max_cents, eligible, reason, trigger, actor,
       deposit_id, checkalt_reference, submit_result
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12::jsonb
     )
     RETURNING *`,
    [
      decision.tenant_id,
      decision.check_intake_item_id || null,
      Number.isInteger(Number(decision.amount_cents)) ? Number(decision.amount_cents) : null,
      decision.auto_deposit_enabled === true,
      Number.isInteger(Number(decision.auto_deposit_max_cents)) ? Number(decision.auto_deposit_max_cents) : null,
      decision.eligible === true,
      decision.reason,
      decision.trigger,
      decision.actor || AUTO_DEPOSIT_ACTOR,
      decision.deposit_id || null,
      decision.checkalt_reference || null,
      JSON.stringify(decision.submit_result || {}),
    ],
  )).rows[0];
  return row;
}

export async function loadRecentReadyTransitionEvidence(client, { check, setting } = {}) {
  if (!check?.id) return null;
  const since = setting?.auto_deposit_updated_at;
  try {
    const review = (await client.query(
      `SELECT id, deposit_path, created_at
       FROM public.check_review_decisions
       WHERE check_id = $1::uuid
         AND deposit_path = 'approved_for_deposit'
         ${since ? 'AND created_at > $2::timestamptz' : ''}
       ORDER BY created_at DESC
       LIMIT 1`,
      since ? [check.id, since] : [check.id],
    )).rows[0];
    if (review) {
      return { source: 'check_review_decisions', from_status: null, created_at: review.created_at };
    }
  } catch {
    /* table may be absent in isolated tests */
  }
  try {
    const audit = (await client.query(
      `SELECT id, event_data, created_at
       FROM public.check_audit_log
       WHERE check_id = $1::uuid
         AND event_type = 'aws_workflow_transition'
         ${since ? 'AND created_at > $2::timestamptz' : ''}
       ORDER BY created_at DESC
       LIMIT 5`,
      since ? [check.id, since] : [check.id],
    )).rows;
    const ready = (audit || []).find((row) => (
      row.event_data?.to_status === 'approved_for_deposit'
      || row.event_data?.to_stage === 'ready_for_deposit'
    ));
    if (ready) {
      return {
        source: 'check_audit_log',
        from_status: ready.event_data?.from_status || null,
        created_at: ready.created_at,
      };
    }
  } catch {
    /* isolated tests may not have audit rows */
  }
  return null;
}

const blockingReason = (blocking) => {
  if (!blocking) return null;
  if (blocking.checkalt_reference) return AUTO_DEPOSIT_REASONS.ALREADY_HAS_REFERENCE;
  return AUTO_DEPOSIT_REASONS.UNCERTAIN_BLOCKED;
};

export async function maybeRunCheckAltAutoDeposit({
  client,
  mapping,
  claims,
  check,
  previous,
  trigger = AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
  spoof = {},
  deps = {},
} = {}) {
  const setting = deps.setting || await loadAutoDepositSetting(client, check?.tenant_id);
  const amountCents = serverAmountCentsFromCheck(check);
  let resolvedPrevious = previous;
  if (resolvedPrevious === undefined && trigger === AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION) {
    const evidence = await loadRecentReadyTransitionEvidence(client, { check, setting });
    resolvedPrevious = evidence
      ? { status: evidence.from_status || 'endorsements_complete', check_stage: 'endorsing' }
      : { status: check?.status, check_stage: check?.check_stage };
    if (!evidence) {
      const skipped = evaluateAutoDepositPolicy({
        setting,
        check,
        previous: { status: 'approved_for_deposit', check_stage: 'ready_for_deposit' },
        amountCents,
        trigger,
      });
      const decision = await recordAutoDepositDecision(client, {
        tenant_id: check?.tenant_id,
        check_intake_item_id: check?.id,
        amount_cents: amountCents,
        auto_deposit_enabled: skipped.auto_deposit_enabled,
        auto_deposit_max_cents: skipped.auto_deposit_max_cents,
        eligible: false,
        reason: AUTO_DEPOSIT_REASONS.PREEXISTING_READY,
        trigger,
      });
      return {
        submitted: false,
        eligible: false,
        reason: AUTO_DEPOSIT_REASONS.PREEXISTING_READY,
        interactiveTotp: false,
        decision,
      };
    }
  }

  const policy = evaluateAutoDepositPolicy({
    setting,
    check,
    previous: resolvedPrevious,
    amountCents,
    trigger,
  });
  if (!policy.eligible) {
    const decision = await recordAutoDepositDecision(client, {
      tenant_id: check?.tenant_id,
      check_intake_item_id: check?.id,
      amount_cents: amountCents,
      auto_deposit_enabled: policy.auto_deposit_enabled,
      auto_deposit_max_cents: policy.auto_deposit_max_cents,
      eligible: false,
      reason: policy.reason,
      trigger,
    });
    return {
      submitted: false,
      eligible: false,
      reason: policy.reason,
      interactiveTotp: false,
      decision,
    };
  }

  const existing = await loadDepositsForCheck(client, {
    tenantId: check.tenant_id,
    checkId: check.id,
  });
  const blocking = pickBlockingDeposit(existing);
  if (blocking) {
    const reason = blockingReason(blocking);
    const decision = await recordAutoDepositDecision(client, {
      tenant_id: check.tenant_id,
      check_intake_item_id: check.id,
      amount_cents: amountCents,
      auto_deposit_enabled: policy.auto_deposit_enabled,
      auto_deposit_max_cents: policy.auto_deposit_max_cents,
      eligible: false,
      reason,
      trigger,
      deposit_id: blocking.id,
      checkalt_reference: blocking.checkalt_reference || null,
      submit_result: { blocked: true, status: blocking.status || null },
    });
    return {
      submitted: false,
      eligible: false,
      reason,
      interactiveTotp: false,
      decision,
    };
  }

  const preflight = await (deps.evaluatePreflight || evaluateCheckAltDepositPreflight)({
    client,
    mapping,
    checkId: check.id,
    spoof,
    deps,
  });
  if (preflight?.historicalReference) {
    const decision = await recordAutoDepositDecision(client, {
      tenant_id: check.tenant_id,
      check_intake_item_id: check.id,
      amount_cents: amountCents,
      auto_deposit_enabled: policy.auto_deposit_enabled,
      auto_deposit_max_cents: policy.auto_deposit_max_cents,
      eligible: false,
      reason: AUTO_DEPOSIT_REASONS.ALREADY_HAS_REFERENCE,
      trigger,
    });
    return {
      submitted: false,
      eligible: false,
      reason: AUTO_DEPOSIT_REASONS.ALREADY_HAS_REFERENCE,
      interactiveTotp: false,
      decision,
      preflight,
    };
  }
  if (!preflight?.ok || preflight.readyForVerification !== true) {
    const decision = await recordAutoDepositDecision(client, {
      tenant_id: check.tenant_id,
      check_intake_item_id: check.id,
      amount_cents: amountCents,
      auto_deposit_enabled: policy.auto_deposit_enabled,
      auto_deposit_max_cents: policy.auto_deposit_max_cents,
      eligible: false,
      reason: AUTO_DEPOSIT_REASONS.GATES_FAILED,
      trigger,
      submit_result: {
        preflight_error: preflight?.error || null,
        preflight_reason: preflight?.reason || null,
      },
    });
    return {
      submitted: false,
      eligible: false,
      reason: AUTO_DEPOSIT_REASONS.GATES_FAILED,
      interactiveTotp: false,
      decision,
      preflight,
    };
  }

  if (!(deps.executionAllowed || productionCheckAltExecutionAllowed)()) {
    const decision = await recordAutoDepositDecision(client, {
      tenant_id: check.tenant_id,
      check_intake_item_id: check.id,
      amount_cents: amountCents,
      auto_deposit_enabled: policy.auto_deposit_enabled,
      auto_deposit_max_cents: policy.auto_deposit_max_cents,
      eligible: true,
      reason: AUTO_DEPOSIT_REASONS.PRODUCTION_BLOCKED,
      trigger,
    });
    return {
      submitted: false,
      eligible: true,
      reason: AUTO_DEPOSIT_REASONS.PRODUCTION_BLOCKED,
      interactiveTotp: false,
      decision,
    };
  }

  const submit = await (deps.submit || handleProductionCheckAltSubmit)({
    client,
    mapping,
    claims,
    body: { check_intake_item_id: check.id },
    spoof,
    fetchImpl: deps.fetchImpl,
    deps: {
      ...deps,
      autoDepositAuthority: {
        enabled: true,
        maxCents: policy.auto_deposit_max_cents,
        actor: AUTO_DEPOSIT_ACTOR,
      },
    },
  });

  if (submit?.uncertain === true || submit?.error === 'reconciliation_required') {
    const decision = await recordAutoDepositDecision(client, {
      tenant_id: check.tenant_id,
      check_intake_item_id: check.id,
      amount_cents: amountCents,
      auto_deposit_enabled: policy.auto_deposit_enabled,
      auto_deposit_max_cents: policy.auto_deposit_max_cents,
      eligible: false,
      reason: AUTO_DEPOSIT_REASONS.UNCERTAIN_BLOCKED,
      trigger,
      deposit_id: submit.deposit_id || null,
      checkalt_reference: submit.checkalt_reference || null,
      submit_result: {
        error: submit.error || null,
        uncertain: true,
        liveProviderCalled: submit.liveProviderCalled === true,
      },
    });
    return {
      submitted: false,
      eligible: false,
      reason: AUTO_DEPOSIT_REASONS.UNCERTAIN_BLOCKED,
      interactiveTotp: false,
      decision,
      submit,
    };
  }

  const submitted = submit?.liveProviderCalled === true || Boolean(submit?.checkalt_reference);
  const duplicate = submit?.duplicate === true || submit?.replayed === true;
  const reason = submitted
    ? AUTO_DEPOSIT_REASONS.EXECUTED
    : (duplicate ? AUTO_DEPOSIT_REASONS.DUPLICATE_BLOCKED : AUTO_DEPOSIT_REASONS.GATES_FAILED);
  const decision = await recordAutoDepositDecision(client, {
    tenant_id: check.tenant_id,
    check_intake_item_id: check.id,
    amount_cents: amountCents,
    auto_deposit_enabled: policy.auto_deposit_enabled,
    auto_deposit_max_cents: policy.auto_deposit_max_cents,
    eligible: submitted,
    reason,
    trigger,
    deposit_id: submit?.deposit_id || null,
    checkalt_reference: submit?.checkalt_reference || null,
    submit_result: {
      status: submit?.status || null,
      liveProviderCalled: submit?.liveProviderCalled === true,
      duplicate: duplicate,
      submission_source: AUTO_DEPOSIT_ACTOR,
    },
  });
  return {
    submitted,
    eligible: submitted,
    reason,
    interactiveTotp: false,
    decision,
    submit,
  };
}

export async function loadRecentConfigStepUp(client, {
  userId,
  tenantId,
  enabled,
  maxCents,
  sinceMs = AUTO_DEPOSIT_CONFIG_TTL_MS,
} = {}) {
  if (!userId || !tenantId) return [];
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = $3
       AND succeeded IS TRUE
       AND created_at >= $4::timestamptz
     ORDER BY created_at DESC
     LIMIT 10`,
    [
      userId,
      tenantId,
      CHECKALT_AUTO_DEPOSIT_CONFIGURE_ACTION,
      new Date(Date.now() - sinceMs).toISOString(),
    ],
  )).rows;
  return rows.filter((row) => {
    if (String(row.metadata?.operation || row.action_key) !== CHECKALT_AUTO_DEPOSIT_CONFIGURE_ACTION) {
      if (String(row.action_key) !== CHECKALT_AUTO_DEPOSIT_CONFIGURE_ACTION) return false;
    }
    if (Boolean(row.metadata?.auto_deposit_enabled) !== Boolean(enabled)) return false;
    const logged = row.metadata?.auto_deposit_max_cents;
    const loggedCents = logged === undefined || logged === null || logged === ''
      ? null
      : Number(logged);
    if (maxCents === null || maxCents === undefined) return loggedCents === null;
    return Number(loggedCents) === Number(maxCents);
  });
}

export function parseAutoDepositConfigValues(body = {}) {
  const enabled = body.auto_deposit_enabled === true
    || body.enabled === true
    || body.autoDepositEnabled === true;
  const raw = body.auto_deposit_max_cents ?? body.max_cents ?? body.autoDepositMaxCents;
  if (raw === undefined || raw === null || raw === '') {
    return { enabled, maxCents: null };
  }
  const maxCents = Number(raw);
  if (!Number.isInteger(maxCents) || maxCents < 0) {
    return { error: 'invalid_threshold', message: 'Maximum Auto-Deposit amount must be integer cents.' };
  }
  return { enabled, maxCents };
}

export async function applyAutoDepositSettings({
  client,
  mapping,
  tenantId,
  enabled,
  maxCents,
  stepupId = null,
} = {}) {
  const previous = await loadAutoDepositSetting(client, tenantId);
  const row = (await client.query(
    `INSERT INTO public.checkalt_tenant_deposit_settings (
       tenant_id, auto_deposit_enabled, auto_deposit_max_cents,
       auto_deposit_updated_at, auto_deposit_updated_by, updated_at
     ) VALUES ($1::uuid, $2, $3, now(), $4::uuid, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       auto_deposit_enabled = EXCLUDED.auto_deposit_enabled,
       auto_deposit_max_cents = EXCLUDED.auto_deposit_max_cents,
       auto_deposit_updated_at = now(),
       auto_deposit_updated_by = EXCLUDED.auto_deposit_updated_by,
       updated_at = now()
     RETURNING *`,
    [tenantId, enabled === true, Number.isInteger(maxCents) ? maxCents : null, mapping.application_user_id],
  )).rows[0];
  const audit = (await client.query(
    `INSERT INTO public.checkalt_auto_deposit_settings_audit (
       tenant_id, actor_id, stepup_id, previous_enabled, previous_max_cents,
       new_enabled, new_max_cents
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)
     RETURNING *`,
    [
      tenantId,
      mapping.application_user_id,
      stepupId,
      previous.auto_deposit_enabled === true,
      Number.isInteger(Number(previous.auto_deposit_max_cents)) ? Number(previous.auto_deposit_max_cents) : null,
      enabled === true,
      Number.isInteger(maxCents) ? maxCents : null,
    ],
  )).rows[0];
  return { setting: row, audit, swept: false };
}

export async function authorizeAutoDepositConfig({
  client,
  mapping,
  tenantId,
} = {}) {
  if (!mapping?.application_user_id) {
    return { ok: false, statusCode: 401, error: 'identity_required' };
  }
  if (!tenantId) {
    return { ok: false, statusCode: 400, error: 'tenant_id is required' };
  }
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (!membershipForTenant(memberships, tenantId)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'cross_tenant_denied',
      message: 'Auto-Deposit settings are tenant-scoped. Browser tenant_id is not authority.',
    };
  }
  const roles = await loadTenantRole(client, mapping.application_user_id, tenantId);
  if (!roleAllowsAutoDepositConfig(roles)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'financial_unauthorized',
      message: 'Only a tenant owner or admin can configure CheckAlt Auto-Deposit.',
      roles,
      financialRoleOk: roleAllowsFinancial(roles),
    };
  }
  return { ok: true, roles, tenantId };
}
