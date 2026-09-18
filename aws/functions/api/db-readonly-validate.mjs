import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';
import { evaluateForceRls, summarizeRlsMatrix, TENANT_COLUMNS } from './rls-audit.mjs';
import {
  buildClientConfig,
  classifyDbError,
  EXPECTED_APPLICATION_ROLE,
  IDENTITY_PROBE,
  sanitizePublicError,
} from './db-health.mjs';

const { Client } = pg;

export const CORE_TABLES = [
  'tenants',
  'profiles',
  'tenant_users',
  'user_roles',
  'claims',
  'check_intake_items',
  'check_endorsements',
  'deposit_batches',
  'deposit_items',
  'checkalt_deposits',
  'disbursement_batches',
  'disbursement_splits',
  'payment_provider_accounts',
  'payment_wallets',
  'payment_webhook_events',
  'homeowner_ledger_events',
];

export const EXPECTED_ROW_COUNTS = {
  tenants: 6,
  profiles: 8,
  tenant_users: 7,
  user_roles: 10,
  claims: 180,
  check_intake_items: 182,
  check_endorsements: 502,
  deposit_batches: 115,
  deposit_items: 114,
  checkalt_deposits: 58,
  disbursement_batches: 109,
  disbursement_splits: 108,
  payment_provider_accounts: 3,
  payment_wallets: 1,
  payment_webhook_events: 227,
  homeowner_ledger_events: 657,
};

export const EXPECTED_DATABASE = 'checksops';
export const EXPECTED_SKIPPED_AUTH_USERS_FKS = 47;
export const EXPECTED_PUBLIC_TRIGGERS = 165;

const issue = (kind, severity, message, extra = {}) => ({
  kind,
  severity,
  message,
  ...extra,
});

const redactPathSample = (value) => {
  if (value == null) return null;
  let text = String(value);
  // Remove query string (can include signed URL credentials).
  text = text.replace(/\?.*$/s, '');
  // Redact any UUID-like tokens.
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    '[id]',
  );
  // Redact host on http(s) URLs while keeping a hint of the path shape.
  text = text.replace(/^https?:\/\/[^/]+/i, 'https://[host]');
  // Keep samples short.
  if (text.length > 220) text = `${text.slice(0, 220)}…`;
  return text;
};

const classifyQueryIssue = (error, extra = {}) => {
  const code = error?.code || '';
  const message = sanitizePublicError(error);
  if (code === '42501') return issue('permission', 'error', message, { code, ...extra });
  if (code === '42P01') return issue('missing_relation', 'error', message, { code, ...extra });
  if (code === '42883') return issue('function', 'error', message, { code, ...extra });
  if (code === '23503') return issue('missing_fk', 'error', message, { code, ...extra });
  return issue('query', 'error', message, { code, ...extra });
};

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

const isExpectedAuthPermission = (error) => {
  const code = error?.code || '';
  const message = String(error?.message || '');
  return code === '42501' && /schema auth|function uid|function auth\.uid/i.test(message);
};

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
      // keep the original error if rollback itself fails
    }
    throw error;
  }
};

export const validateReadonlyCoreTables = async ({
  loadCredentials = loadDatabaseCredentials,
  createClient = (config) => new Client(config),
} = {}) => {
  const result = {
    ok: false,
    readOnly: true,
    writesAttempted: false,
    currentDatabase: null,
    currentUser: null,
    transactionReadOnly: null,
    defaultTransactionReadOnly: null,
    connectedDatabase: null,
    secretDatabase: null,
    rlsMode: null,
    restoredTablesRlsEnabled: false,
    failClosedWithoutIdentity: false,
    legacyImagePathInventory: null,
    tables: [],
    privileges: [],
    catalog: {},
    issues: [],
  };

  let client;
  try {
    const credentials = await loadCredentials();
    result.connectedDatabase = credentials.database || null;
    result.secretDatabase = credentials.secretDatabase || null;
    client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 10000 }));
    await client.connect();
    await client.query('BEGIN READ ONLY');

    const identity = (await client.query(IDENTITY_PROBE)).rows[0] || {};
    result.currentDatabase = identity.current_database || null;
    result.currentUser = identity.current_user || null;
    result.transactionReadOnly = identity.transaction_read_only || null;
    result.defaultTransactionReadOnly = identity.default_transaction_read_only || null;

    if (result.currentDatabase !== EXPECTED_DATABASE) {
      result.issues.push(issue(
        'wrong_database',
        'error',
        `connected to ${result.currentDatabase}, expected ${EXPECTED_DATABASE}`,
      ));
    }
    if (result.currentUser !== EXPECTED_APPLICATION_ROLE) {
      result.issues.push(issue(
        'permission',
        'error',
        `connected as ${result.currentUser}, expected ${EXPECTED_APPLICATION_ROLE}`,
      ));
    }

    for (const table of CORE_TABLES) {
      const expected = EXPECTED_ROW_COUNTS[table];
      const row = {
        table,
        present: false,
        rowCount: null,
        expectedCount: expected,
        countMatches: false,
        countMatchesRestore: false,
        failClosedWithoutIdentity: false,
        error: null,
      };
      try {
        const presentResult = await client.query(
          'SELECT to_regclass($1) AS regclass',
          [`public.${table}`],
        );
        row.present = Boolean(presentResult.rows[0]?.regclass);
        if (!row.present) {
          result.issues.push(issue('missing_relation', 'error', `public.${table} is missing`, { table }));
          result.tables.push(row);
          continue;
        }
        const countResult = await client.query(
          `SELECT count(*)::bigint AS row_count FROM public.${quoteIdent(table)}`,
        );
        row.rowCount = Number(countResult.rows[0]?.row_count ?? 0);
        row.countMatchesRestore = row.rowCount === expected;
        row.countMatches = row.countMatchesRestore;
      } catch (error) {
        row.error = sanitizePublicError(error);
        result.issues.push(classifyQueryIssue(error, { table }));
      }
      result.tables.push(row);
    }

    // Read-only inventory: identify legacy/non-canonical check image path values
    // that may require compatibility repair (no DB mutation here).
    try {
      const columns = ['front_image_path', 'back_image_path', 'back_image_original_path'];
      const inventory = {};
      for (const column of columns) {
        const httpUrlCount = Number((await client.query(
          `SELECT count(*)::int AS n FROM public.check_intake_items WHERE ${quoteIdent(column)} ILIKE $1`,
          ['http%'],
        )).rows[0]?.n ?? 0);
        const supabaseUrlCount = Number((await client.query(
          `SELECT count(*)::int AS n FROM public.check_intake_items WHERE ${quoteIdent(column)} ILIKE $1`,
          ['%/storage/v1/object/%'],
        )).rows[0]?.n ?? 0);
        const bucketPrefixCount = Number((await client.query(
          `SELECT count(*)::int AS n FROM public.check_intake_items WHERE ${quoteIdent(column)} ILIKE $1`,
          ['claim-files/%'],
        )).rows[0]?.n ?? 0);
        const nonCanonicalPrefixCount = Number((await client.query(
          `SELECT count(*)::int AS n
           FROM public.check_intake_items
           WHERE ${quoteIdent(column)} IS NOT NULL
             AND ${quoteIdent(column)} NOT ILIKE $1
             AND ${quoteIdent(column)} NOT ILIKE $2`,
          ['checks/%', 'check-intake/%'],
        )).rows[0]?.n ?? 0);

        const examples = (await client.query(
          `SELECT id::text AS id, ${quoteIdent(column)} AS value
           FROM public.check_intake_items
           WHERE ${quoteIdent(column)} ILIKE $1
              OR ${quoteIdent(column)} ILIKE $2
              OR ${quoteIdent(column)} ILIKE $3
              OR (${quoteIdent(column)} IS NOT NULL
                  AND ${quoteIdent(column)} NOT ILIKE $4
                  AND ${quoteIdent(column)} NOT ILIKE $5)
           LIMIT 5`,
          ['http%', '%/storage/v1/object/%', 'claim-files/%', 'checks/%', 'check-intake/%'],
        )).rows.map((row) => ({
          id: redactPathSample(row.id),
          value: redactPathSample(row.value),
        }));

        inventory[column] = {
          httpUrlCount,
          supabaseStorageUrlCount: supabaseUrlCount,
          claimFilesPrefixCount: bucketPrefixCount,
          nonCanonicalPrefixCount,
          examples,
        };
      }
      result.legacyImagePathInventory = inventory;
    } catch (error) {
      result.issues.push(classifyQueryIssue(error, { table: 'check_intake_items', column: 'image_paths' }));
    }

    try {
      const privilegeResult = await client.query(
        `SELECT c.relname AS table_name,
                has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
                has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
                has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
                has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
                c.relrowsecurity AS rls_enabled,
                c.relforcerowsecurity AS rls_forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [CORE_TABLES],
      );
      result.privileges = privilegeResult.rows.map((row) => ({
        table: row.table_name,
        canSelect: row.can_select === true,
        canInsert: row.can_insert === true,
        canUpdate: row.can_update === true,
        canDelete: row.can_delete === true,
        rlsEnabled: row.rls_enabled === true,
        rlsForced: row.rls_forced === true,
      }));
      const enabledCount = result.privileges.filter((row) => row.rlsEnabled).length;
      result.rlsMode = enabledCount === 0
        ? 'off'
        : enabledCount === result.privileges.length
          ? 'on'
          : 'partial';
      result.restoredTablesRlsEnabled = result.rlsMode === 'on';
      result.failClosedWithoutIdentity = false;
      for (const row of result.privileges) {
        if (!row.canSelect) {
          result.issues.push(issue('permission', 'error', `SELECT denied on public.${row.table}`, { table: row.table }));
        }
        if (row.canInsert || row.canUpdate || row.canDelete) {
          result.issues.push(issue(
            'permission',
            row.rlsEnabled ? 'expected' : 'error',
            row.rlsEnabled
              ? `write privilege present on public.${row.table} under RLS`
              : `write privilege present on public.${row.table}`,
            { table: row.table, canInsert: row.canInsert, canUpdate: row.canUpdate, canDelete: row.canDelete },
          ));
        }
        if (row.rlsForced) {
          result.issues.push(issue(
            'permission',
            'error',
            `FORCE ROW LEVEL SECURITY is set on public.${row.table}`,
            { table: row.table },
          ));
        }
      }
      if (result.rlsMode === 'partial') {
        result.issues.push(issue(
          'permission',
          'error',
          `RLS enablement is incomplete on core tables (${enabledCount}/${result.privileges.length})`,
        ));
      }
      if (result.rlsMode === 'off') {
        for (const row of result.tables) {
          if (row.present && !row.countMatchesRestore) {
            result.issues.push(issue(
              'count_mismatch',
              'error',
              `public.${row.table} count ${row.rowCount} != expected ${row.expectedCount}`,
              { table: row.table, rowCount: row.rowCount, expectedCount: row.expectedCount },
            ));
          }
        }
      }
      if (result.rlsMode === 'on') {
        let failClosed = true;
        for (const row of result.tables) {
          if (!row.present) continue;
          if (row.rowCount === 0) {
            row.countMatches = true;
            row.failClosedWithoutIdentity = true;
            continue;
          }
          failClosed = false;
          row.countMatches = false;
          row.failClosedWithoutIdentity = false;
          result.issues.push(issue(
            'permission',
            'error',
            `public.${row.table} is visible to checksops without request.app_user_id after RLS (${row.rowCount} rows)`,
            { table: row.table, rowCount: row.rowCount, expectedCount: row.expectedCount },
          ));
        }
        result.failClosedWithoutIdentity = failClosed;
        if (failClosed) {
          result.issues.push(issue(
            'permission',
            'expected',
            'Application role without identity sees 0 core-table rows (global RLS fail-closed). Restore counts are reconciled as table owner, not here.',
          ));
        }
      }
    } catch (error) {
      result.issues.push(classifyQueryIssue(error, { probe: 'privileges' }));
    }

    const catalog = {
      sentinelPresent: null,
      schemaUsage: {},
      authUsersPresent: null,
      restoredAuthUsersForeignKeys: null,
      skippedAuthUsersForeignKeysExpected: EXPECTED_SKIPPED_AUTH_USERS_FKS,
      publicTriggers: null,
      publicFunctions: null,
      supabaseAuthUidFunctions: null,
      supabaseNetFunctions: null,
      supabaseCronFunctions: null,
      supabaseVaultFunctions: null,
      supabasePgmqFunctions: null,
      canExecuteAuthUid: null,
      authUidResult: null,
    };

    const catalogProbes = [
      {
        key: 'sentinel',
        sql: "SELECT to_regclass('public._checksops_restore_complete') IS NOT NULL AS present",
        apply: (row) => {
          catalog.sentinelPresent = row.present === true;
          if (!catalog.sentinelPresent) {
            result.issues.push(issue('missing_relation', 'error', 'restore sentinel public._checksops_restore_complete is missing'));
          }
        },
      },
      {
        key: 'schema_usage',
        sql: `SELECT nspname AS schema_name,
                     has_schema_privilege(current_user, n.oid, 'USAGE') AS can_usage
              FROM pg_namespace n
              WHERE nspname IN ('public', 'auth', 'storage', 'extensions')
              ORDER BY nspname`,
        applyMany: (rows) => {
          catalog.schemaUsage = Object.fromEntries(rows.map((row) => [row.schema_name, row.can_usage === true]));
          if (catalog.schemaUsage.public !== true) {
            result.issues.push(issue('permission', 'error', 'USAGE denied on schema public'));
          }
          if (catalog.schemaUsage.auth) {
            result.issues.push(issue(
              'permission',
              'expected',
              'USAGE granted on schema auth for the identity-phase auth.uid() shim; auth.users remains unrestored',
            ));
          } else {
            result.issues.push(issue(
              'permission',
              'expected',
              'USAGE denied on schema auth (Auth/Cognito is not in this phase; least-privilege)',
            ));
          }
          if (catalog.schemaUsage.storage) {
            result.issues.push(issue('permission', 'error', 'USAGE unexpectedly granted on schema storage'));
          }
        },
      },
      {
        key: 'auth_users',
        sql: `SELECT EXISTS (
                SELECT 1
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'auth' AND c.relname = 'users' AND c.relkind = 'r'
              ) AS present`,
        apply: (row) => {
          catalog.authUsersPresent = row.present === true;
          if (!catalog.authUsersPresent) {
            result.issues.push(issue(
              'supabase_dependency',
              'expected',
              'auth.users stub is missing (Auth/Cognito not in this phase)',
            ));
          }
        },
      },
      {
        key: 'auth_users_fks',
        sql: `SELECT count(*)::int AS fk_count
              FROM pg_constraint con
              JOIN pg_class ref ON ref.oid = con.confrelid
              JOIN pg_namespace n ON n.oid = ref.relnamespace
              WHERE con.contype = 'f'
                AND n.nspname = 'auth'
                AND ref.relname = 'users'`,
        apply: (row) => {
          catalog.restoredAuthUsersForeignKeys = Number(row.fk_count || 0);
          if (catalog.restoredAuthUsersForeignKeys === 0) {
            result.issues.push(issue(
              'missing_fk',
              'expected',
              `${EXPECTED_SKIPPED_AUTH_USERS_FKS} public FKs to auth.users were skipped on restore and remain absent`,
              { restored: 0, skipped: EXPECTED_SKIPPED_AUTH_USERS_FKS },
            ));
          } else if (catalog.restoredAuthUsersForeignKeys !== EXPECTED_SKIPPED_AUTH_USERS_FKS) {
            result.issues.push(issue(
              'missing_fk',
              'error',
              `unexpected auth.users FK count ${catalog.restoredAuthUsersForeignKeys}`,
              { restored: catalog.restoredAuthUsersForeignKeys, skipped: EXPECTED_SKIPPED_AUTH_USERS_FKS },
            ));
          }
        },
      },
      {
        key: 'triggers',
        sql: `SELECT count(*)::int AS trigger_count
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
        apply: (row) => {
          catalog.publicTriggers = Number(row.trigger_count || 0);
          if (catalog.publicTriggers !== EXPECTED_PUBLIC_TRIGGERS) {
            result.issues.push(issue(
              'trigger',
              'error',
              `public trigger count ${catalog.publicTriggers} != expected ${EXPECTED_PUBLIC_TRIGGERS}`,
            ));
          }
        },
      },
      {
        key: 'functions',
        sql: `SELECT
                count(*) FILTER (WHERE p.prokind IN ('f', 'p'))::int AS function_count,
                count(*) FILTER (WHERE p.prosrc ILIKE '%auth.uid%')::int AS auth_uid_functions,
                count(*) FILTER (WHERE p.prosrc ~* 'net\\.')::int AS net_functions,
                count(*) FILTER (WHERE p.prosrc ~* 'cron\\.')::int AS cron_functions,
                count(*) FILTER (WHERE p.prosrc ~* 'vault\\.|decrypted_secrets')::int AS vault_functions,
                count(*) FILTER (WHERE p.prosrc ~* 'pgmq\\.')::int AS pgmq_functions
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'`,
        apply: (row) => {
          catalog.publicFunctions = Number(row.function_count || 0);
          catalog.supabaseAuthUidFunctions = Number(row.auth_uid_functions || 0);
          catalog.supabaseNetFunctions = Number(row.net_functions || 0);
          catalog.supabaseCronFunctions = Number(row.cron_functions || 0);
          catalog.supabaseVaultFunctions = Number(row.vault_functions || 0);
          catalog.supabasePgmqFunctions = Number(row.pgmq_functions || 0);
          if (catalog.supabaseNetFunctions || catalog.supabaseCronFunctions || catalog.supabaseVaultFunctions || catalog.supabasePgmqFunctions) {
            result.issues.push(issue(
              'supabase_dependency',
              'expected',
              'public function bodies still reference net/cron/vault/pgmq; EXECUTE was not granted to checksops',
              {
                net: catalog.supabaseNetFunctions,
                cron: catalog.supabaseCronFunctions,
                vault: catalog.supabaseVaultFunctions,
                pgmq: catalog.supabasePgmqFunctions,
              },
            ));
          }
          if (catalog.supabaseAuthUidFunctions) {
            result.issues.push(issue(
              'supabase_dependency',
              'expected',
              `${catalog.supabaseAuthUidFunctions} public functions reference auth.uid(); Auth/Cognito is not in this phase`,
            ));
          }
        },
      },
      {
        key: 'auth_uid_privilege',
        sql: "SELECT has_function_privilege(current_user, 'auth.uid()', 'EXECUTE') AS can_execute",
        apply: (row) => {
          catalog.canExecuteAuthUid = row.can_execute === true;
          if (!catalog.canExecuteAuthUid) {
            result.issues.push(issue(
              'function',
              'expected',
              'checksops cannot EXECUTE auth.uid(); least-privilege grants omitted function EXECUTE',
            ));
          }
        },
      },
    ];

    for (const probe of catalogProbes) {
      try {
        const queryResult = await withSavepoint(client, `p_${probe.key}`, () => client.query(probe.sql));
        if (probe.applyMany) probe.applyMany(queryResult.rows);
        else probe.apply(queryResult.rows[0] || {});
      } catch (error) {
        const classified = classifyQueryIssue(error, { probe: probe.key });
        if (isExpectedAuthPermission(error) || (probe.key === 'auth_uid_privilege' && error?.code === '42501')) {
          classified.severity = 'expected';
          classified.kind = probe.key.includes('auth') ? 'supabase_dependency' : classified.kind;
        }
        if (probe.key === 'auth_users_fks' && (error?.code === '42P01' || /does not exist/i.test(String(error?.message || '')))) {
          classified.kind = 'missing_fk';
          classified.severity = 'expected';
        }
        result.issues.push(classified);
      }
    }

    try {
      const uidResult = await withSavepoint(client, 'p_auth_uid', () => client.query('SELECT auth.uid() AS auth_uid'));
      catalog.authUidResult = uidResult.rows[0]?.auth_uid ?? null;
    } catch (error) {
      catalog.authUidResult = null;
      result.issues.push(issue(
        isExpectedAuthPermission(error) ? 'supabase_dependency' : 'function',
        error?.code === '42501' ? 'expected' : 'error',
        sanitizePublicError(error),
        { code: error?.code || '', probe: 'auth.uid()' },
      ));
    }

    result.catalog = catalog;
    try {
      const roles = (await client.query(`SELECT rolname, rolsuper, rolbypassrls
        FROM pg_roles
        WHERE rolname IN ('checksops', 'checksops_admin', 'postgres', 'rdsadmin')
        ORDER BY rolname`)).rows;
      const tables = (await client.query(`SELECT c.relname AS table,
        pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = ANY($1::text[])
        ) AS has_tenant_column
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`, [TENANT_COLUMNS])).rows;
      const policies = (await client.query(`SELECT tablename, cmd, count(*)::int AS n
        FROM pg_policies WHERE schemaname = 'public'
        GROUP BY tablename, cmd ORDER BY tablename, cmd`)).rows;
      const summary = summarizeRlsMatrix(tables, policies);
      result.rlsAudit = {
        roles: roles.map((row) => ({
          rolname: row.rolname,
          rolsuper: row.rolsuper === true,
          rolbypassrls: row.rolbypassrls === true,
        })),
        force: evaluateForceRls({ roles, tables }),
        summary: {
          tableCount: summary.tableCount,
          rlsEnabled: summary.rlsEnabled,
          rlsForced: summary.rlsForced,
          tenantSensitive: summary.tenantSensitive,
          missingRls: summary.missingRls,
          missingSelect: summary.missingSelect,
          unforcedEnabled: summary.unforcedEnabled,
        },
        matrix: summary.matrix,
      };
    } catch (error) {
      result.rlsAudit = { error: sanitizePublicError(error) };
    }
    result.ok = result.issues.every((item) => item.severity !== 'error')
      && result.tables.length === CORE_TABLES.length
      && result.tables.every((row) => row.present && row.countMatches && !row.error);
    return result;
  } catch (error) {
    const classified = classifyDbError(error, error.stage);
    result.issues.push(issue(classified.stage || 'query', 'error', classified.message));
    result.ok = false;
    return result;
  } finally {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore if no transaction is open
      }
      try {
        await client.end();
      } catch {
        // ignore disconnect errors
      }
    }
  }
};
