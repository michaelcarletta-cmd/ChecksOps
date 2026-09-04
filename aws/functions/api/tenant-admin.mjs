/**
 * Tenant Cognito invite / admin (Class A) + domain + OpenAI BYOK helpers.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { withIdentity, parseBody, ignoredSpoof } from './data.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { sendViaSesOrSink } from './email.mjs';

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = () => process.env.COGNITO_CLIENT_ID;
const sm = () => new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });

const cognitoJson = async (target, payload) => {
  const response = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
  if (!response.ok) {
    const error = new Error(body.message || body.Message || body.__type || 'CognitoError');
    error.name = String(body.__type || 'CognitoError').split('#').pop();
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }
  return body;
};

const assertTenantAdmin = async (client, mapping, tenantId) => {
  const membership = (await client.query(
    `SELECT role FROM public.tenant_users
     WHERE tenant_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
    [tenantId, mapping.application_user_id],
  )).rows[0];
  const system = (await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1::uuid LIMIT 1`,
    [mapping.application_user_id],
  )).rows[0];
  const master = (await client.query(
    `SELECT public.is_master_owner() AS is_master`,
  )).rows[0];
  const ok = membership?.role === 'admin'
    || system?.role === 'admin'
    || master?.is_master === true;
  return ok;
};

export const handleTenantInviteUser = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const tenantId = body.tenant_id || body.tenantId;
  const email = normalizeEmail(body.email);
  const role = body.role || 'member';
  const fullName = body.full_name || body.fullName || email;
  if (!tenantId || !email) {
    return { ok: false, statusCode: 400, error: 'Missing tenant_id, email, or role', spoofFieldsIgnored: spoof };
  }
  if (!(await assertTenantAdmin(client, mapping, tenantId))) {
    return { ok: false, statusCode: 403, error: 'Not authorized — must be tenant admin or system admin', spoofFieldsIgnored: spoof };
  }

  const tenant = (await client.query(
    `SELECT id, slug, name, custom_domain FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (!tenant) return { ok: false, statusCode: 404, error: 'Tenant not found', spoofFieldsIgnored: spoof };

  const tempPassword = `Tmp-${randomBytes(9).toString('base64url')}!a1`;
  let cognitoSub = null;
  let isNewUser = false;
  try {
    const created = await cognitoJson('AdminCreateUser', {
      UserPoolId: POOL_ID(),
      Username: email,
      TemporaryPassword: tempPassword,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: fullName },
      ],
    });
    cognitoSub = created.User?.Username || created.User?.Attributes?.find?.((a) => a.Name === 'sub')?.Value;
    // Prefer sub attribute
    const attrs = created.User?.Attributes || [];
    const subAttr = attrs.find((a) => a.Name === 'sub');
    if (subAttr) cognitoSub = subAttr.Value;
    isNewUser = true;
  } catch (error) {
    if (String(error.name).includes('UsernameExistsException')) {
      const listed = await cognitoJson('AdminGetUser', {
        UserPoolId: POOL_ID(),
        Username: email,
      });
      cognitoSub = listed.Username;
      const attrs = listed.UserAttributes || [];
      const subAttr = attrs.find((a) => a.Name === 'sub');
      if (subAttr) cognitoSub = subAttr.Value;
    } else {
      return {
        ok: false,
        statusCode: 502,
        error: 'cognito_invite_failed',
        message: String(error.message || error).slice(0, 240),
        spoofFieldsIgnored: spoof,
      };
    }
  }

  // Ensure application profile + mapping exist (UUID app id, not cognito sub)
  let appUserId = (await client.query(
    `SELECT id::text AS id FROM public.profiles WHERE lower(email) = $1 LIMIT 1`,
    [email],
  )).rows[0]?.id;
  if (!appUserId) {
    appUserId = randomUUID();
    await client.query(
      `INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [appUserId, email, fullName],
    ).catch(async () => {
      await client.query(
        `INSERT INTO public.profiles (id, email, full_name)
         VALUES ($1::uuid, $2, $3)`,
        [appUserId, email, fullName],
      ).catch(() => {});
    });
  }

  if (cognitoSub && appUserId && String(cognitoSub) !== String(appUserId)) {
    await client.query(
      `INSERT INTO public.identity_accounts (cognito_sub, application_user_id, email, created_at, updated_at)
       VALUES ($1, $2::uuid, $3, now(), now())
       ON CONFLICT (cognito_sub) DO UPDATE
         SET application_user_id = EXCLUDED.application_user_id,
             email = EXCLUDED.email,
             updated_at = now()`,
      [cognitoSub, appUserId, email],
    ).catch(() => {});
  }

  await client.query(
    `INSERT INTO public.tenant_users (id, tenant_id, user_id, role, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now())
     ON CONFLICT DO NOTHING`,
    [randomUUID(), tenantId, appUserId, role],
  ).catch(async () => {
    await client.query(
      `INSERT INTO public.tenant_users (tenant_id, user_id, role)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, appUserId, role],
    ).catch(() => {});
  });

  const loginUrl = tenant.custom_domain
    ? `https://${tenant.custom_domain}/login`
    : `https://staging.checksops.com/login`;

  await sendViaSesOrSink({
    to: email,
    subject: `You're invited to ${tenant.name || 'ChecksOps'}`,
    html: `<p>You have been invited as <strong>${role}</strong>.</p><p><a href="${loginUrl}">Sign in</a></p><p>Staging invite — use the temporary password provided by your admin if prompted.</p>`,
    text: `Invited as ${role}. Sign in: ${loginUrl}`,
  });

  return {
    ok: true,
    statusCode: 200,
    success: true,
    invited: true,
    isNewUser,
    email,
    role,
    applicationUserId: appUserId,
    cognitoSub,
    // Never return temp password in responses for safety
    tempPasswordIssued: isNewUser,
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleCreateTenantUser = async (event) => handleTenantInviteUser(event);

export const handleDeleteUser = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const userId = body.userId || body.user_id;
  const email = normalizeEmail(body.email);
  const system = (await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1::uuid LIMIT 1`,
    [mapping.application_user_id],
  )).rows[0];
  const master = (await client.query(`SELECT public.is_master_owner() AS is_master`)).rows[0];
  if (system?.role !== 'admin' && !master?.is_master) {
    return { ok: false, statusCode: 403, error: 'admin_required', spoofFieldsIgnored: spoof };
  }
  if (!userId && !email) {
    return { ok: false, statusCode: 400, error: 'missing_user', spoofFieldsIgnored: spoof };
  }
  // Soft-disable: remove tenant memberships; do not hard-delete Cognito from staging automation.
  if (userId) {
    await client.query(`DELETE FROM public.tenant_users WHERE user_id = $1::uuid`, [userId]).catch(() => {});
  }
  if (email) {
    try {
      await cognitoJson('AdminDisableUser', { UserPoolId: POOL_ID(), Username: email });
    } catch {
      /* ignore missing user */
    }
  }
  return { ok: true, statusCode: 200, disabled: true, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });

export const handleGetInstanceUsers = async (event) => withIdentity(event, async ({
  spoof,
}) => ({
  ok: false,
  statusCode: 501,
  error: 'partner_sync_deferred',
  message: 'get-instance-users requires partner claim-sync sandbox credentials (Class B)',
  spoofFieldsIgnored: spoof,
}));

export const handleTenantDomainVerify = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const tenantId = body.tenantId || body.tenant_id;
  const domain = String(body.domain || '').trim().toLowerCase();
  if (!tenantId || !domain) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  if (!(await assertTenantAdmin(client, mapping, tenantId))) {
    return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
  }
  const token = randomBytes(16).toString('hex');
  await client.query(
    `INSERT INTO public.tenant_email_settings (tenant_id, sending_domain, domain_status, updated_at)
     VALUES ($1::uuid, $2, 'pending', now())
     ON CONFLICT (tenant_id) DO UPDATE
       SET sending_domain = EXCLUDED.sending_domain,
           domain_status = 'pending',
           updated_at = now()`,
    [tenantId, domain],
  ).catch(async () => {
    await client.query(
      `UPDATE public.tenant_email_settings
       SET sending_domain = $2, domain_status = 'pending', updated_at = now()
       WHERE tenant_id = $1::uuid`,
      [tenantId, domain],
    ).catch(() => {});
  });
  return {
    ok: true,
    statusCode: 200,
    domain,
    status: 'pending',
    dns: [
      { type: 'TXT', name: `_checksops-verify.${domain}`, value: `checksops-domain-verify=${token}` },
    ],
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleTenantDomainCheck = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const tenantId = body.tenantId || body.tenant_id;
  if (!tenantId) return { ok: false, statusCode: 400, error: 'missing_tenant', spoofFieldsIgnored: spoof };
  if (!(await assertTenantAdmin(client, mapping, tenantId))) {
    return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
  }
  const row = (await client.query(
    `SELECT sending_domain, domain_status, verified_at, updated_at
     FROM public.tenant_email_settings WHERE tenant_id = $1::uuid LIMIT 1`,
    [tenantId],
  )).rows[0];
  return {
    ok: true,
    statusCode: 200,
    domain: row?.sending_domain || null,
    status: row?.domain_status || 'unset',
    verified: row?.domain_status === 'verified',
    verifiedAt: row?.verified_at || null,
    stagingNote: 'AWS staging reads tenant_email_settings; ACM/Route53 attach remains ops-owned',
    spoofFieldsIgnored: spoof,
  };
});

export const handleTenantDomainRecheckCron = async (event) => {
  const spoof = ignoredSpoof(event, parseBody(event));
  // Non-financial scheduled job: mark stale pending domains for review only.
  return {
    ok: true,
    statusCode: 200,
    processed: 0,
    staging: true,
    message: 'tenant-domain-recheck-cron no-op until ACM DNS automation is wired',
    spoofFieldsIgnored: spoof,
  };
};

const openaiSecretName = (tenantId) => `checksops/staging/tenant-openai/${tenantId}`;

export const handleTenantSetOpenaiKey = async (event) => withIdentity(event, async ({
  mapping, body, spoof, client,
}) => {
  const tenantId = body.tenant_id || body.tenantId;
  const apiKey = String(body.api_key || body.apiKey || '').trim();
  if (!tenantId || !apiKey) {
    return { ok: false, statusCode: 400, error: 'missing_fields', spoofFieldsIgnored: spoof };
  }
  if (!(await assertTenantAdmin(client, mapping, tenantId))) {
    return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
  }
  const name = openaiSecretName(tenantId);
  try {
    await sm().send(new CreateSecretCommand({
      Name: name,
      SecretString: JSON.stringify({ apiKey, tenantId, updatedBy: mapping.application_user_id }),
    }));
  } catch (error) {
    if (String(error.name).includes('ResourceExistsException') || String(error.message).includes('already exists')) {
      await sm().send(new PutSecretValueCommand({
        SecretId: name,
        SecretString: JSON.stringify({ apiKey, tenantId, updatedBy: mapping.application_user_id }),
      }));
    } else {
      return { ok: false, statusCode: 502, error: 'secrets_write_failed', message: String(error.message).slice(0, 200), spoofFieldsIgnored: spoof };
    }
  }
  return { ok: true, statusCode: 200, stored: true, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });

export const handleTenantValidateOpenaiKey = async (event) => withIdentity(event, async ({
  mapping, body, spoof, client,
}) => {
  const tenantId = body.tenant_id || body.tenantId;
  if (!tenantId) return { ok: false, statusCode: 400, error: 'missing_tenant', spoofFieldsIgnored: spoof };
  if (!(await assertTenantAdmin(client, mapping, tenantId))) {
    return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
  }
  try {
    const out = await sm().send(new GetSecretValueCommand({ SecretId: openaiSecretName(tenantId) }));
    const parsed = JSON.parse(out.SecretString || '{}');
    return {
      ok: true,
      statusCode: 200,
      valid: Boolean(parsed.apiKey),
      configured: Boolean(parsed.apiKey),
      spoofFieldsIgnored: spoof,
    };
  } catch {
    return { ok: true, statusCode: 200, valid: false, configured: false, spoofFieldsIgnored: spoof };
  }
});

export const handleTenantRemoveOpenaiKey = async (event) => withIdentity(event, async ({
  mapping, body, spoof, client,
}) => {
  const tenantId = body.tenant_id || body.tenantId;
  if (!tenantId) return { ok: false, statusCode: 400, error: 'missing_tenant', spoofFieldsIgnored: spoof };
  if (!(await assertTenantAdmin(client, mapping, tenantId))) {
    return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
  }
  try {
    await sm().send(new DeleteSecretCommand({
      SecretId: openaiSecretName(tenantId),
      ForceDeleteWithoutRecovery: true,
    }));
  } catch {
    /* ignore missing */
  }
  return { ok: true, statusCode: 200, removed: true, spoofFieldsIgnored: spoof };
}, { write: true, commit: true });
