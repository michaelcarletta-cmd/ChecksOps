export const LIVE_SOURCE = {
  projectRef: 'nbcqwpysqgyxrrbgtmkw',
  projectUrl: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
  priorDirectInspectionPublicTables: 186,
  doNotInventoryProjectRef: 'sqyyvpaymashtdwjjmku',
  doNotInventoryReason:
    'Management API can see a differently-ref\'d project named ChecksOps. That is not the Lovable production project in supabase/config.toml and .env.production.',
};

export const LIVE_INVENTORY_TOKEN_ENV = 'CHECKSOPS_LIVE_SUPABASE_ACCESS_TOKEN';
export const LIVE_INVENTORY_DB_URL_ENV = 'CHECKSOPS_LIVE_SUPABASE_DB_URL';

export const liveInventoryBlockedMessage = () =>
  [
    'LIVE INVENTORY STOPPED: this environment does not have catalog-level read access to the live Lovable ChecksOps database.',
    `Required source: Supabase project ${LIVE_SOURCE.projectRef} (${LIVE_SOURCE.projectUrl}).`,
    'Prior live inspection reported 186 public tables; the repository generated-types scan has 166. The live catalog must be inventoried before any export.',
    'Present but insufficient:',
    `- Vite publishable/anon key for ${LIVE_SOURCE.projectRef} (PostgREST/Auth only; cannot list pg_catalog, RLS, extensions, all public tables, auth.users count, or storage object counts).`,
    `- A Supabase personal access token that can manage project ${LIVE_SOURCE.doNotInventoryProjectRef} (named ChecksOps) but returns 403 for ${LIVE_SOURCE.projectRef}. Do not inventory that other project as live.`,
    'Missing access (pick one; store as a Cursor environment secret — do not paste a database password into chat):',
    `1. Fine-grained Supabase access token with database_read on ${LIVE_SOURCE.projectRef}, in env ${LIVE_INVENTORY_TOKEN_ENV}. Inventory will use POST /v1/projects/${LIVE_SOURCE.projectRef}/database/query with read_only=true.`,
    `2. Read-only Postgres URI for ${LIVE_SOURCE.projectRef} (default_transaction_read_only=on), in env ${LIVE_INVENTORY_DB_URL_ENV}.`,
    'Not requested and not used: service_role key for writes, pg_dump, RDS changes, or application row export.',
  ].join('\n');

export const hasLiveCatalogAccess = (env = process.env) =>
  Boolean(env[LIVE_INVENTORY_TOKEN_ENV] || env[LIVE_INVENTORY_DB_URL_ENV]);
