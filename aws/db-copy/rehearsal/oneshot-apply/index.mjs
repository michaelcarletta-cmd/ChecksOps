/**
 * Isolated rehearsal restore + production delta apply.
 * Default writes only to checksops_rehearsal_YYYYMMDD.
 * Live checksops overlay requires confirmChecksopsOverlay + confirmIsolatedReconPass.
 * Never applies 64_financial_activation_grants.sql. Never logs PII.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { filterRestoreToc } from './restore-toc.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));
const AUTH_FK_PATH = path.join(ROOT, 'auth-fk-names.json');

const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name || ''))) throw new Error(`invalid identifier ${String(name).slice(0, 40)}`);
  return `"${String(name)}"`;
};

const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');

const run = (cmd, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve({ out, err });
    else reject(new Error(`${cmd} failed (${code}): ${(err || out).slice(0, 500)}`));
  });
});

const streamToBuffer = async (body) => {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be the checksops_admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) throw new Error('secret username is not checksops_admin');
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || host === 'localhost') throw new Error('admin secret host is missing or loopback');
  return {
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
  };
};

const connect = async (admin, database) => {
  const client = new Client({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 10000,
    query_timeout: 180000,
  });
  await client.connect();
  return client;
};

const assertRehearsalName = (name) => {
  if (!/^checksops_rehearsal_[0-9]{8}[a-z]?$/.test(name)) {
    throw new Error(`refusing database name ${name}`);
  }
};

const pgEnv = (admin, database) => ({
  PGHOST: admin.host,
  PGPORT: String(admin.port),
  PGUSER: admin.user,
  PGPASSWORD: admin.password,
  PGDATABASE: database,
  PGSSLMODE: 'verify-full',
  PGSSLROOTCERT: CA_PATH,
  PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH || ''}`,
  LD_LIBRARY_PATH: `${path.join(ROOT, 'lib')}:${process.env.LD_LIBRARY_PATH || ''}`,
});

const createDatabase = async (event) => {
  const dbName = event.database;
  assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, 'postgres');
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== 'postgres') throw new Error(`expected postgres, got ${current}`);
    const exists = (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount > 0;
    if (exists && event.recreate) {
      await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await client.query(`DROP DATABASE ${ident(dbName)}`);
    } else if (exists) {
      return { ok: true, created: false, database: dbName };
    }
    await client.query(`CREATE DATABASE ${ident(dbName)}`);
    return { ok: true, created: true, database: dbName, mutatedChecksops: false, mutatedPostgresDb: false };
  } finally {
    await client.end();
  }
};

const bootstrapSchema = async (event) => {
  const dbName = event.database;
  assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    let extensions = fs.readFileSync(path.join(ROOT, 'sql', '00_rds_supported_extensions.sql'), 'utf8');
    extensions = extensions.replaceAll('ALTER DATABASE checksops', `ALTER DATABASE ${dbName}`);
    await client.query(extensions);
    await client.query(fs.readFileSync(path.join(ROOT, 'sql', '01_auth_compatibility_stubs.sql'), 'utf8'));
    return { ok: true, database: dbName, extensionsApplied: true, authStubsApplied: true };
  } finally {
    await client.end();
  }
};

const restoreDump = async (event) => {
  const dbName = event.database;
  assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, 'postgres');
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== 'postgres') throw new Error(`expected postgres, got ${current}`);
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${ident(dbName)}`);
    // Brief exclusive lock on live checksops so TEMPLATE copy can run.
    // Does not drop or write checksops; API connections reconnect.
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'checksops' AND pid <> pg_backend_pid()`,
    );
    await client.query(`CREATE DATABASE ${ident(dbName)} TEMPLATE checksops`);
    return {
      ok: true,
      database: dbName,
      restoreMode: 'template_clone_then_overlay',
      clonedFrom: 'checksops',
      mutatedChecksops: false,
      note: 'Live checksops was copied as TEMPLATE only; overlay replaces migratable business tables with production rows.',
    };
  } finally {
    await client.end();
  }
};

const STAGING_ONLY_SKIP = new Set(['identity_accounts']);

const assertOverlayTarget = (name, event) => {
  if (name === 'checksops') {
    if (event.confirmChecksopsOverlay !== true || event.confirmIsolatedReconPass !== true) {
      throw new Error('refusing overlay on checksops without confirmChecksopsOverlay and confirmIsolatedReconPass');
    }
    return;
  }
  assertRehearsalName(name);
};

const applyDelta = async (event) => {
  const dbName = event.database;
  assertOverlayTarget(dbName, event);
  const admin = await loadAdmin();
  const s3 = new S3Client({});
  const prefix = String(event.manifestPrefix || '').replace(/\/+$/, '');
  const manifestObj = await s3.send(new GetObjectCommand({
    Bucket: event.bucket,
    Key: `${prefix}/manifest.json`,
  }));
  const manifest = JSON.parse((await streamToBuffer(manifestObj.Body)).toString('utf8'));
  const client = await connect(admin, dbName);
  const summary = [];
  try {
    try {
      await client.query("SELECT set_config('session_replication_role', 'replica', false)");
    } catch {
      await client.query('SET session_replication_role = replica');
    }
    const onlyTables = Array.isArray(event.onlyTables) ? new Set(event.onlyTables) : null;
    for (const table of manifest.tables || []) {
      ident(table.name);
      if (STAGING_ONLY_SKIP.has(table.name)) {
        summary.push({ table: table.name, skipped: 'staging_only_identity' });
        continue;
      }
      if (onlyTables && !onlyTables.has(table.name)) continue;
      const pk = (table.pkColumns || ['id']).map((col) => ident(col));
      try {
        const raw = await s3.send(new GetObjectCommand({
          Bucket: event.bucket,
          Key: `${prefix}/tables/${table.name}.json`,
        }));
        const payload = JSON.parse((await streamToBuffer(raw.Body)).toString('utf8'));
        const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table.name}`])).rows[0].ok;
        if (!exists) {
          summary.push({ table: table.name, skipped: 'missing_on_rehearsal' });
          continue;
        }
        const colMeta = (await client.query(`
          SELECT a.attname AS name, t.typname AS type, a.attgenerated AS generated, a.attidentity AS identity
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_type t ON t.oid = a.atttypid
          WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        `, [table.name])).rows;
        const writable = new Set(colMeta
          .filter((col) => !col.generated && col.identity !== 'a')
          .map((col) => col.name));
        const jsonCols = new Set(colMeta.filter((col) => ['json', 'jsonb'].includes(col.type)).map((col) => col.name));
        const coerce = (name, value) => {
          if (value === undefined) return null;
          if (jsonCols.has(name) && value !== null && typeof value === 'object') return JSON.stringify(value);
          if (jsonCols.has(name) && value === '') return null;
          return value;
        };
        let deleted = 0;
        let upserted = 0;
        let skippedCols = 0;
        if (payload.replaceAll) {
          await client.query(`DELETE FROM public.${ident(table.name)}`);
          deleted = -1;
        } else {
          for (const del of payload.deletes || []) {
            const values = Array.isArray(del) ? del : [del];
            const where = pk.map((col, i) => `${col} = $${i + 1}`).join(' AND ');
            await client.query(`DELETE FROM public.${ident(table.name)} WHERE ${where}`, values);
            deleted += 1;
          }
        }
        for (const row of payload.upserts || []) {
          const columns = Object.keys(row).filter((col) => writable.has(col));
          skippedCols += Object.keys(row).filter((col) => /^[a-z_][a-z0-9_]*$/i.test(col) && !writable.has(col)).length ? 1 : 0;
          if (!columns.length) continue;
          const placeholders = columns.map((_, i) => `$${i + 1}`);
          const updateSet = columns
            .filter((col) => !(table.pkColumns || ['id']).includes(col))
            .map((col) => `${ident(col)} = EXCLUDED.${ident(col)}`);
          const sql = updateSet.length
            ? `INSERT INTO public.${ident(table.name)} (${columns.map(ident).join(', ')})
               VALUES (${placeholders.join(', ')})
               ON CONFLICT (${(table.pkColumns || ['id']).map(ident).join(', ')})
               DO UPDATE SET ${updateSet.join(', ')}`
            : `INSERT INTO public.${ident(table.name)} (${columns.map(ident).join(', ')})
               VALUES (${placeholders.join(', ')})
               ON CONFLICT (${(table.pkColumns || ['id']).map(ident).join(', ')}) DO NOTHING`;
          await client.query(sql, columns.map((col) => coerce(col, row[col])));
          upserted += 1;
        }
        summary.push({
          table: table.name,
          deleted,
          upserted,
          skippedGeneratedOrMissingColumns: Boolean(skippedCols),
          skippedSecretColumns: table.skippedSecretColumns || [],
        });
      } catch (error) {
        summary.push({
          table: table.name,
          error: String(error.message || error).slice(0, 180),
        });
      }
    }
    await client.query('SELECT set_config($1, $2, false)', ['session_replication_role', 'origin']);
    const grantSql = fs.readFileSync(path.join(ROOT, 'sql', '02_grant_readonly_application_role.sql'), 'utf8')
      .replaceAll('ON DATABASE checksops', `ON DATABASE ${dbName}`);
    try { await client.query(grantSql); } catch (error) {
      summary.push({ grants: String(error.message || error).slice(0, 160) });
    }
    return { ok: true, database: dbName, tables: summary.length, tableSummary: summary };
  } finally {
    try { await client.query('SELECT set_config($1, $2, false)', ['session_replication_role', 'origin']); } catch { /* ignore */ }
    await client.end();
  }
};

const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const PROBE_SUB = '2418c458-c011-70b7-07ac-6b9da2d9415d';

const applyProductionIdentityLinks = async (event) => {
  if (event.confirmT0Identity !== true) {
    throw new Error('refusing identity remap without confirmT0Identity');
  }
  const links = event.links || [];
  if (!Array.isArray(links) || links.length !== 8) {
    throw new Error(`expected 8 links, got ${links?.length}`);
  }
  const admin = await loadAdmin();
  const client = await connect(admin, 'checksops');
  try {
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (db !== 'checksops') throw new Error(`connected to ${db}`);
    const seenSubs = new Set();
    const seenIds = new Set();
    const applied = [];
    for (const link of links) {
      const applicationUserId = link.applicationUserId || link.application_user_id;
      const cognitoSub = link.cognitoSub || link.cognito_sub;
      const email = link.email;
      if (!applicationUserId || !cognitoSub || !email) {
        throw new Error('each link needs applicationUserId, cognitoSub, email');
      }
      if (applicationUserId === NINTH_ID) throw new Error('refusing to link the ninth UUID');
      if (cognitoSub === PROBE_SUB) throw new Error('refusing to reuse the isolated probe Cognito sub');
      if (String(applicationUserId) === String(cognitoSub)) {
        throw new Error('refusing application_user_id equal to cognito_sub');
      }
      if (seenSubs.has(cognitoSub) || seenIds.has(applicationUserId)) {
        throw new Error('duplicate application UUID or cognito_sub in payload');
      }
      seenSubs.add(cognitoSub);
      seenIds.add(applicationUserId);
      const updated = await client.query(
        `UPDATE public.identity_accounts
         SET cognito_sub = $1,
             status = 'active',
             linked_at = now()
         WHERE application_user_id = $2::uuid
           AND lower(email) = lower($3)
           AND application_user_id <> $4::uuid
         RETURNING application_user_id::text AS application_user_id, status`,
        [cognitoSub, applicationUserId, email, NINTH_ID],
      );
      if (!updated.rows[0]) {
        throw new Error(`no matching identity row for ${applicationUserId}`);
      }
      applied.push({ applicationUserId: updated.rows[0].application_user_id, status: updated.rows[0].status });
    }
    const ninth = (await client.query(
      `SELECT application_user_id::text AS application_user_id, cognito_sub, status
       FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
      [NINTH_ID],
    )).rows[0] || null;
    const active = Number((await client.query(
      `SELECT count(*)::int AS n FROM public.identity_accounts WHERE status = 'active'`,
    )).rows[0].n);
    const uniqueSubs = Number((await client.query(
      `SELECT count(DISTINCT cognito_sub)::int AS n FROM public.identity_accounts WHERE cognito_sub IS NOT NULL`,
    )).rows[0].n);
    const ninthUntouched = Boolean(ninth)
      && ninth.cognito_sub == null
      && ninth.status === 'pending';
    return {
      ok: applied.length === 8 && ninthUntouched && uniqueSubs >= 8,
      database: 'checksops',
      applied: applied.length,
      active,
      uniqueSubs,
      ninthUntouched,
      emailsLogged: false,
      realInvitationEmailsSent: false,
    };
  } finally {
    await client.end();
  }
};

const inspectCheckImages = async (event) => {
  const dbName = event.database || 'checksops';
  if (dbName !== 'checksops') assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const rows = (await client.query(`
      SELECT
        count(*)::int AS intake,
        count(front_image_path) FILTER (WHERE coalesce(front_image_path, '') <> '')::int AS front_paths,
        count(back_image_path) FILTER (WHERE coalesce(back_image_path, '') <> '')::int AS rear_paths
      FROM public.check_intake_items
    `)).rows[0];
    const older = (await client.query(`
      SELECT count(*)::int AS n
      FROM public.check_intake_items
      WHERE created_at < now() - interval '60 days'
    `)).rows[0].n;
    return {
      ok: true,
      readOnly: true,
      database: dbName,
      intake: rows.intake,
      frontPaths: rows.front_paths,
      rearPaths: rows.rear_paths,
      olderThan60Days: older,
      pathsLogged: false,
    };
  } finally {
    await client.end();
  }
};

const reconcile = async (event) => {
  const dbName = event.database;
  if (dbName === 'checksops') {
    if (event.confirmLiveRecon !== true) {
      throw new Error('refusing reconcile on checksops without confirmLiveRecon');
    }
  } else {
    assertRehearsalName(dbName);
  }
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
    if (db.d !== dbName) throw new Error(`connected to ${db.d}`);
    const countsSql = fs.readFileSync(path.join(ROOT, 'sql', 'reconciliation_counts.sql'), 'utf8');
    const finSql = fs.readFileSync(path.join(ROOT, 'sql', 'reconciliation_financial.sql'), 'utf8');
    const countRows = (await client.query(countsSql)).rows;
    const finRows = (await client.query(finSql)).rows;
    const pkSets = {};
    for (const spec of event.pkTables || []) {
      const table = typeof spec === 'string' ? spec : spec.table;
      const pkColumns = typeof spec === 'string' ? ['id'] : (spec.pkColumns || ['id']);
      ident(table);
      pkColumns.forEach(ident);
      const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`])).rows[0].ok;
      if (!exists) {
        pkSets[table] = { present: false, count: 0, fingerprints: [] };
        continue;
      }
      const expr = `concat_ws('|', ${pkColumns.map((col) => `${ident(col)}::text`).join(', ')})`;
      const rows = (await client.query(`SELECT ${expr} AS pk FROM public.${ident(table)}`)).rows;
      pkSets[table] = {
        present: true,
        count: rows.length,
        fingerprints: rows.map((row) => sha256Hex(row.pk)).sort(),
      };
    }
    const tenants = (await client.query('SELECT count(*)::int AS n, count(DISTINCT id)::int AS distinct_ids FROM public.tenants')).rows[0];
    const profiles = (await client.query('SELECT count(*)::int AS n FROM public.profiles')).rows[0];
    const roles = (await client.query('SELECT role, count(*)::int AS n FROM public.user_roles GROUP BY role ORDER BY 1')).rows;
    const memberships = (await client.query('SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS users, count(DISTINCT tenant_id)::int AS tenants FROM public.tenant_users')).rows[0];
    const identityExists = (await client.query(`SELECT to_regclass('public.identity_accounts') IS NOT NULL AS ok`)).rows[0].ok;
    const fk = {};
    const fkChecks = [
      ['check_endorsements_check_id', `SELECT count(*)::int AS n FROM public.check_endorsements e LEFT JOIN public.check_intake_items i ON i.id = e.check_id WHERE e.check_id IS NOT NULL AND i.id IS NULL`],
      ['deposit_items_batch_id', `SELECT count(*)::int AS n FROM public.deposit_items d LEFT JOIN public.deposit_batches b ON b.id = d.batch_id WHERE d.batch_id IS NOT NULL AND b.id IS NULL`],
      ['disbursement_splits_batch_id', `SELECT count(*)::int AS n FROM public.disbursement_splits s LEFT JOIN public.disbursement_batches b ON b.id = s.batch_id WHERE s.batch_id IS NOT NULL AND b.id IS NULL`],
      ['claim_folders_claim_id', `SELECT count(*)::int AS n FROM public.claim_folders f LEFT JOIN public.claims c ON c.id = f.claim_id WHERE f.claim_id IS NOT NULL AND c.id IS NULL`],
      ['user_roles_duplicate_user_role', `SELECT count(*)::int AS n FROM (SELECT user_id, role, count(*) FROM public.user_roles GROUP BY 1,2 HAVING count(*) > 1) d`],
      ['financial_stepup_log_user_id', `SELECT count(*)::int AS n FROM public.financial_stepup_log s LEFT JOIN public.profiles p ON p.id = s.user_id WHERE s.user_id IS NOT NULL AND p.id IS NULL`],
      ['financial_stepup_log_tenant_id', `SELECT count(*)::int AS n FROM public.financial_stepup_log s LEFT JOIN public.tenants t ON t.id = s.tenant_id WHERE s.tenant_id IS NOT NULL AND t.id IS NULL`],
    ];
    for (const [name, sql] of fkChecks) {
      try { fk[name] = (await client.query(sql)).rows[0].n; }
      catch (error) { fk[name] = { error: String(error.message || error).slice(0, 120) }; }
    }
    const requiredNulls = {};
    const requiredChecks = [
      ['tenants_id_null', `SELECT count(*)::int AS n FROM public.tenants WHERE id IS NULL`],
      ['check_intake_items_id_null', `SELECT count(*)::int AS n FROM public.check_intake_items WHERE id IS NULL`],
      ['claims_id_null', `SELECT count(*)::int AS n FROM public.claims WHERE id IS NULL`],
      ['financial_stepup_log_id_null', `SELECT count(*)::int AS n FROM public.financial_stepup_log WHERE id IS NULL`],
      ['financial_stepup_log_user_id_null', `SELECT count(*)::int AS n FROM public.financial_stepup_log WHERE user_id IS NULL`],
      ['financial_stepup_log_action_key_null', `SELECT count(*)::int AS n FROM public.financial_stepup_log WHERE action_key IS NULL`],
    ];
    for (const [name, sql] of requiredChecks) {
      try { requiredNulls[name] = (await client.query(sql)).rows[0].n; }
      catch (error) { requiredNulls[name] = { error: String(error.message || error).slice(0, 120) }; }
    }
    return {
      ok: true,
      database: dbName,
      connectedAs: db.u,
      tableCounts: Object.fromEntries(countRows.map((row) => [row.table_name, Number(row.row_count)])),
      financialAggregates: Object.fromEntries(finRows.map((row) => [row.metric, String(row.value)])),
      tenants,
      profiles: profiles.n,
      userRolesByName: Object.fromEntries(roles.map((row) => [row.role, row.n])),
      tenantUsers: memberships,
      identityAccountsPresent: identityExists,
      fkOrphanCounts: fk,
      requiredNullCounts: requiredNulls,
      pkSets: Object.fromEntries(Object.entries(pkSets).map(([table, spec]) => ([
        table,
        { present: spec.present, count: spec.count || 0 },
      ]))),
      pkFingerprints: Object.fromEntries(Object.entries(pkSets)
        .filter(([, spec]) => spec.present)
        .map(([table, spec]) => [table, spec.fingerprints])),
    };
  } finally {
    await client.end();
  }
};

const applyDdl = async (event) => {
  const dbName = event.database;
  let checksopsDdl = false;
  if (dbName === 'checksops') {
    if (event.confirmChecksopsDdl !== true || event.ddlOnly !== true) {
      throw new Error('refusing DDL on checksops without confirmChecksopsDdl and ddlOnly');
    }
    checksopsDdl = true;
  } else {
    assertRehearsalName(dbName);
  }
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const sqlPath = [
      path.join(ROOT, 'sql', '37_financial_stepup_log.sql'),
      '/var/task/sql/37_financial_stepup_log.sql',
    ].find((p) => fs.existsSync(p));
    if (!sqlPath) throw new Error('37_financial_stepup_log.sql missing from Lambda package');
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(sqlPath, 'utf8'));
      const exists = (await client.query(`SELECT to_regclass('public.financial_stepup_log') IS NOT NULL AS ok`)).rows[0].ok;
      const columns = (await client.query(`
      SELECT a.attname AS name, t.typname AS type, NOT a.attnotnull AS nullable,
             EXISTS (
               SELECT 1 FROM pg_index i
               WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
             ) AS pk
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = 'public' AND c.relname = 'financial_stepup_log'
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `)).rows;
      const indexes = (await client.query(`
      SELECT indexrelid::regclass::text AS name
      FROM pg_index
      WHERE indrelid = 'public.financial_stepup_log'::regclass
      ORDER BY 1
    `)).rows.map((row) => row.name);
      const policies = (await client.query(`
      SELECT polname FROM pg_policy
      WHERE polrelid = 'public.financial_stepup_log'::regclass
      ORDER BY 1
    `)).rows.map((row) => row.polname);
      const rls = (await client.query(`
      SELECT relrowsecurity AS enabled FROM pg_class
      WHERE oid = 'public.financial_stepup_log'::regclass
    `)).rows[0];
      const n = (await client.query('SELECT count(*)::int AS n FROM public.financial_stepup_log')).rows[0].n;
      await client.query('COMMIT');
      return {
        ok: exists === true,
        database: dbName,
        ddlOnly: true,
        checksopsDdl,
        mutatedChecksopsData: false,
        tableExists: exists,
        columnCount: columns.length,
        columns: columns.map((col) => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          primaryKey: Boolean(col.pk),
        })),
        indexes,
        policies,
        rlsEnabled: Boolean(rls?.enabled),
        rowCount: n,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    await client.end();
  }
};

const REQUIRED_INTAKE_RETURN_COLS = [
  'returned_at',
  'return_code',
  'return_reason',
  'return_notes',
  'return_recorded_by',
  'return_source',
  'pre_return_stage',
  'return_resolved_at',
  'return_resolution',
];

const REQUIRED_CHECKALT_RETURN_COLS = [
  'return_code',
  'return_reason',
  'returned_at',
  'return_window_until',
];

const inspectParitySchema = async (client) => {
  const intake = (await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'check_intake_items'
    ORDER BY ordinal_position
  `)).rows.map((row) => row.column_name);
  const deposits = (await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'checkalt_deposits'
    ORDER BY ordinal_position
  `)).rows.map((row) => row.column_name);
  const fn = (await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tg_mirror_payee_to_endorsement'
    LIMIT 1
  `)).rows[0]?.def || '';
  const enumVals = (await client.query(`
    SELECT e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'check_stage'
    ORDER BY e.enumsortorder
  `)).rows.map((row) => row.enumlabel);
  return {
    intakeColumns: intake,
    checkaltColumns: deposits,
    missingIntakeReturnColumns: REQUIRED_INTAKE_RETURN_COLS.filter((col) => !intake.includes(col)),
    missingCheckaltReturnColumns: REQUIRED_CHECKALT_RETURN_COLS.filter((col) => !deposits.includes(col)),
    triggerHasRenameDelete: /lower\(trim\(NEW\.payee_name\)\) IS DISTINCT FROM lower\(trim\(OLD\.payee_name\)\)/i.test(fn)
      && /DELETE FROM public\.check_endorsements/i.test(fn),
    triggerHasPreferredAuth: /preferred_auth_method|user_passkeys/i.test(fn),
    checkStageHasReturned: enumVals.includes('returned'),
  };
};

const inspectReturnColumns = async (event) => {
  const dbName = event.database || 'checksops';
  if (dbName !== 'checksops') assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const inspected = await inspectParitySchema(client);
    return {
      ok: true,
      readOnly: true,
      database: dbName,
      mutatedChecksops: false,
      liveChecksopsMutated: false,
      ...inspected,
    };
  } finally {
    await client.end();
  }
};

const applyParityDdl = async (event) => {
  const dbName = event.database;
  if (dbName === 'checksops') {
    throw new Error('refusing parity DDL on checksops; use an isolated rehearsal database');
  }
  assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const sqlPath = [
      path.join(ROOT, 'sql', '38_parity_payee_mirror_and_returns.sql'),
      '/var/task/sql/38_parity_payee_mirror_and_returns.sql',
    ].find((p) => fs.existsSync(p));
    if (!sqlPath) throw new Error('38_parity_payee_mirror_and_returns.sql missing from Lambda package');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const addValue = 'ALTER TYPE public.check_stage ADD VALUE IF NOT EXISTS \'returned\'';
    try {
      await client.query(addValue);
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error.message || error))) {
        throw error;
      }
    }
    await client.query('BEGIN');
    try {
      await client.query(sql.replace(addValue, '-- add value already applied'));
      const inspected = await inspectParitySchema(client);
      const ok = inspected.missingIntakeReturnColumns.length === 0
        && inspected.triggerHasRenameDelete === true
        && inspected.triggerHasPreferredAuth === false;
      await client.query('COMMIT');
      return {
        ok,
        database: dbName,
        ddlOnly: true,
        checksopsDdl: false,
        mutatedChecksopsData: false,
        liveChecksopsMutated: false,
        ...inspected,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    await client.end();
  }
};

export const handler = async (event = {}) => {
  const step = event.step || 'create_db';
  const base = {
    productionSupabaseChanged: false,
    productionCutoverPerformed: false,
    liveChecksopsMutated: false,
    step,
  };
  try {
    if (step === 'create_db') return { ...base, ...(await createDatabase(event)) };
    if (step === 'bootstrap') return { ...base, ...(await bootstrapSchema(event)) };
    if (step === 'restore') return { ...base, ...(await restoreDump(event)) };
    if (step === 'apply_ddl') return { ...base, ...(await applyDdl(event)), liveChecksopsMutated: false };
    if (step === 'inspect_return_columns') return { ...base, ...(await inspectReturnColumns(event)), liveChecksopsMutated: false };
    if (step === 'apply_parity_ddl') return { ...base, ...(await applyParityDdl(event)), liveChecksopsMutated: false };
    if (step === 'apply_delta') {
      const result = await applyDelta(event);
      return {
        ...base,
        ...result,
        liveChecksopsMutated: event.database === 'checksops',
        productionCutoverPerformed: event.database === 'checksops',
      };
    }
    if (step === 'reconcile') return { ...base, ...(await reconcile(event)), liveChecksopsMutated: false };
    if (step === 'apply_production_identity_links') {
      return { ...base, ...(await applyProductionIdentityLinks(event)), liveChecksopsMutated: true };
    }
    if (step === 'inspect_check_images') {
      return { ...base, ...(await inspectCheckImages(event)), liveChecksopsMutated: false };
    }
    throw new Error(`unknown step ${step}`);
  } catch (error) {
    return { ...base, ok: false, error: String(error.message || error).slice(0, 500) };
  }
};
