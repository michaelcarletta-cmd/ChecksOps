/**
 * Phase 3A read-only CheckAlt production inventory.
 * Invoked only via Lambda { phase3aInventory: true }. Not an HTTP route.
 * Never returns secret values, full deposit account numbers, JWTs, or passwords.
 * Does not create secrets, apply SQL, lift flags, or call CheckAlt.
 */
import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';
import {
  buildClientConfig,
  EXPECTED_APPLICATION_ROLE,
  IDENTITY_PROBE,
  sanitizePublicError,
} from './db-health.mjs';
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from './cognito.mjs';
import { PRODUCTION_CHECKALT_SECRET_NAMES } from './providers/production/checkalt-secrets.mjs';
import { isJpegMagic, inspectOriented, isAlreadyDepositReady } from './providers/parity/checkalt-image.mjs';
import { downloadClaimFileBytes } from './providers/production/checkalt-images.mjs';

const { Client } = pg;

export const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const FREEDOM_ADMIN_USER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
export const FREEDOM_ADMIN_EMAIL = 'mcarletta@freedomadj.com';
export const EXPECTED_CHECKALT_DEPOSITS = 58;
export const FIRST_TEST_MAX_CENTS = 500;
export const PLANNED_WEBHOOK_CALLBACK = 'https://checksops.com/prep/webhooks/checkalt';
export const PHASE3A_SECRET_CONTRACT = Object.freeze({
  secretId: 'checksops/production/providers',
  consumedOnlyThrough: 'PROVIDER_SECRETS_ARN',
  names: [...PRODUCTION_CHECKALT_SECRET_NAMES],
  createNow: false,
});

export const SQL65_NEW_COLUMNS = Object.freeze([
  'idempotency_key',
  'amount_cents',
  'provider_http_attempted_at',
  'failure_class',
  'last_error',
]);
export const SQL65_NEW_INDEXES = Object.freeze([
  'checkalt_deposits_tenant_idempotency_key_uq',
  'idx_checkalt_deposits_idempotency_key',
]);
export const SQL65_NEW_FUNCTIONS = Object.freeze([
  'aws_financial_execution_active',
  'aws_checkalt_production_config',
  'aws_checkalt_writer_guard',
]);
export const SQL65_NEW_POLICIES = Object.freeze([
  'aws_financial_insert_checkalt_deposits',
  'aws_financial_update_checkalt_deposits',
]);

const SECRETISH = /^(password|username|fi_key|webhook_secret|cached_jwt|deposit_account_number|sso_user_id)$/i;
const JPEG_PATH = /\.jpe?g(\?|$)/i;
const SVG_PATH = /\.svg(\?|$)/i;

const withSavepoint = async (client, name, fn) => {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      /* keep original */
    }
    throw error;
  }
};

export const hostnameOf = (value) => {
  if (!value) return null;
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    const raw = String(value).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    return raw || null;
  }
};

export const classifyCheckAltHost = (hostname, { liveReadable = true } = {}) => {
  if (!liveReadable) {
    return {
      status: 'BLOCKED',
      hostname: null,
      reason: 'live_base_url_unreadable',
      vendorBlocker: true,
    };
  }
  const host = hostname ? String(hostname).toLowerCase() : null;
  if (!host) {
    return {
      status: 'BLOCKED',
      hostname: null,
      reason: 'base_url_missing',
      vendorBlocker: true,
    };
  }
  if (host === 'uatapi.checkalt.com' || host.includes('uat')) {
    return {
      status: 'BLOCKED',
      hostname: host,
      reason: 'uat_host',
      vendorBlocker: true,
    };
  }
  if (host.includes('sandbox')) {
    return {
      status: 'BLOCKED',
      hostname: host,
      reason: 'sandbox_host',
      vendorBlocker: true,
    };
  }
  if (host === 'checkalt-relay.checksops.com') {
    return {
      status: 'BLOCKED',
      hostname: host,
      reason: 'checksops_relay_not_vendor_fincapture',
      vendorBlocker: true,
    };
  }
  if (host === 'api2.checkalt.com') {
    return {
      status: 'VERIFIED',
      hostname: host,
      reason: 'live_checkalt_config_and_prior_production_migration_20260717180936',
      vendorBlocker: false,
    };
  }
  if (host === 'api.checkalt.com') {
    return {
      status: 'VERIFIED',
      hostname: host,
      reason: 'live_checkalt_config_authoritative',
      vendorBlocker: false,
    };
  }
  if (host.endsWith('.checkalt.com')) {
    return {
      status: 'BLOCKED',
      hostname: host,
      reason: 'host_not_proven_by_live_prior_integration_or_vendor_docs',
      vendorBlocker: true,
    };
  }
  return {
    status: 'BLOCKED',
    hostname: host,
    reason: 'unapproved_or_unknown_host',
    vendorBlocker: true,
  };
};

const asRoleList = (value) => {
  if (Array.isArray(value)) return value.map((role) => String(role || '').toLowerCase()).filter(Boolean);
  if (value == null) return [];
  return String(value)
    .replace(/[{}"]/g, '')
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
};

export const classifySql65Compatibility = ({
  columns = [],
  indexes = [],
  functions = [],
  policies = [],
  grants = {},
  rowCount = null,
} = {}) => {
  const presentColumns = SQL65_NEW_COLUMNS.filter((name) => columns.includes(name));
  const presentIndexes = SQL65_NEW_INDEXES.filter((name) => indexes.includes(name));
  const presentFunctions = SQL65_NEW_FUNCTIONS.filter((name) => functions.includes(name));
  const presentPolicies = SQL65_NEW_POLICIES.filter((name) => policies.includes(name));
  const legacyCountOk = rowCount === EXPECTED_CHECKALT_DEPOSITS;
  const noIdempotency = !presentColumns.includes('idempotency_key') && presentIndexes.length === 0;
  const grantsSafe = grants.canSelect === true
    && grants.canInsert === false
    && grants.canUpdate === false
    && grants.canDelete === false
    && grants.rlsEnabled === true;
  const schemaUnchanged = presentColumns.length === 0
    && presentIndexes.length === 0
    && presentFunctions.length === 0
    && presentPolicies.length === 0;
  const schemaSafe = noIdempotency && grantsSafe && schemaUnchanged;
  const safe = schemaSafe && legacyCountOk;
  return {
    status: safe ? 'SAFE_NOT_APPLIED' : (schemaSafe ? 'SCHEMA_SAFE_COUNT_DRIFT' : 'DRIFT_OR_UNSAFE'),
    schemaSafeToApplyLater: schemaSafe,
    safeToApplyLater: safe,
    applied: presentColumns.length > 0 || presentFunctions.length > 0 || presentPolicies.length > 0,
    expectedLegacyRows: EXPECTED_CHECKALT_DEPOSITS,
    liveRowCount: rowCount,
    legacyCountOk,
    noExistingIdempotencyColumnsOrIndexes: noIdempotency,
    noSchemaDriftSincePhase26: schemaUnchanged,
    noDriftSincePhase26: schemaUnchanged && legacyCountOk,
    presentColumns,
    presentIndexes,
    presentFunctions,
    presentPolicies,
    grants,
    nonDestructiveAddIfNotExists: true,
    doNotApplyNow: true,
  };
};

export const presence = (value) => {
  const text = value == null ? '' : String(value);
  const present = text.trim().length > 0;
  return { present, length: present ? text.length : 0 };
};

export const last4 = (value) => {
  const text = value == null ? '' : String(value).replace(/\s+/g, '');
  if (!text) return { present: false, last4: null, length: 0 };
  return { present: true, last4: text.slice(-4), length: text.length };
};

const looksJpegPath = (path) => Boolean(path) && JPEG_PATH.test(String(path)) && !SVG_PATH.test(String(path));

export const isPhase3aInventoryEvent = (event) => (
  event?.phase3aInventory === true
  && !event?.requestContext
  && !event?.rawPath
  && !event?.httpMethod
);

const columnSetOf = async (client, table) => {
  const rows = (await client.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  )).rows;
  return {
    names: rows.map((row) => row.column_name),
    details: rows.map((row) => ({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
    })),
  };
};

const inspectDepositJpeg = async (relPath, side) => {
  if (!relPath) return { ok: false, reason: `${side}_path_missing` };
  if (!looksJpegPath(relPath)) return { ok: false, reason: `${side}_path_not_jpeg` };
  try {
    const bytes = await downloadClaimFileBytes(relPath);
    if (!bytes?.length) return { ok: false, reason: `${side}_s3_missing` };
    if (!isJpegMagic(bytes)) return { ok: false, reason: `${side}_not_jpeg_magic` };
    const info = await inspectOriented(bytes);
    if (!isAlreadyDepositReady(info)) return { ok: false, reason: `${side}_not_deposit_ready` };
    return {
      ok: true,
      bytes: bytes.length,
      width: info.width || null,
      height: info.height || null,
    };
  } catch (error) {
    const msg = String(error?.message || error);
    if (/NoSuchKey|not found|invalid claim-files/i.test(msg)) return { ok: false, reason: `${side}_s3_missing` };
    return { ok: false, reason: `${side}_s3_unreadable` };
  }
};

export async function runPhase3aInventory({
  loadCredentials = loadDatabaseCredentials,
  createClient = (config) => new Client(config),
  inspectImages = true,
} = {}) {
  const result = {
    ok: false,
    readOnly: true,
    writesAttempted: false,
    liveProviderCalled: false,
    productionExecution: false,
    secretCreateAttempted: false,
    sql65ApplyAttempted: false,
    flagsChanged: false,
    webhook: {
      dryRunMustRemainTrue: true,
      plannedCallback: PLANNED_WEBHOOK_CALLBACK,
      vendorConfiguredThisPhase: false,
    },
    secretContract: PHASE3A_SECRET_CONTRACT,
    identity: {},
    checkaltConfig: { readable: false },
    freedomTenantAccount: { readable: false },
    sql65: { probed: false },
    candidates: { probed: false },
    authorization: { probed: false },
    issues: [],
  };

  let client;
  try {
    const credentials = await loadCredentials();
    client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 20000 }));
    await client.connect();
    await client.query('BEGIN READ ONLY');

    const identity = (await client.query(IDENTITY_PROBE)).rows[0] || {};
    result.identity = {
      currentDatabase: identity.current_database || null,
      currentUser: identity.current_user || null,
      transactionReadOnly: identity.transaction_read_only || null,
    };
    if (result.identity.currentUser !== EXPECTED_APPLICATION_ROLE) {
      result.issues.push(`connected_as_${result.identity.currentUser}_expected_checksops`);
    }

    await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, FREEDOM_ADMIN_USER_ID]);
    await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, FREEDOM_ADMIN_EMAIL]);
    const uid = (await client.query('SELECT auth.uid()::text AS auth_uid')).rows[0]?.auth_uid || null;
    result.identity.authUidMatchesFreedomAdmin = uid === FREEDOM_ADMIN_USER_ID;
    if (!result.identity.authUidMatchesFreedomAdmin) {
      result.issues.push('auth_uid_did_not_match_freedom_admin');
    }

    const configCols = await columnSetOf(client, 'checkalt_config');
    const accountCols = await columnSetOf(client, 'checkalt_tenant_accounts');
    const depositCols = await columnSetOf(client, 'checkalt_deposits');
    result.catalog = {
      checkalt_config: configCols.details,
      checkalt_tenant_accounts: accountCols.details,
      checkalt_deposits: depositCols.details,
    };

    result.checkaltConfig = await withSavepoint(client, 'cfg', async () => {
      const row = (await client.query(
        `SELECT *
         FROM public.checkalt_config
         WHERE singleton IS TRUE
         LIMIT 1`,
      )).rows[0] || null;
      if (!row) {
        return { readable: true, present: false, rowCount: 0 };
      }
      const host = hostnameOf(row.base_url);
      const hostClass = classifyCheckAltHost(host, { liveReadable: true });
      const secretCols = {};
      for (const name of ['username', 'password', 'fi_key', 'webhook_secret', 'cached_jwt']) {
        if (configCols.names.includes(name)) secretCols[name] = presence(row[name]);
        else secretCols[name] = { present: false, length: 0, columnPresent: false };
      }
      return {
        readable: true,
        present: true,
        singleton: row.singleton === true,
        merchant: row.merchant || null,
        defaultEnabled: row.default_enabled === true,
        depositorAccountIdPresent: presence(row.depositor_account_id).present,
        depositorAccountIdLength: presence(row.depositor_account_id).length,
        businessUnitPresent: presence(row.business_unit).present,
        autoApproveEnabled: row.auto_approve_enabled === true,
        baseHost: host,
        hostClass,
        username: { ...secretCols.username, source: 'checkalt_config.username' },
        password: { ...secretCols.password, source: 'checkalt_config.password' },
        fiKey: { ...secretCols.fi_key, source: 'checkalt_config.fi_key' },
        webhookSecret: { ...secretCols.webhook_secret, source: 'checkalt_config.webhook_secret' },
        cachedJwtPresent: secretCols.cached_jwt.present,
        extraSecretishColumns: configCols.names.filter((name) => SECRETISH.test(name)),
      };
    }).catch((error) => ({
      readable: false,
      error: sanitizePublicError(error),
      code: error?.code || null,
    }));

    result.freedomTenantAccount = await withSavepoint(client, 'acct', async () => {
      const tenant = (await client.query(
        `SELECT id::text AS id, name, slug
         FROM public.tenants
         WHERE id = $1::uuid`,
        [FREEDOM_TENANT_ID],
      )).rows[0] || null;
      const row = (await client.query(
        `SELECT tenant_id::text AS tenant_id, enabled, registered_at,
                sso_user_id, deposit_account_number, first_name, last_name, email,
                auto_approve_enabled, last_register_payload
         FROM public.checkalt_tenant_accounts
         WHERE tenant_id = $1::uuid
         LIMIT 1`,
        [FREEDOM_TENANT_ID],
      )).rows[0] || null;
      const accountCount = Number((await client.query(
        'SELECT count(*)::bigint AS n FROM public.checkalt_tenant_accounts',
      )).rows[0]?.n || 0);
      if (!row) {
        return {
          readable: true,
          present: false,
          tenant,
          accountCount,
        };
      }
      const sso = presence(row.sso_user_id);
      const acct = last4(row.deposit_account_number);
      const payloadSso = presence(row.last_register_payload?.sso_key);
      return {
        readable: true,
        present: true,
        tenant,
        accountCount,
        tenantId: row.tenant_id,
        enabled: row.enabled !== false,
        registeredAtPresent: Boolean(row.registered_at),
        ssoUserIdPresent: sso.present,
        ssoUserIdLength: sso.length,
        payloadSsoKeyPresent: payloadSso.present,
        depositAccountLast4: acct.last4,
        depositAccountLength: acct.length,
        depositorNamePresent: Boolean(row.first_name || row.last_name),
        depositorEmailPresent: presence(row.email).present,
        autoApproveEnabled: row.auto_approve_enabled === true,
      };
    }).catch((error) => ({
      readable: false,
      error: sanitizePublicError(error),
      code: error?.code || null,
    }));

    result.sql65 = await withSavepoint(client, 'sql65', async () => {
      const indexes = (await client.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'checkalt_deposits'`,
      )).rows.map((row) => row.indexname);
      const functions = (await client.query(
        `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = ANY($1::text[])`,
        [SQL65_NEW_FUNCTIONS],
      )).rows.map((row) => row.proname);
      const policies = (await client.query(
        `SELECT policyname, cmd
         FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'checkalt_deposits'`,
      )).rows;
      const grants = (await client.query(
        `SELECT has_table_privilege(current_user, 'public.checkalt_deposits', 'SELECT') AS can_select,
                has_table_privilege(current_user, 'public.checkalt_deposits', 'INSERT') AS can_insert,
                has_table_privilege(current_user, 'public.checkalt_deposits', 'UPDATE') AS can_update,
                has_table_privilege(current_user, 'public.checkalt_deposits', 'DELETE') AS can_delete,
                c.relrowsecurity AS rls_enabled,
                c.relforcerowsecurity AS rls_forced,
                pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'checkalt_deposits'`,
      )).rows[0] || {};
      const count = Number((await client.query(
        'SELECT count(*)::bigint AS n FROM public.checkalt_deposits',
      )).rows[0]?.n ?? 0);
      const byTenant = (await client.query(
        `SELECT coalesce(t.slug, 'unknown') AS slug,
                count(*)::int AS n,
                count(*) FILTER (
                  WHERE d.checkalt_reference IS NOT NULL AND btrim(d.checkalt_reference) <> ''
                )::int AS with_reference
         FROM public.checkalt_deposits d
         LEFT JOIN public.tenants t ON t.id = d.tenant_id
         GROUP BY 1
         ORDER BY 1`,
      )).rows.map((row) => ({
        slug: row.slug,
        count: Number(row.n),
        withReference: Number(row.with_reference),
      }));
      const compatibility = classifySql65Compatibility({
        columns: depositCols.names,
        indexes,
        functions,
        policies: policies.map((row) => row.policyname),
        grants: {
          canSelect: grants.can_select === true,
          canInsert: grants.can_insert === true,
          canUpdate: grants.can_update === true,
          canDelete: grants.can_delete === true,
          rlsEnabled: grants.rls_enabled === true,
          rlsForced: grants.rls_forced === true,
          owner: grants.owner || null,
        },
        rowCount: count,
      });
      return {
        probed: true,
        currentColumns: depositCols.names,
        currentIndexes: indexes,
        currentPolicies: policies.map((row) => ({ name: row.policyname, cmd: row.cmd })),
        currentFunctions: functions,
        visibleByTenant: byTenant,
        compatibility,
      };
    }).catch((error) => ({
      probed: false,
      error: sanitizePublicError(error),
      code: error?.code || null,
    }));

    result.authorization = await withSavepoint(client, 'authz', async () => {
      const users = (await client.query(
        `SELECT p.id::text AS id,
                p.email,
                tu.role AS tenant_role,
                ARRAY(
                  SELECT ur.role FROM public.user_roles ur
                  WHERE ur.user_id = p.id
                  ORDER BY ur.role
                ) AS platform_roles
         FROM public.tenant_users tu
         JOIN public.profiles p ON p.id = tu.user_id
         WHERE tu.tenant_id = $1::uuid
         ORDER BY p.email`,
        [FREEDOM_TENANT_ID],
      )).rows.map((row) => {
        const roles = [...new Set([
          String(row.tenant_role || '').toLowerCase(),
          ...asRoleList(row.platform_roles),
        ])].filter(Boolean);
        const financial = roles.some((role) => ['owner', 'admin', 'manager'].includes(role));
        return {
          email: row.email || null,
          applicationUserId: row.id,
          tenantRole: row.tenant_role || null,
          platformRoles: row.platform_roles || [],
          financialRole: financial,
        };
      });
      const financialUsers = users.filter((row) => row.financialRole);
      return {
        probed: true,
        freedomMemberCount: users.length,
        financialUsers,
        distinctFinancialUsers: financialUsers.length,
        dualControlImmediatelyUsable: financialUsers.length >= 2,
        totpEnrollmentCheckedHere: false,
      };
    }).catch((error) => ({
      probed: false,
      error: sanitizePublicError(error),
      code: error?.code || null,
    }));

    result.candidates = await withSavepoint(client, 'cands', async () => {
      const intakeCols = await columnSetOf(client, 'check_intake_items');
      const has = (name) => intakeCols.names.includes(name);
      const stageExpr = has('check_stage') ? 'c.check_stage::text' : 'NULL::text';
      const recExpr = has('deposit_recommendation') ? 'c.deposit_recommendation' : 'NULL::text';
      const reviewedExpr = has('reviewed_at') ? 'c.reviewed_at' : 'NULL::timestamptz';
      const rearExpr = has('back_image_deposit_path') ? 'c.back_image_deposit_path' : 'NULL::text';
      const readyClause = [
        has('deposit_recommendation') ? "c.deposit_recommendation = 'ready_for_deposit'" : null,
        has('check_stage') ? "c.check_stage::text = 'ready_for_deposit'" : null,
        "c.status IN ('ready', 'approved_for_deposit')",
      ].filter(Boolean).join(' OR ');
      const notDepositedStage = has('check_stage')
        ? "AND coalesce(c.check_stage::text, '') NOT IN ('deposited', 'returned', 'voided')"
        : '';
      const rows = (await client.query(`
        SELECT c.id::text AS id,
               c.amount,
               c.status,
               ${stageExpr} AS check_stage,
               ${recExpr} AS deposit_recommendation,
               ${reviewedExpr} AS reviewed_at,
               c.front_image_path,
               c.back_image_path,
               ${rearExpr} AS back_image_deposit_path,
               COALESCE(p.payee_count, 0)::int AS payee_count,
               COALESCE(p.complete_count, 0)::int AS complete_payee_count,
               COALESCE(p.rejected_count, 0)::int AS rejected_payee_count,
               COALESCE(d.deposit_rows, 0)::int AS deposit_rows,
               COALESCE(d.ref_rows, 0)::int AS deposit_ref_rows
        FROM public.check_intake_items c
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS payee_count,
                 count(*) FILTER (
                   WHERE lower(coalesce(endorsement_status, '')) IN ('signed', 'waived')
                 )::int AS complete_count,
                 count(*) FILTER (
                   WHERE lower(coalesce(endorsement_status, '')) = 'rejected'
                 )::int AS rejected_count
          FROM public.check_payees cp
          WHERE cp.check_id = c.id
        ) p ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS deposit_rows,
                 count(*) FILTER (
                   WHERE checkalt_reference IS NOT NULL AND btrim(checkalt_reference) <> ''
                 )::int AS ref_rows
          FROM public.checkalt_deposits d
          WHERE d.check_intake_item_id = c.id
        ) d ON true
        WHERE c.tenant_id = $1::uuid
          AND (${readyClause})
          ${notDepositedStage}
          AND coalesce(c.status, '') NOT IN ('deposited', 'voided', 'returned')
        ORDER BY c.amount ASC NULLS LAST, c.created_at ASC
        LIMIT 80
      `, [FREEDOM_TENANT_ID])).rows;

      const mapped = rows.map((row) => {
        const amountCents = row.amount == null ? null : Math.round(Number(row.amount) * 100);
        const fullyReviewed = Boolean(row.reviewed_at);
        const endorsementsComplete = Number(row.payee_count) > 0
          && Number(row.complete_payee_count) === Number(row.payee_count)
          && Number(row.rejected_payee_count) === 0;
        const noDepositRow = Number(row.deposit_rows) === 0;
        const noReference = Number(row.deposit_ref_rows) === 0;
        const frontPathOk = looksJpegPath(row.front_image_path);
        const rearPathOk = looksJpegPath(row.back_image_deposit_path);
        const tenantAccountPresent = result.freedomTenantAccount?.present === true
          && result.freedomTenantAccount?.enabled !== false
          && result.freedomTenantAccount?.ssoUserIdPresent === true
          && result.freedomTenantAccount?.depositAccountLast4 != null;
        const fails = [];
        if (!fullyReviewed) fails.push('not_fully_reviewed');
        if (!endorsementsComplete) fails.push('endorsements_incomplete');
        if (!noDepositRow) fails.push('existing_checkalt_deposits_row');
        if (!noReference) fails.push('existing_checkalt_reference');
        if (!frontPathOk) fails.push('front_deposit_jpeg_path_missing');
        if (!rearPathOk) fails.push('rear_deposit_jpeg_path_missing');
        if (!tenantAccountPresent) fails.push('freedom_tenant_account_incomplete');
        if (!Number.isInteger(amountCents) || amountCents <= 0) fails.push('invalid_amount');
        if (!(Number.isInteger(amountCents) && amountCents <= FIRST_TEST_MAX_CENTS)) fails.push('amount_above_5');
        return {
          id: row.id,
          amountCents,
          amountDollars: row.amount == null ? null : Number(row.amount),
          status: row.status || null,
          checkStage: row.check_stage || null,
          depositRecommendation: row.deposit_recommendation || null,
          fullyReviewed,
          endorsementsComplete,
          payeeCount: Number(row.payee_count),
          noDepositRow,
          noCheckaltReference: noReference,
          frontJpegPath: frontPathOk,
          rearDepositJpegPath: rearPathOk,
          tenantAccountPresent,
          qualifiesWithoutImageBytes: fails.filter((name) => name !== 'amount_above_5').length === 0,
          failReasons: fails,
          le5: Number.isInteger(amountCents) && amountCents <= FIRST_TEST_MAX_CENTS,
        };
      });

      const le5 = mapped.filter((row) => row.le5 && row.qualifiesWithoutImageBytes);
      const imageResults = [];
      if (inspectImages) {
        for (const cand of le5.slice(0, 8)) {
          const source = rows.find((row) => row.id === cand.id);
          const front = await inspectDepositJpeg(source?.front_image_path, 'front');
          const rear = await inspectDepositJpeg(source?.back_image_deposit_path, 'rear');
          imageResults.push({
            id: cand.id,
            amountCents: cand.amountCents,
            front,
            rear,
            validDepositJpegs: front.ok === true && rear.ok === true,
          });
        }
      }

      const qualifyingLe5 = inspectImages
        ? imageResults.filter((row) => row.validDepositJpegs).map((img) => {
          const base = le5.find((row) => row.id === img.id);
          return { ...base, images: img };
        })
        : le5;

      return {
        probed: true,
        readyForDepositCount: mapped.length,
        readyLe5Count: mapped.filter((row) => row.le5).length,
        qualifyingPathLe5Count: le5.length,
        qualifyingLe5: qualifyingLe5,
        otherwiseReadyAbove5Count: mapped.filter((row) => !row.le5 && row.qualifiesWithoutImageBytes).length,
        readyChecks: mapped.map((row) => ({
          id: row.id,
          amountCents: row.amountCents,
          amountDollars: row.amountDollars,
          status: row.status,
          checkStage: row.checkStage,
          depositRecommendation: row.depositRecommendation,
          failReasons: row.failReasons,
        })),
        newLowValueCheckRequired: qualifyingLe5.length === 0,
        imageInspected: inspectImages,
      };
    }).catch((error) => ({
      probed: false,
      error: sanitizePublicError(error),
      code: error?.code || null,
    }));

    await client.query('ROLLBACK');
    result.ok = true;
    return result;
  } catch (error) {
    result.ok = false;
    result.issues.push(sanitizePublicError(error));
    return result;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}
