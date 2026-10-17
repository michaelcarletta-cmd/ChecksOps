/**
 * Per-tenant deposits switch (owner decision 2026-10-17, option 2):
 * tenants.deposits_enabled (SQL 98, NOT NULL DEFAULT true), set only by the
 * platform owner (aws_platform_owner_set_tenant_deposits_enabled, audited in
 * tenant_pricing_audit). Separate from per_check_billing_enabled, which keeps
 * meaning "per-check billing off = bill the default per-check price".
 *
 * When deposits_enabled is false the tenant cannot submit or record a check
 * deposit. Every deposit-creating server path checks it here, for the check's
 * own tenant, before any write or provider call:
 *   - providers.mjs handleFunctionInvoke: checkalt-submit-deposit and the
 *     approve action of checkalt-approve-deposit (production and sandbox);
 *   - workflow-rpc.mjs deposit_action: prepare_deposit, assign_provider,
 *     mark_manual_deposit.
 *
 * The read goes through SQL 98's DEFINER reader
 * public.aws_tenant_deposits_enabled(uuid) inside a savepoint. It fails
 * closed: a failed read refuses the deposit (deposits_status_unavailable). A
 * NULL answer (no such tenant) is not a refusal here: the caller's own check
 * then refuses the request (not found / cross tenant), as today.
 */

export const DEPOSITS_DISABLED = 'deposits_disabled';
export const DEPOSITS_DISABLED_MESSAGE = 'Deposits are turned off for this account. Contact ChecksOps.';
export const DEPOSITS_STATUS_UNAVAILABLE = 'deposits_status_unavailable';
export const TENANT_DEPOSITS_ENABLED_SQL = 'SELECT public.aws_tenant_deposits_enabled($1::uuid) AS enabled';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const depositsDisabledRefusal = (extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: DEPOSITS_DISABLED,
  message: DEPOSITS_DISABLED_MESSAGE,
  liveProviderCalled: false,
  ...extra,
});

/** Runs one read in a savepoint so a failure never aborts the caller's transaction. */
async function savepointRead(client, sql, params) {
  await client.query('SAVEPOINT tenant_deposits_gate');
  try {
    const rows = (await client.query(sql, params)).rows;
    await client.query('RELEASE SAVEPOINT tenant_deposits_gate');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT tenant_deposits_gate').catch(() => {});
    throw error;
  }
}

/**
 * { ok: true } when the tenant may deposit (flag true, or no such tenant);
 * a refusal otherwise. Never throws.
 */
export async function checkTenantDepositsEnabled(client, tenantId) {
  if (!tenantId || !UUID_RE.test(String(tenantId))) return { ok: true, tenantResolved: false };
  try {
    const row = (await savepointRead(client, TENANT_DEPOSITS_ENABLED_SQL, [tenantId]))[0];
    if (row?.enabled === false) return depositsDisabledRefusal({ tenant_id: tenantId });
    return { ok: true, tenantResolved: row?.enabled === true };
  } catch {
    return {
      ok: false,
      statusCode: 503,
      error: DEPOSITS_STATUS_UNAVAILABLE,
      message: `${DEPOSITS_DISABLED_MESSAGE} (Deposit status could not be confirmed.)`,
      liveProviderCalled: false,
    };
  }
}

/** Provider functions that create a deposit; approve-deposit only for action approve. */
export const isDepositFunction = (name, body = {}) => (
  name === 'checkalt-submit-deposit'
  || (name === 'checkalt-approve-deposit' && body?.action === 'approve')
);

/**
 * The tenant a provider deposit request acts for, read with the caller's own
 * identity (RLS): the check for a submit, the production or sandbox deposit
 * row for an approve. Unresolvable -> null (the handler refuses it itself).
 */
export async function depositRequestTenant(client, name, body = {}) {
  if (name === 'checkalt-submit-deposit') {
    const checkId = body.check_intake_item_id || body.check_id;
    if (!UUID_RE.test(String(checkId || ''))) return null;
    return (await savepointRead(
      client,
      'SELECT tenant_id FROM public.check_intake_items WHERE id = $1::uuid',
      [checkId],
    ))[0]?.tenant_id || null;
  }
  const depositId = body.deposit_id || body.checkalt_deposit_id || null;
  const reference = body.checkalt_reference || body.referenceNumber || null;
  if (depositId && UUID_RE.test(String(depositId))) {
    const production = (await savepointRead(
      client,
      'SELECT tenant_id FROM public.checkalt_deposits WHERE id = $1::uuid',
      [depositId],
    ))[0]?.tenant_id;
    if (production) return production;
    return (await savepointRead(
      client,
      "SELECT tenant_id FROM public.aws_provider_sandbox_operations WHERE id = $1::uuid AND provider = 'checkalt'",
      [depositId],
    ))[0]?.tenant_id || null;
  }
  if (reference) {
    const production = (await savepointRead(
      client,
      'SELECT tenant_id FROM public.checkalt_deposits WHERE checkalt_reference = $1 LIMIT 1',
      [String(reference)],
    ))[0]?.tenant_id;
    if (production) return production;
    return (await savepointRead(
      client,
      "SELECT tenant_id FROM public.aws_provider_sandbox_operations WHERE provider = 'checkalt' AND provider_reference = $1 LIMIT 1",
      [String(reference)],
    ))[0]?.tenant_id || null;
  }
  return null;
}

/**
 * Gate for a provider deposit function: null when it may proceed, a refusal
 * otherwise. withReadClient(fn) runs fn({ client }) with the caller's
 * identity (data.mjs withIdentity). Fails closed on any read error.
 */
export async function gateProviderDeposit(name, body, withReadClient) {
  if (!isDepositFunction(name, body)) return null;
  let refusal = null;
  try {
    const result = await withReadClient(async ({ client }) => {
      const tenantId = await depositRequestTenant(client, name, body);
      const checked = await checkTenantDepositsEnabled(client, tenantId);
      return { ok: true, statusCode: 200, checked };
    });
    if (!result || result.ok !== true) {
      // Identity or connection refused: the handler would refuse too; do not mask its error.
      return result?.statusCode === 401 ? null : {
        ok: false,
        statusCode: 503,
        error: DEPOSITS_STATUS_UNAVAILABLE,
        message: `${DEPOSITS_DISABLED_MESSAGE} (Deposit status could not be confirmed.)`,
        liveProviderCalled: false,
      };
    }
    if (!result.checked.ok) refusal = result.checked;
  } catch {
    refusal = {
      ok: false,
      statusCode: 503,
      error: DEPOSITS_STATUS_UNAVAILABLE,
      message: `${DEPOSITS_DISABLED_MESSAGE} (Deposit status could not be confirmed.)`,
      liveProviderCalled: false,
    };
  }
  return refusal;
}
