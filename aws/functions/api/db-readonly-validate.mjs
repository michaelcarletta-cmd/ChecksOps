import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';
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
export const EXPECTED_PUBLIC_TRIGGERS = 164;

const issue = (kind, severity, message, extra = {}) => ({
  kind,
  severity,
  message,
  ...extra,
});

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
        row.countMatches = row.rowCount === expected;
        if (!row.countMatches) {
          result.issues.push(issue(
            'count_mismatch',
            'error',
            `public.${table} count ${row.rowCount} != expected ${expected}`,
            { table, rowCount: row.rowCount, expectedCount: expected },
          ));
        }
      } catch (error) {
        row.error = sanitizePublicError(error);
        result.issues.push(classifyQueryIssue(error, { table }));
      }
      result.tables.push(row);
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
      for (const row of result.privileges) {
        if (!row.canSelect) {
          result.issues.push(issue('permission', 'error', `SELECT denied on public.${row.table}`, { table: row.table }));
        }
        if (row.canInsert || row.canUpdate || row.canDelete) {
          result.issues.push(issue(
            'permission',
            'error',
            `write privilege present on public.${row.table}`,
            { table: row.table, canInsert: row.canInsert, canUpdate: row.canUpdate, canDelete: row.canDelete },
          ));
        }
        if (row.rlsEnabled || row.rlsForced) {
          result.issues.push(issue(
            'permission',
            'error',
            `RLS unexpectedly enabled on public.${row.table}`,
            { table: row.table },
          ));
        }
      }
    } catch (error) {
      result.issues.push(classifyQueryIssue(error, { probe: 'privileges' }));
    }

    const catalog = {
      sentinelPresent: null,
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
        key: 'auth_users',
        sql: "SELECT to_regclass('auth.users') IS NOT NULL AS present",
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
              FROM pg_constraint
              WHERE contype = 'f'
                AND confrelid = to_regclass('auth.users')`,
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
        const rows = (await client.query(probe.sql)).rows[0] || {};
        probe.apply(rows);
      } catch (error) {
        const classified = classifyQueryIssue(error, { probe: probe.key });
        if (probe.key === 'auth_uid_privilege' && error?.code === '42501') {
          classified.severity = 'expected';
          classified.kind = 'function';
        }
        if (probe.key === 'auth_users_fks' && (error?.code === '42P01' || /does not exist/i.test(String(error?.message || '')))) {
          classified.kind = 'missing_fk';
          classified.severity = 'expected';
        }
        result.issues.push(classified);
      }
    }

    try {
      const uidResult = await client.query('SELECT auth.uid() AS auth_uid');
      catalog.authUidResult = uidResult.rows[0]?.auth_uid ?? null;
    } catch (error) {
      catalog.authUidResult = null;
      result.issues.push(issue(
        'function',
        error?.code === '42501' ? 'expected' : 'error',
        sanitizePublicError(error),
        { code: error?.code || '', probe: 'auth.uid()' },
      ));
    }

    result.catalog = catalog;
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
