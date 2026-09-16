import { withIdentity, withIdentityWrite } from '../../data.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import {
  AUTO_DEPOSIT_TRIGGERS,
  applyAutoDepositSettings,
  authorizeAutoDepositConfig,
  loadAutoDepositSetting,
  loadRecentConfigStepUp,
  maybeRunCheckAltAutoDeposit,
  parseAutoDepositConfigValues,
} from './checkalt-auto-deposit.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  liveProviderCalled: false,
  ...extra,
});

const resolveTenantId = async ({ client, mapping, body, spoof }) => {
  const claimed = body.tenant_id || body.tenantId || null;
  const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
  if (claimed && !membershipForTenant(memberships, claimed)) {
    return {
      error: fail('cross_tenant_denied', 403, {
        message: 'Browser tenant_id does not match a membership. It is not used as authority.',
        spoofFieldsIgnored: spoof,
      }),
    };
  }
  if (claimed) return { tenantId: claimed, memberships };
  if (memberships.length === 1) return { tenantId: memberships[0].tenant_id, memberships };
  return {
    error: fail('tenant_id is required', 400, {
      message: 'Auto-Deposit settings require a server-resolved tenant membership.',
      spoofFieldsIgnored: spoof,
    }),
  };
};

export const handleCheckAltAutoDepositSettings = async (event, deps = {}) => {
  const method = String(event?.requestContext?.http?.method || event?.httpMethod || 'POST').toUpperCase();
  if (method === 'GET') {
    return withIdentity(event, async ({ client, mapping, body, spoof }) => {
      const query = event?.queryStringParameters || {};
      const resolved = await resolveTenantId({
        client,
        mapping,
        body: { ...body, tenant_id: body.tenant_id || query.tenant_id || query.tenantId },
        spoof,
      });
      if (resolved.error) return resolved.error;
      const authz = await authorizeAutoDepositConfig({
        client,
        mapping,
        tenantId: resolved.tenantId,
      });
      if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };
      const setting = await loadAutoDepositSetting(client, resolved.tenantId);
      return {
        ok: true,
        statusCode: 200,
        tenant_id: resolved.tenantId,
        auto_deposit_enabled: setting.auto_deposit_enabled === true,
        auto_deposit_max_cents: Number.isInteger(Number(setting.auto_deposit_max_cents))
          ? Number(setting.auto_deposit_max_cents)
          : null,
        auto_deposit_updated_at: setting.auto_deposit_updated_at || null,
        default_off: setting.auto_deposit_enabled !== true,
        spoofFieldsIgnored: spoof,
      };
    }, deps);
  }

  return withIdentityWrite(event, async ({ client, mapping, body, spoof }) => {
    const parsed = parseAutoDepositConfigValues(body);
    if (parsed.error) return fail(parsed.error, 400, { message: parsed.message, spoofFieldsIgnored: spoof });
    if (parsed.enabled && !Number.isInteger(parsed.maxCents)) {
      return fail('invalid_threshold', 400, {
        message: 'Enabling Auto-Deposit requires a maximum amount in integer cents.',
        spoofFieldsIgnored: spoof,
      });
    }
    const resolved = await resolveTenantId({ client, mapping, body, spoof });
    if (resolved.error) return resolved.error;
    const authz = await authorizeAutoDepositConfig({
      client,
      mapping,
      tenantId: resolved.tenantId,
    });
    if (!authz.ok) return { ...authz, spoofFieldsIgnored: spoof };
    const stepups = await loadRecentConfigStepUp(client, {
      userId: mapping.application_user_id,
      tenantId: resolved.tenantId,
      enabled: parsed.enabled,
      maxCents: parsed.maxCents,
    });
    if (!stepups.length) {
      return fail('step_up_required', 403, {
        message: 'Changing Auto-Deposit requires a financial TOTP bound to this tenant configuration.',
        spoofFieldsIgnored: spoof,
        interactiveTotp: true,
      });
    }
    const applied = await applyAutoDepositSettings({
      client,
      mapping,
      tenantId: resolved.tenantId,
      enabled: parsed.enabled,
      maxCents: parsed.maxCents,
      stepupId: stepups[0].id,
    });
    return {
      ok: true,
      statusCode: 200,
      tenant_id: resolved.tenantId,
      auto_deposit_enabled: applied.setting.auto_deposit_enabled === true,
      auto_deposit_max_cents: Number.isInteger(Number(applied.setting.auto_deposit_max_cents))
        ? Number(applied.setting.auto_deposit_max_cents)
        : null,
      auto_deposit_updated_at: applied.setting.auto_deposit_updated_at,
      swept: false,
      trigger: AUTO_DEPOSIT_TRIGGERS.SETTINGS_CHANGE,
      audit_id: applied.audit?.id || null,
      liveProviderCalled: false,
      spoofFieldsIgnored: spoof,
    };
  }, deps);
};

export const handleCheckAltAutoDepositOnReady = async (event, deps = {}) => {
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const checkId = body.check_intake_item_id || body.check_id || body.checkId;
    if (!checkId) return fail('check_intake_item_id is required', 400, { spoofFieldsIgnored: spoof });
    const check = (await client.query(
      `SELECT id, tenant_id, amount, status, check_stage, updated_at
       FROM public.check_intake_items
       WHERE id = $1::uuid`,
      [checkId],
    )).rows[0];
    if (!check) return fail('Check not found', 404, { spoofFieldsIgnored: spoof });
    const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
    if (!membershipForTenant(memberships, check.tenant_id)) {
      return fail('cross_tenant_denied', 403, { spoofFieldsIgnored: spoof });
    }
    const result = await maybeRunCheckAltAutoDeposit({
      client,
      mapping,
      claims,
      check,
      previous: undefined,
      trigger: AUTO_DEPOSIT_TRIGGERS.READY_TRANSITION,
      spoof,
      deps,
    });
    return {
      ok: true,
      statusCode: 200,
      ...result,
      liveProviderCalled: result.submit?.liveProviderCalled === true,
      spoofFieldsIgnored: spoof,
    };
  }, deps);
};
