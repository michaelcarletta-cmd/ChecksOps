# Production database restore test (annual, evidence row B-1)

**Owner:** Michael Carletta, CEO — runs every step (the `claude-code` IAM user cannot create or
delete RDS instances).
**Matrix rows:** A1.3, CC7.5 (`docs/compliance/SOC2_CONTROL_MATRIX.md`); recovery target in
`docs/compliance/BCP_DR.md` §1 (RTO 4 hours for database corruption, RPO 5 minutes).
**How often:** once a year, and after any change to backups. First run due by 2027-01-31.
**Time:** about 1 hour of elapsed time, mostly waiting; about 15 minutes of commands.
**Cost:** a `db.t4g.small` single-AZ instance for about an hour, then deleted: well under $1.

This proves the backups can be turned back into a working database, and measures how long it
takes. **It never touches the live database.** It restores a **new, separate** instance from the
automated backups, checks the data read-only, and deletes the copy.

## Live facts this runbook was written against (read-only, 2026-11-08 22:18 UTC)

| Setting | Value |
|---|---|
| Source instance | `checksops-production`, PostgreSQL 18.3, `db.t4g.small`, Multi-AZ, 50 GiB gp3, encrypted, deletion protection on, not public, port 5432, database `checksops` |
| Subnet group | `checksops-production-db-subnets` (private subnets only) |
| Security group | `sg-0292e00c6b6c7e0eb` (5432 from `sg-0bc4695a666baf49b` and the SQL runner's `sg-0c606bab2bdb2abc5`) |
| Backups | 35 days, point-in-time; `LatestRestorableTime` 2026-11-08 22:18:24 UTC |
| Admin secret | `rds-db-credentials/checksops-production/checksops_admin/1790081257144` (the restored copy keeps the same password) |
| SQL runner | `i-0c35557c4e5385406`, kept **stopped** between runs (`ops/production-sql-one-shot.md`) |

Before starting, re-read them (step 0). If anything differs, stop and update this runbook first.

## Step 0 — read the current state (CloudShell, read-only)

```bash
export AWS_REGION=us-east-1 TEST_ID=checksops-restore-test-$(date -u +%Y%m%d)
aws rds describe-db-instances --db-instance-identifier checksops-production \
  --query 'DBInstances[0].[DBInstanceClass,EngineVersion,MultiAZ,DBSubnetGroup.DBSubnetGroupName,VpcSecurityGroups[0].VpcSecurityGroupId,LatestRestorableTime,BackupRetentionPeriod]' \
  --output table
aws rds describe-db-instances --db-instance-identifier "$TEST_ID" 2>&1 | grep -q DBInstanceNotFound && echo "OK: no test instance yet"
```

Write down `LatestRestorableTime`. Stop if a test instance with today's name already exists.

## Step 1 — restore to a new instance (CloudShell)

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/restore-start.txt
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier checksops-production \
  --target-db-instance-identifier "$TEST_ID" \
  --use-latest-restorable-time \
  --db-instance-class db.t4g.small \
  --no-multi-az \
  --db-subnet-group-name checksops-production-db-subnets \
  --vpc-security-group-ids sg-0292e00c6b6c7e0eb \
  --no-publicly-accessible \
  --no-deletion-protection \
  --copy-tags-to-snapshot \
  --tags Key=purpose,Value=restore-test Key=delete-after,Value=$(date -u +%Y-%m-%d) \
  --query 'DBInstance.[DBInstanceIdentifier,DBInstanceStatus]' --output text
aws rds wait db-instance-available --db-instance-identifier "$TEST_ID"
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/restore-available.txt
aws rds describe-db-instances --db-instance-identifier "$TEST_ID" \
  --query 'DBInstances[0].[Endpoint.Address,DBInstanceStatus,EngineVersion,AllocatedStorage,StorageEncrypted,PubliclyAccessible]' \
  --output table
```

`aws rds wait` gives up after 30 minutes; if it does, run the same `wait` command again. The
restore point is the source's `LatestRestorableTime` at the moment of the request (CloudTrail
`RestoreDBInstanceToPointInTime` records it).

**Stop and delete (step 3)** if the restored instance is publicly accessible or not encrypted.

## Step 2 — check the data, read-only (SQL runner)

Start the runner and open a shell on it:

```bash
aws ec2 start-instances --instance-ids i-0c35557c4e5385406
aws ec2 wait instance-running --instance-ids i-0c35557c4e5385406
aws ssm start-session --target i-0c35557c4e5385406
```

In the runner shell (it installs the PostgreSQL client once if missing; it changes nothing else):

```bash
set -euo pipefail
TEST_HOST=<the Endpoint.Address printed in step 1>
command -v psql >/dev/null || sudo dnf install -y postgresql16
curl -fsS -o /tmp/rds-ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
SECRET=$(aws secretsmanager get-secret-value --region us-east-1 \
  --secret-id rds-db-credentials/checksops-production/checksops_admin/1790081257144 \
  --query SecretString --output text)
export PGUSER=$(echo "$SECRET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["username"])')
export PGPASSWORD=$(echo "$SECRET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["password"])')
export PGDATABASE=checksops PGSSLMODE=verify-full PGSSLROOTCERT=/tmp/rds-ca.pem
unset SECRET
cat > /tmp/restore-check.sql <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT current_setting('server_version') AS server_version, now() AS checked_at;
SELECT count(*) AS public_tables FROM pg_tables WHERE schemaname = 'public';
-- Exact row count of every public table (generated, then run by \gexec; SELECTs only).
SELECT format('SELECT %L AS table_name, count(*) AS row_count FROM public.%I', tablename, tablename)
  FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename \gexec
-- Newest record in the busiest tables: should be just before the restore point.
SELECT 'check_intake_items' AS t, max(created_at) FROM public.check_intake_items
UNION ALL SELECT 'financial_stepup_log', max(created_at) FROM public.financial_stepup_log
UNION ALL SELECT 'audit_logs', max(created_at) FROM public.audit_logs;
ROLLBACK;
SQL
psql -h "$TEST_HOST" -X -q -A -F ',' -f /tmp/restore-check.sql > /tmp/restored.csv
psql -h "$(aws rds describe-db-instances --region us-east-1 --db-instance-identifier checksops-production --query 'DBInstances[0].Endpoint.Address' --output text)" \
  -X -q -A -F ',' -f /tmp/restore-check.sql > /tmp/production.csv
diff <(grep -v checked_at /tmp/restored.csv) <(grep -v checked_at /tmp/production.csv) | head -40 || true
wc -l /tmp/restored.csv /tmp/production.csv
unset PGPASSWORD
rm -f /tmp/restored.csv /tmp/production.csv /tmp/restore-check.sql
exit
```

**Pass** when:
- the restored copy answers on TLS with `verify-full`;
- it has the same number of public tables as production;
- every row count in the copy is equal to or a little below production's (rows written after the
  restore point are missing, which is expected);
- the newest `created_at` values are within minutes of the restore point.

Paste the summary numbers (table count, the differences, the three timestamps) into the record,
**not** the full output. The counts are not personal data, but keep the record short.

If `audit_logs` or another table in the last query does not exist, remove that line and note it.

Stop the runner (CloudShell):

```bash
aws ec2 stop-instances --instance-ids i-0c35557c4e5385406
aws ec2 wait instance-stopped --instance-ids i-0c35557c4e5385406
```

## Step 3 — delete the test instance (CloudShell)

```bash
aws rds delete-db-instance --db-instance-identifier "$TEST_ID" \
  --skip-final-snapshot --delete-automated-backups \
  --query 'DBInstance.DBInstanceStatus' --output text
aws rds wait db-instance-deleted --db-instance-identifier "$TEST_ID"
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/restore-deleted.txt
aws rds describe-db-instances --db-instance-identifier "$TEST_ID" 2>&1 | grep -q DBInstanceNotFound && echo "OK: test instance deleted"
aws rds describe-db-instances --db-instance-identifier checksops-production \
  --query 'DBInstances[0].[DBInstanceStatus,MultiAZ,DeletionProtection]' --output text
```

The last line must show production still `available  True  True`. Double-check the identifier
before running `delete-db-instance`: it must be the `checksops-restore-test-…` name, never
`checksops-production`. Production also has deletion protection on, so a wrong name is refused.

## Step 4 — record

Copy the template below to `docs/compliance/evidence/<date>-B-1-restore-test.md`, fill it in,
and send it to Claude, who opens a docs PR. Also update `docs/compliance/BCP_DR.md` §1 with the
measured time.

```markdown
# Database restore test, <date> (row B-1)

**Who:** Michael Carletta (CloudShell, as michael-admin)
**Source:** checksops-production, restore point (LatestRestorableTime at request) <UTC time>
**Test instance:** checksops-restore-test-<yyyymmdd>, db.t4g.small single-AZ, private, encrypted

| Step | UTC time |
|---|---|
| Restore requested | <restore-start.txt> |
| Instance available | <restore-available.txt> |
| Data check finished | <time> |
| Instance deleted | <restore-deleted.txt> |

**Time to a usable database:** <available − requested> (target in BCP_DR.md §1: 4 hours to a
repointed API; this measures the restore part).

**Data check (read-only, verify-full TLS):** <n> public tables in both; row counts equal except
<list, each lower in the copy by n rows>; newest check_intake_items <time>, financial_stepup_log
<time>, audit_logs <time>.

**Result:** Pass / Fail. **Follow-ups:** <none, or what to change>.
**Production after the test:** available, Multi-AZ true, deletion protection true.
```

## What this runbook does not do

- Never restores over, modifies or reboots `checksops-production`.
- Does not repoint the API at the copy. A real recovery would, after the owner's review
  (`aws/cutover/INCIDENT_RESPONSE_AWS.md` §4, §9); this test stops before that.
- Does not test the `us-east-2` copy. Restoring there is a separate drill, once a year as well.
