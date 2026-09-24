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
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminDisableUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { withIdentity } from './data.mjs';
import { bindProductionCognitoLock } from './identity-env.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { emailAssetOrigin, resolveEmailBranding } from './email-branding.mjs';

const POOL_ID = () => process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = () => process.env.COGNITO_CLIENT_ID;
const sm = () => new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
const cognito = () => new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });

/** Admin Cognito APIs require SigV4 (Lambda execution role). Unsigned fetch returns Missing Authentication Token. */
const cognitoJson = async (target, payload) => {
  const commands = {
    AdminCreateUser: AdminCreateUserCommand,
    AdminGetUser: AdminGetUserCommand,
    AdminDisableUser: AdminDisableUserCommand,
    AdminSetUserPassword: AdminSetUserPasswordCommand,
  };
  const Command = commands[target];
  if (!Command) {
    const error = new Error(`unsupported_cognito_admin_target:${target}`);
    error.name = 'UnsupportedCognitoAdminTarget';
    throw error;
  }
  try {
    return await cognito().send(new Command(payload));
  } catch (err) {
    const error = new Error(err?.message || err?.name || 'CognitoError');
    error.name = String(err?.name || 'CognitoError').split('#').pop();
    error.statusCode = err?.$metadata?.httpStatusCode || 502;
    error.body = { message: err?.message, __type: err?.name };
    throw error;
  }
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

export const runTenantInviteUser = async ({
  client, mapping, body, spoof, send, cognitoJson: cognitoFn, identityScope,
}) => {
  const adminCognito = cognitoFn || cognitoJson;
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
    const created = await adminCognito('AdminCreateUser', {
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
    const attrs = created.User?.Attributes || [];
    const subAttr = attrs.find((a) => a.Name === 'sub');
    if (subAttr) cognitoSub = subAttr.Value;
    isNewUser = true;
  } catch (error) {
    if (String(error.name).includes('UsernameExistsException')) {
      const listed = await adminCognito('AdminGetUser', {
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
      `INSERT INTO public.identity_accounts (cognito_sub, application_user_id, email, status, linked_at, created_at)
       VALUES ($1, $2::uuid, $3, 'active', now(), now())
       ON CONFLICT (cognito_sub) DO UPDATE
         SET application_user_id = EXCLUDED.application_user_id,
             email = EXCLUDED.email,
             status = 'active',
             linked_at = COALESCE(public.identity_accounts.linked_at, now())`,
      [cognitoSub, appUserId, email],
    ).catch(() => {});
  }

  // Production /identity/me resolves via identity_production_cognito_locks.
  // Login must not write that table. Bind here with the server-resolved
  // Cognito sub + application user only (never email, client user id, or tenant_id).
  const lockResult = await bindProductionCognitoLock(client, {
    cognitoSub,
    applicationUserId: appUserId,
    identityScope,
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      statusCode: lockResult.error === 'identity_lock_conflict' ? 409 : 500,
      error: lockResult.error,
      message: lockResult.message || undefined,
      spoofFieldsIgnored: spoof,
    };
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

  const origin = emailAssetOrigin();
  const loginUrl = tenant.custom_domain
    ? `https://${tenant.custom_domain}/login`
    : `${origin}/login`;
  const branding = await resolveEmailBranding(client, { tenantId });
  const rendered = renderTransactionalTemplate('tenant-user-invite', {
    tenantName: tenant.name,
    role,
    loginUrl,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  await mailer({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
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
    tempPasswordIssued: isNewUser,
    spoofFieldsIgnored: spoof,
  };
};

export const handleTenantInviteUser = (event, deps = {}) => withIdentity(event, (ctx) => (
  runTenantInviteUser({
    ...ctx,
    send: deps.sendViaSesOrSink,
    cognitoJson: deps.cognitoJson,
  })
), { write: true, commit: true, ...deps });

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

export {
  handleTenantDomainVerify,
  handleTenantDomainCheck,
  handleTenantDomainRecheckCron,
} from './tenant-email-domain-handlers.mjs';

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

/**
 * Hire mortgage desk agent (Class A Cognito bridge for hire-mortgage-agent).
 * Preserves production semantics: mortgage_agent-only accounts, identity mapping
 * Cognito sub → application UUID (never equal). Cognito still needs a temp
 * password internally with MessageAction SUPPRESS; it is never emailed, logged,
 * or returned. The invite is passwordless login.
 */
export const runHireMortgageAgent = async ({
  client, mapping, body, spoof, send, cognitoJson: cognitoFn, identityScope,
}) => {
  const HIRE_PROVISION_SQL =
    'SELECT public.aws_hire_mortgage_agent_provision($1::uuid, $2::text, $3::text) AS result';
  const adminCognito = cognitoFn || cognitoJson;
  const system = (await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1::uuid AND role = 'admin' LIMIT 1`,
    [mapping.application_user_id],
  )).rows[0];
  const master = (await client.query(`SELECT public.is_master_owner() AS is_master`)).rows[0];
  if (!master?.is_master && !system) {
    return { ok: false, statusCode: 403, error: 'Admin access required', spoofFieldsIgnored: spoof };
  }

  const email = normalizeEmail(body.email);
  const fullName = String(body.full_name || body.fullName || '').trim();
  if (!email || !fullName) {
    return { ok: false, statusCode: 400, error: 'Name and email are required', spoofFieldsIgnored: spoof };
  }

  const providedPassword = body.password && String(body.password).length >= 8
    ? String(body.password)
    : null;
  const tempPassword = providedPassword
    || `MortgageOps!${randomBytes(6).toString('base64url')}9a`;

  let appUserId = (await client.query(
    `SELECT id::text AS id FROM public.profiles WHERE lower(email) = $1 LIMIT 1`,
    [email],
  )).rows[0]?.id || null;
  let created = false;
  let cognitoSub = null;

  if (appUserId) {
    const roles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid`,
      [appUserId],
    )).rows.map((r) => r.role);
    if (roles.includes('staff') || roles.includes('admin')) {
      return {
        ok: false,
        statusCode: 400,
        error: 'This account already has staff/admin access. Mortgage ops access must be scoped-only — remove those roles first.',
        spoofFieldsIgnored: spoof,
      };
    }
    if (roles.includes('mortgage_agent')) {
      return {
        ok: false,
        statusCode: 409,
        error: 'User already has mortgage ops access.',
        spoofFieldsIgnored: spoof,
      };
    }
  }

  try {
    const createdUser = await adminCognito('AdminCreateUser', {
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
    const attrs = createdUser.User?.Attributes || [];
    cognitoSub = attrs.find((a) => a.Name === 'sub')?.Value
      || createdUser.User?.Username
      || null;
    created = true;
    if (providedPassword) {
      try {
        await adminCognito('AdminSetUserPassword', {
          UserPoolId: POOL_ID(),
          Username: email,
          Password: providedPassword,
          Permanent: true,
        });
      } catch {
        /* Cognito still has a suppressed temp password; invite is passwordless. */
      }
    }
  } catch (error) {
    if (String(error.name).includes('UsernameExistsException')) {
      const listed = await adminCognito('AdminGetUser', {
        UserPoolId: POOL_ID(),
        Username: email,
      });
      const attrs = listed.UserAttributes || [];
      cognitoSub = attrs.find((a) => a.Name === 'sub')?.Value || listed.Username;
    } else {
      return {
        ok: false,
        statusCode: 502,
        error: 'cognito_hire_failed',
        message: String(error.message || error).slice(0, 240),
        spoofFieldsIgnored: spoof,
      };
    }
  }

  if (!cognitoSub || (appUserId && String(cognitoSub) === String(appUserId))) {
    return {
      ok: false,
      statusCode: 500,
      error: 'unsafe_or_missing_cognito_sub',
      spoofFieldsIgnored: spoof,
    };
  }

  if (!appUserId) {
    appUserId = randomUUID();
    created = true;
  }
  if (String(cognitoSub) === String(appUserId)) {
    return {
      ok: false,
      statusCode: 500,
      error: 'unsafe_or_missing_cognito_sub',
      spoofFieldsIgnored: spoof,
    };
  }

  await client.query(
    `INSERT INTO public.identity_accounts (cognito_sub, application_user_id, email, status, linked_at, created_at)
     VALUES ($1, $2::uuid, $3, 'active', now(), now())
     ON CONFLICT (cognito_sub) DO UPDATE
       SET application_user_id = EXCLUDED.application_user_id,
           email = EXCLUDED.email,
           status = 'active',
           linked_at = COALESCE(public.identity_accounts.linked_at, now())`,
    [cognitoSub, appUserId, email],
  );

  const provisionRaw = (await client.query(HIRE_PROVISION_SQL, [appUserId, email, fullName])).rows[0]?.result;
  const provision = typeof provisionRaw === 'string'
    ? (() => { try { return JSON.parse(provisionRaw); } catch { return null; } })()
    : provisionRaw;
  if (!provision || provision.ok !== true) {
    const err = provision?.error || 'hire_provision_failed';
    const statusCode = err === 'not_authorized' || err === 'not_authenticated' ? 403 : 400;
    return {
      ok: false,
      statusCode,
      error: err,
      spoofFieldsIgnored: spoof,
    };
  }
  if (provision.mortgage_agent_granted !== true) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Failed to grant mortgage_agent role',
      spoofFieldsIgnored: spoof,
    };
  }

  const lockResult = await bindProductionCognitoLock(client, {
    cognitoSub,
    applicationUserId: appUserId,
    identityScope,
  });
  if (!lockResult.ok) {
    return {
      ok: false,
      statusCode: lockResult.error === 'identity_lock_conflict' ? 409 : 500,
      error: lockResult.error,
      message: lockResult.message || undefined,
      spoofFieldsIgnored: spoof,
    };
  }

  const loginUrl = `${emailAssetOrigin()}/mortgage-ops/login`;
  const branding = await resolveEmailBranding(client, { senderOverride: 'checksops' });
  const rendered = renderTransactionalTemplate('mortgage-agent-invite', {
    fullName,
    loginUrl,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  await mailer({
    to: email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: branding.from,
    replyTo: branding.replyTo,
  });

  return {
    ok: true,
    statusCode: 200,
    success: true,
    user_id: appUserId,
    email,
    full_name: fullName,
    created,
    invitationSent: true,
    cognitoSub,
    applicationUserId: appUserId,
    spoofFieldsIgnored: spoof,
  };
};

export const handleHireMortgageAgent = (event, deps = {}) => withIdentity(event, (ctx) => (
  runHireMortgageAgent({
    ...ctx,
    send: deps.sendViaSesOrSink,
    cognitoJson: deps.cognitoJson,
  })
), { write: true, commit: true, ...deps });

