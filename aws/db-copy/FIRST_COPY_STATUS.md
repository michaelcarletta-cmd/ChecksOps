# First copy attempt — stopped on IAM

The S3 backup is present and readable. Restore into isolated database `checksops` did **not** run because the staging API Lambda role cannot read the `checksops_admin` secret. IAM was not broadened. Original Lambda code/timeout were restored. `/db-health` remains 200 on `postgres`.

## Backup verified

- Bucket: `checksops-staging-privatefilesbucket-erzqsolpucjp`
- Requested key: `migration/checksops_260901.backup` (not found)
- Actual key: `Migration/checksops_260901(1).backup`
- Size: 49,100,401 bytes (49.1 MB)
- Format: PostgreSQL custom (`PGDMP`)
- `s3:GetObject` from the VPC Lambda role: **allowed** (object was downloaded only into Lambda `/tmp`, not Git)

## Missing IAM (do not attach this to the API role unless you intend the web API to hold the master password)

```
Principal: arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi
Action:    secretsmanager:GetSecretValue
Resource:  arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt
```

Safer: a dedicated one-shot restore role with that `GetSecretValue` plus existing VPC/RDS access, not the API function role.

This Cloud Agent can read the admin secret itself, but it cannot open TCP 5432 to private RDS, so restore has to run in VPC.
