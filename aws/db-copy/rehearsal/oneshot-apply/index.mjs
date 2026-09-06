/**
 * Isolated rehearsal restore + production delta apply.
 * Writes only to checksops_rehearsal_YYYYMMDD. Never mutates checksops or postgres.
 * Returns counts/aggregates/orphan counts — never row contents or PII.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

const applyDelta = async (event) => {
  const dbName = event.database;
  assertRehearsalName(dbName);
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

const reconcile = async (event) => {
  const dbName = event.database;
  assertRehearsalName(dbName);
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
    functionDefSha256: fn ? sha256Hex(fn) : null,
    functionDefLength: fn.length,
    functionDef: fn || null,
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

const snapshotRowCounts = async (client) => {
  const tables = ['check_intake_items', 'check_payees', 'check_endorsements'];
  const out = {};
  for (const table of tables) {
    out[table] = (await client.query(`SELECT count(*)::int AS n FROM public.${ident(table)}`)).rows[0].n;
  }
  const stages = (await client.query(`
    SELECT check_stage::text AS k, count(*)::int AS n
    FROM public.check_intake_items
    GROUP BY 1
    ORDER BY 1
  `)).rows;
  const statuses = (await client.query(`
    SELECT status AS k, count(*)::int AS n
    FROM public.check_intake_items
    GROUP BY 1
    ORDER BY 1
  `)).rows;
  return {
    tables: out,
    checkStageHistogram: Object.fromEntries(stages.map((row) => [row.k, row.n])),
    checkStatusHistogram: Object.fromEntries(statuses.map((row) => [row.k, row.n])),
  };
};

const applyTriggerParity = async (event) => {
  const dbName = event.database;
  if (dbName !== 'checksops') {
    throw new Error('apply_trigger_parity is limited to live checksops after explicit confirmation');
  }
  if (event.confirmChecksopsTriggerParity !== true || event.ddlOnly !== true) {
    throw new Error('apply_trigger_parity requires confirmChecksopsTriggerParity=true and ddlOnly=true');
  }
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const sqlPath = [
      path.join(ROOT, 'sql', '39_parity_payee_mirror_trigger_only.sql'),
      '/var/task/sql/39_parity_payee_mirror_trigger_only.sql',
    ].find((p) => fs.existsSync(p));
    if (!sqlPath) throw new Error('39_parity_payee_mirror_trigger_only.sql missing from Lambda package');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    if (/\bGRANT\b/i.test(sql) || /\bALTER\s+TABLE\b/i.test(sql) || /\b64_financial/i.test(sql)) {
      throw new Error('trigger-only SQL failed safety scan');
    }
    const before = await inspectParitySchema(client);
    if (before.missingIntakeReturnColumns.length || before.missingCheckaltReturnColumns.length) {
      throw new Error('required returned_* / return_* columns missing; refuse trigger overlay');
    }
    const countsBefore = await snapshotRowCounts(client);
    await client.query(sql);
    const after = await inspectParitySchema(client);
    const countsAfter = await snapshotRowCounts(client);
    return {
      ok: after.triggerHasRenameDelete === true && after.triggerHasPreferredAuth === false,
      database: dbName,
      applied: '39_parity_payee_mirror_trigger_only.sql',
      ddlOnly: true,
      checksopsDdl: true,
      mutatedChecksopsData: false,
      liveChecksopsMutated: false,
      liveChecksopsDdlApplied: true,
      before,
      after,
      countsBefore,
      countsAfter,
      rowCountsUnchanged: JSON.stringify(countsBefore) === JSON.stringify(countsAfter),
    };
  } finally {
    await client.end();
  }
};

const PROBE_FRONT = 'checks/aws-parity-trigger-probe/pending_front.jpg';
const PROBE_OLD = 'ParityProbeOld';
const PROBE_NEW = 'ParityProbeNew';

const leftoverProbeCount = async (client) => {
  const checks = (await client.query(
    `SELECT count(*)::int AS n FROM public.check_intake_items WHERE front_image_path = $1`,
    [PROBE_FRONT],
  )).rows[0].n;
  const payees = (await client.query(
    `SELECT count(*)::int AS n FROM public.check_payees WHERE payee_name IN ($1, $2)`,
    [PROBE_OLD, PROBE_NEW],
  )).rows[0].n;
  return { leftoverChecks: checks, leftoverPayees: payees };
};

const validateTriggerRenameTxn = async (event) => {
  const dbName = event.database || 'checksops';
  if (dbName !== 'checksops') assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const leftoverBefore = await leftoverProbeCount(client);
    const tenant = (await client.query(`SELECT id FROM public.tenants ORDER BY created_at NULLS LAST LIMIT 1`)).rows[0];
    if (!tenant?.id) throw new Error('no tenant available for transactional probe');
    await client.query('BEGIN');
    try {
      const check = (await client.query(
        `INSERT INTO public.check_intake_items (tenant_id, front_image_path, status)
         VALUES ($1::uuid, $2, 'uploaded')
         RETURNING id`,
        [tenant.id, PROBE_FRONT],
      )).rows[0];
      const payee = (await client.query(
        `INSERT INTO public.check_payees (check_id, tenant_id, payee_name, payee_type, endorsement_status)
         VALUES ($1::uuid, $2::uuid, $3, 'unknown', 'pending')
         RETURNING id`,
        [check.id, tenant.id, PROBE_OLD],
      )).rows[0];
      const afterInsert = (await client.query(
        `SELECT
           count(*) FILTER (WHERE lower(trim(payee_name)) = lower($2) AND status NOT IN ('signed','waived'))::int AS old_unsigned,
           count(*) FILTER (WHERE lower(trim(payee_name)) = lower($3) AND status NOT IN ('signed','waived'))::int AS new_unsigned,
           count(*)::int AS total
         FROM public.check_endorsements
         WHERE check_id = $1::uuid`,
        [check.id, PROBE_OLD, PROBE_NEW],
      )).rows[0];
      await client.query(
        `UPDATE public.check_payees SET payee_name = $2 WHERE id = $1::uuid`,
        [payee.id, PROBE_NEW],
      );
      const afterRename = (await client.query(
        `SELECT
           count(*) FILTER (WHERE lower(trim(payee_name)) = lower($2) AND status NOT IN ('signed','waived'))::int AS old_unsigned,
           count(*) FILTER (WHERE lower(trim(payee_name)) = lower($3) AND status NOT IN ('signed','waived'))::int AS new_unsigned,
           count(*)::int AS total
         FROM public.check_endorsements
         WHERE check_id = $1::uuid`,
        [check.id, PROBE_OLD, PROBE_NEW],
      )).rows[0];
      await client.query('ROLLBACK');
      const leftoverAfter = await leftoverProbeCount(client);
      const renameUpdatesExisting = afterRename.old_unsigned === 0
        && afterRename.new_unsigned === 1
        && afterRename.total === afterInsert.total;
      return {
        ok: renameUpdatesExisting && leftoverAfter.leftoverChecks === 0 && leftoverAfter.leftoverPayees === 0,
        database: dbName,
        transactional: true,
        rolledBack: true,
        mutatedChecksopsData: false,
        liveChecksopsMutated: false,
        leftoverBefore,
        leftoverAfter,
        afterInsert,
        afterRename,
        renameUpdatesExisting,
        customerRecordsChanged: false,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      const leftoverAfter = await leftoverProbeCount(client);
      throw new Error(`${String(error.message || error).slice(0, 220)} leftover=${JSON.stringify(leftoverAfter)}`);
    }
  } finally {
    await client.end();
  }
};

const s3KeyForClaim = (objectPath) => {
  const raw = String(objectPath || '').trim().split('?')[0].replace(/^\/+/, '');
  if (!raw || raw.includes('..') || raw.includes('\0')) return null;
  const rel = raw.replace(/^claim-files\//, '');
  if (!rel) return null;
  return `files/claim-files/${rel}`;
};

const headOrHashObject = async (s3, bucket, key, hashObjects) => {
  if (!key) return { expected: false, present: false, bytes: null, sha256: null, keyHash: null };
  const keyHash = sha256Hex(key);
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = Number(head.ContentLength);
    let digest = null;
    if (hashObjects) {
      const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const hash = createHash('sha256');
      for await (const chunk of obj.Body) hash.update(chunk);
      digest = hash.digest('hex');
    }
    return {
      expected: true,
      present: true,
      bytes: Number.isFinite(bytes) ? bytes : null,
      sha256: digest,
      keyHash,
    };
  } catch (error) {
    const missing = /NotFound|NoSuchKey|404/i.test(String(error.name || error.Code || error.message || error));
    return {
      expected: true,
      present: false,
      bytes: null,
      sha256: null,
      keyHash,
      missing,
    };
  }
};

const inspectHistoricalCheckImages = async (event) => {
  const dbName = event.database || 'checksops';
  if (dbName !== 'checksops') assertRehearsalName(dbName);
  const filesBucket = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
  const hashObjects = event.hashObjects === true;
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  const s3 = new S3Client({});
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const eligible = (await client.query(`
      SELECT count(*)::int AS n
      FROM public.check_intake_items
      WHERE COALESCE(deposited_at, created_at) < now() - interval '60 days'
        AND (
          deposited_at IS NOT NULL
          OR check_stage::text IN ('deposited', 'cleared', 'completed')
          OR status IN ('deposited', 'cleared', 'completed')
        )
    `)).rows[0].n;
    const rows = (await client.query(`
      SELECT id, created_at, deposited_at, front_image_path, back_image_path, back_image_deposit_path
      FROM public.check_intake_items
      WHERE COALESCE(deposited_at, created_at) < now() - interval '60 days'
        AND (
          deposited_at IS NOT NULL
          OR check_stage::text IN ('deposited', 'cleared', 'completed')
          OR status IN ('deposited', 'cleared', 'completed')
        )
      ORDER BY COALESCE(deposited_at, created_at) ASC
      LIMIT 8
    `)).rows;
    const ids = rows.map((row) => row.id);
    let filesByCheck = new Map();
    if (ids.length) {
      try {
        const files = (await client.query(
          `SELECT check_intake_item_id, file_path
           FROM public.check_files
           WHERE check_intake_item_id = ANY($1::uuid[])`,
          [ids],
        )).rows;
        for (const file of files) {
          const list = filesByCheck.get(file.check_intake_item_id) || [];
          list.push(file.file_path);
          filesByCheck.set(file.check_intake_item_id, list);
        }
      } catch { /* table optional */ }
    }
    const sample = [];
    let frontPresent = 0;
    let rearPresent = 0;
    let extraExpected = 0;
    let extraPresent = 0;
    const destObjects = [];
    for (const row of rows) {
      const ageDays = Math.floor(
        (Date.now() - new Date(row.deposited_at || row.created_at).getTime()) / 86400000,
      );
      const front = await headOrHashObject(s3, filesBucket, s3KeyForClaim(row.front_image_path), hashObjects);
      const rearPath = row.back_image_path || row.back_image_deposit_path;
      const rear = await headOrHashObject(s3, filesBucket, s3KeyForClaim(rearPath), hashObjects);
      if (front.present) frontPresent += 1;
      if (rear.present) rearPresent += 1;
      const extras = [];
      for (const filePath of filesByCheck.get(row.id) || []) {
        const extra = await headOrHashObject(s3, filesBucket, s3KeyForClaim(filePath), hashObjects);
        extraExpected += extra.expected ? 1 : 0;
        extraPresent += extra.present ? 1 : 0;
        extras.push({ present: extra.present, bytes: extra.bytes, sha256: extra.sha256, keyHash: extra.keyHash });
        if (extra.keyHash) destObjects.push(extra);
      }
      if (front.keyHash) destObjects.push(front);
      if (rear.keyHash) destObjects.push(rear);
      sample.push({
        checkIdHash: sha256Hex(row.id),
        ageDays,
        dbRecordPresent: true,
        front: { present: front.present, bytes: front.bytes, sha256: front.sha256, keyHash: front.keyHash },
        rear: { present: rear.present, bytes: rear.bytes, sha256: rear.sha256, keyHash: rear.keyHash, expected: Boolean(rearPath) },
        extraDocuments: {
          expected: extras.length,
          present: extras.filter((item) => item.present).length,
        },
      });
    }
    return {
      ok: sample.length > 0 && frontPresent === sample.length && rearPresent === sample.filter((row) => row.rear.expected).length,
      readOnly: true,
      database: dbName,
      mutatedChecksops: false,
      filesBucketPresent: true,
      hashObjects,
      eligibleOlderCheckCount: eligible,
      sampleSize: sample.length,
      frontPresent,
      rearPresent,
      extraExpected,
      extraPresent,
      sample,
      destObjectKeyHashes: destObjects.map((item) => item.keyHash).filter(Boolean),
      destHashesByKeyHash: Object.fromEntries(
        destObjects.filter((item) => item.keyHash && item.sha256).map((item) => [item.keyHash, item.sha256]),
      ),
    };
  } finally {
    await client.end();
  }
};

const targetedDbRecon = async (event) => {
  const dbName = event.database || 'checksops';
  if (dbName !== 'checksops') assertRehearsalName(dbName);
  const admin = await loadAdmin();
  const client = await connect(admin, dbName);
  try {
    const current = (await client.query('SELECT current_database() AS d')).rows[0].d;
    if (current !== dbName) throw new Error(`connected to ${current}`);
    const schema = await inspectParitySchema(client);
    const counts = await snapshotRowCounts(client);
    const leftover = await leftoverProbeCount(client);
    const rlsTables = [
      'check_intake_items',
      'check_payees',
      'check_endorsements',
      'checkalt_deposits',
      'tenants',
      'check_files',
    ];
    const rls = {};
    for (const table of rlsTables) {
      const exists = (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`])).rows[0].ok;
      if (!exists) {
        rls[table] = { present: false };
        continue;
      }
      const row = (await client.query(`
        SELECT c.relrowsecurity AS enabled, count(p.polname)::int AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'public' AND c.relname = $1
        GROUP BY 1
      `, [table])).rows[0];
      rls[table] = { present: true, enabled: Boolean(row?.enabled), policies: row?.policies || 0 };
    }
    let financialExecuteGrants = 0;
    try {
      financialExecuteGrants = (await client.query(`
        SELECT count(*)::int AS n
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name LIKE 'aws_financial_%'
          AND grantee IN ('checksops', 'authenticated', 'PUBLIC')
          AND privilege_type = 'EXECUTE'
      `)).rows[0].n;
    } catch { financialExecuteGrants = 0; }
    const triggerOnPayees = (await client.query(`
      SELECT tgname, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'check_payees' AND NOT t.tgisinternal
      ORDER BY 1
    `)).rows.map((row) => row.tgname);
    return {
      ok: schema.missingIntakeReturnColumns.length === 0
        && schema.missingCheckaltReturnColumns.length === 0
        && schema.triggerHasRenameDelete === true
        && schema.triggerHasPreferredAuth === false
        && leftover.leftoverChecks === 0
        && leftover.leftoverPayees === 0
        && financialExecuteGrants === 0
        && rls.check_intake_items.enabled === true
        && rls.check_payees.enabled === true
        && rls.check_endorsements.enabled === true,
      readOnly: true,
      database: dbName,
      mutatedChecksops: false,
      liveChecksopsMutated: false,
      schema,
      counts,
      leftover,
      rls,
      financialExecuteGrants,
      payeeTriggerNames: triggerOnPayees,
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
    if (step === 'apply_trigger_parity') return { ...base, ...(await applyTriggerParity(event)), liveChecksopsMutated: false };
    if (step === 'validate_trigger_rename_txn') return { ...base, ...(await validateTriggerRenameTxn(event)), liveChecksopsMutated: false };
    if (step === 'inspect_historical_check_images') return { ...base, ...(await inspectHistoricalCheckImages(event)), liveChecksopsMutated: false };
    if (step === 'targeted_db_recon') return { ...base, ...(await targetedDbRecon(event)), liveChecksopsMutated: false };
    if (step === 'apply_delta') return { ...base, ...(await applyDelta(event)) };
    if (step === 'reconcile') return { ...base, ...(await reconcile(event)) };
    throw new Error(`unknown step ${step}`);
  } catch (error) {
    return { ...base, ok: false, error: String(error.message || error).slice(0, 500) };
  }
};
