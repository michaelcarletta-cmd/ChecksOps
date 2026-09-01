-- Extensions for a future first copy into database checksops.
-- PREPARATION ONLY: do not run yet. Execute later as checksops_admin.
-- Stop rather than skipping if CREATE EXTENSION fails.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Live source currently has these enabled. Enable on RDS only if this instance
-- supports the required version. Stop the copy if either command fails.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

-- Do not enable on first copy:
-- pg_cron, pg_net, pgmq, pgsodium, supabase_vault
