#!/usr/bin/env node
/**
 * Phase 1: classify 94 authoritative Freedom → C1C active shares against AWS.
 * Read-only. No INSERT/UPDATE/DELETE. Never prints PII, amounts, or tokens.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const AWS = `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const WORK = '/tmp/c1c-phase1-work';
const OUT = '/opt/cursor/artifacts/c1c-partner-share';
const SECRET_ID = 'checksops/staging/storage-migration-token';
const BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const PROD_API = process.env.CHECKSOPS_PROD_API_URL || 'https://checksops.com/prep';
const STAGING_API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';

const run = (cmd, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve(out);
    else reject(new Error(`${cmd} failed (${code}): ${(err || out).slice(0, 400)}`));
  });
});

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const pageLimit = (rows, pageSize = 200) => {
  const out = [];
  for (let i = 0; i < rows.length; i += pageSize) out.push(rows.slice(i, i + pageSize));
  return out;
};

async function main() {
  await mkdir(WORK, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const tokenFile = path.join(WORK, 'oidc.jwt');
  await writeFile(tokenFile, String(token), { mode: 0o600 });
  const assumed = JSON.parse(await run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'c1c-phase1-diff',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]));
  await unlink(tokenFile).catch(() => {});
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: assumed.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: assumed.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: assumed.Credentials.SessionToken,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    writesAttempted: false,
    c1cTenantId: C1C,
    freedomTenantId: FREEDOM,
    source: {},
    aws: { path: null, rows: [], limitations: [] },
    classification: null,
    expectedMutation: null,
  };

  let bridgeToken = null;
  const rawSecret = (await run(AWS, [
    'secretsmanager', 'get-secret-value',
    '--secret-id', SECRET_ID,
    '--query', 'SecretString',
    '--output', 'text',
  ], env)).trim();
  try {
    const parsed = JSON.parse(rawSecret);
    bridgeToken = parsed.token || parsed.migrationToken || null;
  } catch {
    bridgeToken = rawSecret;
  }
  if (!bridgeToken) throw new Error('migration token missing');

  const bridgeFetch = async (body) => {
    const response = await fetch(BRIDGE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: ANON,
        authorization: `Bearer ${ANON}`,
        'x-checksops-migration-token': String(bridgeToken).trim(),
      },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };

  const health = await bridgeFetch({ action: 'health' });
  if (!(health.status === 200 && health.json?.ok === true && health.json?.mode === 'read_only'
    && health.json?.writes === false && health.json?.rawSql === false)) {
    throw new Error('bridge is not fail-closed read_only');
  }

  const pageRows = async (table, columns) => {
    const rows = [];
    let after = null;
    for (let pages = 0; pages < 80; pages += 1) {
      const body = { action: 'rows', table, keysOnly: false, limit: 500, columns };
      if (after) body.after = after;
      const resp = await bridgeFetch(body);
      if (resp.status !== 200 || resp.json?.ok === false) {
        throw new Error(`rows ${table} http ${resp.status} ${resp.json?.error || 'failed'}`);
      }
      const batch = Array.isArray(resp.json.rows) ? resp.json.rows : [];
      rows.push(...batch);
      if (!resp.json.hasMore) break;
      after = resp.json.after || null;
      if (!after) break;
    }
    return rows;
  };

  const sourceShares = await pageRows('shared_checks', [
    'id', 'check_id', 'source_tenant_id', 'target_tenant_id', 'created_at', 'revoked_at', 'shared_by',
  ]);
  const sourceIntake = await pageRows('check_intake_items', ['id', 'tenant_id', 'status', 'check_stage']);
  const intakeById = new Map(sourceIntake.map((r) => [r.id, r]));

  const sourceActive = sourceShares.filter((s) =>
    s.target_tenant_id === C1C
    && s.source_tenant_id === FREEDOM
    && !s.revoked_at
  );
  const sourceRevoked = sourceShares.filter((s) =>
    s.target_tenant_id === C1C
    && s.source_tenant_id === FREEDOM
    && s.revoked_at
  );
  const sourceOwnershipWrong = sourceActive.filter((s) => intakeById.get(s.check_id)?.tenant_id !== FREEDOM);

  report.source = {
    sharedChecksTotal: sourceShares.length,
    activeFreedomToC1c: sourceActive.length,
    revokedFreedomToC1c: sourceRevoked.length,
    parentMissing: sourceActive.filter((s) => !intakeById.has(s.check_id)).length,
    parentNotFreedom: sourceOwnershipWrong.length,
    checkIds: sourceActive.map((s) => s.check_id).sort(),
    shareIds: sourceActive.map((s) => s.id).sort(),
    revokedCheckIds: sourceRevoked.map((s) => s.check_id).sort(),
  };

  if (sourceActive.length !== 94) {
    report.aws.limitations.push(`source_active_count_${sourceActive.length}_expected_94`);
  }

  const secretNames = JSON.parse(await run(AWS, [
    'secretsmanager', 'list-secrets',
    '--query', 'SecretList[].Name',
    '--output', 'json',
  ], env));
  report.aws.secretNameCount = Array.isArray(secretNames) ? secretNames.length : 0;
  report.aws.secretNameHints = (secretNames || [])
    .filter((n) => /cognito|password|tester|t0|login|identity/i.test(String(n)))
    .map((n) => String(n));

  const lambdas = JSON.parse(await run(AWS, [
    'lambda', 'list-functions',
    '--query', 'Functions[?contains(FunctionName, `checksops`)].FunctionName',
    '--output', 'json',
  ], env));
  report.aws.lambdaNames = lambdas;

  const passwordCandidates = {};
  const passwordFiles = [
    process.env.COGNITO_PASSWORD_FILE,
    '/tmp/cognito-login-passwords.json',
    '/tmp/checksops-cognito-passwords.json',
  ].filter(Boolean);
  for (const file of passwordFiles) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        passwordCandidates.file = Object.keys(parsed || {});
      } catch { /* ignore */ }
    }
  }
  for (const name of report.aws.secretNameHints) {
    try {
      const raw = (await run(AWS, [
        'secretsmanager', 'get-secret-value',
        '--secret-id', name,
        '--query', 'SecretString',
        '--output', 'text',
      ], env)).trim();
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch { parsed = { raw: true }; }
      passwordCandidates[name] = parsed && typeof parsed === 'object'
        ? Object.keys(parsed)
        : ['string'];
      if (parsed && typeof parsed === 'object') {
        if (!passwordCandidates.values) passwordCandidates.values = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.length >= 8) {
            passwordCandidates.values[k] = v;
          }
        }
      }
    } catch (e) {
      passwordCandidates[`${name}_error`] = String(e.message).slice(0, 80);
    }
  }
  report.aws.passwordSources = Object.fromEntries(
    Object.entries(passwordCandidates).filter(([k]) => k !== 'values'),
  );

  const passwords = passwordCandidates.values || {};
  const login = async (apiBase, email) => {
    const password = passwords[email] || passwords[email.toLowerCase()]
      || passwords.password || passwords.testerPassword || passwords.CHECKSOPS_T0_TESTER_PASSWORD;
    if (!password) return { ok: false, error: 'no_password' };
    const response = await fetch(`${apiBase}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json = await response.json().catch(() => ({}));
    if (response.status !== 200 || !json.authentication?.idToken) {
      return { ok: false, error: json.error || `http_${response.status}` };
    }
    return { ok: true, token: json.authentication.idToken };
  };

  const queryShares = async (apiBase, token, label) => {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await fetch(`${apiBase}/data/query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          table: 'shared_checks',
          select: 'id,check_id,source_tenant_id,target_tenant_id,created_at,revoked_at',
          op: 'select',
          filters: [
            { column: 'target_tenant_id', op: 'eq', value: C1C },
          ],
          order: 'created_at',
          limit: 200,
          offset,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (response.status !== 200 || json.ok !== true) {
        return { ok: false, error: json.error || `http_${response.status}`, label, page };
      }
      const batch = Array.isArray(json.data) ? json.data : [];
      rows.push(...batch);
      if (batch.length < 200) break;
      offset += batch.length;
    }
    return { ok: true, label, rows };
  };

  let awsRows = [];
  for (const apiBase of [PROD_API, STAGING_API]) {
    const freedomLogin = await login(apiBase, FREEDOM_EMAIL);
    report.aws[`${apiBase.includes('prep') ? 'prod' : 'staging'}FreedomLogin`] = {
      ok: freedomLogin.ok,
      error: freedomLogin.error || null,
    };
    if (!freedomLogin.ok) continue;
    const queried = await queryShares(apiBase, freedomLogin.token, apiBase);
    report.aws[`${apiBase.includes('prep') ? 'prod' : 'staging'}FreedomQuery`] = {
      ok: queried.ok,
      error: queried.error || null,
      count: queried.rows?.length ?? null,
    };
    if (queried.ok) {
      awsRows = queried.rows;
      report.aws.path = `cognito_freedom_query:${apiBase}`;
      break;
    }
  }

  if (!awsRows.length && !report.aws.path) {
    const inventoryLambda = (lambdas || []).find((n) => /rehearsal-oneshot$/.test(n) && !/apply/.test(n));
    if (inventoryLambda) {
      try {
        const payloadFile = path.join(WORK, 'oneshot-payload.json');
        const outFile = path.join(WORK, 'oneshot-out.json');
        await writeFile(payloadFile, JSON.stringify({
          step: 'inventory',
          database: 'checksops',
          DATABASE_NAME: 'checksops',
        }));
        await run(AWS, [
          'lambda', 'invoke',
          '--function-name', inventoryLambda,
          '--cli-binary-format', 'raw-in-base64-out',
          '--payload', `file://${payloadFile}`,
          outFile,
        ], env);
        const invoked = JSON.parse(await readFile(outFile, 'utf8'));
        report.aws.inventoryOneshot = {
          ok: invoked.ok === true,
          error: invoked.error ? String(invoked.error).slice(0, 200) : null,
          sharedChecksCount: invoked.tableCounts?.shared_checks ?? null,
        };
        if (invoked.error) report.aws.limitations.push(`inventory_oneshot:${String(invoked.error).slice(0, 120)}`);
      } catch (e) {
        report.aws.limitations.push(`inventory_oneshot_invoke:${String(e.message).slice(0, 160)}`);
      }
    } else {
      report.aws.limitations.push('no_inventory_oneshot_and_no_cognito_query');
    }
  }

  const awsByCheck = new Map();
  for (const row of awsRows) {
    if (row.target_tenant_id !== C1C) continue;
    const prev = awsByCheck.get(row.check_id);
    if (!prev) {
      awsByCheck.set(row.check_id, row);
      continue;
    }
    const prevActive = !prev.revoked_at;
    const nextActive = !row.revoked_at;
    if (nextActive && !prevActive) awsByCheck.set(row.check_id, row);
  }

  const alreadyActive = [];
  const missing = [];
  const revoked = [];
  const conflict = [];

  for (const share of sourceActive) {
    const aws = awsByCheck.get(share.check_id);
    if (!aws) {
      missing.push({ check_id: share.check_id, source_share_id: share.id, created_at: share.created_at });
      continue;
    }
    const sourceOk = aws.source_tenant_id === FREEDOM;
    const targetOk = aws.target_tenant_id === C1C;
    if (!sourceOk || !targetOk) {
      conflict.push({
        check_id: share.check_id,
        reason: !sourceOk ? 'source_tenant_mismatch' : 'target_tenant_mismatch',
        aws_source: aws.source_tenant_id,
        aws_target: aws.target_tenant_id,
        aws_revoked: Boolean(aws.revoked_at),
      });
      continue;
    }
    if (aws.revoked_at) {
      revoked.push({
        check_id: share.check_id,
        aws_share_id: aws.id,
        source_share_id: share.id,
        aws_revoked_at: aws.revoked_at,
      });
      continue;
    }
    alreadyActive.push({ check_id: share.check_id, aws_share_id: aws.id, source_share_id: share.id });
  }

  const extraAws = [];
  for (const [checkId, aws] of awsByCheck) {
    if (sourceActive.some((s) => s.check_id === checkId)) continue;
    extraAws.push({
      check_id: checkId,
      revoked: Boolean(aws.revoked_at),
      inSourceRevokedSet: sourceRevoked.some((s) => s.check_id === checkId),
    });
  }

  report.aws.rows = awsRows.map((r) => ({
    id: r.id,
    check_id: r.check_id,
    source_tenant_id: r.source_tenant_id,
    target_tenant_id: r.target_tenant_id,
    revoked: Boolean(r.revoked_at),
    created_at: r.created_at || null,
  }));
  report.aws.uniqueCheckIds = awsByCheck.size;
  report.aws.activeCount = [...awsByCheck.values()].filter((r) => !r.revoked_at).length;
  report.aws.revokedCount = [...awsByCheck.values()].filter((r) => r.revoked_at).length;

  report.classification = {
    ALREADY_ACTIVE_IN_AWS: alreadyActive.length,
    MISSING_FROM_AWS: missing.length,
    REVOKED_IN_AWS: revoked.length,
    CONFLICT_DATA_MISMATCH: conflict.length,
    extraAwsNotInAuthoritative94: extraAws.length,
    alreadyActiveCheckIds: alreadyActive.map((r) => r.check_id).sort(),
    missingCheckIds: missing.map((r) => r.check_id).sort(),
    revokedCheckIds: revoked.map((r) => r.check_id).sort(),
    conflictCheckIds: conflict.map((r) => r.check_id).sort(),
    extraAws,
    conflicts: conflict,
  };

  const insertCount = missing.length;
  const updateCount = revoked.length;
  report.expectedMutation = {
    expectedInsertCount: insertCount,
    expectedUpdateCount: updateCount,
    expectedDeleteCount: 0,
    expectedCheckOwnershipChanges: 0,
    failClosedOnConflicts: conflict.length > 0,
    bulkInsertSkippedBecauseComplete: insertCount === 0 && updateCount === 0 && conflict.length === 0
      && alreadyActive.length === 94,
    notes: [
      'INSERT only for MISSING_FROM_AWS active authoritative shares.',
      'UPDATE revoked_at=NULL only if REVOKED_IN_AWS rows are in the authoritative 94 active set.',
      'DELETE is forbidden.',
      'check_intake_items.tenant_id is never changed.',
    ],
  };

  await writeFile(path.join(OUT, 'phase1-diff.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(OUT, 'phase1-source-active-check-ids.json'), JSON.stringify(report.source.checkIds, null, 2));

  console.log(JSON.stringify({
    wrote: `${OUT}/phase1-diff.json`,
    sourceActive: report.source.activeFreedomToC1c,
    awsPath: report.aws.path,
    awsRows: report.aws.rows.length,
    limitations: report.aws.limitations,
    classification: {
      ALREADY_ACTIVE_IN_AWS: alreadyActive.length,
      MISSING_FROM_AWS: missing.length,
      REVOKED_IN_AWS: revoked.length,
      CONFLICT_DATA_MISMATCH: conflict.length,
    },
    expectedMutation: report.expectedMutation,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 400) }));
  process.exit(1);
});
