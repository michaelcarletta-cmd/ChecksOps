import path from 'node:path';
import {
  EXECUTE_ENV,
  EXECUTE_VALUE,
  EXCLUDED_SCHEMAS,
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
  const identityFile = path.posix.join(artifactDir, 'auth-identity-map.csv');
  return {
    preparationOnly: true,
    source: 'live ChecksOps Supabase/Lovable PostgreSQL (connection URI from env, never committed)',
    target: TARGET_RDS,
    envVarsRequiredLater: [
      'SUPABASE_DB_URL',
      'CHECKSOPS_RDS_ADMIN_URL',
    ],
    notes: [
      'Use pg_dump/pg_restore 16+ against the live source. PostgreSQL 18.3 can restore dumps from current Supabase major versions.',
      'Never log, print, or commit connection URIs or passwords.',
      'Dump public schema only. Do not dump auth, storage, realtime, vault, cron, or net.',
      'Extract RLS policies to a sidecar SQL file. Do not apply them on RDS in the first restore.',
      'Extract auth.users id,email into an identity map. Do not copy encrypted passwords.',
      'Restore as checksops_admin. Keep checksops LOGIN with CONNECT + later SELECT only.',
    ],
    sequence: [
      {
        id: 1,
        lane: 'postgresql_schema',
        title: 'Create restore database and RDS-safe extensions',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          `createdb --maintenance-db=${TARGET_RDS.defaultDatabase} ${TARGET_RDS.recommendedRestoreDatabase}`,
          'psql --file aws/db-copy/sql/00_rds_supported_extensions.sql',
          'psql --file aws/db-copy/sql/01_auth_compatibility_stubs.sql',
        ],
      },
      {
        id: 2,
        lane: 'auth_users',
        title: 'Export identity map only (id, email)',
        role: 'supabase source, read-only',
        apply: false,
        commands: [
          `psql --csv --command "copy (select id, email, created_at from auth.users) to stdout" > ${identityFile}`,
        ],
      },
      {
        id: 3,
        lane: 'postgresql_schema',
        title: 'Dump public schema without owners, ACLs, or subscriptions',
        role: 'supabase source, read-only',
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
        id: 4,
        lane: 'rls_security_policies',
        title: 'Extract RLS policy SQL; do not restore it yet',
        role: 'supabase source, read-only',
        apply: false,
        commands: [
          `pg_dump --schema=public --section=pre-data --section=post-data --no-owner --no-acl | awk '/CREATE POLICY|ENABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/ {print}' > ${rlsFile}`,
        ],
      },
      {
        id: 5,
        lane: 'public_application_data',
        title: 'Dump public data only',
        role: 'supabase source, read-only',
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
        id: 6,
        lane: 'postgresql_schema',
        title: 'Restore schema then identity map then data as admin',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          `pg_restore --dbname=${TARGET_RDS.recommendedRestoreDatabase} --no-owner --no-acl --exit-on-error ${schemaFile}`,
          `psql --command "\\copy auth.users (id, email, created_at) FROM '${identityFile}' CSV HEADER"`,
          `pg_restore --dbname=${TARGET_RDS.recommendedRestoreDatabase} --data-only --disable-triggers --no-owner --exit-on-error ${dataFile}`,
        ],
      },
      {
        id: 7,
        lane: 'database_functions_triggers',
        title: 'Disable HTTP/cron/vault triggers; keep data-integrity triggers',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          'Review restored functions for net.http_, cron.schedule, vault., and storage. calls. Drop or no-op those bodies. Stop rather than guessing.',
        ],
      },
      {
        id: 8,
        lane: 'public_application_data',
        title: 'Grant least privilege to application role and reconcile',
        role: TARGET_RDS.adminRole,
        apply: false,
        commands: [
          'psql --file aws/db-copy/sql/02_grant_readonly_application_role.sql',
          'psql --file aws/db-copy/sql/reconciliation_counts.sql',
          'psql --file aws/db-copy/sql/reconciliation_financial.sql',
        ],
      },
    ],
    neverInThisPhase: [
      'storage object copy to S3',
      'Cognito user import',
      'RLS policy apply',
      'Edge Function deploy as production webhook targets',
      'Moov / CheckAlt / Plaid / Resend webhook destination changes',
      'DNS cutover',
      'merge to main',
    ],
  };
};

export const renderPlanText = (plan) => {
  const lines = [
    'ChecksOps database copy PLAN (preparation only — not executed)',
    `Target RDS: ${plan.target.identifier} ${plan.target.engine} ${plan.target.engineVersion}`,
    `Application role: ${plan.target.applicationRole} (least privilege; not used for restore)`,
    `Admin role: ${plan.target.adminRole} (schema restore only, later phase)`,
    '',
  ];
  for (const step of plan.sequence) {
    lines.push(`${step.id}. [${step.lane}] ${step.title}`);
    lines.push(`   apply now: ${step.apply}`);
    for (const command of step.commands) lines.push(`   $ ${command}`);
    lines.push('');
  }
  lines.push('Never in this phase:');
  for (const item of plan.neverInThisPhase) lines.push(`- ${item}`);
  return `${lines.join('\n')}\n`;
};
