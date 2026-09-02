import path from 'node:path';
import {
  EXECUTE_ENV,
  EXECUTE_VALUE,
  EXCLUDED_SCHEMAS,
  LIVE_SOURCE_COUNTS,
  TARGET_RDS,
} from './catalog.mjs';

const excludeSchemaFlags = EXCLUDED_SCHEMAS.flatMap((schema) => ['--exclude-schema', schema]);

export const isExecuteAuthorized = (env = process.env, argv = process.argv) =>
  env[EXECUTE_ENV] === EXECUTE_VALUE && argv.includes('--execute');

export const refuseExecuteMessage = () =>
  [
    'REFUSING dump/restore: this revision is preparation-only.',
    'The tooling will not connect to, export, restore, truncate, drop, or overwrite either database.',
    `To enable later, an operator must set ${EXECUTE_ENV}=${EXECUTE_VALUE} and pass --execute.`,
    'Do not do that until a later approved copy phase.',
  ].join(' ');

export const buildDumpPlan = ({ artifactDir = '/var/lib/checksops/db-copy' } = {}) => {
  const schemaFile = path.posix.join(artifactDir, 'public-schema.dump');
  const dataFile = path.posix.join(artifactDir, 'public-data.dump');
  const rlsFile = path.posix.join(artifactDir, 'public-rls.sql');
  const schemaList = path.posix.join(artifactDir, 'public-schema.list');
  return {
    preparationOnly: true,
    apply: false,
    source: {
      kind: 'live ChecksOps Supabase/Lovable PostgreSQL',
      inventory: 'aws/db-copy/LIVE_SOURCE_INVENTORY.md',
      counts: LIVE_SOURCE_COUNTS,
      dumpCredentials: 'operator-held read-only URI; never requested or logged by this tooling',
    },
    target: TARGET_RDS,
    restoreDatabase: TARGET_RDS.recommendedRestoreDatabase,
    leaveUntouched: TARGET_RDS.defaultDatabase,
    envVarsRequiredLater: [
      'Operator-held read-only source URI (not stored in this Cloud Agent)',
      'CHECKSOPS_RDS_ADMIN_URL on a host that can reach private RDS',
    ],
    notes: [
      `Authoritative inventory: ${LIVE_SOURCE_COUNTS.publicBaseTables} base tables, ${LIVE_SOURCE_COUNTS.publicViews} views, ${LIVE_SOURCE_COUNTS.publicFunctions} functions, ${LIVE_SOURCE_COUNTS.publicTriggers} triggers, ${LIVE_SOURCE_COUNTS.publicRlsPolicies} RLS policies.`,
      '186 public relations = 166 tables + 20 views. There is no 20-table data gap.',
      `Do not dump ${LIVE_SOURCE_COUNTS.authUsers} auth.users (Cognito later). Live catalog found ${LIVE_SOURCE_COUNTS.publicForeignKeysToAuthUsers} public FKs to auth.users.`,
      `Do not dump ${LIVE_SOURCE_COUNTS.storageObjects} storage.objects (S3 later).`,
      'Dump public schema only. Do not dump auth, storage, realtime, vault, cron, net, or pgmq.',
      'Extract RLS policies to a sidecar SQL file and filter POLICY / ROW SECURITY from pg_restore -l. Do not apply them on RDS in the first restore.',
      `Restore into isolated database ${TARGET_RDS.recommendedRestoreDatabase}. Leave ${TARGET_RDS.defaultDatabase} and /db-health untouched.`,
      'Restore as checksops_admin. Keep checksops LOGIN with CONNECT + SELECT only.',
      'Never log, print, or commit connection URIs or passwords.',
    ],
    sequence: [
      {
        id: 1,
        lane: 'postgresql_schema',
        title: 'Create isolated restore database and RDS-supported extensions',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          `psql --dbname=${TARGET_RDS.defaultDatabase} --command "CREATE DATABASE ${TARGET_RDS.recommendedRestoreDatabase};"`,
          `psql --dbname=${TARGET_RDS.recommendedRestoreDatabase} --file aws/db-copy/sql/00_rds_supported_extensions.sql`,
          `psql --dbname=${TARGET_RDS.recommendedRestoreDatabase} --file aws/db-copy/sql/01_auth_compatibility_stubs.sql`,
        ],
      },
      {
        id: 2,
        lane: 'postgresql_schema',
        title: 'Dump public schema without owners, ACLs, publications, or subscriptions',
        role: 'operator, live source, read-only',
        apply: false,
        commands: [
          [
            'pg_dump',
            '--format=custom',
            '--schema-only',
            '--schema=public',
            '--no-owner',
            '--no-acl',
            '--no-publications',
            '--no-subscriptions',
            ...excludeSchemaFlags,
            `--file=${schemaFile}`,
          ].join(' '),
        ],
      },
      {
        id: 3,
        lane: 'rls_security_policies',
        title: 'Extract RLS policy SQL and filter it out of the restore list; do not restore it',
        role: 'operator, live source, read-only',
        apply: false,
        commands: [
          `pg_dump --schema=public --section=pre-data --section=post-data --no-owner --no-acl | awk '/CREATE POLICY|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/ {print}' > ${rlsFile}`,
          `pg_restore -l ${schemaFile} | grep -v -E 'POLICY|ROW SECURITY' > ${schemaList}`,
        ],
      },
      {
        id: 4,
        lane: 'public_application_data',
        title: 'Dump public data for all 166 base tables',
        role: 'operator, live source, read-only',
        apply: false,
        commands: [
          [
            'pg_dump',
            '--format=custom',
            '--data-only',
            '--schema=public',
            '--no-owner',
            '--disable-triggers',
            `--file=${dataFile}`,
          ].join(' '),
        ],
      },
      {
        id: 5,
        lane: 'postgresql_schema',
        title: 'Restore schema then data into isolated database checksops (no Auth rows, no RLS)',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          `pg_restore --dbname=${TARGET_RDS.recommendedRestoreDatabase} --no-owner --no-acl --use-list=${schemaList} --exit-on-error ${schemaFile}`,
          `pg_restore --dbname=${TARGET_RDS.recommendedRestoreDatabase} --data-only --disable-triggers --no-owner --exit-on-error ${dataFile}`,
        ],
      },
      {
        id: 6,
        lane: 'database_functions_triggers',
        title: 'Inspect and disable net/cron/vault/pgmq behavior; keep data-integrity triggers',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          `psql --dbname=${TARGET_RDS.recommendedRestoreDatabase} --file aws/db-copy/sql/03_inspect_supabase_dependencies.sql`,
          'Disable or no-op public functions/triggers that call net.*, cron.*, vault, or pgmq. Keep data-integrity triggers. Stop rather than guessing.',
        ],
      },
      {
        id: 7,
        lane: 'public_application_data',
        title: 'Grant least privilege and reconcile all 166 tables plus financial metrics',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          `psql --dbname=${TARGET_RDS.recommendedRestoreDatabase} --file aws/db-copy/sql/02_grant_readonly_application_role.sql`,
          'psql --file aws/db-copy/sql/reconciliation_counts.sql  # run on source and target; 166 counts must match',
          'psql --file aws/db-copy/sql/reconciliation_financial.sql  # payment/check/deposit/endorsement/disbursement',
        ],
      },
    ],
    rollback: {
      apply: false,
      sql: 'aws/db-copy/sql/04_rollback_failed_staging_database.sql',
      command: `psql --dbname=${TARGET_RDS.defaultDatabase} --command "DROP DATABASE ${TARGET_RDS.recommendedRestoreDatabase};"`,
      never: [
        `DROP DATABASE ${TARGET_RDS.defaultDatabase}`,
        'DROP ROLE checksops',
        'DROP ROLE checksops_admin',
        'password changes',
        'RDS instance create/replace/reboot/resize/delete',
      ],
    },
    neverInThisPhase: [
      'auth.users dump or Cognito import',
      'storage object copy to S3',
      'RLS policy apply / ENABLE ROW LEVEL SECURITY',
      'realtime publication restore',
      'pg_cron / pg_net / supabase_vault / pgmq / pgsodium behavior',
      'Edge Function deploy as production webhook targets',
      'Moov / CheckAlt / Plaid / Resend webhook destination changes',
      'DNS cutover',
      'merge to main',
      `restore into database ${TARGET_RDS.defaultDatabase}`,
    ],
  };
};

export const renderPlanText = (plan) => {
  const lines = [
    'ChecksOps database copy PLAN (preparation only — not executed)',
    `Target RDS: ${plan.target.identifier} ${plan.target.engine} ${plan.target.engineVersion}`,
    `Restore database: ${plan.restoreDatabase} (leave ${plan.leaveUntouched} untouched)`,
    `Application role: ${plan.target.applicationRole} (least privilege; not used for restore)`,
    `Admin role: ${plan.target.adminRole} (schema restore only, later phase)`,
    `Live counts: ${plan.source.counts.publicBaseTables} tables, ${plan.source.counts.publicViews} views, ${plan.source.counts.publicFunctions} functions, ${plan.source.counts.publicTriggers} triggers, ${plan.source.counts.publicRlsPolicies} RLS (not applied)`,
    '',
  ];
  for (const step of plan.sequence) {
    lines.push(`${step.id}. [${step.lane}] ${step.title}`);
    lines.push(`   apply now: ${step.apply}`);
    for (const command of step.commands) lines.push(`   $ ${command}`);
    lines.push('');
  }
  lines.push('Rollback if restore fails:');
  lines.push(`   apply now: ${plan.rollback.apply}`);
  lines.push(`   $ ${plan.rollback.command}`);
  lines.push('');
  lines.push('Never in this phase:');
  for (const item of plan.neverInThisPhase) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
};
