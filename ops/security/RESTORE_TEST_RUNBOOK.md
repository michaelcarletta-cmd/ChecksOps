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

The files part of the same yearly test (the `us-east-2` copy of the private-files bucket) is in
[Files recovery](#files-recovery-us-east-2-copy-of-the-private-files-bucket) below. Run it on the
same day or within the same month, and record it in the same B-1 record.

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

## Files recovery (`us-east-2` copy of the private-files bucket)

**Owner:** Michael Carletta, CEO — runs every step in CloudShell as `michael-admin` (access portal,
IAM Identity Center permission set `AdministratorAccess`, **never root**). The `claude-code` IAM
user cannot list or read either bucket.
**Matrix rows:** A1.3, CC7.5, CC9.1; `docs/compliance/BCP_DR.md` §1 (loss of `us-east-1`).
**How often:** with the database test above, once a year (row B-1), and after any change to the
replication rule, the copy bucket or the `us-east-2` compliance documents key.
**Time:** about 20 minutes. **Cost:** a few cents (two object reads, two list passes).

The drill proves that the copy can be **read back**: one ordinary (SSE-S3) object, byte for byte
against the source, and one compliance document, which nobody can decrypt today. It changes one
thing for its duration, a temporary decrypt statement on the `us-east-2` key, and removes it at the
end. **Never print an object key**: keys contain tenant ids. Every command below prints counts,
lengths, statuses or `OK` lines only; the two sample keys stay in files under `/tmp` and are
deleted in F6.

### Live facts the files part was written against (read-only, 2026-11-09)

| Setting | Value |
|---|---|
| Source bucket | `checksops-production-privatefiles-806168576068` (`us-east-1`), versioning Enabled, default SSE-S3 |
| Compliance documents | under `files/verification-docs/`, SSE-KMS with `arn:aws:kms:us-east-1:806168576068:key/59d713da-72f3-43a6-8a48-a826d432d53f`, no Bucket Key. Its policy lets only the production API role and the replication role decrypt (through S3), so the operator cannot read the source documents either |
| Copy bucket | `checksops-production-privatefiles-dr-806168576068` (`us-east-2`), versioning Enabled, SSE-S3 (Bucket Key off, SSE-C blocked), Block Public Access all four on, policy `DenyInsecureTransport` only |
| Replication rule | `CopyToUsEast2` on the source: everything, `SseKmsEncryptedObjects` Enabled, replicas of KMS objects encrypted with the `us-east-2` key, **delete markers not copied** |
| `us-east-2` key | `arn:aws:kms:us-east-2:806168576068:key/c5863c6d-61b6-42dd-8a42-837fe17c7b25` (`alias/checksops-production-compliance-documents-dr`). Policy: `KeyAdministrationOnly` (account root, the 24 administration actions including `kms:PutKeyPolicy`, no encrypt or decrypt) and `FilesReplicationRoleEncryptViaS3` (`kms:Encrypt` only, role `checksops-production-files-replication`). **Nobody can decrypt the copies** until a statement is added |
| Operator role | `arn:aws:iam::806168576068:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_e5a8a8393214f964` (the role behind `michael-admin`'s permission set) |
| API configuration | the production API `checksops-production-prep-api` (`us-east-1`) reads the bucket from `FILES_BUCKET` and the documents key from `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN` |

Re-read them in F0. If anything differs, stop and update this runbook first.

### F0 — read the current state (CloudShell, read-only)

```bash
export AWS_REGION=us-east-2
SRC=checksops-production-privatefiles-806168576068
DST=checksops-production-privatefiles-dr-806168576068
ACCOUNT=806168576068
DR_KEY=arn:aws:kms:us-east-2:$ACCOUNT:key/c5863c6d-61b6-42dd-8a42-837fe17c7b25
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/files-drill-start.txt
CALLER=$(aws sts get-caller-identity --query Arn --output text); echo "$CALLER"
OPERATOR_ROLE=$(aws iam get-role --role-name "$(echo "$CALLER" | cut -d/ -f2)" --query Role.Arn --output text)
echo "$OPERATOR_ROLE"
aws kms get-key-policy --key-id "$DR_KEY" --policy-name default --output text > /tmp/dr-key-before.json
python3 - <<'PY'
import json
s = [x["Sid"] for x in json.load(open('/tmp/dr-key-before.json'))["Statement"]]
assert s == ["KeyAdministrationOnly", "FilesReplicationRoleEncryptViaS3"], s
print("OK: us-east-2 key policy has the two phase 2 statements, nobody can decrypt")
PY
aws s3api get-bucket-replication --bucket "$SRC" --region us-east-1 \
  --query 'ReplicationConfiguration.Rules[0].[ID,Status,SourceSelectionCriteria.SseKmsEncryptedObjects.Status,DeleteMarkerReplication.Status,Destination.EncryptionConfiguration.ReplicaKmsKeyID]' --output text
aws s3api get-bucket-versioning --bucket "$DST" --query Status --output text
aws s3api get-public-access-block --bucket "$DST" --output text
aws s3api get-bucket-policy --bucket "$DST" --query Policy --output text | python3 -c '
import json,sys; print([s["Sid"] for s in json.load(sys.stdin)["Statement"]])'
```

Stop unless:
- `CALLER` is `arn:aws:sts::806168576068:assumed-role/AWSReservedSSO_AdministratorAccess_…/…`
  (not `root`, not `claude-code`), and `OPERATOR_ROLE` is the operator role in the table;
- the key policy prints the `OK` line;
- the rule prints `CopyToUsEast2 Enabled Enabled Disabled <DR_KEY>`;
- the copy bucket prints `Enabled`, four `True`, and `['DenyInsecureTransport']`.

Keep `/tmp/dr-key-before.json`: F5 checks that the policy goes back to exactly this content.

### F1 — compare the two buckets, counts only (read-only)

```bash
aws s3api list-objects-v2 --bucket "$SRC" --region us-east-1 --query 'Contents[].[Key,Size]' --output json > /tmp/drill-src-list.json
aws s3api list-objects-v2 --bucket "$DST" --query 'Contents[].[Key,Size]' --output json > /tmp/drill-dst-list.json
python3 - <<'PY'
import json, random
def load(p):
    return {k: s for k, s in (json.load(open(p)) or []) if not k.startswith("_replication-reports/")}
src, dst = load('/tmp/drill-src-list.json'), load('/tmp/drill-dst-list.json')
docs = lambda m: [k for k in m if k.startswith("files/verification-docs/")]
print("source current objects", len(src), "bytes", sum(src.values()), "compliance documents", len(docs(src)))
print("copy current objects  ", len(dst), "bytes", sum(dst.values()), "compliance documents", len(docs(dst)))
print("in source, not in copy", len(src.keys() - dst.keys()))
print("in copy, not in source", len(dst.keys() - src.keys()), "(deleted in the source; deletes are not copied)")
print("same key, different size", sum(1 for k in src.keys() & dst.keys() if src[k] != dst[k]))
plain = [k for k in src.keys() & dst.keys()
         if not k.startswith("files/verification-docs/") and src[k] == dst[k] and 0 < src[k] < 20_000_000]
both_docs = [k for k in docs(dst) if k in src and src[k] == dst[k]]
assert plain and both_docs, "no sample available"
open('/tmp/drill-plain-key', 'w').write(random.choice(plain))
open('/tmp/drill-doc-key', 'w').write(random.choice(both_docs))
print("OK: one SSE-S3 sample and one compliance document sample chosen (keys not printed)")
PY
```

Pass when "in source, not in copy" and "same key, different size" are 0, or only a handful that
match uploads in the last few minutes (replication lag; run F1 again ten minutes later and they
should be gone). "In copy, not in source" is files deleted in the source since 2026-11-09, which is
expected. **Stop** on anything else.

### F2 — read back an SSE-S3 copy, and show the documents are sealed (read-only)

```bash
PLAIN=$(cat /tmp/drill-plain-key); DOC=$(cat /tmp/drill-doc-key)
EMPTY=$(printf '' | sha256sum | cut -c1-64)
A=$(aws s3 cp "s3://$SRC/$PLAIN" - --region us-east-1 2>/dev/null | sha256sum | cut -c1-64)
B=$(aws s3 cp "s3://$DST/$PLAIN" - --region us-east-2 2>/dev/null | sha256sum | cut -c1-64)
[ "$A" = "$B" ] && [ "$A" != "$EMPTY" ] && echo "OK: SSE-S3 copy reads back byte-identical to the source" || echo "STOP: differs or unreadable"
aws s3api head-object --bucket "$DST" --key "$DOC" --query '[ServerSideEncryption,SSEKMSKeyId,ReplicationStatus]' --output text
aws s3 cp "s3://$DST/$DOC" - 2>&1 >/dev/null | grep -q 'AccessDenied\|kms:Decrypt' && echo "OK: the document copy cannot be decrypted before the drill grant"
```

Stop unless both `OK` lines print and the head reads `aws:kms  <DR_KEY>  REPLICA`. (`2>/dev/null`
and `grep -q` keep the error text, which names the key, off the screen.)

### F3 — add the temporary decrypt statement (read, add one statement, write)

The statement names the account as principal and narrows it with `aws:PrincipalArn` to the
operator role, so the role's own `AdministratorAccess` policy must also allow the call, and no
other principal gains anything. It allows only `kms:Decrypt`, only through S3 in `us-east-2`, only
for objects under `files/verification-docs/` of the copy bucket. **From here on, if anything
stops the drill, run F5 before anything else.**

```bash
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/files-drill-grant.txt
OPERATOR_ROLE="$OPERATOR_ROLE" python3 - <<'PY'
import json, os
d = json.load(open('/tmp/dr-key-before.json'))
sids = [s["Sid"] for s in d["Statement"]]
assert sids == ["KeyAdministrationOnly", "FilesReplicationRoleEncryptViaS3"], sids
assert "RestoreDrillDecryptViaS3" not in sids, "already there"
d["Statement"].append({
  "Sid": "RestoreDrillDecryptViaS3", "Effect": "Allow",
  "Principal": {"AWS": "arn:aws:iam::806168576068:root"},
  "Action": "kms:Decrypt", "Resource": "*",
  "Condition": {
    "StringEquals": {"kms:ViaService": "s3.us-east-2.amazonaws.com",
                     "aws:PrincipalArn": os.environ["OPERATOR_ROLE"]},
    "StringLike": {"kms:EncryptionContext:aws:s3:arn":
                   "arn:aws:s3:::checksops-production-privatefiles-dr-806168576068/files/verification-docs/*"}}})
json.dump(d, open('/tmp/dr-key-drill.json', 'w'))
print("statements", len(sids), "->", len(d["Statement"]))
PY
aws kms put-key-policy --key-id "$DR_KEY" --policy-name default --policy file:///tmp/dr-key-drill.json
aws kms get-key-policy --key-id "$DR_KEY" --policy-name default --output text | python3 -c '
import json,sys; print([s["Sid"] for s in json.load(sys.stdin)["Statement"]])'
```

It must print `statements 2 -> 3` and the three Sids. Wait about a minute before F4 (key policy
changes take a few seconds to apply everywhere).

### F4 — read back a compliance document copy (read-only)

```bash
N=$(aws s3 cp "s3://$DST/$DOC" - 2>/dev/null | wc -c)
L=$(aws s3api head-object --bucket "$DST" --key "$DOC" --query ContentLength --output text)
S=$(aws s3api head-object --bucket "$SRC" --region us-east-1 --key "$DOC" --query ContentLength --output text)
echo "decrypted bytes $N, copy length $L, source length $S"
[ "$N" -gt 0 ] && [ "$N" = "$L" ] && [ "$L" = "$S" ] && echo "OK: compliance document copy decrypts in us-east-2"
```

`head-object` needs no decrypt, so the source length is readable even though the operator cannot
decrypt the source. The bytes go to `wc` only; nothing is saved. If it prints `0` bytes, wait one
more minute and run F4 once more; if it is still `0`, stop and go to F5.

### F5 — remove the temporary statement and check it is gone

```bash
aws kms get-key-policy --key-id "$DR_KEY" --policy-name default --output text > /tmp/dr-key-current.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/dr-key-current.json'))
sids = [s["Sid"] for s in d["Statement"]]
assert sids == ["KeyAdministrationOnly", "FilesReplicationRoleEncryptViaS3", "RestoreDrillDecryptViaS3"], sids
d["Statement"] = [s for s in d["Statement"] if s["Sid"] != "RestoreDrillDecryptViaS3"]
assert d == json.load(open('/tmp/dr-key-before.json')), "the other statements changed during the drill"
json.dump(d, open('/tmp/dr-key-after.json', 'w'))
print("statements 3 -> 2, the same as before the drill")
PY
aws kms put-key-policy --key-id "$DR_KEY" --policy-name default --policy file:///tmp/dr-key-after.json
date -u +%Y-%m-%dT%H:%M:%SZ | tee /tmp/files-drill-revoke.txt
aws kms get-key-policy --key-id "$DR_KEY" --policy-name default --output text > /tmp/dr-key-final.json
python3 -c '
import json; a=json.load(open("/tmp/dr-key-final.json")); b=json.load(open("/tmp/dr-key-before.json"))
assert a == b, [s["Sid"] for s in a["Statement"]]; print("OK: key policy is back to the pre-drill policy")'
```

After a minute, the decrypt must be refused again:

```bash
aws s3 cp "s3://$DST/$DOC" - 2>&1 >/dev/null | grep -q 'AccessDenied\|kms:Decrypt' && echo "OK: the document copy is sealed again"
```

If the `assert` in the first block fails (someone else changed the key policy during the drill),
**stop**: do not write anything; report the Sids it printed and decide with the evidence. The
drill statement must never be left in place by accident: record it as an open item until it is
removed.

### F6 — CloudTrail event ids, then clean up (read-only, then deletes local files only)

CloudTrail can take up to 15 minutes to show the events.

```bash
for E in PutKeyPolicy Decrypt; do
  aws cloudtrail lookup-events --region us-east-2 --start-time "$(cat /tmp/files-drill-start.txt)" \
    --lookup-attributes AttributeKey=EventName,AttributeValue=$E \
    --query 'Events[].[EventName,EventTime,EventId,Username]' --output text
done
cat /tmp/files-drill-start.txt /tmp/files-drill-grant.txt /tmp/files-drill-revoke.txt
date -u +%Y-%m-%dT%H:%M:%SZ
rm -f /tmp/drill-plain-key /tmp/drill-doc-key /tmp/drill-src-list.json /tmp/drill-dst-list.json \
      /tmp/dr-key-before.json /tmp/dr-key-drill.json /tmp/dr-key-current.json /tmp/dr-key-after.json \
      /tmp/dr-key-final.json /tmp/files-drill-*.txt
unset PLAIN DOC
```

Expect exactly two `PutKeyPolicy` events (add, remove) by `michael-admin`, and `Decrypt` events
only from the drill (F4) by `michael-admin` between the grant and the revoke times: no other
principal can decrypt with this key. A `Decrypt` event at any other time is a finding: stop and
report it.

### F7 — record (files part)

Add this to the same `docs/compliance/evidence/<date>-B-1-restore-test.md` and send it to Claude,
who opens the docs PR. Counts, lengths and event ids only, **never an object key**.

```markdown
## Files: us-east-2 copy read-back (row B-1, files part)

**Who:** Michael Carletta (CloudShell, as michael-admin, role AWSReservedSSO_AdministratorAccess_…)
**Copy:** checksops-production-privatefiles-dr-806168576068 (us-east-2), rule CopyToUsEast2

| Step | UTC time |
|---|---|
| Drill started (F0) | <files-drill-start.txt> |
| Decrypt statement added (F3) | <files-drill-grant.txt> |
| Decrypt statement removed (F5) | <files-drill-revoke.txt> |
| Drill finished (F6) | <time> |

**Counts (F1):** source <n> current objects / <bytes> bytes (<n> compliance documents); copy <n> /
<bytes> (<n> compliance documents); in source not in copy <n> (<explain, e.g. uploaded in the last
minutes, gone on re-run>); in copy not in source <n> (deleted in source); same key different size <n>.

**Read-back:** SSE-S3 sample byte-identical to the source (sha256 compared, not recorded): yes/no.
Compliance document sample: refused before the grant yes/no; decrypted after the grant, <n> bytes =
copy length = source length yes/no; refused again after removal yes/no.

**Key policy (us-east-2 key c5863c6d-…):** PutKeyPolicy add <time> <event id>; PutKeyPolicy remove
<time> <event id>; Decrypt events <n>, all by michael-admin between those times: yes/no. Policy after
the drill identical to before (F5 OK): yes/no.

**Time taken:** <finished − started>.
**Result:** Pass / Fail. **Follow-ups:** <none, or what to change>.
```

### Real recovery outline (not a drill)

This is the shape of a real files recovery. Each change it names is a **separate owner-approved
change** through the guarded workflows, with its own reviewed PR and run, as for any production
change (`CLAUDE.md`, `docs/compliance/CHANGE_MANAGEMENT.md`). It is an outline, not a procedure:
write the procedure, from the live state, when it is needed.

**What the copy holds.** Every object version written to the source since phase 1 (2026-11-09),
plus the versions the two Batch Replication jobs copied; compliance documents encrypted with the
`us-east-2` key; object tags. **What it does not hold:**
- **Deletes.** Delete markers are not copied, so a file deleted in the source is still current in
  the copy. A recovery from the copy brings deleted files back; tenant data that was deleted on
  purpose (retention purges, `docs/DATA_RETENTION.md`) must be deleted again after the recovery.
- **The last few minutes.** Replication is asynchronous (minutes, no time guarantee). Uploads in the
  minutes before the loss, and any object whose replication status is `FAILED`, may be missing.
- **Agreement with the database.** The database copy in `us-east-2` is about 15 minutes behind
  (`BCP_DR.md` §1). Expect a few rows that point at a missing file and a few files with no row.
- `_replication-reports/` objects exist only in the copy; they are not application files.

**Which case it is.**
1. *Files deleted or overwritten, bucket and region fine:* restore the previous version in the
   source (`BCP_DR.md` §3). The copy is not needed.
2. *Source bucket unusable or wiped (versions deleted), `us-east-1` up:* copy the objects **back**
   into `us-east-1` (into the source bucket or a new one) rather than repointing; the API, its role
   and the source compliance documents key all live there. Compliance documents need a decrypt
   grant on the `us-east-2` key for the role that copies them (below) and are re-encrypted with the
   `us-east-1` key, whose policy is managed by `aws/production/onboarding-keys.yaml` through
   `guarded-production-onboarding-keys.yml` (`ops/production-onboarding-keys.md`). A new bucket name
   also means a `FILES_BUCKET` change through `guarded-production-lambda-config.yml`
   (`ops/lambda-configuration-change.md`) and the API role's bucket permissions
   (`aws/production/api-execution-role.yaml`, `FilesBucketName`).
3. *`us-east-1` lost:* the API (`checksops-production-prep-api`), its Cognito user pool, Secrets
   Manager, the source key and the guarded workflows' own `us-east-1` signing key are gone with it.
   No workflow in `.github/workflows/` targets `us-east-2`, and this repository has no `us-east-2`
   API stack. Pointing the API at the copy therefore means: the database
   restored in `us-east-2` (`BCP_DR.md` §4), an API running in `us-east-2` with `FILES_BUCKET` =
   `checksops-production-privatefiles-dr-806168576068` and `COMPLIANCE_DOCUMENTS_KMS_KEY_ARN` = the
   `us-east-2` key, and that API's role allowed on the copy bucket and on the key. Building that path
   is itself an owner decision and a set of reviewed PRs; it is not in place today.

**The decrypt grant for the restore role.** Whatever reads the compliance document copies (the
role that copies them back in case 2, or the `us-east-2` API role in case 3) needs a key policy
statement on the `us-east-2` key, added the same way as F3: read the policy, assert its Sid is
absent and the other statements are the two above, add one statement, write, read back. Scope it
like F3: `kms:Decrypt` (plus `kms:GenerateDataKey` only for an API that will write new documents),
`kms:ViaService` `s3.us-east-2.amazonaws.com`, the copy bucket's `files/verification-docs/*`
encryption context, and that one role. The `KeyAdministrationOnly` statement allows the owner's
`PutKeyPolicy`. Record the `PutKeyPolicy` event id. Once the recovery is over, remove it the same
way as F5, unless the `us-east-2` API stays in service.

**Stop on the first surprise**, as everywhere else: a count that does not match, a rule or key
policy that differs from this runbook, an unexpected `Decrypt` event. Report it with the evidence
and decide before going further.

## What this runbook does not do

- Never restores over, modifies or reboots `checksops-production`.
- Does not repoint the API at the copy. A real recovery would, after the owner's review
  (`aws/cutover/INCIDENT_RESPONSE_AWS.md` §4, §9); this test stops before that.
- Does not test the `us-east-2` copy of the database. Restoring there is a separate drill, once a
  year as well.
- The files drill reads two objects and changes one thing for its duration: a temporary decrypt
  statement on the `us-east-2` compliance documents key, removed at the end (F5). It never writes,
  copies back or deletes an object, and never changes either bucket, the replication rule or role,
  or the `us-east-1` compliance documents key.
- Does not repoint the API at the files copy or copy files back. A real recovery does that as
  separate owner-approved changes ("Real recovery outline").
