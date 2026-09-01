-- Rollback a FAILED first copy that targeted database checksops only.
-- PREPARATION ONLY: do not run unless a restore into checksops failed.
-- Never DROP DATABASE postgres.
-- Never DROP ROLE checksops or checksops_admin.
-- Never change passwords.
-- Never drop or modify the RDS instance.

-- Confirm you are connected to maintenance database postgres, not checksops:
-- SELECT current_database();  -- must be postgres
-- SELECT datname FROM pg_database WHERE datname = 'checksops';

-- Then, only if the failed restore created checksops:
-- DROP DATABASE checksops;

-- After rollback, the staging API secret still points at dbname=postgres.
-- Re-create database checksops only when starting a new approved copy.
