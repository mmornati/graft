-- A SELECT-only role for the Graft console. Run it once as the owner of Graft's tables (the role in
-- Graft's DATABASE_URL), for example:
--
--   psql "$DATABASE_URL" -v console_password="'a-long-random-password'" -f console/sql/readonly-role.sql
--
-- It is safe to run again: it only creates what is missing and re-grants. The console refuses to start
-- if its role can INSERT, UPDATE, DELETE or TRUNCATE any of these tables.

\set ON_ERROR_STOP on

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graft_console') AS create_role \gset
\if :create_role
  CREATE ROLE graft_console LOGIN PASSWORD :console_password
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\else
  ALTER ROLE graft_console WITH LOGIN PASSWORD :console_password;
\endif

-- Even if a grant slips, every transaction of this role starts read-only.
ALTER ROLE graft_console SET default_transaction_read_only = on;
ALTER ROLE graft_console SET statement_timeout = '10s';

GRANT CONNECT ON DATABASE :"DBNAME" TO graft_console;

GRANT USAGE ON SCHEMA public TO graft_console;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO graft_console;
-- Tables Graft's later migrations create, when the migrating role is the one running this script.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO graft_console;

-- The job queue (pg-boss) lives in its own schema, created when Graft's worker first starts. The
-- console reads job counts from it; without these grants the System view says jobs are unavailable.
SELECT to_regnamespace('pgboss') IS NOT NULL AS has_pgboss \gset
\if :has_pgboss
  GRANT USAGE ON SCHEMA pgboss TO graft_console;
  GRANT SELECT ON ALL TABLES IN SCHEMA pgboss TO graft_console;
  ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT ON TABLES TO graft_console;
\endif
