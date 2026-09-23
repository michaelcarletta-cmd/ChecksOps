import fs from 'node:fs';
import path from 'node:path';
import { parseGeneratedDatabaseTypes } from './parse-types.mjs';
import { parseLiveSourceInventory } from './parse-live-inventory.mjs';
import { describeLiveAccess } from './live-access.mjs';
import {
  CONDITIONAL_RDS_EXTENSIONS,
  CRITICAL_TABLE_GROUPS,
  EXCLUDED_SCHEMAS,
  FINANCIAL_METRICS,
  LANES,
  LIVE_SOURCE_COUNTS,
  POSTGIS_CATALOG_VIEWS,
  RDS_SUPPORTED_EXTENSIONS,
  SENSITIVE_PUBLIC_TABLES,
  SOURCE,
  STORAGE_BUCKETS,
  TARGET_RDS,
  UNSUPPORTED_OR_SUPABASE_EXTENSIONS,
  WEBHOOK_EDGE_FUNCTIONS,
  allCriticalTables,
} from './catalog.mjs';

const EXTENSION_RE = /CREATE EXTENSION(?:\s+IF NOT EXISTS)?\s+["']?([a-zA-Z0-9_]+)/gi;
const AUTH_USERS_RE = /auth\.users/gi;
const AUTH_HELPER_RE = /auth\.(uid|jwt|role|email)\s*\(/gi;
const RLS_RE = /ENABLE ROW LEVEL SECURITY/gi;
const POLICY_RE = /CREATE POLICY/gi;
const CRON_RE = /cron\.schedule/gi;
const NET_RE = /net\.http_/gi;
const VAULT_RE = /vault\.|pgsodium/gi;
const STORAGE_SCHEMA_RE = /\bstorage\./gi;
const REALTIME_RE = /\brealtime\./gi;

const scanMigrations = (migrationsDir) => {
  const files = fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  const extensions = new Set();
  let authUsersRefs = 0;
  let authHelperRefs = 0;
  let rlsEnable = 0;
  let policies = 0;
  let cronSchedules = 0;
  let netHttp = 0;
  let vaultRefs = 0;
  let storageRefs = 0;
  let realtimeRefs = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const match of text.matchAll(EXTENSION_RE)) extensions.add(match[1]);
    authUsersRefs += (text.match(AUTH_USERS_RE) || []).length;
    authHelperRefs += (text.match(AUTH_HELPER_RE) || []).length;
    rlsEnable += (text.match(RLS_RE) || []).length;
    policies += (text.match(POLICY_RE) || []).length;
    cronSchedules += (text.match(CRON_RE) || []).length;
    netHttp += (text.match(NET_RE) || []).length;
    vaultRefs += (text.match(VAULT_RE) || []).length;
    storageRefs += (text.match(STORAGE_SCHEMA_RE) || []).length;
    realtimeRefs += (text.match(REALTIME_RE) || []).length;
  }
  return {
    migrationFileCount: files.length,
    extensions: [...extensions].sort(),
    authUsersRefs,
    authHelperRefs,
    rlsEnable,
    policies,
    cronSchedules,
    netHttp,
    vaultRefs,
    storageRefs,
    realtimeRefs,
  };
};

const listEdgeFunctions = (functionsDir) => {
  if (!fs.existsSync(functionsDir)) return [];
  return fs
    .readdirSync(functionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(functionsDir, entry.name, 'index.ts')))
    .map((entry) => entry.name)
    .sort();
};

const classifyTable = (name) => {
  if (POSTGIS_CATALOG_VIEWS.includes(name)) {
    return {
      object: name,
      lane: 'postgresql_schema',
      disposition: 'transform',
      reason: 'PostGIS catalog view. Restore only if the PostGIS extension is enabled on RDS.',
    };
  }
  if (SENSITIVE_PUBLIC_TABLES.includes(name)) {
    return {
      object: name,
      lane: 'public_application_data',
      disposition: 'migrate_directly',
      reason: 'Public application data that contains secrets/PII. Copy with the dump; never print contents.',
      sensitive: true,
    };
  }
  return {
    object: name,
    lane: 'public_application_data',
    disposition: 'migrate_directly',
    reason: 'Public application table. Schema, indexes, constraints, sequences, and rows copy with pg_dump/pg_restore.',
  };
};

const classifyView = (name) => {
  if (POSTGIS_CATALOG_VIEWS.includes(name)) {
    return {
      object: name,
      lane: 'postgresql_schema',
      disposition: 'transform',
      reason: 'Created by PostGIS, not ChecksOps SQL. Enable PostGIS first if the live dump requires it.',
    };
  }
  return {
    object: name,
    lane: 'postgresql_schema',
    disposition: 'migrate_directly',
    reason: 'Public view. Restore with schema dump after base tables exist.',
  };
};

export const liveInventoryPath = (repoRoot) =>
  path.join(repoRoot, 'aws/db-copy/LIVE_SOURCE_INVENTORY.md');

/**
 * Load the authoritative live inventory from the committed markdown file.
 * Does not contact Supabase or request credentials.
 */
export const loadCommittedLiveInventory = (repoRoot) => {
  const inventoryPath = liveInventoryPath(repoRoot);
  const live = parseLiveSourceInventory(inventoryPath);
  const types = parseGeneratedDatabaseTypes(path.join(repoRoot, 'src/types/database.ts'));
  const access = describeLiveAccess();

  const tableCountMatch = live.public.baseTables === types.tables.length;
  const viewCountMatch = live.public.views === types.views.length;

  return {
    status: 'ready',
    apply: false,
    source: 'LIVE_SOURCE_INVENTORY.md',
    inventoryPath: 'aws/db-copy/LIVE_SOURCE_INVENTORY.md',
    access,
    live,
    generatedTypes: {
      tables: types.tables.length,
      views: types.views.length,
      functions: types.functions.length,
      note: 'PostgREST types list 358 functions; live catalog has 960 public routines.',
    },
    alignment: {
      tableCountMatch,
      viewCountMatch,
      noTwentyTableDiscrepancy: live.noTableGapVsViews,
      explanation:
        '186 public relations = 166 base tables + 20 views. Generated types match both counts.',
    },
    outOfScope: {
      authUsers: { count: live.authUsers, destination: 'Cognito', dump: false },
      storageObjects: { count: live.storageObjects, destination: 'S3', dump: false },
      rlsActivation: { count: live.public.rlsPolicies, apply: false },
      realtime: { copy: false },
      cronNetVaultPgmq: { copyBehavior: false, inspectAfterRestore: true },
      productionWebhooks: { copy: false },
    },
    expected: LIVE_SOURCE_COUNTS,
  };
};

export const buildRepoInventory = (repoRoot) => {
  const typesPath = path.join(repoRoot, 'src/types/database.ts');
  const migrationsDir = path.join(repoRoot, 'supabase/migrations');
  const functionsDir = path.join(repoRoot, 'supabase/functions');
  const parsed = parseGeneratedDatabaseTypes(typesPath);
  const migrations = scanMigrations(migrationsDir);
  const edgeFunctions = listEdgeFunctions(functionsDir);
  const critical = allCriticalTables();
  const missingCritical = critical.filter((name) => !parsed.tables.includes(name));
  const liveInventory = loadCommittedLiveInventory(repoRoot);

  const classifications = {
    migrate_directly: [],
    transform: [
      {
        object: 'auth.uid() compatibility stubs (no Auth user rows)',
        lane: 'database_functions_triggers',
        disposition: 'transform',
        reason:
          'Live catalog found 0 public FKs to auth.users. First copy does not dump the 9 Auth users. Install no-op auth.uid()/auth.jwt() stubs so the 40 public functions that reference auth.uid() can compile. Cognito is a later phase.',
      },
      {
        object: 'public functions/triggers that call net.*, cron.*, vault, or pgmq',
        lane: 'database_functions_triggers',
        disposition: 'transform',
        reason:
          'Live inventory: 4 net.*, 2 cron.*, 5 vault, 5 pgmq public functions. Inspect after restore; disable those bodies. Do not enable pg_cron/pg_net/vault/pgmq behavior on RDS.',
      },
      {
        object: 'role owners and GRANTs (anon, authenticated, service_role)',
        lane: 'postgresql_schema',
        disposition: 'transform',
        reason:
          'Supabase roles do not exist on RDS. Restore with --no-owner --no-acl. Grant least privilege to checksops after restore.',
      },
    ],
    migrate_later: [
      {
        object: 'Supabase Auth users (9) → Cognito',
        lane: 'auth_users',
        disposition: 'migrate_later',
        reason: 'Out of first PostgreSQL copy. Do not dump password hashes, sessions, tokens, or identities.',
      },
      {
        object: 'storage.objects (1,335) → S3',
        lane: 'storage_objects',
        disposition: 'migrate_later',
        reason: 'Cannot restore into S3 by pg_restore. Copy objects in the storage phase with key mapping.',
      },
      {
        object: 'RLS policies (380)',
        lane: 'rls_security_policies',
        disposition: 'migrate_later',
        reason:
          'Extract to a sidecar file. Do not ENABLE ROW LEVEL SECURITY on first restore; policies depend on auth.uid() and would hide rows from checksops.',
      },
      {
        object: 'Edge Functions and production webhooks',
        lane: 'edge_functions_webhooks',
        disposition: 'migrate_later',
        reason: 'Rewrite as Lambda/API routes. Do not change Moov, CheckAlt, Plaid, or Resend production webhooks.',
      },
      {
        object: 'Realtime publication',
        lane: 'postgresql_schema',
        disposition: 'migrate_later',
        reason: 'Supabase Realtime is not RDS. Application will not use postgres changes feed on staging.',
      },
    ],
  };

  for (const table of parsed.tables) {
    const classified = classifyTable(table);
    classifications[classified.disposition].push(classified);
  }
  for (const view of parsed.views) {
    const classified = classifyView(view);
    classifications[classified.disposition].push(classified);
  }

  return {
    generatedAt: 'repo-scan+committed-live-inventory',
    source: SOURCE,
    target: TARGET_RDS,
    lanes: LANES,
    liveInventory,
    generatedSchema: {
      tables: parsed.tables,
      views: parsed.views,
      functions: parsed.functions,
      enums: parsed.enums,
      tableCount: parsed.tables.length,
      viewCount: parsed.views.length,
      functionCount: parsed.functions.length,
      enumCount: parsed.enums.length,
    },
    migrations,
    edgeFunctions: {
      count: edgeFunctions.length,
      names: edgeFunctions,
      webhookFunctions: WEBHOOK_EDGE_FUNCTIONS.filter((name) => edgeFunctions.includes(name)),
    },
    storageBuckets: STORAGE_BUCKETS,
    extensions: {
      rdsSupported: RDS_SUPPORTED_EXTENSIONS,
      conditional: CONDITIONAL_RDS_EXTENSIONS,
      unsupportedOrSupabase: UNSUPPORTED_OR_SUPABASE_EXTENSIONS,
      seenInMigrations: migrations.extensions,
    },
    excludedSchemas: EXCLUDED_SCHEMAS,
    criticalTableGroups: CRITICAL_TABLE_GROUPS,
    criticalTables: critical,
    missingCriticalFromGeneratedTypes: missingCritical,
    financialMetrics: FINANCIAL_METRICS.filter((metric) =>
      metric.table ? parsed.tables.includes(metric.table) : true,
    ),
    sensitivePublicTables: SENSITIVE_PUBLIC_TABLES.filter((name) => parsed.tables.includes(name)),
    classifications,
    safety: {
      preparationOnly: true,
      defaultCommandConnects: false,
      dumpRestoreDisabledUnlessEnv: 'CHECKSOPS_DB_COPY_EXECUTE=I_UNDERSTAND_THIS_WRITES_DATA',
      applicationRoleMustStayLeastPrivileged: true,
      doNotChangeProductionSupabase: true,
      doNotSwitchProviderWebhooks: true,
      doNotRequestSupabaseToken: true,
      restoreIntoIsolatedDatabase: TARGET_RDS.recommendedRestoreDatabase,
      leavePostgresDatabaseUntouched: true,
    },
  };
};

export const summarizeClassification = (inventory) => ({
  migrateDirectly: inventory.classifications.migrate_directly.length,
  transform: inventory.classifications.transform.length,
  migrateLater: inventory.classifications.migrate_later.length,
});
