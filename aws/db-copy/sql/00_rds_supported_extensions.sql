-- Extensions for the first copy into database checksops.
-- Execute as checksops_admin. Stop rather than skipping if CREATE EXTENSION fails.
-- Supabase installs pgcrypto/uuid-ossp in schema "extensions"; RDS public-only
-- restore fails on defaults like extensions.gen_random_bytes without this schema.

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Live source currently has these enabled. Stop the copy if either command fails.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA extensions TO PUBLIC;
ALTER DATABASE checksops SET search_path TO public, extensions;

-- Do not enable on first copy:
-- pg_cron, pg_net, pgmq, pgsodium, supabase_vault
