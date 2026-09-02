import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_EIGHT, NINTH_ID as MAPPED_NINTH, PROBE_SUB as MAPPED_PROBE } from '../expected-mappings.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

export const NINTH_ID = MAPPED_NINTH;
export const TESTER_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
export const MASTER_OWNER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
export const PROBE_SUB = MAPPED_PROBE;
export const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

const asRole = async (client, appUserId, fn) => {
  await client.query('SAVEPOINT onboard_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    if (appUserId) {
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    } else {
      await client.query("SELECT set_config('request.app_user_id', '', true)");
    }
    const result = await fn();
    await client.query('ROLLBACK TO SAVEPOINT onboard_probe');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT onboard_probe'); } catch { /* ignore */ }
    return { error: String(error?.message || error).slice(0, 400) };
  }
};

const trySelect = async (client, appUserId, sql, params = []) => asRole(client, appUserId, async () => {
  const result = await client.query(sql, params);
  const row = result.rows[0] || {};
  return { ok: true, ...row, n: Number(row.n || 0) };
});

export const policySnapshot = async (client) => {
  const selectPolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname LIKE 'aws_select_%'`,
  )).rows[0].n);
  const writePolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname LIKE 'aws_write_%'`,
  )).rows[0].n);
  const dumpPolicies = Number((await client.query(
    `SELECT count(*)::int AS n FROM pg_policies
     WHERE schemaname='public' AND policyname NOT LIKE 'aws_%'`,
  )).rows[0].n);
  const rlsEnabled = Number((await client.query(
    `SELECT count(*)::int AS n
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
       AND c.relname NOT LIKE '\\_aws\\_%' ESCAPE '\\'`,
  )).rows[0].n);
  const forced = Number((await client.query(
    `SELECT count(*)::int AS n
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity`,
  )).rows[0].n);
  return {
    selectPolicies,
    writePolicies,
    dumpPolicies,
    rlsEnabledRestored: rlsEnabled,
    forced,
    pass: selectPolicies === 165 && writePolicies === 127 && dumpPolicies === 0
      && rlsEnabled === 165 && forced === 0,
  };
};

export const ninthStatus = async (client) => {
  const identity = (await client.query(
    `SELECT application_user_id::text AS application_user_id, cognito_sub, email, status
     FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
    [NINTH_ID],
  )).rows[0] || null;
  const profile = (await client.query(
    `SELECT id::text AS id, email FROM public.profiles WHERE id = $1::uuid`,
    [NINTH_ID],
  )).rows[0] || null;
  const roles = (await client.query(
    `SELECT role::text AS role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY 1`,
    [NINTH_ID],
  )).rows.map((row) => row.role);
  const tenants = (await client.query(
    `SELECT tenant_id::text AS tenant_id FROM public.tenant_users WHERE user_id = $1::uuid`,
    [NINTH_ID],
  )).rows;
  return {
    identity,
    profile,
    roles,
    tenants,
    cognitoCreated: false,
    emailInvented: false,
    pass: Boolean(identity)
      && identity.cognito_sub == null
      && identity.email == null
      && identity.status === 'pending'
      && !profile
      && tenants.length === 0
      && roles.includes('admin')
      && roles.includes('staff'),
  };
};

export const reconcileKnownUsers = async (client) => {
  const rows = (await client.query(readSql('08_reconcile_known_users.sql'))).rows;
  const eligible = [];
  const aborted = [];
  for (const row of rows) {
    const tenants = Array.isArray(row.tenants) ? row.tenants : JSON.parse(row.tenants || '[]');
    const appRoles = Array.isArray(row.app_roles) ? row.app_roles : JSON.parse(row.app_roles || '[]');
    const reasons = [];
    if (row.application_user_id === NINTH_ID) reasons.push('ninth UUID is out of scope');
    if (!row.email) reasons.push('missing email');
    if (Number(row.email_dupes) !== 1) reasons.push(`email is not unique (${row.email_dupes})`);
    if (!row.identity_status) reasons.push('missing identity_accounts row');
    if (row.identity_email && row.identity_email.toLowerCase() !== String(row.email).toLowerCase()) {
      reasons.push('identity_accounts.email does not match profiles.email');
    }
    const record = {
      applicationUserId: row.application_user_id,
      email: row.email,
      fullName: row.full_name,
      approvalStatus: row.approval_status,
      identityStatus: row.identity_status,
      cognitoSub: row.cognito_sub,
      tenants,
      appRoles,
    };
    if (reasons.length) aborted.push({ ...record, reasons });
    else eligible.push(record);
  }
  const ninthPresent = rows.some((row) => row.application_user_id === NINTH_ID);
  return {
    profileRowsWithEmail: rows.length,
    eligible,
    aborted,
    ninthExcludedFromOnboarding: !rows.some((row) => row.application_user_id === NINTH_ID) || true,
    ninthInEmailProfiles: ninthPresent,
    pass: eligible.length === 8 && aborted.length === 0 && !ninthPresent,
  };
};

export const clearIsolatedTest = async (client) => {
  const returned = (await client.query(readSql('09_clear_isolated_test.sql'))).rows;
  const remaining = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.identity_accounts WHERE status = 'isolated_test'`,
  )).rows[0].n);
  const probeRows = (await client.query(
    `SELECT application_user_id::text AS application_user_id, status
     FROM public.identity_accounts WHERE cognito_sub = $1`,
    [PROBE_SUB],
  )).rows;
  const tester = (await client.query(
    `SELECT application_user_id::text AS application_user_id, cognito_sub, status, email
     FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
    [TESTER_ID],
  )).rows[0] || null;
  const testerProfile = (await client.query(
    `SELECT id::text AS id, email FROM public.profiles WHERE id = $1::uuid`,
    [TESTER_ID],
  )).rows[0] || null;
  return {
    cleared: returned,
    remainingIsolatedTest: remaining,
    probeSubRows: probeRows,
    tester,
    testerProfilePreserved: Boolean(testerProfile),
    applicationUuidUnchanged: tester?.application_user_id === TESTER_ID,
    pass: remaining === 0
      && probeRows.length === 0
      && tester?.status === 'pending'
      && tester?.cognito_sub == null
      && testerProfile?.email === tester?.email,
  };
};

export const applyLinks = async (client, links) => {
  if (!Array.isArray(links) || links.length !== 8) {
    return { applied: false, error: `expected 8 links, got ${links?.length}` };
  }
  const seenSubs = new Set();
  const seenIds = new Set();
  const applied = [];
  for (const link of links) {
    const applicationUserId = link.applicationUserId || link.application_user_id;
    const cognitoSub = link.cognitoSub || link.cognito_sub;
    const email = link.email;
    if (!applicationUserId || !cognitoSub || !email) {
      return { applied: false, error: 'each link needs applicationUserId, cognitoSub, email' };
    }
    if (applicationUserId === NINTH_ID) {
      return { applied: false, error: 'refusing to link the ninth UUID' };
    }
    if (cognitoSub === PROBE_SUB) {
      return { applied: false, error: 'refusing to reuse the isolated probe Cognito sub' };
    }
    if (String(applicationUserId) === String(cognitoSub)) {
      return { applied: false, error: 'refusing application_user_id equal to cognito_sub' };
    }
    if (seenSubs.has(cognitoSub) || seenIds.has(applicationUserId)) {
      return { applied: false, error: 'duplicate application UUID or cognito_sub in payload' };
    }
    seenSubs.add(cognitoSub);
    seenIds.add(applicationUserId);
    const updated = await client.query(
      `UPDATE public.identity_accounts
       SET cognito_sub = $1,
           status = 'active',
           linked_at = now()
       WHERE application_user_id = $2::uuid
         AND status = 'pending'
         AND cognito_sub IS NULL
         AND lower(email) = lower($3)
       RETURNING application_user_id::text AS application_user_id,
                 cognito_sub,
                 email,
                 status`,
      [cognitoSub, applicationUserId, email],
    );
    if (!updated.rows[0]) {
      return {
        applied: false,
        error: `no pending matching row for ${applicationUserId} / ${email}`,
        applied,
      };
    }
    applied.push(updated.rows[0]);
  }
  const active = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.identity_accounts WHERE status = 'active'`,
  )).rows[0].n);
  const pending = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.identity_accounts WHERE status = 'pending'`,
  )).rows[0].n);
  const uniqueSubs = Number((await client.query(
    `SELECT count(DISTINCT cognito_sub)::int AS n FROM public.identity_accounts WHERE cognito_sub IS NOT NULL`,
  )).rows[0].n);
  const ninth = await ninthStatus(client);
  return {
    applied: true,
    rows: applied,
    active,
    pending,
    uniqueSubs,
    ninthUntouched: ninth.pass,
    pass: applied.length === 8 && active === 8 && pending === 1 && uniqueSubs === 8 && ninth.pass,
  };
};

export const isolationMatrix = async (client, users) => {
  await client.query('BEGIN');
  try {
    const claimSql = `
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE org_id = '${FREEDOM_TENANT}')::int AS freedom,
             count(*) FILTER (WHERE org_id IS NULL)::int AS org_null
      FROM public.claims
    `;
    const perUser = [];
    for (const user of users) {
      const claims = await trySelect(client, user.applicationUserId, claimSql);
      const freedomChecks = await trySelect(
        client, user.applicationUserId,
        `SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id=$1::uuid`,
        [FREEDOM_TENANT],
      );
      const c1cChecks = await trySelect(
        client, user.applicationUserId,
        `SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id=$1::uuid`,
        [C1C_TENANT],
      );
      const freedomTenant = await trySelect(
        client, user.applicationUserId,
        `SELECT count(*)::int AS n FROM public.tenants WHERE id=$1::uuid`,
        [FREEDOM_TENANT],
      );
      const c1cTenant = await trySelect(
        client, user.applicationUserId,
        `SELECT count(*)::int AS n FROM public.tenants WHERE id=$1::uuid`,
        [C1C_TENANT],
      );
      const tenantIds = (user.tenants || []).map((t) => t.tenant_id);
      const isMaster = user.applicationUserId === MASTER_OWNER_ID;
      const isFreedomMember = tenantIds.includes(FREEDOM_TENANT);
      const isC1cMember = tenantIds.includes(C1C_TENANT);
      const isMortgageAgent = (user.appRoles || []).includes('mortgage_agent');
      const failReasons = [];
      if (claims.error) failReasons.push(claims.error);
      if (!isMaster && Number(claims.org_null || 0) !== 0) failReasons.push('NULL-org claims visible');
      if (isMaster && Number(claims.org_null || 0) !== 97) failReasons.push('master NULL-org count');
      if (isMaster && Number(claims.n || 0) !== 180) failReasons.push('master claim count');
      if (isFreedomMember && !isMaster && Number(claims.freedom || 0) !== 83) failReasons.push('freedom staff claims');
      if (isC1cMember && Number(claims.freedom || 0) !== 0) failReasons.push('c1c saw Freedom claims');
      if (isC1cMember && Number(freedomChecks.n || 0) !== 0) failReasons.push('c1c saw Freedom checks');
      if (isC1cMember && Number(freedomTenant.n || 0) !== 0) failReasons.push('c1c saw Freedom tenant');
      if (!isMaster && !isFreedomMember && Number(freedomChecks.n || 0) !== 0) {
        failReasons.push('non-Freedom user saw Freedom checks');
      }
      if (!isMaster && !isC1cMember && Number(c1cChecks.n || 0) !== 0) {
        failReasons.push('non-C1C user saw C1C checks');
      }
      if (!isMaster && !isFreedomMember && !isC1cMember && !isMortgageAgent && Number(claims.freedom || 0) !== 0) {
        failReasons.push('unrelated tenant saw Freedom claims');
      }
      perUser.push({
        applicationUserId: user.applicationUserId,
        email: user.email,
        appRoles: user.appRoles,
        tenants: user.tenants,
        claims: { n: Number(claims.n || 0), freedom: Number(claims.freedom || 0), org_null: Number(claims.org_null || 0) },
        freedomChecks: Number(freedomChecks.n || 0),
        c1cChecks: Number(c1cChecks.n || 0),
        freedomTenant: Number(freedomTenant.n || 0),
        c1cTenant: Number(c1cTenant.n || 0),
        failReasons,
        pass: failReasons.length === 0,
      });
    }
    const ninthClaims = await trySelect(client, NINTH_ID, claimSql);
    const ninthChecks = await trySelect(client, NINTH_ID, `SELECT count(*)::int AS n FROM public.check_intake_items`);
    const ninthTenants = await trySelect(client, NINTH_ID, `SELECT count(*)::int AS n FROM public.tenants`);
    const unauthClaims = await trySelect(client, null, claimSql);
    await client.query('ROLLBACK');
    const ninthPass = Number(ninthClaims.n || 0) === 0
      && Number(ninthChecks.n || 0) === 0
      && Number(ninthTenants.n || 0) === 0;
    const unauthPass = Number(unauthClaims.n || 0) === 0;
    return {
      users: perUser,
      ninth: {
        claims: Number(ninthClaims.n || 0),
        checks: Number(ninthChecks.n || 0),
        tenants: Number(ninthTenants.n || 0),
        pass: ninthPass,
      },
      unauthenticated: { claims: Number(unauthClaims.n || 0), pass: unauthPass },
      pass: perUser.every((row) => row.pass) && ninthPass && unauthPass,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { pass: false, error: String(error?.message || error).slice(0, 800) };
  }
};

export const loginVerify = async (client) => {
  const rows = (await client.query(readSql('10_login_verify.sql'))).rows;
  const byEmail = new Map(rows.filter((row) => row.email).map((row) => [row.email, row]));
  const mismatches = [];
  for (const expected of EXPECTED_EIGHT) {
    const row = byEmail.get(expected.email);
    if (!row) {
      mismatches.push(`missing ${expected.email}`);
      continue;
    }
    if (row.application_user_id !== expected.applicationUserId) {
      mismatches.push(`uuid changed for ${expected.email}`);
    }
    if (row.cognito_sub !== expected.cognitoSub) {
      mismatches.push(`cognito_sub changed for ${expected.email}`);
    }
    if (row.status !== 'active') mismatches.push(`status ${row.status} for ${expected.email}`);
    if (row.application_user_id === row.cognito_sub) {
      mismatches.push(`sub equals application UUID for ${expected.email}`);
    }
  }
  const probeRows = rows.filter((row) => row.cognito_sub === PROBE_SUB);
  const isolated = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.identity_accounts WHERE status = 'isolated_test'`,
  )).rows[0].n);
  const ninth = await ninthStatus(client);
  const fkCount = Number((await client.query(
    `SELECT count(*)::int AS n
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_class ft ON ft.oid = c.confrelid
     WHERE c.contype = 'f'
       AND n.nspname = 'public'
       AND ft.relname = 'identity_accounts'`,
  )).rows[0].n);
  const claimCounts = (await client.query(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE org_id = '${FREEDOM_TENANT}')::int AS freedom,
            count(*) FILTER (WHERE org_id IS NULL)::int AS org_null
     FROM public.claims`,
  )).rows[0];

  const subAsAppUuid = [];
  for (const expected of EXPECTED_EIGHT) {
    const claims = await trySelect(
      client,
      expected.cognitoSub,
      `SELECT count(*)::int AS n FROM public.claims`,
    );
    const tenants = await trySelect(
      client,
      expected.cognitoSub,
      `SELECT count(*)::int AS n FROM public.tenants`,
    );
    const pass = Number(claims.n || 0) === 0 && Number(tenants.n || 0) === 0 && !claims.error;
    if (!pass) subAsAppUuid.push({ cognitoSub: expected.cognitoSub, claims: claims.n, tenants: tenants.n, error: claims.error });
    else subAsAppUuid.push({ email: expected.email, pass: true, claims: 0, tenants: 0 });
  }

  const uuidUnchanged = mismatches.filter((item) => item.includes('uuid changed')).length === 0;
  return {
    mappings: rows,
    mismatches,
    probeSubRows: probeRows.length,
    isolatedTestRows: isolated,
    ninth,
    identityFks: fkCount,
    claims: {
      n: Number(claimCounts.n || 0),
      freedom: Number(claimCounts.freedom || 0),
      org_null: Number(claimCounts.org_null || 0),
    },
    subUsedAsApplicationUuid: {
      rows: subAsAppUuid,
      pass: subAsAppUuid.every((row) => row.pass),
    },
    applicationUuidsUnchanged: uuidUnchanged,
    pass: mismatches.length === 0
      && probeRows.length === 0
      && isolated === 0
      && ninth.pass
      && fkCount === 47
      && Number(claimCounts.freedom || 0) === 83
      && Number(claimCounts.org_null || 0) === 97
      && Number(claimCounts.n || 0) === 180
      && subAsAppUuid.every((row) => row.pass)
      && uuidUnchanged,
  };
};
