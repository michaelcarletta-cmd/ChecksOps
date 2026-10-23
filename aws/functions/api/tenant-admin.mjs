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
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { withIdentity } from './data.mjs';
import { normalizeEmail } from './email-policy.mjs';
import { sendViaSesOrSink } from './email.mjs';
import { renderTransactionalTemplate } from './email-templates.mjs';
import { emailAssetOrigin, resolveEmailBranding } from './email-branding.mjs';
import { bindProductionCognitoLock } from './identity-env.mjs';

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
    AdminDeleteUser: AdminDeleteUserCommand,
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

// Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
// Team management (invite, remove, the tenant AI key) is open to any member of
// the tenant. Global user_roles admin/staff and the master owner get no
// shortcut into a tenant.
const assertTenantMember = async (client, mapping, tenantId) => {
  const rows = (await client.query(
    `SELECT 1 FROM public.tenant_users
     WHERE tenant_id = $1::uuid AND user_id = $2::uuid
     LIMIT 1`,
    [tenantId, mapping.application_user_id],
  )).rows;
  return rows.length > 0;
};

// is_master_owner() is an alias of is_platform_owner() (aws/rls/sql/10).
const isPlatformOwner = async (client) => {
  try {
    const row = (await client.query(
      `SELECT public.is_platform_owner() AS is_owner, public.is_master_owner() AS is_master`,
    )).rows[0];
    return row?.is_owner === true || row?.is_master === true;
  } catch {
    return false;
  }
};

/** The platform owner's mailbox (public.is_platform_owner() is identity-email based). */
export const PLATFORM_OWNER_EMAIL = 'checksopsadmin@gmail.com';

/**
 * How many tenant_users rows the tenant has. The platform owner reads every
 * tenant's rows (aws_select_tenant_users). null when it cannot be read, so the
 * first-invite check fails closed.
 */
export const TENANT_MEMBER_COUNT_SQL = `SELECT count(*)::int AS member_count
  FROM public.tenant_users
 WHERE tenant_id = $1::uuid`;

const tenantMemberCount = async (client, tenantId) => {
  const n = (await client.query(TENANT_MEMBER_COUNT_SQL, [tenantId])).rows[0]?.member_count;
  return Number.isInteger(n) ? n : null;
};

/**
 * Serializes the platform owner's first invite per tenant for the rest of the
 * transaction, so two concurrent first invites cannot both see zero members.
 * SQL 90's aws_first_invite_allowed takes the same lock.
 */
/** The target's memberships the caller may remove: tenants both belong to (optionally one tenant). */
export const REMOVABLE_MEMBERSHIPS_SQL = `SELECT target.tenant_id
  FROM public.tenant_users target
  JOIN public.tenant_users mine ON mine.tenant_id = target.tenant_id AND mine.user_id = $2::uuid
 WHERE target.user_id = $1::uuid
   AND ($3::uuid IS NULL OR target.tenant_id = $3::uuid)`;

export const FIRST_INVITE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('first-invite:' || $1::uuid::text, 0))`;

/**
 * Creates (or finds) the invitee's profile and Cognito identity link (SQL 90,
 * SECURITY DEFINER): checks the caller is a member of the tenant or the
 * platform owner making a locked first invite, refuses the platform owner as
 * invitee and never re-points an existing cognito_sub. Returns the user id.
 */
export const INVITE_CREATE_USER_IDENTITY_SQL = `SELECT public.aws_invite_create_user_identity($1::uuid, $2::text, $3::text, $4::text)::text AS user_id`;

/** True when the application user is the platform owner (identity or profile email). */
export const USER_IS_PLATFORM_OWNER_SQL = `SELECT 1
  FROM public.identity_accounts ia
 WHERE ia.application_user_id = $1::uuid
   AND lower(ia.email) = $2
 UNION ALL
SELECT 1
  FROM public.profiles p
 WHERE p.id = $1::uuid
   AND lower(p.email) = $2
 LIMIT 1`;

export const userIsPlatformOwner = async (client, userId) => (
  (await client.query(USER_IS_PLATFORM_OWNER_SQL, [userId, PLATFORM_OWNER_EMAIL])).rows.length > 0
);

/** The application user an existing Cognito login is already linked to. */
export const IDENTITY_BY_SUB_SQL = `SELECT application_user_id::text AS application_user_id
  FROM public.identity_accounts
 WHERE cognito_sub = $1
 LIMIT 1`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Removes a Cognito user this request created, after a later step failed, so
 * a failed invite leaves no login behind. Best-effort: the Lambda role may not
 * hold cognito-idp:AdminDeleteUser; the response says whether it worked.
 */
const deleteCreatedCognitoUser = async (adminCognito, email, client, cognitoSub) => {
  // Re-check right before deleting: never delete a login that an identity
  // mapping (committed by another request) points at.
  try {
    if (cognitoSub && (await client.query(IDENTITY_BY_SUB_SQL, [String(cognitoSub)])).rows.length) {
      return 'kept_linked';
    }
  } catch {
    return 'kept_unverified';
  }
  try {
    await adminCognito('AdminDeleteUser', { UserPoolId: POOL_ID(), Username: email });
    return 'deleted';
  } catch (error) {
    return `delete_failed:${String(error?.name || 'CognitoError').slice(0, 80)}`;
  }
};

/**
 * The tenant invite email (template tenant-user-invite, tenant branding,
 * tenant login URL). Shared by the invite and the member Resend. A send
 * failure is reported, never thrown.
 */
const sendTenantInviteEmail = async ({
  client, tenant, email, send,
}) => {
  const origin = emailAssetOrigin();
  const loginUrl = tenant.custom_domain
    ? `https://${tenant.custom_domain}/login`
    : `${origin}/login`;
  const branding = await resolveEmailBranding(client, { tenantId: tenant.id });
  const rendered = renderTransactionalTemplate('tenant-user-invite', {
    tenantName: tenant.name,
    role: 'a member',
    loginUrl,
    branding,
  });
  const mailer = send || sendViaSesOrSink;
  try {
    await mailer({
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      from: branding.from,
      replyTo: branding.replyTo,
    });
    return { inviteSent: true, inviteError: null };
  } catch (error) {
    return { inviteSent: false, inviteError: String(error?.message || error).slice(0, 200) };
  }
};

export const runTenantInviteUser = async ({
  client, mapping, body, spoof, send, cognitoJson: cognitoFn, identityScope,
}) => {
  const adminCognito = cognitoFn || cognitoJson;
  const tenantId = body.tenant_id || body.tenantId;
  const email = normalizeEmail(body.email);
  // There is no role choice: any client-supplied role is ignored. The
  // membership row takes the column default for tenant_users.role (the repo
  // schema default is 'viewer'), which authorization ignores.
  const fullName = body.full_name || body.fullName || email;
  if (!tenantId || !email) {
    return { ok: false, statusCode: 400, error: 'Missing tenant_id or email', spoofFieldsIgnored: spoof };
  }
  if (!UUID_RE.test(String(tenantId))) {
    return { ok: false, statusCode: 400, error: 'invalid_uuid', field: 'tenant_id', spoofFieldsIgnored: spoof };
  }
  // The platform owner is never a member of a tenant.
  if (email === PLATFORM_OWNER_EMAIL) {
    return { ok: false, statusCode: 403, error: 'platform_owner_not_invitable', message: 'The platform owner cannot be added to a company', spoofFieldsIgnored: spoof };
  }
  // Any member of this tenant may invite teammates. The platform owner may
  // only make a new tenant's first invite: the tenant must have no
  // tenant_users rows yet.
  if (!(await assertTenantMember(client, mapping, tenantId))) {
    if (!(await isPlatformOwner(client))) {
      return { ok: false, statusCode: 403, error: 'Not authorized — must be a member of this company', spoofFieldsIgnored: spoof };
    }
    await client.query(FIRST_INVITE_LOCK_SQL, [tenantId]);
    if ((await tenantMemberCount(client, tenantId)) !== 0) {
      return {
        ok: false,
        statusCode: 403,
        error: 'first_invite_only',
        message: 'This company already has members; its members invite teammates',
        spoofFieldsIgnored: spoof,
      };
    }
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

  // Every step below runs in this request's one transaction (withIdentity),
  // inside a savepoint: a failure rolls the identity link and membership back
  // to the savepoint (and the request returns ok:false, so withIdentity rolls
  // back the rest). A Cognito user created by this request is then deleted,
  // unless an identity mapping still points at it.
  const SAVEPOINT = 'tenant_invite_identity';
  let inSavepoint = false;
  const failInvite = async (statusCode, error, message) => {
    if (inSavepoint) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`); } catch { /* the request rolls back anyway */ }
      inSavepoint = false;
    }
    return {
      ok: false,
      statusCode,
      error,
      message: message ? String(message).slice(0, 240) : undefined,
      cognitoCleanup: isNewUser
        ? await deleteCreatedCognitoUser(adminCognito, email, client, cognitoSub)
        : 'not_created_by_this_request',
      spoofFieldsIgnored: spoof,
    };
  };
  if (!cognitoSub) return failInvite(502, 'cognito_sub_missing');

  let appUserId = null;
  try {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    inSavepoint = true;
    appUserId = (await client.query(
      INVITE_CREATE_USER_IDENTITY_SQL,
      [tenantId, email, fullName, String(cognitoSub)],
    )).rows[0]?.user_id || null;
  } catch (error) {
    if (error?.code === '42501' && /platform_owner/.test(String(error?.message || ''))) {
      return failInvite(403, 'platform_owner_not_invitable', 'The platform owner cannot be added to a company');
    }
    if (error?.code === '42501') return failInvite(403, 'not_authorized', error?.message || error);
    if (/identity_link_conflict/.test(String(error?.message || ''))) {
      return failInvite(409, 'identity_link_conflict', 'This login is already linked to a different account.');
    }
    return failInvite(500, 'invite_identity_failed', error?.message || error);
  }
  if (!appUserId) return failInvite(500, 'invite_identity_failed');

  // The platform owner is never added to a tenant, whatever email the login uses.
  if (await userIsPlatformOwner(client, appUserId)) {
    return failInvite(403, 'platform_owner_not_invitable', 'The platform owner cannot be added to a company');
  }

  // Production /identity/me resolves via identity_production_cognito_locks
  // (live since before this release). Login must not write that table, so the
  // invite binds it here with the server-resolved Cognito sub + application
  // user only (never email, client user id or tenant_id). Staging is a no-op.
  let lockResult;
  try {
    lockResult = await bindProductionCognitoLock(client, {
      cognitoSub: String(cognitoSub),
      applicationUserId: appUserId,
      identityScope,
    });
  } catch (error) {
    return failInvite(500, 'identity_lock_failed', error?.message || error);
  }
  if (!lockResult.ok) {
    return failInvite(
      lockResult.error === 'identity_lock_conflict' ? 409 : 500,
      lockResult.error,
      lockResult.message,
    );
  }

  try {
    await client.query(
      `INSERT INTO public.tenant_users (id, tenant_id, user_id, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), tenantId, appUserId],
    );
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    inSavepoint = false;
  } catch (error) {
    // Fail loudly: an invite that did not create the membership is not an invite.
    return failInvite(500, 'tenant_membership_failed', error?.message || error);
  }

  const { inviteSent, inviteError } = await sendTenantInviteEmail({ client, tenant, email, send });

  return {
    ok: true,
    statusCode: 200,
    success: true,
    invited: true,
    // The SPA reads the snake_case fields (TenantUserManager, AdminTenants).
    invite_sent: inviteSent,
    invite_error: inviteError,
    is_new_user: isNewUser,
    isNewUser,
    email,
    applicationUserId: appUserId,
    cognitoSub,
    tempPasswordIssued: isNewUser,
    spoofFieldsIgnored: spoof,
  };
};

/**
 * A login created by the invite keeps its suppressed temporary password, so it
 * stays in FORCE_CHANGE_PASSWORD, where Cognito offers no EMAIL_OTP sign-in.
 * Once the invite has committed, set a random permanent password that is never
 * returned, logged or sent; the invitee signs in with an email code. Logins the
 * invite did not create are never touched. A failure keeps the invite.
 */
export const confirmInvitedLogin = async ({ email, cognitoJson: cognitoFn }) => {
  const adminCognito = cognitoFn || cognitoJson;
  try {
    await adminCognito('AdminSetUserPassword', {
      UserPoolId: POOL_ID(),
      Username: email,
      Password: `Inv-${randomBytes(24).toString('base64url')}!a1`,
      Permanent: true,
    });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'invite_login_confirm_failed', error_name: String(error?.name || 'Error').slice(0, 80) }));
    return false;
  }
};

export const handleTenantInviteUser = async (event, deps = {}) => {
  const result = await withIdentity(event, (ctx) => (
    runTenantInviteUser({
      ...ctx,
      identityScope: deps.identityScope,
      send: deps.sendViaSesOrSink,
      cognitoJson: deps.cognitoJson,
    })
  ), { write: true, commit: true, ...deps });
  // withIdentity has committed by the time it returns an ok result.
  if (result?.ok !== true || !result.isNewUser || Number(result.statusCode || 200) >= 400) return result;
  return { ...result, login_ready: await confirmInvitedLogin({ email: result.email, cognitoJson: deps.cognitoJson }) };
};

export const handleCreateTenantUser = async (event) => handleTenantInviteUser(event);

/** The member of the tenant whose login email is $2 (normalized, lower case). */
export const TENANT_MEMBER_BY_EMAIL_SQL = `SELECT tu.user_id::text AS user_id
  FROM public.tenant_users tu
  JOIN public.identity_accounts ia ON ia.application_user_id = tu.user_id
 WHERE tu.tenant_id = $1::uuid
   AND lower(ia.email) = $2
 LIMIT 1`;

/**
 * Member "Resend" on the tenant page: sends the tenant invite email again to
 * an existing member of the tenant. The caller is the platform owner or a
 * member of that tenant. Cognito, the identity link and the membership are
 * not touched (the member signs in with an email code).
 */
export const runTenantInviteResend = async ({
  client, mapping, body, spoof, send,
}) => {
  const tenantId = body.tenant_id || body.tenantId;
  const email = normalizeEmail(body.email);
  const refuse = (statusCode, error, message, extra = {}) => ({
    ok: false, statusCode, error, message, invite_sent: false, spoofFieldsIgnored: spoof, ...extra,
  });
  if (!UUID_RE.test(String(tenantId || ''))) {
    return refuse(400, 'invalid_uuid', 'Choose a company first.', { field: 'tenant_id' });
  }
  if (!email) return refuse(400, 'invalid_email', 'Enter the member\'s email address.', { field: 'email' });
  if (!(await assertTenantMember(client, mapping, tenantId)) && !(await isPlatformOwner(client))) {
    return refuse(403, 'not_authorized', 'Only members of this company or the ChecksOps platform owner can resend an invite.');
  }
  const tenant = (await client.query(
    `SELECT id, slug, name, custom_domain FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
    [tenantId],
  )).rows[0];
  if (!tenant) return refuse(404, 'tenant_not_found', 'That company was not found.');
  const member = email === PLATFORM_OWNER_EMAIL
    ? null
    : (await client.query(TENANT_MEMBER_BY_EMAIL_SQL, [tenantId, email])).rows[0];
  if (!member) {
    return refuse(404, 'member_not_found', 'That email is not a member of this company. Use Invite to add them.');
  }
  const { inviteSent } = await sendTenantInviteEmail({ client, tenant, email, send });
  if (!inviteSent) {
    return refuse(502, 'invite_email_failed', 'The invite email could not be sent. Try again in a moment.');
  }
  return {
    ok: true,
    statusCode: 200,
    invite_sent: true,
    message: `Invite email sent to ${email}.`,
    spoofFieldsIgnored: spoof,
  };
};

export const handleTenantInviteResend = async (event, deps = {}) => withIdentity(event, (ctx) => (
  runTenantInviteResend({ ...ctx, send: deps.sendViaSesOrSink })
), deps);

export const runDeleteUser = async ({
  client, mapping, body, spoof, cognitoJson: cognitoFn,
}) => {
  const adminCognito = cognitoFn || cognitoJson;
  const userId = body.userId || body.user_id;
  const email = normalizeEmail(body.email);
  const tenantId = body.tenant_id || body.tenantId || null;
  if (!userId && !email) {
    return { ok: false, statusCode: 400, error: 'missing_user', spoofFieldsIgnored: spoof };
  }
  if (!(await isPlatformOwner(client))) {
    // Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
    // A member removes a user only from the tenants they belong to. Disabling
    // the login reaches every tenant, so it stays with the platform owner.
    if (!userId) {
      return { ok: false, statusCode: 400, error: 'missing_user', spoofFieldsIgnored: spoof };
    }
    // A tenant never loses its last member here: an empty tenant reopens the
    // platform owner's first invite. The count runs under the same per-tenant
    // first-invite advisory lock SQL 90's aws_first_invite_allowed takes.
    const removable = (await client.query(REMOVABLE_MEMBERSHIPS_SQL, [userId, mapping.application_user_id, tenantId]))
      .rows.map((row) => String(row.tenant_id)).sort();
    for (const removableTenantId of removable) {
      await client.query(FIRST_INVITE_LOCK_SQL, [removableTenantId]);
      const count = await tenantMemberCount(client, removableTenantId);
      if (count === null || count <= 1) {
        return {
          ok: false,
          statusCode: 409,
          error: 'last_member_protected',
          message: 'A company must keep at least one member.',
          tenant_id: removableTenantId,
          spoofFieldsIgnored: spoof,
        };
      }
    }
    const removed = await client.query(
      `DELETE FROM public.tenant_users
        WHERE user_id = $1::uuid
          AND ($3::uuid IS NULL OR tenant_id = $3::uuid)
          AND tenant_id IN (
            SELECT mine.tenant_id FROM public.tenant_users mine
             WHERE mine.user_id = $2::uuid)`,
      [userId, mapping.application_user_id, tenantId],
    );
    if (!(removed?.rowCount > 0)) {
      return { ok: false, statusCode: 403, error: 'not_authorized', spoofFieldsIgnored: spoof };
    }
    return {
      ok: true,
      statusCode: 200,
      disabled: false,
      removed_from_tenants: removed.rowCount,
      spoofFieldsIgnored: spoof,
    };
  }
  // Platform owner: disable the login (soft-disable; Cognito is not
  // hard-deleted). Tenant memberships are the tenant's own: the platform owner
  // does not edit them (RLS has no platform-owner tenant_users write), its
  // members remove teammates.
  let loginEmail = email;
  if (!loginEmail && userId) {
    loginEmail = normalizeEmail((await client.query(
      `SELECT email FROM public.identity_accounts WHERE application_user_id = $1::uuid LIMIT 1`,
      [userId],
    )).rows[0]?.email);
  }
  if (!loginEmail) {
    return { ok: false, statusCode: 404, error: 'login_not_found', spoofFieldsIgnored: spoof };
  }
  if (loginEmail === PLATFORM_OWNER_EMAIL) {
    return { ok: false, statusCode: 403, error: 'platform_owner_protected', spoofFieldsIgnored: spoof };
  }
  // Only a login that does not exist counts as disabled. Any other Cognito
  // error (AccessDenied, throttling) fails loudly: reporting "disabled" while
  // the person can still sign in is worse than reporting the failure.
  try {
    await adminCognito('AdminDisableUser', { UserPoolId: POOL_ID(), Username: loginEmail });
  } catch (error) {
    if (error?.name !== 'UserNotFoundException') {
      return {
        ok: false,
        statusCode: 502,
        error: 'login_disable_failed',
        reason: String(error?.name || 'CognitoError').slice(0, 80),
        disabled: false,
        spoofFieldsIgnored: spoof,
      };
    }
  }
  return { ok: true, statusCode: 200, disabled: true, spoofFieldsIgnored: spoof };
};

export const handleDeleteUser = async (event, deps = {}) => withIdentity(event, (ctx) => (
  runDeleteUser({ ...ctx, cognitoJson: deps.cognitoJson })
), { write: true, commit: true, ...deps });

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
  if (!(await assertTenantMember(client, mapping, tenantId))) {
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
  if (!(await assertTenantMember(client, mapping, tenantId))) {
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
  if (!(await assertTenantMember(client, mapping, tenantId))) {
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

const sendMortgageAgentInvite = async ({ client, send, email, fullName }) => {
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
};

/**
 * Re-hiring an agent whose login an earlier hire created but never confirmed
 * (still FORCE_CHANGE_PASSWORD, where Cognito offers no email code) repairs it:
 * only a login linked to this same agent, only in that state. Returns null when
 * there is nothing to repair; any other login is never touched.
 */
const repairUnconfirmedAgentLogin = async ({ client, adminCognito, email, appUserId }) => {
  let login;
  try {
    login = await adminCognito('AdminGetUser', { UserPoolId: POOL_ID(), Username: email });
  } catch {
    return null;
  }
  if (login?.UserStatus !== 'FORCE_CHANGE_PASSWORD') return null;
  const sub = (login.UserAttributes || []).find((a) => a.Name === 'sub')?.Value || login.Username;
  if (!sub) return null;
  const linkedUserId = (await client.query(IDENTITY_BY_SUB_SQL, [String(sub)])).rows[0]?.application_user_id || null;
  if (!linkedUserId || String(linkedUserId) !== String(appUserId)) return null;
  return { confirmed: await confirmInvitedLogin({ email, cognitoJson: adminCognito }) };
};

/**
 * Hire mortgage desk agent (Class A Cognito bridge for hire-mortgage-agent).
 * Preserves production semantics: mortgage_agent-only accounts, identity mapping
 * Cognito sub → application UUID (never equal). Cognito still needs a temp
 * password internally with MessageAction SUPPRESS; it is never emailed, logged,
 * or returned. The invite is passwordless login: handleHireMortgageAgent
 * confirms a login this hire created once the hire has committed.
 */
export const runHireMortgageAgent = async ({
  client, mapping, body, spoof, send, cognitoJson: cognitoFn,
}) => {
  const adminCognito = cognitoFn || cognitoJson;
  // Hiring a mortgage agent grants a platform role (user_roles): the platform
  // owner only. A global user_roles admin is not enough.
  if (!(await isPlatformOwner(client))) {
    return { ok: false, statusCode: 403, error: 'Platform owner access required', spoofFieldsIgnored: spoof };
  }

  const email = normalizeEmail(body.email);
  const fullName = String(body.full_name || body.fullName || '').trim();
  if (!email || !fullName) {
    return { ok: false, statusCode: 400, error: 'Name and email are required', spoofFieldsIgnored: spoof };
  }
  if (email === PLATFORM_OWNER_EMAIL) {
    return { ok: false, statusCode: 403, error: 'platform_owner_protected', spoofFieldsIgnored: spoof };
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
  let loginToConfirm = false;

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
      const repair = await repairUnconfirmedAgentLogin({ client, adminCognito, email, appUserId });
      if (!repair) {
        return {
          ok: false,
          statusCode: 409,
          error: 'User already has mortgage ops access.',
          spoofFieldsIgnored: spoof,
        };
      }
      if (!repair.confirmed) {
        return {
          ok: false,
          statusCode: 502,
          error: 'login_repair_failed',
          message: 'The agent login could not be made ready for email-code sign-in.',
          spoofFieldsIgnored: spoof,
        };
      }
      await sendMortgageAgentInvite({ client, send, email, fullName });
      return {
        ok: true,
        statusCode: 200,
        success: true,
        user_id: appUserId,
        email,
        full_name: fullName,
        created: false,
        login_repaired: true,
        login_ready: true,
        invitationSent: true,
        applicationUserId: appUserId,
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
    loginToConfirm = true;
    if (providedPassword) {
      try {
        await adminCognito('AdminSetUserPassword', {
          UserPoolId: POOL_ID(),
          Username: email,
          Password: providedPassword,
          Permanent: true,
        });
        loginToConfirm = false;
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

  // Never re-point an existing Cognito login to another application user.
  const linkedUserId = (await client.query(IDENTITY_BY_SUB_SQL, [String(cognitoSub)])).rows[0]?.application_user_id || null;
  if (linkedUserId && appUserId && String(linkedUserId) !== String(appUserId)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'identity_link_conflict',
      message: 'This login is already linked to a different account.',
      spoofFieldsIgnored: spoof,
    };
  }
  if (linkedUserId && !appUserId) {
    const linkedRoles = (await client.query(
      `SELECT role FROM public.user_roles WHERE user_id = $1::uuid`,
      [linkedUserId],
    )).rows.map((r) => r.role);
    if (linkedRoles.includes('staff') || linkedRoles.includes('admin') || linkedRoles.includes('mortgage_agent')) {
      return {
        ok: false,
        statusCode: 409,
        error: 'identity_link_conflict',
        message: 'This login is already linked to an account with platform roles.',
        spoofFieldsIgnored: spoof,
      };
    }
    appUserId = linkedUserId;
  }
  if (appUserId && await userIsPlatformOwner(client, appUserId)) {
    return { ok: false, statusCode: 403, error: 'platform_owner_protected', spoofFieldsIgnored: spoof };
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
     ON CONFLICT (cognito_sub) DO NOTHING`,
    [cognitoSub, appUserId, email],
  );

  await client.query(
    `INSERT INTO public.profiles (id, email, full_name, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [appUserId, email, fullName],
  );

  let roleOk = false;
  try {
    const roleInsert = await client.query(
      `INSERT INTO public.user_roles (user_id, role)
       VALUES ($1::uuid, 'mortgage_agent')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [appUserId],
    );
    roleOk = Boolean(roleInsert?.rows?.length);
  } catch {
    try {
      const roleInsert = await client.query(
        `INSERT INTO public.user_roles (id, user_id, role)
         VALUES ($1::uuid, $2::uuid, 'mortgage_agent')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [randomUUID(), appUserId],
      );
      roleOk = Boolean(roleInsert?.rows?.length);
    } catch {
      roleOk = false;
    }
  }

  if (!roleOk) {
    const has = (await client.query(
      `SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role = 'mortgage_agent' LIMIT 1`,
      [appUserId],
    )).rows[0];
    if (!has) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Failed to grant mortgage_agent role',
        spoofFieldsIgnored: spoof,
      };
    }
  }

  // Live production behaviour: an (re)hired agent's compensation account is
  // active. A savepoint keeps the hire going if SQL 47 is not applied.
  try {
    await client.query('SAVEPOINT hire_mortgage_agent_account');
    await client.query(
      `INSERT INTO public.mortgage_agent_accounts (application_user_id, status)
       VALUES ($1::uuid, 'active')
       ON CONFLICT (application_user_id) DO UPDATE
         SET status = 'active',
             deactivated_at = NULL,
             deactivated_by = NULL,
             updated_at = now()`,
      [appUserId],
    );
    await client.query('RELEASE SAVEPOINT hire_mortgage_agent_account');
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT hire_mortgage_agent_account'); } catch { /* request rolls back */ }
  }

  await sendMortgageAgentInvite({ client, send, email, fullName });

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
    loginToConfirm,
    spoofFieldsIgnored: spoof,
  };
};

export const handleHireMortgageAgent = async (event, deps = {}) => {
  const result = await withIdentity(event, (ctx) => (
    runHireMortgageAgent({
      ...ctx,
      send: deps.sendViaSesOrSink,
      cognitoJson: deps.cognitoJson,
    })
  ), { write: true, commit: true, ...deps });
  if (!result || typeof result !== 'object' || !('loginToConfirm' in result)) return result;
  const { loginToConfirm, ...rest } = result;
  // withIdentity has committed by the time it returns an ok result.
  if (rest.ok !== true || !loginToConfirm || Number(rest.statusCode || 200) >= 400) return rest;
  return { ...rest, login_ready: await confirmInvitedLogin({ email: rest.email, cognitoJson: deps.cognitoJson }) };
};

