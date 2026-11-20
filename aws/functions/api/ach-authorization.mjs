/**
 * ACH debit authorization for a funding account (route save-ach-authorization).
 *
 * Owner report 2026-11-19: Settings > Bank Accounts "Sign & Authorize ACH" failed with
 * writes_disabled. The card inserted public.ach_authorizations from the browser, a table the AWS
 * client never writes, the generic /data/write route refuses, and SQL 136 accepts only on a server
 * write path. This route is that path:
 *
 * - Membership: resolveTenantAccess canConfigure (any member of the tenant), as the other tenant
 *   settings writes; partners and other tenants do not act.
 * - The funding account must be the tenant's own stakeholder_accounts row.
 * - The server writes the agreement text from the stored account (name and last four), never from
 *   the request, so the signed text always names the account; authorized_by is the verified sign-in;
 *   ip_address and user_agent come from API Gateway.
 * - authorize is idempotent: an active authorization for the account is returned, not duplicated.
 *   revoke deactivates the active one (revoked_at, revoked_by, revoke_reason).
 * - Writes set the money-write flag (SQL 136) immediately before they run. Nothing is debited and
 *   no payment provider is called.
 */
import { withIdentity } from './data.mjs';
import { setMoneyWriteFlag } from './money-write-flag.mjs';
import { resolveTenantAccess } from './tenant-email-domain.mjs';

export const ACH_AUTHORIZATION_COLUMNS = Object.freeze([
  'id', 'tenant_id', 'stakeholder_account_id', 'authorized_name', 'authorized_by', 'form_text',
  'is_active', 'created_at', 'revoked_at', 'revoked_by',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));
const ACH_SELECT = ACH_AUTHORIZATION_COLUMNS.join(', ');

const refuse = (spoof, statusCode, error, message, extra = {}) => ({
  ok: false, statusCode, error, message, spoofFieldsIgnored: spoof, ...extra,
});

const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
};

/** The account's last four: the stored account number, else the provider's, else null. */
export const achAccountLastFour = (stakeholder) => {
  const fromAccount = String(stakeholder?.chk_acct || '').replace(/\D/g, '');
  if (fromAccount.length >= 4) return fromAccount.slice(-4);
  const fromProvider = String(stakeholder?.provider_last_four || '').replace(/\D/g, '');
  return fromProvider.length >= 4 ? fromProvider.slice(-4) : null;
};

export const achAuthorizationText = ({ name, lastFour }) => (
  `I, ${name}, authorize this platform to initiate ACH debit entries from my account ${
    lastFour ? `ending in ${lastFour}` : 'on file'
  } for the purpose of funding disbursements. I understand that this authorization will remain in effect until I revoke it.`
);

/** The caller's IP and user agent as API Gateway saw them (never from the request body). */
export const achRequestMeta = (event) => {
  const headers = event?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'user-agent');
  return {
    sourceIp: event?.requestContext?.http?.sourceIp || event?.requestContext?.identity?.sourceIp || null,
    userAgent: event?.requestContext?.http?.userAgent || (key ? headers[key] : null) || null,
  };
};

const loadStakeholder = async (client, tenantId, stakeholderId) => (
  (await client.query(
    `SELECT id, tenant_id, nickname, custname, chk_acct, provider_last_four, is_active
     FROM public.stakeholder_accounts
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [stakeholderId, tenantId],
  )).rows[0] || null
);

const loadActive = async (client, tenantId, stakeholderId) => (
  (await client.query(
    `SELECT ${ACH_SELECT}
     FROM public.ach_authorizations
     WHERE tenant_id = $1::uuid AND stakeholder_account_id = $2::uuid AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, stakeholderId],
  )).rows[0] || null
);

export const runSaveAchAuthorization = async ({ client, mapping, body, spoof, request = {} }) => {
  const tenantId = body.tenantId || body.tenant_id;
  if (!isUuid(tenantId)) return refuse(spoof, 400, 'missing_tenant', 'Missing organization.');
  const access = await resolveTenantAccess(client, mapping, tenantId);
  if (!access?.canView) return refuse(spoof, 403, 'cross_tenant_denied', 'Not authorized');
  if (!access?.canConfigure) {
    return refuse(spoof, 403, 'not_authorized', 'Only a member of this organization can sign or revoke an ACH authorization.');
  }
  const stakeholderId = body.stakeholderAccountId || body.stakeholder_account_id;
  if (!isUuid(stakeholderId)) return refuse(spoof, 400, 'missing_stakeholder_account', 'Choose a funding account.');
  const action = String(body.action || 'get').toLowerCase();
  if (!['get', 'authorize', 'revoke'].includes(action)) {
    return refuse(spoof, 400, 'invalid_action', 'action must be get, authorize or revoke');
  }
  const stakeholder = await loadStakeholder(client, tenantId, stakeholderId);
  if (!stakeholder) return refuse(spoof, 404, 'funding_source_not_found', 'Funding account not found.');
  const lastFour = achAccountLastFour(stakeholder);
  const name = clip(stakeholder.custname, 200) || clip(stakeholder.nickname, 200) || 'Account holder';
  const formText = achAuthorizationText({ name, lastFour });
  const active = await loadActive(client, tenantId, stakeholderId);
  const reply = (extra) => ({ ok: true, statusCode: 200, account_last4: lastFour, spoofFieldsIgnored: spoof, ...extra });

  if (action === 'get') return reply({ authorization: active, form_text: formText });

  if (action === 'authorize') {
    if (active) return reply({ authorization: active, already_active: true });
    if (stakeholder.is_active === false) return refuse(spoof, 409, 'account_inactive', 'This funding account is inactive.');
    await setMoneyWriteFlag(client);
    const row = (await client.query(
      `INSERT INTO public.ach_authorizations
         (tenant_id, stakeholder_account_id, authorized_name, authorized_by, ip_address, user_agent, form_text, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, true)
       RETURNING ${ACH_SELECT}`,
      [tenantId, stakeholderId, name, mapping.application_user_id, clip(request.sourceIp, 64), clip(request.userAgent, 512), formText],
    )).rows[0] || null;
    if (!row) return refuse(spoof, 409, 'ach_authorization_not_saved', 'The authorization was not saved.');
    return reply({ authorization: row });
  }

  if (!active) return reply({ authorization: null, already_revoked: true });
  await setMoneyWriteFlag(client);
  const revoked = (await client.query(
    `UPDATE public.ach_authorizations
     SET is_active = false, revoked_at = now(), revoked_by = $3::uuid, revoke_reason = $4, updated_at = now()
     WHERE tenant_id = $1::uuid AND stakeholder_account_id = $2::uuid AND is_active = true
     RETURNING ${ACH_SELECT}`,
    [tenantId, stakeholderId, mapping.application_user_id, clip(body.reason, 500)],
  )).rows;
  if (revoked.length === 0) return refuse(spoof, 409, 'ach_revoke_not_applied', 'The authorization was not revoked.');
  return reply({ authorization: null, revoked: revoked.length });
};

export const handleSaveAchAuthorization = (event, deps = {}) => withIdentity(
  event,
  (args) => runSaveAchAuthorization({ ...args, request: achRequestMeta(event) }),
  { write: true, commit: true, ...deps },
);
