#!/usr/bin/env node
/**
 * Bridge teardown dry-run. Lists what would be deleted AFTER a successful
 * production cutover. Refuses to delete anything. --apply is refused.
 */
const apply = process.argv.includes('--apply');

const report = {
  ok: !apply,
  mode: apply ? 'apply_refused' : 'dry_run',
  wouldDeleteNow: false,
  keepDeployedUntilSuccessfulCutover: [
    'aws-staging-db-bridge',
    'aws-staging-storage-bridge',
  ],
  afterSuccessfulCutoverOnly: [
    'supabase functions delete aws-staging-db-bridge --project-ref nbcqwpysqgyxrrbgtmkw',
    'supabase functions delete aws-staging-storage-bridge --project-ref nbcqwpysqgyxrrbgtmkw',
    'rotate checksops/staging/storage-migration-token',
    'confirm both function URLs return 404',
  ],
  doNot: [
    'delete production Supabase project',
    'delete staging RDS checksops',
    'empty S3 files/ prefixes',
    'teardown during a failed cutover (needed for retry)',
  ],
};

if (apply) {
  console.error(JSON.stringify({
    ...report,
    error: 'refusing_bridge_teardown',
    message: 'Bridges must remain deployed until a human-approved successful cutover.',
  }, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(report, null, 2));
