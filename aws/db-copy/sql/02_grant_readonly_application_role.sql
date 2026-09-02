-- Least-privilege grants for the application role after a future restore.
-- PREPARATION ONLY: do not run yet.
-- Restore schema/data as checksops_admin. Do not use checksops for DDL.
-- Do not grant SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, or BYPASSRLS.

GRANT CONNECT ON DATABASE checksops TO checksops;
GRANT USAGE ON SCHEMA public TO checksops;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO checksops;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO checksops;

-- Intentionally omitted:
-- GRANT INSERT/UPDATE/DELETE
-- GRANT EXECUTE ON ALL FUNCTIONS (review per function later)
-- GRANT BYPASSRLS
