# Tranche 1 write rollback

Disable AWS writes immediately without affecting AWS reads or production ChecksOps.

## Primary kill switch (preferred)

On Lambda `checksops-staging-api` (us-east-1):

```bash
aws lambda update-function-configuration \
  --function-name checksops-staging-api \
  --environment "Variables={...,AWS_WRITES_ENABLED=false}"
```

`POST /data/write` then returns `403 writes_disabled` for authenticated callers and `401` without a token. `POST /data/query` and storage reads are unchanged. Production Lovable/Supabase is unchanged.

Treat any value other than the string `true` as off (fail-closed).

## Optional GRANT revoke

If the DML grants themselves must be removed:

1. Run `aws/write-path/sql/32_tranche1_revoke_write_grants.sql` as `checksops_admin` from a temporary in-VPC oneshot (`step=revoke`).
2. Delete that oneshot and its admin-secret role.
3. Confirm `checksops` still has SELECT on the two tables.
4. Do not grant DML on financial/provider tables.

## Frontend

AWS-mode client only sends Tranche 1 tables to `/data/write`. Production `VITE_AUTH_PROVIDER` is not `cognito`, so production continues to use Supabase. No production DNS change is required to roll back.

## Do not

- Globally set `default_transaction_read_only=off`
- Point production DNS at staging
- Disable production Supabase
- Attach `checksops_admin` to API Policy4
